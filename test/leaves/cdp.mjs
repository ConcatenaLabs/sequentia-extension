// A small Chrome DevTools Protocol client for the leaf drive: one browser connection,
// flat sessions per target, every console line of the extension's service worker, its
// offscreen document, the leaf wallet's worker and the pages written to one log.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILTER = [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}];

export class Browser {
  constructor({ chrome, profile, ext, consoleLog, headless = false, extraArgs = [] }) {
    Object.assign(this, { chromeBin: chrome, profile, ext, consoleLog, headless, extraArgs });
    this.next = 1; this.pending = new Map(); this.handlers = []; this.sessions = new Map();
    this.problems = [];
    this.attachedIds = new Set();
    this.seen = new Set();
  }

  async launch(label) {
    this.label = label;
    const args = [
      `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      `--disable-extensions-except=${this.ext}`, `--load-extension=${this.ext}`, '--window-size=1200,900',
      ...this.extraArgs, 'about:blank',
    ];
    if (this.headless) args.unshift('--headless=new');
    this.proc = spawn(this.chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((ok, no) => {
      let buf = '';
      this.proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
      this.proc.once('exit', (c) => no(new Error('chrome exited ' + c + '\n' + buf.slice(-2000))));
    });
    this.ws = new WebSocket(wsUrl);
    await new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
    this.ws.addEventListener('message', (ev) => this.onMessage(JSON.parse(ev.data)));
    // Every kind of target but the browser and its tabs: the offscreen document is a
    // `background_page`, which the default filter leaves out.
    await this.send('Target.setDiscoverTargets', { discover: true, filter: FILTER });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER });
    // An offscreen document announces itself only by a change of target info, which
    // can come before it can be attached to: look for unattached ones every second.
    this.sweep = setInterval(() => this.attachOurs().catch(() => {}), 1000);
  }

  async attachOurs() {
    for (const t of await this.targets()) {
      // Attached means an attachedToTarget event was seen: an attach sent too early
      // answers with a session and no event, and is tried again.
      if (!this.ours(t) || t.type === 'service_worker' || this.attachedIds.has(t.targetId)) continue;
      await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, no) => this.pending.set(id, { ok, no, method }));
  }

  on(fn) { this.handlers.push(fn); return () => { this.handlers = this.handlers.filter((h) => h !== fn); }; }

  log(line) { appendFileSync(this.consoleLog, `[${new Date().toISOString()}] [${this.label}] ${line}\n`); }

  // What counts as this extension's own context, whose errors fail the drive.
  ours(info) { return info && /^chrome-extension:\/\/[a-p]{32}\//.test(info.url || ''); }

  async onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      return m.error ? p.no(new Error(p.method + ': ' + m.error.message)) : p.ok(m.result);
    }
    if (m.method === 'Target.attachedToTarget') {
      this.attachedIds.add(m.params.targetInfo.targetId);
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      this.sessions.set(sessionId, targetInfo);
      // Every target is watched: the offscreen document attaches as `other` before its
      // URL is known, and is told apart later by its URL (targetInfoChanged below).
      const watch = true;
      if (watch) {
        await this.send('Runtime.enable', {}, sessionId).catch(() => {});
        await this.send('Log.enable', {}, sessionId).catch(() => {});
        // The leaf wallet's dedicated worker lives under the offscreen document.
        if (!/worker/.test(targetInfo.type)) {
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER }, sessionId).catch(() => {});
        }
        this.log(`attached ${targetInfo.type} ${targetInfo.url}`);
      }
      if (waitingForDebugger) await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
    if (m.method === 'Target.targetInfoChanged') {
      for (const [sid, info] of this.sessions) if (info.targetId === m.params.targetInfo.targetId) this.sessions.set(sid, m.params.targetInfo);
    }
    const t = m.sessionId && this.sessions.get(m.sessionId);
    if (t) {
      const where = `${t.type} ${t.url.replace(/^chrome-extension:\/\/[a-p]{32}/, 'ext:')}`;
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        // Attaching again replays what a context already logged: once each.
        const key = `${t.targetId} ${m.params.timestamp} ${m.params.type} ${text}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.log(`console.${m.params.type} in ${where}: ${text}`);
        if (this.ours(t) && m.params.type === 'error') this.problems.push(`console.error in ${where}: ${text}`);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const text = (d.exception && d.exception.description) || d.text;
        const key = `${t.targetId} ${m.params.timestamp} exception ${text}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.log(`EXCEPTION in ${where}: ${text}`);
        if (this.ours(t)) this.problems.push(`exception in ${where}: ${text}`);
      }
      if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        const key = `${t.targetId} ${e.timestamp} log ${e.text}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.log(`log.${e.level} in ${where}: ${e.text}${e.url ? ' (' + e.url + ')' : ''}`);
        // A blocked public host name is the drive keeping off the testnet, not a fault.
        if (this.ours(t) && e.level === 'error' && !/ERR_NAME_NOT_RESOLVED|sequentiatestnet\.com/.test(e.text + (e.url || ''))) {
          this.problems.push(`log error in ${where}: ${e.text}`);
        }
      }
    }
    for (const h of this.handlers) { try { h(m); } catch {} }
  }

  async targets() { return (await this.send('Target.getTargets', { filter: FILTER })).targetInfos; }

  async waitTarget(pred, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      if (Date.now() - t0 > ms) throw new Error('no target appeared in ' + ms + ' ms');
      await sleep(200);
    }
  }

  async serviceWorker() {
    const t = await this.waitTarget((x) => x.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url), 60000);
    this.extId = new URL(t.url).host;
    return t;
  }

  async page(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    return this.pageOf(targetId);
  }

  async pageOf(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId).catch(() => {});
    await this.send('Runtime.enable', {}, sessionId).catch(() => {});
    return new Page(this, targetId, sessionId);
  }

  async close() {
    clearInterval(this.sweep);
    try { await this.send('Browser.close'); } catch {}
    await new Promise((r) => (this.proc.exitCode != null ? r() : this.proc.once('exit', r)));
    try { this.ws.close(); } catch {}
    this.sessions.clear();
    this.attachedIds.clear();
  }
}

export class Page {
  constructor(b, targetId, sessionId) { Object.assign(this, { b, targetId, sessionId }); }
  async eval(expression) {
    const r = await this.b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expression, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.eval(expression)) return; } catch {}
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + expression);
      await sleep(250);
    }
  }
  async front() { await this.b.send('Target.activateTarget', { targetId: this.targetId }).catch(() => {}); await this.b.send('Page.bringToFront', {}, this.sessionId).catch(() => {}); }
  async shot(file) {
    await this.front();
    const { data } = await this.b.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
  click(sel) { return this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no ${sel.replace(/'/g, '')}'); e.click(); return true})()`); }
  set(id, v) { return this.eval(`(()=>{const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(String(v))}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new Event('change')); return true})()`); }
  text(sel) { return this.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`); }
}

export { sleep };

// Load the unpacked extension in a headless Chromium, start it again from the
// same profile, and report every error its service worker throws, both times.
// The second start reads the files from disk afresh, which is what reloading
// an unpacked extension does (chrome.runtime.reload() unloads an extension
// given on the command line instead of loading it again).
//
//   CHROME=/path/to/chrome node scripts/sw-console-check.mjs
//
// A module that fails to parse or link (a duplicate declaration, an import the
// committed pkg/ does not export) kills the whole service worker, and Chromium
// reports it only in the worker's own console. Attaching replays what the
// worker already threw, and a worker that never finished loading cannot answer
// the popup's message, which the check sends each time. All host names
// resolve to nothing: the check reaches no server.
//
// Exits non-zero on any exception or console error from the worker.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME;
if (!CHROME) { console.error('set CHROME to a Chromium or Chrome for Testing binary'); process.exit(2); }
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-sw-check-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(label) {
  const chrome = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    chrome.once('exit', (c) => reject(new Error('chrome exited ' + c + '\n' + buf)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  const problems = [];
  const workers = [];
  const attached = new Set();
  // This extension's worker; Chromium runs component extensions of its own.
  const isOurWorker = (t) => t && t.type === 'service_worker'
    && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url);
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if ((m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged')
        && isOurWorker(m.params.targetInfo) && !attached.has(m.params.targetInfo.targetId)) {
      attached.add(m.params.targetInfo.targetId);
      send('Target.attachToTarget', { targetId: m.params.targetInfo.targetId, flatten: true })
        .catch(() => attached.delete(m.params.targetInfo.targetId));
      return;
    }
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      if (isOurWorker(targetInfo)) {
        attached.add(targetInfo.targetId);
        workers.push({ sessionId, url: targetInfo.url });
        // Enabling replays what the worker has already thrown or logged.
        await send('Runtime.enable', {}, sessionId);
        await send('Log.enable', {}, sessionId).catch(() => {});
      }
      if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    const w = workers.find((x) => x.sessionId === m.sessionId);
    if (!w) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      problems.push(`exception in ${w.url}: ${(d.exception && d.exception.description) || d.text}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      problems.push(`console.error in ${w.url}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const e = m.params.entry;
      // A blocked host name is the check working, not the extension failing.
      if (!/ERR_NAME_NOT_RESOLVED|Failed to fetch/.test(e.text)) problems.push(`log error in ${w.url}: ${e.text}`);
    }
  });
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  try {
    for (let i = 0; i < 100 && !workers.length; i++) await sleep(100);
    if (!workers.length) throw new Error('no service worker started (it may have failed to register)');
    await sleep(3000);   // let the worker's start-up run its course
    const worker = workers[0];
    const id = new URL(worker.url).host;
    const v = await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().version', returnByValue: true }, worker.sessionId);
    console.log(`${label}: service worker ${worker.url} registered, version ${v.result.value}`);

    // The popup's view: the staking module loads and reports itself
    // supported, and the worker answers a UI message.
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${id}/popup/popup.html` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(2000);
    const r = await send('Runtime.evaluate', {
      expression: "import('/src/staking.js').then((m) => ({ supported: m.supported(), createVbytes: m.CREATE_VBYTES.toString(), spendVbytes: m.SPEND_VBYTES.toString() }))",
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error('staking.js in the popup: ' + r.exceptionDetails.exception.description);
    console.log(`${label}: popup imports staking.js:`, JSON.stringify(r.result.value));
    if (!r.result.value.supported) problems.push('staking.supported() is false with the committed pkg/');
    const ping = await send('Runtime.evaluate', {
      expression: "chrome.runtime.sendMessage({ scope: 'ui', method: 'stakingOverview', params: {} })",
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (ping.exceptionDetails) throw new Error('UI message: ' + ping.exceptionDetails.exception.description);
    console.log(`${label}: worker answers stakingOverview (no wallet open):`, JSON.stringify(ping.result.value));
    if (!ping.result.value) problems.push('the service worker did not answer a UI message');

    // The offscreen document, as the worker brings it up for a job: it must
    // load and answer the build handshake with this build's version, or every
    // offscreen job (Lightning swaps, orders, the leaf wallet) fails.
    const hello = await send('Runtime.evaluate', {
      expression: `(async () => {
        const v = chrome.runtime.getManifest().version;
        try { await chrome.offscreen.closeDocument(); } catch {}
        await chrome.offscreen.createDocument({ url: 'offscreen.html?v=' + v, reasons: ['WORKERS'], justification: 'check' });
        let got = null;
        for (let i = 0; i < 60 && !got; i++) {
          try { got = await chrome.runtime.sendMessage({ scope: 'oln', op: 'hello' }); } catch {}
          if (!got) await new Promise((r) => setTimeout(r, 250));
        }
        return { manifest: v, offscreen: got && got.version };
      })()`,
      awaitPromise: true, returnByValue: true,
    }, worker.sessionId);
    if (hello.exceptionDetails) throw new Error('offscreen document: ' + hello.exceptionDetails.exception.description);
    console.log(`${label}: offscreen handshake:`, JSON.stringify(hello.result.value));
    if (hello.result.value.offscreen !== hello.result.value.manifest) {
      problems.push(`the offscreen document answers build ${hello.result.value.offscreen}, the manifest is ${hello.result.value.manifest}: every offscreen job would fail`);
    }
  } catch (e) {
    problems.push(String(e.message || e));
  }
  chrome.kill();
  await new Promise((r) => (chrome.exitCode != null ? r() : chrome.once('exit', r)));
  return problems.map((p) => `${label}: ${p}`);
}

const problems = [...await session('first start'), ...await session('restart')];
fs.rmSync(profile, { recursive: true, force: true });
if (problems.length) {
  console.log('PROBLEMS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('no exceptions or console errors from the service worker, on either start');
process.exit(0);

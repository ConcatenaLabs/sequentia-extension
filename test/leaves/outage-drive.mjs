#!/usr/bin/env node
// Every coin home with the operator gone, on the live testnet: Ambra browser from this checkout,
// headless, joined to the operator through the web wallet's tooling/live-proxy.mjs --cors (which
// forwards everything to the testnet and, with --refuse /arca, cuts the operator off from this
// wallet alone while the node and the rest still answer). One step a run, the wallet kept in
// <work> between runs:
//
//   setup                          a new wallet (its phrase in <work>/phrase, mode 600), developer
//                                  mode, the operator joined through the proxy
//   receive <file> <asset> <atoms> <minutes>   a receive request from the test site, written to
//                                  <file> for another wallet to pay; waits for it that long
//   coins [ms]                     the coins the leaf wallet holds
//   settle [minutes]               default mode, open until every coin held is a live leaf of a round
//   drill                          developer mode's Exit drill on the first leaf that has one
//   home                           default mode's Take my coins home: the card, the review, then
//                                  Take them home; written to <work>/home.json
//   homeinfo, rows                 what the service worker says of the way home, and the overview
//
//   CHROME=… PROXY=http://127.0.0.1:18796 node test/leaves/outage-drive.mjs <work> <step> [args…]
//
// Every host name but 127.0.0.1 resolves to nothing: the wallet reaches the testnet only through
// the proxy. Coins of one tree share their first steps: a drill on one coin puts its lineage on
// the chain, and the library then takes the coins resting on it home by itself, so run `home`
// on coins of their own round (`settle`) before any `drill`.
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser } from './cdp.mjs'

const EXT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const CHROME = process.env.CHROME
const PROXY = process.env.PROXY || 'http://127.0.0.1:18796'
const PW = 'outage-drive-password'
const [work, step, ...rest] = process.argv.slice(2)
if (!CHROME || !work || !step) { console.error('usage: CHROME=… node test/leaves/outage-drive.mjs <work> <step> [args…]'); process.exit(2) }
const out = join(work, 'evidence'); mkdirSync(out, { recursive: true })
const logf = join(out, 'drive.log')
const note = (s) => { const l = `[${new Date().toISOString()}] ${step}: ${s}`; console.log(l); appendFileSync(logf, l + '\n') }
const waitVal = async (p, expr, ms) => { await p.waitFor(expr, ms); return await p.eval(expr) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let n = 0
const shot = async (p, name) => { const f = join(out, `${String(++n).padStart(2, '0')}-${step}-${name}.png`); await p.shot(f) }

// The test site, on this machine.
const site = createServer((req, res) => {
  const f = req.url.startsWith('/site.js') ? 'site.js' : 'site.html'
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' })
  res.end(readFileSync(join(EXT, 'test/leaves', f)))
})
await new Promise((ok) => site.listen(18897, '127.0.0.1', ok))

const b = new Browser({ chrome: CHROME, profile: join(work, 'chrome-profile'), ext: EXT, consoleLog: join(out, 'console.log'), headless: true,
  extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })

async function unlock () {
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`)
  await pop.waitFor("(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick) || (document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide'))", 60000)
  if (await pop.eval("!!(document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null)")) {
    await pop.set('unlockPw', PW); await pop.click('#btnUnlock')
  }
  await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000)
  return pop
}
const ui = (pop, method, params = {}) => pop.eval(`new Promise((ok) => chrome.runtime.sendMessage({ scope: 'ui', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }, (r) => ok(r)))`)

async function approve (name, decide = true, ms = 120000) {
  const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), ms)
  const a = await b.pageOf(t.targetId)
  await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 60000)
  const body = await a.text('#reqCard')
  note(`approval ${name}: ${body.replace(/\s+/g, ' ').slice(0, 700)}`)
  await shot(a, name)
  await a.click(decide ? '#btnApprove' : '#btnReject')
  for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100)
  return body
}

async function openSite () {
  const s = await b.page('http://127.0.0.1:18897/site.html')
  await s.waitFor('window.siteEvents', 60000)
  const done = (method) => s.waitFor(`document.querySelector('#out').dataset.method === ${JSON.stringify(method)} && document.querySelector('#out').dataset.ok !== ''`, 900000)
  const answer = async () => ({ ok: await s.eval("document.querySelector('#out').dataset.ok === '1'"), text: await s.eval("document.querySelector('#out').textContent") })
  const press = async (btn) => { await s.eval("document.querySelector('#out').dataset.method=''"); await s.click(btn) }
  await press('#btnConnect')
  // Connected already by an earlier run: no approval window comes.
  await approve('connect', true, 8000).catch(() => null)
  await done('connect')
  return { s, done, answer, press }
}

try {
  await b.launch(step)
  await b.serviceWorker()
  await sleep(2000)
  note("extension " + b.extId)
  if (step === 'setup') {
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`)
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000)
    await pop.click('#btnStartCreate')
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase")
    const phrase = await pop.eval("document.querySelector('#newPhrase').dataset.phrase")
    writeFileSync(join(work, 'phrase'), phrase + '\n', { mode: 0o600 })
    await pop.set('createPw', PW); await pop.set('createPw2', PW)
    await pop.click('#btnCreateGo')
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000)
    note('wallet created through the popup (phrase kept in the work directory, mode 600)')
    await pop.click('[data-tab=settings]')
    await sleep(2000)
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return true})()")
    await pop.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000)
    await pop.set('leafServer', PROXY + '/arca'); await pop.set('leafNodeUrl', PROXY + '/node-rpc')
    await pop.click('#btnLeafJoin')
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 300000)
    note('joined: operator ' + (await pop.text('#leafOperator')).trim() + ' · ' + (await pop.text('#leafServerShown')).trim() + ' · status ' + (await pop.text('#leafStatus')).trim())
    await shot(pop, 'joined')
  } else if (step === 'receive') {
    const [file, asset, atoms, mins] = rest
    const pop = await unlock()
    const { s, done, answer, press } = await openSite()
    await s.set('asset', asset); await s.set('amount', atoms)
    await press('#btnReceive')
    await approve('receive')
    await done('requestLeafReceive')
    const a = await answer()
    if (!a.ok) throw new Error('requestLeafReceive: ' + a.text)
    const j = JSON.parse(a.text)
    const req = j.request || j
    writeFileSync(file, typeof req === 'string' ? req : JSON.stringify(req))
    note('request written to ' + file + ': ' + String(typeof req === 'string' ? req : JSON.stringify(req)).slice(0, 40) + '…')
    const until = Date.now() + Number(mins || 15) * 60000
    while (Date.now() < until) {
      await press('#btnBalances'); await done('getLeafBalances')
      const bal = await answer()
      note('balances: ' + bal.text.slice(0, 400))
      if (bal.ok && JSON.stringify(JSON.parse(bal.text).leaves || {}).includes(asset)) break
      await sleep(20000)
    }
    await shot(pop, 'after-receive')
  } else if (step === 'coins') {
    const pop = await unlock()
    await sleep(Number(rest[0] || 20000))
    const r = await ui(pop, 'default.leaf', { command: 'coins' })
    writeFileSync(join(work, 'coins.json'), JSON.stringify(r, null, 1))
    const coins = ((r && r.result) || {}).coins || (r && r.result) || []
    note('coins: ' + JSON.stringify(Array.isArray(coins) ? coins.map((c) => ({ leaf: c.leaf_id, state: c.state, kind: c.kind, value: c.value })) : r).slice(0, 2000))
  } else if (step === 'exit') {
    const pop = await unlock()
    await sleep(15000)
    const r = await ui(pop, 'default.leaf', { command: 'coins' })
    const coins = (((r && r.result) || {}).coins || []).filter((c) => ['live', 'pending', 'given'].includes(c.state) || c.state === 'operator-confirmed')
    note(`${coins.length} coin(s) to take home: ` + coins.map((c) => `${c.leaf_id.slice(0, 12)} ${c.state} ${c.value}`).join('; '))
    const { s, done, answer, press } = await openSite()
    const runs = []
    for (const c of coins) {
      await s.set('leafId', c.leaf_id); await s.set('feeAsset', '')
      const t = Date.now()
      await press('#btnExit')
      const screen = await approve('exit-' + c.leaf_id.slice(0, 8))
      await done('exitLeaf')
      const a = await answer()
      runs.push({ leaf: c.leaf_id, value: c.value, screen, ok: a.ok, answer: a.text, seconds: (Date.now() - t) / 1000 })
      note(`exit ${c.leaf_id.slice(0, 12)}: ${a.ok ? 'ok' : 'REFUSED'} ${a.text.slice(0, 900)}`)
      writeFileSync(join(work, 'exit.json'), JSON.stringify(runs, null, 1))
      await shot(s, 'exit-answer')
    }
  } else if (step === 'homeinfo') {
    const pop = await unlock()
    for (let i = 0; i < 12; i++) {
      await sleep(15000)
      const r = await ui(pop, 'leaves.home')
      note('leaves.home: ' + JSON.stringify(r).slice(0, 600))
      note('card: ' + JSON.stringify(await pop.eval("(()=>{const c=document.querySelector('#homeCard'); return c ? c.className + ' | ' + c.innerText : 'none'})()")))
      if (r && r.result && r.result.home && r.result.home.unreachable) break
    }
  } else if (step === 'rows') {
    const pop = await unlock()
    await sleep(Number(rest[0] || 60000))
    const ov = await ui(pop, 'overview', { withLn: false })
    note('rows: ' + JSON.stringify(((ov && ov.result && ov.result.rows) || []).map((r) => ({ key: String(r.key).slice(0, 12), ticker: r.ticker, total: r.total, leaves: r.leaves }))))
    const r = await ui(pop, 'default.leaf', { command: 'coins' })
    const coins = ((r && r.result) || {}).coins || []
    note('coins: ' + JSON.stringify(coins.map((c) => ({ leaf: c.leaf_id.slice(0, 12), state: c.state, note: (c.note || '').slice(0, 160) }))))
    note('card: ' + JSON.stringify(await pop.eval("(()=>{const c=document.querySelector('#homeCard'); return c ? c.className + ' | ' + c.innerText : 'none'})()")))
    await shot(pop, 'rows')
  } else if (step === 'settle') {
    // Default mode, open until every live coin is a leaf of a round (the wallet refreshes what it
    // received by itself at the next round), up to `mins` minutes.
    const pop = await unlock()
    await pop.click('[data-tab=settings]'); await sleep(1500)
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); if(s.value!=='user'){ s.value='user'; s.dispatchEvent(new Event('change')) } return true})()")
    const until = Date.now() + Number(rest[0] || 25) * 60000
    let coins = []
    while (Date.now() < until) {
      await sleep(30000)
      const r = await ui(pop, 'default.leaf', { command: 'coins' })
      const res = r && r.result
      coins = (Array.isArray(res) ? res : (res && res.coins) || []).map((c) => ({ leaf: c.leaf_id, state: c.state, kind: c.kind, value: c.value }))
      note('coins: ' + JSON.stringify(coins.filter((c) => !['spent', 'exited'].includes(c.state)).map((c) => `${c.leaf.slice(0, 12)} ${c.state} ${c.kind}`)))
      const held = coins.filter((c) => ['live', 'pending', 'given', 'forfeited'].includes(c.state))
      if (held.length >= 2 && held.every((c) => c.state === 'live' && c.kind === 'batch')) break
    }
    writeFileSync(join(work, 'coins-settled.json'), JSON.stringify(coins, null, 1))
  } else if (step === 'drill') {
    // Developer mode's Exit drill, from the popup's own Leaves list: the first coin that has one.
    const pop = await unlock()
    await pop.click('[data-tab=settings]')
    await sleep(2000)
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); if(s.value!=='developer'){ s.value='developer'; s.dispatchEvent(new Event('change')) } return true})()")
    await pop.waitFor("document.querySelectorAll('#leafCoins .leaf-coin').length > 0", 300000)
    note('leaves listed: ' + (await pop.eval("[...document.querySelectorAll('#leafCoins .leaf-coin')].map(d=>d.dataset.leaf.slice(0,12)+' '+d.dataset.state).join('; ')")).replace(/\n+/g, ' | ').slice(0, 900))
    note('leaf status: ' + (await pop.text('#leafStatus')))
    await shot(pop, 'dev-leaves')
    const leaf = await pop.eval("(()=>{ const d=[...document.querySelectorAll('#leafCoins .leaf-coin')].find(x=>x.querySelector('button[data-action=exit]')); return d ? d.dataset.leaf : null })()")
    if (!leaf) throw new Error('no leaf with an Exit drill')
    await pop.click(`.leaf-coin[data-leaf="${leaf}"] button[data-action=exit]`)
    const q = await waitVal(pop, "(()=>{ const q=document.querySelector('#leafExitQuote'); if(q) return q.innerText; const s=document.querySelector('#leafStatus'); return /err/.test(s.className) ? 'ERR '+s.innerText : false })()", 300000)
    note('quote for ' + leaf + ': ' + q.replace(/\n+/g, ' | '))
    await shot(pop, 'dev-quote')
    if (q.startsWith('ERR')) throw new Error(q)
    await pop.click('#btnLeafExitConfirm')
    const r = await waitVal(pop, `(()=>{ const d=document.querySelector('.leaf-coin[data-leaf="${leaf}"] .leaf-drill'); if(d) return d.innerText; const s=document.querySelector('#leafStatus'); return /err/.test(s.className) ? 'ERR '+s.innerText : false })()`, 600000)
    note('drill: ' + r)
    await shot(pop, 'dev-drill')
    writeFileSync(join(work, 'drill.json'), JSON.stringify({ leaf, quote: q, result: r }, null, 1))
    if (!/broadcast [0-9a-f]{64}/.test(r)) process.exitCode = 1
  } else if (step === 'home') {
    // Default mode's card: Take my coins home, the review, then Take them home.
    const pop = await unlock()
    await pop.click('[data-tab=settings]')
    await sleep(2000)
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); if(s.value!=='user'){ s.value='user'; s.dispatchEvent(new Event('change')) } return true})()")
    await sleep(2000)
    await pop.click('[data-tab=balance]')
    const t = Date.now()
    const card = await waitVal(pop, "(()=>{ const b=document.querySelector('#btnTakeHome'); return b && b.offsetParent !== null ? document.querySelector('#homeCard').innerText : false })()", 900000)
    note(`card after ${((Date.now() - t) / 1000).toFixed(1)} s: ` + card.replace(/\n+/g, ' | '))
    await shot(pop, 'home-card')
    await pop.click('#btnTakeHome')
    const review = await waitVal(pop, "(()=>{ const m=document.querySelector('.modal'); if(!m) return false; const ok=document.querySelector('#btnTakeHomeConfirm'); const st=m.querySelector('.status'); return (ok && !ok.disabled) || (st && /err/.test(st.className)) ? m.innerText : false })()", 900000)
    note('review: ' + review.replace(/\n+/g, ' | '))
    await shot(pop, 'home-review')
    const out = { card, review }
    if (await pop.eval("!!(document.querySelector('#btnTakeHomeConfirm') && !document.querySelector('#btnTakeHomeConfirm').disabled)")) {
      await pop.click('#btnTakeHomeConfirm')
      out.result = await waitVal(pop, "(()=>{ const m=document.querySelector('.modal'); const ok=document.querySelector('#btnTakeHomeConfirm'); return m && ok && ok.classList.contains('hide') ? m.innerText : false })()", 1800000)
      note('result: ' + out.result.replace(/\n+/g, ' | '))
      await shot(pop, 'home-sent')
      if (!/on its way to your own address/.test(out.result) || /cannot be taken home/.test(out.result)) process.exitCode = 1
      await pop.eval("document.querySelector('.modal button.ghost').click()")
      await sleep(3000)
      out.after = await pop.eval("document.querySelector('#homeCard').innerText")
      note('card after: ' + out.after.replace(/\n+/g, ' | '))
      await shot(pop, 'home-after')
    } else process.exitCode = 1
    writeFileSync(join(work, 'home.json'), JSON.stringify(out, null, 1))
  } else {
    throw new Error('no step ' + step)
  }
} catch (e) {
  note('FAIL ' + (e && e.stack || e))
  process.exitCode = 1
} finally {
  await b.close().catch(() => {})
  site.close()
  setTimeout(() => process.exit(), 1000)
}

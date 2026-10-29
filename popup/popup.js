// Popup UI. All wallet logic lives in the background engine; this file only
// renders state and relays user intents over the ui RPC scope.
import { lnInvoiceKind } from '../src/util.js';
import { userSplit, developerSplit } from '../src/balance-view.js';
import { plannedCoins } from '../src/leaf-schedule.js';
import { frozenSentence, plainRefusal, batchLine } from '../src/leaf-profiles.js';
import { DEFAULT_WORDS, heldAssetList } from '../vendor/default-arca.js';
import { BTC_WORDS } from '../vendor/btc-ark.js';
import { createEngine as createUserTrade } from '../vendor/user-trade.js';
import { mountUserComposer } from '../vendor/user-composer.js';
import { admittedReceives } from '../vendor/tooling/lsp/single-step-book.mjs';
import * as seqob from '../vendor/seqob.js';
import { toWire, fromWire } from '../src/wire.js';
import { BASE, ESPLORA, USER_PAIRS_URL, LEAF_MAKERS } from '../src/config.js';
import { REPORT_WORDS, createErrorLog, buildReport, sendReport, sentWords } from '../vendor/problem-report.js';

// The popup's recent errors: what it threw and every error it showed (.status.err).
const popupErrors = createErrorLog();
popupErrors.install(window, console);
new MutationObserver((ms) => {
  for (const m of ms) {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    const e = t && t.closest && t.closest('.status.err');
    if (e && e.id !== 'reportStatus' && e.textContent.trim()) popupErrors.note(e.textContent.trim());
  }
}).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });

const $ = (id) => document.getElementById(id);
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ scope: 'ui', method, params }, (resp) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (resp && resp.ok) resolve(resp.result);
    else reject(new Error((resp && resp.error) || 'request failed'));
  });
});

// Keep the service worker (and its wasm engine) warm while the popup is open.
try { chrome.runtime.connect({ name: 'seq-ui' }); } catch {}

function fmtAtoms(atoms, d) {
  let a = BigInt(atoms); const neg = a < 0n; if (neg) a = -a;
  const base = 10n ** BigInt(d);
  let s = (a / base).toString();
  if (d > 0) { const f = (a % base).toString().padStart(d, '0').replace(/0+$/, ''); if (f) s += '.' + f; }
  return (neg ? '-' : '') + s;
}
const looksLikeBolt11 = (s) => /^ln(bc|tb|tbs|ert|sq|tsq)[0-9a-z]+$/i.test((s || '').trim());

const VIEWS = ['vBoot', 'vWelcome', 'vCreate', 'vImport', 'vUnlock', 'vApp'];
function view(id) { for (const v of VIEWS) $(v).classList.toggle('hide', v !== id); }

const TABS = ['balance', 'send', 'receive', 'trade', 'stake', 'history', 'settings'];
function tab(name) {
  for (const t of TABS) $('t' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hide', t !== name);
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  if (name === 'receive') { if (isDefault()) renderDefaultReceive(); else renderReceive(); }
  if (name === 'history') renderHistory();
  if (name === 'settings') { renderSettings(); paintReport(); }
  if (name === 'send') { if (isDefault()) fillDefaultSend(); else fillSendSelectors(); }
  if (name === 'trade') renderTrade();
  if (name === 'stake') { renderStakes(); renderStake(); renderRewards(); }
}
for (const b of document.querySelectorAll('.tabs [data-tab]')) b.onclick = () => tab(b.dataset.tab);

let OV = null;   // last overview snapshot

// ---- boot / routing ----
async function boot() {
  const st = await rpc('state');
  if (!st.hasVault) { view('vWelcome'); return; }
  if (!st.unlocked) { view('vUnlock'); setTimeout(() => $('unlockPw').focus(), 50); return; }
  view('vApp');
  await refreshOverview();
}

// ---- onboarding ----
$('btnStartCreate').onclick = async () => {
  const { mnemonic } = await rpc('generateMnemonic');
  const box = $('newPhrase'); box.innerHTML = '';
  mnemonic.split(' ').forEach((w, i) => {
    const s = el('span'); const n = el('i', null, String(i + 1)); s.appendChild(n); s.appendChild(document.createTextNode(w)); box.appendChild(s);
  });
  box.dataset.phrase = mnemonic;
  view('vCreate');
};
$('btnCreateBack').onclick = () => view('vWelcome');
$('btnCreateGo').onclick = async () => {
  $('createErr').textContent = '';
  const pw = $('createPw').value;
  if (pw !== $('createPw2').value) { $('createErr').textContent = 'Passwords do not match.'; return; }
  try {
    $('btnCreateGo').disabled = true;
    await rpc('create', { mnemonic: $('newPhrase').dataset.phrase, password: pw });
    view('vApp'); await refreshOverview();
  } catch (e) { $('createErr').textContent = e.message; }
  finally { $('btnCreateGo').disabled = false; }
};
$('btnStartImport').onclick = () => view('vImport');
$('btnImportBack').onclick = () => view('vWelcome');
$('btnImportGo').onclick = async () => {
  $('importErr').textContent = '';
  const pw = $('importPw').value;
  if (pw !== $('importPw2').value) { $('importErr').textContent = 'Passwords do not match.'; return; }
  try {
    $('btnImportGo').disabled = true;
    await rpc('create', { mnemonic: $('importPhrase').value, password: pw });
    view('vApp'); await refreshOverview();
  } catch (e) { $('importErr').textContent = e.message; }
  finally { $('btnImportGo').disabled = false; }
};

// ---- unlock / lock ----
$('btnUnlock').onclick = async () => {
  $('unlockErr').textContent = '';
  try {
    $('btnUnlock').disabled = true;
    await rpc('unlock', { password: $('unlockPw').value });
    view('vApp'); await refreshOverview();
  } catch (e) { $('unlockErr').textContent = e.message; }
  finally { $('btnUnlock').disabled = false; }
};
$('unlockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnUnlock').click(); });
$('btnLock').onclick = async () => { await rpc('lock'); view('vUnlock'); };

// ---- balance ----
async function refreshOverview() {
  // Fast paint without Lightning, then a second pass folding LN in.
  try { OV = await rpc('overview', { withLn: false }); renderOverview(); } catch (e) { $('syncNote').textContent = e.message; }
  rpc('sync').then(async () => {
    OV = await rpc('overview', { withLn: true });
    renderOverview();
  }).catch((e) => { $('syncNote').className = 'status err'; $('syncNote').textContent = 'Sync failed: ' + e.message; });
}

function renderOverview() {
  if (!OV) return;
  applyMode();
  $('headline').textContent = OV.totalRefStr || '—';
  $('headlineSub').textContent = 'Portfolio total' + (OV.pricesStale ? ' · prices may be stale' : '');
  $('syncNote').className = 'status';
  $('syncNote').textContent = OV.scanned ? '' : 'Syncing…';
  const refSel = $('refSel'); refSel.innerHTML = '';
  const opts = OV.refOptions.includes(OV.ref) ? OV.refOptions : [...OV.refOptions, OV.ref];
  for (const o of opts) { const op = el('option', null, o); op.value = o; if (o === OV.ref) op.selected = true; refSel.appendChild(op); }
  refSel.onchange = async () => { await rpc('setSettings', { refCcy: refSel.value }); refreshOverview(); };

  const list = $('assetList'); list.innerHTML = '';
  if (OV.pendingMove && OV.pendingMove.ticker) {
    const n = el('div', 'status', 'Finishing a pending move of ' + OV.pendingMove.ticker + ' to Lightning…');
    list.appendChild(n);
  }
  // Each figure counts every part (on-chain, leaves, Lightning and, for the Sequence
  // token, staked) in both modes. User mode shows that one figure, its parts a tap away
  // in plain words; developer mode names every rail under it, with Move to and from
  // Lightning.
  const dev = OV.mode === 'developer';
  for (const r of OV.rows) {
    const row = el('div', 'asset-row'); row.dataset.key = r.key;
    const head = el('div', 'arow-head');
    const tk = el('span', 'tk', r.ticker); tk.title = r.ticker; head.appendChild(tk);
    if (r.verified) { const b = el('span', 'badge-v', '✓'); b.title = r.key === 'BTC' ? 'Bitcoin, the parent chain' : (r.domain ? 'Verified · ' + r.domain : 'Verified in the Sequentia asset registry'); head.appendChild(b); }
    else if (!r.registered) { const b = el('span', 'badge-u', '⚠'); b.title = 'Not in the asset registry. Anyone can issue an asset with any ticker; verify the issuer before trusting it.'; head.appendChild(b); }
    const mid = el('div', 'grow');
    const nm = el('div', 'sub', r.name); nm.title = r.name + (r.domain ? ' · registered by ' + r.domain : '');
    mid.appendChild(nm); head.appendChild(mid);
    const amt = el('span', 'amt');
    amt.appendChild(el('div', 'fig', fmtAtoms(r.total, r.precision)));
    if (r.refStr) amt.appendChild(el('div', 'sub', r.refStr));
    head.appendChild(amt);
    row.appendChild(head);
    // A holding its issuer has frozen for this wallet: one plain sentence, in both modes,
    // never hidden.
    if (BigInt(r.frozen || 0) > 0n) row.appendChild(el('div', 'sub frozen-line', frozenSentence(fmtAtoms(r.frozen, r.precision), r.ticker)));
    // Default mode: what is held but cannot be spent yet, under the figure.
    if (!(OV.mode === 'developer') && BigInt(r.arriving || 0) > 0n) row.appendChild(el('div', 'sub arriving-line', DEFAULT_WORDS.arriving(fmtAtoms(r.arriving, r.precision), r.ticker)));

    if (r.restricted && r.legend) {
      const meta = el('div', 'ln-meta'); meta.appendChild(el('div', null, r.legend)); row.appendChild(meta);
    }
    const fmt = (v) => fmtAtoms(v, r.precision);
    if (!dev) {
      const split = userSplit(r, fmt);
      if (split) {
        row.classList.add('tappable'); row.title = 'Show where this balance is';
        if (SPLIT_OPEN.has(r.key)) row.appendChild(el('div', 'sub rail-split', split));
        row.onclick = () => { if (SPLIT_OPEN.has(r.key)) SPLIT_OPEN.delete(r.key); else SPLIT_OPEN.add(r.key); renderOverview(); };
      }
      list.appendChild(row);
      continue;
    }
    // Developer mode: every rail of the asset on one line. BTC is never a leaf.
    if (r.key !== 'BTC' && !r.restricted) row.appendChild(el('div', 'sub rail-split', developerSplit(r, fmt)));
    if (r.key === 'BTC' && BigInt(r.ark || 0) > 0n) row.appendChild(el('div', 'sub rail-split', fmt(r.onchain) + ' on-chain · ' + fmt(r.ark) + ' on the Bitcoin ark' + (BigInt(r.ln || 0) > 0n ? ' · ' + fmt(r.ln) + ' Lightning' : '')));
    const lnAtoms = BigInt(r.ln || 0);
    const canMove = (r.key === 'BTC' || r.feePriced) && !r.restricted;
    if (OV.lnDeployed && canMove && (lnAtoms > 0n || BigInt(r.onchain) > 0n)) {
      const meta = el('div', 'ln-meta');
      meta.appendChild(el('div', null, lnAtoms > 0n
        ? '⚡ ' + fmtAtoms(r.ln, r.precision) + ' ' + r.ticker + ' in Lightning · ' + fmtAtoms(r.onchain, r.precision) + ' on-chain'
        : '⚡ Not in Lightning yet · ' + fmtAtoms(r.onchain, r.precision) + ' ' + r.ticker + ' on-chain'));
      const acts = el('div', 'bal-acts');
      if (BigInt(r.onchain) > 0n) {
        const b = el('button', 'ghost tiny', lnAtoms > 0n ? 'Add to Lightning' : 'Move to Lightning');
        b.onclick = () => moveDialog(r);
        acts.appendChild(b);
      }
      if (lnAtoms > 0n) {
        const c = el('button', 'ghost tiny', 'Move to chain');
        c.onclick = () => closeDialog(r);
        acts.appendChild(c);
      }
      meta.appendChild(acts);
      row.appendChild(meta);
    }
    list.appendChild(row);
  }
}
// The rows whose split is open in user mode, kept across renders.
const SPLIT_OPEN = new Set();

// ---- modals ----
function modal(title) {
  const m = el('div', 'modal'); const c = el('div', 'card');
  c.appendChild(el('h2', null, title));
  m.appendChild(c); document.body.appendChild(m);
  return { m, c };
}
function toast(text) {
  const n = el('div', 'status ok', text);
  n.style.cssText = 'position:fixed;bottom:12px;left:14px;right:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;z-index:20';
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 5000);
}

function moveDialog(r) {
  const { m, c } = modal('Move ' + r.ticker + ' to Lightning');
  c.appendChild(el('p', 'sub', 'Your wallet sends the amount on-chain to your own hosted node, then your device co-signs opening a Lightning channel. Non-custodial: only your device can spend these funds.'));
  const inp = el('input', 'mono'); inp.placeholder = 'Amount (' + r.ticker + ')'; c.appendChild(inp);
  c.appendChild(el('div', 'sub', 'Available on-chain: ' + fmtAtoms(r.onchain, r.precision) + ' ' + r.ticker));
  const st = el('div', 'status'); const row = el('div', 'row');
  const ok = el('button', 'primary', 'Move'); const no = el('button', 'ghost', 'Cancel');
  row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.appendChild(st);
  no.onclick = () => m.remove();
  lnProgressTarget = st;
  ok.onclick = async () => {
    ok.disabled = no.disabled = true;
    // Once the deposit is SENT the move is persisted and self-healing (the
    // background worker finishes or resumes the channel open), so the dialog
    // must stop holding the user hostage: Cancel becomes a real exit.
    const watch = setInterval(() => {
      if (/deposit sent|waiting for (the deposit|it) to confirm|opening the lightning channel|funding broadcast/i.test(st.textContent)) {
        no.disabled = false; no.textContent = 'Continue in background';
        no.onclick = () => { clearInterval(watch); m.remove(); toast('Your ' + r.ticker + ' channel keeps opening in the background; the balance row shows ⚡ when it is ready.'); };
      }
    }, 1000);
    try {
      const atoms = parseAmount(inp.value, r.precision);
      st.textContent = 'Starting…';
      await rpc('lnMove', { kind: r.key, amount: atoms.toString() });
      clearInterval(watch);
      st.className = 'status ok'; st.textContent = 'Done. Your ' + r.ticker + ' Lightning channel is active.';
      no.textContent = 'Close'; no.disabled = false; no.onclick = () => m.remove();
      refreshOverview();
    } catch (e) {
      clearInterval(watch);
      st.className = 'status err'; st.textContent = 'Failed: ' + e.message;
      ok.disabled = no.disabled = false;
    }
  };
}
function closeDialog(r) {
  const { m, c } = modal('Move ' + r.ticker + ' back on-chain');
  c.appendChild(el('p', 'sub', 'This closes your ' + r.ticker + ' Lightning channel and returns the funds to your wallet on-chain. Your device co-signs the close, so only you can move these funds.'));
  const st = el('div', 'status'); const row = el('div', 'row');
  const ok = el('button', 'primary', 'Move to chain'); const no = el('button', 'ghost', 'Cancel');
  row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.appendChild(st);
  no.onclick = () => m.remove();
  lnProgressTarget = st;
  ok.onclick = async () => {
    ok.disabled = no.disabled = true;
    try {
      const res = await rpc('lnClose', { kind: r.key });
      st.className = 'status ok';
      st.textContent = 'Close broadcast' + (res.closing_txid ? ' (' + res.closing_txid.slice(0, 16) + '…)' : '') + '. Funds return once it confirms.';
      no.textContent = 'Close'; no.disabled = false;
      refreshOverview();
    } catch (e) { st.className = 'status err'; st.textContent = 'Failed: ' + e.message; ok.disabled = no.disabled = false; }
  };
}

function parseAmount(str, d) {
  str = (str || '').trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error('enter a valid amount');
  let [i, f = ''] = str.split('.');
  if (f.length > d) throw new Error('max ' + d + ' decimals for this asset');
  f = (f + '0'.repeat(d)).slice(0, d);
  return BigInt(i) * (10n ** BigInt(d)) + BigInt(f || '0');
}

// ---- LN progress events ----
let lnProgressTarget = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.scope === 'ui-event') {
    if (msg.event === 'ln-progress' && lnProgressTarget && lnProgressTarget.isConnected) {
      lnProgressTarget.className = 'status'; lnProgressTarget.textContent = msg.text;
    }
    if (msg.event === 'locked') view('vUnlock');
    // The leaf wallet's balance changed: the figures and the headline count it.
    if (msg.event === 'leaves-changed' && OV) rpc('overview', { withLn: false }).then((v) => { OV = v; renderOverview(); if (isDefault() && !$('tSend').classList.contains('hide')) updateDefaultAvail(); }).catch(() => {});
  }
  // A leaf sync finished (on the schedule, or asked): show what it changed.
  if (msg && msg.scope === 'leaf-event' && (msg.event === 'leafSynced' || msg.event === 'leafCared' || msg.event === 'leafReleasing') && !$('leafCard').classList.contains('hide')) {
    renderLeaves().catch(() => {});
  }
});

// ---- send ----
async function fillSendSelectors() {
  if (!OV) return;
  const sel = $('sendAsset'); const prev = sel.value; sel.innerHTML = '';
  const add = (key, ticker) => { const o = el('option', null, ticker); o.value = key; sel.appendChild(o); };
  add('BTC', 'BTC');
  for (const r of OV.rows) if (r.key !== 'BTC') add(r.key, r.ticker);
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  sel.onchange = updateSendUi;
  try {
    const fa = await rpc('feeAssets');
    const fsel = $('feeAsset'); fsel.innerHTML = '';
    for (const a of fa.assets) { const o = el('option', null, a.ticker); o.value = a.hex; fsel.appendChild(o); }
  } catch {}
  const lsel = $('lnPayAsset'); lsel.innerHTML = '';
  for (const k of (OV.lnCapable || [])) {
    const row = OV.rows.find((r) => r.key === k);
    const o = el('option', null, k === 'BTC' ? 'BTC' : (row ? row.ticker : k.slice(0, 8)));
    o.value = k; lsel.appendChild(o);
  }
  updateSendUi();
}
function updateSendUi() {
  const to = $('sendTo').value.trim();
  const isLn = looksLikeBolt11(to);
  $('sendOnchain').classList.toggle('hide', isLn);
  $('sendLn').classList.toggle('hide', !isLn);
  if (isLn) {
    // The invoice names what it is paid in: select that node, or say why it cannot be paid.
    const inv = lnInvoiceKind(to), lsel = $('lnPayAsset');
    if (inv.error) { $('sendErr').className = 'status err'; $('sendErr').textContent = 'This is ' + inv.error + '.'; }
    else if ([...lsel.options].some((o) => o.value === inv.kind)) {
      lsel.value = inv.kind;
      $('sendErr').className = 'status'; $('sendErr').textContent = 'This invoice is paid in ' + lsel.selectedOptions[0].textContent + '.';
    } else {
      $('sendErr').className = 'status err';
      $('sendErr').textContent = 'This invoice is paid in an asset this wallet holds no Lightning balance in (' + inv.kind.slice(0, 8) + '…).';
    }
  }
  if (!isLn && OV) {
    const key = $('sendAsset').value;
    const row = OV.rows.find((r) => r.key === key);
    const isOamp = key.startsWith('oamp:');
    $('sendAvail').textContent = row ? ('Available: ' + fmtAtoms(row.onchain, row.precision) + ' ' + row.ticker + (isOamp ? ' (restricted; recipient is an AID)' : '')) : '';
    $('sendFeeRow').classList.toggle('hide', key === 'BTC' || isOamp);
  }
}
$('sendTo').addEventListener('input', updateSendUi);
// A refusal as the mode shows it: in user mode a coin its issuer froze is said plainly.
const refusalShown = (e) => (OV && OV.mode === 'developer' ? e.message : plainRefusal(e).message);

$('btnReview').onclick = async () => {
  $('sendErr').className = 'status'; $('sendErr').textContent = '';
  try {
    $('btnReview').disabled = true;
    const asset = $('sendAsset').value;
    const prep = await rpc('prepareSend', {
      rows: [{ addr: $('sendTo').value.trim(), amtS: $('sendAmt').value.trim(), asset }],
      feeAsset: $('feeAsset').value || undefined,
      feeRate: $('feeRate').value.trim() || undefined,
    });
    reviewModal(prep);
  } catch (e) { $('sendErr').className = 'status err'; $('sendErr').textContent = refusalShown(e); }
  finally { $('btnReview').disabled = false; }
};

function reviewModal(prep) {
  const { m, c } = modal('Confirm');
  const kv = [];
  const rv = prep.review;
  kv.push(['Network', rv.network]);
  if (rv.rows) for (const r of rv.rows) {
    const meta = OV.rows.find((x) => x.key === r.hex) || { ticker: r.hex === 'BTC' ? 'BTC' : r.hex.slice(0, 8), precision: 8 };
    kv.push(['→ ' + r.addr, fmtAtoms(r.atoms, meta.precision) + ' ' + meta.ticker]);
  }
  if (rv.recipientAid) {
    kv.push(['Recipient AID', rv.recipientAid]);
    kv.push(['Amount', fmtAtoms(rv.atoms, rv.precision) + ' ' + rv.ticker]);
    if (rv.convertFee) kv.push(['Fee (in-asset)', fmtAtoms(rv.convertFee, rv.precision) + ' ' + rv.ticker]);
    kv.push(['Spending', rv.spending + ' enclave output(s)']);
  }
  if (rv.feeAssetHex && rv.feeAssetHex !== 'BTC') {
    const meta = OV.rows.find((x) => x.key === rv.feeAssetHex);
    kv.push(['Fee paid in', rv.feeAssetHex === OV.policyHex ? 'tSEQ' : (meta ? meta.ticker : rv.feeAssetHex.slice(0, 8) + '…')]);
  }
  if (rv.feeEst) kv.push(['Network fee (est.)', rv.feeEst + ' atoms']);
  for (const [k, v] of kv) {
    const d = el('div', 'kv'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v)); c.appendChild(d);
  }
  const st = el('div', 'status'); const row = el('div', 'row');
  const ok = el('button', 'primary', 'Confirm & sign'); const no = el('button', 'ghost', 'Cancel');
  row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.appendChild(st);
  no.onclick = () => { rpc('dropSend', { id: prep.id, kind: prep.kind }).catch(() => {}); m.remove(); };
  ok.onclick = async () => {
    ok.disabled = no.disabled = true;
    st.textContent = 'Signing & broadcasting…';
    try {
      const res = await rpc('confirmSend', { id: prep.id, kind: prep.kind });
      m.remove();
      toast('Broadcast: ' + (res.txid || '').slice(0, 20) + '…');
      $('sendAmt').value = ''; $('sendTo').value = '';
      refreshOverview();
    } catch (e) { st.className = 'status err'; st.textContent = 'Failed: ' + refusalShown(e); ok.disabled = no.disabled = false; }
  };
}

$('btnLnPay').onclick = async () => {
  $('sendErr').className = 'status'; $('sendErr').textContent = 'Paying over Lightning…';
  lnProgressTarget = $('sendErr');
  try {
    $('btnLnPay').disabled = true;
    const r = await rpc('lnPay', { kind: $('lnPayAsset').value, bolt11: $('sendTo').value.trim() });
    $('sendErr').className = 'status ok';
    $('sendErr').textContent = 'Paid ✓' + (r.preimage ? ' · preimage ' + r.preimage.slice(0, 16) + '…' : '');
    $('sendTo').value = ''; updateSendUi(); refreshOverview();
  } catch (e) { $('sendErr').className = 'status err'; $('sendErr').textContent = 'Payment failed: ' + e.message; }
  finally { $('btnLnPay').disabled = false; }
};

// ---- receive ----
let recvConf = false, recvMode = 'onchain';
async function renderReceive() {
  $('recvOnchain').classList.toggle('hide', recvMode !== 'onchain');
  $('recvLn').classList.toggle('hide', recvMode !== 'ln');
  $('btnRecvMode').textContent = recvMode === 'onchain' ? 'Lightning' : 'On-chain';
  if (recvMode === 'onchain') {
    try {
      const a = await rpc('receive', { confidential: recvConf });
      $('recvAddr').textContent = a.address;
      $('recvQr').src = a.qr;
      $('btnConfToggle').textContent = recvConf ? 'Standard' : 'Confidential';
      $('recvTip').textContent = recvConf
        ? 'Confidential (tsqb1…): amounts and assets are hidden on-chain. Opt-in, Sequentia only.'
        : 'Standard (tb1…), Bitcoin-compatible: this same address also receives parent-chain BTC.';
    } catch (e) { $('recvStatus').className = 'status err'; $('recvStatus').textContent = e.message; }
  } else {
    const sel = $('lnRecvAsset'); sel.innerHTML = '';
    for (const k of (OV && OV.lnCapable) || []) {
      const row = OV.rows.find((r) => r.key === k);
      const o = el('option', null, k === 'BTC' ? 'BTC' : (row ? row.ticker : k.slice(0, 8)));
      o.value = k; sel.appendChild(o);
    }
  }
  // OpenAMP receive card
  const hasOamp = OV && OV.oampAid && OV.oampAssets && OV.oampAssets.length;
  $('recvOamp').classList.toggle('hide', !hasOamp);
  if (hasOamp) {
    $('oampAid').textContent = OV.oampAid;
    const sel = $('oampRecvAsset');
    if (!sel.dataset.filled) {
      sel.innerHTML = '';
      const none = el('option', null, 'Choose a restricted asset…'); none.value = ''; sel.appendChild(none);
      for (const a of OV.oampAssets) { const o = el('option', null, a.ticker || a.id.slice(0, 8)); o.value = a.id; sel.appendChild(o); }
      sel.dataset.filled = '1';
      sel.onchange = async () => {
        if (!sel.value) return;
        try {
          const r = await rpc('oampReceive', { assetId: sel.value });
          $('oampRecvAddr').textContent = r.address || '—';
          $('oampRecvAddr').classList.remove('hide');
          if (r.qr) { $('oampRecvQr').src = r.qr; $('oampRecvQr').classList.remove('hide'); }
        } catch (e) { $('recvStatus').className = 'status err'; $('recvStatus').textContent = e.message; }
      };
    }
  }
}
$('btnRecvMode').onclick = () => { recvMode = recvMode === 'onchain' ? 'ln' : 'onchain'; renderReceive(); };
$('btnConfToggle').onclick = () => { recvConf = !recvConf; renderReceive(); };
$('btnCopyAddr').onclick = () => { navigator.clipboard.writeText($('recvAddr').textContent).then(() => toast('Address copied.')); };
$('btnNewAddr').onclick = async () => {
  const a = await rpc('receive', { confidential: recvConf, fresh: true });
  $('recvAddr').textContent = a.address; $('recvQr').src = a.qr;
};
$('btnLnInvoice').onclick = async () => {
  $('recvStatus').className = 'status'; $('recvStatus').textContent = 'Creating invoice…';
  lnProgressTarget = $('recvStatus');
  try {
    $('btnLnInvoice').disabled = true;
    const kind = $('lnRecvAsset').value;
    const row = OV.rows.find((r) => r.key === kind);
    const prec = kind === 'BTC' ? 8 : (row ? row.precision : 8);
    const atoms = parseAmount($('lnRecvAmt').value, prec);
    const inv = await rpc('lnInvoice', { kind, amount: atoms.toString() });
    $('lnInvoiceOut').textContent = inv.bolt11;
    $('lnInvoiceOut').classList.remove('hide');
    $('btnCopyInvoice').classList.remove('hide');
    $('recvStatus').className = 'status ok'; $('recvStatus').textContent = 'Invoice ready. Share it to get paid.';
  } catch (e) { $('recvStatus').className = 'status err'; $('recvStatus').textContent = e.message; }
  finally { $('btnLnInvoice').disabled = false; }
};
$('btnCopyInvoice').onclick = () => { navigator.clipboard.writeText($('lnInvoiceOut').textContent).then(() => toast('Invoice copied.')); };

// ---- history ----
let histTab = 'seq', HIST = null;
for (const b of document.querySelectorAll('[data-htab]')) b.onclick = () => {
  histTab = b.dataset.htab;
  for (const x of document.querySelectorAll('[data-htab]')) x.classList.toggle('on', x === b);
  renderHistList();
};
async function renderHistory() {
  $('histList').innerHTML = '';
  $('histList').appendChild(el('p', 'sub', 'Loading…'));
  try { HIST = await rpc('history'); } catch (e) { $('histList').textContent = e.message; return; }
  renderHistList();
}
function renderHistList() {
  const list = $('histList'); list.innerHTML = '';
  if (!HIST) return;
  if (histTab === 'oamp') {
    const items = HIST.oamp || [];
    if (!items.length) { list.appendChild(el('p', 'sub', 'No restricted-asset transfers yet.')); return; }
    for (const t of items) {
      const item = el('div', 'item');
      item.appendChild(el('span', 'badge b-out', 'transfer'));
      const mid = el('div', 'grow');
      mid.appendChild(el('div', null, '→ ' + (t.recipient_aid || '').slice(0, 18) + '…'));
      mid.appendChild(el('div', 'sub', new Date(t.time).toLocaleString()));
      item.appendChild(mid);
      item.appendChild(el('span', 'amt neg', '-' + fmtAtoms(t.atoms, t.precision) + ' ' + t.ticker));
      list.appendChild(item);
    }
    return;
  }
  const items = (histTab === 'seq' ? HIST.seq : HIST.btc) || [];
  if (!items.length) { list.appendChild(el('p', 'sub', 'No transactions yet.')); return; }
  const base = histTab === 'seq' ? OV.explorerTx : OV.explorerT4Tx;
  for (const t of items) {
    const item = el('div', 'item');
    const bcls = t.type === 'incoming' ? 'b-in' : (t.type === 'outgoing' || t.type === 'burn') ? 'b-out' : 'b-iss';
    item.appendChild(el('span', 'badge ' + bcls, t.type));
    const mid = el('div', 'grow');
    const a = el('a', null, t.txid.slice(0, 18) + '…'); a.href = base + t.txid; a.target = '_blank'; a.rel = 'noopener';
    const d1 = el('div'); d1.appendChild(a); mid.appendChild(d1);
    mid.appendChild(el('div', 'sub', t.height ? (t.timestamp ? new Date(t.timestamp * 1000).toLocaleString() : 'block ' + t.height) : 'unconfirmed'));
    item.appendChild(mid);
    const nz = (t.display || []).filter((x) => BigInt(x.atoms) !== 0n);
    const top = nz.reduce((best, x) => {
      const abs = (v) => (v < 0n ? -v : v);
      return best && abs(BigInt(best.atoms)) >= abs(BigInt(x.atoms)) ? best : x;
    }, null);
    if (top) {
      const v = BigInt(top.atoms);
      item.appendChild(el('span', 'amt ' + (v < 0n ? 'neg' : 'pos'), fmtAtoms(top.atoms, top.precision) + ' ' + top.ticker));
    }
    list.appendChild(item);
  }
}

// ---- settings ----
async function renderSettings() {
  try {
    const { sites } = await rpc('sites');
    const box = $('siteList'); box.innerHTML = '';
    const entries = Object.entries(sites);
    if (!entries.length) { box.appendChild(el('p', 'sub', 'No sites connected.')); }
    for (const [origin, info] of entries) {
      const row = el('div', 'row'); row.style.marginTop = '6px';
      const o = el('div', 'grow mono', origin); o.style.fontSize = '12px';
      row.appendChild(o);
      const b = el('button', 'ghost tiny', 'Disconnect');
      b.onclick = async () => { await rpc('revokeSite', { origin }); renderSettings(); };
      row.appendChild(b);
      box.appendChild(row);
    }
    const s = await rpc('getSettings');
    $('setAutolock').value = s.autoLockMin || 30;
    await renderLeaves();
  } catch (e) { $('settingsStatus').className = 'status err'; $('settingsStatus').textContent = e.message; }
}

// ---- the mode, and leaves (developer mode) ----
// Every figure and refusal here is the leaf wallet library's, shown in its words. Renders
// overlap (a tab opened, the mode changed, a leaf event): only the latest one draws, so a
// developer-mode answer that arrives after a change to user mode never shows the card again.
let leavesAsked = 0;
async function renderLeaves() {
  const asked = ++leavesAsked;
  const st = await rpc('leaves.state');
  if (asked !== leavesAsked) return;
  $('setMode').value = st.mode;
  $('leafCard').classList.toggle('hide', st.mode !== 'developer');
  if (st.mode !== 'developer') return;
  $('leafJoin').classList.toggle('hide', st.joined);
  $('leafJoined').classList.toggle('hide', !st.joined);
  $('leafStatus').className = st.error ? 'status err' : 'status';
  $('leafStatus').textContent = st.error || '';
  if (!st.joined) return;
  $('leafOperator').textContent = st.operator || '';
  $('leafServerShown').textContent = 'Server ' + (st.server || '') + ' · node ' + (st.nodeUrl || '');
  const box = $('leafBalances'); box.innerHTML = '';
  const arca = (st.balance && st.balance.arca) || {};
  const ids = Object.keys(arca);
  if (!ids.length) box.appendChild(el('p', 'sub', 'No leaves held. BTC is never a leaf: a tree on the Sequentia network holds no BTC.'));
  for (const id of ids) {
    const row = el('div', 'kv leaf-row'); row.dataset.asset = id;
    let total = 0n; const parts = [];
    for (const [state, v] of Object.entries(arca[id])) { total += BigInt(v); parts.push(state + ' ' + v); }
    row.appendChild(el('span', 'k mono', id.slice(0, 12) + '…'));
    row.appendChild(el('span', 'v', total.toString() + ' atoms (' + parts.join(', ') + ')'));
    box.appendChild(row);
  }
  renderCare(st);
  renderBond(st);
  renderSupply(st);
  renderCoins(st);
  const rel = st.status && st.status.releasing;
  $('leafReleasing').classList.toggle('hide', !rel);
  $('leafReleasing').textContent = rel ? 'Paying through the next round: ' + rel.command + ' needs more than the unplanned leaves hold, so '
    + rel.coins.length + ' planned leaf(s) (' + rel.coins.map(short).join(', ') + ') are given up in the next round for leaves no plan names; it is asked again once that round is final.' : '';
  const sc = st.schedule || {};
  const last = st.status && st.status.lastSync;
  $('leafSchedule').textContent = (sc.next_sync_at ? 'Next sync the schedule asks for: ' + new Date(sc.next_sync_at * 1000).toISOString() : 'Nothing held off the chain, nothing awaited.')
    + (last ? ' · Last sync ' + new Date(last.at).toISOString() + ' (' + last.by + ')' : '');
}
// Developer mode's view of what the wallet does by itself: the last `care` and the plans.
const short = (x) => (x ? String(x).slice(0, 12) + '…' : '');
const isoOf = (secs) => (typeof secs === 'number' ? new Date(secs * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '?');
function renderCare(st) {
  const lc = st.status && st.status.lastCare;
  const box = $('leafCareLast'); box.innerHTML = '';
  if (!lc) box.textContent = 'Not run yet since the wallet opened.';
  else if (lc.error) { box.className = 'status err'; box.textContent = 'Last run ' + new Date(lc.at).toISOString() + ': ' + lc.error.message; }
  else {
    box.className = 'sub';
    const s = lc.summary || {};
    box.dataset.taken = String(s.taken || 0); box.dataset.planned = String(s.planned || 0); box.dataset.cancelled = String(s.cancelled || 0);
    box.appendChild(el('div', null, 'Last run ' + new Date(lc.at).toISOString() + ': ' + (s.taken || 0) + ' claim(s) taken up'
      + (s.held ? ', ' + s.held + ' held for a later run' : '') + ' · ' + (s.planned || 0) + ' plan(s) signed'
      + (s.unplanned ? ', ' + s.unplanned + ' refused by the operator' : '') + ' · ' + (s.cancelled || 0) + ' cancelled (their leaf moved) · '
      + (s.refreshing || 0) + ' leaf(s) sent to a round, to be planned · ' + (s.later || 0) + ' not yet near their refresh'));
    const v = lc.value || {};
    for (const p of v.planned || []) if (p && p.error) box.appendChild(el('div', 'status err', short(p.coin) + ': ' + p.error));
    for (const r of v.refreshing || []) if (r && r.error) box.appendChild(el('div', 'status err', short(r.coin) + ': ' + r.error));
    for (const c of (Array.isArray(v.claims) ? v.claims : [])) if (c && (c.refused || c.error)) box.appendChild(el('div', 'status err', 'claim ' + c.claim + ': ' + (c.refused || c.error)));
    if (v.claims && !Array.isArray(v.claims) && v.claims.error) box.appendChild(el('div', 'status err', 'claims: ' + v.claims.error));
  }
  const list = $('leafPlans'); list.innerHTML = '';
  const plans = st.plans || [];
  if (!plans.length) list.appendChild(el('div', 'sub', 'No refresh plans.'));
  for (const p of plans) {
    const row = el('div', 'kv leaf-plan'); row.dataset.plan = p.plan_id; row.dataset.state = p.state;
    const mid = el('div', 'grow');
    mid.appendChild(el('div', 'mono', 'Plan ' + short(p.plan_id) + ' · ' + p.state + ' · leaf ' + short(p.coin) + ' · ' + p.value + ' of ' + short(p.asset)));
    mid.appendChild(el('div', 'sub', 'covers it until ' + isoOf(p.covered_until) + ' at the earliest; sync by ' + isoOf(p.sync_by)
      + '; steps: ' + (p.steps || []).map((x) => x.state || 'waiting').join(', ')));
    row.appendChild(mid);
    if (p.state === 'open') {
      const acts = el('div', 'bal-acts');
      const c = el('button', 'ghost tiny', 'Cancel'); c.onclick = () => leafAct('Cancelling the plan…', () => rpc('leaves.planCancel', { plan: p.plan_id }));
      const current = ((p.steps || []).filter((x) => x.leaf_id).map((x) => x.leaf_id).pop()) || p.coin;
      const r = el('button', 'ghost tiny', 'Release'); r.onclick = () => leafAct('Releasing the leaf into the next round…', () => rpc('leaves.release', { leaf: current }));
      acts.appendChild(c); acts.appendChild(r); row.appendChild(acts);
    }
    list.appendChild(row);
  }
}
async function leafAct(what, fn) {
  $('leafStatus').className = 'status'; $('leafStatus').textContent = what;
  try { const v = await fn(); $('leafStatus').textContent = ''; await renderLeaves(); return v; }
  catch (e) { $('leafStatus').className = 'status err'; $('leafStatus').textContent = e.message; await renderLeaves().catch(() => {}); return null; }
}
// Developer mode's view of the operator's bond: its asset, value and state, and the watch.
const kvRow = (k, v) => { const d = el('div', 'kv'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v == null ? '' : String(v))); return d; };
function renderBond(st) {
  const card = $('leafBond');
  const box = $('leafBondShown'); box.innerHTML = '';
  const b = st.status && st.status.bond;
  card.dataset.state = (b && b.state) || '';
  if (!b) box.appendChild(el('div', 'sub', 'Not read yet since the wallet opened.'));
  else if (b.error) box.appendChild(el('div', 'status err', b.error.message));
  else {
    box.appendChild(kvRow('State', b.state));
    if (b.asset) box.appendChild(kvRow('Bond', b.value + ' of ' + short(b.asset)));
    if (b.coin) box.appendChild(kvRow('Coin', b.coin));
    if (b.withdrawable_at != null) box.appendChild(kvRow('Withdrawable', isoOf(b.withdrawable_at)));
    box.appendChild(kvRow('Required by this wallet', b.required ? 'yes: seen bonded' : 'no: never seen bonded'));
    box.appendChild(kvRow('Covers what this wallet holds out of round', b.covers === true ? 'yes' : (b.covers || 'no')));
    if (b.why) box.appendChild(el('div', 'sub', b.why));
  }
  const w = st.status && st.status.lastWatch;
  const wl = $('leafWatchShown'); wl.innerHTML = ''; wl.className = 'sub';
  if (w && w.error) { wl.className = 'status err'; wl.textContent = 'Last watch ' + new Date(w.at).toISOString() + ': ' + w.error.message; }
  else if (w) {
    const v = w.value || {}; const ev = v.evidence || {};
    card.dataset.slashed = String((v.slashed || []).length);
    wl.textContent = 'Last watch ' + new Date(w.at).toISOString() + ': ' + (ev.lines ?? 0) + ' evidence line(s), ' + (ev.salts ?? 0) + ' salt(s), ' + (v.slashed || []).length + ' slash(es) sent';
  }
}
$('btnLeafWatchBond').onclick = () => leafAct('Watching the bond…', () => rpc('leaves.watchBond'));

// Developer mode: each asset the operator serves issuer-operated, with its supply report,
// every mint and burn the operator lists read again on the wallet's own node.
const SUPPLY = {};
function renderSupply(st) {
  const assets = st.issuerAssets || [];
  $('leafSupply').classList.toggle('hide', !assets.length);
  const box = $('leafSupplyRows'); box.innerHTML = '';
  for (const a of assets) {
    const row = el('div', 'leaf-supply'); row.dataset.asset = a;
    row.appendChild(el('div', 'mono', short(a)));
    const r = SUPPLY[a];
    if (r && r.error) row.appendChild(el('div', 'status err', r.error));
    else if (r) {
      row.dataset.checked = String(!!r.checked_on_the_node);
      for (const k of ['minted', 'burned', 'in_batches']) if (r[k] != null && typeof r[k] !== 'object') row.appendChild(kvRow(k.replace('_', ' '), r[k]));
      row.appendChild(kvRow('Checked on this node', r.checked_on_the_node ? 'yes: every listed mint and burn agrees' : 'no'));
      row.appendChild(el('div', 'sub', (r.mints || []).length + ' mint(s), ' + (r.burns || []).length + ' burn(s) listed'));
    }
    const b = el('button', 'ghost tiny', 'Supply'); b.dataset.action = 'supply';
    b.onclick = async () => {
      const v = await leafAct('Asking for the supply…', () => rpc('leaves.supply', { asset: a }));
      SUPPLY[a] = v ? v.supply : { error: $('leafStatus').textContent || 'refused' };
      renderSupply(st);
    };
    row.appendChild(b);
    box.appendChild(row);
  }
}

// Developer mode's leaves, each with its state and dates, a planned one marked: a planned
// leaf is paid out of round only once released into the next round.
const HELD = new Set(['live', 'pending', 'offered', 'sending', 'given', 'forfeited', 'exiting']);
function renderCoins(st) {
  const box = $('leafCoins'); box.innerHTML = '';
  const planned = plannedCoins(st.plans);
  const held = (st.coins || []).filter((c) => HELD.has(c.state));
  if (!held.length) box.appendChild(el('div', 'sub', 'No leaf held.'));
  for (const c of held) {
    const d = el('div', 'kv leaf-coin'); d.dataset.leaf = c.leaf_id; d.dataset.state = c.state; d.dataset.asset = c.asset;
    const mid = el('div', 'grow');
    mid.appendChild(el('div', 'mono', short(c.leaf_id) + ' · ' + (c.standing || c.state) + ' · ' + c.kind + ' · ' + c.value + ' of ' + short(c.asset)));
    if (c.exit_by != null) mid.appendChild(el('div', 'sub', 'refresh from ' + isoOf(c.refresh_from) + ' · exit by ' + isoOf(c.exit_by)));
    const plan = planned.get(c.leaf_id);
    if (plan) { d.dataset.planned = plan.plan_id; mid.appendChild(el('div', 'sub', 'Planned: plan ' + short(plan.plan_id) + ', ' + plan.state + '; paid out of round only once released into the next round')); }
    const batch = batchLine(c.batch_profile);
    if (batch) { d.dataset.batchProfile = c.batch_profile; mid.appendChild(el('div', 'sub', 'Batch: ' + batch)); }
    // A supervised asset's leaf: where it lands, and whether its issuer has frozen it.
    if (c.landing) { d.dataset.landing = c.landing; mid.appendChild(el('div', 'sub', 'Lands at ' + c.landing + " (this wallet's landing key: a supervised asset's leaf leaves the tree only there)")); }
    if (c.frozen) {
      const fz = !!(c.frozen.frozen || c.frozen.paused);
      d.dataset.frozen = String(fz);
      mid.appendChild(el('div', 'sub', 'Frozen: ' + (fz ? (c.frozen.paused ? 'yes: the issuer paused the asset' : 'yes: the issuer froze this landing') : 'no')));
      if (fz) mid.appendChild(el('div', 'sub frozen-line', frozenSentence(c.value, short(c.asset))));
      if (c.frozen.note) mid.appendChild(el('div', 'sub', c.frozen.note));
    }
    d.appendChild(mid);
    box.appendChild(d);
  }
}
$('btnLeafCare').onclick = () => leafAct('Running…', () => rpc('leaves.care'));

$('setMode').onchange = async () => {
  try { await rpc('setMode', { mode: $('setMode').value }); await renderLeaves(); if (OV) { OV = await rpc('overview', { withLn: false }); renderOverview(); } }
  catch (e) { $('settingsStatus').className = 'status err'; $('settingsStatus').textContent = e.message; }
};
$('btnLeafJoin').onclick = async () => {
  const v = (id) => $(id).value.trim();
  const cfg = { server: v('leafServer'), node_url: v('leafNodeUrl') };
  if (v('leafNodeUser')) cfg.node_user = v('leafNodeUser');
  if (v('leafNodePassword')) cfg.node_password = v('leafNodePassword');
  if (v('leafDelay')) cfg.exit_delay_units = v('leafDelay');
  if (v('leafMinDelay')) cfg.min_exit_delay_units = v('leafMinDelay');
  $('btnLeafJoin').disabled = true;
  $('leafStatus').className = 'status'; $('leafStatus').textContent = 'Joining…';
  try { await rpc('leaves.join', cfg); await renderLeaves(); }
  catch (e) { $('leafStatus').className = 'status err'; $('leafStatus').textContent = e.message; }
  finally { $('btnLeafJoin').disabled = false; }
};
$('btnLeafSync').onclick = async () => {
  $('btnLeafSync').disabled = true;
  $('leafStatus').className = 'status'; $('leafStatus').textContent = 'Syncing…';
  try { await rpc('leaves.sync'); $('leafStatus').textContent = ''; await renderLeaves(); }
  catch (e) { $('leafStatus').className = 'status err'; $('leafStatus').textContent = e.message; }
  finally { $('btnLeafSync').disabled = false; }
};
$('btnSaveSettings').onclick = async () => {
  const v = parseInt($('setAutolock').value, 10);
  if (!(v > 0)) { $('settingsStatus').className = 'status err'; $('settingsStatus').textContent = 'Enter a positive number of minutes.'; return; }
  await rpc('setSettings', { autoLockMin: v });
  $('settingsStatus').className = 'status ok'; $('settingsStatus').textContent = 'Saved.';
};
$('btnReveal').onclick = async () => {
  try {
    const { mnemonic } = await rpc('revealMnemonic', { password: $('revealPw').value });
    $('revealOut').textContent = mnemonic;
    $('revealOut').classList.remove('hide');
    $('revealPw').value = '';
  } catch (e) { $('settingsStatus').className = 'status err'; $('settingsStatus').textContent = e.message; }
};

boot().catch((e) => { view('vBoot'); $('vBoot').textContent = 'Failed to start: ' + e.message; });


// ---- the stakes of this wallet's key ----------------------------------------
// Every stake of the key, whichever wallet bonded it and under either lock, with
// Unbond once its lock has passed and Withdraw once its unbonding is over. Each
// step is reviewed here first; the service worker builds and signs it only once
// the review is confirmed, and broadcasts it only if it moves what was shown.
const tseq = (atoms) => fmtAtoms(atoms, 8) + ' tSEQ';
function stakeWhen(s) {
  switch (s.state) {
    case 'pending': return 'Staking, waiting for its first confirmation.';
    case 'bonded':
      if (s.timeLock) {
        if (!s.maturesAtTime) return 'Staked, with ' + s.lock + '.';
        return 'Staked, with ' + s.lock + '. It can be unbonded from about ' + new Date(s.maturesAtTime * 1000).toLocaleString() + '.';
      }
      return 'Staked, with ' + s.lock + '. It can be unbonded at block ' + Number(s.maturesAt).toLocaleString('en-US') + '.';
    case 'unbondable': return 'Its lock has passed: it can be unbonded.';
    case 'unbonding': return 'Unbonding: no longer counted as stake. It can be withdrawn into the wallet about two weeks after the unbond confirmed.';
    case 'claimable': return 'Unbonded: it can be withdrawn into the wallet.';
    case 'claiming': return 'Withdrawing into the wallet, waiting for the confirmation.';
    case 'left': return 'Spent another way.';
    case 'unknown': return 'Not found on the chain.';
    default: return 'Could not read where it stands; try again in a moment.';
  }
}
async function renderStakes() {
  const box = $('stakeList');
  let r;
  try { r = await rpc('stakes'); }
  catch (e) { box.textContent = 'Could not read your stakes: ' + e.message; return; }
  box.innerHTML = '';
  if (!r.supported) { box.textContent = 'This build cannot unbond a stake; update the extension.'; return; }
  if (!r.stakes.length) { box.textContent = 'No stakes.'; return; }
  for (const s of r.stakes) {
    const row = el('div', 'item stake-row'); row.dataset.txid = s.txid; row.dataset.state = s.state;
    const mid = el('div', 'grow');
    mid.appendChild(el('div', null, tseq(s.held !== '0' ? s.held : s.atoms)));
    mid.appendChild(el('div', 'sub', stakeWhen(s)));
    row.appendChild(mid);
    if (s.state === 'unbondable') {
      const b = el('button', 'ghost tiny', 'Unbond'); b.onclick = () => stakeReview('unbond', s); row.appendChild(b);
    } else if (s.state === 'claimable') {
      const b = el('button', 'ghost tiny', 'Withdraw'); b.onclick = () => stakeReview('claim', s); row.appendChild(b);
    }
    box.appendChild(row);
  }
}
async function stakeReview(kind, s) {
  $('stakeListMsg').className = 'status'; $('stakeListMsg').textContent = '';
  let rv;
  try { rv = await rpc(kind === 'unbond' ? 'stakeUnbondReview' : 'stakeClaimReview', { txid: s.txid }); }
  catch (e) { $('stakeListMsg').className = 'status err'; $('stakeListMsg').textContent = e.message; return; }
  const { m, c } = modal(kind === 'unbond' ? 'Unbond this stake' : 'Withdraw this stake');
  const kv = kind === 'unbond'
    ? [['Network', 'Sequentia (testnet); not parent-chain BTC'], ['Stake', tseq(rv.stake)], ['Network fee', tseq(rv.fee) + ' (out of the stake)'],
       ['Then', 'it stops counting as stake at once, and ' + tseq(rv.unbonding) + ' can be withdrawn into this wallet about two weeks after this confirms']]
    : [['Network', 'Sequentia (testnet); not parent-chain BTC'], ['→ ' + rv.address, tseq(rv.out)], ['Network fee', tseq(rv.fee)]];
  for (const [k, v] of kv) { const d = el('div', 'kv'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v)); c.appendChild(d); }
  const st = el('div', 'status'); const row = el('div', 'row');
  const ok = el('button', 'primary', 'Confirm & sign'); ok.id = 'btnStakeConfirm';
  const no = el('button', 'ghost', 'Cancel');
  row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.appendChild(st);
  no.onclick = () => { rpc('stakeStepDrop', { id: rv.id }).catch(() => {}); m.remove(); };
  ok.onclick = async () => {
    ok.disabled = no.disabled = true; st.textContent = 'Signing & broadcasting…';
    try {
      const res = await rpc('stakeStepConfirm', { id: rv.id });
      m.remove();
      toast((kind === 'unbond' ? 'Unbonding: ' : 'Withdrawing: ') + String(res.txid).slice(0, 20) + '…');
      renderStakes(); refreshOverview();
    } catch (e) {
      st.className = 'status err';
      st.textContent = /bad-unbond-premature/.test(e.message)
        ? 'Not yet: the chain has not gone far enough past the unbond. Try again in a few minutes.'
        : 'Failed: ' + e.message;
      // The review is spent either way: Cancel closes it, and the row offers the step again.
      no.disabled = false; no.onclick = () => { m.remove(); renderStakes(); };
    }
  };
}

// ---- staking pools (delegation only) ----------------------------------------
// Delegating lends the weight this wallet's staking key already carries. The
// coins never move, the pool can never spend them, and only this wallet can end
// the delegation. That last property is why "Leave" is never gated on the pool
// board being reachable: leaving has to work at all times.
let STAKE = null;          // last stakingOverview snapshot
let STAKE_SEL = null;      // the pool row the user picked

function stakeShare(p, total) {
  if (!total) return '';
  return ` · ${(Number(p.weight) / total * 100).toFixed(1)}% of the network`;
}

async function renderStake() {
  $('stakeMsg').textContent = '';
  try { STAKE = await rpc('stakingOverview'); }
  catch (e) { $('stakeStatus').textContent = 'Could not read staking status: ' + e.message; return; }

  const unsupported = $('stakeUnsupported');
  if (!STAKE.supported) {
    // Never offer joining a pool that this build could not leave.
    unsupported.textContent = 'This build cannot create or spend a delegation record the way the network requires, so it does not offer delegating. Update the extension.';
    unsupported.classList.remove('hide');
    $('stakePools').innerHTML = '';
    $('stakeStatus').textContent = '';
    $('btnDelegate').disabled = true;
    $('btnLeavePool').classList.add('hide');
    return;
  }
  unsupported.classList.add('hide');
  $('btnDelegate').disabled = false;

  const d = STAKE.delegation;
  $('stakeStatus').textContent = !d
    ? 'Not delegating. Your stake signs for itself, so it only earns while a node of yours is producing blocks.'
    : (d.confirmed
        ? `Delegated to ${d.signer.slice(0, 16)}… · ${fmtAtoms(d.atoms, 8)} tSEQ held in the record`
        : 'Delegation sent, waiting to confirm. Until it does, your weight still counts for you.');
  $('btnLeavePool').classList.toggle('hide', !d);
  $('btnDelegate').textContent = d ? 'Move to the selected pool' : 'Delegate';

  const warn = $('stakeWarnings');
  warn.innerHTML = '';
  for (const w of (STAKE.warnings || [])) {
    const box = el('div', 'status', '⚠ ' + w);
    box.style.marginBottom = '6px';
    warn.appendChild(box);
  }

  const list = $('stakePools');
  list.innerHTML = '';
  const board = STAKE.board;
  if (!board) {
    // Advisory only: leaving still works, and the copy has to say so rather
    // than leave someone thinking they are stuck.
    list.appendChild(el('div', 'sub', 'Pool list unavailable right now'
      + (STAKE.boardError ? ` (${STAKE.boardError})` : '') + '. Leaving a pool always works.'));
    return;
  }
  // Only signers that DECLARED themselves a pool are offered. The feed carries
  // every staker so the card can describe whichever one this wallet is lent to,
  // but a staker producing for itself never asked for delegations.
  const offered = board.pools.filter((p) => p.declared !== false);
  if (!offered.length) {
    list.appendChild(el('div', 'sub', 'No pool has declared itself yet. '
      + `${board.stakers || 0} signer(s) are producing blocks for themselves; a staker becomes a pool by `
      + 'committing a payout policy on-chain, and appears here when it does.'));
    return;
  }
  const total = Number(board.network_weight) || 0;
  for (const p of offered) {
    const row = el('div', 'card');
    row.style.cssText = 'cursor:pointer;padding:8px 10px;margin-bottom:6px';
    if (STAKE_SEL === p.signer || (d && d.signer === p.signer)) row.style.outline = '1px solid var(--gold,#f5b301)';
    row.appendChild(el('div', 'mono', p.signer.slice(0, 16) + '…'));
    const rel = p.reliability === undefined ? 'no blocks owed yet'
      : `produces ${p.reliability.toFixed(2)} of its share`;
    row.appendChild(el('div', 'sub',
      `${fmtAtoms(p.weight, 8)} tSEQ${stakeShare(p, total)} · ${p.delegators} delegator(s) · ${rel}`));
    row.appendChild(el('div', 'sub', p.payout || ''));
    if ((p.policy_pending || []).length) {
      const w = el('div', 'sub', `⚠ has announced a payout change binding in ${p.policy_pending[0].blocks_away} blocks`);
      w.style.color = '#f5b301';
      row.appendChild(w);
    }
    if (p.eligible === false) {
      const w = el('div', 'sub', 'below the network minimum stake, so it cannot produce yet');
      w.style.color = '#e88';
      row.appendChild(w);
    }
    row.onclick = () => { STAKE_SEL = p.signer; $('stakeSigner').value = p.signer; renderStake(); };
    list.appendChild(row);
  }
}

$('btnDelegate').onclick = async () => {
  const msg = $('stakeMsg');
  msg.textContent = '';
  const target = ($('stakeSigner').value || '').trim().toLowerCase() || STAKE_SEL;
  if (!target) { msg.textContent = 'Pick a pool, or paste its signer key.'; return; }
  const moving = !!(STAKE && STAKE.delegation);
  const ok = confirm(
    (moving ? 'Move your stake\'s block-signing rights to:\n\n' : 'Delegate your stake\'s block-signing rights to:\n\n')
    + target + '\n\n'
    + 'Your coins do NOT move, and this pool can never spend them: only this wallet can. '
    + 'You can take the rights back at any time, immediately, without the pool\'s cooperation.\n\n'
    + 'What you are trusting it for is the reward: check what it has committed to paying.');
  if (!ok) return;
  $('btnDelegate').disabled = true;
  try {
    const r = moving ? await rpc('stakingSpend', { rotateTo: target })
                     : await rpc('stakingDelegate', { signer: target });
    msg.textContent = (moving ? 'Moving pool · ' : 'Delegated · ') + String(r.txid).slice(0, 16) + '…';
    $('stakeSigner').value = ''; STAKE_SEL = null;
    await renderStake();
  } catch (e) { msg.textContent = 'Failed: ' + e.message; }
  finally { $('btnDelegate').disabled = false; }
};

$('btnLeavePool').onclick = async () => {
  const msg = $('stakeMsg');
  msg.textContent = '';
  const ok = confirm(
    'Take your stake back?\n\n'
    + 'Your weight counts for you again from the next confirmation, and the pool loses it.\n\n'
    + 'This does NOT unstake: your coins were never moved by delegating and are not moved now.');
  if (!ok) return;
  $('btnLeavePool').disabled = true;
  try {
    const r = await rpc('stakingSpend', { rotateTo: null });
    msg.textContent = 'Left the pool · ' + String(r.txid).slice(0, 16) + '…';
    await renderStake();
  } catch (e) { msg.textContent = 'Failed: ' + e.message; }
  finally { $('btnLeavePool').disabled = false; }
};


// --- staking rewards, and converting them ----------------------------------
// The engine lives in the background (it needs the wallet and the kit's wasm);
// this only shows what it decided. "Nothing happened" and "nothing should have
// happened" look identical otherwise, and the second is far the more common.
let REWARDS = null;

// The background knows the registry, so it names the assets; the popup only
// has to remember what it was told.
const AC_TICKERS = new Map();
function acTicker(target) {
  if (!target || target === 'BTC') return 'BTC';
  return AC_TICKERS.get(target) || (target.slice(0, 8) + '…');
}

async function renderRewards() {
  const list = $('rewardList');
  if (!list) return;
  $('acMsg').textContent = '';
  try { REWARDS = await rpc('rewardsOverview'); }
  catch (e) { list.textContent = 'Could not read staking rewards: ' + e.message; return; }

  const totals = REWARDS.totals || [];
  for (const t of totals) if (t.ticker) AC_TICKERS.set(t.asset, t.ticker);
  for (const r of (REWARDS.considered || [])) if (r.ticker) AC_TICKERS.set(r.batch.asset, r.ticker);
  if (!totals.length) {
    list.textContent = 'No staking rewards yet. A block pays its own fees, so rewards appear once a block you (or your pool) produced carried some.';
  } else {
    list.innerHTML = '';
    for (const t of totals) {
      const row = document.createElement('div');
      const srcs = Object.entries(t.sources || {}).map(([k, v]) => `${v}× ${k}`).join(' · ');
      const maturing = BigInt(t.immature || '0') > 0n ? ` · ${t.immature} maturing` : '';
      row.textContent = `${acTicker(t.asset)}: ${t.mature} spendable${maturing}${srcs ? ' · ' + srcs : ''}`;
      list.appendChild(row);
    }
  }

  const s = REWARDS.settings || {};
  $('acEnabled').checked = !!s.enabled;
  $('acSettings').classList.toggle('hide', !s.enabled);

  // Bitcoin first: the top seat is the whole of its privilege here.
  const sel = $('acTarget');
  sel.innerHTML = '';
  const btc = document.createElement('option');
  btc.value = 'BTC'; btc.textContent = 'BTC (Bitcoin)';
  sel.appendChild(btc);
  for (const t of totals) {
    if (t.asset === 'BTC') continue;
    const o = document.createElement('option');
    o.value = t.asset; o.textContent = acTicker(t.asset);
    sel.appendChild(o);
  }
  sel.value = s.target || 'BTC';
  $('acMin').value = s.minReceive || '';
  $('acSlip').value = String(s.maxSlippageBp || 200);

  const lines = [];
  if (!s.enabled) {
    lines.push('Rewards are being kept as they are.');
  } else if ((REWARDS.considered || []).length) {
    for (const r of REWARDS.considered) {
      const d = r.decision || {};
      lines.push(`${r.batch.value} ${r.ticker || acTicker(r.batch.asset)} → ${acTicker(s.target)}: ${d.converts ? 'converting' : (d.reason || 'waiting')}`);
    }
  } else {
    lines.push('Nothing to convert right now. Rewards are gathered per asset until a batch is worth converting.');
  }
  for (const c of (REWARDS.recent || [])) {
    lines.push(`Converted ${c.value} ${acTicker(c.asset)} → ${acTicker(c.target)}`);
  }
  if (REWARDS.error) lines.push(REWARDS.error);
  $('acMsg').textContent = lines.join('\n');
}

async function saveRewardSettings(patch) {
  try {
    await rpc('rewardsSetConvert', patch);
    await renderRewards();
  } catch (e) {
    $('acMsg').textContent = 'Could not save: ' + e.message;
  }
}

$('acEnabled').onchange = () => saveRewardSettings({ enabled: $('acEnabled').checked });
$('acTarget').onchange = () => saveRewardSettings({ target: $('acTarget').value });
$('acSlip').onchange = () => saveRewardSettings({ maxSlippageBp: Number($('acSlip').value) });
$('acMin').onchange = () => {
  const v = $('acMin').value.trim();
  if (v && !/^[0-9]+$/.test(v)) { $('acMsg').textContent = 'That is not an amount in atoms.'; return; }
  saveRewardSettings({ minReceive: v || '0' });
};


// ==== default mode (src/default-mode.js; the words are the web wallet's, vendor/) ====
const isDefault = () => !!OV && OV.mode !== 'developer';
function applyMode() {
  const d = isDefault();
  $('tabTradeBtn').classList.toggle('hide', !d);
  $('sendDefault').classList.toggle('hide', !d);
  $('sendDev').classList.toggle('hide', d);
  $('recvDefault').classList.toggle('hide', !d);
  $('recvDev').classList.toggle('hide', d);
  $('faucetCard').classList.remove('hide');
  if (!d && !$('tTrade').classList.contains('hide')) tab('balance');
}

// ---- receive: one code ----
let recvCode = null, recvAsk = null, recvWatch = 0;
function recvSats() {
  const v = $('recvDAmt').value.trim();
  if (!v) return null;
  try { return parseAmount(v, 8); } catch { return null; }
}
async function renderDefaultReceive(fresh = false) {
  $('recvDTip').textContent = DEFAULT_WORDS.receiveTip;
  $('recvDAmt').placeholder = BTC_WORDS.amountHint;
  if (!recvCode || fresh) { $('recvDCode').textContent = DEFAULT_WORDS.receiveWait; $('recvDQr').removeAttribute('src'); }
  const sats = recvSats();
  const ask = (recvAsk = rpc('default.receiveCode', { sats: sats ? sats.toString() : null, fresh }));
  try {
    const r = await ask;
    if (ask !== recvAsk) return;
    recvCode = r;
    $('recvDLbl').textContent = r.isCode ? DEFAULT_WORDS.codeLabel : 'Receive';
    $('btnDCopy').textContent = r.isCode ? DEFAULT_WORDS.copyCode : 'Copy';
    $('recvDCode').textContent = r.code;
    if (r.qr) $('recvDQr').src = r.qr; else $('recvDQr').removeAttribute('src');
    if (r.invoiceHash) watchInvoice(r.invoiceHash, sats);
  } catch (e) { $('recvDStatus').className = 'status err'; $('recvDStatus').textContent = refusalShown(e); }
}
// A code with an amount carries an invoice: once it is paid, say so and make a new code.
function watchInvoice(hash, sats) {
  const mine = ++recvWatch;
  const until = Date.now() + 15 * 60_000;
  const tick = async () => {
    if (mine !== recvWatch || Date.now() > until || !document.body.isConnected) return;
    let r = null; try { r = await rpc('default.invoiceReceived', { hash }); } catch {}
    if (r && r.state === 'paid') {
      $('recvDStatus').className = 'status ok'; $('recvDStatus').textContent = BTC_WORDS.received(fmtAtoms(sats, 8));
      $('recvDAmt').value = ''; refreshOverview(); renderDefaultReceive(true); return;
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}
$('btnDCopy').onclick = () => { if (recvCode) navigator.clipboard.writeText(recvCode.code).then(() => toast(recvCode.isCode ? 'Receive code copied' : 'Copied')); };
$('btnDNew').onclick = () => { $('recvDStatus').textContent = ''; renderDefaultReceive(true); };
{ let t = null; $('recvDAmt').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { recvWatch++; renderDefaultReceive(); }, 600); }); }

// ---- the testnet faucet: it pays the receive code ----
for (const b of document.querySelectorAll('#faucetBtns button')) b.onclick = async () => {
  const btns = [...document.querySelectorAll('#faucetBtns button')];
  btns.forEach((x) => { x.disabled = true; });
  $('faucetStatus').className = 'status'; $('faucetStatus').textContent = 'Requesting from the faucet…';
  try {
    const r = await rpc('default.faucet', { asset: b.dataset.faucet });
    $('faucetStatus').className = 'status ok'; $('faucetStatus').textContent = r.text;
    refreshOverview();
    if (isDefault()) renderDefaultReceive();
  } catch (e) { $('faucetStatus').className = 'status err'; $('faucetStatus').textContent = 'The faucet could not pay: ' + e.message; }
  finally { btns.forEach((x) => { x.disabled = false; }); }
};

// ---- send: one recipient field ----
function fillDefaultSend() {
  if (!OV) return;
  const sel = $('sendDAsset'); const prev = sel.value; sel.innerHTML = '';
  const totals = {};
  for (const r of OV.rows) if (r.key !== 'BTC' && !r.restricted) totals[r.key] = r.total;
  for (const k of heldAssetList(totals)) {
    const row = OV.rows.find((r) => r.key === k);
    const o = el('option', null, k === 'BTC' ? 'BTC' : (row ? row.ticker : k.slice(0, 8))); o.value = k; sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  sel.onchange = updateDefaultAvail;
  updateDefaultAvail();
}
function updateDefaultAvail() {
  const row = OV && OV.rows.find((r) => r.key === $('sendDAsset').value);
  $('sendDAvail').textContent = row ? 'balance ' + fmtAtoms(row.total, row.precision) : '';
}
$('btnDReview').onclick = async () => {
  $('sendDErr').className = 'status'; $('sendDErr').textContent = '';
  try {
    $('btnDReview').disabled = true;
    const plan = await rpc('default.prepareSend', { to: $('sendDTo').value.trim(), amtS: $('sendDAmt').value.trim(), asset: $('sendDAsset').value });
    defaultReview(plan);
  } catch (e) { $('sendDErr').className = 'status err'; $('sendDErr').textContent = e.message; }
  finally { $('btnDReview').disabled = false; }
};
function defaultReview(plan) {
  const { m, c } = modal(plan.title);
  for (const line of plan.lines || []) c.appendChild(el('p', 'sub', line));
  const st = el('div', 'status'); const row = el('div', 'row');
  const ok = el('button', 'primary', plan.button || DEFAULT_WORDS.send); const no = el('button', 'ghost', 'Cancel');
  row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.appendChild(st);
  no.onclick = () => m.remove();
  ok.onclick = async () => {
    ok.disabled = no.disabled = true;
    st.className = 'status'; st.textContent = DEFAULT_WORDS.sending;
    try {
      const r = await rpc('default.confirmSend', { id: plan.id });
      st.className = 'status ok'; st.textContent = r.text;
      ok.classList.add('hide'); no.textContent = 'Close'; no.disabled = false;
      $('sendDAmt').value = ''; $('sendDTo').value = '';
      refreshOverview();
    } catch (e) { st.className = 'status err'; st.textContent = e.message; no.disabled = false; }
  };
}

// ---- trade: the user composer (vendor/user-composer.js), the web wallet's own ----
let composer = null, userTrade = null, pairs = null, genesis = null, assetInfo = {};
const READ_TIMEOUT_MS = 20_000;
seqob.setSeqobBase(BASE + '/seqob');
function metaOf(h) {
  if (h === 'BTC') return { ticker: 'BTC', precision: 8 };
  const row = OV && OV.rows.find((r) => r.key === h);
  if (row) return { ticker: row.ticker, precision: row.precision };
  return assetInfo[h] || { ticker: h.slice(0, 8), precision: 8 };
}
function held(h) { const row = OV && OV.rows.find((r) => r.key === h); return row ? BigInt(row.total) : 0n; }
function knownAssets() {
  const s = new Set(['BTC']);
  for (const r of (OV && OV.rows) || []) if (!r.restricted) s.add(r.key);
  for (const c of Object.values((pairs && pairs.chains) || {})) for (const p of c.pairs || []) { s.add(p.pay); s.add(p.receive); }
  return [...s].filter((a) => a === 'BTC' || /^[0-9a-f]{64}$/.test(a));
}
async function relayPairBook(base, quote) {
  const get = async (b, q) => {
    const r = await fetch(`${seqob.seqobBase()}/v1/market/${b}/${q}/orderbook`, { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.offers || []).map((o, i) => { const raw = JSON.parse(JSON.stringify(o)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _relayJson: raw, _status: (j.statuses || [])[i] || null }; });
  };
  const t0 = Date.now();
  const [a, b] = await Promise.all([get(base, quote), get(quote, base).catch(() => [])]);
  console.log(`[trade] book: ${a.length + b.length} offers in ${Date.now() - t0} ms`);
  const seen = new Set();
  return [...a, ...b].filter((o) => { const k = (o.maker_pubkey || '') + ':' + (o.offer_id || ''); if (seen.has(k)) return false; seen.add(k); return true; });
}
// The trade's BTC is paid and received on the Bitcoin ark, which lives in the offscreen
// document: each method asked there (BigInt crosses as { $big }).
const arkBtc = new Proxy({}, { get: (_, method) => async (arg) => fromWire(await rpc('default.ark', { method: String(method), args: toWire(arg) })) });
let arkUp = false;
async function fetchJsonOnce(url, init) {
  const r = await fetch(url, init ? { ...init, headers: { 'content-type': 'application/json' } } : { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function renderTrade() {
  const root = $('userComposerRoot');
  if (!composer) {
    try { pairs = await (await fetch(USER_PAIRS_URL, { cache: 'no-store' })).json(); } catch { pairs = { chains: {} }; }
    try { genesis = (await rpc('default.leafInfo')).genesis_hash; } catch {}
    try { const j = await rpc('default.joined'); arkUp = !!j.ark; } catch {}
    // Tickers and decimals from the registry the service worker holds.
    try { assetInfo = await rpc('default.assetMeta', { hexes: knownAssets() }); } catch {}
    userTrade = createUserTrade({
      leaves: { command: async (cmd, args) => {
        const t = Date.now();
        console.log(`[trade] ${cmd} asked`);
        try { return await rpc('default.leaf', { command: cmd, args: args || {} }); }
        finally { console.log(`[trade] ${cmd}: ${Date.now() - t} ms`); }
      } },
      fetchJson: async (url, init) => {
        const t = Date.now();
        try { return await fetchJsonOnce(url, init); } finally { console.log(`[trade] ${init ? 'POST' : 'GET'} ${url.replace(BASE, '')}: ${Date.now() - t} ms`); }
      },
      makers: () => LEAF_MAKERS,
      relayBook: (pay, receive) => relayPairBook(receive, pay),
      relayFills: async (pay, receive) => {
        const get = async (b, q) => { const r = await fetch(`${seqob.seqobBase()}/v1/market/${b}/${q}/fills?limit=500`, { cache: 'no-store' }); return r.ok ? ((await r.json()).fills || []) : []; };
        const [a, b] = await Promise.all([get(receive, pay).catch(() => []), get(pay, receive).catch(() => [])]);
        return [...a, ...b];
      },
      outputValue: async (txid, vout) => {
        const r = await fetch(`${ESPLORA}/tx/${txid}`, { cache: 'no-store' }); if (!r.ok) return null;
        const o = ((await r.json()).vout || [])[vout]; return o && o.value != null ? String(o.value) : null;
      },
      admitted: async () => ({ pairs, genesis }),
      get btc() { return arkUp ? arkBtc : null; },
      onchain: null,
      store: localStorage, tag: () => OV && OV.tag ? OV.tag : 'default',
      log: (...a) => console.log(...a),
    });
    composer = mountUserComposer({
      root, engine: userTrade, assetMeta: metaOf, fmtAtoms, parseAtoms: (t, p) => parseAmount(t, p),
      knownAssets, held,
      admittedReceives: (pay) => admittedReceives(pairs, genesis, pay),
    });
  }
  composer.render();
  composer.follow();
}

// ---- remove the wallet ----
$('btnRemoveWallet').onclick = async () => {
  $('removeStatus').className = 'status'; $('removeStatus').textContent = '';
  try {
    $('btnRemoveWallet').disabled = true;
    await rpc('removeWallet', { password: $('removePw').value });
    $('removePw').value = '';
    OV = null; composer = null; userTrade = null; recvCode = null;
    view('vWelcome');
  } catch (e) { $('removeStatus').className = 'status err'; $('removeStatus').textContent = e.message; }
  finally { $('btnRemoveWallet').disabled = false; }
};

// ==== Report a problem (vendor/problem-report.js; the words are the web wallet's) ====
// The report carries the extension's version, the mode and the recent errors of the popup and
// the service worker. The address goes only when ticked; the exact payload is shown as it changes.
let reportCtx = { errors: [], mode: 'user', address: '' };
function reportNow() {
  const errors = [...popupErrors.list(), ...reportCtx.errors].sort((a, b) => a.at.localeCompare(b.at));
  return buildReport({
    wallet: 'ambra-browser', version: chrome.runtime.getManifest().version, mode: reportCtx.mode === 'developer' ? 'developer' : 'default',
    description: $('reportText').value, accountCode: $('reportCode').value, errors,
    context: { platform: navigator.platform, user_agent: navigator.userAgent, network: 'testnet' },
    addresses: $('reportAddr').checked && reportCtx.address ? [reportCtx.address] : [],
  });
}
function paintReportNow() {
  const ticked = $('reportAddr').checked;
  $('reportAddrList').classList.toggle('hide', !ticked);
  $('reportAddrValue').textContent = ticked ? reportCtx.address : '';
  $('reportPayload').textContent = JSON.stringify(reportNow(), null, 2);
}
async function paintReport() {
  try { reportCtx = await rpc('reportContext'); } catch {}
  paintReportNow();
}
(function mountReport() {
  const W = REPORT_WORDS;
  const set = (id, t) => { $(id).textContent = t; };
  set('reportTitle', W.title); set('reportIntro', W.intro); set('reportTextLabel', W.descriptionLabel);
  set('reportCodeLabel', W.codeLabel); set('reportCodeHint', W.codeHint); set('reportIncludes', W.includes);
  set('reportAddrLabel', W.addressesBox); set('reportAddrWill', W.addressesWill); set('reportPreviewLabel', W.preview);
  set('btnReport', W.send);
  $('reportText').placeholder = W.descriptionHint;
  const clearRefusal = () => { if ($('reportStatus').classList.contains('err')) { $('reportStatus').className = 'status'; $('reportStatus').textContent = ''; } paintReportNow(); };
  $('reportText').addEventListener('input', clearRefusal);
  $('reportCode').addEventListener('input', clearRefusal);
  $('reportAddr').addEventListener('change', paintReportNow);
  $('reportPreview').addEventListener('toggle', paintReport);
  $('btnReport').onclick = async () => {
    const st = $('reportStatus');
    await paintReport();
    const r = reportNow();
    let no = r.description ? null : W.needDescription;
    if (!no) { try { no = (await rpc('reportCheck', { report: r })).refusal; } catch {} }
    if (no) { st.className = 'status err'; st.textContent = no; return; }
    $('btnReport').disabled = true; st.className = 'status'; st.textContent = W.sending;
    const res = await sendReport(r, { url: BASE + '/emissio/api/problem-reports' });
    $('btnReport').disabled = false;
    if (!res.ok) { st.className = 'status err'; st.textContent = res.message; return; }
    st.className = 'status ok'; st.textContent = sentWords(res);
    $('reportText').value = ''; $('reportAddr').checked = false; paintReportNow();
  };
})();

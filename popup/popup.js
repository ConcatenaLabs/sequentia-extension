// Popup UI. All wallet logic lives in the background engine; this file only
// renders state and relays user intents over the ui RPC scope.
import { lnInvoiceKind } from '../src/util.js';

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

const TABS = ['balance', 'send', 'receive', 'stake', 'history', 'settings'];
function tab(name) {
  for (const t of TABS) $('t' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hide', t !== name);
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  if (name === 'receive') renderReceive();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'send') fillSendSelectors();
  if (name === 'stake') { renderStake(); renderRewards(); }
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
  for (const r of OV.rows) {
    const row = el('div', 'asset-row');
    const head = el('div', 'arow-head');
    const tk = el('span', 'tk', r.ticker); tk.title = r.ticker; head.appendChild(tk);
    if (r.verified) { const b = el('span', 'badge-v', '✓'); b.title = r.key === 'BTC' ? 'Bitcoin, the parent chain' : (r.domain ? 'Verified · ' + r.domain : 'Verified in the Sequentia asset registry'); head.appendChild(b); }
    else if (!r.registered) { const b = el('span', 'badge-u', '⚠'); b.title = 'Not in the asset registry. Anyone can issue an asset with any ticker; verify the issuer before trusting it.'; head.appendChild(b); }
    const mid = el('div', 'grow');
    const nm = el('div', 'sub', r.name); nm.title = r.name + (r.domain ? ' · registered by ' + r.domain : '');
    mid.appendChild(nm); head.appendChild(mid);
    const amt = el('span', 'amt');
    amt.appendChild(el('div', null, fmtAtoms(r.total, r.precision)));
    if (r.refStr) amt.appendChild(el('div', 'sub', r.refStr));
    head.appendChild(amt);
    row.appendChild(head);

    if (r.restricted && r.legend) {
      const meta = el('div', 'ln-meta'); meta.appendChild(el('div', null, r.legend)); row.appendChild(meta);
    }
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
  } catch (e) { $('sendErr').className = 'status err'; $('sendErr').textContent = e.message; }
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
    } catch (e) { st.className = 'status err'; st.textContent = 'Failed: ' + e.message; ok.disabled = no.disabled = false; }
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
  } catch (e) { $('settingsStatus').className = 'status err'; $('settingsStatus').textContent = e.message; }
}
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

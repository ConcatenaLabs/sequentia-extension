// Approval window logic: fetch the pending request, optionally unlock first,
// render a human-readable summary, and send the decision.

const $ = (id) => document.getElementById(id);
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ scope: 'ui', method, params }, (resp) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (resp && resp.ok) resolve(resp.result);
    else reject(new Error((resp && resp.error) || 'request failed'));
  });
});

const reqId = new URLSearchParams(location.search).get('id');

const TITLES = {
  connect: 'Connect to this site?',
  unlock: 'Unlock your wallet',
  signMessage: 'Sign a message?',
  signPset: 'Sign a transaction?',
  createInvoice: 'Create a Lightning invoice?',
  payInvoice: 'Pay a Lightning invoice?',
  lnRequestInbound: 'Request inbound Lightning capacity?',
  dexFillOnchain: 'Fill this order on-chain?',
  dexSwapLn: 'Swap over Lightning?',
  openampSignTagged: 'Sign a statement?',
  openampSignSpend: 'Co-sign a restricted-asset spend?',
  openampSignSupervision: 'Authorize this as the asset\u2019s issuer?',
  signContractSpend: 'Sign this contract spend?',
  requestLeafReceive: 'Hand out a receive request for leaves?',
  sendLeaves: 'Pay from your leaves?',
};

function fmtAtoms(atoms, d) {
  let a = BigInt(atoms); const neg = a < 0n; if (neg) a = -a;
  const base = 10n ** BigInt(d);
  let s = (a / base).toString();
  if (d > 0) { const f = (a % base).toString().padStart(d, '0').replace(/0+$/, ''); if (f) s += '.' + f; }
  return (neg ? '-' : '') + s;
}

let approval = null;

async function load() {
  const { approval: a, unlocked } = await rpc('approval.get', { id: reqId });
  approval = a;
  if (!a) { show('noneCard'); return; }
  if (!unlocked) { show('unlockCard'); return; }
  render(a);
}

function show(id) {
  for (const c of ['unlockCard', 'reqCard', 'noneCard']) $(c).classList.toggle('hide', c !== id);
}

function render(a) {
  show('reqCard');
  $('reqTitle').textContent = TITLES[a.method] || a.method;
  $('reqOrigin').textContent = a.origin;
  $('reqText').textContent = (a.display && a.display.text) || '';
  const det = $('reqDetail');
  det.innerHTML = '';
  const d = a.display || {};
  const add = (label, value, mono) => {
    const kv = document.createElement('div'); kv.className = 'kv';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'v'; if (mono) v.style.fontFamily = 'var(--mono)';
    v.textContent = value;
    kv.appendChild(k); kv.appendChild(v); det.appendChild(kv);
  };
  if (d.detail) add('Details', d.detail);
  if (Array.isArray(d.rows)) for (const [k, v] of d.rows) add(k, String(v), /^[0-9a-f]{20,}$/i.test(String(v)));
  if (d.message) { const p = document.createElement('div'); p.className = 'payload'; p.textContent = d.message; det.appendChild(p); }
  if (d.bolt11) { const p = document.createElement('div'); p.className = 'payload'; p.textContent = d.bolt11; det.appendChild(p); }
  if (Array.isArray(d.deltas)) {
    for (const x of d.deltas) {
      const v = BigInt(x.atoms);
      add(v < 0n ? 'You send' : 'You receive', fmtAtoms(x.atoms, x.precision) + ' ' + x.ticker);
    }
  }
  if (d.fee != null) add('Network fee (est.)', String(d.fee) + ' atoms');
  // A contract spend: the engine's summary, section by section (vendor/contracts.js).
  if (Array.isArray(d.sections)) {
    for (const sec of d.sections) {
      const h = document.createElement('div'); h.className = 'section'; h.textContent = sec.title; det.appendChild(h);
      for (const [k, v] of sec.rows) add(k, String(v), /^[0-9a-f]{20,}$/i.test(String(v)));
    }
  }
  if (d.pset) { const p = document.createElement('div'); p.className = 'payload'; p.textContent = d.pset; det.appendChild(p); }
  if (d.warning) { const w = document.createElement('div'); w.className = 'status err'; w.textContent = d.warning; det.appendChild(w); }
}

$('btnUnlock').onclick = async () => {
  $('unlockErr').textContent = '';
  try {
    await rpc('approval.unlock', { password: $('pw').value });
    await load();
  } catch (e) { $('unlockErr').textContent = e.message; }
};
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnUnlock').click(); });

function closeSelf() {
  // window.close() is unreliable for a page opened via chrome.tabs.create;
  // fall back to removing our own tab.
  try { window.close(); } catch {}
  try { chrome.tabs.getCurrent((t) => { if (t && t.id != null) chrome.tabs.remove(t.id); }); } catch {}
}

async function decide(approve) {
  $('btnApprove').disabled = $('btnReject').disabled = true;
  $('reqStatus').className = 'status';
  $('reqStatus').textContent = approve ? 'Working…' : 'Rejecting…';
  try {
    // What this page showed: a contract spend is signed only for the digest it rendered.
    const shown = (approval.display && approval.display.digest) || null;
    await rpc('approval.decide', { id: approval.id, approve, shown });
    closeSelf();
  } catch (e) {
    $('reqStatus').className = 'status err';
    $('reqStatus').textContent = 'Failed: ' + e.message;
    $('btnApprove').disabled = $('btnReject').disabled = false;
  }
}
$('btnApprove').onclick = () => decide(true);
$('btnReject').onclick = () => decide(false);

load().catch((e) => { show('noneCard'); console.error(e); });

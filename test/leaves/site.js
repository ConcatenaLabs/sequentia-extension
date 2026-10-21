// The test site: every button is one provider call; its answer (or its error, in the
// wallet's words) is written to #out, with data-method and data-ok on the element, and
// every event the wallet sends is appended to #events as one JSON line.
(() => {
  const $ = (id) => document.getElementById(id);
  const out = $('out');
  const events = [];
  function show(method, ok, v) {
    out.dataset.method = method;
    out.dataset.ok = ok ? '1' : '0';
    out.className = ok ? '' : 'err';
    out.textContent = ok ? JSON.stringify(v, null, 2) : String(v && v.message ? v.message : v);
  }
  async function call(method, params) {
    out.dataset.method = method; out.dataset.ok = ''; out.textContent = 'waiting for the wallet…';
    try { const v = await window.sequentia.request({ method, params }); show(method, true, v); return v; }
    catch (e) { show(method, false, e); return null; }
  }
  // The site follows the wallet's mode: its leaf features show in developer mode only.
  function follow(mode) {
    $('siteMode').textContent = mode || 'unknown';
    $('leafFeatures').hidden = mode !== 'developer';
    document.body.dataset.mode = mode || '';
  }
  async function readMode() {
    try { const v = await window.sequentia.request({ method: 'getWalletMode' }); follow(v && v.mode); } catch { follow(null); }
  }
  function listen() {
    window.sequentia.on('modeChanged', (data) => follow(data && data.mode));
    for (const ev of ['leafArrived', 'leafSyncDue', 'modeChanged', 'accountsChanged', 'disconnect']) {
      window.sequentia.on(ev, (data) => {
        events.push({ event: ev, data, at: Date.now() });
        $('events').textContent = events.map((e) => JSON.stringify(e)).join('\n');
      });
    }
  }
  const val = (id) => $(id).value.trim();
  const opt = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  function wire() {
    listen();
    $('btnConnect').onclick = () => call('connect');
    $('btnMode').onclick = async () => { const v = await call('getWalletMode'); if (v) follow(v.mode); };
    $('btnBalances').onclick = () => call('getLeafBalances');
    $('btnAddress').onclick = () => call('getLeafAddress');
    $('btnBoard').onclick = () => call('boardLeaves', opt({ asset: val('asset'), amount: val('amount'), fee_asset: val('feeAsset') }));
    $('btnExit').onclick = () => call('exitLeaf', opt({ leaf_id: val('leafId'), fee_asset: val('feeAsset') }));
    $('btnReceive').onclick = () => call('requestLeafReceive', opt({ asset: val('asset'), amount: val('amount') }));
    $('btnSend').onclick = () => call('sendLeaves', opt({ request: val('request'), asset: val('asset'), amount: val('amount') }));
    $('btnSwapOffer').onclick = () => call('leafSwapOffer', { give_asset: val('giveAsset'), give: val('give'), want_asset: val('wantAsset'), want: val('want') });
    $('btnSwapAccept').onclick = () => call('leafSwapAccept', { offer: val('swapOffer') });
    $('btnSwapComplete').onclick = () => call('leafSwapComplete', { accept: val('swapAccept') });
    $('btnSwaps').onclick = () => call('getLeafSwaps');
    $('btnSwapCancel').onclick = () => call('leafSwapCancel', { swap: val('swapId') });
    window.siteEvents = events;
    readMode();
  }
  if (window.sequentia) wire(); else window.addEventListener('sequentia#initialized', wire, { once: true });
})();

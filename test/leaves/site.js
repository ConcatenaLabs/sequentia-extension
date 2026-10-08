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
  function listen() {
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
    $('btnMode').onclick = () => call('getWalletMode');
    $('btnBalances').onclick = () => call('getLeafBalances');
    $('btnReceive').onclick = () => call('requestLeafReceive', opt({ asset: val('asset'), amount: val('amount') }));
    $('btnSend').onclick = () => call('sendLeaves', opt({ request: val('request'), asset: val('asset'), amount: val('amount') }));
    window.siteEvents = events;
  }
  if (window.sequentia) wire(); else window.addEventListener('sequentia#initialized', wire, { once: true });
})();

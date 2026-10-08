// Content script (isolated world): relays window.sequentia requests from the
// page to the background service worker, and wallet events back to the page.
//
// Requests prefer the long-lived PORT channel: sendMessage response callbacks
// die at Chrome's ~5-minute cap, which is shorter than a Lightning swap or a
// node revival. While any port request is in flight, a keepalive ping runs
// every 15s — each port message resets the service worker's 30-second idle
// clock, so a multi-minute operation cannot be killed mid-flight.
(() => {
  const TAG = '__sequentiaWallet';
  let eventPort = null;
  let pinger = null;
  const portPending = new Map();   // reqId -> true (response routed to page)

  function updatePinger() {
    if (portPending.size && !pinger) {
      pinger = setInterval(() => { try { eventPort && eventPort.postMessage({ __ping: 1 }); } catch {} }, 15000);
    }
    if (!portPending.size && pinger) { clearInterval(pinger); pinger = null; }
  }

  function ensureEventPort() {
    if (eventPort) return eventPort;
    try {
      eventPort = chrome.runtime.connect({ name: 'seq-dapp' });
      eventPort.onMessage.addListener((m) => {
        if (!m) return;
        if (m.__pong) return;
        if (m.__res != null) {
          if (portPending.delete(m.__res)) {
            updatePinger();
            window.postMessage({ [TAG]: 'res', id: m.__res, ok: !!m.ok, result: m.result, error: m.error }, window.location.origin);
          }
          return;
        }
        if (m.event) window.postMessage({ [TAG]: 'event', event: m.event, data: m.data }, window.location.origin);
      });
      eventPort.onDisconnect.addListener(() => {
        eventPort = null;
        for (const id of portPending.keys()) {
          window.postMessage({ [TAG]: 'res', id, ok: false, error: 'the wallet restarted; check your balances before retrying' }, window.location.origin);
        }
        portPending.clear();
        updatePinger();
      });
    } catch { eventPort = null; }
    return eventPort;
  }

  function viaSendMessage(m) {
    chrome.runtime.sendMessage({ scope: 'dapp', method: m.method, params: m.params }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        window.postMessage({ [TAG]: 'res', id: m.id, ok: false, error: err.message }, window.location.origin);
        return;
      }
      if (resp && resp.ok) {
        if (m.method === 'connect') ensureEventPort();
        window.postMessage({ [TAG]: 'res', id: m.id, ok: true, result: resp.result }, window.location.origin);
      } else {
        window.postMessage({ [TAG]: 'res', id: m.id, ok: false, error: (resp && resp.error) || 'request failed' }, window.location.origin);
      }
    });
  }

  // Events the wallet sends through every tab (they reach a page even after the
  // wallet's service worker has slept, which closes the port above): passed on only to
  // a page of one of the origins named (none named: any page).
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.scope !== 'dapp-event' || typeof m.event !== 'string') return;
      if (Array.isArray(m.origins) && !m.origins.includes(window.location.origin)) return;
      window.postMessage({ [TAG]: 'event', event: m.event, data: m.data }, window.location.origin);
    });
  } catch {}

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] === undefined) return;
    const m = ev.data;
    if (m[TAG] === 'listen') { ensureEventPort(); return; }
    if (m[TAG] !== 'req') return;
    const port = ensureEventPort();
    if (port) {
      try {
        portPending.set(m.id, true);
        updatePinger();
        port.postMessage({ __req: m.id, method: m.method, params: m.params });
        return;
      } catch { portPending.delete(m.id); updatePinger(); eventPort = null; }
    }
    viaSendMessage(m);
  });
})();

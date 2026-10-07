// What a Chromium service worker offers that Node does not, enough for
// background.js to load and answer its own UI messages. `__sw.ui(method,
// params)` sends a message exactly as the popup does and resolves with the
// result, or rejects with the error the popup would show.

const areas = { local: new Map(), session: new Map() };
function mkArea(map) {
  return {
    async get(key) {
      if (key == null) return Object.fromEntries(map);
      if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
      const out = {};
      for (const k of key) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(key) { for (const k of [].concat(key)) map.delete(k); },
  };
}
const listeners = { message: [], connect: [], alarm: [] };
const event = (list) => ({ addListener: (f) => list.push(f), removeListener() {} });

globalThis.chrome = {
  storage: { local: mkArea(areas.local), session: mkArea(areas.session) },
  alarms: { async create() {}, async clear() {}, onAlarm: event(listeners.alarm) },
  runtime: {
    id: 'regtest',
    getManifest: () => ({ version: '0.0.0-regtest' }),
    getURL: (p) => 'chrome-extension://regtest/' + p,
    onMessage: event(listeners.message),
    onConnect: event(listeners.connect),
    sendMessage: async () => undefined,
  },
  tabs: { async create() {} },
};
globalThis.self = globalThis;
globalThis.addEventListener ??= () => {};

globalThis.__sw = {
  ui(method, params = {}) {
    return new Promise((resolve, reject) => {
      const sender = { id: 'regtest', url: 'chrome-extension://regtest/popup/popup.html' };
      const respond = (r) => (r && r.ok ? resolve(r.result) : reject(new Error(r ? r.error : 'no response')));
      if (!listeners.message.length) return reject(new Error('background.js registered no message listener'));
      for (const l of listeners.message) l({ scope: 'ui', method, params }, sender, respond);
    });
  },
};

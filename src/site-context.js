// Whose the site-trade engine's and its order review's leaf commands are. The engine
// (vendor/user-trade.js) and the review (vendor/site-orders.js) are the web wallet's, and their
// leaf commands name no caller, so the extension runs one engine and one review for each site
// (src/site-trade.js), each asking the library through its own side made here: whatever one site's
// side asks can only ever be that site's or the person's, never another site's.
//
//   siteSide(origin, runUser) -> { leaves, asking(f), approving(f), attribution() }
//     leaves      the engine's and the review's `leaves`: `command` asks the library as attribution()
//                 says; `hold`, which the engine wraps around each quote and each confirmation,
//                 makes everything that quote or confirmation asks, for as long as it runs, the
//                 site's (a quote) or the person's (a confirmation the person approved, asked while
//                 `approving`), however long it outlives the request that started it
//     asking(f)   runs f, a request the site makes with nothing approved (a quote, its orders, a
//                 cancel to approve, what it can spend)
//     approving(f) runs f, what the person approved (the trade, the cancel)
//     attribution() -> runUser's options now: the person's while anything approved runs (an
//                 approved request or a confirmation's hold: it always wins), else the site's
//                 (`origin`) while a request of the site's or a quote's hold runs, else the
//                 wallet's own (the engine's follow of trades after the answer)
//
//   keptSide(runUser) -> the same for the engine and review over the records kept before each site
//     had its own (one wallet-wide engine). They serve several sites, so the site's requests
//     (`asking(origin, f)`) run one at a time, each under its own origin; approved work does not
//     wait for them, and is the person's.
export function siteSide(origin, runUser) {
  const n = { asking: 0, approving: 0, siteHolds: 0, approvedHolds: 0 };
  const attribution = () => (n.approving || n.approvedHolds ? { person: true } : (n.asking || n.siteHolds) && origin ? { origin } : {});
  return {
    leaves: {
      command: (cmd, args) => runUser(String(cmd), args || {}, attribution()),
      async hold(f) {
        const k = n.approving ? 'approvedHolds' : 'siteHolds';
        n[k]++;
        try { return await f(); } finally { n[k]--; }
      },
    },
    async asking(f) { n.asking++; try { return await f(); } finally { n.asking--; } },
    async approving(f) { n.approving++; try { return await f(); } finally { n.approving--; } },
    attribution,
    counts: n,
  };
}

export function keptSide(runUser) {
  const n = { approving: 0, approvedHolds: 0, siteHolds: 0 };
  let current = null, chain = Promise.resolve();
  const attribution = () => (n.approving || n.approvedHolds ? { person: true } : current ? { origin: current } : {});
  return {
    leaves: {
      command: (cmd, args) => runUser(String(cmd), args || {}, attribution()),
      async hold(f) {
        const k = n.approving ? 'approvedHolds' : 'siteHolds';
        n[k]++;
        try { return await f(); } finally { n[k]--; }
      },
    },
    asking(origin, f) {
      const run = chain.then(async () => { current = String(origin || '') || null; try { return await f(); } finally { current = null; } });
      chain = run.catch(() => {});
      return run;
    },
    async approving(f) { n.approving++; try { return await f(); } finally { n.approving--; } },
    attribution,
    counts: n,
  };
}

// The tag a site's records are kept under: the wallet's, and the site's origin.
export const siteTag = (tag, origin) => `${tag}|site|${origin}`;
// Whether the wallet's tag alone holds records of the engine (vendor/user-trade.js, 'swk.usertrade')
// or the review (vendor/site-orders.js, 'swk.siteorders'): made before each site had its own.
export function keptRecords(st, tag) {
  const read = (k) => { try { return JSON.parse(st.getItem(k) || 'null'); } catch { return null; } };
  const trades = read('swk.usertrade.' + tag);
  const db = read('swk.siteorders.' + tag) || {};
  return (Array.isArray(trades) && trades.length > 0) || ['trades', 'orders', 'placing'].some((k) => db[k] && Object.keys(db[k]).length > 0);
}
// The sites that have records of their own (an engine's trades or a review's orders) among the
// keys of the store: each one's engine follows its trades, whether or not the site has asked anything
// since the service worker started. The engine keeps one more key beside its trades (the orders the
// operator refused as not final yet: '.notfinal'), which names no other site.
export function sitesWithRecords(keys, tag) {
  const out = new Set();
  for (const p of ['swk.usertrade.', 'swk.siteorders.']) {
    const pre = p + siteTag(tag, '');
    for (const k of keys) {
      if (!k.startsWith(pre)) continue;
      let origin = k.slice(pre.length);
      if (p === 'swk.usertrade.' && origin.endsWith('.notfinal')) origin = origin.slice(0, -'.notfinal'.length);
      if (origin) out.add(origin);
    }
  }
  return [...out];
}

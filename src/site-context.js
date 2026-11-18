// Whose commands the site-trade engine and its site-order review ask the leaf library: a site's,
// the person's, or the wallet's own. The engine (vendor/user-trade.js) and the review
// (vendor/site-orders.js) are the web wallet's, one of each for every site, and their leaf commands
// carry no caller of their own. So each entry a site's request takes into them runs in a span:
// `site(origin, f)` while the site asks for something the person has not approved (a quote, its
// orders, a cancel to approve, what it can spend), `approved(f)` while what the person approved runs
// (the trade, the cancel). The adapters (`leaves`) ask the library as the spans under way say:
//   - a site's span under way: the site's, with its origin (the host runs it after every command of
//     the person's own and counts it against that site: src/leaves.js runUser `origin`); with
//     several sites' spans at once, under one origin shared by them (SEVERAL_SITES);
//   - else an approved span: the person's;
//   - else the wallet's own (the engine's follow of trades after the answer).
// A site's span under way wins over an approved one: a command whose caller cannot be told apart
// waits after the person's own rather than ahead of them.
export const SEVERAL_SITES = 'several sites';

export function siteContext() {
  const sites = new Map();
  let approved = 0;
  return {
    async site(origin, f) {
      const key = String(origin || '');
      sites.set(key, (sites.get(key) || 0) + 1);
      try { return await f(); } finally { const n = sites.get(key) - 1; if (n) sites.set(key, n); else sites.delete(key); }
    },
    async approved(f) {
      approved++;
      try { return await f(); } finally { approved--; }
    },
    // -> runUser's options for a command asked now.
    attribution() {
      if (sites.size) return { origin: sites.size === 1 ? sites.keys().next().value : SEVERAL_SITES };
      if (approved) return { person: true };
      return {};
    },
  };
}

// The leaf commands of the engine or the review, as the spans under way attribute them.
export function siteLeaves(ctx, runUser) {
  return { command: (cmd, args) => runUser(String(cmd), args || {}, ctx.attribution()) };
}

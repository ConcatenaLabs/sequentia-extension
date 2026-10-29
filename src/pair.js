// A pair's display direction, {base, quote}: the web wallet's canonicalPair (swap.js), which that
// file keeps among much the extension does not load; change it there first, then here. Only
// units of account are quotes (BTC, then the fiat stablecoins, bridged ones included); the
// Sequence token is one asset among equals and ranks with every other base. A rank tie falls back
// to the asset id, so a pair's direction never flips with the side being bought.
const RANK = { USDX: 900, EURX: 890, 'EURC.E': 885, FEEUSD: 880, USDT: 870, USDC: 865, 'USDC.E': 864, USD: 860 };

export function quoteRank(hex, tickerOf) {
  if (hex === 'BTC') return 1000;
  const t = String((tickerOf && tickerOf(hex)) || '').toUpperCase();
  return t in RANK ? RANK[t] : 400;
}

export function canonicalPair(a, b, tickerOf) {
  if (!a || !b) return { base: a || b, quote: b || a };
  const ra = quoteRank(a, tickerOf), rb = quoteRank(b, tickerOf);
  if (ra !== rb) return ra > rb ? { base: b, quote: a } : { base: a, quote: b };
  return String(a) < String(b) ? { base: a, quote: b } : { base: b, quote: a };
}

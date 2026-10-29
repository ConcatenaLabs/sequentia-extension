// Copied unchanged from seqdex-web shared/indicators.js, the family's one chart module; change it there
// first, then copy it here.
// Chart indicators, computed on the page from the relay's candles (oldest first,
// `{ t, o, h, l, c, v }`, prices in whole quote units per whole base unit). Each
// returns points `{ time, value }` for the chart, starting where the indicator has
// enough candles to mean anything. No library: these are the textbook formulas.

const pt = (c, value) => ({ time: c.t, value });

// Simple moving average of the closes over n candles.
export function sma(candles, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= n) sum -= candles[i - n].c;
    if (i >= n - 1) out.push(pt(candles[i], sum / n));
  }
  return out;
}

// Exponential moving average over n candles, seeded with the simple average of
// the first n.
export function ema(candles, n) {
  if (candles.length < n) return [];
  const a = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += candles[i].c / n;
  const out = [pt(candles[n - 1], e)];
  for (let i = n; i < candles.length; i++) {
    e = candles[i].c * a + e * (1 - a);
    out.push(pt(candles[i], e));
  }
  return out;
}

// Bollinger bands: the n-candle average and k standard deviations (of the
// population) either side of it.
export function bollinger(candles, n = 20, k = 2) {
  const upper = [], middle = [], lower = [];
  for (let i = n - 1; i < candles.length; i++) {
    let mu = 0;
    for (let j = i - n + 1; j <= i; j++) mu += candles[j].c / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (candles[j].c - mu) ** 2 / n;
    const sd = Math.sqrt(v);
    middle.push(pt(candles[i], mu));
    upper.push(pt(candles[i], mu + k * sd));
    lower.push(pt(candles[i], mu - k * sd));
  }
  return { upper, middle, lower };
}

// Volume-weighted average price of each UTC day so far, from each candle's
// typical price (high + low + close) / 3. A candle with no volume leaves it as
// it was; a day's first candles with no volume have none.
export function vwap(candles) {
  const out = [];
  let day = null, pv = 0, vol = 0;
  for (const c of candles) {
    const d = Math.floor(c.t / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = Number(c.v) || 0;
    pv += (c.h + c.l + c.c) / 3 * v;
    vol += v;
    if (vol > 0) out.push(pt(c, pv / vol));
  }
  return out;
}

// Relative strength index over n candles, with Wilder's smoothing; 0 to 100. A
// market that only rose reads 100, one that never moved 50.
export function rsi(candles, n = 14) {
  if (candles.length <= n) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) gain += d / n; else loss -= d / n;
  }
  const val = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  const out = [pt(candles[n], val())];
  for (let i = n + 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out.push(pt(candles[i], val()));
  }
  return out;
}

// The indicators a chart offers, in the menu's order: their words, their colour,
// and whether they draw over the price, in a pane of their own, or as the volume
// bars. `on` is the choice a new visitor starts with.
export const INDICATORS = Object.freeze([
  { key: 'vol', label: 'Volume', color: '#5c6470', place: 'volume', on: true },
  { key: 'ma7', label: 'Moving average 7', color: '#8fb8ff', place: 'price', on: true, lines: (c) => [sma(c, 7)] },
  { key: 'ma25', label: 'Moving average 25', color: '#c084fc', place: 'price', on: true, lines: (c) => [sma(c, 25)] },
  { key: 'ema20', label: 'EMA 20', color: '#2dd4bf', place: 'price', on: false, lines: (c) => [ema(c, 20)] },
  { key: 'bb', label: 'Bollinger bands 20, 2', color: '#97a0ae', place: 'price', on: false, lines: (c) => { const b = bollinger(c, 20, 2); return [b.upper, b.middle, b.lower]; } },
  { key: 'vwap', label: 'VWAP', color: '#fbbf24', place: 'price', on: false, lines: (c) => [vwap(c)] },
  { key: 'rsi', label: 'RSI 14', color: '#f472b6', place: 'pane', on: false, lines: (c) => [rsi(c, 14)] },
]);

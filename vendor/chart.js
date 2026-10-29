// Copied unchanged from seqdex-web shared/chart.js, the family's one chart module; change it there
// first, then copy it here.
// SeqDEX's charts: a pair's price (candles or a step line, with volume and the
// indicators of shared/indicators.js) and its book's depth, drawn with TradingView
// Lightweight Charts (vendor/lightweight-charts). The wallets draw their market
// view with the same library and the same ranges, colours and words, so a person
// moving between them sees one chart.
//
// The library is passed in (`LW`, the module's namespace) rather than imported
// here, so every page and every wallet uses its own vendored copy of one file and
// the pure helpers below load in Node for the tests.
import { INDICATORS } from './indicators.js';

// The family's colours: buys green, sales amber, as in the wallets.
export const COLORS = Object.freeze({
  buy: '#3ddc84', sell: '#f0a35e', line: '#8fb8ff',
  bg: '#14161c', text: '#97a0ae', grid: '#1b1f27', border: '#262b35', cross: '#5c6470',
});

// The library's attribution notice, which a page showing a chart shows with its link.
export const CHART_NOTICE = Object.freeze({
  text: 'Charts by TradingView Lightweight Charts™',
  href: 'https://www.tradingview.com/',
});

// The chart's ranges: the span shown and the candle each bar is (relay seconds).
// 1D, 1W and 1M are the wallets' own; SeqDEX adds 3M, 1Y and All. The relay keeps
// a market's last 1,000 trades, so a long range shows as far back as those go.
export const RANGES = Object.freeze([
  { key: '1D', span: 86400, interval: 900 },
  { key: '1W', span: 7 * 86400, interval: 7200 },
  { key: '1M', span: 30 * 86400, interval: 43200 },
  { key: '3M', span: 90 * 86400, interval: 86400 },
  { key: '1Y', span: 365 * 86400, interval: 86400 },
  { key: 'All', span: 0, interval: 7 * 86400 },
]);
export const rangeOf = (key) => RANGES.find((r) => r.key === key) || RANGES[2];

// Decimals and the smallest step for prices around p: about six significant figures.
export function priceFormat(p) {
  const a = Math.abs(Number(p)) || 1;
  const precision = Math.max(0, Math.min(12, 5 - Math.floor(Math.log10(a))));
  return { type: 'price', precision, minMove: Number((10 ** -precision).toFixed(precision)) };
}

// The candles of a range with every interval in it present: the relay serves only
// intervals that traded, and the library spaces bars by their order, so an empty
// day would vanish from the time axis. An interval with no trade holds the last
// price (open = high = low = close, no volume); the close before the range is
// carried in; nothing is drawn before the market's first trade. `fromSec` 0 means
// from the first candle. Intervals align to the epoch, as the relay's do.
export function fillCandles(candles, interval, fromSec, nowSec, maxBars = 1500) {
  if (!candles.length || !(interval > 0)) return [];
  const align = (t) => Math.floor(t / interval) * interval;
  const end = align(nowSec);
  let start = align(fromSec > 0 ? fromSec : candles[0].t);
  start = Math.max(start, align(candles[0].t), end - (maxBars - 1) * interval);
  const at = new Map(candles.map((c) => [c.t, c]));
  let prev = null;
  for (const c of candles) { if (c.t < start) prev = c.c; else break; }
  const out = [];
  for (let t = start; t <= end; t += interval) {
    const c = at.get(t);
    if (c) { out.push(c); prev = c.c; }
    else if (prev != null) out.push({ t, o: prev, h: prev, l: prev, c: prev, v: 0 });
  }
  return out;
}

// The relay's candles, already in whole units, as the library's bars and volume.
export function barsOf(candles) {
  return candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }));
}
export function volumeOf(candles) {
  return candles.map((c) => ({ time: c.t, value: Number(c.v) || 0, color: c.c >= c.o ? 'rgba(61,220,132,.45)' : 'rgba(240,163,94,.45)' }));
}
// The step line: each close, held until the next one, carried to now.
export function closesOf(candles, nowSec) {
  const pts = candles.map((c) => ({ time: c.t, value: c.c }));
  const last = candles[candles.length - 1];
  if (last && nowSec > last.t) pts.push({ time: nowSec, value: last.c });
  return pts;
}

// The book's depth sampled at even price steps (the library's price axis spaces
// points by their order, not by their value): at each step on the buyers' side,
// how much is bid at that price or above; on the sellers' side, how much is asked
// at that price or below. bids and asks are `{ price, size }` in whole units. The
// step grows so neither side has more than `maxPoints` points. A crossed book
// (best bid above best ask) is drawn as it is: the two sides overlap.
export function depthSeries(bids, asks, { maxPoints = 300, span = 0.1 } = {}) {
  const b = bids.filter((o) => o.price > 0 && o.size > 0).sort((x, y) => y.price - x.price);
  const a = asks.filter((o) => o.price > 0 && o.size > 0).sort((x, y) => x.price - y.price);
  if (!b.length && !a.length) return { bids: [], asks: [], step: 0 };
  const ref = b.length && a.length ? (b[0].price + a[0].price) / 2 : (b[0] || a[0]).price;
  const lo = Math.max(b.length ? b[b.length - 1].price : ref, ref * (1 - span));
  const hi = Math.min(a.length ? a[a.length - 1].price : ref, ref * (1 + span));
  let step = niceStep(Math.max(hi - lo, ref * 1e-6) / maxPoints);
  const round = (x) => Number(x.toPrecision(12));
  const side = (orders, from, to, holds) => {
    const out = [];
    const first = Math.floor(from / step), last = Math.ceil(to / step);
    for (let k = first; k <= last; k++) {
      const px = round(k * step);
      let d = 0;
      for (const o of orders) if (holds(o.price, px)) d += o.size;
      out.push({ time: px, value: d });
    }
    return out;
  };
  return {
    step,
    bids: b.length ? side(b, lo, b[0].price, (p, px) => p >= px) : [],
    asks: a.length ? side(a, a[0].price, hi, (p, px) => p <= px) : [],
  };
}
// 1, 2 or 5 times a power of ten, at least x.
export function niceStep(x) {
  const e = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * e >= x) return Number((m * e).toPrecision(12));
  return 10 * e;
}

// A seven-day line for a list, as SVG text: the ticker's spark_7d (0 before the
// first trade is left out), green when it ends at or above where it starts.
export function sparkSvg(points, { w = 120, h = 30 } = {}) {
  const p = (points || []).map(Number).filter((x) => x > 0);
  if (p.length < 2) return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const lo = Math.min(...p), hi = Math.max(...p);
  const xy = p.map((v, i) => `${(i / (p.length - 1) * w).toFixed(1)},${(h - 2 - (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 4)).toFixed(1)}`).join(' ');
  const col = p[p.length - 1] >= p[0] ? COLORS.buy : COLORS.sell;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${col}" stroke-width="1.5" points="${xy}"/></svg>`;
}

// A flat or nearly flat price keeps a readable scale: 1% either side of it.
export function padFlat(range) {
  const r = range && range.priceRange;
  if (!r) return range;
  const { minValue: lo, maxValue: hi } = r, mid = (lo + hi) / 2;
  if (hi - lo > Math.abs(mid) * 0.002) return range;
  const d = Math.abs(mid) * 0.01 || 1;
  return { ...range, priceRange: { minValue: mid - d, maxValue: mid + d } };
}
const autoscaleInfoProvider = (orig) => padFlat(orig());

function baseOptions(extra = {}) {
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: COLORS.bg }, textColor: COLORS.text,
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 11,
      attributionLogo: true,
      panes: { separatorColor: COLORS.border, separatorHoverColor: COLORS.border },
    },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: COLORS.border },
    timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0, vertLine: { color: COLORS.cross, labelBackgroundColor: COLORS.border }, horzLine: { color: COLORS.cross, labelBackgroundColor: COLORS.border } },
    ...extra,
  };
}

// A pair's price chart in `el`. Returns its controls:
//   setCandles(candles, nowSec, range)  the relay's candles in whole units, oldest
//                                first, for a range of RANGES (filled, fillCandles)
//   setType('candles' | 'line')
//   setIndicators(keys)          a Set of INDICATORS keys to show
//   onHover(fn)                  fn(candle or null) as the pointer moves
//   remove()
export function createPriceChart(LW, el, { type = 'candles', indicators } = {}) {
  const chart = LW.createChart(el, baseOptions());
  const shown = new Set(indicators || INDICATORS.filter((i) => i.on).map((i) => i.key));
  let kind = type, candles = [], now = 0, fitKey = null;
  const candle = chart.addSeries(LW.CandlestickSeries, { upColor: COLORS.buy, downColor: COLORS.sell, borderVisible: false, wickUpColor: COLORS.buy, wickDownColor: COLORS.sell, autoscaleInfoProvider });
  const line = chart.addSeries(LW.LineSeries, { color: COLORS.line, lineWidth: 2, lineType: LW.LineType.WithSteps, visible: false, autoscaleInfoProvider });
  let volume = null;
  let lines = [];      // indicator series drawn now
  const byTime = new Map();

  function drawIndicators() {
    for (const s of lines) chart.removeSeries(s);
    lines = [];
    if (shown.has('vol')) {
      if (!volume) { volume = chart.addSeries(LW.HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1); }
      volume.setData(volumeOf(candles));
    } else if (volume) { chart.removeSeries(volume); volume = null; }
    let pane = volume ? 2 : 1;
    for (const ind of INDICATORS) {
      if (ind.place === 'volume' || !shown.has(ind.key)) continue;
      const where = ind.place === 'pane' ? pane++ : 0;
      for (const pts of ind.lines(candles)) {
        const s = chart.addSeries(LW.LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: ind.place === 'pane', crosshairMarkerVisible: false }, where);
        s.setData(pts);
        lines.push(s);
      }
    }
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(70);
  }
  function draw() {
    const last = candles[candles.length - 1];
    const fmt = priceFormat(last ? last.c : 1);
    candle.applyOptions({ priceFormat: fmt, visible: kind === 'candles' });
    line.applyOptions({ priceFormat: fmt, visible: kind === 'line' });
    candle.setData(barsOf(candles));
    line.setData(closesOf(candles, now));
    byTime.clear();
    for (const c of candles) byTime.set(c.t, c);
    drawIndicators();
    // Fit the view to the range when it changes, not at every repaint, so a zoom holds.
    const key = candles.length ? candles[0].t + ':' + candles.length : '';
    if (key !== fitKey) { fitKey = key; chart.timeScale().fitContent(); }
  }
  return {
    chart,
    setCandles(c, nowSec, range) {
      now = nowSec || Math.floor(Date.now() / 1000);
      const r = range || rangeOf('1M');
      candles = fillCandles(c || [], r.interval, r.span ? now - r.span : 0, now);
      draw();
    },
    setType(t) { kind = t === 'line' ? 'line' : 'candles'; candle.applyOptions({ visible: kind === 'candles' }); line.applyOptions({ visible: kind === 'line' }); },
    setIndicators(keys) { shown.clear(); for (const k of keys) shown.add(k); drawIndicators(); },
    indicators() { return new Set(shown); },
    onHover(fn) { chart.subscribeCrosshairMove((e) => fn(e && e.time != null ? byTime.get(e.time) || null : null)); },
    remove() { chart.remove(); },
  };
}

// A book's depth in `el`, price along the bottom. Returns { setBook(bids, asks), remove() }.
export function createDepthChart(LW, el) {
  const chart = LW.createOptionsChart(el, baseOptions({
    timeScale: { borderColor: COLORS.border },
    rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.1, bottom: 0 } },
  }));
  const area = (c, rgb) => chart.addSeries(LW.AreaSeries, { lineColor: c, topColor: `rgba(${rgb},.35)`, bottomColor: `rgba(${rgb},.03)`, lineType: LW.LineType.WithSteps, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  const bidS = area(COLORS.buy, '61,220,132'), askS = area(COLORS.sell, '240,163,94');
  return {
    chart,
    setBook(bids, asks) {
      const d = depthSeries(bids, asks);
      const most = Math.max(1e-12, ...d.bids.map((p) => p.value), ...d.asks.map((p) => p.value));
      const amt = priceFormat(most);
      bidS.applyOptions({ priceFormat: amt }); askS.applyOptions({ priceFormat: amt });
      bidS.setData(d.bids); askS.setData(d.asks);
      chart.timeScale().fitContent();
      return d;
    },
    remove() { chart.remove(); },
  };
}

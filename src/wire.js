// BigInt never crosses the message boundary (extension messages are JSON). A value that holds
// one is sent as { $big: '<digits>' } and read back on the other side.
export function toWire(v) {
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = toWire(x);
    return o;
  }
  return v;
}
export function fromWire(v) {
  if (Array.isArray(v)) return v.map(fromWire);
  if (v && typeof v === 'object') {
    if (typeof v.$big === 'string' && Object.keys(v).length === 1) return BigInt(v.$big);
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = fromWire(x);
    return o;
  }
  return v;
}

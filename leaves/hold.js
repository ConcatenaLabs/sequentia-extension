// The leaf wallet's pause through the site's hold (the node route's /hold): a synchronous request
// that the site keeps open for the time asked and then answers 204, so a worker blocked in a pause
// waits in the network stack and costs the browser nothing. Used by leaves/worker.js, which hands
// it to the library (`setPause`).
//
// `site.url` is the hold's address, or null: the library then waits on the clock. Set to null,
// for good, by an answer that shows this site has no working hold: anything but a hold or a
// refusal for the moment (a 404 where there is no such path), and a 204 that comes back in well
// under the time asked (under half of it, when more than 100 ms was asked), which a broken or
// replaced route gives, and which would otherwise send requests back to back for the whole
// pause. A 400 is this request's fault (a time the route does not take), never the site's: the
// rest of that pause is waited on the clock and the hold is kept.
export const HOLD_SHORT_FROM_MS = 100

// The most one request asks the hold for: the node route holds a request 30 s at most and refuses
// more (400), so a longer pause is asked for in parts.
export const HOLD_MOST_MS = 25_000

export function holdThrough (site, ms, { Xhr = globalThis.XMLHttpRequest, now = () => Date.now() } = {}) {
  const until = now() + ms
  for (;;) {
    const rest = Math.ceil(until - now())
    if (!site.url || rest <= 5) return
    const left = Math.min(rest, HOLD_MOST_MS)
    const x = new Xhr()
    const asked = now()
    try {
      x.open('GET', site.url + '?ms=' + left, false)
      x.timeout = left + 5000
      x.send()
    } catch { return }
    if (x.status === 204) {
      const took = now() - asked
      if (left > HOLD_SHORT_FROM_MS && took < left / 2) { site.url = null; return }
      continue
    }
    if (x.status !== 400 && x.status !== 429 && x.status !== 502 && x.status !== 503) site.url = null
    return
  }
}

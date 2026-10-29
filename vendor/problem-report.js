// Report a problem: a tester describes what happened and the wallet sends it to
// Emissio's intake (POST /emissio/api/problem-reports, contract in Emissio's
// README, "Problem-report intake"), with its version, its mode and its recent
// errors. The same module and words are in Ambra browser; Ambra mobile carries
// them in Dart. Change them together (docs/DEFAULT_MODE.md, "Report a problem").
//
// What leaves the wallet is exactly the payload `buildReport` returns, and the
// form shows it before it is sent. It never holds the recovery phrase or a key:
// errors are scrubbed of anything shaped like an address, a key, an invoice or a
// long hex string before they are kept, and a description that carries words of
// the wallet's own phrase is refused. Addresses go only when the person ticks
// the box that lists them.

export const REPORT_URL = 'https://sequentiatestnet.com/emissio/api/problem-reports'

export const REPORT_WORDS = Object.freeze({
  title: 'Report a problem',
  intro: 'Tell us what went wrong. Reports help fix the testnet before more people use it.',
  descriptionLabel: 'What happened?',
  descriptionHint: 'What you did, what you expected, and what happened instead.',
  codeLabel: 'Emissio account code (optional)',
  codeHint: 'Paste it to be credited if the report is accepted.',
  includes: 'The report includes this wallet\'s version, its mode and its recent errors. It never includes your recovery phrase or your keys.',
  addressesBox: 'Also send my address',
  addressesWill: 'This address will be sent:',
  preview: 'What will be sent',
  send: 'Send report',
  sending: 'Sending…',
  sent: (id) => id == null ? 'Report sent. Thank you.' : `Report sent. Its number is #${id}. Thank you.`,
  credited: 'If it is accepted, it is credited to your Emissio account.',
  codeUnknown: 'That account code was not found, so the report was sent without it.',
  needDescription: 'Describe what happened.',
  phrase: 'This looks like your recovery phrase. Never share it with anyone: remove it, then send again.',
  already: 'This report was already sent.',
  tooMany: 'Too many reports from here. Try again later.',
  tooLarge: 'This report is too long. Shorten it, then send again.',
  failed: 'The report could not be sent. Check your connection and try again.',
})

export const LIMITS = Object.freeze({ description: 4000, errors: 20, errorMessage: 500, context: 300, version: 40, addresses: 20, address: 120 })

// Anything shaped like a secret or an identifier of the person's coins.
const SCRUBS = [
  // Long hex: private keys, txids, blinding keys.
  [/\b[0-9a-fA-F]{32,}\b/g, '[hex]'],
  // bech32 / blech32 strings: addresses, invoices, encoded keys (a prefix, "1", the data).
  [/\b[a-z0-9]{1,40}1[02-9ac-hj-np-z]{20,}\b/gi, '[address]'],
  // base58 strings: legacy addresses, WIF keys, extended keys.
  [/\b[1-9A-HJ-NP-Za-km-z]{25,}\b/g, '[key]'],
]
export function scrub (text) {
  let t = String(text ?? '')
  for (const [re, by] of SCRUBS) t = t.replace(re, by)
  return t
}

// True when `text` carries three or more consecutive words of the phrase, in order.
export function carriesPhrase (text, phrase) {
  const words = String(phrase || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length < 3) return false
  const said = String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  for (let i = 0; i + 3 <= words.length; i++) {
    const run = words.slice(i, i + 3)
    for (let j = 0; j + 3 <= said.length; j++) {
      if (said[j] === run[0] && said[j + 1] === run[1] && said[j + 2] === run[2]) return true
    }
  }
  return false
}

// The wallet's recent errors: the last `limit`, scrubbed, a repeat of the newest folded in.
export function createErrorLog (limit = LIMITS.errors) {
  const items = []
  const note = (message, at = new Date()) => {
    const m = scrub(message instanceof Error ? message.message : message).slice(0, LIMITS.errorMessage).trim()
    if (!m) return
    const last = items[items.length - 1]
    if (last && last.message === m) { last.at = at.toISOString(); return }
    items.push({ at: at.toISOString(), message: m })
    if (items.length > limit) items.shift()
  }
  // Uncaught errors, rejected promises and console.error, as they happen.
  const install = (win, con) => {
    win.addEventListener('error', (e) => note(e.error || e.message))
    win.addEventListener('unhandledrejection', (e) => note(e.reason))
    if (con && typeof con.error === 'function') {
      const orig = con.error.bind(con)
      con.error = (...args) => { try { note(args.map((a) => a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) } catch {} orig(...args) }
    }
  }
  return { note, install, list: () => items.map((e) => ({ ...e })) }
}

const cut = (s, n) => String(s ?? '').trim().slice(0, n)

// The payload of one report, exactly as it is sent.
export function buildReport ({ wallet, version, mode, description, accountCode, errors = [], context = {}, addresses = [] }) {
  const report = {
    v: 1,
    wallet,
    version: cut(version, LIMITS.version),
    mode: mode === 'developer' ? 'developer' : 'default',
    description: cut(description, LIMITS.description),
  }
  const code = cut(accountCode, 64)
  if (code) report.account_code = code
  report.errors = errors.slice(-LIMITS.errors).map((e) => ({ at: e.at, message: cut(scrub(e.message), LIMITS.errorMessage) }))
  const ctx = {}
  for (const [k, v] of Object.entries(context)) if (v != null && v !== '') ctx[k] = cut(v, LIMITS.context)
  if (Object.keys(ctx).length) report.context = ctx
  const addrs = addresses.filter(Boolean).slice(0, LIMITS.addresses).map((a) => cut(a, LIMITS.address))
  if (addrs.length) report.attached = { addresses: addrs }
  return report
}

// Checks before sending: one sentence, or null when the report may go.
export function refusal (report, phrase) {
  if (!report.description) return REPORT_WORDS.needDescription
  if (carriesPhrase(report.description, phrase) || carriesPhrase(report.account_code, phrase)) return REPORT_WORDS.phrase
  return null
}

// Sends one report. Resolves to { ok: true, id, account } or { ok: false, message }, the
// message in this wallet's words whatever the service answered.
export async function sendReport (report, { url = REPORT_URL, fetchImpl = globalThis.fetch } = {}) {
  let r
  try {
    r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })
  } catch {
    return { ok: false, message: REPORT_WORDS.failed }
  }
  if (r.status === 201) {
    let body = {}
    try { body = await r.json() } catch {}
    return { ok: true, id: body.id, account: body.account || 'none' }
  }
  const message = r.status === 409 ? REPORT_WORDS.already
    : r.status === 429 ? REPORT_WORDS.tooMany
      : r.status === 413 ? REPORT_WORDS.tooLarge
        : r.status === 400 && !report.description ? REPORT_WORDS.needDescription
          : REPORT_WORDS.failed
  return { ok: false, message }
}

// The sentence shown once a report is sent.
export function sentWords ({ id, account }) {
  const s = [REPORT_WORDS.sent(id)]
  if (account === 'linked') s.push(REPORT_WORDS.credited)
  if (account === 'unknown') s.push(REPORT_WORDS.codeUnknown)
  return s.join(' ')
}

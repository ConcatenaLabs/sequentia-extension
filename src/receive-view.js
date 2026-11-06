// What default mode's Receive shows around the picture, from the service worker's answer
// (src/default-mode.js receiveCode): the web wallet's words (docs/DEFAULT_MODE.md, Receive),
// never rewritten here. With a payment name and no amount the picture is the name, with a line
// saying names are public, Copy name and Show full code, and no New code (every payer gets a new
// code anyway); the full code then offers Show name back. No DOM: test/receive-view.test.mjs.
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { NAME_WORDS } from '../vendor/lnaddr.js';

// r: { isCode, isName?, named? }; full: the person asked for the full code.
// -> { label, tip, copy, newCode, toggle, publicLine }
export function receiveView(r, { full = false } = {}) {
  if (r && r.isName) {
    return { label: NAME_WORDS.label, tip: NAME_WORDS.qrTip, copy: NAME_WORDS.copyName, newCode: false,
      toggle: NAME_WORDS.showFull, publicLine: NAME_WORDS.public };
  }
  const code = !!(r && r.isCode);
  return { label: code ? DEFAULT_WORDS.codeLabel : 'Receive', tip: code && r.named && full ? NAME_WORDS.fullTip : null,
    copy: code ? DEFAULT_WORDS.copyCode : 'Copy', newCode: true,
    toggle: r && r.named && full ? NAME_WORDS.showName : null, publicLine: null };
}

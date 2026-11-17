// What default mode's Receive shows around the picture, from the service worker's answer
// (src/default-mode.js receiveCode): the web wallet's words (docs/DEFAULT_MODE.md, Receive),
// never rewritten here. The card is the picture, one line and Copy; with a payment name and no
// amount the picture is the name, and the full code's text is shown only when asked for ("Show
// full code"). No DOM: test/receive-view.test.mjs.
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { NAME_WORDS } from '../vendor/lnaddr.js';

// Whether a payment name is shown, and put in the QR code: while the name service answers and has
// said this wallet's key holds it. A name it cannot be reached at, or one kept from before and not
// confirmed yet since the wallet opened (it may have been released or changed on another device), is
// not shown: payers could not look it up, and the code stands in. `nm` is the offscreen document's
// answer: { name, verified, unreachable, ... }.
export const nameShown = (nm) => !!(nm && nm.name && nm.verified && !nm.unreachable);

// r: the last answer ({ isCode, isName?, named?, shown?, nameText? }) or null while it is asked for.
// full: the person asked for the full code; conf: the Confidential switch is on; amount: an amount is asked for.
// -> { line, codeText, toggle, settingsLine }
//    line          the one line under the picture
//    codeText      the full code's text, only when asked for with a name held
//    toggle        "Show full code" or "Show name", with a name held and no amount or confidential
//    settingsLine  where the name is changed, inside More options
export function receiveView(r, { full = false, conf = false, amount = false } = {}) {
  const named = !!(r && r.named) && !conf;
  let line = DEFAULT_WORDS.receiveLine;
  if (conf) line = DEFAULT_WORDS.receiveTipConf;
  else if (full && named) line = NAME_WORDS.fullTip;
  else if (!r) line = DEFAULT_WORDS.receiveWait;
  return {
    line,
    codeText: full && named && r && !r.isName ? (r.shown || r.code) : null,
    toggle: named && !amount ? (full ? NAME_WORDS.showName : NAME_WORDS.showFull) : null,
    settingsLine: r && r.named && r.nameText ? NAME_WORDS.settingsLine(r.nameText) : null,
  };
}

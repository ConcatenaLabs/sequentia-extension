// What a website may ask this wallet to sign under the OpenAMP enclave key.
//
// The enclave key is one half of the 2-of-2 that restricted assets live in, so
// a party who could choose the 32 bytes it signs would hold a signing oracle
// over transfer sighashes and could drain the account. Every statement this
// wallet signs for a site is therefore signed TAGGED: the message it actually
// signs is sha256(sha256(tag) || sha256(tag) || message). A taproot sighash is
// the same construction under the tag "TapSighash", so producing one under any
// other tag is a preimage problem rather than a matter of choosing the input.
//
// The guarantee rests entirely on the tag never being a consensus tag, which is
// what this module enforces. It also refuses anything the approval window could
// not show the user honestly: against a statement that is perfectly safe to
// sign but means something the user did not intend, the defence is reading it,
// and a statement that cannot be rendered cannot be read.
//
// Kept free of any wasm or extension import so it is unit-testable on its own.

// Tags that name a digest some consensus or signing rule already computes.
// Prefixes rather than exact names, with margin: "tap" covers TapSighash,
// TapLeaf, TapBranch and TapTweak, and anything else the taproot rules grow.
// A legitimate application tag that happens to start with one of these is
// collateral damage, and cheap: it renames itself. Signing under one of these
// by mistake is not cheap.
//
// "sequentia/" is reserved for the same reason one step removed: the node's own
// tags live there (Sequentia/SupervisionRecord and friends), and a message under
// one of those is a consensus instruction rather than a statement about the
// world. Those are produced only by openampSignSpend's supervision sibling,
// which rebuilds the message from fields it can show the user. A site cannot
// reach them through the generic signer.
const RESERVED_PREFIXES = ['tap', 'bip0340', 'bip340', 'bip322', 'elements', 'sequentia/'];

// The OpenAMP policy server acts on statements under its own "openamp-" tags:
// "openamp-cosign-v1" is a holder's request for a co-sign, "openamp-dvp-v1" a
// trade's expiry, and later ones will follow. One such signature obtained by a
// site would let it act as the holder towards the policy server (reopening a
// trade the holder let expire), so a site may have only the two statements the
// integration spec gives it: a login challenge and a document hash. The wallet
// makes the others in its own flows, never because a site asked.
const OPENAMP_PREFIX = 'openamp-';
const OPENAMP_FOR_SITES = ['openamp-challenge-v1', 'openamp-document-v1'];
const RESERVED_SUBSTRINGS = ['sighash'];

const MAX_TAG = 64;
const MAX_STATEMENT = 4096;

// Printable ASCII, no spaces: a tag is an identifier, never prose.
function tagWellFormed(tag) {
  if (typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG) return false;
  for (const ch of tag) {
    const c = ch.codePointAt(0);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

// Anything a human can read in the approval window: printable text plus the
// whitespace that formats it. Control characters are refused because they can
// hide the part of a statement the user would have objected to.
function statementRenderable(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// Validate one site signing request and return what the signer needs:
// { tag, messageHex, kind } where kind is 'statement' or 'hash'.
//
// Exactly one of `statement` (UTF-8 text, signed as its own bytes) and `hash`
// (a 32-byte content address, signed as those raw bytes) may be given. Both
// forms exist in the OpenAMP integration spec: a login challenge and a mandate
// are statements, an e-signature over a document is the document's hash.
export function checkSigningRequest({ tag, statement, hash } = {}) {
  if (!tagWellFormed(tag)) {
    throw new Error('a signing tag must be 1-64 printable characters with no spaces');
  }
  const lower = tag.toLowerCase();
  for (const p of RESERVED_PREFIXES) {
    if (lower.startsWith(p)) throw new Error('refusing to sign under the reserved tag "' + tag + '"');
  }
  for (const sub of RESERVED_SUBSTRINGS) {
    if (lower.includes(sub)) throw new Error('refusing to sign under the reserved tag "' + tag + '"');
  }
  if (lower.startsWith(OPENAMP_PREFIX) && !OPENAMP_FOR_SITES.includes(tag)) {
    throw new Error('refusing to sign under the OpenAMP protocol tag "' + tag +
      '": a site may ask only for ' + OPENAMP_FOR_SITES.join(' or '));
  }

  const hasStatement = statement !== undefined && statement !== null;
  const hasHash = hash !== undefined && hash !== null;
  if (hasStatement === hasHash) {
    throw new Error('give exactly one of statement or hash');
  }

  if (hasHash) {
    const h = String(hash);
    if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('hash must be a 32-byte hex digest');
    return { tag, messageHex: h.toLowerCase(), kind: 'hash' };
  }

  const s = String(statement);
  if (s.length === 0 || s.length > MAX_STATEMENT) {
    throw new Error('a statement must be 1-' + MAX_STATEMENT + ' characters');
  }
  if (!statementRenderable(s)) {
    throw new Error('a statement must be readable text; control characters are refused');
  }
  return { tag, messageHex: toHex(new TextEncoder().encode(s)), kind: 'statement' };
}

export const _policy = { RESERVED_PREFIXES, RESERVED_SUBSTRINGS, OPENAMP_FOR_SITES, MAX_TAG, MAX_STATEMENT };

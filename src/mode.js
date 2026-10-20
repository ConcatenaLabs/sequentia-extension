// The wallet's mode: one setting, kept for each wallet, 'user' until the user changes it.
//
// User mode is one figure per asset, and the wallet chooses how value moves. Developer
// mode names every rail (on-chain, leaves, Lightning) side by side, each with its
// balance and its manual controls, and shows the developer tools. Sites read the mode
// through the provider (`getWalletMode`, `modeChanged`) and follow it.
//
// The words are the same in every Sequentia wallet (the web wallet, this extension and
// Ambra): change them in all three together.
//
// A wallet is told apart by its tag, the same one the web wallet uses: a 32-bit FNV-1a
// of its descriptor, public and never key material. The tag of the wallet last opened
// is kept so the mode reads while the wallet is locked.

import { stGet, stSet } from './util.js';

export const MODE_WORDS = Object.freeze({
  title: 'Mode',
  user: 'User mode',
  userLine: 'One figure per asset, and the wallet chooses how value moves.',
  developer: 'Developer mode',
  developerLine: 'Every rail by name, side by side (on-chain, leaves and Lightning), each with its balance and its manual controls, and the developer tools.',
  note: 'Kept for this wallet. Sites that ask the wallet for its mode follow it.',
});

const MODES_KEY = 'ext.modes';     // { [walletTag]: 'developer' | 'user' }
const TAG_KEY = 'ext.walletTag';   // the tag of the wallet last opened
const SETTINGS_KEY = 'ext.settings';

export function tagOf(descriptor) {
  const src = String(descriptor || '');
  if (!src) return null;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export async function walletTag() { return (await stGet('local', TAG_KEY)) || null; }

// Called when a wallet opens. A mode set before modes were kept per wallet becomes
// this wallet's, once.
export async function rememberWallet(tag) {
  if (!tag) return;
  await stSet('local', TAG_KEY, tag);
  const s = (await stGet('local', SETTINGS_KEY)) || {};
  if (s.mode) {
    const modes = (await stGet('local', MODES_KEY)) || {};
    if (!modes[tag]) modes[tag] = s.mode === 'developer' ? 'developer' : 'user';
    await stSet('local', MODES_KEY, modes);
    delete s.mode;
    await stSet('local', SETTINGS_KEY, s);
  }
}

export async function mode() {
  const tag = await walletTag();
  const modes = (await stGet('local', MODES_KEY)) || {};
  if (tag && modes[tag]) return modes[tag] === 'developer' ? 'developer' : 'user';
  const s = (await stGet('local', SETTINGS_KEY)) || {};
  return s.mode === 'developer' ? 'developer' : 'user';
}

export async function setMode(m) {
  if (m !== 'developer' && m !== 'user') throw new Error("the mode is 'developer' or 'user'");
  const tag = await walletTag();
  if (!tag) throw new Error('open the wallet first: the mode is kept for each wallet');
  const modes = (await stGet('local', MODES_KEY)) || {};
  modes[tag] = m;
  await stSet('local', MODES_KEY, modes);
  return m;
}

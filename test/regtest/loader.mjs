// Module hooks that point the extension at a private regtest chain: config.js
// gets the shim's endpoints and the chain's records-v2 height, and the engine
// opens the chain's own network instead of the testnet's. Each rewrite must
// match exactly once, so a changed source fails the run instead of silently
// talking to the public testnet.

let cfg = null;
export async function initialize(data) { cfg = data; }

function replaceOnce(src, from, to, file) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`regtest loader: expected one "${from}" in ${file}, found ${n}`);
  return src.replace(from, to);
}

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (url.endsWith('/src/config.js')) {
    let s = String(r.source);
    s = replaceOnce(s, "export const BASE = 'https://sequentiatestnet.com';", `export const BASE = ${JSON.stringify(cfg.base)};`, url);
    s = replaceOnce(s, "export const T4_API = BASE + '/testnet4/api';", `export const T4_API = ${JSON.stringify(cfg.t4)};`, url);
    s = replaceOnce(s, 'export const RECORDS_V2_HEIGHT = null;', `export const RECORDS_V2_HEIGHT = ${JSON.stringify(cfg.recordsV2Height)};`, url);
    return { ...r, source: s };
  }
  if (url.endsWith('/src/engine.js')) {
    const s = replaceOnce(String(r.source), 'network = Network.sequentiaTestnet();',
      `network = Network.regtestWithGenesis(new AssetId(${JSON.stringify(cfg.policyAsset)}), ${JSON.stringify(cfg.genesis)});`, url);
    return { ...r, source: s };
  }
  return r;
}

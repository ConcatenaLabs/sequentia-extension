// The chain's genesis hash, which names the pairs default mode admits (user-mode/pairs.json is
// keyed by it). Asked of the chain's esplora, as the web wallet and Ambra do, so the Trade tab never
// waits on the leaf wallet, whose one worker runs its commands one at a time; the leaf wallet's
// `info` only when esplora does not answer. Each read is bounded in time.
const HEX64 = /^[0-9a-f]{64}$/;

export async function chainGenesis({ esplora, info, fetchFn = fetch, timeoutMs = 20_000 } = {}) {
  try {
    const r = await fetchFn(esplora + '/block-height/0', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const h = r.ok ? String(await r.text()).trim() : '';
    if (HEX64.test(h)) return h;
  } catch { /* esplora did not answer: the leaf wallet's word */ }
  if (!info) return null;
  let timer;
  try {
    const g = await Promise.race([info(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), timeoutMs); })]);
    const h = String((g && g.genesis_hash) || '').trim();
    return HEX64.test(h) ? h : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// The offscreen document (offscreen.html): the one page of this extension that
// outlives the service worker's idle clocks. It runs the long Lightning jobs and
// the leaf wallet. There is at most one per extension; every caller shares it
// through ensureOffscreen.

// One bring-up at a time: two callers at once (an unlock and a site's request) would
// otherwise each find the document still loading, and the second would close the one
// the first was creating ("Offscreen document closed before fully loading").
let bringingUp = null;
export function ensureOffscreen() {
  if (!bringingUp) bringingUp = bringUp().finally(() => { bringingUp = null; });
  return bringingUp;
}

async function bringUp() {
  // REUSE a live document whenever it answers the hello handshake with the
  // current build version: the document holds the warm Lightning signer wss
  // links, and recreating it per swap forced a full node bring-up every time
  // (the bulk of a 24s swap). A silent or version-skewed document — the stale-
  // code hazard the old always-recreate policy guarded against — is torn down
  // and rebuilt.
  const version = chrome.runtime.getManifest().version;
  try {
    const r = await chrome.runtime.sendMessage({ scope: 'oln', op: 'hello' });
    if (r && r.version === version) return;
  } catch {}
  try { await chrome.offscreen.closeDocument(); } catch {}
  await chrome.offscreen.createDocument({
    url: 'offscreen.html?v=' + encodeURIComponent(version),
    reasons: ['WORKERS'],
    justification: 'Long-lived Lightning signer sessions and the leaf wallet outlive service worker limits',
  });
  // The loader imports the engine asynchronously; dispatching before its
  // listener exists dies with "receiving end does not exist". Wait for hello.
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await chrome.runtime.sendMessage({ scope: 'oln', op: 'hello' });
      if (r && r.version === version) return;
    } catch {}
    if (Date.now() - t0 > 15_000) throw new Error('the wallet engine did not come up');
    await new Promise((res) => setTimeout(res, 250));
  }
}

// Whether the document is up now, without bringing it up.
export async function offscreenUp() {
  try { return !!(await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length; } catch { return false; }
}

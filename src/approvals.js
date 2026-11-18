// The approvals a site's request waits on: one tab each (approval/approval.html), settled by the
// person's decision, by the five-minute limit, by the tab failing to open, by the person closing
// the tab, or by the site going away (its last port to the wallet gone). However it is settled, the
// request's own promise settles with it, so whatever the request holds until then (a swap offer's
// coins, its slot: src/leaf-swap.js) is let go by the request's own catch and finally.
//
//   requestApproval(origin, method, display, exec) -> exec's answer once approved, else a refusal
//   decideApproval(id, approve, shown)             the approval page's decision
//   approvalTabClosed(tabId)                       chrome.tabs.onRemoved: the tab was closed
//   originGone(origin)                             the site's last port disconnected
//   pendingApproval(id), anyPendingApproval()      what the approval page shows

const pending = new Map();
let reqSeq = 0;
export const APPROVAL_MS = 300_000;
export const TAB_CLOSED = 'the approval window was closed';
export const SITE_GONE = 'the site that asked is gone';

function newRequestId() { return 'req' + (++reqSeq) + '.' + Date.now(); }

export function pendingApproval(id) {
  const p = pending.get(id);
  if (!p) return null;
  return { id, origin: p.origin, method: p.method, display: p.display };
}
export function anyPendingApproval() {
  const first = pending.keys().next();
  return first.done ? null : pendingApproval(first.value);
}

// Approvals open as a regular TAB, not a floating popup window: on tiling /
// Wayland window managers (seen live on COSMIC) a popup created by a freshly
// reloaded service worker can land invisible, and an approval the user cannot
// see times out. A tab is always reachable from the tab strip.
async function openApprovalWindow(id) {
  return await chrome.tabs.create({
    url: chrome.runtime.getURL('approval/approval.html') + '?id=' + encodeURIComponent(id),
    active: true,
  });
}

// The request ends unapproved: taken out, its timer stopped, its promise refused.
function refuse(id, why) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.reject(new Error(why));
  return true;
}

// Ask the user. `display` is the serializable summary the approval page renders.
export function requestApproval(origin, method, display, exec) {
  // `exec(shown)` receives what the approval page says it showed (`decideApproval`).
  return new Promise((resolve, reject) => {
    const id = newRequestId();
    const p = { origin, method, display, exec, resolve, reject, at: Date.now(), tabId: null, timer: null };
    pending.set(id, p);
    // Expire abandoned approvals after 5 minutes.
    p.timer = setTimeout(() => refuse(id, 'approval timed out'), APPROVAL_MS);
    openApprovalWindow(id).then((tab) => {
      if (tab && tab.id != null) p.tabId = tab.id;
    }, (e) => refuse(id, 'could not open the approval window: ' + (e?.message ?? e)));
  });
}

// The approval page decided. On approve the operation runs asynchronously:
// the approval tab closes immediately (no "Working…" purgatory, and its own
// message channel cannot outlive Chrome's cap anyway); the outcome flows to
// the requesting page over the port channel.
export async function decideApproval(id, approve, shown = null) {
  const p = pending.get(id);
  if (!p) throw new Error('this request has expired');
  if (!approve) { refuse(id, 'the user rejected the request'); return { done: true }; }
  pending.delete(id);
  clearTimeout(p.timer);
  (async () => {
    try { p.resolve(await p.exec(shown)); }
    catch (e) { p.reject(e instanceof Error ? e : new Error(String(e))); }
  })();
  return { done: true };
}

// The person closed an approval's tab without deciding: refused, as a rejection is. (The page
// closes itself after a decision, by which time the request is no longer waiting.)
export function approvalTabClosed(tabId) {
  let n = 0;
  for (const [id, p] of [...pending]) if (p.tabId === tabId && refuse(id, TAB_CLOSED)) n++;
  return n;
}

// The site that asked has no port to the wallet left (its tabs closed or navigated away): every
// approval it waits on is refused, so nothing it asked for holds anything for the five minutes.
export function originGone(origin) {
  let n = 0;
  for (const [id, p] of [...pending]) if (p.origin === origin && refuse(id, SITE_GONE)) n++;
  return n;
}

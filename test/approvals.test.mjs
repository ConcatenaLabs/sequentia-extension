// The approvals a site's request waits on (src/approvals.js), and a swap offer's slot let go however
// its approval ends: the person closing the approval's tab, or the site's last port going, refuses
// the request as a rejection does, at once rather than after the five minutes
// (sequentia-extension#224, the review of #226).
//   node --test test/approvals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let tabSeq = 100;
const opened = [];
globalThis.chrome = {
  runtime: { getURL: (p) => 'chrome-extension://x/' + p },
  tabs: { create: async (o) => { const tab = { id: ++tabSeq, url: o.url }; opened.push(tab); return tab; } },
};
const A = await import('../src/approvals.js');
const { takeOfferSlot, OFFER_WAITS } = await import('../src/leaf-swap.js');
const settle = () => new Promise((r) => setImmediate(r));

// The provider's leafSwapOffer, as it is written: the slot, the offer, the approval, the cancel on
// a refusal, the slot let go in finally.
function offer(origin, log) {
  const slot = takeOfferSlot(origin);
  return (async () => {
    try {
      log.push('offer');
      try {
        return await A.requestApproval(origin, 'leafSwapOffer', { text: 'offer' }, async () => 'approved');
      } catch (e) {
        log.push('cancel: ' + e.message);
        throw e;
      }
    } finally { slot.release(); log.push('released'); }
  })();
}

test('closing the approval\'s tab refuses the request at once: the offer is cancelled and its slot let go', async () => {
  const log = [];
  const p = offer('https://a.example', log);
  await settle();
  const tab = opened.at(-1);
  assert.ok(A.anyPendingApproval(), 'waiting for the person');
  assert.throws(() => takeOfferSlot('https://a.example'), (e) => e.message === OFFER_WAITS);
  assert.equal(A.approvalTabClosed(tab.id + 1000), 0, 'another tab closed: nothing');
  assert.equal(A.approvalTabClosed(tab.id), 1);
  await assert.rejects(p, (e) => e.message === A.TAB_CLOSED);
  assert.deepEqual(log, ['offer', 'cancel: ' + A.TAB_CLOSED, 'released']);
  assert.equal(A.anyPendingApproval(), null);
  takeOfferSlot('https://a.example').release();
});

test('the site\'s last port going refuses what it waits on, and only its own', async () => {
  const la = [], lb = [];
  const a = offer('https://a.example', la);
  const b = offer('https://b.example', lb);
  await settle();
  assert.equal(A.originGone('https://a.example'), 1);
  await assert.rejects(a, (e) => e.message === A.SITE_GONE);
  assert.deepEqual(la, ['offer', 'cancel: ' + A.SITE_GONE, 'released']);
  assert.ok(A.anyPendingApproval(), 'the other site\'s still waits');
  assert.equal(lb.length, 1);
  // The other one's decision still works as before; a decision after the end is refused.
  const id = A.anyPendingApproval().id;
  await A.decideApproval(id, true);
  assert.equal(await b, 'approved');
  assert.deepEqual(lb, ['offer', 'released']);
  await assert.rejects(A.decideApproval(id, false), /expired/);
  assert.equal(A.originGone('https://a.example'), 0);
});

test('a rejection, and a tab that cannot open, end it as before', async () => {
  const log = [];
  const p = offer('https://c.example', log);
  await settle();
  await A.decideApproval(A.anyPendingApproval().id, false);
  await assert.rejects(p, /rejected/);
  assert.deepEqual(log, ['offer', 'cancel: the user rejected the request', 'released']);
  const create = chrome.tabs.create;
  chrome.tabs.create = async () => { throw new Error('no window'); };
  const l2 = [];
  await assert.rejects(offer('https://c.example', l2), /could not open the approval window/);
  assert.deepEqual(l2.at(-1), 'released');
  chrome.tabs.create = create;
});

test('the service worker refuses approvals when a tab closes and when a site\'s last port goes', () => {
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(bg, /chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{ router\.approvalTabClosed\(tabId\); \}\)/);
  assert.match(bg, /if \(s\) \{ s\.delete\(port\); if \(!s\.size\) dappPorts\.delete\(origin\); \}\n[\s\S]{0,300}if \(!dappPorts\.has\(origin\)\) router\.originGone\(origin\);/);
  const pr = readFileSync(new URL('../src/provider-router.js', import.meta.url), 'utf8');
  assert.match(pr, /export \{ pendingApproval, anyPendingApproval, decideApproval, approvalTabClosed, originGone \} from '\.\/approvals\.js';/);
  assert.match(pr, /const o = await leaves\.run\('swap_offer', args, \{ origin \}\);/, 'the offer is the site\'s, before approval');
  assert.match(pr, /await leaves\.run\('swap_cancel', \{ swap: o\.swap \}\)\.catch/, 'its cancel the person\'s');
});

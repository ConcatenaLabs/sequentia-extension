// A read of the leaf library for a caller that both draws figures at once and acts on what it read:
// the Lightning-to-ark move reads the leaf wallet's coins for every figure of the overview (its
// `liveMoving`, which cannot wait) and in its pass (`setMoving`, whose answer decides what is still
// moving and which emptied channel to close). Every figure once sent the library a command and
// nobody waited for it; on a wallet open for hours the line in front of the library grew faster than
// it could answer and every other command waited behind it (sequentia-extension#219).
//
//   keptRead(read, { freshMs, now }) -> { peek(), current() }
//     read()     -> a promise of the answer (one command of the library)
//     peek()     at once, never throws: the last answer while it is under `freshMs` old, else null
//                (a caller that cannot wait treats null as no reading); when it has none fresh it
//                starts a read for the next peek, never a second beside one under way. A refused
//                read only leaves the peek without a fresh answer.
//     current()  a read now, for a caller that acts on it: its answer, or its refusal thrown, never
//                an old or an empty answer in its place.
//
//   figureReads(kept) -> { read(), drawing(f) }
//     read()      the peek while a figure is drawn (inside drawing(f)), the current read otherwise
//     drawing(f)  runs f (synchronous: a figure) with read() answering by the peek
export function keptRead(read, { freshMs = 5000, now = () => Date.now() } = {}) {
  let kept = null, at = -Infinity, under = null;
  function start() {
    let p;
    try { p = Promise.resolve(read()); } catch (e) { p = Promise.reject(e); }
    const q = p.then((v) => { kept = v; at = now(); return v; });
    under = q;
    q.then(() => {}, () => {}).then(() => { if (under === q) under = null; });
    return q;
  }
  return {
    peek() {
      if (kept !== null && now() - at < freshMs) return kept;
      if (!under) start().catch(() => {});
      return null;
    },
    current: () => start(),
  };
}

export function figureReads(kept) {
  let drawing = 0;
  return {
    read: () => (drawing ? kept.peek() : kept.current()),
    drawing(f) { drawing++; try { return f(); } finally { drawing--; } },
  };
}

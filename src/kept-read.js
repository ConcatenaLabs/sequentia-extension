// A read of the leaf library for a caller that wants its answer at once and asks it often (each
// figure of the overview): the last answer while it is fresh, else the one read under way, never a
// second beside it. Without it every figure sent the library a command and nobody waited for its
// answer; on a wallet open for hours the line in front of the library grew faster than it could
// answer and every other command waited behind it (sequentia-extension#219).
//
//   keptRead(read, { freshMs, now }) -> get()
//     read()  -> a promise of the answer (one command of the library)
//     get()   -> the last answer when it is under `freshMs` old; else the promise of the read under
//                way (started now when none is), which a caller that cannot wait sees as no answer
//                yet. A read that fails leaves the last answer as it was.
export function keptRead(read, { freshMs = 5000, now = () => Date.now() } = {}) {
  let kept = null, at = -Infinity, under = null;
  return function get() {
    if (kept !== null && now() - at < freshMs) return kept;
    if (!under) {
      let p;
      try { p = Promise.resolve(read()); } catch (e) { p = Promise.reject(e); }
      under = p.then((v) => { kept = v; at = now(); return v; }, () => kept).finally(() => { under = null; });
    }
    return under;
  };
}

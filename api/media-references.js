/**
 * Backend-neutral reference discovery for media kept by openGym.
 * Used by Node/Docker and Cloudflare. The frontend uses the same canonical
 * api/test/fixtures/media-refs.json cases.
 */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Every blob a state refers to: customEx[].media.hash and .poster.hash, and the same two of every
 * entry of workouts[].media (the photos and videos of a logged workout) and of every set's own
 * media list, workouts[].entries[].sets[].media (a form video filmed for that set). Deliberately loose —
 * each field counts on its own as long as it is a well-formed hash, even when the rest of the ref
 * would not pass the client's normalizeMediaRef, and a workout's list counts past the client's
 * cap of six. This set decides what is KEPT, so erring towards more is the safe direction.
 * `active` is not walked: PUT /api/data drops it before the state is stored.
 * frontend/src/lib/media-refs.js has to agree with it; api/test/fixtures/media-refs.json pins
 * both to the same answers.
 */
export function referencedHashes(state) {
  const out = new Set();
  if (!state || typeof state !== 'object') return out;
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const add = r => { if (r && typeof r === 'object' && typeof r.hash === 'string' && HASH_RE.test(r.hash)) out.add(r.hash); };
  const ref = m => { add(m); add(m.poster); };
  for (const c of Array.isArray(state.customEx) ? state.customEx : []) {
    if (isObj(c) && isObj(c.media)) ref(c.media);
  }
  for (const w of Array.isArray(state.workouts) ? state.workouts : []) {
    if (!isObj(w) || !Array.isArray(w.media)) continue;
    for (const m of w.media) if (isObj(m)) ref(m);
  }
  // A set's own form video (v1.4.4): every entry of every set's `media` list, by the same rule.
  for (const w of Array.isArray(state.workouts) ? state.workouts : []) {
    if (!isObj(w) || !Array.isArray(w.entries)) continue;
    for (const e of w.entries) {
      if (!isObj(e) || !Array.isArray(e.sets)) continue;
      for (const st of e.sets) if (isObj(st) && Array.isArray(st.media)) for (const m of st.media) if (isObj(m)) ref(m);
    }
  }
  // Progress photos filed under a day rather than a workout (frontend lib/day-photos.js):
  // dayPhotos[<hash>] = { d, m, _ts }, a cleared one only { _ts }.
  if (isObj(state.dayPhotos)) for (const e of Object.values(state.dayPhotos)) if (isObj(e) && isObj(e.m)) ref(e.m);
  return out;
}

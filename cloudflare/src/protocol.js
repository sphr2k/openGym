/**
 * The unmodified openGym iOS app understands these response shapes.
 * Changes must be checked against api/server.js and its node integration tests.
 */
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }
});

export const hex = bytes => Array.from(bytes).map(v => v.toString(16).padStart(2, "0")).join("");
export const randomHex = size => hex(crypto.getRandomValues(new Uint8Array(size)));
export const randomBase64url = size => Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString("base64url");

export function forClient(state) {
  if (!state || typeof state !== "object") return state;
  if (!("_unstamped" in state || "_prior" in state)) return state;
  const { _unstamped, _prior, ...rest } = state;
  return rest;
}

export function validateProfile(next) {
  if (!next || typeof next !== "object" ||
      (!Array.isArray(next) && !Object.keys(next).some(k => k !== "_rev" && k !== "_ts"))) {
    return { error: "state required", status: 400 };
  }
  const list = v => v == null || Array.isArray(v);
  if (Array.isArray(next) || !list(next.workouts) || !list(next.routines)) {
    return { error: "invalid state", status: 400 };
  }
  for (const k of ["workouts", "routines"]) {
    if (Array.isArray(next[k])) next[k] = next[k].filter(x => !!x && typeof x === "object" && !Array.isArray(x));
  }
  return null;
}

export const BODY_LIMIT = 5 * 1024 * 1024;
export async function jsonBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > BODY_LIMIT) return { error: json({ error: "body too large" }, 413) };
  let text;
  try { text = await request.text(); } catch { return { error: json({ error: "bad request" }, 400) }; }
  if (!text) return { value: {} };
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") || "")) {
    return { error: json({ error: "content-type must be application/json" }, 415) };
  }
  if (text.length > BODY_LIMIT) return { error: json({ error: "body too large" }, 413) };
  try { return { value: text ? JSON.parse(text) : {} }; }
  catch { return { error: json({ error: "invalid JSON" }, 400) }; }
}

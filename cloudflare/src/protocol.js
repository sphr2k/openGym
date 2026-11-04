import { MAX_JSON_BODY_BYTES } from "../../api/body-limits.js";
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

export const BODY_LIMIT = MAX_JSON_BODY_BYTES;

export async function jsonBody(request) {
  const declared=Number(request.headers.get("content-length")||0);
  if(declared>BODY_LIMIT)return {error:json({error:"body too large"},413)};

  // Never materialize an unbounded UTF-8 body. JS string.length counts UTF-16
  // code units, *not* bytes, and could admit an oversized emoji-heavy body.
  // TextDecoder(stream:true) preserves UTF-8 characters split across chunks.
  const parts=[],decoder=new TextDecoder("utf-8"),reader=request.body?.getReader();
  let bytes=0;
  try {
    if(reader)for(;;) {
      const {done,value}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>BODY_LIMIT){
        await reader.cancel().catch(()=>{});
        return {error:json({error:"body too large"},413)};
      }
      parts.push(decoder.decode(value,{stream:true}));
    }
  }catch{
    return {error:json({error:"bad request"},400)};
  }
  const content=parts.join("")+decoder.decode();
  if(!content)return {value:{}};
  if(!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type")||"")){
    return {error:json({error:"content-type must be application/json"},415)};
  }
  try{return {value:JSON.parse(content)};}
  catch{return {error:json({error:"invalid JSON"},400)};}
}

import { AccountDO } from "./accounts.js";
import { ProfileDO } from "./profile.js";
import { json, BODY_LIMIT } from "./protocol.js";

export { AccountDO, ProfileDO };
const MOBILE_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);
const ACCOUNT_ROUTES = new Set([
  "POST /api/register/options",
  "POST /api/register/verify",
  "POST /api/login/options",
  "POST /api/login/verify",
  "POST /api/pair/create",
  "POST /api/pair/redeem",
  "GET /api/me",
  "GET /api/account/passkeys",
  "POST /api/logout",
  "POST /api/logout/all"
]);
const PROFILE_ROUTES = new Set(["GET /api/data", "GET /api/data/rev", "PUT /api/data"]);

function account(env) {
  return env.ACCOUNTS.getByName("accounts");
}
function supportsOrigin(origin, own) {
  return origin === own || MOBILE_ORIGINS.has(origin);
}
function corsHeaders(origin, own, isPreflight) {
  if (!origin || !supportsOrigin(origin, own)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    ...(isPreflight ? {
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret",
      "Access-Control-Max-Age": "86400"
    } : {})
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    if (path.startsWith("/api/_internal/") || path.startsWith("/_internal/")) return json({error:"not found"},404);

    const origin = request.headers.get("origin");
    const ownOrigin = env.APP_ORIGIN || url.origin;
    const cors = corsHeaders(origin, ownOrigin, request.method === "OPTIONS");
    if (origin && !supportsOrigin(origin, ownOrigin)) return json({error:"cross-origin request refused",code:"origin-mismatch",expected:ownOrigin},403);
    if (request.method === "OPTIONS") {
      return new Response(null, { status:204, headers:cors });
    }

    const route = request.method + " " + path;
    const methodWrites = ["POST","PUT","PATCH","DELETE"].includes(request.method);
    if (methodWrites) {
      const size = Number(request.headers.get("content-length") || 0);
      if (size > BODY_LIMIT) return json({error:"body too large"},413);
      // Existing native apps use Authorization: Bearer and a separate origin.
      // Cookie-backed browser writes must come from our actual origin.
      const bearer = (request.headers.get("authorization") || "").startsWith("Bearer ");
      if (!bearer && origin && origin !== ownOrigin) {
        return json({error:"cross-origin request refused",code:"origin-mismatch",expected:ownOrigin},403);
      }
      if (!bearer && request.headers.get("sec-fetch-site") === "cross-site") {
        return json({error:"cross-origin request refused",code:"origin-mismatch",expected:ownOrigin},403);
      }
    }

    let response;
    try {
      if (route === "GET /api/health") {
        response = await account(env).fetch(new Request(new URL("/_internal/health",url), {method:"GET"}));
      } else if (route === "GET /api/config") {
        const allowGuest = !/^(false|0|off)$/i.test(String(env.ALLOW_GUEST ?? "true"));
        response = json({invite_only:false,allow_guest:allowGuest});
      } else if (ACCOUNT_ROUTES.has(route)) {
        response = await account(env).fetch(request);
      } else if (PROFILE_ROUTES.has(route)) {
        const auth = new Request(new URL("/_internal/resolve",url), {
          method:"POST",
          headers: {...Object.fromEntries(request.headers), "content-type": "application/json"},
          body: "{}"
        });
        const authAnswer = await account(env).fetch(auth);
        if (!authAnswer.ok) response = json({error:"not signed in"},401);
        else {
          const {id} = await authAnswer.json();
          response = await env.PROFILES.getByName("profile:" + id).fetch(request);
        }
      } else {
        response = json({error:"not found"},404);
      }
    } catch (error) {
      console.error("Cloudflare API request failed", error);
      response = json({error:"internal error"},500);
    }
    if (!origin || !supportsOrigin(origin, ownOrigin)) return response;
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([k,v])=>headers.set(k,v));
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};

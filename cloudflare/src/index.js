import { AccountDO } from "./accounts.js";
import { ProfileDO } from "./profile.js";
import { json, BODY_LIMIT } from "./protocol.js";
import { validNudgeDate, nudgeCheckStatus } from "../../api/nudge-check-status.js";
import { limits, mediaConfig } from "./media-validation.js";

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
  "POST /api/account/passkeys/options",
  "POST /api/account/passkeys/verify",
  "POST /api/account/device-link",
  "POST /api/device-link/options",
  "POST /api/device-link/verify",
  "POST /api/account/passkeys/rename",
  "DELETE /api/account/passkeys",
  "POST /api/account/delete",
  "POST /api/logout",
  "POST /api/logout/all"
]);
const PROFILE_ROUTES = new Set(["GET /api/data", "GET /api/data/rev", "PUT /api/data"]);
const NUDGE_ROUTE = "GET /api/nudge-check";
const MEDIA_ROUTE = /^\/api\/media\/(?:[0-9a-f]{64}|missing|sweep)$/;

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
    // Fail closed on an incomplete staging configuration; this control also
    // protects static assets and prevents anyone from registering publicly.
    // Do not enable it in the regular user-facing Worker deployment.
    if (env.STAGING_LOCKED === "true") {
      const supplied = request.headers.get("x-opengym-stage-key");
      if (typeof env.STAGING_API_KEY !== "string" ||
          !supplied || supplied !== env.STAGING_API_KEY) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
    }

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
      if (size > BODY_LIMIT && !(request.method==="PUT" && /^\/api\/media\/[0-9a-f]{64}$/.test(path))) return json({error:"body too large"},413);
      // Existing native apps use Authorization: Bearer and a separate origin.
      // Cookie-backed browser writes must come from our actual origin.
      const bearer = (request.headers.get("authorization") || "").startsWith("Bearer ");
      // The app must redeem its one-time pairing code BEFORE it has an openGym
      // bearer. Allow only the fixed Capacitor WebView origins for this route;
      // the one-time code remains the sole credential and is rate-limited.
      const mobilePairing = route === "POST /api/pair/redeem" && MOBILE_ORIGINS.has(origin);
      if (!bearer && !mobilePairing && origin && origin !== ownOrigin) {
        return json({error:"cross-origin request refused",code:"origin-mismatch",expected:ownOrigin},403);
      }
      if (!bearer && !mobilePairing && request.headers.get("sec-fetch-site") === "cross-site") {
        return json({error:"cross-origin request refused",code:"origin-mismatch",expected:ownOrigin},403);
      }
    }

    let response;
    try {
      if (route === "GET /api/health") {
        response = await account(env).fetch(new Request(new URL("/_internal/health",url), {method:"GET"}));
      } else if (route === "GET /api/config") {
        const allowGuest = !/^(false|0|off)$/i.test(String(env.ALLOW_GUEST ?? "true"));
        const media = limits(env);
        response = json({invite_only:false,allow_guest:allowGuest,...(media.enabled?{media:mediaConfig(media)}:{})});
      } else if (ACCOUNT_ROUTES.has(route)) {
        response = await account(env).fetch(request);
      } else if (PROFILE_ROUTES.has(route) || route === NUDGE_ROUTE || MEDIA_ROUTE.test(path)) {
        const auth = new Request(new URL("/_internal/resolve",url), {
          method:"POST",
          headers: {...Object.fromEntries(request.headers), "content-type": "application/json"},
          body: "{}"
        });
        const authAnswer = await account(env).fetch(auth);
        if (!authAnswer.ok) response = json({error:"not signed in"},401);
        else {
          const {id} = await authAnswer.json();
          const profile = env.PROFILES.getByName("profile:" + id);
          if (route === NUDGE_ROUTE) {
            const date = url.searchParams.get("date") || "";
            if (!validNudgeDate(date)) {
              response = json({error:"date must be YYYY-MM-DD",code:"date-invalid"},400);
            } else {
              const answer = await profile.fetch(new Request(new URL("/api/data",url),{method:"GET"}));
              if (!answer.ok) response = answer;
              else {
                const {state,rev} = await answer.json();
                response = json(nudgeCheckStatus(state,date,rev));
              }
            }
          } else {
            response = await profile.fetch(request);
          }
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

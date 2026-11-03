# openGym on Cloudflare — experimental implementation

This independently deployable Worker targets the **unmodified openGym iOS/Android/Web client**. It does not replace the client sync algorithm. The openGym Node/Docker server is unchanged.

## Current functionality (tested)

- WebAuthn registration and login against persistent SQLite AccountDO
- Cookie sessions, bearer sessions and session-version invalidation
- Fresh-passkey-proof phone pairing, one-use/expiring pairing codes
- Second passkey creation/rename/removal with actual WebAuthn assertion and last-way-in protection
- Account deletion: immediate revocation plus idempotent profile/media deletion, with durable retry alarms
- GET /api/me, GET /api/config, GET /api/health, GET /api/account/passkeys
- GET /api/data, GET /api/data/rev, PUT /api/data and native background GET /api/nudge-check
- Original state stamps and revision/write-ID conflict contract (api/sync-stamps.js)
- Actual Vite UI and 13k public exercise-media assets served via Workers Static Assets
- Request-origin filtering and native Capacitor preflight
- SQLite unit tests for authentication, media retention, failed cleanup/retries, quota and user isolation
- Full local Wrangler/WebAuthn/paired-client integration test including R2 and account deletion

**Not production-ready**: custom media uploads/R2 APIs, additional account/passkey management, admin, device recovery, all coach/integration/push/notification APIs and complete client route parity are not implemented yet. Missing optional routes return HTTP 404; media capability is **not advertised** in /api/config. No live production deployment has been performed. Further security and failure-mode testing is required.

## Local development

From the repository root:

~~~sh
npm ci --prefix frontend
npm run build --prefix frontend
node scripts/catalogue/stage-media.mjs frontend/dist
npm ci --prefix cloudflare
npm run check --prefix cloudflare
npm run dev --prefix cloudflare -- --port 8791
# another terminal:
npm run test:integration --prefix cloudflare
~~~

Wrangler creates local SQLite Durable Objects and an R2 binding. The test intentionally creates its own temporary account using a synthetic WebAuthn authenticator.

## Cloudflare build / target configuration

The Worker lives under cloudflare/, with wrangler.jsonc and a relative static assets directory. It uses two SQLite Durable Object classes: AccountDO (singleton account+session authority), and ProfileDO (one per profile); the MEDIA binding targets a private R2 bucket. Worker static assets are built from the original Vite app. The public deployment is not recommended until the API compatibility checklist is complete.

A custom public domain must use a consistent WebAuthn RP ID/origin. APP_ORIGIN and RP_ID are optional configuration bindings, but **must be pinned for deployments whose request Host varies**. Account users and media do not use externally visible DO identifiers.

## Compatibility and testing

- The existing client sends a whole JSON profile with baseRev, baseWid and stamps. The ProfileDO handles the CAS in one SQLite transaction, calling the original api/sync-stamps.js and returning HTTP 409 with the current profile.
- Pairing requires a fresh WebAuthn assertion, not just a browser session. The one-use verification and code state live in AccountDO SQLite, not Worker memory.
- The official phone holds the bearer token and polls /api/data/rev; it needs no new API library or mobile build.
- The current integration fixture validates real WebAuthn registration and proof, iPhone pairing, two profile writes, stale write rejection and reload under wrangler dev.
- **Still required before production**: real iOS end-to-end acceptance, account deletion/recovery/second passkey, R2 media and backup/export, security review and static asset deployment from Cloudflare builds.

Use the OpenSpec at ../openspec/changes/cloudflare-sqlite-do-runtime/ for the remaining acceptance checklist. Do not silently switch the client to a different sync protocol.

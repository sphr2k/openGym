# openGym on Cloudflare — experimental implementation

This independently deployable Worker targets the **unmodified openGym iOS/Android/Web client**. It does not replace the client sync algorithm. The openGym Node/Docker server is unchanged.

## Current functionality (tested)

- WebAuthn registration and login against persistent SQLite AccountDO
- Cookie sessions, bearer sessions and session-version invalidation
- Fresh-passkey-proof phone pairing, one-use/expiring pairing codes
- Second passkey creation/rename/removal with actual WebAuthn assertion and last-way-in protection
- Browser-to-browser device link (60-bit one-time code, 10-minute TTL, replay-safe registration)
- Account deletion: immediate revocation plus idempotent profile/media deletion, with durable retry alarms
- Persistent profile deletion tombstone blocks stale writes and in-flight R2 upload resurrection
- GET /api/me, GET /api/config, GET /api/health, GET /api/account/passkeys
- GET /api/data, GET /api/data/rev, PUT /api/data and native background GET /api/nudge-check
- Original state stamps and revision/write-ID conflict contract (api/sync-stamps.js)
- Actual Vite UI and 13k public exercise-media assets served via Workers Static Assets
- Request-origin filtering and native Capacitor preflight
- SQLite unit tests for authentication, media retention, failed cleanup/retries, quota and user isolation
- Full local Wrangler/WebAuthn/paired-client integration test including R2 and account deletion
- R2 orphan reconciliation: recover objects that landed before an interrupted SQLite commit;
  preserve referenced blobs and apply the existing grace period to unreferenced blobs; an alarm is persisted before R2 writes so interrupted uploads are revisited
- Guarded Cloudflare staging Worker deployed with separate R2 bucket and DO SQLite

**Not production-ready:** Admin-issued recovery, admin dashboard, watch relay, push,
AI coach, integration APIs, verified migration/backup tooling and full native app parity
are not complete. Missing optional routes return HTTP 404. This is a restricted
staging deployment, not a public user-facing release.

**Deployment verified:** opengym-cloudflare-staging.janwer.workers.dev with its
own R2 bucket, SQLite Durable Objects and 13,283 static assets. All requests are
rejected without a private staging secret. The native App Store client cannot
yet use this protected stage without a compatible access policy. Local Wrangler
integration tests validate the existing mobile HTTP contract.


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

## Guarded Cloudflare staging

Staging uses a separate Wrangler config and must never share production storage.
From cloudflare/ after building the frontend and catalogue media:

1. Create R2 bucket opengym-cloudflare-staging-media using Wrangler.
2. Run npm run deploy:staging.
3. Generate a strong random key in a private local secret store, then supply it
   via stdin to: npx wrangler secret put STAGING_API_KEY --config wrangler.staging.jsonc

If the STAGING_API_KEY binding is absent, the staging Worker fails closed with
HTTP 404. The header X-OpenGym-Stage-Key must match it to access any route,
including the static app. Never embed the key in browser JavaScript, HTML, a URL,
or a public repository. The synthetic WebAuthn HTTP test supports private
OPENGYM_TEST_URL and OPENGYM_STAGE_KEY environment variables.

A public instance requires a separate security decision: do not remove the gate
until account recovery, migrations, authorization, abuse limits and native app
acceptance are complete. Cloudflare Access is an alternative only if the
unmodified native app can supply the selected Access credentials.

## Cloudflare build / target configuration

The Worker lives under cloudflare/, with wrangler.jsonc and a relative static assets directory. It uses two SQLite Durable Object classes: AccountDO (singleton account+session authority), and ProfileDO (one per profile); the MEDIA binding targets a private R2 bucket. Worker static assets are built from the original Vite app. The public deployment is not recommended until the API compatibility checklist is complete.

A custom public domain must use a consistent WebAuthn RP ID/origin. APP_ORIGIN and RP_ID are optional configuration bindings, but **must be pinned for deployments whose request Host varies**. Account users and media do not use externally visible DO identifiers.

## Compatibility and testing

- The existing client sends a whole JSON profile with baseRev, baseWid and stamps. The ProfileDO handles the CAS in one SQLite transaction, calling the original api/sync-stamps.js and returning HTTP 409 with the current profile.
- Pairing requires a fresh WebAuthn assertion, not just a browser session. The one-use verification and code state live in AccountDO SQLite, not Worker memory.
- The official phone holds the bearer token and polls /api/data/rev; it needs no new API library or mobile build.
- The current integration fixture validates real WebAuthn registration and proof, iPhone pairing, two profile writes, stale write rejection and reload under wrangler dev.
- **Still required before production**: real iOS end-to-end acceptance, migration/backup, optional/admin/watch/recovery routes and full security review.

Use the OpenSpec at ../openspec/changes/cloudflare-sqlite-do-runtime/ for the remaining acceptance checklist. Do not silently switch the client to a different sync protocol.

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
- Guarded Cloudflare staging Worker deployed with separate R2 bucket and DO SQLite (legacy format; not yet upgraded to R2 profile snapshots)

**Not production-ready:** Admin-issued recovery, admin dashboard, watch relay, push,
AI coach, integration APIs, verified migration/backup tooling and full native app parity
are not complete. Missing optional routes return HTTP 404. This is a restricted
staging deployment, not a public user-facing release.

**Deployment verified:** opengym-cloudflare-staging.janwer.workers.dev with its
own R2 bucket, SQLite Durable Objects and 13,283 static assets. Cloudflare
Access is required for both the UI and API (owner browser login plus an
explicit iOS Service Auth policy). The native app uses its existing
Cloudflare Access Client ID/Secret support. Real native-device acceptance
is still pending.


## Profile storage: immutable R2 snapshots

Each user owns one SQLite-backed \`ProfileDO\`. The **entire original JSON profile**
is stored as a single immutable object in the existing private R2 bucket under
\`users/<user-id>/snapshots/\`. SQLite holds only the current revision, write ID,
snapshot key, SHA-256 checksum, a short revision history with the referenced
media hashes of each retained snapshot, and the existing media metadata.
Media reference extraction is shared with the original Node/Docker backend
(`api/media-references.js`). No JSON schema mapping, Drizzle or application-specific DB migrations
are required for new upstream fields.

Writes load the snapshot, run the original \`stampPut\`, upload a *new* R2
object and then atomically compare and update the SQLite pointer/history/media
references. The final CAS includes the snapshot revision actually read before
the async R2 operation. Versioned writers receive the original HTTP 409
conflict shape. Unversioned writers retry against the newest state, rerunning
\`stampPut\` (bounded retries). \`GET /api/data/rev\` reads SQLite alone.

**Recovery/GC:** A persistent DO alarm is armed before each R2 PUT. A repeated,
prefix-scoped mark-and-sweep lists R2 snapshots and reconciles against SQLite.
Unpublished objects must be at least 24h old before automatic removal.
Committed snapshots are preserved for 35 days, plus the current snapshot and
the immediately preceding PITR-window anchor, even when an account is idle
for months. GC is *application-managed*; do not configure an age-based R2
lifecycle rule on the snapshot prefix. Intentional account deletion revokes
access, purges R2 snapshots and retains temporary sweep wakeups for delayed
uploads. Point-in-time recovery covers the DO SQLite pointer only, not R2
objects; this retention policy is necessary for recoverability, not a backup
substitute. Media GC uses the same retained-version set as snapshot GC, so
manual sweeps cannot delete content needed by a historical snapshot.
Expired media upload reservations and interrupted deletions are reconciled
idempotently; the single per-DO alarm is also retained through account deletion
to catch late R2 uploads.

The client continues to send whole profiles and is **still subject to the
shared 5 MiB HTTP request limit**, enforced on actual UTF-8 bytes during
stream ingestion on both Node/Docker and Cloudflare. Only the SQLite per-row
2 MiB limit is removed. Media upload bodies are bounded independently by
the original per-type caps. Cloudflare uses a single reusable payload buffer
and reserves a per-DO 48 MiB concurrency budget *before* buffering; large
simultaneous uploads can receive the original HTTP 429 retry response. The
original Node/Docker backend retains its own streaming/file-backed upload
adapter and does not need Cloudflare's memory-budget mechanism.

**Clean-slate layout:** No legacy document reader, migration or dual-write is
shipped. The short-lived fail-closed check for the old \`document\` table is
only a cutover safety guard ([remove in #17](https://github.com/sphr2k/openGym/issues/17)).
The owner's existing Cloudflare staging data requires an **external one-shot
migration and verified independent backup** before this Worker may be deployed
([migration #6](https://github.com/sphr2k/openGym/issues/6)).
Do not deploy directly over the current legacy staging SQLite database.

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

## Cloudflare Access staging (actual deployment)

Staging uses a separate Wrangler config and never shares production storage.
The verified deployed hostname is opengym-cloudflare-staging.janwer.workers.dev.
Access application: openGym Staging, type self-hosted, bound to that exact
workers.dev hostname; the owner browser policy permits only mail@janwerner.de.
A separate Service Auth policy allows only service token openGym iOS Staging.
Other Cloudflare Access service tokens cannot access this application.

The iOS app's existing CF-Access-Client-Id and CF-Access-Client-Secret headers
are supported in frontend/src/lib/cf-access.js and api.js. Access passes native
preflight OPTIONS requests to the Worker (options_preflight_bypass=true).
The Worker returns the allowed methods and headers only for Capacitor/WebView
origins. The first POST /api/pair/redeem intentionally permits the Capacitor
origin without an openGym Bearer token: it is authenticated by the short-lived,
single-use pairing code. All later data requests require the paired Bearer.

Staging config sets assets.run_worker_first=true. Without it, Cloudflare
may serve public UI assets without invoking Worker code. The original
STAGING_LOCKED header mechanism remains available for other isolated
deployment targets but is disabled here because it is not supported by the
unmodified browser and native clients.

**User setup:**
1. Open the staging hostname in a browser and authenticate with Cloudflare Access.
2. In openGym register/sign in with a passkey and use Settings -> Pair the mobile app.
3. In Cloudflare Zero Trust -> Access controls -> Service credentials ->
   Service Tokens, find openGym iOS Staging and rotate its Client Secret.
   The secret is only shown once; never commit it or paste it in a shared issue.
4. In the native iOS app's Connect to server screen, enter the staging hostname,
   the Cloudflare Access Client ID/Secret, and the single-use pairing code.

The staging Access token uses a 90-day expiry. Each token rotation revokes the
previous client secret. Full authorized remote and App Store iOS sync must be
tested before production use.

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

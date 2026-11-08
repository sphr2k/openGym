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
- Guarded Cloudflare staging Worker with independent R2 bucket and SQLite Durable Objects

**Not production-ready:** Admin-issued recovery, admin dashboard, watch relay, push,
AI coach, integration APIs, verified migration/backup tooling and full native app parity
are not complete. Missing optional routes return HTTP 404. This is a restricted
staging deployment, not a public user-facing release.

**Staging evidence:** A restricted private Cloudflare staging deployment has been exercised with its own R2 bucket, SQLite Durable Objects and the original frontend assets. Real native-device acceptance remains pending. Resource names, private hostnames and identity policies are intentionally omitted from reusable public deployment instructions.


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

**Clean-slate layout:** No legacy document reader, migration, dual-write or
cutover compatibility guard is shipped. Existing installations using the
previous `document` table require a separate, operator-controlled, verified
one-shot conversion into R2 snapshots and SQLite pointers **before** this
Worker is deployed ([#6](https://github.com/sphr2k/openGym/issues/6)).
Code rollback does not automatically restore a previous storage format.

## Cloudflare CLI modes

Project configuration lives in cloudflare/cloudflare.config.ts. Use the new
Cloudflare CLI (cf) for builds, development, and deployments. The generated
wrangler.config.ts is only the internal bundler adapter.

The default mode targets Worker opengym-cloudflare and R2 bucket
opengym-media. Explicit --mode staging targets the guarded Worker
opengym-cloudflare-staging and its separate staging R2 bucket. Each mode
uses its own SQLite-backed AccountDO and ProfileDO namespaces. Staging sends
ALL asset requests through the Worker, preserving its Access boundary.

Use cf deploy --mode staging for the staging target, never the default
deploy command. The cf dev server normally listens on port 8787.

## Local development

From the repository root:

~~~sh
npm ci --prefix frontend
npm run build --prefix frontend
node scripts/catalogue/stage-media.mjs frontend/dist
npm ci --prefix cloudflare
npm ci --prefix mcp    # Cloudflare MCP imports the shared training logic
npm run check --prefix cloudflare
npm run dev --prefix cloudflare
# another terminal:
npm run test:integration --prefix cloudflare
~~~

Wrangler creates local SQLite Durable Objects and an R2 binding. The test intentionally creates its own temporary account using a synthetic WebAuthn authenticator.

## Deploy and maintain your own Cloudflare instance

This is an experimental alternative backend for the **existing** openGym
web/iOS/Android application, not a separate product. It requires a Cloudflare
account with Workers, SQLite-backed Durable Objects and private R2 enabled.

**Current supported path:** deploy from the full source checkout. There is
**no GitHub Actions or custom CI requirement**, and no end-user database
migration commands for a *new* installation. Setup still requires a terminal
and Cloudflare authorization; do not advertise it as a completed one-click
deployment for nontechnical users.

1. Use a dedicated Cloudflare account or isolated application resources.
   Review the resource names in \`cloudflare/cloudflare.config.ts\`. The app needs
   two SQLite Durable Object classes and an R2 bucket for media and immutable
   full-profile snapshots.
2. Build the **original** frontend from the repository root:

   ~~~sh
   npm ci --prefix frontend
   npm run build --prefix frontend
   node scripts/catalogue/stage-media.mjs frontend/dist
   npm ci --prefix cloudflare
   npm ci --prefix mcp
   ~~~

3. Create the R2 bucket named in your *own* Wrangler config, once, through
   the Cloudflare Dashboard or Wrangler. Keep the bucket private; do not
   expose it as a public development or website bucket.
4. Check the Worker bundle, then deploy from \`cloudflare/\` using that
   folder's Wrangler config:

   ~~~sh
   npm run check --prefix cloudflare
   cd cloudflare
   cf deploy
   ~~~

5. Open the deployed HTTPS hostname. Register/sign in using the app's
   existing passkey flow; pair an unmodified native app using the existing
   one-time pairing flow. Keep the hostname stable. When routing through a
   custom domain, configure \`APP_ORIGIN\` and \`RP_ID\` consistently **before**
   the first passkey registration, because passkeys are bound to origin/RP ID.

### Optional Cloudflare Access protection

For an **existing private** application, Cloudflare Access can add an
independent outer access boundary, but it is not an application feature.
If enabled, protect **all Worker/static-asset routes**, not only \`/api/*\`.
Browser users may authenticate through an Access identity policy. Native
app connections require an explicitly scoped Service Auth policy and
separately generated client ID/secret supplied through the original native
connection screen. Never commit or publish tokens, identity allowlists or
private origins. A one-time pairing code does not replace the Access policy.

For an ordinary installation without Cloudflare Access, openGym still
enforces its own passkey/session/bearer authentication. Configure your
registration/invite policy deliberately rather than assuming all endpoints
are automatically private.

### Updates and recovery

Application code updates do not require a CI pipeline or manual SQL for
the current fixed schema. **Back up your data before a storage architecture
change.** The original frontend already supports portable JSON and ZIP
(with photos/videos) export/import via Settings → Data & backup, across both
backends; an export with reported missing media is not a complete backup.

SQLite PITR alone is **not** a portable backup for R2 snapshots and media.
R2 snapshot GC must retain the current snapshot, the recovery-window history,
its pre-window anchor, and the media referenced by those snapshots. Do not
install an R2 age-based lifecycle rule on the private snapshot/media prefix.

An existing installation's \`document\` storage needs a **separate one-shot
data migration** before upgrading; the product runtime deliberately has no
legacy migration path. See [#6](https://github.com/sphr2k/openGym/issues/6)
and remove the temporary cutover guard via
[#17](https://github.com/sphr2k/openGym/issues/17).

### Why there is no one-click button yet

Cloudflare's [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
can provision resources and connect Workers Builds, but **subdirectory
deployments require all application dependencies to live within that
subdirectory**. Our Worker imports shared modules from \`api/\` and serves
assets built in \`frontend/\`. A button pointing only at \`cloudflare/\`
would therefore fail to assemble this monorepo correctly.

A maintainer-ready one-click option needs a verified packaging/build
strategy that preserves the **shared Node/Docker domain code**, not a
Cloudflare-only copy. Track in
[#11](https://github.com/sphr2k/openGym/issues/11); do not advertise a
button until tested from a fresh account. Cloudflare's hosted Workers Builds
is an optional managed deploy mechanism, not a requirement to configure
GitHub Actions yourself.

## Compatibility and testing

- The existing client sends a whole JSON profile with baseRev, baseWid and stamps. The ProfileDO handles the CAS in one SQLite transaction, calling the original api/sync-stamps.js and returning HTTP 409 with the current profile.
- Pairing requires a fresh WebAuthn assertion, not just a browser session. The one-use verification and code state live in AccountDO SQLite, not Worker memory.
- The official phone holds the bearer token and polls /api/data/rev; it needs no new API library or mobile build.
- The current integration fixture validates real WebAuthn registration and proof, iPhone pairing, two profile writes, stale write rejection and reload under cf dev.
- **Still required before production**: real iOS end-to-end acceptance, independently verified backup/restore, optional/admin/watch/recovery routes and full security review.

The source-repository [Issues](https://github.com/sphr2k/openGym/issues) and relevant PRs are the authoritative acceptance backlog. Do not create parallel specifications or silently switch the client to a different sync protocol.

## Optional read-only MCP Worker (single-owner deployments)

The optional Cloudflare MCP endpoint is a **separate Worker**, `opengym-mcp`,
with no web assets, R2 access, or browser login. Its `ACCOUNTS` and `PROFILES`
bindings target the *existing* `opengym-cloudflare-staging` Durable Object
namespaces. The application remains behind its independent Cloudflare Access
policy; do not create a public bypass on it for MCP traffic.

The MCP Worker serves only `/mcp` (Streamable HTTP), and rejects callers unless
`MCP_UPSTREAM_TOKEN` is a random secret of at least 32 characters. Place the
same token in the Cloudflare MCP Portal's **bearer** upstream configuration.
The Portal performs user OAuth via Cloudflare Access. Restrict its Access policy
to the intended owner; an authenticated Portal caller can read that owner's
workout history. `log_workout` is intentionally NOT exposed.

This integration fails closed unless the OpenGym staging account database has
**exactly one active account**, which must be the unique owner. No client token,
passkey, or broad administrative credential is stored in the MCP Worker.

~~~sh
# From the repository root, after installing Node and cf:
npm ci --prefix mcp
npm ci --prefix cloudflare
# Build/deploy the existing app after the internal owner lookup was added:
cd cloudflare
cf deploy --mode staging
# Deploy the separate no-assets MCP Worker, with MCP_UPSTREAM_TOKEN provided
# through a private JSON or .env file, not a CLI argument or checked-in YAML:
cf deploy --mode mcp --secrets-file /private/path/mcp-secrets.json
~~~

The bearer must be kept synchronized with the Portal remote upstream, and the
MCP Worker must be registered at `https://opengym-mcp.<subdomain>.workers.dev/mcp`.
Avoid registering a URL pointing directly at the Access-protected web app.

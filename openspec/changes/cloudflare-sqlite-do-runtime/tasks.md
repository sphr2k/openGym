## Foundation
- [x] Create fork and feature branch
- [x] Specify Client API/Sync/Auth requirements and migration strategy
- [x] Implement separate Worker package, Wrangler SQLite DO bindings and static asset configuration
- [x] Run local Wrangler dev and build smoke test

## Secure authentication
- [x] Implement AccountsDO for users, WebAuthn keys/challenges, one-time pairing and signing key
- [x] Preserve registration/login and fresh passkey assertion requirement for pairing
- [x] Implement bearer/cookie renewal, CSRF/CORS and replay tests

## Profile sync
- [x] Implement per-user ProfileDO with original /api/data and /api/data/rev contract
- [x] Reuse original stampPut; test invalid input, stale revision/write ID, reset and concurrency
- [x] Verify persistence across AccountDO reconstruction and SQLite reopen in tests
- [ ] Verify persistence across real remote Cloudflare DO eviction/restart

## Media/compatibility/deployment
- [x] Implement authenticated R2 media APIs and hash/mime validations
- [x] Add/rename/remove passkeys with fresh WebAuthn assertion; protect last sign-in method
- [x] Revoke credentials before account deletion, idempotent R2/SQLite cleanup with durable alarm retries
- [x] Add per-user automatic R2 garbage collection with 14-day grace and manual immediate sweep
- [x] Reconcile orphaned R2 objects after lost SQLite commits, with a DO wakeup recorded before upload
- [x] Preserve web-to-web device-link flow with one-use 60-bit code and atomic passkey creation
- [x] Persist per-user media rate limits and test account deletion with in-flight uploads
- [ ] Implement admin-generated recovery codes, admin APIs, watch relay and optional notifications with full compatibility tests
- [x] Deploy guarded staging Worker with full exercise catalogue, dedicated R2 bucket and DO SQLite
- [x] Force Worker-first static asset routing and verify anonymous app/API/media responses are 404
- [x] Exercise unmodified mobile-client HTTP contract using synthetic WebAuthn in Wrangler
- [ ] Test actual App Store iOS client against a production-like authenticated deployment
- [x] Push feature branch to public fork without PRs and document protected deployment
- [ ] Implement backup/migration and public production deployment instructions

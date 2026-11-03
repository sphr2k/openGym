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
- [ ] Confirm persistence after DO restart

## Media/compatibility/deployment
- [ ] Implement authenticated R2 media APIs and hash/mime validations
- [x] Add/rename/remove passkeys with fresh WebAuthn assertion; protect last sign-in method
- [x] Revoke credentials before account deletion, idempotent R2/SQLite cleanup with durable alarm retries
- [x] Add per-user automatic R2 garbage collection with 14-day grace and manual immediate sweep
- [ ] Implement device-link recovery, admin APIs, watch relay and optional notifications with full compatibility tests
- [ ] Frontend asset deployment with exercise catalogue
- [ ] Test unmodified mobile client pairing and workout sync
- [ ] Publish branch and draft PR, deployment/backup docs

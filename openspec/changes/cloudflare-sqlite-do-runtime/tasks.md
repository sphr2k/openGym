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
- [ ] Account management, delete, passkey management and optional endpoints pass compatibility tests
- [ ] Frontend asset deployment with exercise catalogue
- [ ] Test unmodified mobile client pairing and workout sync
- [ ] Publish branch and draft PR, deployment/backup docs

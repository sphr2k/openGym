# Cloudflare SQLite Durable Objects runtime for openGym

## Why

openGym currently needs a persistent Node process and filesystem for even one person. Provide a separately deployable Cloudflare Workers backend without rebuilding the official iOS/Android client or changing its API and conflict-handling protocol.

## What changes

- One SQLite Durable Object for account/security state, one per-user SQLite Durable Object for the synced profile.
- Keep public passkey login/registration, browser cookies, fresh-proof mobile pairing, bearer renewal, GET/PUT /api/data, /api/data/rev and revision conflict semantics exactly compatible.
- Reuse original api/sync-stamps.js. Do not implement another merge algorithm. Persist all security challenges/codes across Worker isolates.
- Private R2 for custom media, account cleanup and backup/export; static Vite assets deployed with the Worker.
- Existing Node/Docker server remains unchanged and testable.

## Out of scope

No new client-side CRDT, no rewrite of the native iOS application, no celld or Docker adapter, no conversion of workout JSON to relational tables yet. The first release shall not claim full parity until all relevant account/notifications/media routes are implemented and tested.

## Acceptance

An unmodified mobile app can pair after a fresh WebAuthn proof, save a completed session, recover via HTTP 409 after another device writes, and re-download all data. No silent data loss when a Worker isolate is replaced.

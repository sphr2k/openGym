# Architecture

One Worker serves Vite static assets and API routes. AccountsDO uses embedded SQLite for users, public-key credentials, one-time WebAuthn challenges, pairing codes and session signing secret. ProfileDO (one object per user) stores one JSON snapshot with revision and write lineage in SQLite. Private R2 stores media; object keys are namespaced per authenticated user. The app never sees DO names or Cloudflare-specific headers.

## Compatibility

Preserve the exact existing /api/config, /api/me, /api/register/{options,verify}, /api/login/{options,verify}, /api/pair/{create,redeem}, /api/data, /api/data/rev wire shapes. Signed session payload: user id, expiry, session version and kind. Browser cookies secure, httpOnly and same-site; native client uses Bearer token. Pair creation still requires a fresh WebAuthn assertion (no cookie-only fallback).

ProfileDO performs read, validate, compare baseRev/baseWid, stampPut and write before returning, in one synchronous SQLite transaction with no awaited I/O. 409 returns current doc for existing client-side merge. Stamped server fields and reset handling are unchanged. Clients do not get _prior and _unstamped. Non-versioned legacy imports still work.

## Security and operational rules

Worker verifies CORS/origin and CSRF for cookie mutations and limits request sizes. One-time credentials stored in SQLite, consumed atomically, protected with throttling. All ProfileDO operations are dispatched only after AccountsDO authenticated the session; no user ID from client-controlled headers is trusted. Account deletion first revokes access, then idempotently cleans profile and media. Worker has no process-global mutable state.

## Testing

Run OpenSpec validation, build and local Worker smoke test against real DO SQLite. Test WebAuthn and pairing, duplicate/replayed challenges, stale revision and write ID, concurrent writers, old-client stamps, reset preservation and mobile CORS, and restart persistence. Then validate one complete session with official iOS app before production label.

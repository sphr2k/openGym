## ADDED Requirements

### Requirement: Passkey and pairing API compatibility
The Worker SHALL implement current WebAuthn registration/login and one-time iOS pairing APIs with the same request/response schemas.

#### Scenario: New registration
- **WHEN** a client proves a WebAuthn registration challenge
- **THEN** account and credential are persisted in SQLite and a signed browser session is issued

#### Scenario: Pair native client
- **WHEN** an authenticated browser proves ownership with a fresh passkey assertion
- **THEN** the issued pairing code may be redeemed only once for a bearer session

#### Scenario: Replay
- **WHEN** a consumed WebAuthn challenge or pairing code is used again
- **THEN** it is rejected regardless of the Worker isolate serving the request

#### Scenario: Unauthorized data
- **WHEN** an unauthenticated client requests a profile
- **THEN** it receives 401 and cannot choose a different user's profile

### Requirement: Cloudflare-native persistence
The runtime SHALL keep authoritative account and profile data in SQLite Durable Objects and private media in R2.

#### Scenario: Isolate replacement
- **WHEN** an isolate restarts between requests
- **THEN** all completed writes, auth state and revocations remain effective


### Requirement: Cloudflare Access supports native pairing without client changes
The Worker SHALL allow the documented native Capacitor origins to redeem a short-lived
single-use pairing code before an openGym Bearer exists. Cloudflare Access SHALL
authenticate the upstream request using the existing service-token headers. The
Access-protected hostname SHALL bypass authentication for CORS preflight OPTIONS,
while enforcing Access on the actual pairing and data requests.

#### Scenario: First native pairing
- **WHEN** a Capacitor WebView sends POST /api/pair/redeem with its native Origin, a valid one-time code and Cloudflare Access service-token headers
- **THEN** the origin gate allows the request to reach the existing pairing handler and the handler issues a Bearer only for a valid unused code

#### Scenario: Invalid website origin
- **WHEN** an arbitrary web origin sends the same pairing request
- **THEN** the origin gate rejects it with HTTP 403

#### Scenario: Native CORS preflight
- **WHEN** the native client sends OPTIONS with Origin capacitor://localhost and requests the Access and openGym authorization headers
- **THEN** the Access layer forwards the preflight and the Worker responds with HTTP 204 and the exact allowed headers

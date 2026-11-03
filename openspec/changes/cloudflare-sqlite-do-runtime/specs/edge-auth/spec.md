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

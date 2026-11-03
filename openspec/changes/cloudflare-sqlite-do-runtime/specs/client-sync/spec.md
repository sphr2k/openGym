## ADDED Requirements

### Requirement: Wire-compatible client sync
The Cloudflare runtime SHALL preserve openGym's existing GET /api/data, GET /api/data/rev and PUT /api/data payloads, revisions and response statuses.

#### Scenario: New user reads
- **WHEN** an authenticated new user fetches /api/data
- **THEN** it returns state:null and rev:0

#### Scenario: Valid write
- **WHEN** a client writes a valid profile over the current baseRev and optional baseWid
- **THEN** the server removes active, stamps fields per legacy rules, persists new _rev/_wid/_wids and returns ok:true, rev and wid

#### Scenario: Concurrent stale write
- **WHEN** another device writes since the supplied baseRev or baseWid
- **THEN** HTTP 409 returns the current state and rev without overwriting it

#### Scenario: Old client compatibility
- **WHEN** an old client writes without stamped=true
- **THEN** api/sync-stamps.js preserves removal and edit metadata as on the original Node API

### Requirement: Existing client remains unchanged
The runtime SHALL NOT require client code changes or install Cloudflare-specific client dependencies.

#### Scenario: Offline reconnect
- **WHEN** the official app reconnects with stale local state
- **THEN** its existing 409/merge/retry flow remains functional

# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance — directly from your
self-hosted `./data` directory, and log a workout you describe to it.

It runs locally as a stdio process spawned by the LLM client and adds no new container. The
read tools need no authentication: they read the same `state-<uid>.json` files the openGym api
already writes, and the LLM never sees passkeys, VAPID keys, or session secrets. The one write
tool, `log_workout`, is off until you pair it with your server (see
[Logging workouts](#logging-workouts)).

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Phase 1 of a multi-phase plan, plus the first write tool. See **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

The MCP server reads the same `./data` directory `docker compose up` creates. Pick the profile
to answer for — its user id is in `./data/db.json` under `users[].id`:

```bash
# single-user instance (the common self-hosted case) — auto-detected:
node src/index.js

# multi-user instance, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/openGym/data node src/index.js
```

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/openGym/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if you have one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Cloudflare Worker deployment (read-only)

The Cloudflare staging application serves Streamable HTTP MCP at `/mcp` on
a dedicated hostname that routes to the **same Worker** as the app. It uses
the same ten read-only tools and the existing Profile Durable Objects, no
local files or separate data store. Requests are scoped with
`AsyncLocalStorage`. The Portal enforces user OAuth; this route additionally
requires a separate 32+ byte upstream bearer, and cannot reach app routes.
`log_workout` is deliberately not exposed. See `../cloudflare/README.md`.

## Tools

Ten read-only tools, and one that writes:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight and rest per exercise) |
| `preview_session` | What will the app actually put on screen when I start this routine — after the progression policy and my history have overridden the plan? |
| `get_week_plan` | What's planned when: the next seven days with their routines and how each was decided (coach week, a pinned session, an override, the weekday plan), the current coach week when one is running, and the weekday table. |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown including recorded set-completion times, chronologically sorted `set_timeline` and intervals between completion ticks, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. `form_videos` says how many sets were filmed; the videos themselves never leave the app. A set with a note of its own (set menu → Note) carries it as `sets[].note`. |
| `get_bodyweight` | Weigh-ins, one value per day (the profile's "Daily weigh-in value": morning, average or last), each day's readings with their times, the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |
| `get_programme` | My programmes (routines as a block of weeks with %1RM / RPE targets), and which week of the running one I'm in. |
| `log_workout` | *Writes.* "I did dumbbell curls, 12 kg, 12/12/10" → a logged session in your history, on every device. Needs pairing: [Logging workouts](#logging-workouts). |

`get_routine` and `preview_session` answer two different questions, and confusing them is the
easiest way for a coach to give wrong advice. `get_routine` reports what the routine *stores*.
`preview_session` reports what the athlete will actually *see*: a routine holding "squat 3×8 @
60 kg" opens at 75 kg if the policy progressed or deloaded from that routine's last logged
session. The routine's own weight is the last fallback the session builder consults, not the
first; its reps hold unless a policy that moves reps moved them, or the profile starts planned
sessions from the last session (`starts_from`). Ask `preview_session` before naming a weight.

An exercise merged into another in the app (an exercise's details → Merge into…) reads as the one
it went into everywhere, also in a workout another device logged against it before it synced.

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## Set timestamps and rest-interval analysis

Completed workouts retain `sets[].at` (Unix milliseconds), recorded when the
athlete checks off a set. `get_workout` exposes this as `completed_at` (ISO UTC)
and `completed_at_ms`, alongside existing load/reps, effort (when entered) and
per-set notes. It also returns `set_timeline`, which sorts recorded completion
checks across **all** exercises and rows instead of assuming plan order. Entries
identify the exercise and the original set number/indices. `completion_order`
is chronological. `seconds_since_previous_completion` and
`seconds_since_previous_same_exercise_completion` are exact elapsed times
between those checks, when both timestamps exist.

**Do not call these measured rest durations.** The elapsed time includes the
next set's execution time, setup, transitions, and any intervening exercises.
The actual set-start time and hence exact rest are not recorded. Subtracting an
assumed set execution time can give an explicitly model-dependent rest estimate,
but the MCP does not present that estimate as an observation. Older or imported
sets without `at` are preserved in `entries` and omitted from the chronological
timeline; the MCP never fabricates timestamps. Set rows do not currently get
UUIDv7 IDs by default; order comes from `at`, not from an assumed identifier.

### Estimated pause and same-exercise recovery (MCP only)

`get_workout` now calculates a **model-based** rest estimate for normal
repetition sets, both in `entries[].sets[]` and the chronological `set_timeline`:

- `estimated_set_duration_sec` and `estimated_set_duration_range_sec` assume
  **3 seconds per repetition**, sensitivity range **2–4 seconds/rep**.
- `estimated_idle_before_sec` / `_range_sec`: time since the immediately
  previous checked-off set, minus the estimated execution time of this set.
  This is passive/non-set time (including walking and equipment setup), not
  necessarily actual rest.
- `estimated_same_exercise_recovery_sec` / `_range_sec`: previous completion
  of the **same exercise** to the estimated start of this set. Includes other
  exercises performed in between, so is not a direct measure of muscular
  recovery or absence of exertion.
- `estimated_passive_since_previous_same_exercise_sec` / `_range_sec`:
  same-exercise interval excluding estimated execution time of **all intervening
  sets and the current set**; available only if the duration of every relevant
  set can be estimated. `intervening_set_count` and
  `intervening_exercise_ids` show the intervening work.

All values are in seconds, rounded to 0.1 seconds. Set
`seconds_per_rep` in `get_workout` (1–8, default 3) to examine other tempo
assumptions. `rest_estimation_model` reports the assumptions and source data
coverage. The ranges are tempo-sensitivity scenarios, **not confidence
intervals**, and do not reflect delayed check-offs or other measurement errors.
No rest-interval estimate is made when any completed set lacks its timestamp,
when timestamp gaps contradict the minimum estimated duration, or for timed,
cardio, unilateral, drop-set or rest-pause rows lacking a supported duration.
None of these estimates is a validated physiological muscle or cardiovascular
recovery score; intervening sets can load the same muscle groups and influence
systemic fatigue.

### Muscle overlap and intervening workload (existing `get_workout` tool)

`get_workout` now also returns the **same canonical muscle assignments** used by
OpenGym's muscle balance map (`frontend/src/lib/muscles.js`), not a second mapping
built into the MCP. Every workout `entry` carries:

- `muscle_weights`: effective-set coefficients for each canonical muscle;
  `primary_muscles` (coefficient ≥0.75) and `secondary_muscles` (0–0.75),
  and `muscle_source` (`catalogue`, `profile_custom`, `history_snapshot`,
  `history_override`, `body_part_fallback`, or `unmapped`). These categories
  describe the **app's load model**, not measured muscle activation.

When all completed sets have timestamps, each `set_timeline` event (and its
corresponding `entries[].sets[]` row) additionally provides:

- `last_work_by_muscle`: the most recent completed set for **each muscle**
  involved in this exercise, with the observed time elapsed and, when the
  set-duration model applies, estimated time until the current set started.
  `latest_overlapping_set`: the most recent set sharing any muscle group.
- `intervening_overlapping_sets`, `intervening_overlapping_set_count`,
  `intervening_muscle_set_counts`, and `intervening_muscle_load`: when a previous
  set of the **same exercise** exists, show which intervening work sets share
  muscles and sum OpenGym's effective-set coefficients for those shared muscles.
- `muscle_overlap_unavailable`: documented reason when the chronology or
  muscle metadata cannot support an estimate. `muscle_overlap_model` at workout
  level reports data coverage and interpretation limits.

Warm-up rows do not count as intervening *work* sets. Implausible check-off
intervals are flagged and excluded from the muscle-time tracking, without
changing the stored logs. For imported workouts without set timestamps,
exercise muscle metadata remains available, but chronological overlap is not
inferred. No stored workout data, profile metadata or automatic RIR defaults
are altered. Actual RIR/RPE is read only when the user entered it.

**This is not a physiological fatigue or recovery score.** For example, rowing
and pulldowns share OpenGym's `upper-back` and `biceps` groups, whereas rowing
and the leg press do not share a mapped muscle. The model cannot tell whether
cardiovascular fatigue, systemic exertion, posture, technique or genuine local
muscle recovery is the limiting factor. Treat these as interpretable training
covariates for comparisons across sessions.

## Logging workouts

`log_workout` lets you tell your LLM what you did instead of tapping it in:

> "Log today: dumbbell curls, 12 kg, three sets of 12 except the last was 10. Then planks, 3 × 60 s."

The LLM turns that into exercises and sets; the tool matches the exercises against your library,
builds the workout the way the app's Finish button does (PR badges, the next suggested weight,
warm-ups kept out of volume) and saves it through your openGym server, so every signed-in
device shows it within half a minute. Asking for the same thing twice logs it once.

Exercise names are matched the way a CSV import matches them. A common name resolves to the
library's default variant ("shoulder press" is the barbell one, "leg press" the 45° sled), and the
reply shows what it was matched to so the LLM can check with you. What it will not do is pick
between two entries: "lever chest press" is two in the library, and a name like that, or one that
matches nothing, comes back as a question with candidates. It only creates one of your own
exercises when you confirm the library has none.

It saves at most 20 workouts an hour (a forgotten week is fine, a client stuck in a loop is
not), and each save leaves one line on the MCP server's stderr with the workout's id, day and
the server revision it landed at. Workouts it logged have ids starting with `mw`.

### Pairing

Writes go through the api rather than straight into `./data`, because the api is what keeps a
phone's sync and this write from overwriting each other. So the MCP server needs your server's
address and a sign-in:

1. In the app, signed in as the profile to log into: **Settings → Account → Pair the mobile app**.
   It shows a one-time code (valid five minutes).
2. Turn the code into a token:

   ```bash
   node mcp/scripts/pair.mjs https://gym.example.com ABCD-1234
   ```

3. Add both to the MCP server's `env` in your client config:

   ```jsonc
   "env": {
     "OPENGYM_DATA": "/absolute/path/to/openGym/data",
     "OPENGYM_URL": "https://gym.example.com",
     "OPENGYM_TOKEN": "<the token pair.mjs printed>"
   }
   ```

Things to know about that token:

- It is a **full sign-in to your profile**, the same kind the paired phone app holds, not a
  workout-only key. Your client's config file holds it in plain text; treat it like a password.
- `OPENGYM_URL` has to be `https://` (plain `http://` only to `localhost`), so it never crosses a
  network in the clear.
- It lasts `SESSION_DAYS` (90 days by default). **Sign out everywhere** in Settings ends it at
  once. Either way `log_workout` then says the token was not accepted: pair again.
- Pairing again gets you a new token but does **not** end the old one. To retire a token you
  think has leaked, use Sign out everywhere (which also disconnects paired phones).
- If the MCP server also reads a `./data` directory, the token has to belong to the same profile
  (`OPENGYM_UID`); a token for another one is refused. The server can be remote: without
  `OPENGYM_DATA` the read tools have nothing to read, but `log_workout` still works.

### What it does not do (yet)

- Cardio by time and speed, supersets, per-side sets. Log those in the app.
- Edit or delete a workout. Fix a mistake in the app's History.
- Complete a routine's session. A logged workout is freestyle: it counts in history, stats,
  1RM, PRs and the muscle map, and like any freestyle session it can inform a routine that has
  no history of its own, but it does not tick off a planned day or a coach week's session.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **One runtime dependency beyond the MCP SDK:** none. No database driver, no HTTP framework.
- **No new container.** stdio transport is spawned by the LLM client; nothing to add to
  `docker-compose.yml`.
- **No new auth.** The read tools' boundary is the filesystem — same as `docker compose`
  running on the user's box. No passkey material, VAPID keys, or session secrets ever cross it.
  `log_workout` uses the paired-session token the phone app already uses; no new kind of
  credential, no new api route.
- **No telemetry.** The read tools make no network call. `log_workout` talks to your own
  openGym server and nothing else. The process exits when the LLM client disconnects.

## Tests

```bash
cd mcp && npm test
```

58 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own 92 tests in `frontend/src/lib/*.test.js`.

`log_workout` has two more files: `write-tools.test.js` against a stand-in api (conflicts,
retries, a rejected token, dry runs, duplicates), and `log-workout.e2e.test.js` against the real
`api/server.js` on a temp data directory, which needs `npm ci` in `api/` (it skips without it on
a laptop and fails under `CI`). The workout it builds is tested in
`frontend/src/lib/log-workout.test.js`.

## Roadmap

- **Done (Phase 1):** read-only stdio, 8 tools, direct `./data` access.
- **Done (Phase 1.5):** `preview_session` — the policy's next prescription, the opening set
  rows it produces, and which of plan / confirmed weight / history each number came from.
- **Phase 2:** read+write over stdio, in pieces (#116). Writes go through the api's own
  `PUT /api/data` with the revision they read, as a paired device does, rather than into
  `state-<uid>.json` directly: the api is the one writer of that file, and its sync stamps are
  what keep a write from being undone by the next phone that merges.
  - **Done:** `log_workout`, on the paired-session token (`scripts/pair.mjs`).
  - Next: `add_bodyweight`, `edit_routine`, `assign_weekday`, `override_day`, log corrections.
- **Phase 3:** Streamable HTTP transport, opt-in 4th container in `docker-compose.yml`. Same
  tool implementations, second transport — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.


### Live workouts on Cloudflare MCP

The Cloudflare client publishes a per-device snapshot of its active session through the existing authenticated profile sync, normally around 1.5 seconds after a change. The profile Durable Object keeps that snapshot in a separate SQLite table; the active session remains device-local and is never merged into the canonical profile.

Both list_workouts and get_workout expose completed and running workouts. get_workout with no parameters chooses a fresh running session if one exists, otherwise the latest completed session. Use status=in_progress or workout_id to select a specific live session. A running session includes open sets with done=false, and existing set-timeline and fatigue estimates use only completed work.

Live data includes updated_at, synced_at and stale. A snapshot is marked stale after five minutes and expires after 24 hours. It disappears on the next successful sync after the workout is finished or discarded. If a client goes offline or signs out, the server may retain a stale snapshot until expiry. Account deletion removes all snapshots.

The MCP tools are read-only: they cannot modify an ongoing workout.

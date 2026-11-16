# Temporary upstream overlays

## Exercise-history PR badges

Tracking: [fork issue #44](https://github.com/sphr2k/openGym/issues/44),
[upstream PR #1248](https://github.com/DuarteSantos8/openGym/pull/1248).

The fork carries the same display-only patch submitted upstream: in reps mode
with live records enabled, the session date's PR badge summarizes the existing
set-record results. Chart best-load markers, other modes and disabled live
records keep their existing behavior. This does not change persisted workout
summary PRs or require another backfill.

When integrating upstream:

1. Check whether the target upstream revision contains the accepted fix (or an
   equivalent implementation), rather than relying only on the PR's status.
2. If present, use the upstream implementation and remove this entry. Do not
   revert the fix: an unchanged accepted patch normally reconciles during a
   normal merge without another code edit. Resolve any revised implementation
   in favor of the upstream version after checking behavior.
3. Run `cd frontend && npx vitest run src/sheets.history.test.jsx
   src/lib/exercise-history.test.js src/lib/set-records.test.js`. Confirm that
   equal-load rep improvements get matching session badges and set trophies,
   exact ties do not, and the chart's Best value remains unchanged.

If the upstream revision does not contain the fix, retain this patch and entry.
The unrelated RIR/10RM proposal remains deferred.

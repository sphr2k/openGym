// One estimate for set labels and PRs. Keep full precision until display.
import { beatsWeight, isAssisted } from './exercises.js'
import { estimateSet, calibrate } from '../../../shared/strength/e10rm.ts'
import { bestWeightFor, bestWeightForEntry, isBw, metricRowsForEntry, metricModeForEntry } from './history.js'
import { isSideSet } from './workout-model.js'
import { rirOf } from './effort.js'
import { entryDbLoad, historyAs } from './dumbbells.js'
import { gymSplitView } from './gym-split.js'

// Epley, normalised to ten reps. Missing historical effort adds no reserve;
// it is never written back as a logged rating. Bound effective reps too.
export { strengthProgress, calibrate, explainEstimate } from '../../../shared/strength/e10rm.ts'
export { BASELINE_FORMULA, PERSONAL_FORMULA } from '../../../shared/strength/e10rm.ts'
export function estimate10RM(weight, reps, rir = null, model = null) {
  return estimateSet({ w: Number(weight), r: Number(reps), rir, done: true }, model)?.value ?? null
}

export function best10RM(entry, model = null) {
  if (entry?.target?.assisted || isAssisted(entry?.id) || isBw({ ...entry?.target, id: entry?.id })) return null
  let best = null
  for (const row of metricRowsForEntry(entry, 'reps')) {
    const sets = isSideSet(row) ? [row.sides.L, row.sides.R] : [row]
    for (const set of sets) {
      if (!set?.done) continue
      const estimate = estimateSet({ w: Number(set.w), r: Number(set.r), rir: rirOf(set), done: true }, model)
      // High-repetition estimates are visible in the workout, but cannot set a strength PR.
      if (estimate?.pr_eligible && (best == null || estimate.value > best)) best = estimate.value
    }
  }
  return best
}

export function is10RMRecord(state, entry) {
  const history = historyAs(gymSplitView(state, entry.id), entry.id, entryDbLoad(entry))
  const model = calibrate(history?.workouts || [], entry.id)
  const current = best10RM(entry, model)
  if (current == null) return false
  let best = 0
  for (const workout of history?.workouts || []) for (const previous of workout.entries || []) {
    if (previous.id === entry.id) best = Math.max(best, best10RM(previous, model) || 0)
  }
  return current > best
}

// Assistance and bodyweight loads keep their existing load-record meaning;
// timed/cardio records likewise do not become strength estimates.
export const uses10RM = entry => metricModeForEntry(entry) === 'reps' &&
  !entry?.target?.assisted && !isAssisted(entry?.id) && !isBw({ ...entry?.target, id: entry?.id })

export function isEntryRecord(state, entry) {
  if (uses10RM(entry)) {
    if (best10RM(entry) != null) return is10RMRecord(state, entry)
    // A high-repetition estimate is display-only; do not resurrect a weight-only PR
    // through the legacy fallback when no ordinary-range set exists.
    const extrapolated = metricRowsForEntry(entry, 'reps').some(row =>
      (isSideSet(row) ? [row.sides.L, row.sides.R] : [row])
        .some(set => set?.done && estimateSet(set)?.range_quality === 'high_rep_extrapolation'))
    if (extrapolated) return false
  }
  return beatsWeight(entry.id, bestWeightForEntry(entry), bestWeightFor(state, entry.id, entryDbLoad(entry)))
}

export function workoutRecords(state, entries) {
  return [...new Set((entries || []).filter(entry => isEntryRecord(state, entry)).map(entry => entry.id))]
}

// One estimate for set labels and PRs. Keep full precision until display.
import { beatsWeight, isAssisted } from './exercises.js'
import { bestWeightFor, bestWeightForEntry, isBw, metricRowsForEntry, metricModeForEntry } from './history.js'
import { isSideSet } from './workout-model.js'
import { rirOf } from './effort.js'
import { REP_CAP } from './onerm.js'
import { entryDbLoad, historyAs } from './dumbbells.js'
import { gymSplitView } from './gym-split.js'

// Epley, normalised to ten reps. Missing historical effort adds no reserve;
// it is never written back as a logged rating. Bound effective reps too.
export function estimate10RM(weight, reps, rir = null) {
  const w = Number(weight), r = Number(reps), reserve = rir == null ? 0 : Number(rir)
  if (!Number.isFinite(w) || !Number.isFinite(r) || !Number.isFinite(reserve) ||
      w <= 0 || r < 1 || reserve < 0 || r + reserve > REP_CAP) return null
  return w * (30 + r + reserve) / 40
}

export function best10RM(entry) {
  if (entry?.target?.assisted || isAssisted(entry?.id) || isBw({ ...entry?.target, id: entry?.id })) return null
  let best = null
  for (const row of metricRowsForEntry(entry, 'reps')) {
    const sets = isSideSet(row) ? [row.sides.L, row.sides.R] : [row]
    for (const set of sets) {
      if (!set?.done) continue
      const est = estimate10RM(set.w, set.r, rirOf(set))
      if (est != null && (best == null || est > best)) best = est
    }
  }
  return best
}

export function is10RMRecord(state, entry) {
  const current = best10RM(entry)
  if (current == null) return false
  const history = historyAs(gymSplitView(state, entry.id), entry.id, entryDbLoad(entry))
  let best = 0
  for (const workout of history?.workouts || []) for (const previous of workout.entries || []) {
    if (previous.id === entry.id) best = Math.max(best, best10RM(previous) || 0)
  }
  return current > best
}

// Assistance and bodyweight loads keep their existing load-record meaning;
// timed/cardio records likewise do not become strength estimates.
export const uses10RM = entry => metricModeForEntry(entry) === 'reps' &&
  !entry?.target?.assisted && !isAssisted(entry?.id) && !isBw({ ...entry?.target, id: entry?.id })

export function isEntryRecord(state, entry) {
  return uses10RM(entry) ? is10RMRecord(state, entry)
    : beatsWeight(entry.id, bestWeightForEntry(entry), bestWeightFor(state, entry.id, entryDbLoad(entry)))
}

export function workoutRecords(state, entries) {
  return [...new Set((entries || []).filter(entry => isEntryRecord(state, entry)).map(entry => entry.id))]
}

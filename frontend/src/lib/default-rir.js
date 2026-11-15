import { effortOf } from './history.js'
import { isWarmupRow, modeForSet } from './workout-model.js'

// Applied only when a new set/side is completed, never when history is loaded.
export function withDefaultRir(state, entry, row, set = row) {
  if (state?.defaultRir === false || effortOf(state) !== 'rir' || !set?.done ||
      isWarmupRow(row) || modeForSet(row, entry?.target) !== 'reps' || set.rir != null || set.rpe != null) return set
  return { ...set, rir: 0 }
}

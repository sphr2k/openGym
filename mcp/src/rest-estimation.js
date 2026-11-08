// Scenario-based rest estimates from actual set check-off timestamps.
// No physiological recovery or real start-of-effort is measured by these values.
import { modeOf } from '../../frontend/src/lib/history.js'
import { hasCompletedWork, isSideSet, setType } from '../../frontend/src/lib/workout-model.js'

export const DEFAULT_SECONDS_PER_REP = 3
const round = n => Math.round(n * 10) / 10

// Default sensitivity scenarios are 2/3/4 seconds per rep. This range is NOT
// a measured 95%-CI; it reflects only uncertainty in the assumed rep tempo.
export function estimatedRepDuration(set, mode, secondsPerRep = DEFAULT_SECONDS_PER_REP) {
  if (mode !== 'reps' || !hasCompletedWork(set) || setType(set) !== 'straight' || isSideSet(set)) return null
  const reps = Number(set?.r)
  if (!Number.isInteger(reps) || reps <= 0 || reps > 100) return null
  const low = Math.max(0.5, secondsPerRep - 1)
  const high = secondsPerRep + 1
  return { seconds: round(reps * secondsPerRep), min: round(reps * low), max: round(reps * high) }
}

function restAfterGap(elapsedSec, duration) {
  if (duration == null || !Number.isFinite(elapsedSec) || elapsedSec < duration.min) return null
  return {
    seconds: round(Math.max(0, elapsedSec - duration.seconds)),
    range_sec: [round(Math.max(0, elapsedSec - duration.max)), round(Math.max(0, elapsedSec - duration.min))],
  }
}

// Called on the same time-sorted `set_timeline` the user sees. A missing tick
// anywhere invalidates the assumption that adjacent timestamps are adjacent
// actual sets, so interval estimates are suppressed for the entire workout.
export function estimateWorkoutRest(timeline, rawEntries, secondsPerRep = DEFAULT_SECONDS_PER_REP) {
  if (!(Number.isFinite(secondsPerRep) && secondsPerRep >= 1 && secondsPerRep <= 8))
    throw new RangeError('seconds_per_rep must be between 1 and 8')

  const recorded = timeline.length
  const completed = (rawEntries || []).reduce((n, e) => n + (e.sets || []).filter(hasCompletedWork).length, 0)
  const fullCoverage = recorded > 0 && recorded === completed
  const rows = timeline.map(e => ({ ...e }))
  const durations = rows.map(e => {
    const source = rawEntries[e.entry_index]
    const set = source?.sets?.[e.set_index]
    const mode = modeOf({ ...(source?.target || {}), id: source?.id })
    const d = estimatedRepDuration(set, mode, secondsPerRep)
    if (d) {
      e.estimated_set_duration_sec = d.seconds
      e.estimated_set_duration_range_sec = [d.min, d.max]
    }
    return d
  })

  const lastExercise = new Map()
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i]
    const d = durations[i]
    const earlierIdx = lastExercise.get(e.exercise_id)
    if (earlierIdx != null) {
      const between = rows.slice(earlierIdx + 1, i)
      e.intervening_set_count = between.length
      e.intervening_exercise_ids = [...new Set(between.map(x => x.exercise_id))]
    }
    if (!fullCoverage) {
      e.rest_estimate_unavailable = 'incomplete_set_timestamps'
    } else if (!d) {
      e.rest_estimate_unavailable = 'unsupported_set_duration'
    } else {
      // Passive, non-set time immediately before the current effort; includes
      // adjusting equipment, walking to another station and idle waiting.
      if (i > 0 && durations[i - 1]) {
        const delta = (e.completed_at_ms - rows[i - 1].completed_at_ms) / 1000
        const passive = restAfterGap(delta, d)
        if (passive) {
          e.estimated_idle_before_sec = passive.seconds
          e.estimated_idle_before_range_sec = passive.range_sec
        } else e.rest_estimate_unavailable = 'completion_gap_shorter_than_set_duration'
      }

      if (earlierIdx != null && durations[earlierIdx]) {
        const delta = (e.completed_at_ms - rows[earlierIdx].completed_at_ms) / 1000
        const recovery = restAfterGap(delta, d)
        if (recovery) {
          // Includes intervening efforts! Hence NOT passive rest, and not a
          // direct physiological measure of local-muscle recovery.
          e.estimated_same_exercise_recovery_sec = recovery.seconds
          e.estimated_same_exercise_recovery_range_sec = recovery.range_sec

          // Sensitivity calculation for actual non-set time since this lift's
          // previous completion: deduct ALL known intervening set durations.
          // Unknown durations (cardio, isometric, rest-pause, unilateral) => no estimate.
          const betweenDurations = durations.slice(earlierIdx + 1, i + 1)
          if (betweenDurations.every(Boolean)) {
            const predicted = betweenDurations.reduce((n, x) => n + x.seconds, 0)
            const min = betweenDurations.reduce((n, x) => n + x.min, 0)
            const max = betweenDurations.reduce((n, x) => n + x.max, 0)
            if (delta >= min) {
              e.estimated_passive_since_previous_same_exercise_sec = round(Math.max(0, delta - predicted))
              e.estimated_passive_since_previous_same_exercise_range_sec = [round(Math.max(0, delta - max)), round(Math.max(0, delta - min))]
            }
          }
        }
      }
    }
    lastExercise.set(e.exercise_id, i)
  }

  return {
    timeline: rows,
    model: {
      method: 'completion_ticks_minus_assumed_rep_duration',
      seconds_per_rep: secondsPerRep,
      seconds_per_rep_scenarios: [Math.max(0.5, secondsPerRep - 1), secondsPerRep, secondsPerRep + 1],
      scenario_range_is_confidence_interval: false,
      completed_set_count: completed,
      timestamped_set_count: recorded,
      interval_estimates_available: fullCoverage,
      note: 'These are model-based intervals, not measured rest or physiological recovery. Passive time includes setup and transitions; same-exercise recovery includes intervening exercises, which may share muscle demands. Check-off times may lag physical effort. Timed/cardio, unilateral and intensifier rows are not modelled. Ranges vary assumed repetition tempo only.',
    },
  }
}

// Read-only context for a completed workout. Uses the SAME muscle model as
// OpenGym's stats map; no muscle mapping or physiological recovery model here.
import { MUSCLES, hasExplicitMuscleMetadata, musclesOf } from '../../frontend/src/lib/muscles.js'
import { exOr } from '../../frontend/src/lib/exercises.js'
import { hasCompletedWork, isWarmupRow } from '../../frontend/src/lib/workout-model.js'

const round = n => Math.round(n * 100) / 100
const sortedWeights = value => Object.fromEntries(MUSCLES.filter(m => Number(value[m]) > 0).map(m => [m, value[m]]))
const ownMetadata = e => ['muscleWeights', 'muscles', 'muscleGroups', 'primaries', 'primaryMuscles', 'primary', 'secondaries', 'secondaryMuscles', 'secondary', 'tg', 'mg', 'sm'].some(k => Object.hasOwn(e || {}, k))

// Match the history muscle map's source preference: explicit history override,
// current custom exercise, built-in catalogue, then saved history snapshot.
// Never call registerCustom(): the MCP serves multiple profiles concurrently.
export function workoutMuscleProfiles(rawEntries, S) {
  const custom = new Map((S?.customEx || []).filter(x => x?.id != null).map(x => [x.id, x]))
  return (rawEntries || []).map(e => {
    const builtIn = exOr(e.id)
    let source, provenance
    if (ownMetadata(e)) { source = e; provenance = 'history_override' }
    else if (custom.has(e.id)) { source = custom.get(e.id); provenance = 'profile_custom' }
    else if (!builtIn.missing) { source = builtIn; provenance = 'catalogue' }
    else if (e.muscleSnapshot && typeof e.muscleSnapshot === 'object') { source = e; provenance = 'history_snapshot' }
    else { source = e; provenance = 'history_bodypart_fallback' }
    const weights = sortedWeights(musclesOf(source))
    const chosen = provenance === 'history_snapshot' ? (e.muscleSnapshot || e) : source
    const explicit = hasExplicitMuscleMetadata(chosen) || (chosen?.muscleWeights && typeof chosen.muscleWeights === 'object' && !Array.isArray(chosen.muscleWeights))
    const muscles = Object.keys(weights)
    // These tiers interpret the existing OpenGym effective-set coefficients,
    // rather than inventing a second primary/secondary muscle classification.
    return {
      muscle_weights: weights,
      primary_muscles: muscles.filter(m => weights[m] >= 0.75),
      secondary_muscles: muscles.filter(m => weights[m] < 0.75),
      muscle_source: explicit ? provenance : (muscles.length ? 'body_part_fallback' : 'unmapped'),
    }
  })
}

// Enrich an existing, chronologically sorted timeline with explicit exposure
// to muscles shared with earlier work. Not a prediction of neuromuscular or
// cardiorespiratory recovery. Can only establish order if every set has a tick.
export function addMuscleOverlap(timeline, rawEntries, profiles) {
  const completed = (rawEntries || []).reduce((n,e) => n + (e.sets || []).filter(hasCompletedWork).length, 0)
  const coverage = completed > 0 && timeline.length === completed
  const byMuscle = new Map() // most recent work set for each canonical muscle
  const lastSame = new Map()
  let counted = 0

  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i]
    const profile = profiles[e.entry_index] || { muscle_weights: {} }
    const weights = profile.muscle_weights
    const groups = Object.keys(weights)
    const raw = rawEntries[e.entry_index]?.sets?.[e.set_index]
    const validWork = !!raw && hasCompletedWork(raw) && !isWarmupRow(raw)
    e.muscle_weights = { ...weights }
    // A physically impossible 5-second transition is often a delayed check-off.
    // Keep its raw timestamp visible, but do not use it as a trusted fatigue event.
    const timestampSuspect = e.rest_estimate_unavailable === 'completion_gap_shorter_than_set_duration'
    if (!coverage) {
      e.muscle_overlap_unavailable = 'incomplete_set_timestamps'
      continue
    }
    if (!groups.length) {
      e.muscle_overlap_unavailable = 'unmapped_exercise'
      continue
    }
    if (!validWork) {
      e.muscle_overlap_unavailable = 'warmup_or_incomplete_set'
      continue
    }
    if (timestampSuspect) {
      e.muscle_overlap_unavailable = 'implausible_completion_order'
      continue
    }
    counted++
    // A muscle-specific clock: current set's completion must never count.
    const lastByMuscle = {}
    let mostRecent = null
    for (const muscle of groups) {
      const prev = byMuscle.get(muscle)
      if (!prev) continue
      const delta = (e.completed_at_ms - prev.completed_at_ms) / 1000
      if (delta < 0) continue
      lastByMuscle[muscle] = {
        exercise_id: prev.exercise_id,
        set_number: prev.set_number,
        completion_order: prev.completion_order,
        elapsed_since_completion_sec: Math.round(delta * 10) / 10,
        // Starts are modelled; do not use intervals with missing/implausible durations.
        ...(e.estimated_set_duration_sec != null && !e.rest_estimate_unavailable && delta >= (e.estimated_set_duration_range_sec?.[0] || 0)
          ? { estimated_sec_until_current_set_start: Math.max(0, Math.round((delta-e.estimated_set_duration_sec)*10)/10) }
          : {}),
      }
      if (!mostRecent || prev.completed_at_ms > mostRecent.completed_at_ms) mostRecent = prev
    }
    if (Object.keys(lastByMuscle).length) {
      e.last_work_by_muscle = lastByMuscle
      e.latest_overlapping_set = {
        exercise_id: mostRecent.exercise_id,
        set_number: mostRecent.set_number,
        completion_order: mostRecent.completion_order,
        shared_muscles: groups.filter(m => byMuscle.get(m)?.completion_order === mostRecent.completion_order),
      }
    }

    // Specifically: extra muscle load accumulated between two sets of the
    // SAME exercise (excluding both endpoint sets). No actual RIR inferred.
    const previousIdx = lastSame.get(e.exercise_id)
    if (previousIdx != null) {
      const intermediates = timeline.slice(previousIdx + 1, i)
      const load = {}
      const counts = {}
      const affected = []
      for (const set of intermediates) {
        const previousProfile = profiles[set.entry_index] || { muscle_weights:{} }
        const earlierRaw = rawEntries[set.entry_index]?.sets?.[set.set_index]
        if (!earlierRaw || isWarmupRow(earlierRaw) || !hasCompletedWork(earlierRaw) || set.muscle_overlap_unavailable === 'implausible_completion_order') continue
        const shared = groups.filter(m => previousProfile.muscle_weights[m] > 0)
        if (!shared.length) continue
        affected.push({
          exercise_id: set.exercise_id,
          set_number: set.set_number,
          completion_order: set.completion_order,
          shared_muscles: shared,
        })
        for (const m of shared) {
          load[m] = round((load[m] || 0) + previousProfile.muscle_weights[m])
          counts[m] = (counts[m] || 0) + 1
        }
      }
      const excluded = intermediates.filter(set => set.muscle_overlap_unavailable === 'implausible_completion_order')
      if (excluded.length) e.intervening_suspect_timestamp_set_count = excluded.length
      e.intervening_overlapping_sets = affected
      e.intervening_overlapping_set_count = affected.length
      e.intervening_muscle_load = sortedWeights(load)
      e.intervening_muscle_set_counts = sortedWeights(counts)
    }
    lastSame.set(e.exercise_id, i)
    // Zero-load and incomplete/warmup rows are not work. Even for a late tick,
    // the user's event time is left as-is rather than silently reordered.
    for (const m of groups) byMuscle.set(m, e)
  }

  return {
    available: coverage,
    completed_set_count: completed,
    timestamped_set_count: timeline.length,
    mapped_work_set_count: counted,
    taxonomy: 'OpenGym musclesOf + muscleWeightsOf; effective-set coefficients (not EMG, fatigue or recovery percentages)',
    note: 'Overlaps are exercise-metadata associations, not measured residual fatigue. Shared muscles may be primary or secondary, without implying equal activation. Implausible checkoff events are excluded from derived muscle-work clocks, flagged, and retained in raw timeline. Warmups are not counted as intervening work. Actual RIR is reported only if logged.',
  }
}

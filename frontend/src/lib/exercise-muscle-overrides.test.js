import { describe, expect, it } from 'vitest'
import { EXDB, EXIDX, smOf } from './exercises.js'
import { muscleWeightsOf, musclesOf } from './muscles.js'
import { EXERCISE_SECONDARY_REMOVALS } from './exercise-muscle-overrides.js'
import { workoutMuscleProfiles } from '../../../mcp/src/muscle-overlap.js'

const raw = Object.fromEntries(EXDB.map(ex => [ex.id, ex]))

describe('fork-local exercise muscle correction overlay', () => {
  it('removes false effective-set triceps credit from lateral/front raises, preserving the generated catalogue', () => {
    for (const [id, excluded] of Object.entries(EXERCISE_SECONDARY_REMOVALS)) {
      const source = raw[id]
      const target = EXIDX[id]
      expect(source, id).toBeDefined()
      expect(target, id).toBeDefined()
      expect(source.sm, id).toContain('triceps')
      for (const muscle of excluded) {
        expect(smOf(target), id).not.toContain(muscle)
        expect(muscleWeightsOf(target), id).not.toHaveProperty(muscle)
        expect(musclesOf(target), id).not.toHaveProperty(muscle)
      }
      expect(muscleWeightsOf(target)['side-delts'] || muscleWeightsOf(target)['front-delts'], id).toBe(1)
      expect(raw[id].sm, id).toContain('triceps') // no mutation of generator output
    }
  })

  it('applies the same mapping to MCP muscle overlap, without suppressing true press-related triceps credit', () => {
    const profiles = workoutMuscleProfiles([{ id: '0178' }, { id: '0576' }], { customEx: [] })
    expect(profiles[0]).toMatchObject({ muscle_source: 'catalogue', muscle_weights: { 'side-delts': 1, trapezius: 0.4 } })
    expect(profiles[0].muscle_weights).not.toHaveProperty('triceps')
    expect(profiles[1].muscle_weights).toHaveProperty('triceps', 0.4)
  })
})

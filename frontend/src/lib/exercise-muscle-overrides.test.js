import { describe, expect, it } from 'vitest'
import { EXDB, EXIDX, smOf } from './exercises.js'
import { muscleWeightsOf, musclesOf, loadOf, loadOfWorkouts, sessionLoad, loadOfRoutine } from './muscles.js'
import { EXERCISE_SECONDARY_REMOVALS } from './exercise-muscle-overrides.js'
import { workoutMuscleProfiles } from '../../../mcp/src/muscle-overlap.js'

const raw = Object.fromEntries(EXDB.map(ex => [ex.id, ex]))

describe('fork-local exercise muscle correction overlay', () => {
  it('removes invalid secondary muscle credit from reviewed isolation movements, preserving source catalogue', () => {
    for (const [id, excluded] of Object.entries(EXERCISE_SECONDARY_REMOVALS)) {
      const source = raw[id]
      const target = EXIDX[id]
      expect(source, id).toBeDefined()
      expect(target, id).toBeDefined()
      for (const muscle of excluded) expect(source.sm, id).toContain(muscle)
      for (const muscle of excluded) {
        expect(smOf(target), id).not.toContain(muscle)
        expect(muscleWeightsOf(target), id).not.toHaveProperty(muscle)
        expect(musclesOf(target), id).not.toHaveProperty(muscle)
      }
      const primary = { 'side delts': 'side-delts', 'front delts': 'front-delts', pectorals: 'chest', forearms: 'forearm' }[source.tg]
      expect(muscleWeightsOf(target)[primary], id).toBe(1)
      for (const muscle of excluded) expect(raw[id].sm, id).toContain(muscle) // source untouched
    }
  })

  it('does not count mobility, stretching, yoga, cardio and combat as hypertrophy sets', () => {
    const strength = {id:'0576',sets:[{done:true,w:52.5,r:12}]}
    const mobility = {id:'1167',sets:[{done:true,w:0,r:20}]}
    const stretching = {id:'5401',sets:[{done:true,w:0,r:10}]}
    const cardio = {id:'0128',sets:[{done:true,w:0,r:20}]}
    const work = [strength,mobility,stretching,cardio]
    const expected = loadOfWorkouts([{entries:[strength]}])
    expect(loadOfWorkouts([{entries:work}])).toEqual(expected)
    expect(sessionLoad(work).done).toEqual(expected)
    expect(sessionLoad(work).planned).toEqual(expected)
    expect(loadOfRoutine({ex:work.map(x=>({id:x.id,sets:1}))})).toEqual(expected)
    expect(musclesOf(EXIDX['1167'])).toHaveProperty('chest',1) // anatomy still visible in exercise picker
    expect(loadOf([{id:'1167',sets:1}],{includeNonStrength:true})).toHaveProperty('chest',1) // watch shows anatomy
    expect(loadOfWorkouts([{entries:[{id:'1297',sets:[{done:true,w:0,r:10}]}]}])).toHaveProperty('chest',1)
  })

  it('applies the same mapping to MCP muscle overlap, without suppressing true press-related triceps credit', () => {
    const profiles = workoutMuscleProfiles([{ id: '0178' }, { id: '0576' }], { customEx: [] })
    expect(profiles[0]).toMatchObject({ muscle_source: 'catalogue', muscle_weights: { 'side-delts': 1, trapezius: 0.4 } })
    expect(profiles[0].muscle_weights).not.toHaveProperty('triceps')
    expect(profiles[1].muscle_weights).toHaveProperty('triceps', 0.4)
  })
})

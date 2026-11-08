import { describe, expect, test } from 'vitest'
import { estimatedRepDuration, estimateWorkoutRest } from '../src/rest-estimation.js'

const base = Date.parse('2026-11-08T12:00:00.000Z')
const raw = [
  { id:'0025', target:{mode:'reps'}, sets:[
    {w:155,r:10,done:true,at:base+120000},
    {w:155,r:8,done:true,at:base+360000},
  ]},
  { id:'2291',target:{mode:'reps'},sets:[{w:84,r:12,done:true,at:base+240000}] },
]
const event = (id, entry, set, time) => ({exercise_id:id,entry_index:entry,set_index:set,completed_at_ms:base+time*1000})
const timeline = [event('0025',0,0,120),event('2291',1,0,240),event('0025',0,1,360)]

describe('rest estimates from real completion timestamps',()=>{
  test('interleaved exercises: idle, same-exercise recovery and cumulative passive rest differ',()=>{
    const {timeline:t,model} = estimateWorkoutRest(timeline,raw)
    expect(model).toMatchObject({seconds_per_rep:3, seconds_per_rep_scenarios:[2,3,4], completed_set_count:3,timestamped_set_count:3,interval_estimates_available:true,scenario_range_is_confidence_interval:false})
    expect(t[0].estimated_set_duration_sec).toBe(30)
    expect(t[0]).not.toHaveProperty('estimated_idle_before_sec')
    expect(t[1]).toMatchObject({
      estimated_set_duration_sec:36,estimated_set_duration_range_sec:[24,48],
      estimated_idle_before_sec:84,estimated_idle_before_range_sec:[72,96],
    })
    expect(t[2]).toMatchObject({
      estimated_set_duration_sec:24, estimated_set_duration_range_sec:[16,32],
      estimated_idle_before_sec:96, estimated_idle_before_range_sec:[88,104],
      estimated_same_exercise_recovery_sec:216,estimated_same_exercise_recovery_range_sec:[208,224],
      estimated_passive_since_previous_same_exercise_sec:180,estimated_passive_since_previous_same_exercise_range_sec:[160,200],
      intervening_set_count:1,intervening_exercise_ids:['2291'],
    })
    // Neither raw log nor its order is mutated.
    expect(raw[0].sets[1]).not.toHaveProperty('estimated_set_duration_sec')
    expect(timeline[2]).not.toHaveProperty('estimated_idle_before_sec')
  })

  test('a consecutive repeat has the same predicted idle and passive recovery',()=>{
    const rawSame = [{id:'0025',sets:[{done:true,r:8,at:base+100000},{done:true,r:10,at:base+300000}]}]
    const x = [event('0025',0,0,100),event('0025',0,1,300)]
    const t = estimateWorkoutRest(x,rawSame).timeline
    expect(t[1].estimated_idle_before_sec).toBe(170)
    expect(t[1].estimated_same_exercise_recovery_sec).toBe(170)
    expect(t[1].estimated_passive_since_previous_same_exercise_sec).toBe(170)
    expect(t[1].intervening_set_count).toBe(0)
  })

  test('tempo is configurable and scenario ranges vary tempo rather than implying statistical certainty',()=>{
    const t = estimateWorkoutRest(timeline,raw,4)
    expect(t.model.seconds_per_rep_scenarios).toEqual([3,4,5])
    expect(t.timeline[1].estimated_idle_before_sec).toBe(72)
    expect(t.timeline[2].estimated_same_exercise_recovery_sec).toBe(208)
    expect(t.timeline[2].estimated_passive_since_previous_same_exercise_sec).toBe(160)
    expect(()=>estimateWorkoutRest(timeline,raw,9)).toThrow(/seconds_per_rep/)
  })

  test('with a missing check-off timestamp: do not pretend logged ticks are consecutive sets',()=>{
    const s = structuredClone(raw)
    s[1].sets.push({done:true,r:10})
    const {timeline:t,model} = estimateWorkoutRest(timeline,s)
    expect(model).toMatchObject({interval_estimates_available:false,completed_set_count:4,timestamped_set_count:3})
    for (const x of t) {
      expect(x.rest_estimate_unavailable).toBe('incomplete_set_timestamps')
      expect(x).not.toHaveProperty('estimated_idle_before_sec')
      expect(x).not.toHaveProperty('estimated_same_exercise_recovery_sec')
    }
    expect(t[0].estimated_set_duration_sec).toBe(30)
    expect(estimateWorkoutRest([],[{id:'0025',sets:[]}]).model.interval_estimates_available).toBe(false)
  })

  test('no false precision for isometrics, cardio, drop sets, rest-pause or unilateral work',()=>{
    expect(estimatedRepDuration({done:true,sec:60},'time')).toBeNull()
    expect(estimatedRepDuration({done:true,min:15},'cardio')).toBeNull()
    expect(estimatedRepDuration({done:true,r:12,type:'dropset'},'reps')).toBeNull()
    expect(estimatedRepDuration({done:true,r:12,type:'restpause'},'reps')).toBeNull()
    expect(estimatedRepDuration({done:true,r:12,sides:{L:{r:6},R:{r:6}}},'reps')).toBeNull()
    expect(estimatedRepDuration({done:false,r:12},'reps')).toBeNull()
    expect(estimatedRepDuration({done:true,r:0},'reps')).toBeNull()
    const s = [{id:'0025',sets:[{done:true,r:10,at:base+50000},{done:true,r:10,at:base+55000}]}]
    const t = estimateWorkoutRest([event('0025',0,0,50),event('0025',0,1,55)],s).timeline
    expect(t[1].rest_estimate_unavailable).toBe('completion_gap_shorter_than_set_duration')
    expect(t[1]).not.toHaveProperty('estimated_idle_before_sec')
    expect(t[1]).not.toHaveProperty('estimated_same_exercise_recovery_sec')
  })

  test('no passive-overlap estimate when intervening sets have unsupported duration',()=>{
    const s = structuredClone(raw)
    s[1].target={mode:'time'}
    s[1].sets=[{done:true,sec:45,at:base+240000}]
    const t = estimateWorkoutRest(timeline,s).timeline
    expect(t[2].estimated_same_exercise_recovery_sec).toBe(216)
    expect(t[2]).not.toHaveProperty('estimated_passive_since_previous_same_exercise_sec')
    expect(t[2]).not.toHaveProperty('estimated_idle_before_sec')
  })
})

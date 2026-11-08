import { describe, expect, test } from 'vitest'
import { workoutMuscleProfiles, addMuscleOverlap } from '../src/muscle-overlap.js'
import { estimateWorkoutRest } from '../src/rest-estimation.js'

const start = Date.parse('2026-11-08T14:00:00Z')
const log = (r, t, opts={}) => ({ done: true, r, w: 60, at:start + 1000 * t, ...opts })
const event = (id, entry, index, t, order) => ({
  exercise_id:id,entry_index:entry,set_index:index,set_number:index+1,
  completed_at_ms:start+1000*t,completion_order:order,
})
function run(entries, order, customEx=[]) {
  const profiles = workoutMuscleProfiles(entries, {customEx})
  const rawTimeline = order.map(([entry,index,t],i)=>event(entries[entry].id,entry,index,t,i+1))
  const {timeline} = estimateWorkoutRest(rawTimeline,entries)
  const model = addMuscleOverlap(timeline,entries,profiles)
  return { profiles, timeline, model }
}

describe('OpenGym muscle-metadata based set overlap',()=>{
  test('reuse actual catalogue: lat pulldown and row share upper-back and biceps',()=>{
    const entries = [
      {id:'2291',sets:[log(12,120),log(11,360)]},
      {id:'2661',sets:[log(12,240)]},
    ]
    const original = JSON.stringify(entries)
    const {profiles,timeline:t,model} = run(entries,[[0,0,120],[1,0,240],[0,1,360]])
    expect(model).toMatchObject({available:true,completed_set_count:3,timestamped_set_count:3,mapped_work_set_count:3})
    expect(profiles[0]).toMatchObject({muscle_source:'catalogue',muscle_weights:{'upper-back':1,biceps:0.4,forearm:0.4},primary_muscles:['upper-back']})
    expect(profiles[1].muscle_weights).toEqual({'upper-back':1,biceps:0.4})
    expect(t[1].latest_overlapping_set).toMatchObject({exercise_id:'2291',shared_muscles:['upper-back','biceps']})
    expect(t[2].latest_overlapping_set).toMatchObject({exercise_id:'2661',shared_muscles:['upper-back','biceps']})
    expect(t[2].last_work_by_muscle['upper-back'].elapsed_since_completion_sec).toBe(120)
    expect(t[2].last_work_by_muscle['upper-back'].estimated_sec_until_current_set_start).toBe(87)
    expect(t[2].last_work_by_muscle.forearm.exercise_id).toBe('2291')
    expect(t[2]).toMatchObject({
      intervening_overlapping_set_count:1,
      intervening_overlapping_sets:[{exercise_id:'2661',set_number:1,shared_muscles:['upper-back','biceps']}],
      intervening_muscle_load:{'upper-back':1,biceps:0.4},
      intervening_muscle_set_counts:{'upper-back':1,biceps:1},
    })
    expect(JSON.stringify(entries)).toBe(original) // pure / no profile leakage
  })

  test('a leg press interleaved with rowing is not automatically classified as shared local muscle load',()=>{
    const entries=[{id:'2267',sets:[log(17,120),log(15,360)]},{id:'2661',sets:[log(16,240)]}]
    const {timeline:t} = run(entries,[[0,0,120],[1,0,240],[0,1,360]])
    expect(t[1]).not.toHaveProperty('latest_overlapping_set')
    expect(t[2].latest_overlapping_set.exercise_id).toBe('2267')
    expect(t[2]).toMatchObject({intervening_overlapping_set_count:0, intervening_overlapping_sets:[],intervening_muscle_load:{},intervening_muscle_set_counts:{}})
  })

  test('reports multiple overlapping sets by muscle, ignoring unrelated and warm-up work',()=>{
    const entries=[
      {id:'2291',sets:[log(12,60),log(8,420)]},
      {id:'2661',sets:[log(12,120),log(8,300,{phase:'warmup'})]},
      {id:'11254',sets:[log(15,180)]},
      {id:'2267',sets:[log(15,240)]},
    ]
    const {timeline:t} = run(entries,[[0,0,60],[1,0,120],[2,0,180],[3,0,240],[1,1,300],[0,1,420]])
    expect(t[4].muscle_overlap_unavailable).toBe('warmup_or_incomplete_set')
    expect(t[5]).toMatchObject({intervening_overlapping_set_count:2,intervening_muscle_load:{'upper-back':1.4,biceps:0.4}})
    expect(t[5].intervening_overlapping_sets.map(x=>x.exercise_id)).toEqual(['2661','11254'])
    expect(t[5].last_work_by_muscle['upper-back'].exercise_id).toBe('11254')
    expect(t[5].last_work_by_muscle.biceps.exercise_id).toBe('2661')
  })

  test('resolves historical overrides, current customs, deleted customs with snapshots, and non-informative unknowns independently',()=>{
    const entries=[
      {id:'cx-custom',sets:[log(10,60)]},
      {id:'cx-deleted',muscleSnapshot:{muscleWeights:{quadriceps:1,hamstring:0.4}},sets:[log(8,120)]},
      {id:'unknown-ex',sets:[log(10,180)]},
      {id:'2267',muscleWeights:{chest:1,quadriceps:0},sets:[log(8,240)]},
      {id:'cx-fallback',sets:[log(9,300)]},
    ]
    const profiles=workoutMuscleProfiles(entries,{customEx:[
      {id:'cx-custom',n:'custom',bp:'back',muscleWeights:{triceps:1,biceps:0.4}},
      {id:'cx-fallback',n:'legacy',bp:'upper arms'},
    ]})
    expect(profiles[0]).toMatchObject({muscle_source:'profile_custom',muscle_weights:{triceps:1,biceps:0.4}})
    expect(profiles[1]).toMatchObject({muscle_source:'history_snapshot',muscle_weights:{quadriceps:1,hamstring:0.4}})
    expect(profiles[2]).toMatchObject({muscle_source:'unmapped',muscle_weights:{}})
    expect(profiles[3]).toMatchObject({muscle_source:'history_override',muscle_weights:{chest:1}})
    expect(profiles[4]).toMatchObject({muscle_source:'body_part_fallback',muscle_weights:{biceps:0.5,triceps:0.5}})
  })

  test('incomplete timestamp history disables chronological assertions but keeps exercise metadata',()=>{
    const entries=[{id:'2291',sets:[log(10,60),{done:true,r:8,w:60}]},{id:'2661',sets:[log(10,120)]}]
    const {profiles,timeline:t,model} = run(entries,[[0,0,60],[1,0,120]])
    expect(profiles[0].muscle_weights).toHaveProperty('upper-back',1)
    expect(model.available).toBe(false)
    expect(t.every(e=>e.muscle_overlap_unavailable==='incomplete_set_timestamps')).toBe(true)
    expect(t[1]).not.toHaveProperty('last_work_by_muscle')
  })

  test('an implausibly close check-off stays in raw timeline but is not counted as recent muscular work',()=>{
    const entries=[
      {id:'0294',sets:[log(11,100)]},
      {id:'0430',sets:[log(12,105),log(9,300)]},
    ]
    const {timeline:t,model} = run(entries,[[0,0,100],[1,0,105],[1,1,300]])
    expect(t[1].rest_estimate_unavailable).toBe('completion_gap_shorter_than_set_duration')
    expect(t[1].muscle_overlap_unavailable).toBe('implausible_completion_order')
    expect(model.mapped_work_set_count).toBe(2)
    expect(t[2]).not.toHaveProperty('latest_overlapping_set')
  })

  test('does not fabricate effort proximity or failure from muscle metadata',()=>{
    const entries=[{id:'2291',sets:[log(10,60),log(8,300)]}]
    const {timeline:t} = run(entries,[[0,0,60],[0,1,300]])
    for(const event of t) {
      expect(event).not.toHaveProperty('actual_rir')
      expect(event).not.toHaveProperty('assumed_rir')
      expect(event).not.toHaveProperty('muscle_recovery_percent')
      expect(event).not.toHaveProperty('fatigue_score')
    }
  })
})

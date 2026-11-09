import { describe, expect, it } from 'vitest'
import { nextPrescription, readSession } from './progression.js'

const chest = '0576'
const routine = { id: 'full-body' }
const cfg = {id:chest, sets:3, reps:10, weight:47.5, prog:'linear'}
const S = (rows, target={sets:3,reps:10,weight:47.5}) => ({unit:'kg',workouts:[{
  d:'2026-11-08',routineId:routine.id,routineIds:[routine.id],
  entries:[{id:chest,rid:routine.id,target,sets:rows.map(([w,r])=>({w,r,done:true}))}]
}]})

// A representative real-world scenario: the middle of a session includes one
// heavy test set, not three sets performed at that weight.
describe('mixed-load progression: the experiment is not the entire working baseline',()=>{
  it('does not recommend the one-off heavy load for the whole next workout',()=>{
    const state = S([[47.5,13],[47.5,11],[52.5,6],[47.5,7]],{sets:3,reps:10,weight:47.5})
    for(const prog of ['linear','greyskull','double','triple']){
      const p=nextPrescription(state,{...cfg,prog,...(prog==='double'||prog==='triple'?{repsMin:8}:{}),...(prog==='triple'?{setsMax:4}:{})},routine)
      expect(p.kind,prog).toBe('hold')
      expect(p.weight,prog).toBe(47.5)
      expect(p.why[0],prog).toMatch(/Mixed working weights/)
    }
  })

  it('does not advance even if every set met its rep target at different loads',()=>{
    const state = S([[47.5,12],[47.5,12],[52.5,12]])
    for(const prog of ['linear','greyskull','double','triple']){
      const p=nextPrescription(state,{...cfg,prog,...(prog==='double'||prog==='triple'?{repsMin:8}:{}),...(prog==='triple'?{setsMax:4}:{})},routine)
      expect(p.kind,prog).toBe('hold')
      expect(p.weight,prog).toBe(47.5)
    }
  })

  it('prefers the actual majority load even if the plan contained an obsolete weight',()=>{
    const s=readSession(S([[50,10],[50,10],[52.5,10]]).workouts[0].entries[0])
    expect(s.workingWeight).toBe(50)
    expect(s.mixedLoads).toBe(true)
  })

  it('on a tie prefers the planned load, otherwise the first work load',()=>{
    const rows=[[52.5,10],[47.5,10]]
    const a=readSession(S(rows,{sets:2,reps:10,weight:47.5}).workouts[0].entries[0])
    const b=readSession(S(rows,{sets:2,reps:10,weight:45}).workouts[0].entries[0])
    expect(a.workingWeight).toBe(47.5)
    expect(b.workingWeight).toBe(52.5)
  })

  it('retains normal progression when working loads match',()=>{
    const p=nextPrescription(S([[47.5,12],[47.5,12],[47.5,12]]),cfg,routine)
    expect(p).toMatchObject({kind:'up',weight:50})
  })

  it('does not confuse planned back-off sets with unplanned heavy experiments',()=>{
    const target={sets:3,reps:10,weight:52.5,backoffStep:2.5}
    const entry={id:chest,target,sets:[[52.5,10],[50,10],[47.5,10]].map(([w,r])=>({w,r,done:true}))}
    expect(readSession(entry).mixedLoads).toBe(false)
    expect(readSession(entry).weight).toBe(52.5)
  })

  it('does not infer a load change from an extra fourth test set',()=>{
    const state=S([[47.5,10],[47.5,10],[47.5,10],[52.5,3]])
    const p=nextPrescription(state,cfg,routine)
    expect(p).toMatchObject({kind:'up',weight:50})
  })
})

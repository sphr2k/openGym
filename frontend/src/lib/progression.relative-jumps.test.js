import { describe, expect, it } from 'vitest'
import { excessiveLoadJump, MAX_AUTO_LOAD_JUMP_PCT, nextPrescription } from './progression.js'

const from = (id,w,reps,goal=10,extra={}) => ({
  unit:'kg', workouts:[{d:'2026-11-08',entries:[{
    id, target:{sets:3,reps:goal,weight:w},
    sets:reps.map(r=>({w,r,done:true})),
  }]}],...extra,
})
const cfg = (id,w,policy='linear',extra={})=>({id,sets:3,reps:10,weight:w,prog:policy,...extra})

describe('avoid disproportionate automatic weight increments',()=>{
  it('conservatively caps automatic jumps without changing manual increments',()=>{
    expect(MAX_AUTO_LOAD_JUMP_PCT).toBe(15)
    expect(excessiveLoadJump(6,8.5)).toBe(true)
    expect(excessiveLoadJump(155,160)).toBe(false)
    expect(excessiveLoadJump(100,115)).toBe(false)
  })
  it('holds reverse flies at 6 kg instead of automatically adding 42% load',()=>{
    const x=nextPrescription(from('11254',6,[16,12,12]),cfg('11254',6))
    expect(x).toMatchObject({kind:'hold',weight:6})
    expect(x.why[0]).toMatch(/automatic-step limit/)
  })
  it('also guards double and triple progression on light isolation exercises',()=>{
    const double=nextPrescription(from('11254',6,[12,12,12],12),cfg('11254',6,'double',{reps:12,repsMin:8}))
    expect(double).toMatchObject({kind:'hold',weight:6,reps:12})
    const triple=nextPrescription(from('11254',6,[12,12,12],12),cfg('11254',6,'triple',{reps:12,repsMin:8,setsMax:3}))
    expect(triple).toMatchObject({kind:'hold',weight:6,reps:12,sets:3,rowReps:[12,12,12]})
  })
  it('continues normally with modest increments on compound lifts',()=>{
    expect(nextPrescription(from('2267',155,[17,15,17]),cfg('2267',155)).weight).toBe(160)
    expect(nextPrescription(from('0576',47.5,[13,11,10]),cfg('0576',47.5)).weight).toBe(50)
  })
  it('allows Greyskull to use one increment when the double would be disproportionate',()=>{
    const p=nextPrescription(from('0576',20,[10,10,20]),cfg('0576',20,'greyskull'))
    expect(p).toMatchObject({kind:'up',weight:22.5})
  })
  it('does not invent a progressable weight when the available dumbbell step is too large',()=>{
    const p=nextPrescription(from('0294',12,[11,12,12],10),cfg('0294',12))
    expect(p.kind).toBe('hold')
    expect(p.weight).toBe(12)
  })
})

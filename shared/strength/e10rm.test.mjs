import {test} from 'node:test'
import assert from 'node:assert/strict'
import {estimateSet,calibrate,strengthProgress,explainEstimate} from './e10rm.ts'
const set=(w,r,rir=0,done=true)=>({w,r,rir,done})
const workout=(id,d,sets)=>({id,d,entries:[{id:'chest',sets}]})
test('Epley is anchored at ten reps and uses observed RIR',()=>{
 assert.equal(estimateSet(set(50,10)).value,50)
 assert.equal(estimateSet(set(50,8,2)).value,50)
 assert.equal(estimateSet(set(50,12)).value,52.5)
 assert.equal(estimateSet(set(50,15)).pr_eligible,true)
 assert.equal(estimateSet(set(50,16)).range_quality,'high_rep_extrapolation')
 assert.equal(estimateSet(set(50,30)).pr_eligible,false)
 assert.equal(estimateSet(set(50,31)),null)
 assert.equal(estimateSet({...set(50,10),warmup:true}),null)
 assert.equal(estimateSet({...set(50,10),done:false}),null)
 assert.equal(estimateSet({w:50,r:10,done:true}).rir_source,'assumed_zero')
 assert.equal(estimateSet({w:50,r:8,rpe:8,done:true}).value,50)
})
test('PR, workout series, and last-five median come from real sets',()=>{
 const w=[workout('a','2026-10-01',[set(50,10)]),workout('b','2026-10-08',[set(50,12)]),workout('c','2026-10-15',[set(48,10)])]
 const p=strengthProgress(w,'chest')
 assert.equal(p.all_time_pr.value,52.5)
 assert.equal(p.all_time_pr.workout_id,'b')
 assert.equal(p.trend,50)
 assert.equal(p.model.method,'epley')
 assert.match(explainEstimate(p.all_time_pr,p.model,'de'),/Standardformel/)
})
test('independent exercise IDs never share trends',()=>{
 const p=strengthProgress([workout('a','2026-10-01',[set(50,10)])],'row')
 assert.equal(p.all_time_pr,null)
})
test('individual calibration only activates with enough chronologically validated data',()=>{
 const rows=Array.from({length:24},(_,i)=>{
   const d=new Date(Date.UTC(2026,8,1+i*3)).toISOString().slice(0,10)
   const reps=7+(i%8)
   const strength=60*Math.exp(.006*i)
   const weight=strength*Math.exp(-.045*(reps-10))
   return workout('w'+i,d,[set(weight,reps)])
 })
 const m=calibrate(rows,'chest')
 assert.equal(m.sample_count,24)
 assert.equal(m.workout_count,24)
 assert.ok(['validated','validation_not_better'].includes(m.status))
 // No unvalidated model is ever selected.
 if(m.method==='individual_exponential') assert.equal(m.status,'validated')
})

test('21-rep estimates are visible as extrapolations but never PRs or calibration rows',()=>{
 const result=estimateSet({w:6,r:21,done:true})
 assert.equal(result.value,7.65)
 assert.equal(result.method,'epley')
 assert.equal(result.rir_source,'assumed_zero')
 assert.equal(result.range_quality,'high_rep_extrapolation')
 assert.equal(result.pr_eligible,false)
 assert.match(explainEstimate(result,{method:'epley',status:'insufficient_data'},'de','kg'),/unsichere Extrapolation/)
 const rows=[workout('first','2026-10-01',[set(6,21)]),workout('second','2026-10-09',[set(7,10)])]
 const progress=strengthProgress(rows,'chest')
 assert.equal(progress.series.length,1)
 assert.equal(progress.all_time_pr.value,7)
 assert.equal(progress.trend,7)
 assert.equal(progress.model.sample_count,1)
})
test('personal models do not extrapolate beyond their validated range',()=>{
 const model={method:'individual_exponential',k:.05,status:'validated',sample_count:16,workout_count:12,window_days:84}
 assert.equal(estimateSet(set(20,10),model).method,'individual_exponential')
 const high=estimateSet(set(6,21),model)
 assert.equal(high.method,'epley')
 assert.equal(high.value,7.65)
 assert.match(explainEstimate(high,model,'en','kg'),/Outside the validated rep range/)
})
test('explanations preserve pounds rather than inventing a kg conversion',()=>{
 const result=estimateSet(set(40,10))
 assert.match(explainEstimate(result,{status:'insufficient_data'},'de','lb'),/40\.0 lb/)
 assert.match(explainEstimate(result,{status:'insufficient_data'},'en','lb'),/40\.0 lb/)
 assert.doesNotMatch(explainEstimate(result,{},'en','lb'),/kg/)
})

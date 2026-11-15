// Shared pure TypeScript-compatible calculations. No profile/model state is persisted.
// Node >=22.18 supports native type stripping; Vite imports this module directly.
export const E10RM_VERSION = '1.1.0'
export const BASELINE_FORMULA = 'weight * (30 + reps + RIR) / 40'
export const PERSONAL_FORMULA = 'weight * exp(k * (reps + RIR - 10))'
export const BASE_K = Math.log(41 / 40)
export const STANDARD_MAX_EFFECTIVE_REPS = 15
export const DISPLAY_MAX_EFFECTIVE_REPS = 30
const DAY = 86400000
const finite = n => typeof n === 'number' && Number.isFinite(n)
const dateMs = s => { const t=Date.parse(s); return Number.isFinite(t) ? t : null }
const median = xs => { if (!xs.length) return null; const a=[...xs].sort((a,b)=>a-b); return a.length%2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2 }
export function effortForSet(s) {
  if (finite(s?.rir) && s.rir>=0 && s.rir<=10) return {rir:s.rir,source:'logged_rir'}
  if (finite(s?.rpe) && s.rpe>=0 && s.rpe<=10) return {rir:10-s.rpe,source:'logged_rpe'}
  if (s?.failure===true || s?.toFailure===true) return {rir:0,source:'failure'}
  return {rir:0,source:'assumed_zero'}
}
export function estimateSet(s, model=null) {
  const weight=Number(s?.w ?? s?.weight), reps=Number(s?.r ?? s?.reps)
  if(s?.done===false || s?.warmup || s?.warmUp || s?.phase==='warmup' || !finite(weight) || weight<=0 || !Number.isInteger(reps) || reps<1) return null
  const effort=effortForSet(s), effectiveReps=reps+effort.rir
  if(effectiveReps<6 || effectiveReps>DISPLAY_MAX_EFFECTIVE_REPS) return null
  // Display high-rep estimates as explicitly lower-confidence extrapolations, never PRs.
  // A personalized curve is validated in the regular 6-15 rep range, not beyond it.
  const extrapolated=effectiveReps>STANDARD_MAX_EFFECTIVE_REPS
  const personal=!extrapolated && model?.method==='individual_exponential'
  const k=personal?model.k:null
  const value=personal?weight*Math.exp(k*(effectiveReps-10)):weight*(30+effectiveReps)/40
  if(!Number.isFinite(value)||value<=0)return null
  return {value,weight,reps,rir:effort.rir,rir_source:effort.source,effective_reps:effectiveReps,
    method:personal?'individual_exponential':'epley',formula:personal?PERSONAL_FORMULA:BASELINE_FORMULA,
    ...(personal?{k}:{}),range_quality:extrapolated?'high_rep_extrapolation':'standard',
    pr_eligible:!extrapolated,model_version:E10RM_VERSION}
}
// Use the first eligible, explicitly rated work set in each workout for calibration.
// This avoids treating ordinary within-session fatigue as a repetition/load relationship.
function calibrationRows(workouts, exerciseId, days=84) {
  const ordered=[...workouts].filter(w=>dateMs(w.d)!=null).sort((a,b)=>dateMs(a.d)-dateMs(b.d))
  const latest=dateMs(ordered.at(-1)?.d)
  const out=[]
  for(const w of ordered){
    if(latest-dateMs(w.d)>days*DAY)continue
    for(const entry of w.entries||[]){
      if(String(entry.id)!==String(exerciseId))continue
      const first=(entry.sets||[]).find(s=>{
        const e=estimateSet(s)
        return s?.done===true && e?.pr_eligible && e.rir_source!=='assumed_zero' && !s.sides
      })
      if(first){const e=estimateSet(first);out.push({t:(dateMs(w.d)-latest)/DAY/7,x:e.effective_reps-10,y:Math.log(e.weight),date:w.d,id:w.id});break}
    }
  }
  return out
}
const fitAB=(rows,transform)=>{
  const ts=rows.map(r=>r.t),ys=rows.map(r=>r.y+transform(r))
  const tbar=ts.reduce((a,b)=>a+b,0)/rows.length,ybar=ys.reduce((a,b)=>a+b,0)/rows.length
  const denom=ts.reduce((sum,t)=>sum+(t-tbar)**2,0)+2
  const b=ts.reduce((sum,t,i)=>sum+(t-tbar)*(ys[i]-ybar),0)/denom
  return {a:ybar-b*tbar,b}
}
const predict=(p,r,shift)=>p.a+p.b*r.t-shift(r)
const rmse=(rows,p,shift)=>Math.sqrt(rows.reduce((sum,r)=>sum+(r.y-predict(p,r,shift))**2,0)/rows.length)
export function calibrate(workouts, exerciseId) {
  const rows=calibrationRows(workouts,exerciseId)
  const fallback={method:'epley',formula:BASELINE_FORMULA,model_version:E10RM_VERSION, sample_count:rows.length,
    workout_count:new Set(rows.map(r=>r.id||r.date)).size,status:'insufficient_data'}
  if(rows.length<12 || fallback.workout_count<8 || Math.max(...rows.map(r=>r.x))-Math.min(...rows.map(r=>r.x))<4)return fallback
  const cutoff=Math.floor(rows.length*.75), train=rows.slice(0,cutoff), test=rows.slice(cutoff)
  if(test.length<3 || new Set(train.map(r=>r.date)).size<6) return fallback
  const baseShift=r=>Math.log((40+r.x)/40)
  const base=fitAB(train,baseShift)
  // Partial out the time trend before estimating the rep slope; ridge shrink to Epley.
  const temporal=fitAB(train,()=>0)
  const xbar=train.reduce((a,r)=>a+r.x,0)/train.length
  const tbar=train.reduce((a,r)=>a+r.t,0)/train.length
  const xt=train.reduce((a,r)=>a+(r.x-xbar)*(r.t-tbar),0)/
    (train.reduce((a,r)=>a+(r.t-tbar)**2,0)+2)
  const xx=train.reduce((a,r)=>{const xres=r.x-xbar-xt*(r.t-tbar);return a+xres*xres},0)
  const xy=train.reduce((a,r)=>{const xres=r.x-xbar-xt*(r.t-tbar);return a+xres*(r.y-temporal.a-temporal.b*r.t)},0)
  const ridge=80, k=Math.max(.012,Math.min(.055,(ridge*BASE_K-xy)/(ridge+xx)))
  const shift=r=>k*r.x, personalised=fitAB(train,shift)
  const baseline_error=rmse(test,base,baseShift),individual_error=rmse(test,personalised,shift)
  const meta={sample_count:rows.length,workout_count:fallback.workout_count,
    training_count:train.length,validation_count:test.length,
    baseline_validation_rmse:baseline_error,individual_validation_rmse:individual_error,
    k,window_days:84,model_version:E10RM_VERSION}
  if(!Number.isFinite(individual_error)||individual_error>=baseline_error*.95)
    return {...fallback,...meta,status:'validation_not_better'}
  return {...meta,method:'individual_exponential',formula:PERSONAL_FORMULA,status:'validated'}
}
export function strengthProgress(workouts, exerciseId) {
  const model=calibrate(workouts,exerciseId),series=[]
  for(const w of [...workouts].sort((a,b)=>String(a.d).localeCompare(String(b.d)))){
    let best=null
    for(const entry of w.entries||[]){
      if(String(entry.id)!==String(exerciseId)) continue
      for(const [index,s] of (entry.sets||[]).entries()){
        for(const side of s?.sides?[s.sides.L,s.sides.R]:[s]){
          if(side?.done!==true)continue
          const result=estimateSet({...side,warmup:s?.warmup||s?.warmUp||s?.phase==='warmup'},model)
          if(result?.pr_eligible && (!best || result.value>best.value))best={...result,set_index:index,workout_id:w.id||null,date:w.d}
        }
      }
    }
    if(best)series.push(best)
  }
  const pr=series.reduce((best,r)=>!best||r.value>best.value?r:best,null)
  const recent=series.slice(-5)
  return {exercise_id:String(exerciseId),model,formula:model.formula,series,all_time_pr:pr,
    trend:median(recent.map(x=>x.value)),trend_sample_count:recent.length,model_version:E10RM_VERSION}
}
export function explainEstimate(result, model, language='en', unit='kg') {
  if(!result)return ''
  const de=language.toLowerCase().startsWith('de')
  const personal=result.method==='individual_exponential'
  const extrapolated=result.range_quality==='high_rep_extrapolation'
  const assumption=result.rir_source==='assumed_zero'
  const input=de
    ? 'Aus '+result.weight+' '+unit+' × '+result.reps+' Wiederholungen'+(assumption?' (RIR nicht erfasst; für die Rechnung 0 angenommen)':' bei RIR '+result.rir)+' ergibt sich ein geschätztes 10RM von '+result.value.toFixed(1)+' '+unit+'. '
    : 'From '+result.weight+' '+unit+' × '+result.reps+' reps'+(assumption?' (RIR not recorded; assumed zero for this calculation)':' at RIR '+result.rir)+', the estimated 10RM is '+result.value.toFixed(1)+' '+unit+'. '
  const selection=personal
    ? (de
      ? 'Die individuelle Wiederholungskurve wurde aus '+model.sample_count+' bewerteten Sätzen in '+model.workout_count+' Trainingseinheiten der letzten '+model.window_days+' Tage berechnet und sagte spätere Sätze besser voraus als die Standardformel (k='+model.k.toFixed(4)+'). '
      : 'An individual curve fitted from '+model.sample_count+' rated sets across '+model.workout_count+' workouts in the last '+model.window_days+' days outperformed the baseline in chronological validation (k='+model.k.toFixed(4)+'). ')
    : (extrapolated && model?.method==='individual_exponential'
      ? (de?'Außerhalb des validierten Wiederholungsbereichs wird statt der individuellen Kurve die Epley-Standardformel verwendet. ':'Outside the validated rep range, the Epley baseline is used instead of the individual curve. ')
      : (de
        ? 'Es wird die Epley-Standardformel verwendet'+(model?.status==='validation_not_better'?', weil die individuelle Kurve spätere Sätze nicht besser vorhersagte':', weil noch nicht genügend vergleichbare historische Daten zur individuellen Kalibrierung vorliegen')+'. '
        : 'The Epley baseline is used'+(model?.status==='validation_not_better'?' because personalization did not predict subsequent sets better':' because there is not yet enough comparable history for personalization')+'. '))
  const warning=extrapolated
    ? (de?'Mehr als 15 effektive Wiederholungen: unsichere Extrapolation, nicht für Bestleistungen oder den Kraftverlauf berücksichtigt. ':'More than 15 effective reps: lower-confidence extrapolation, excluded from strength PRs and trends. ')
    : ''
  return input+selection+warning+(de?'Das ist eine Schätzung, kein gemessenes 10RM. Formel: ':'This is an estimate, not a measured 10RM. Formula: ')+result.formula+'.'
}

// Shared profile shapes for Node/Docker and Cloudflare contract tests.
// Synthetic and deterministic: no personal data, no persistence implementation.
const hash = "a".repeat(64);
export function representativeProfile(count) {
  const workouts = Array.from({length:count}, (_,i) => ({
    id:`workout-${i}`,
    d:`2026-${String(1+(Math.floor(i/28)%12)).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`,
    start:1700000000000+i*86400000, end:1700002000000+i*86400000,
    name:i%3===0?"Ganzkörper 🐢":"Full body",
    entries:Array.from({length:3}, (_,e) => ({
      id:`exercise-${e}`,
      sets:Array.from({length:4}, (_,j) => ({
        w:50+i%35+e*2,r:8+j,done:true,rir:j%3,
        at:1700000000000+i*86400000+j*90000,
        ...(j===3?{type:"dropset",drops:[{w:25,r:5}]}:{})
      }))
    })),
    ...(i%80===0?{media:[{hash}]}:{})
  }));
  return {
    workouts,
    routines:[{id:"routine-1",name:"Full body",ex:["exercise-0","exercise-1"]}],
    bodyweight:[{d:"2026-01-01",w:75,t:1700000000000}],
    measurements:[{d:"2026-01-01",t:1700000000000,waist:80}],
    customEx:[{id:"custom-1",name:"Unknown upstream extension",fields:{future:[null,0,false]}}],
    settings:{units:"kg",unknown:{arr:[null,false,{},["🦄"]] }},
    dayPhotos:{"2026-01-01":{_ts:1700000000000,m:{hash}}},
    deleted:{workouts:{"removed-1":1700000000000}},
    edited:{"settings.units":1700000000000},
    _ts:1700000000000,
  };
}

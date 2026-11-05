import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { context } from "./sqlite.mjs";
import { ProfileDO } from "../src/profile.js";

import { representativeProfile } from "../../api/test/profile-fixtures.js";

function fixture() {
  const {ctx,db}=context();
  ctx.id={name:"profile:contract"};
  let gets=0,puts=0;
  const blobs=new Map();
  const env={MEDIA:{
    async put(key,data){puts++;blobs.set(key,Buffer.from(data));return {size:data.length};},
    async get(key){gets++;const b=blobs.get(key);return b?{text:async()=>b.toString("utf8")}:null;},
    async delete(keys){for(const k of [].concat(keys))blobs.delete(k);},
    async list({prefix}){return {objects:[...blobs.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key,uploaded:new Date()})),truncated:false};}
  }};
  const profile=new ProfileDO(ctx,env);
  return {db,env,profile,blobs,counts:()=>({gets,puts})};
}
const put=(state,baseRev,baseWid)=>new Request("https://opengym.test/api/data",{
  method:"PUT",headers:{"content-type":"application/json"},
  body:JSON.stringify({state,baseRev,baseWid,stamped:true})
});
const get=()=>new Request("https://opengym.test/api/data");

for(const count of [400,2000]) test(`profile contract: ${count} imported workouts and unknown upstream fields survive immutable snapshots`,async()=>{
  const f=fixture(),original=representativeProfile(count);
  const bytes=Buffer.byteLength(JSON.stringify(original));
  assert.ok(bytes<5*1024*1024,`fixture must remain within public sync protocol limit (${bytes})`);
  const start=performance.now();
  const created=await f.profile.fetch(put(original,0));
  assert.equal(created.status,200,await created.clone().text());
  const first=await created.json();
  const read=await (await f.profile.fetch(get())).json();
  for(const k of Object.keys(original))assert.deepEqual(read.state[k],original[k],`lossless ${k}`);
  assert.equal(read.rev,first.rev);
  assert.equal(f.counts().puts,1,"one complete R2 object per committed revision");
  assert.equal(f.db.prepare("SELECT count(*) n FROM profile_history").get().n,1);
  const before=f.counts().gets;
  const revision=await (await f.profile.fetch(new Request("https://opengym.test/api/data/rev"))).json();
  assert.equal(revision.rev,first.rev);
  assert.equal(f.counts().gets,before,"revision polling must not fetch the R2 profile");
  const updated={...read.state,workouts:read.state.workouts.map((w,i)=>i===30?{...w,name:"Edited on phone"}:w)};
  const revised=await f.profile.fetch(put(updated,first.rev,first.wid));
  assert.equal(revised.status,200,await revised.clone().text());
  const second=await revised.json();
  assert.equal(f.counts().puts,2);
  const after=await (await f.profile.fetch(get())).json();
  assert.equal(after.state.workouts.length,count);
  assert.equal(after.state.workouts[30].name,"Edited on phone");
  assert.equal(after.rev,second.rev);
  const stale=await f.profile.fetch(put(original,first.rev,first.wid));
  assert.equal(stale.status,409);
  console.log(JSON.stringify({fixtureWorkouts:count,profileBytes:bytes,elapsedMs:Math.round(performance.now()-start),r2Puts:f.counts().puts}));
});

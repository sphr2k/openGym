import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileDO } from "../src/profile.js";
import { context } from "./sqlite.mjs";

const url = "https://opengym.example/api/data";
const req = (method, body) => new Request(url, {
  method, ...(body ? {headers: {"Content-Type":"application/json"},body:JSON.stringify(body)}:{})
});
const parse = async response => ({status:response.status,body:await response.json()});
// Real ProfileDO tests need the same per-user identity and R2 binding as Wrangler.
function fixture() {
  const {ctx,db}=context();
  ctx.id={name:"profile:unit"};
  const objects=new Map();
  const env={MEDIA:{
    async put(k,data){objects.set(k,{data:Buffer.from(data),uploaded:new Date()});return {size:data.length};},
    async get(k){const o=objects.get(k);return o?{text:async()=>o.data.toString("utf8"),body:new Blob([o.data]).stream()}:null;},
    async delete(k){for(const x of [].concat(k))objects.delete(x);},
    async list({prefix,limit=1000}){return {objects:[...objects.entries()].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([key,v])=>({key,uploaded:v.uploaded})),truncated:false};}
  }};
  return {ctx,db,env,objects,profile:new ProfileDO(ctx,env)};
}

test("legacy initial read, write and revision polling",async()=>{
  const {profile}=fixture();
  assert.deepEqual((await parse(await profile.fetch(req("GET")))).body,{state:null,rev:0});
  const state = {workouts:[{id:"w1",d:"2026-11-03",entries:[{id:"0025",sets:[{w:66.3,r:7,at:1700000000000}]}]}],routines:[],active:{id:"local"}};
  const put = await parse(await profile.fetch(req("PUT",{state,baseRev:0,stamped:true})));
  assert.equal(put.status,200);
  assert.equal(put.body.rev,1);
  assert.equal(put.body.wid.length,16);
  const now = (await parse(await profile.fetch(req("GET")))).body;
  assert.equal(now.rev,1);
  assert.equal(now.state.active,undefined);
  assert.equal(now.state.workouts[0].entries[0].sets[0].at,1700000000000);
  const rev = await parse(await profile.fetch(new Request(url+"/rev")));
  assert.deepEqual(rev.body,{rev:1,wid:put.body.wid});
});

test("baseRev and baseWid protect writes and return original 409 shape",async()=>{
  const {profile}=fixture();
  const s={workouts:[],routines:[]};
  const first=(await parse(await profile.fetch(req("PUT",{state:s,baseRev:0,stamped:true})))).body;
  const stale=await parse(await profile.fetch(req("PUT",{state:{workouts:[{id:"should-not-write"}],routines:[]},baseRev:0})));
  assert.equal(stale.status,409);
  assert.deepEqual(Object.keys(stale.body).sort(),["error","rev","state"].sort());
  assert.equal(stale.body.rev,1);
  assert.equal(stale.body.state.workouts.length,0);
  const wrongWid=await parse(await profile.fetch(req("PUT",{state:s,baseRev:1,baseWid:"old"})));
  assert.equal(wrongWid.status,409);
  const second=(await parse(await profile.fetch(req("PUT",{state:s,baseRev:1,baseWid:first.wid,stamped:true})))).body;
  assert.equal(second.rev,2);
  const now=(await parse(await profile.fetch(req("GET")))).body.state;
  assert.equal(now._wids[0],first.wid);
});

test("concurrent writers cannot both overwrite the same revision",async()=>{
  const {profile}=fixture();
  const s=(n)=>({state:{workouts:[{id:"w"+n}],routines:[]},baseRev:0,stamped:true});
  const writes=await Promise.all([profile.fetch(req("PUT",s(1))),profile.fetch(req("PUT",s(2)))]);
  assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
  const now=(await parse(await profile.fetch(req("GET")))).body;
  assert.equal(now.state.workouts.length,1);
});

test("legacy stampPut, strict state validation and reset stamp preservation",async()=>{
  const {profile}=fixture();
  for(const invalid of [{},{_rev:12},{workouts:{},routines:[]},[],null]){
    const r=await parse(await profile.fetch(req("PUT",{state:invalid})));
    assert.equal(r.status,400);
  }
  const init={workouts:[{id:"a",d:"2026-11-01"}],routines:[],resetAt:3000,resetIds:{workouts:["old"]}};
  let result=await parse(await profile.fetch(req("PUT",{state:init,stamped:true,baseRev:0})));
  assert.equal(result.status,200);
  const old={workouts:[{id:"a",d:"2026-11-01"},{id:"new",d:"2026-11-02"}],routines:[]};
  result=await parse(await profile.fetch(req("PUT",{state:old,baseRev:1,stamped:false})));
  assert.equal(result.status,200);
  const now=(await parse(await profile.fetch(req("GET")))).body.state;
  assert.equal(now.resetAt,3000);
  assert.deepEqual(now.resetIds,{workouts:["old"]});
  assert.ok(now._wid);
});

test("server-only metadata is not exposed to clients", async()=>{
  const {profile}=fixture();
  const s={workouts:[],routines:[],_prior:{secret:1},_unstamped:{secret:2}};
  assert.equal((await profile.fetch(req("PUT",{state:s,stamped:true}))).status,200);
  const now=(await parse(await profile.fetch(req("GET")))).body.state;
  assert.equal(now._prior,undefined);
  assert.equal(now._unstamped,undefined);
});

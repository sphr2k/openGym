import {test} from "node:test";
import assert from "node:assert/strict";
import {context} from "./sqlite.mjs";
import {ProfileDO} from "../src/profile.js";
import {SNAPSHOT_GRACE_MS,ORPHAN_GRACE_MS} from "../src/profile-store.js";

const req=(state,baseRev,baseWid)=>new Request("https://opengym.test/api/data",{
  method:"PUT",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({state,baseRev,baseWid,stamped:true})
});
const data=()=>new Request("https://opengym.test/api/data");
const profileState=(workouts=[],other={})=>({workouts,routines:[],...other});
const parse=async r=>({status:r.status,body:await r.json()});

function fixture(name="tester") {
  const {ctx,db}=context();
  ctx.id={name:"profile:"+name};
  const blobs=new Map(), alarms=[];
  ctx.storage.setAlarm=async t=>{alarms.push(t);return t;};
  ctx.storage.getAlarm=async()=>alarms.at(-1)??null;
  ctx.storage.deleteAlarm=async()=>{alarms.push(null);};
  const env={MEDIA:{
    async put(key,bytes){blobs.set(key,{data:Buffer.from(bytes),uploaded:new Date()});return {size:bytes.length};},
    async get(key){const r=blobs.get(key);return r?{text:async()=>r.data.toString("utf8"),size:r.data.length,body:new Blob([r.data]).stream()}:null;},
    async delete(keys){for(const k of [].concat(keys))blobs.delete(k);},
    async list({prefix,limit=1000,cursor}) {
      const result=[...blobs.entries()].filter(([k])=>k.startsWith(prefix));
      const start=cursor?Number(cursor):0, part=result.slice(start,start+limit);
      return {objects:part.map(([key,v])=>({key,uploaded:v.uploaded})),truncated:start+limit<result.length,cursor:start+limit<result.length?String(start+limit):undefined};
    }
  }};
  return {ctx,db,env,blobs,alarms,profile:new ProfileDO(ctx,env)};
}

test("full >2 MiB immutable R2 profile, JSON fields, revision-only SQLite read and hashing",async()=>{
  const f=fixture();
  const original=profileState([{id:"w",notes:"🦆".repeat(550000)}],{other:{future:null},flags:[null,false,0,[]]});
  assert.ok(Buffer.byteLength(JSON.stringify(original))>2*1024*1024);
  const first=await parse(await f.profile.fetch(req(original,0)));
  assert.equal(first.status,200);
  assert.equal(first.body.rev,1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM profile_history").get().n,1);
  const stored=f.db.prepare("SELECT snapshot_key,sha256,revision FROM profile_meta").get();
  assert.equal(stored.revision,1);
  assert.equal(stored.sha256.length,64);
  assert.ok(f.blobs.get(stored.snapshot_key)?.data.length>2*1024*1024);
  const restored=await parse(await f.profile.fetch(data()));
  assert.deepEqual(restored.body.state.workouts[0].notes,original.workouts[0].notes);
  assert.deepEqual(restored.body.state.other,original.other);
  const previousGet=f.env.MEDIA.get;
  f.env.MEDIA.get=async()=>{throw new Error("revision endpoint should not reach R2");};
  const revision=await parse(await f.profile.fetch(new Request("https://opengym.test/api/data/rev")));
  assert.deepEqual(revision.body,{rev:1,wid:first.body.wid});
  f.env.MEDIA.get=previousGet;
});

test("two concurrent writers serialize at SQLite pointer commit and return current 409",async()=>{
  const f=fixture("cas");
  let unlock;const hold=new Promise(r=>{unlock=r;});
  let firstStaged;const pending=new Promise(r=>{firstStaged=r;});
  const originalPut=f.env.MEDIA.put.bind(f.env.MEDIA);
  let puts=0;
  f.env.MEDIA.put=async(...args)=>{
    if(++puts===1){firstStaged();await hold;}
    return originalPut(...args);
  };
  const slow=f.profile.fetch(req(profileState([{id:"slow"}]),0));
  await pending;
  const fast=await parse(await f.profile.fetch(req(profileState([{id:"fast"}]),0)));
  assert.equal(fast.status,200);
  unlock();
  const denied=await parse(await slow);
  assert.equal(denied.status,409);
  assert.equal(denied.body.state.workouts[0].id,"fast");
  assert.equal(denied.body.rev,1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM profile_history").get().n,1);
  assert.equal(f.blobs.size,2); // One committed, one orphan to reconcile.
  assert.ok(f.alarms.some(x=>typeof x==="number")); // Armed before first PUT.
});

test("staging failure rolls back SQLite current pointer and history atomically",async()=>{
  const f=fixture("fault");
  assert.equal((await f.profile.fetch(req(profileState([{id:"old"}]),0))).status,200);
  const previous=f.db.prepare("SELECT * FROM profile_meta").get();
  f.db.exec("CREATE TRIGGER abort_snapshot_history BEFORE INSERT ON profile_history WHEN new.revision>1 BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(()=>f.profile.fetch(req(profileState([{id:"new"}]),1)),/injected/);
  assert.deepEqual(f.db.prepare("SELECT * FROM profile_meta").get(),previous);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM profile_history").get().n,1);
  assert.equal((await parse(await f.profile.fetch(data()))).body.state.workouts[0].id,"old");
});

test("long inactivity keeps current snapshot and PITR window anchor, reclaims old irrelevant revisions",async()=>{
  const f=fixture("pitr");
  let last={rev:0};
  for(let i=0;i<3;i++){
    const result=await parse(await f.profile.fetch(req(profileState([{id:"w"+i}]),last.rev,last.wid)));
    assert.equal(result.status,200);
    last=result.body;
  }
  const now=Date.now(),day=86400000;
  const rows=f.db.prepare("SELECT revision,r2_key FROM profile_history ORDER BY revision").all();
  f.db.prepare("UPDATE profile_history SET committed_at=? WHERE revision=1").run(now-70*day);
  f.db.prepare("UPDATE profile_history SET committed_at=? WHERE revision=2").run(now-40*day);
  f.db.prepare("UPDATE profile_history SET committed_at=? WHERE revision=3").run(now-10*day);
  for(const item of f.blobs.values())item.uploaded=new Date(now-70*day);
  await f.profile.store.sweep(false,now);
  const retained=f.db.prepare("SELECT revision FROM profile_history ORDER BY revision").all().map(x=>x.revision);
  assert.deepEqual(retained,[2,3]);
  assert.equal(f.blobs.has(rows[0].r2_key),false);
  assert.equal(f.blobs.has(rows[1].r2_key),true);
  assert.equal(f.blobs.has(rows[2].r2_key),true);
  const inactive=fixture("inactive");
  await inactive.profile.fetch(req(profileState([{id:"never-replaced"}]),0));
  for(const item of inactive.blobs.values())item.uploaded=new Date(now-70*day);
  inactive.db.prepare("UPDATE profile_history SET committed_at=?").run(now-70*day);
  await inactive.profile.store.sweep(false,now);
  assert.equal(inactive.blobs.size,1);
  assert.equal((await parse(await inactive.profile.fetch(data()))).body.state.workouts[0].id,"never-replaced");
});

test("orphan R2 PUT is safely swept after age threshold but not before",async()=>{
  const f=fixture("orphan");
  await f.profile.fetch(req(profileState([{id:"committed"}]),0));
  const orphan=f.profile.store.prefix()+"orphan-uncommitted.json";
  f.blobs.set(orphan,{data:Buffer.from("{}"),uploaded:new Date(Date.now()-ORPHAN_GRACE_MS+1000)});
  await f.profile.store.sweep(false,Date.now());
  assert.equal(f.blobs.has(orphan),true);
  f.blobs.get(orphan).uploaded=new Date(Date.now()-ORPHAN_GRACE_MS-1000);
  await f.profile.store.sweep(false,Date.now());
  assert.equal(f.blobs.has(orphan),false);
  assert.equal(f.blobs.size,1);
});

test("account deletion during in-flight R2 PUT cannot resurrect a snapshot",async()=>{
  const f=fixture("delete-race");
  let unlock;const hold=new Promise(r=>{unlock=r;});
  let waiting;const started=new Promise(r=>{waiting=r;});
  const oldPut=f.env.MEDIA.put.bind(f.env.MEDIA);
  f.env.MEDIA.put=async (...args)=>{waiting();await hold;return oldPut(...args);};
  const pending=f.profile.fetch(req(profileState([{id:"pending"}]),0));
  await started;
  const deleted=await parse(await f.profile.fetch(new Request("https://opengym.test/_internal/delete-all",{method:"POST"})));
  assert.equal(deleted.status,200);
  unlock();
  const denied=await parse(await pending);
  assert.equal(denied.status,410);
  assert.equal(f.blobs.size,0);
  assert.equal(f.profile.store.gcActive(),true);
});

test("media GC locks before async R2 profile load so concurrent commits cannot race stale refs",async()=>{
  const f=fixture("gc-race");
  const initial=await parse(await f.profile.fetch(req(profileState([{id:"initial"}]),0)));
  assert.equal(initial.status,200);
  let release,notified;
  const held=new Promise(r=>{release=r;});
  const reached=new Promise(r=>{notified=r;});
  const read=f.env.MEDIA.get.bind(f.env.MEDIA);
  f.env.MEDIA.get=async (...args)=>{notified();await held;return read(...args);};
  const gc=f.profile.alarm();
  await reached;
  const blocked=await parse(await f.profile.fetch(req(profileState([{id:"replacement"}]),initial.body.rev,initial.body.wid)));
  assert.equal(blocked.status,503);
  release();
  await gc;
  const now=await parse(await f.profile.fetch(data()));
  assert.equal(now.body.state.workouts[0].id,"initial");
});

test("unversioned concurrent writers retry and re-run stamping on latest revision",async()=>{
  const f=fixture("unversioned");
  let release,staged;
  const held=new Promise(r=>{release=r;});
  const reached=new Promise(r=>{staged=r;});
  const put=f.env.MEDIA.put.bind(f.env.MEDIA);
  let count=0;
  f.env.MEDIA.put=async(...args)=>{if(++count===1){staged();await held;}return put(...args);};
  const delayed=f.profile.fetch(req(profileState([{id:"old-writer"}])));
  await reached;
  const newer=await parse(await f.profile.fetch(req(profileState([{id:"newer-writer"}]))));
  assert.equal(newer.status,200);
  release();
  const retried=await parse(await delayed);
  assert.equal(retried.status,200);
  assert.equal(retried.body.rev,2);
  assert.equal((await parse(await f.profile.fetch(data()))).body.rev,2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM profile_history").get().n,2);
});

test("R2 PUT failure cannot advance SQLite profile revision",async()=>{
  const f=fixture("r2-fail");
  assert.equal((await f.profile.fetch(req(profileState([{id:"initial"}]),0))).status,200);
  const old=f.db.prepare("SELECT revision,snapshot_key FROM profile_meta").get();
  f.env.MEDIA.put=async()=>{throw Error("injected R2 failure");};
  await assert.rejects(()=>f.profile.fetch(req(profileState([{id:"new"}]),1)),/injected R2 failure/);
  assert.deepEqual(f.db.prepare("SELECT revision,snapshot_key FROM profile_meta").get(),old);
  assert.equal((await parse(await f.profile.fetch(data()))).body.state.workouts[0].id,"initial");
});

test("post-commit alarm scheduler failure does not report an already committed write as failed",async()=>{
  const f=fixture("alarm-ack");
  let called=0;
  f.ctx.storage.setAlarm=async t=>{
    if(++called>1) throw Error("post-commit alarm scheduling failed");
    f.alarms.push(t);
  };
  const response=await parse(await f.profile.fetch(req(profileState([{id:"persisted"}]),0)));
  assert.equal(response.status,200);
  assert.equal(response.body.rev,1);
  assert.equal((await parse(await f.profile.fetch(data()))).body.state.workouts[0].id,"persisted");
});

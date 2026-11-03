import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {context} from "./sqlite.mjs";
import {ProfileDO} from "../src/profile.js";

const sha=b=>createHash("sha256").update(b).digest("hex");
const jpeg=()=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),randomBytes(124)]);
const raw=(method,path,bytes,mime="image/jpeg")=>
  new Request("https://gym.example"+path,{method,headers:{"content-type":mime},body:bytes});
const post=(path,body={})=>new Request("https://gym.example"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const state=(refs=[])=>({workouts:[],routines:[],customEx:refs.map((h,i)=>({id:"cx"+i,media:{hash:h}}))});
const parse=async r=>({status:r.status,body:await r.json()});
function fixture(name,opts={}){
  const {ctx}=context();
  ctx.id={name:"profile:"+name};
  const alarms=[];
  ctx.storage.setAlarm=async at=>alarms.push(at);
  ctx.storage.deleteAlarm=async()=>alarms.push(null);
  const blobs=opts.blobs||new Map();
  const media={
    async put(key,bytes){blobs.set(key,Buffer.from(bytes));return {size:bytes.length};},
    async get(key){const b=blobs.get(key);return b?{size:b.length,body:new Blob([b]).stream()}:null;},
    async head(key){const b=blobs.get(key);return b?{size:b.length}:null;},
    async delete(keys){for(const k of [].concat(keys))blobs.delete(k);},
    async list({prefix,limit=1000}){return {objects:[...blobs.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(key=>({key})),truncated:false};}
  };
  const env={MEDIA:media,MEDIA_GC_GRACE_DAYS:"0",...opts.env};
  return {ctx,env,blobs,alarms,profile:new ProfileDO(ctx,env)};
}

test("per-user R2 object isolation: shared bucket but separate user namespaces",async()=>{
  const a=fixture("alice");const b=fixture("bob",{blobs:a.blobs});
  const bytes=jpeg(),h=sha(bytes),key="users/alice/media/"+h;
  assert.equal((await a.profile.fetch(raw("PUT","/api/media/"+h,bytes))).status,201);
  assert.equal(a.blobs.has(key),true);
  assert.equal((await b.profile.fetch(new Request("https://gym.example/api/media/"+h))).status,404);
  const absent=await parse(await b.profile.fetch(post("/api/media/missing",{hashes:[h]})));
  assert.deepEqual(absent.body.missing,[h]);
  const other=await parse(await a.profile.fetch(post("/api/media/missing",{hashes:[h]})));
  assert.deepEqual(other.body.missing,[]);
});

test("grace-period alarm deletes only unreferenced blobs, with a readable profile",async()=>{
  const {profile,blobs,alarms}=fixture("jan");
  const a=jpeg(),b=jpeg(),ha=sha(a),hb=sha(b);
  await profile.fetch(post("/api/data",{})); // no-op 404, no media side effects
  assert.equal((await profile.fetch(raw("PUT","/api/media/"+ha,a))).status,201);
  assert.equal(alarms.length>0,true);
  assert.equal((await profile.fetch(raw("PUT","/api/media/"+hb,b))).status,201);
  // There is no saved snapshot yet: an alarm must retain every blob.
  await profile.alarm();
  assert.equal(blobs.size,2);
  const put=await profile.fetch(raw("PUT","/api/data",JSON.stringify({state:state([ha]),baseRev:0,stamped:true}),"application/json"));
  assert.equal(put.status,200);
  await profile.alarm();
  assert.equal(blobs.size,1);
  assert.equal(blobs.has("users/jan/media/"+ha),true);
  assert.equal(blobs.has("users/jan/media/"+hb),false);
  const miss=await parse(await profile.fetch(post("/api/media/missing",{hashes:[ha,hb]})));
  assert.deepEqual(miss.body.missing,[hb]);
  assert.equal(miss.body.usage.count,1);
});

test("failed R2 delete remains retryable rather than dropping SQLite state",async()=>{
  const f=fixture("retry");
  const bytes=jpeg(),h=sha(bytes);
  assert.equal((await f.profile.fetch(raw("PUT","/api/media/"+h,bytes))).status,201);
  assert.equal((await f.profile.fetch(raw("PUT","/api/data",JSON.stringify({state:state(),stamped:true}),"application/json"))).status,200);
  const original=f.env.MEDIA.delete.bind(f.env.MEDIA);
  let times=0;
  f.env.MEDIA.delete=async()=>{if(!times++){throw Error("temporary R2 outage");}return original("users/retry/media/"+h);};
  await f.profile.alarm();
  assert.equal(f.blobs.size,1);
  const metadata=f.profile.sql.exec("SELECT status FROM media_files WHERE hash=?",h).toArray()[0];
  assert.equal(metadata.status,"ready");
  await f.profile.alarm();
  assert.equal(f.blobs.size,0);
});

test("quota is atomic and refuses uploads over configured limit",async()=>{
  const f=fixture("tight",{env:{MEDIA_QUOTA_MB:"0.00015"}});
  const bytes=jpeg(),other=jpeg();
  const a=await parse(await f.profile.fetch(raw("PUT","/api/media/"+sha(bytes),bytes)));
  assert.equal(a.status,201);
  const denied=await parse(await f.profile.fetch(raw("PUT","/api/media/"+sha(other),other)));
  assert.equal(denied.status,413);
  assert.equal(denied.body.code,"media-quota");
  assert.equal(f.blobs.size,1);
});

test("account deletion's internal profile purge is idempotent, including R2",async()=>{
  const f=fixture("depart");
  const b=jpeg(),h=sha(b);
  await f.profile.fetch(raw("PUT","/api/media/"+h,b));
  const first=await parse(await f.profile.fetch(post("/_internal/delete-all")));
  assert.deepEqual(first.body,{ok:true});
  assert.equal(f.blobs.size,0);
  const second=await parse(await f.profile.fetch(post("/_internal/delete-all")));
  assert.deepEqual(second.body,{ok:true});
  assert.deepEqual((await parse(await f.profile.fetch(new Request("https://gym.example/api/data")))).body,{state:null,rev:0});
});

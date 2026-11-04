import {test} from "node:test";
import assert from "node:assert/strict";
import {context} from "./sqlite.mjs";
import {ProfileStore,CHUNK_BYTES} from "../src/profile-store.js";
import {ProfileDO} from "../src/profile.js";

const state=(extra={})=>({workouts:[],routines:[],...extra,_rev:1,_wid:"0000000000000001"});
const persist=(store,ctx,value,rev=1)=>ctx.storage.transactionSync(()=>store.save(value,rev));

test("generic fragments reconstruct unknown fields, arrays, unicode and large values",()=>{
  const {ctx,db}=context(), store=new ProfileStore(ctx.storage);
  const original=state({
    empty:[],nul:null,zero:0,flag:false,string:"",unused:{dynamic:["future",null,false,{_f:{"new":123}}]},
    workouts:[{id:"a",media:{hash:"abc"}}, {id:"b",text:"🤸🏼‍♂️💪".repeat(70000)}],
    routines:[{id:"r1",name:"μικρός"}],
  });
  persist(store,ctx,original);
  assert.deepEqual(store.current(),{state:original,rev:1});
  const large=db.prepare("SELECT COUNT(*) AS n FROM profile_fragments WHERE field='workouts' AND item_index=1").get().n;
  assert.ok(large>1);
  for(const row of db.prepare("SELECT length(payload) AS size FROM profile_fragments").all())
    assert.ok(row.size<=CHUNK_BYTES);
  const updated={...original,workouts:[original.workouts[1],{id:"new"}],empty:null,routines:[],fresh:{flag:"extra"},_rev:2,_wid:"0000000000000002"};
  persist(store,ctx,updated,2);
  assert.deepEqual(store.current(),{state:updated,rev:2});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_fragments WHERE field='empty'").get().n,1);
  store.clear();
  assert.deepEqual(store.current(),{state:null,rev:0});
});

test("whole profiles above 2 MB persist without a giant SQLite value",()=>{
  const {ctx,db}=context(),store=new ProfileStore(ctx.storage);
  const workouts=Array.from({length:1800},(_,i)=>({id:"w"+i,entries:[{id:"exercise",sets:Array.from({length:8},(_,j)=>({w:70,r:7,at:1791000000000+i*100000+j,notes:"x".repeat(170)}))}]}));
  const s=state({workouts});
  assert.ok(Buffer.byteLength(JSON.stringify(s))>2*1024*1024);
  persist(store,ctx,s);
  assert.deepEqual(store.current(),{state:s,rev:1});
  assert.ok(db.prepare("SELECT max(length(payload)) AS max FROM profile_fragments").get().max<=CHUNK_BYTES);
});

test("unmodified rows are not rewritten for small updates",()=>{
  const {ctx,db}=context(),store=new ProfileStore(ctx.storage);
  const first=state({workouts:Array.from({length:400},(_,i)=>({id:"w"+i,notes:"data-"+i}))});
  persist(store,ctx,first);
  db.exec("CREATE TABLE frag_writes (n INTEGER)");
  db.exec("CREATE TRIGGER count_fragment_updates AFTER UPDATE ON profile_fragments BEGIN INSERT INTO frag_writes VALUES (1); END");
  db.exec("CREATE TRIGGER count_fragment_inserts AFTER INSERT ON profile_fragments BEGIN INSERT INTO frag_writes VALUES (1); END");
  db.exec("CREATE TRIGGER count_fragment_deletes AFTER DELETE ON profile_fragments BEGIN INSERT INTO frag_writes VALUES (1); END");
  const second={...first,workouts:first.workouts.map((w,i)=>i===17?{...w,notes:"changed"}:w),_rev:2,_wid:"0000000000000002"};
  persist(store,ctx,second,2);
  assert.deepEqual(store.current(),{state:second,rev:2});
  assert.ok(db.prepare("SELECT count(*) AS n FROM frag_writes").get().n<10);

});

test("fragment writes and metadata rollback as a single synchronous SQLite transaction",()=>{
  const {ctx,db}=context(),store=new ProfileStore(ctx.storage);
  const first=state({workouts:[{id:"old"}]});
  persist(store,ctx,first);
  db.exec("CREATE TRIGGER abort_fragment_insert BEFORE INSERT ON profile_fragments WHEN new.field='new' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const second={...first,new:{value:42},_rev:2,_wid:"0000000000000002"};
  assert.throws(()=>persist(store,ctx,second,2),/injected failure/);
  assert.deepEqual(store.current(),{state:first,rev:1});
  assert.equal(db.prepare("SELECT count(*) AS n FROM profile_sections WHERE field='new'").get().n,0);
});

test("temporary old-schema guard refuses to treat unmigrated profile as empty",()=>{
  const {ctx,db}=context(),store=new ProfileStore(ctx.storage);
  db.exec("CREATE TABLE document (id INTEGER PRIMARY KEY,body TEXT NOT NULL,revision INTEGER NOT NULL)");
  db.prepare("INSERT INTO document VALUES (1,?,1)").run(JSON.stringify(state()));
  assert.throws(()=>store.current(),/legacy profile schema/);
  assert.throws(()=>persist(store,ctx,state()),/legacy profile schema/);
});

test("ProfileDO still returns original revision and 409 semantics for huge nested JSON",async()=>{
  const {ctx}=context(),profile=new ProfileDO(ctx,{});
  const s={workouts:[{id:"long",notes:"🦆".repeat(90000)}],routines:[],strange:{unknown:[1,null,{"a":"v"}]}};
  const request=(payload)=>new Request("https://gym.example/api/data",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const one=await profile.fetch(request({state:s,baseRev:0,stamped:true}));
  assert.equal(one.status,200);
  const first=await one.json();
  const fetched=await (await profile.fetch(new Request("https://gym.example/api/data"))).json();
  assert.equal(fetched.state.workouts[0].notes,s.workouts[0].notes);
  assert.deepEqual(fetched.state.strange,s.strange);
  const stale=await profile.fetch(request({state:s,baseRev:0,stamped:true}));
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).rev,first.rev);
});

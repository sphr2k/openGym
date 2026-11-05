import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountDO } from "../src/accounts.js";
import { context } from "./sqlite.mjs";

const url="https://gym.example";
const req=(path,method="GET",body,headers={})=>new Request(url+path,{
  method,headers:{...(body?{"content-type":"application/json"}:{}),...headers},
  ...(body?{body:JSON.stringify(body)}:{})
});
const parsed=async r=>({status:r.status,headers:r.headers,body:await r.json()});

test("WebAuthn options persist, cannot be replayed, pairing requires fresh proof",async()=>{
  const {ctx}=context();const a=new AccountDO(ctx,{FIRST_USER_ADMIN:"true"});
  const opt=await parsed(await a.fetch(req("/api/register/options","POST",{name:"Lift Person"})));
  assert.equal(opt.status,200);
  assert.equal(opt.body.options.rp.id,"gym.example");
  assert.ok(opt.body.cid);
  const failed=await parsed(await a.fetch(req("/api/register/verify","POST",{cid:opt.body.cid,credential:{id:"fake"}})));
  assert.equal(failed.status,400);
  const replay=await parsed(await a.fetch(req("/api/register/verify","POST",{cid:opt.body.cid,credential:{id:"fake"}})));
  assert.equal(replay.body.code,"challenge-expired");

  // Inject a *test-only* signed user via the SQLite context, never a production HTTP endpoint.
  a.sql.exec("INSERT INTO users(id,name,created,admin,owner) VALUES ('u1','Tester','2026-11-03',1,1)");
  const user=a.queryOne("SELECT * FROM users WHERE id=?","u1");
  const token=await a.sign(user,"c");
  const cookie="__Host-gymsid="+token;
  const me=await parsed(await a.fetch(req("/api/me","GET",undefined,{cookie})));
  assert.deepEqual(me.body.user,{id:"u1",name:"Tester",admin:true,owner:true});
  const pair=await parsed(await a.fetch(req("/api/pair/create","POST",{}, {cookie})));
  assert.equal(pair.status,403);
  assert.equal(pair.body.code,"passkey-required");
  const invalid=await parsed(await a.fetch(req("/api/pair/redeem","POST",{code:"AAAAAAAA"})));
  assert.equal(invalid.body.code,"pair-invalid");

  // Restart the AccountDO on the same persistent SQLite database.
  const reopened=new AccountDO(ctx,{});
  const same=await parsed(await reopened.fetch(req("/api/me","GET",undefined,{cookie})));
  assert.equal(same.status,200);
  await reopened.fetch(req("/api/logout/all","POST",{}, {cookie}));
  const revoked=await parsed(await reopened.fetch(req("/api/me","GET",undefined,{cookie})));
  assert.equal(revoked.status,401);
});

test("auth token does not accept forged signatures or browser cookies as bearer",async()=>{
  const {ctx}=context();const a=new AccountDO(ctx,{});
  a.sql.exec("INSERT INTO users(id,name,created) VALUES ('u1','Tester','2026-11-03')");
  const user=a.queryOne("SELECT * FROM users WHERE id='u1'");
  const token=await a.sign(user,"c");
  const cookie="__Host-gymsid="+token;
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{authorization:"Bearer "+token}))).status,401);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{cookie:"__Host-gymsid="+token.slice(0,-1)+"!"}))).status,401);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{cookie:cookie+"; __Host-gymsid=other"}))).status,401);
});

test("account deletion revokes immediately and retries interrupted remote cleanup",async()=>{
  const {ctx}=context();
  const alarms=[];
  ctx.storage.setAlarm=async at=>alarms.push(at);
  let attempts=0,cleaned="";
  const profile={fetch:async()=>{attempts++;if(attempts===1)return new Response("failed",{status:503});cleaned="u1";return new Response('{"ok":true}',{headers:{"content-type":"application/json"}});}};
  const a=new AccountDO(ctx,{PROFILES:{getByName:()=>profile}});
  a.sql.exec("INSERT INTO users(id,name,created) VALUES ('u1','Account Owner','2026-11-03')");
  a.sql.exec("INSERT INTO credentials(id,user_id,public_key,counter,transports,created,last_used) VALUES ('test','u1','fake',0,'[]','2026-11-03','2026-11-03')");
  const user=a.queryOne("SELECT * FROM users WHERE id='u1'");
  const bearer=await a.sign(user,"b");
  const headers={authorization:"Bearer "+bearer};
  const del=await parsed(await a.fetch(req("/api/account/delete","POST",{name:"Account Owner"},headers)));
  assert.equal(del.status,200);
  assert.equal(del.body.ok,true);
  assert.equal(a.queryOne("SELECT id FROM users WHERE id='u1'"),null);
  assert.equal(a.queryOne("SELECT id FROM credentials WHERE user_id='u1'"),null);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,headers))).status,401);
  assert.equal(a.queryOne("SELECT COUNT(*) AS n FROM pending_deletions").n,1);
  assert.equal(alarms.length,1);
  await a.alarm();
  assert.equal(attempts,2);
  assert.equal(cleaned,"u1");
  assert.equal(a.queryOne("SELECT COUNT(*) AS n FROM pending_deletions").n,0);
});


test("session contract: expiry, version revocation and disabled account fail closed",async()=>{
  const {ctx}=context(),a=new AccountDO(ctx,{});
  a.sql.exec("INSERT INTO users(id,name,created,sv) VALUES ('security-u','Verifier','2026-11-04',0)");
  const user=a.queryOne("SELECT * FROM users WHERE id='security-u'");
  const cookieToken=await a.sign(user,"c");
  const bearerToken=await a.sign(user,"b");
  const cookie={cookie:"__Host-gymsid="+cookieToken};
  const bearer={authorization:"Bearer "+bearerToken};
  assert.equal((await a.fetch(req("/api/me","GET",undefined,cookie))).status,200);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,bearer))).status,200);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{authorization:"Bearer "+cookieToken}))).status,401);
  const old=Date.now()-1000,expiredPayload=["security-u",old,0,"c"].join(":");
  const signature=Buffer.from(await crypto.subtle.sign("HMAC",await a.key(),new TextEncoder().encode(expiredPayload))).toString("base64url");
  const expired={cookie:"__Host-gymsid="+expiredPayload+"."+signature};
  assert.equal((await a.fetch(req("/api/me","GET",undefined,expired))).status,401);
  a.sql.exec("UPDATE users SET sv=sv+1 WHERE id='security-u'");
  assert.equal((await a.fetch(req("/api/me","GET",undefined,cookie))).status,401);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,bearer))).status,401);
  const changed=a.queryOne("SELECT * FROM users WHERE id='security-u'");
  const fresh=await a.sign(changed,"c");
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{cookie:"__Host-gymsid="+fresh}))).status,200);
  a.sql.exec("UPDATE users SET disabled=1 WHERE id='security-u'");
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{cookie:"__Host-gymsid="+fresh}))).status,401);
});

test("session contract: malformed or ambiguous cookie cannot override a valid bearer",async()=>{
  const {ctx}=context(),a=new AccountDO(ctx,{});
  a.sql.exec("INSERT INTO users(id,name,created) VALUES ('u1','Verifier','2026-11-04')");
  const user=a.queryOne("SELECT * FROM users WHERE id='u1'");
  const good=await a.sign(user,"c");
  const bearer=await a.sign(user,"b");
  const request=cookie=>req("/api/me","GET",undefined,{cookie});
  for(const c of ["__Host-gymsid="+good+"; __Host-gymsid=other",
    "__Host-gymsid="+good+"; __Host-gymsid="+good+"!",
    "gymsid="+good+"; gymsid=other"]){
    assert.equal((await a.fetch(request(c))).status,401);
  }
  // A valid token in a supported cookie format continues to authenticate.
  assert.equal((await a.fetch(request("gymsid="+good))).status,200);
  assert.equal((await a.fetch(req("/api/me","GET",undefined,{authorization:"Bearer "+bearer}))).status,200);
  const noProof=await parsed(await a.fetch(req("/api/pair/create","POST",{}, {cookie:"gymsid="+good})));
  assert.equal(noProof.status,403);
  assert.equal(noProof.body.code,"passkey-required");
});

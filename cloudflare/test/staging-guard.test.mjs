import {test} from "node:test";
import assert from "node:assert/strict";
import cfConfig from "../cloudflare.config.ts";
import worker from "../src/index.js";

test("staging fails closed when the secret binding is missing",async()=>{
  for(const request of [
    new Request("https://staging.example/"),
    new Request("https://staging.example/api/health"),
    new Request("https://staging.example/api/register/options",{method:"POST",headers:{"content-type":"application/json"},body:'{"name":"Public"}'})
  ]){
    const r=await worker.fetch(request,{STAGING_LOCKED:"true"},{});
    assert.equal(r.status,404);
  }
});

test("staging rejects incorrect credentials and serves API after correct key",async()=>{
  const env={STAGING_LOCKED:"true",STAGING_API_KEY:"synthetic-test-key",ALLOW_GUEST:"true"};
  const missing=await worker.fetch(new Request("https://staging.example/api/config"),env,{});
  assert.equal(missing.status,404);
  const bad=await worker.fetch(new Request("https://staging.example/api/config",{headers:{"X-OpenGym-Stage-Key":"bad"}}),env,{});
  assert.equal(bad.status,404);
  const good=await worker.fetch(new Request("https://staging.example/api/config",{headers:{"X-OpenGym-Stage-Key":"synthetic-test-key"}}),env,{});
  assert.equal(good.status,200);
  assert.equal((await good.json()).allow_guest,true);
});

test("cf staging guards all assets, keeps account and profile DO namespaces, and never changes default target",()=>{
  const stage=cfConfig({mode:"staging",isPreview:false}).worker;
  const regular=cfConfig({mode:undefined,isPreview:false}).worker;
  assert.equal(stage.assets.runWorkerFirst,true,
    "all static assets must invoke the Access-aware Worker");
  assert.equal(stage.env.STAGING_LOCKED,undefined,
    "legacy header gate must not block browsers and iOS");
  assert.equal(stage.name,"opengym-cloudflare-staging");
  assert.equal(regular.name,"opengym-cloudflare");
  assert.deepEqual(regular.assets.runWorkerFirst,["/api/*"]);
  assert.deepEqual(stage.env.MEDIA,{type:"r2",name:"opengym-cloudflare-staging-media"});
  assert.deepEqual(regular.env.MEDIA,{type:"r2",name:"opengym-media"});
  for(const key of ["ACCOUNTS","PROFILES"]){
    assert.equal(stage.env[key].type,"durable-object");
    assert.equal(stage.env[key].worker,stage.name);
    assert.equal(regular.env[key].worker,regular.name);
  }
  assert.equal(stage.env.ACCOUNTS.exportName,"AccountDO");
  assert.equal(stage.env.PROFILES.exportName,"ProfileDO");
  assert.deepEqual(stage.exports.AccountDO,{type:"durable-object",storage:"sqlite"});
  assert.deepEqual(stage.exports.ProfileDO,{type:"durable-object",storage:"sqlite"});
});

test("staging binds the MCP hostname to the existing application Worker",()=>{
  const stage=cfConfig({mode:"staging",isPreview:false}).worker;
  const regular=cfConfig({mode:undefined,isPreview:false}).worker;
  assert.equal(stage.env.MCP_HOSTNAME.value, "opengym-mcp.janw.eu");
  assert.equal(regular.env.MCP_HOSTNAME, undefined);
  assert.equal(stage.entrypoint, "./src/index.js");
  assert.equal(stage.exports.AccountDO.storage, "sqlite");
  assert.equal(stage.exports.ProfileDO.storage, "sqlite");
});

test("the official Capacitor app can redeem a pairing code before it owns an openGym Bearer",async()=>{
  const account={fetch:async request=>{
    assert.equal(new URL(request.url).pathname,"/api/pair/redeem");
    return Response.json({error:"invalid or expired code",code:"pair-invalid"},{status:400});
  }};
  const env={ACCOUNTS:{getByName:()=>account}};
  const original="https://gym.example/api/pair/redeem";
  const request=new Request(original,{
    method:"POST",
    headers:{"Content-Type":"application/json","Origin":"capacitor://localhost",
      "Sec-Fetch-Site":"cross-site"},
    body:JSON.stringify({code:"expired"})
  });
  const response=await worker.fetch(request,env,{});
  assert.equal(response.status,400);
  assert.equal((await response.json()).code,"pair-invalid");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),"capacitor://localhost");
});

test("cross-origin browser attempts to redeem a pairing code are denied",async()=>{
  const env={};
  const response=await worker.fetch(new Request("https://gym.example/api/pair/redeem",{
    method:"POST",
    headers:{"Content-Type":"application/json","Origin":"https://attacker.example","Sec-Fetch-Site":"cross-site"},
    body:'{"code":"ABCD"}'
  }),env,{});
  assert.equal(response.status,403);
  assert.equal((await response.json()).code,"origin-mismatch");
});

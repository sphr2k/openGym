import {test} from "node:test";
import assert from "node:assert/strict";
import cfConfig from "../cloudflare.config.ts";
import worker from "../src/index.js";

test("legacy access-key guard fails closed when the secret binding is missing",async()=>{
  for(const request of [
    new Request("https://staging.example/"),
    new Request("https://staging.example/api/health"),
    new Request("https://staging.example/api/register/options",{method:"POST",headers:{"content-type":"application/json"},body:'{"name":"Public"}'})
  ]){
    const r=await worker.fetch(request,{STAGING_LOCKED:"true"},{});
    assert.equal(r.status,404);
  }
});

test("legacy access-key guard rejects incorrect credentials and serves API after correct key",async()=>{
  const env={STAGING_LOCKED:"true",STAGING_API_KEY:"synthetic-test-key",ALLOW_GUEST:"true"};
  const missing=await worker.fetch(new Request("https://staging.example/api/config"),env,{});
  assert.equal(missing.status,404);
  const bad=await worker.fetch(new Request("https://staging.example/api/config",{headers:{"X-OpenGym-Stage-Key":"bad"}}),env,{});
  assert.equal(bad.status,404);
  const good=await worker.fetch(new Request("https://staging.example/api/config",{headers:{"X-OpenGym-Stage-Key":"synthetic-test-key"}}),env,{});
  assert.equal(good.status,200);
  assert.equal((await good.json()).allow_guest,true);
});

test("production target is OpenGym on its custom origin and preserves DO class names",()=>{
  const prod=cfConfig({mode:undefined,isPreview:false}).worker;
  assert.equal(prod.name,"opengym");
  assert.equal(prod.workersDev,false);
  assert.equal(prod.previewUrls,false);
  assert.equal(prod.assets.runWorkerFirst,true);
  assert.equal(prod.env.APP_ORIGIN.value,"https://opengym.janwerner.de");
  assert.equal(prod.env.RP_ID.value,"opengym.janwerner.de");
  assert.deepEqual(prod.env.MEDIA,{type:"r2",name:"opengym-cloudflare-staging-media"});
  for(const key of ["ACCOUNTS","PROFILES"]){
    assert.equal(prod.env[key].worker,prod.name);
    assert.equal(prod.env[key].exportName,key==="ACCOUNTS"?"AccountDO":"ProfileDO");
  }
  assert.deepEqual(prod.exports.AccountDO,{type:"durable-object",storage:"sqlite"});
  assert.deepEqual(prod.exports.ProfileDO,{type:"durable-object",storage:"sqlite"});
});

test("the default Worker never routes deployments to the retired trial environment",()=>{
  const prod=cfConfig({mode:undefined,isPreview:false}).worker;
  assert.equal(prod.name,"opengym");
  assert.equal(prod.env.ACCOUNTS.worker,"opengym");
  assert.equal(prod.env.PROFILES.worker,"opengym");
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

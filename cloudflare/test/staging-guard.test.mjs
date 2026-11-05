import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
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

test("Access staging sends ALL static assets to Worker and does not require legacy header",()=>{
  const fs=requireJsonc();
  assert.equal(fs.assets.run_worker_first,true,
    "Cloudflare otherwise serves assets before fetch() and bypasses Access-aware routing");
  assert.equal(fs.vars.STAGING_LOCKED,undefined,"legacy header gate must not block browsers and iOS");
  assert.notEqual(fs.name,"opengym-cloudflare");
  assert.notEqual(fs.r2_buckets[0].bucket_name,"opengym-media");
});

function requireJsonc(){
  // The checked-in .jsonc contains only JSON-compatible syntax.
  return JSON.parse(readFileSync(new URL("../wrangler.staging.jsonc",import.meta.url),"utf8"));
}

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

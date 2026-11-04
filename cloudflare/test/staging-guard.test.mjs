import {test} from "node:test";
import assert from "node:assert/strict";
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

import {test} from "node:test";
import assert from "node:assert/strict";
import {jsonBody,BODY_LIMIT} from "../src/protocol.js";
import {MAX_JSON_BODY_BYTES} from "../../api/body-limits.js";
import {readBoundedBytes} from "../src/bounded-bytes.js";

const request=(body,headers={})=>new Request("https://gym.example/api/data",{
  method:"PUT",duplex:"half",
  headers:{"content-type":"application/json",...headers},
  body
});
const result=async r=>r.error?{status:r.error.status,body:await r.error.json()}:{value:r.value};

test("Node and Cloudflare JSON limits share a single 5 MiB contract",()=>{
  assert.equal(BODY_LIMIT,MAX_JSON_BODY_BYTES);
  assert.equal(BODY_LIMIT,5*1024*1024);
});

test("Workers reject oversize multibyte UTF-8 despite shorter JS string.length",async()=>{
  const tooLarge='{"note":"'+ '🐢'.repeat(Math.floor(BODY_LIMIT/4)+1) +'"}';
  assert.ok(tooLarge.length<BODY_LIMIT);
  assert.ok(Buffer.byteLength(tooLarge)>BODY_LIMIT);
  const denied=await result(await jsonBody(request(tooLarge,{"content-length":"0"})));
  assert.equal(denied.status,413);
  assert.deepEqual(denied.body,{error:"body too large"});
});

test("Workers accept exactly 5 MiB JSON bytes, refuse 5 MiB + 1",async()=>{
  const prefix='{"n":"',suffix='"}';
  const exact=prefix+'x'.repeat(BODY_LIMIT-Buffer.byteLength(prefix)-Buffer.byteLength(suffix))+suffix;
  assert.equal(Buffer.byteLength(exact),BODY_LIMIT);
  const accepted=await jsonBody(request(exact));
  assert.equal(accepted.value.n.length,BODY_LIMIT-Buffer.byteLength(prefix)-Buffer.byteLength(suffix));
  const refused=await result(await jsonBody(request(exact+" ")));
  assert.equal(refused.status,413);
});

test("stream decoder preserves UTF-8 split across chunks with a misleading Content-Length",async()=>{
  const bytes=new TextEncoder().encode('{"text":"🦄"}');
  const stream=new ReadableStream({
    start(controller){
      for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));
      controller.close();
    }
  });
  const r=await jsonBody(request(stream,{"content-length":"1"}));
  assert.deepEqual(r.value,{text:"🦄"});
});

test("invalid content type and malformed JSON retain the Node-compatible status",async()=>{
  assert.equal((await result(await jsonBody(request("notjson")))).status,400);
  assert.equal((await result(await jsonBody(request("{}",{"content-type":"text/plain"})))).status,415);
});

test("media reader uses one allocation when Content-Length is correct",async()=>{
  const data=new Uint8Array(4*1024*1024);data[0]=0xff;data[1]=0xd8;
  const input=new Request("https://gym.example/api/media/upload",{
    method:"PUT",headers:{"content-length":String(data.byteLength)},body:data
  });
  const read=await readBoundedBytes(input,data.length);
  assert.equal(read.byteLength,data.length);
  assert.equal(read.buffer.byteLength,data.length);
  assert.equal(read[0],0xff);
});

test("media reader caps body with absent or false-small Content-Length",async()=>{
  const stream=()=>new ReadableStream({
    start(c){c.enqueue(new Uint8Array(60));c.enqueue(new Uint8Array(60));c.close();}
  });
  const unknown={headers:new Headers(),body:stream()};
  const bytes=await readBoundedBytes(unknown,128);
  assert.equal(bytes.byteLength,120);
  const misleading={headers:new Headers({"content-length":"1"}),body:stream()};
  assert.equal((await readBoundedBytes(misleading,100)),null);
});

test("media reader handles empty bodies without buffer duplication",async()=>{
  const input={headers:new Headers(),body:null};
  assert.equal((await readBoundedBytes(input,1024)).byteLength,0);
});

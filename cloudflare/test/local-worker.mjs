/**
 * Real worker integration: synthetic P-256 WebAuthn authenticator, real SQLite
 * Durable Objects via wrangler dev, real HTTP and cookie/bearer paths.
 * Run against npm run dev: npm run test:integration.
 */
import { Encoder } from "cbor-x";
const encoder=new Encoder({useRecords:false,mapsAsObjects:false,variableMapSize:true});
const cbor=(v)=>encoder.encode(v);
import {
  createHash, generateKeyPairSync, randomBytes, sign
} from "node:crypto";
import assert from "node:assert/strict";

const base = process.env.OPENGYM_TEST_URL || "http://127.0.0.1:8791";
const rpID = new URL(base).hostname;
const origin = new URL(base).origin;
const j = async res => ({status:res.status,headers:res.headers,body:await res.json()});
const api = async (path, method = "GET", body, headers = {}) =>
  j(await fetch(base + path,{
    method,
    headers:{...(body?{"Content-Type":"application/json"}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})
  }));
const post=(p,b,h={})=>api(p,"POST",b,h);
const put=(p,b,h={})=>api(p,"PUT",b,h);

const {publicKey,privateKey} = generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const jwk = publicKey.export({format:"jwk"});
const credId=randomBytes(20);
const id=credId.toString("base64url");
const hash=s=>createHash("sha256").update(s).digest();
const b64=b=>Buffer.from(b).toString("base64url");
const rpHash=hash(rpID);
const client=(type,challenge)=>b64(Buffer.from(JSON.stringify({
  type,challenge,origin,crossOrigin:false
})));
const count=(i)=>{const b=Buffer.alloc(4);b.writeUInt32BE(i);return b};
const cose=cbor(new Map([
  [1,2],[3,-7],[-1,1],
  [-2,Buffer.from(jwk.x,"base64url")],
  [-3,Buffer.from(jwk.y,"base64url")]
]));
const creation=(challenge)=>{
  const len=Buffer.alloc(2);len.writeUInt16BE(credId.length);
  const authData=Buffer.concat([rpHash,Buffer.from([0x45]),count(0),Buffer.alloc(16),len,credId,cose]);
  return {
    id,rawId:id,type:"public-key",
    response:{
      clientDataJSON:client("webauthn.create",challenge),
      attestationObject:b64(cbor({fmt:"none",attStmt:{},authData})),
      transports:["internal"]
    },
    clientExtensionResults:{}
  };
};
let assertionCounter=0;
const assertion=(challenge)=>{
  const clientData=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin,crossOrigin:false}));
  const authData=Buffer.concat([rpHash,Buffer.from([0x05]),count(++assertionCounter)]);
  const sig=sign("sha256",Buffer.concat([authData,hash(clientData)]),privateKey);
  return {
    id,rawId:id,type:"public-key",
    response:{clientDataJSON:b64(clientData),authenticatorData:b64(authData),
      signature:b64(sig),userHandle:null},
    clientExtensionResults:{}
  };
};
function ok(response,where) {
  assert.equal(response.status,200,where+": "+JSON.stringify(response.body));
  return response.body;
}

function extraCredential(){
  const {publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const jk=publicKey.export({format:"jwk"}),raw=randomBytes(20),id=raw.toString("base64url");
  const coseKey=cbor(new Map([
    [1,2],[3,-7],[-1,1],[-2,Buffer.from(jk.x,"base64url")],[-3,Buffer.from(jk.y,"base64url")]
  ]));
  return {id,creation(challenge){
    const len=Buffer.alloc(2);len.writeUInt16BE(raw.length);
    const auth=Buffer.concat([rpHash,Buffer.from([0x45]),count(0),Buffer.alloc(16),len,raw,coseKey]);
    return {id,rawId:id,type:"public-key",
      response:{clientDataJSON:client("webauthn.create",challenge),
      attestationObject:b64(cbor({fmt:"none",attStmt:{},authData:auth})),transports:["internal"]},
      clientExtensionResults:{}};
  }};
}
const username="WorkerIT-"+randomBytes(3).toString("hex");
console.log("Health:",ok(await api("/api/health"),"health"));
const opt=ok(await post("/api/register/options",{name:username}),"register/options");
const verified=await post("/api/register/verify",{cid:opt.cid,credential:creation(opt.options.challenge)});
const user=ok(verified,"register/verify").user;
assert.equal(user.name,username);
const cookie=verified.headers.get("set-cookie").split(";")[0];
console.log("Registration:",user.id);
const loginCookie={Cookie:cookie};
assert.equal(ok(await api("/api/me","GET",undefined,loginCookie),"me").user.id,user.id);
let data=ok(await api("/api/data","GET",undefined,loginCookie),"data initial");
assert.deepEqual(data,{state:null,rev:0});

const initial={workouts:[{id:"w-1",d:"2026-11-03",entries:[{id:"0042",sets:[{w:66.3,r:7,at:1793741111000}]}]}],routines:[],active:{id:"local-only"}};
const v1=ok(await put("/api/data",{state:initial,baseRev:0,stamped:true},loginCookie),"put");
assert.equal(v1.rev,1);
const stale=await put("/api/data",{state:{workouts:[],routines:[]},baseRev:0},loginCookie);
assert.equal(stale.status,409);
assert.equal(stale.body.state.workouts[0].id,"w-1");
const nudge=ok(await api("/api/nudge-check?date=2026-11-03","GET",undefined,loginCookie),"nudge-check");
assert.deepEqual(nudge,{date:"2026-11-03",done:true,nudge:false,rev:1});
const malformed=await api("/api/nudge-check?date=invalid","GET",undefined,loginCookie);
assert.equal(malformed.status,400);
const current=ok(await api("/api/data","GET",undefined,loginCookie),"get");
assert.equal(current.state.active,undefined);

const loginOpt=ok(await post("/api/login/options",{}),"login/options");
const proof=assertion(loginOpt.options.challenge);
const paired=ok(await post("/api/pair/create",{cid:loginOpt.cid,credential:proof},loginCookie),"pair/create");
assert.match(paired.code,/^[A-HJ-NP-Z2-9]{8}$/);
const redeemed=ok(await post("/api/pair/redeem",{code:paired.code}),"pair/redeem");
assert.equal(redeemed.user.id,user.id);
const replay=await post("/api/pair/redeem",{code:paired.code});
assert.equal(replay.status,400);
assert.equal(replay.body.code,"pair-invalid");
const bearer={Authorization:"Bearer "+redeemed.token,Origin:"capacitor://localhost"};
data=ok(await api("/api/data","GET",undefined,bearer),"native data");
assert.equal(data.rev,1);
const v2=ok(await put("/api/data",{state:{...current.state,workouts:[...current.state.workouts,{id:"w-2"}]},baseRev:1,baseWid:v1.wid,stamped:true},bearer),"native put");
assert.equal(v2.rev,2);
const lost=await put("/api/data",{state:current.state,baseRev:1},loginCookie);
assert.equal(lost.status,409);
const reloaded=ok(await api("/api/data","GET",undefined,loginCookie),"data after native put");
assert.equal(reloaded.state.workouts.length,2);

// Exercise the real Settings -> Passkeys flow with a second authenticator.
const passkeys0=ok(await api("/api/account/passkeys","GET",undefined,loginCookie),"passkeys initial");
assert.equal(passkeys0.passkeys.length,1);
assert.equal(passkeys0.lastWayIn,true);
const forbidLast=await api("/api/account/passkeys?id="+encodeURIComponent(id),"DELETE",{},loginCookie);
assert.equal(forbidLast.status,409);
assert.equal(forbidLast.body.code,"last-way-in");
const renamed=ok(await post("/api/account/passkeys/rename",{id,name:"Primary Key"},loginCookie),"rename passkey");
assert.equal(renamed.passkeys[0].name,"Primary Key");
const noProof=await post("/api/account/passkeys/options",{},loginCookie);
assert.equal(noProof.status,403);
const a2=extraCredential();
const addOptions=ok(await post("/api/login/options",{}),"login options for add");
const add=ok(await post("/api/account/passkeys/options",
  {cid:addOptions.cid,credential:assertion(addOptions.options.challenge)},loginCookie),"add options");
assert.equal(add.options.excludeCredentials.length,1);
const verifiedAdd=ok(await post("/api/account/passkeys/verify",
  {cid:add.cid,credential:a2.creation(add.options.challenge),name:"Backup Key"},loginCookie),"add verify");
assert.equal(verifiedAdd.passkeys.length,2);
assert.equal(verifiedAdd.lastWayIn,false);
const addReplay=await post("/api/account/passkeys/verify",
  {cid:add.cid,credential:a2.creation(add.options.challenge),name:"Backup Key"},loginCookie);
assert.equal(addReplay.status,400);
assert.equal(addReplay.body.code,"challenge-expired");
const rmOptions=ok(await post("/api/login/options",{}),"login options for passkey removal");
const removed=await api("/api/account/passkeys?id="+encodeURIComponent(a2.id),"DELETE",
  {cid:rmOptions.cid,credential:assertion(rmOptions.options.challenge)},loginCookie);
assert.equal(removed.status,200);
assert.equal(removed.body.passkeys.length,1);
console.log("Live passkey management OK: rename, step-up, add, replay denial, last-key protection, remove");

const image=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),randomBytes(120)]);
const imageHash=hash(image).toString("hex");
const apiMedia=async (method,hashValue,content=image,mime="image/jpeg",headers=loginCookie)=>
  fetch(base+"/api/media/"+hashValue,{method,headers:{...headers,...(method==="PUT"?{"Content-Type":mime}:{})},
    ...(method==="PUT"?{body:content}:{})});
const initialMissing=ok(await post("/api/media/missing",{hashes:[imageHash]},loginCookie),"media missing initial");
assert.deepEqual(initialMissing.missing,[imageHash]);
assert.equal(initialMissing.usage.count,0);
const uploaded=await apiMedia("PUT",imageHash);
assert.equal(uploaded.status,201,"upload response: "+await uploaded.clone().text());
assert.deepEqual(await uploaded.json(),{ok:true,hash:imageHash,mime:"image/jpeg",size:image.length,existed:false});
const fetched=await apiMedia("GET",imageHash);
assert.equal(fetched.status,200);
assert.equal(fetched.headers.get("cache-control"),"private, no-store");
assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),image);
const duplicate=await apiMedia("PUT",imageHash);
assert.equal(duplicate.status,200);
assert.equal((await duplicate.json()).existed,true);
const wrongHash=await apiMedia("PUT","f".repeat(64));
assert.equal(wrongHash.status,400);
assert.equal((await wrongHash.json()).code,"hash-mismatch");
const disguised=await apiMedia("PUT",imageHash,Buffer.from("<svg/>"),"image/jpeg");
assert.equal(disguised.status,415);
const present=ok(await post("/api/media/missing",{hashes:[imageHash]},loginCookie),"media present");
assert.deepEqual(present.missing,[]);
assert.equal(present.usage.count,1);
const additional=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),randomBytes(119)]);
const extraHash=hash(additional).toString("hex");
assert.equal((await apiMedia("PUT",extraHash,additional)).status,201);
const before=ok(await api("/api/data","GET",undefined,loginCookie),"get before reference");
const updated={...before.state,customEx:[{id:"exercise-1",media:{hash:imageHash,mime:"image/jpeg",size:image.length}}]};
const putWithReference=await put("/api/data",{state:updated,baseRev:before.rev,baseWid:before.state._wid,stamped:true},loginCookie);
assert.equal(putWithReference.status,200);
const swept=ok(await post("/api/media/sweep",{},loginCookie),"media sweep");
assert.equal(swept.removed,1);
assert.equal(swept.freedBytes,additional.length);
assert.deepEqual(ok(await post("/api/media/missing",{hashes:[imageHash,extraHash]},loginCookie),"media missing after sweep").missing,[extraHash]);
assert.equal((await apiMedia("GET",imageHash)).status,200);
assert.equal((await apiMedia("GET",extraHash)).status,404);
console.log("Live R2 media integration OK: missing, upload, integrity, replay, quota accounting, scoped GET, reference-aware sweep");

// Account deletion uses the native app's bearer credential only after local biometric
// confirmation; the browser's cookie needs a fresh passkey step-up.
const wrongDelete=await post("/api/account/delete",{name:"not-the-owner"},bearer);
assert.equal(wrongDelete.status,400);
assert.equal(wrongDelete.body.code,"confirm-name");
const unprovedBrowser=await post("/api/account/delete",{name:username},loginCookie);
assert.equal(unprovedBrowser.status,403);
assert.equal(unprovedBrowser.body.code,"passkey-required");
const deleted=ok(await post("/api/account/delete",{name:username},bearer),"native account delete");
assert.equal(deleted.ok,true);
assert.equal((await api("/api/me","GET",undefined,loginCookie)).status,401);
assert.equal((await api("/api/data","GET",undefined,bearer)).status,401);
assert.equal((await api("/api/media/"+imageHash,"GET",undefined,bearer)).status,401);
console.log("Account deletion OK: name confirmation, fresh browser proof, bearer delete, credentials revoked");
console.log("Live Worker integration OK: register, WebAuthn, cookie, pairing, bearer, PUT, 409, reload");

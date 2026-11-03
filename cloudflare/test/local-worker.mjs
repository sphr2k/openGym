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
console.log("Live Worker integration OK: register, WebAuthn, cookie, pairing, bearer, PUT, 409, reload");

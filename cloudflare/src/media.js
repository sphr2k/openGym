import { json, randomHex, jsonBody } from "./protocol.js";
import { HASH_RE,TYPES,limits,sniffMedia,videoInfo,messages,quotaBytes,maxBytes } from "./media-validation.js";

const reserveTTL = 10 * 60 * 1000;
const o=v=>!!v&&typeof v==="object"&&!Array.isArray(v);
const err=(status,code,extra={})=>json({error:messages[code]||code,code,...extra},status);
export function referencedHashes(state){
  const result=new Set();if(!o(state))return result;
  const add=m=>{if(o(m)&&typeof m.hash==="string"&&HASH_RE.test(m.hash))result.add(m.hash);};
  const ref=m=>{if(o(m)){add(m);add(m.poster);}};
  for(const e of Array.isArray(state.customEx)?state.customEx:[])if(o(e))ref(e.media);
  for(const w of Array.isArray(state.workouts)?state.workouts:[]){
    if(!o(w))continue;
    if(Array.isArray(w.media))for(const m of w.media)ref(m);
    if(Array.isArray(w.entries))for(const e of w.entries){
      if(!o(e)||!Array.isArray(e.sets))continue;
      for(const set of e.sets)if(o(set)&&Array.isArray(set.media))
        for(const m of set.media)ref(m);
    }
  }
  if(o(state.dayPhotos))for(const d of Object.values(state.dayPhotos))if(o(d))ref(d.m);
  return result;
}
export function initMedia(p){
  p.sql.exec("CREATE TABLE IF NOT EXISTS media_files (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','ready','deleting')), token TEXT, expires INTEGER, unreferenced_since INTEGER)");
}
const row=(p,h)=>p.sql.exec("SELECT * FROM media_files WHERE hash=?",h).toArray()[0]||null;
const stats=p=>p.sql.exec("SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM media_files WHERE status='ready'").toArray()[0];
const usage=p=>{const s=stats(p);return {bytes:Number(s.bytes),count:Number(s.count),quotaBytes:quotaBytes(limits(p.env))};};
const key=(p,h)=>{
  const name=p.ctx.id?.name;
  if(typeof name!=="string"||!name.startsWith("profile:"))throw Error("ProfileDO requires named id");
  return "users/"+name.slice(8)+"/media/"+h;
};
export function noteReferences(p,state){
  const refs=referencedHashes(state),now=Date.now();
  for(const f of p.sql.exec("SELECT hash,unreferenced_since FROM media_files WHERE status='ready'").toArray()){
    if(refs.has(f.hash)&&f.unreferenced_since!==null)p.sql.exec("UPDATE media_files SET unreferenced_since=NULL WHERE hash=?",f.hash);
    else if(!refs.has(f.hash)&&f.unreferenced_since===null)p.sql.exec("UPDATE media_files SET unreferenced_since=? WHERE hash=?",now,f.hash);
  }
}
function reserve(p,h,mime,size){
  return p.ctx.storage.transactionSync(()=>{
    p.sql.exec("DELETE FROM media_files WHERE status='reserved' AND expires<?",Date.now());
    const previous=row(p,h);
    if(previous?.status==="ready")return {previous};
    if(previous)return {busy:true};
    const inflight=p.sql.exec("SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM media_files WHERE status='reserved'").toArray()[0];
    if(inflight.n>=2)return {busy:true};
    const q=quotaBytes(limits(p.env));
    if(q&&Number(stats(p).bytes)+Number(inflight.bytes)+size>q)return {quota:true};
    const token=randomHex(16);
    p.sql.exec("INSERT INTO media_files(hash,mime,size,status,token,expires,unreferenced_since) VALUES (?,?,?,'reserved',?,?,?)",h,mime,size,token,Date.now()+reserveTTL,Date.now());
    return {token};
  });
}
async function readBounded(req,max){
  if(Number(req.headers.get("content-length")||0)>max)return null;
  const reader=req.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let bytes=0;
  for(;;){const {value,done}=await reader.read();if(done)break;
    bytes+=value.length;if(bytes>max){await reader.cancel().catch(()=>{});return null;}chunks.push(value);
  }
  const data=new Uint8Array(bytes);let offset=0;
  for(const c of chunks){data.set(c,offset);offset+=c.length;}
  return data;
}
async function upload(p,req,h){
  const l=limits(p.env),mime=req.headers.get("content-type")?.split(";")[0]?.trim()?.toLowerCase();
  const decl=TYPES[mime];if(!decl)return err(415,"media-type");
  const ceiling=maxBytes(l,decl.kind);
  const bytes=await readBounded(req,ceiling);
  if(!bytes)return err(413,"media-too-large",{maxMB:ceiling/1048576});
  if(!bytes.length)return err(415,"media-type");
  const sniff=sniffMedia(bytes);
  if(!sniff||sniff.category!==decl.category)return err(415,"media-type");
  if(bytes.length>maxBytes(l,sniff.kind))return err(413,"media-too-large",{maxMB:maxBytes(l,sniff.kind)/1048576});
  if(sniff.kind==="video"&&["mp4","mov"].includes(sniff.ext)){
    const info=videoInfo(bytes);
    if(!info)return err(415,"media-invalid");
    if(info.durationSec!==null&&info.durationSec>l.videoSec+1)return err(413,"media-too-long",{maxSec:l.videoSec});
  }
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  const checksum=Array.from(digest,v=>v.toString(16).padStart(2,"0")).join("");
  if(checksum!==h)return err(400,"hash-mismatch");
  let reservation=reserve(p,h,sniff.mime,bytes.length);
  if(reservation.previous){
    const head=await p.env.MEDIA.head(key(p,h));
    if(head&&head.size===reservation.previous.size){
      return json({ok:true,hash:h,mime:reservation.previous.mime,size:reservation.previous.size,existed:true});
    }
    p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='ready'",h);
    reservation=reserve(p,h,sniff.mime,bytes.length);
  }
  if(reservation.busy)return err(429,"busy",{retryAfter:5});
  if(reservation.quota)return err(413,"media-quota",{usedMB:Math.round(stats(p).bytes/104857.6)/10,quotaMB:l.quotaMB});
  if(!reservation.token)return json({error:"media reservation failed"},503);
  try{
    await p.env.MEDIA.put(key(p,h),bytes,{httpMetadata:{contentType:sniff.mime},customMetadata:{hash:h}});
    const hasRef=referencedHashes(p.current().state).has(h);
    p.sql.exec("UPDATE media_files SET status='ready',mime=?,size=?,token=NULL,expires=NULL,unreferenced_since=? WHERE hash=? AND status='reserved' AND token=?",
      sniff.mime,bytes.length,hasRef?null:Date.now(),h,reservation.token);
    return json({ok:true,hash:h,mime:sniff.mime,size:bytes.length,existed:false},201);
  }catch(e){
    p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='reserved' AND token=?",h,reservation.token);
    throw e;
  }
}
async function download(p,h){
  const f=row(p,h);if(!f||f.status!=="ready")return err(404,"media-missing");
  const blob=await p.env.MEDIA.get(key(p,h));
  if(!blob||blob.size!==f.size)return err(404,"media-missing");
  return new Response(blob.body,{headers:{
    "Content-Type":f.mime,"Content-Length":String(f.size),"Cache-Control":"private, no-store",
    "X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy":"same-origin",
    "Content-Disposition":'inline; filename="'+h+"."+TYPES[f.mime].ext+'"',
    "X-Robots-Tag":"noindex","Access-Control-Expose-Headers":"Content-Length"
  }});
}
async function missing(p,req){
  const parsed=await jsonBody(req);if(parsed.error)return parsed.error;
  const hashes=parsed.value?.hashes;
  if(!Array.isArray(hashes)||hashes.length>1000||!hashes.every(h=>typeof h==="string"&&HASH_RE.test(h)))
    return err(400,"bad-request",{error:"hashes must be a list of at most 1000 lowercase sha256 hex strings"});
  const absent=[];
  for(const h of new Set(hashes)){
    const f=row(p,h);if(!f||f.status!=="ready"){absent.push(h);continue;}
    const head=await p.env.MEDIA.head(key(p,h));
    if(!head||head.size!==f.size)absent.push(h);
  }
  return json({missing:absent,usage:usage(p)});
}
export async function garbageCollect(p,graceMs){
  if(p.mediaSweepRunning)return err(429,"busy",{retryAfter:5});
  const {state,unreadable}=p.current();
  if(unreadable||!state)return json({removed:0,freedBytes:0,usage:usage(p)});
  p.mediaSweepRunning=true;
  let removed=0,freedBytes=0;
  try{
    const refs=referencedHashes(state),now=Date.now();
    for(const f of p.sql.exec("SELECT hash,size,unreferenced_since FROM media_files WHERE status='ready'").toArray()){
      if(refs.has(f.hash)){
        if(f.unreferenced_since!==null)p.sql.exec("UPDATE media_files SET unreferenced_since=NULL WHERE hash=?",f.hash);
        continue;
      }
      if(f.unreferenced_since===null){
        p.sql.exec("UPDATE media_files SET unreferenced_since=? WHERE hash=?",now,f.hash);
        if(graceMs>0)continue;
      }else if(graceMs>0 && now-Number(f.unreferenced_since)<graceMs)continue;
      p.sql.exec("UPDATE media_files SET status='deleting' WHERE hash=? AND status='ready'",f.hash);
      try{
        await p.env.MEDIA.delete(key(p,f.hash));
        p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='deleting'",f.hash);
        removed++;freedBytes+=f.size;
      }catch(e){
        p.sql.exec("UPDATE media_files SET status='ready' WHERE hash=? AND status='deleting'",f.hash);
        console.error("R2 delete failed",e);
      }
    }
    return json({removed,freedBytes,usage:usage(p)});
  }finally{p.mediaSweepRunning=false;}
}
export async function scheduleGarbageCollection(p){
  if(!p.env.MEDIA||typeof p.ctx.storage.setAlarm!=="function")return;
  const entry=p.sql.exec("SELECT MIN(unreferenced_since) AS next FROM media_files WHERE status='ready' AND unreferenced_since IS NOT NULL").toArray()[0];
  if(entry.next===null){
    if(typeof p.ctx.storage.deleteAlarm==="function")await p.ctx.storage.deleteAlarm();
    return;
  }
  const due=Number(entry.next)+limits(p.env).gcGraceDays*86400000;
  // A profile with no snapshot is never assumed empty: keep files, retry later.
  const safeDelay=p.current().state?10000:6*60*60*1000;
  await p.ctx.storage.setAlarm(Math.max(Date.now()+safeDelay,due));
}
async function sweep(p,req){
  const parsed=await jsonBody(req);if(parsed.error)return parsed.error;
  return garbageCollect(p,0);
}
export async function mediaRequest(p,req){
  const path=new URL(req.url).pathname,method=req.method;
  if(!limits(p.env).enabled)return json({error:"not found"},404);
  const m=/^\/api\/media\/([0-9a-f]{64})$/.exec(path);
  if(m&&method==="GET")return download(p,m[1]);
  if(m&&method==="PUT")return upload(p,req,m[1]);
  if(path==="/api/media/missing"&&method==="POST")return missing(p,req);
  if(path==="/api/media/sweep"&&method==="POST")return sweep(p,req);
  return json({error:"not found"},404);
}


/** Idempotent profile purge, called only after AccountDO revoked all credentials.
 * Deletes R2 first, then SQLite. A retry can safely continue after interruption.
 */
export async function deleteAllProfileData(p){
  const name=p.ctx.id?.name;
  if(typeof name!=="string"||!name.startsWith("profile:"))throw Error("missing profile identity");
  const prefix="users/"+name.slice(8)+"/media/";
  // Deleting the first page repeatedly avoids cursor invalidation during deletion.
  for(let i=0;i<10000;i++){
    const page=await p.env.MEDIA.list({prefix,limit:1000});
    if(!page.objects.length)break;
    await p.env.MEDIA.delete(page.objects.map(o=>o.key));
    if(i===9999)throw Error("profile media cleanup exceeded safety limit");
  }
  p.ctx.storage.transactionSync(()=>{
    p.sql.exec("DELETE FROM media_files");
    p.sql.exec("DELETE FROM document");
  });
  return json({ok:true});
}

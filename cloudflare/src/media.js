import { json, randomHex, jsonBody } from "./protocol.js";
import { HASH_RE,TYPES,limits,sniffMedia,videoInfo,messages,quotaBytes,maxBytes } from "./media-validation.js";

import { referencedHashes } from "../../api/media-references.js";
export { referencedHashes };

const reserveTTL = 10 * 60 * 1000;
// Additional window for a PUT with an unknown outcome after its SQL lease
// expires. Late PUTs are also caught by persistent, periodic R2 listing.
const reservationSettleMs = 60 * 60 * 1000;
const o=v=>!!v&&typeof v==="object"&&!Array.isArray(v);
const err=(status,code,extra={})=>json({error:messages[code]||code,code,...extra},status);
export function initMedia(p){
  p.sql.exec("CREATE TABLE IF NOT EXISTS media_files (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('reserved','ready','deleting')), token TEXT, expires INTEGER, unreferenced_since INTEGER)");
  p.sql.exec("CREATE TABLE IF NOT EXISTS profile_lifecycle(key TEXT PRIMARY KEY,value INTEGER NOT NULL)");
  p.sql.exec("CREATE TABLE IF NOT EXISTS media_throttle(kind TEXT PRIMARY KEY,count INTEGER NOT NULL,started INTEGER NOT NULL)");
}
export const profileDeleted=p=>!!p.sql.exec("SELECT value FROM profile_lifecycle WHERE key='deleted'").toArray()[0]?.value;
const revoked=()=>json({error:"profile removed",code:"profile-deleted"},410);
function takeRate(p,kind,max,windowMs){
  return p.ctx.storage.transactionSync(()=>{
    const now=Date.now();
    const row=p.sql.exec("SELECT count,started FROM media_throttle WHERE kind=?",kind).toArray()[0];
    if(!row||now-row.started>=windowMs){
      p.sql.exec("INSERT INTO media_throttle(kind,count,started) VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET count=excluded.count,started=excluded.started",kind,1,now);
      return 0;
    }
    if(row.count>=max)return Math.max(1,Math.ceil((windowMs-(now-row.started))/1000));
    p.sql.exec("UPDATE media_throttle SET count=count+1 WHERE kind=?",kind);
    return 0;
  });
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
    if(profileDeleted(p))return {deleted:true};
    // Do not discard expired reservations here: R2 may have committed an
    // upload just before the isolate died. Reconciliation owns lease expiry.
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
  if(reservation.deleted)return revoked();
  if(reservation.busy)return err(429,"busy",{retryAfter:5});
  if(reservation.quota)return err(413,"media-quota",{usedMB:Math.round(stats(p).bytes/104857.6)/10,quotaMB:l.quotaMB});
  if(!reservation.token)return json({error:"media reservation failed"},503);
  try{
    // Register a wakeup BEFORE any external R2 write. If an isolate dies after
    // R2 PUT but before SQLite metadata commit, the next alarm can reconcile.
    // Keep a periodic media/snapshot reconciliation alive even if a timed-out
    // reservation is later cleared before an in-flight R2 PUT completes.
    await p.store.armSweep();
    await p.env.MEDIA.put(key(p,h),bytes,{httpMetadata:{contentType:sniff.mime},customMetadata:{hash:h}});
    if(profileDeleted(p)){
      // An upload already in flight when the account was deleted must not
      // resurrect bytes after the cleanup job has completed.
      await p.env.MEDIA.delete(key(p,h));
      p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='reserved' AND token=?",h,reservation.token);
      return revoked();
    }
    const loaded=await p.current();
    if(loaded.unreadable) throw Error("profile unreadable during media upload");
    if(profileDeleted(p)){
      await p.env.MEDIA.delete(key(p,h)).catch(()=>{});
      return revoked();
    }
    const hasRef=referencedHashes(loaded.state).has(h);
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
/**
 * Recover media committed to R2 just before the Durable Object was interrupted.
 * The R2 prefix is scoped to the authenticated user, so other users' files are
 * never inspected. We never delete from an unreadable/missing profile snapshot.
 *
 * No public API calls this directly: only the same ProfileDO's GC alarm or
 * explicitly requested sweep uses it, holding the per-object maintenance gate.
 */
export async function reconcileOrphans(p,state) {
  const name=p.ctx.id?.name;
  if(typeof name!=="string"||!name.startsWith("profile:"))throw Error("missing profile identity");
  const prefix="users/"+name.slice(8)+"/media/";
  // Same retained snapshot set used by snapshot GC. This includes current,
  // PITR-window revisions and the preceding recovery-window anchor.
  const protectedHashes=p.store.protectedMediaHashes();
  for(const h of referencedHashes(state))protectedHashes.add(h);
  let cursor,restored=0;
  const now=Date.now();
  for(let pageNumber=0;pageNumber<1000;pageNumber++){
    const page=await p.env.MEDIA.list({prefix,limit:1000,...(cursor?{cursor}:{})});
    for(const candidate of page.objects){
      const hash=candidate.key.slice(prefix.length);
      if(!HASH_RE.test(hash))continue;
      const existing=row(p,hash);
      if(existing?.status==="ready" || existing?.status==="deleting")continue;
      if(existing?.status==="reserved" &&
         now < Number(existing.expires)+reservationSettleMs)continue;
      const obj=await p.env.MEDIA.head(candidate.key);
      if(!obj)continue;
      const mime=obj.httpMetadata?.contentType;
      if(!TYPES[mime])continue;
      if(existing?.status==="reserved") {
        // Never turn a truncated/incorrect upload into a published file.
        if(obj.size!==existing.size)continue;
        p.sql.exec(
          "UPDATE media_files SET status='ready',mime=?,size=?,token=NULL,expires=NULL,unreferenced_since=? WHERE hash=? AND status='reserved' AND expires<?",
          mime,obj.size,protectedHashes.has(hash)?null:now,hash,now-reservationSettleMs);
        // A failed conditional update is safe: the next alarm reconciles again.
      }else{
        const uploaded=Date.parse(obj.uploaded instanceof Date?obj.uploaded.toISOString():String(obj.uploaded||""));
        const since=protectedHashes.has(hash)?null:(Number.isFinite(uploaded)?Math.min(uploaded,now):now);
        p.sql.exec("INSERT OR IGNORE INTO media_files(hash,mime,size,status,token,expires,unreferenced_since) VALUES (?,?,?,'ready',NULL,NULL,?)",
          hash,mime,obj.size,since);
      }
      restored++;
    }
    if(!page.truncated)break;
    if(!page.cursor||page.cursor===cursor)throw Error("R2 listing cursor did not advance");
    cursor=page.cursor;
    if(pageNumber===999)throw Error("R2 reconciliation exceeded page limit");
  }
  // A negative HEAD cannot prove that an in-flight, cancelled PUT will never
  // become visible. Expire only long-dead leases and keep the alarm active.
  for(const lease of p.sql.exec("SELECT hash,expires FROM media_files WHERE status='reserved' AND expires<?",now-reservationSettleMs).toArray()){
    const obj=await p.env.MEDIA.head(key(p,lease.hash));
    if(obj)continue;
    p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='reserved' AND expires<?",lease.hash,now-reservationSettleMs);
  }
  return restored;
}

export async function garbageCollect(p,graceMs){
  if(profileDeleted(p))return json({removed:0,freedBytes:0,usage:usage(p)});
  if(p.mediaSweepRunning)return err(429,"busy",{retryAfter:5});
  p.mediaSweepRunning=true;
  let removed=0,freedBytes=0;
  try{
    const {state,unreadable}=await p.current();
    if(unreadable)return json({removed:0,freedBytes:0,usage:usage(p)});
    await reconcileOrphans(p,state);
    // Do not delete ready media with no current profile: a first upload may be
    // followed by the first profile commit, including delayed native sync.
    if(!state)return json({removed:0,freedBytes:0,usage:usage(p)});
    const current=referencedHashes(state),protectedHashes=p.store.protectedMediaHashes(),now=Date.now();
    for(const f of p.sql.exec("SELECT hash,size,status,unreferenced_since FROM media_files WHERE status IN ('ready','deleting')").toArray()){
      const isCurrent=current.has(f.hash),isProtected=protectedHashes.has(f.hash);
      if(isCurrent || isProtected){
        // A potentially interrupted DELETE must not be retried if a retained
        // historical version or current profile still needs this object.
        if(f.status==="deleting")
          p.sql.exec("UPDATE media_files SET status='ready' WHERE hash=? AND status='deleting'",f.hash);
        if(isCurrent && f.unreferenced_since!==null)
          p.sql.exec("UPDATE media_files SET unreferenced_since=NULL WHERE hash=?",f.hash);
        continue;
      }
      if(f.unreferenced_since===null){
        p.sql.exec("UPDATE media_files SET status='ready',unreferenced_since=? WHERE hash=?",now,f.hash);
        continue;
      }
      if(graceMs>0 && now-Number(f.unreferenced_since)<graceMs){
        if(f.status==="deleting")p.sql.exec("UPDATE media_files SET status='ready' WHERE hash=?",f.hash);
        continue;
      }
      // Marking 'deleting' is an idempotent persistent lease. If the DO dies
      // during R2 DELETE, the next GC retries this same state. R2 DELETE of a
      // missing object succeeds just as a completed deletion would.
      p.sql.exec("UPDATE media_files SET status='deleting' WHERE hash=?",f.hash);
      try{
        await p.env.MEDIA.delete(key(p,f.hash));
        p.sql.exec("DELETE FROM media_files WHERE hash=? AND status='deleting'",f.hash);
        removed++;freedBytes+=f.size;
      }catch(e){
        // Keep deleting status so retries recover even across DO evictions.
        console.error("R2 delete failed",e);
      }
    }
    return json({removed,freedBytes,usage:usage(p)});
  }finally{p.mediaSweepRunning=false;}
}
export async function scheduleGarbageCollection(p){
  if(!p.env.MEDIA || typeof p.ctx.storage.setAlarm!=="function")return;
  const now=Date.now();
  const next=p.sql.exec("SELECT MIN(unreferenced_since) AS next FROM media_files WHERE status='ready' AND unreferenced_since IS NOT NULL").toArray()[0]?.next;
  const reserved=p.sql.exec("SELECT COUNT(*) AS n FROM media_files WHERE status='reserved'").toArray()[0].n;
  const deleting=p.sql.exec("SELECT COUNT(*) AS n FROM media_files WHERE status='deleting'").toArray()[0].n;
  const candidates=[];
  if(p.store.gcActive()) candidates.push(now+6*60*60*1000);
  if(reserved || deleting) candidates.push(now+6*60*60*1000);
  if(next!==null && next!==undefined){
    const due=Number(next)+limits(p.env).gcGraceDays*86400000;
    candidates.push(Math.max(now+10000,due));
  }
  if(!candidates.length){
    if(typeof p.ctx.storage.deleteAlarm==="function")await p.ctx.storage.deleteAlarm();
    return;
  }
  await p.ctx.storage.setAlarm(Math.min(...candidates));
}
async function sweep(p,req){
  const parsed=await jsonBody(req);if(parsed.error)return parsed.error;
  return garbageCollect(p,0);
}
export async function mediaRequest(p,req){
  if(profileDeleted(p))return revoked();
  const path=new URL(req.url).pathname,method=req.method;
  if(!limits(p.env).enabled)return json({error:"not found"},404);
  const m=/^\/api\/media\/([0-9a-f]{64})$/.exec(path);
  if(m&&method==="GET")return download(p,m[1]);
  if(m&&method==="PUT"){
    if(p.mediaSweepRunning)return json({error:"media maintenance in progress"},503);
    const wait=takeRate(p,"upload",limits(p.env).uploadsPerHour,3600000);
    if(wait)return json({error:"too many uploads, try again later",code:"locked",retryAfter:wait},429,{"Retry-After":String(wait)});
    return upload(p,req,m[1]);
  }
  if(path==="/api/media/missing"&&method==="POST")return missing(p,req);
  if(path==="/api/media/sweep"&&method==="POST"){
    const wait=takeRate(p,"sweep",10,3600000);
    if(wait)return json({error:"too many uploads, try again later",code:"locked",retryAfter:wait},429,{"Retry-After":String(wait)});
    return sweep(p,req);
  }
  return json({error:"not found"},404);
}


/** Idempotent user-scoped media cleanup, also run by alarms after account
 * deletion to catch R2 PUTs that finish after the initial purge.
 */
export async function purgeDeletedMedia(p){
  if(!profileDeleted(p)) throw Error("media prefix purge requires account tombstone");
  const name=p.ctx.id?.name;
  if(typeof name!=="string"||!name.startsWith("profile:"))throw Error("missing profile identity");
  const prefix="users/"+name.slice(8)+"/media/";
  // Repeated first-page listing is safe while deleting objects: cursors
  // against a changing keyspace could otherwise skip objects.
  for(let i=0;i<10000;i++){
    const page=await p.env.MEDIA.list({prefix,limit:1000});
    if(!page.objects.length)return;
    await p.env.MEDIA.delete(page.objects.map(o=>o.key));
  }
  throw Error("profile media cleanup exceeded safety limit");
}

/** Idempotent profile purge, called only after AccountDO revoked all credentials.
 * Deletes R2 first, then SQLite. A retry can safely continue after interruption.
 */
export async function deleteAllProfileData(p){
  // Persist revocation before any external R2 I/O; this marker survives
  // retries, DO evictions and concurrent uploads that were already running.
  p.sql.exec("INSERT OR REPLACE INTO profile_lifecycle(key,value) VALUES ('deleted',1)");
  await purgeDeletedMedia(p);
  // Remove snapshots before clearing their canonical SQL pointers. If an
  // external delete fails, the account deletion can be retried idempotently.
  // The ongoing GC marker remains after deletion to catch late R2 uploads.
  await p.store.sweep(true);
  p.ctx.storage.transactionSync(()=>{
    p.sql.exec("DELETE FROM media_files");
    p.store.clear();
  });
  await scheduleGarbageCollection(p);
  return json({ok:true});
}

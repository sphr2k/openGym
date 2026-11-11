import { stampPut } from "../../api/sync-stamps.js";
import { ProfileStore } from "./profile-store.js";
import { initMedia, noteReferences, mediaRequest, deleteAllProfileData, purgeDeletedMedia, garbageCollect, scheduleGarbageCollection, profileDeleted } from "./media.js";
import { forClient, json, jsonBody, randomHex, validateProfile } from "./protocol.js";

const WID_KEEP = 50;
const MAX_REBASE = 5;
// Read-only MCP snapshots, separate from the canonical profile and its merge protocol.
const LIVE_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_MAX_BYTES = 512 * 1024;
const LIVE_DEVICE_RE = /^[a-f0-9-]{36}$/i;
const validLive = a => a && typeof a === "object" && !Array.isArray(a) &&
  typeof a.id === "string" && a.id.length > 0 && a.id.length <= 128 &&
  typeof a.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.d) &&
  Number.isFinite(a.start) && a.start > 0 && Array.isArray(a.entries);

const clone = value => JSON.parse(JSON.stringify(value));

// The DO coordinates OCC across awaits. Only pointer + revision + media
// references are committed inside a synchronous SQLite transaction.
export class ProfileDO {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.sql=ctx.storage.sql;
    this.store=new ProfileStore(ctx,env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS mcp_live_workouts (device_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, synced_at INTEGER NOT NULL, payload TEXT NOT NULL)");
    initMedia(this);
  }

  current() {
    return this.store.load();
  }

  async read(path) {
    if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
    if(path==="/api/data/rev") {
      const {rev,wid}=this.store.revision();
      return json({rev,...(wid?{wid}:{})});
    }
    const {state,rev,unreadable}=await this.current();
    if(unreadable) return json({error:"state unreadable"},503);
    if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
    return json({state:forClient(state),rev});
  }

  // Called only inside the successful profile pointer transaction. In particular, a
  // rejected 409 must never publish a stale active session.
  writeLive(deviceId, active, updatedAt) {
    if (typeof deviceId !== "string" || !LIVE_DEVICE_RE.test(deviceId)) return;
    const now = Date.now();
    this.sql.exec("DELETE FROM mcp_live_workouts WHERE synced_at < ?", now - LIVE_TTL_MS);
    if (!active) {
      this.sql.exec("DELETE FROM mcp_live_workouts WHERE device_id=?", deviceId);
      return;
    }
    if (!validLive(active)) return;
    const payload = JSON.stringify(active);
    if (new TextEncoder().encode(payload).length > LIVE_MAX_BYTES) return;
    this.sql.exec("INSERT INTO mcp_live_workouts(device_id,updated_at,synced_at,payload) VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET updated_at=excluded.updated_at,synced_at=excluded.synced_at,payload=excluded.payload",
      deviceId, Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now, now, payload);
  }

  readLive() {
    if (profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
    const now = Date.now();
    this.sql.exec("DELETE FROM mcp_live_workouts WHERE synced_at < ?", now - LIVE_TTL_MS);
    return json({workouts:this.sql.exec("SELECT payload,updated_at,synced_at FROM mcp_live_workouts ORDER BY synced_at DESC").toArray()
      .map(row => ({...JSON.parse(row.payload), updated_at:row.updated_at, synced_at:row.synced_at}))});
  }

  async write(body) {
    if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
    if(this.mediaSweepRunning) return json({error:"media maintenance in progress"},503);
    for(let attempt=0;attempt<MAX_REBASE;attempt++) {
      const baseline=this.store.revision();
      const {state:cur,unreadable}=await this.store.load(baseline);
      if(unreadable) return json({error:"state unreadable"},503);
      if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);

      if((body.baseRev!=null && body.baseRev!==baseline.rev) ||
        (body.baseRev!=null && typeof body.baseWid==="string" &&
          cur?._wid && body.baseWid!==cur._wid)) {
        return json({error:"conflict",rev:baseline.rev,state:forClient(cur)},409);
      }

      const next=clone(body.state);
      const bad=validateProfile(next);
      if(bad) return json({error:bad.error},bad.status);
      delete next.active;
      if(Number(cur?.resetAt||0)>Number(next.resetAt||0)) {
        next.resetAt=cur.resetAt;
        if(cur.resetIds && typeof cur.resetIds==="object") next.resetIds=cur.resetIds;
        else delete next.resetIds;
      }
      const report={};
      try {
        stampPut(cur,next,{
          overRead:body.baseRev!=null && body.baseRev===baseline.rev,
          stamped:body.stamped===true,
          report
        });
      }catch(err) {
        if(err instanceof RangeError) return json({error:"invalid state"},400);
        throw err;
      }
      next._rev=baseline.rev+(report.changed?2:1);
      next._wids=[...(Array.isArray(cur?._wids)?cur._wids:[]),...(cur?._wid?[cur._wid]:[])]
        .filter(x=>typeof x==="string").slice(-WID_KEEP);
      next._wid=randomHex(8);

      // Persist a sweep wakeup before the external write, including when the
      // R2 PUT succeeds but the isolate crashes before the SQLite commit.
      await this.store.armSweep();
      if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
      const snapshot=await this.store.stage(next,next._rev);
      let result;
      try {
        result=this.ctx.storage.transactionSync(()=>{
          if(profileDeleted(this)) return "deleted";
          if(this.mediaSweepRunning) return "maintenance";
          if(!this.store.commit(baseline,next,snapshot)) return "conflict";
          noteReferences(this,next);
          // active itself remains device-local. Snapshot it only for clients that
          // explicitly identify their device; older clients preserve prior behavior.
          this.writeLive(body.liveDeviceId, body.state?.active, body.state?._ts);
          return "committed";
        });
      }catch(err) {
        // The staged snapshot remains an orphan and is reclaimed by the sweep.
        throw err;
      }

      if(result==="committed") {
        // A post-commit alarm scheduling error must not turn a durable write
        // into HTTP 500. The sweep alarm was already armed before R2.put().
        try {await scheduleGarbageCollection(this);}
        catch(err) {console.error("post-commit GC alarm scheduling failed",err);}
        return json({ok:true,ts:next._ts||null,rev:baseline.rev+1,wid:next._wid});
      }
      if(result==="deleted") {
        // Best effort only. Periodic post-delete R2 reconciliation is the
        // reliable fallback if cleanup fails or the isolate is interrupted.
        await this.env.MEDIA.delete(snapshot.key).catch(()=>{});
        return json({error:"profile removed",code:"profile-deleted"},410);
      }
      if(result==="maintenance")
        return json({error:"media maintenance in progress"},503);

      // A different writer committed while R2 PUT was in flight. A caller
      // specifying baseRev must see the *new* authoritative state in 409.
      if(body.baseRev!=null) {
        const fresh=await this.current();
        if(fresh.unreadable) return json({error:"state unreadable"},503);
        if(profileDeleted(this)) return json({error:"profile removed",code:"profile-deleted"},410);
        return json({error:"conflict",rev:fresh.rev,state:forClient(fresh.state)},409);
      }
      // Unversioned writers retained by upstream must re-run stampPut against
      // the new state; re-uploading the old prepared snapshot would lose edits.
    }
    return json({error:"concurrent updates; retry",code:"retry"},503,{"Retry-After":"1"});
  }

  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(request.method==="GET" && path==="/_internal/mcp-live-workouts")
      return this.readLive();
    if(request.method==="POST" && path==="/_internal/delete-all")
      return deleteAllProfileData(this);
    if(request.method==="GET" && (path==="/api/data" || path==="/api/data/rev"))
      return this.read(path);
    if(request.method==="PUT" && path==="/api/data") {
      const parsed=await jsonBody(request);
      if(parsed.error) return parsed.error;
      return this.write(parsed.value);
    }
    if(path.startsWith("/api/media/")) {
      const response=await mediaRequest(this,request);
      if(response.ok && request.method!=="GET") await scheduleGarbageCollection(this);
      return response;
    }
    return json({error:"not found"},404);
  }

  async alarm() {
    // Re-arm before any slow external I/O: a crash during GC must not lose
    // the next wakeup after Cloudflare's bounded alarm retries.
    await scheduleGarbageCollection(this);
    let failure;
    try {
      if(profileDeleted(this)) await purgeDeletedMedia(this);
      else {
        const grace=Math.max(0,Number(this.env.MEDIA_GC_GRACE_DAYS??14))*86400000;
        await garbageCollect(this,grace);
      }
    }catch(err) {failure=err;console.error("media GC failed",err);}
    try {
      if(this.store.gcActive()) await this.store.sweep(profileDeleted(this));
    }catch(err) {failure??=err;console.error("snapshot GC failed",err);}
    finally {await scheduleGarbageCollection(this);}
    if(failure) throw failure;
  }
}

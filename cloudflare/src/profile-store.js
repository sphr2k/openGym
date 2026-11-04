// The only canonical profile is an immutable R2 JSON snapshot selected by a
// synchronous SQLite pointer. No application-specific JSON schema or migrations.
import { randomHex } from "./protocol.js";

export const SNAPSHOT_GRACE_MS = 35 * 86400000; // 30-day DO PITR + five-day cushion
export const ORPHAN_GRACE_MS = 24 * 3600000;
export const SNAPSHOT_SWEEP_MS = 6 * 3600000;

const encode = new TextEncoder();
const hex = bytes => [...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");
async function sha256(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)));
}
const blank = () => ({rev:0,wid:null,key:null,hash:null,committedAt:null});
const row = p => p.sql.exec("SELECT revision AS rev, write_id AS wid, snapshot_key AS key, sha256 AS hash, committed_at AS committedAt FROM profile_meta WHERE id=1").toArray()[0];

export class ProfileStore {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.sql=ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS profile_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, write_id TEXT, snapshot_key TEXT, sha256 TEXT, committed_at INTEGER, gc_active INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS profile_history (revision INTEGER PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, committed_at INTEGER NOT NULL, sha256 TEXT NOT NULL)");
  }

  // Intentionally temporary safety tripwire only; no legacy reader or migration.
  assertCleanSlate() {
    if(this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document'").toArray().length)
      throw Error("legacy document schema: run the external one-shot migration before deploy");
  }

  revision() {
    this.assertCleanSlate();
    return row(this)??blank();
  }

  prefix() {
    const name=this.ctx.id?.name;
    if(typeof name!=="string" || !name.startsWith("profile:")) throw Error("ProfileDO requires named user identity");
    return "users/"+name.slice(8)+"/snapshots/";
  }

  async load(meta=this.revision()) {
    if(!meta.key) return {state:null,rev:meta.rev};
    if(!this.env.MEDIA) return {unreadable:true};
    const obj=await this.env.MEDIA.get(meta.key);
    if(!obj) return {unreadable:true};
    const text=await obj.text();
    const digest=await sha256(encode.encode(text));
    if(digest!==meta.hash) return {unreadable:true};
    try {
      const state=JSON.parse(text);
      if(!state || Array.isArray(state) || typeof state!=="object" ||
        state._rev!==meta.rev || state._wid!==meta.wid) return {unreadable:true};
      return {state,rev:meta.rev};
    }catch{return {unreadable:true};}
  }

  // Must happen *before* any asynchronous R2 PUT. The durable gc_active bit
  // prevents the existing media alarm scheduler from cancelling our sweep.
  async armSweep() {
    this.assertCleanSlate();
    this.ctx.storage.transactionSync(()=>{
      this.sql.exec("INSERT INTO profile_meta(id,revision,gc_active) VALUES (1,0,1) ON CONFLICT(id) DO UPDATE SET gc_active=1");
    });
    if(typeof this.ctx.storage.setAlarm==="function") {
      const due=Date.now()+SNAPSHOT_SWEEP_MS;
      const old=typeof this.ctx.storage.getAlarm==="function" ? await this.ctx.storage.getAlarm():null;
      if(old==null || old>due) await this.ctx.storage.setAlarm(due);
    }
  }

  async stage(state,rev) {
    const content=JSON.stringify(state);
    if(typeof content!=="string") throw Error("invalid profile encoding");
    const bytes=encode.encode(content);
    const hash=await sha256(bytes);
    const key=this.prefix()+rev+"-"+randomHex(16)+".json";
    const result=await this.env.MEDIA.put(key,bytes,{httpMetadata:{contentType:"application/json"}});
    if(!result) throw Error("R2 snapshot write failed");
    return {key,hash};
  }

  // Only call inside ctx.storage.transactionSync(). Never async.
  commit(expected,state,snapshot) {
    const live=this.revision();
    if(live.rev!==expected.rev || live.wid!==expected.wid) return false;
    const now=Date.now();
    this.sql.exec("INSERT INTO profile_meta(id,revision,write_id,snapshot_key,sha256,committed_at,gc_active) VALUES (1,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,write_id=excluded.write_id,snapshot_key=excluded.snapshot_key,sha256=excluded.sha256,committed_at=excluded.committed_at,gc_active=1",
      state._rev,state._wid,snapshot.key,snapshot.hash,now);
    this.sql.exec("INSERT INTO profile_history(revision,r2_key,committed_at,sha256) VALUES (?,?,?,?)",state._rev,snapshot.key,now,snapshot.hash);
    return true;
  }

  gcActive() {
    return !!this.sql.exec("SELECT gc_active FROM profile_meta WHERE id=1").toArray()[0]?.gc_active;
  }

  async sweep(deleted=false,now=Date.now()) {
    const prefix=this.prefix();
    const all=this.sql.exec("SELECT revision,r2_key,committed_at FROM profile_history ORDER BY revision").toArray();
    const current=deleted?null:this.revision().key;
    const cutoff=now-SNAPSHOT_GRACE_MS;
    // An older snapshot that was live at the beginning of the PITR window
    // must survive, even if it was committed months before that window.
    const anchor=[...all].reverse().find(x=>x.committed_at<cutoff);
    const retained=deleted?new Set():new Set(all.filter(x=>x.committed_at>=cutoff || x.r2_key===anchor?.r2_key || x.r2_key===current).map(x=>x.r2_key));
    if(current) retained.add(current);
    this.ctx.storage.transactionSync(()=>{
      for(const x of all) if(!retained.has(x.r2_key))
        this.sql.exec("DELETE FROM profile_history WHERE revision=?",x.revision);
    });
    // Reconciliation is authoritative by SQLite references. A very recent
    // orphan is never removed, protecting in-flight and delayed R2 puts.
    let cursor,removed=0;
    for(let page=0;page<1000;page++){
      const result=await this.env.MEDIA.list({prefix,limit:1000,...(cursor?{cursor}:{})});
      for(const x of result.objects){
        if(retained.has(x.key)) continue;
        const uploaded=x.uploaded instanceof Date?x.uploaded.getTime():Date.parse(String(x.uploaded||""));
        if(!deleted && (!Number.isFinite(uploaded)||now-uploaded<ORPHAN_GRACE_MS)) continue;
        await this.env.MEDIA.delete(x.key);
        removed++;
      }
      if(!result.truncated) break;
      if(!result.cursor || result.cursor===cursor) throw Error("R2 snapshot list cursor failed");
      cursor=result.cursor;
      if(page===999) throw Error("R2 snapshot sweep exceeded page limit");
    }
    if(deleted) {
      const tombstone=this.sql.exec("SELECT deleted_at FROM profile_meta WHERE id=1").toArray()[0]?.deleted_at;
      if(tombstone && now-tombstone>7*86400000)
        this.sql.exec("UPDATE profile_meta SET gc_active=0 WHERE id=1");
    }
    return removed;
  }

  // Called only after account credentials have been revoked; preserve the
  // tombstone/sweep marker so an in-flight R2 put cannot leak indefinitely.
  clear() {
    this.sql.exec("DELETE FROM profile_history");
    this.sql.exec("INSERT INTO profile_meta(id,revision,gc_active,deleted_at) VALUES (1,0,1,?) ON CONFLICT(id) DO UPDATE SET revision=0,write_id=NULL,snapshot_key=NULL,sha256=NULL,committed_at=NULL,gc_active=1,deleted_at=excluded.deleted_at",Date.now());
  }
}

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { meta, sections, fragments } from "./profile-schema.js";

// Stable schema, independent of the upstream JSON structure.
export const CHUNK_BYTES = 256 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", {fatal:true});
const version = 1;
const key = (field,item,chunk) => JSON.stringify([field,item,chunk]);

function chunksOf(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw Error("unserializable JSON field");
  const bytes = enc.encode(json);
  const chunks = [];
  for(let i=0;i<bytes.length;i+=CHUNK_BYTES) chunks.push(Buffer.from(bytes.subarray(i,i+CHUNK_BYTES)));
  return chunks;
}
function decode(chunks) {
  if (!chunks?.length) throw Error("missing JSON fragment");
  const all = Buffer.concat(chunks);
  return JSON.parse(dec.decode(all));
}

export class ProfileStore {
  constructor(storage) {
    this.storage = storage;
    this.db = drizzle(storage);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS profile_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, write_id TEXT NOT NULL, storage_version INTEGER NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS profile_sections (field TEXT PRIMARY KEY, position INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('array','value')))");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS profile_fragments (field TEXT NOT NULL, item_index INTEGER NOT NULL, chunk_index INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(field,item_index,chunk_index))");
  }

  // Temporary safety tripwire, NOT a compatibility reader/migrator. Remove
  // after the one-shot migration is complete and the cutover accepted.
  assertNoLegacy() {
    const legacy=this.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document'").toArray();
    if (legacy.length) throw Error("legacy profile schema detected: perform external one-shot migration before deploying this runtime");
  }

  revision() {
    this.assertNoLegacy();
    const m=this.db.select().from(meta).where(eq(meta.id,1)).get();
    if(!m) return {rev:0};
    if(m.version!==version) return {unreadable:true};
    return {rev:m.rev,wid:m.wid};
  }

  current() {
    this.assertNoLegacy();
    const m=this.db.select().from(meta).where(eq(meta.id,1)).get();
    if (!m) {
      if (this.db.select().from(sections).limit(1).get() || this.db.select().from(fragments).limit(1).get())
        return {unreadable:true};
      return {state:null,rev:0};
    }
    if(m.version!==version) return {unreadable:true};
    try {
      const allSections=this.db.select().from(sections).orderBy(sections.position).all();
      const allFragments=this.db.select().from(fragments).orderBy(fragments.field,fragments.item,fragments.chunk).all();
      const grouped=new Map();
      for(const f of allFragments) {
        if(f.item < -1 || f.chunk < 0 || f.payload.length>CHUNK_BYTES) throw Error("invalid fragment");
        if(!grouped.has(f.field)) grouped.set(f.field,new Map());
        const items=grouped.get(f.field);
        if(!items.has(f.item)) items.set(f.item,[]);
        const list=items.get(f.item);
        if(list.length!==f.chunk) throw Error("noncontiguous fragment");
        list.push(f.payload);
      }
      const entries=[], seen=new Set();
      for(const [i,s] of allSections.entries()) {
        if(s.position!==i || seen.has(s.field)) throw Error("invalid section");
        seen.add(s.field);
        const items=grouped.get(s.field)??new Map();
        if(s.kind==="array") {
          if(items.has(-1)) throw Error("scalar fragment in array");
          const array=[];
          for(let n=0;n<items.size;n++){
            if(!items.has(n)) throw Error("array gap");
            array.push(decode(items.get(n)));
          }
          entries.push([s.field,array]);
        } else if(s.kind==="value") {
          if(items.size!==1 || !items.has(-1)) throw Error("missing scalar");
          entries.push([s.field,decode(items.get(-1))]);
        } else throw Error("unknown kind");
      }
      for(const field of grouped.keys()) if(!seen.has(field)) throw Error("orphan fragment");
      const state=Object.fromEntries(entries);
      if(state._rev!==m.rev || state._wid!==m.wid) throw Error("metadata mismatch");
      return {state,rev:m.rev};
    }catch{return {unreadable:true};}
  }

  save(state,rev) {
    this.assertNoLegacy();
    if(state._rev!==rev || typeof state._wid!=="string") throw Error("invalid revision metadata");
    const oldSections=new Map(this.db.select().from(sections).all().map(s=>[s.field,s]));
    const oldParts=new Map(this.db.select().from(fragments).all().map(p=>[key(p.field,p.item,p.chunk),p.payload]));
    const keep=new Set(), fields=Object.entries(state);
    for(const [pos,[field,value]] of fields.entries()) {
      const isArray=Array.isArray(value), kind=isArray?"array":"value", previous=oldSections.get(field);
      if(!previous || previous.kind!==kind || previous.position!==pos)
        this.db.insert(sections).values({field,position:pos,kind}).onConflictDoUpdate({target:sections.field,set:{position:pos,kind}}).run();
      for(const [item,v] of (isArray?value.map((v,i)=>[i,v]):[[-1,value]])) {
        for(const [chunk,payload] of chunksOf(v).entries()) {
          const k=key(field,item,chunk);
          keep.add(k);
          const old=oldParts.get(k);
          if(old && Buffer.compare(Buffer.from(old),payload)===0) continue;
          this.db.insert(fragments).values({field,item,chunk,payload})
            .onConflictDoUpdate({target:[fragments.field,fragments.item,fragments.chunk],set:{payload}}).run();
        }
      }
    }
    for(const k of oldParts.keys()) if(!keep.has(k)) {
      const [field,item,chunk]=JSON.parse(k);
      this.db.delete(fragments).where(and(eq(fragments.field,field),eq(fragments.item,item),eq(fragments.chunk,chunk))).run();
    }
    const names=new Set(fields.map(([f])=>f));
    for(const f of oldSections.keys()) if(!names.has(f))
      this.db.delete(sections).where(eq(sections.field,f)).run();
    this.db.insert(meta).values({id:1,rev,wid:state._wid,version})
      .onConflictDoUpdate({target:meta.id,set:{rev,wid:state._wid,version}}).run();
  }
  clear(){
    this.db.delete(fragments).run();
    this.db.delete(sections).run();
    this.db.delete(meta).run();
  }
}

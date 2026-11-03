import { stampPut } from "../../api/sync-stamps.js";
import { initMedia, noteReferences, mediaRequest, deleteAllProfileData, garbageCollect, scheduleGarbageCollection } from "./media.js";
import { forClient, json, jsonBody, randomHex, validateProfile } from "./protocol.js";

const WID_KEEP = 50;
const clone = value => JSON.parse(JSON.stringify(value));

/**
 * The DO is the write serialization boundary. No await is allowed between
 * reading the revision and committing the next one.
 */
export class ProfileDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, revision INTEGER NOT NULL)"
    );
    initMedia(this);
  }

  current() {
    const row = this.sql.exec("SELECT body, revision FROM document WHERE id = 1").toArray()[0];
    if (!row) return { state: null, rev: 0 };
    try { return { state: JSON.parse(row.body), rev: row.revision }; }
    catch { return { unreadable: true }; }
  }

  read(path) {
    const { state, rev, unreadable } = this.current();
    if (unreadable) return json({ error: "state unreadable" }, 503);
    if (path === "/api/data/rev") {
      return json({ rev, ...(state?._wid ? { wid: state._wid } : {}) });
    }
    return json({ state: forClient(state), rev });
  }

  write(body) {
    if (this.mediaSweepRunning) return json({error:"media maintenance in progress"},503);
    // This closure is sync by design: serializable CAS + JSON commit in one DO.
    return this.ctx.storage.transactionSync(() => {
      const { state: cur, rev: curRev, unreadable } = this.current();
      if (unreadable) return json({ error: "state unreadable" }, 503);
      const next = clone(body.state);
      const bad = validateProfile(next);
      if (bad) return json({ error: bad.error }, bad.status);
      if ((body.baseRev != null && body.baseRev !== curRev) ||
          (body.baseRev != null && typeof body.baseWid === "string" &&
           cur?._wid && body.baseWid !== cur._wid)) {
        return json({ error: "conflict", rev: curRev, state: forClient(cur) }, 409);
      }
      delete next.active;
      if (Number(cur?.resetAt || 0) > Number(next.resetAt || 0)) {
        next.resetAt = cur.resetAt;
        if (cur.resetIds && typeof cur.resetIds === "object") next.resetIds = cur.resetIds;
        else delete next.resetIds;
      }
      const report = {};
      try {
        stampPut(cur, next, {
          overRead: body.baseRev != null && body.baseRev === curRev,
          stamped: body.stamped === true,
          report
        });
      } catch (err) {
        if (err instanceof RangeError) return json({ error: "invalid state" }, 400);
        throw err;
      }
      next._rev = curRev + (report.changed ? 2 : 1);
      next._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
        .filter(x => typeof x === "string").slice(-WID_KEEP);
      next._wid = randomHex(8);
      let content;
      try { content = JSON.stringify(next); }
      catch (err) {
        if (err instanceof RangeError) return json({ error: "invalid state" }, 400);
        throw err;
      }
      this.sql.exec("INSERT INTO document(id, body, revision) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, revision = excluded.revision", content, next._rev);
      noteReferences(this,next);
      // The externally returned revision intentionally differs if stampPut modified unknown fields:
      // matching Node behavior causes the client to pull the stamped state on the next check.
      return json({ ok: true, ts: next._ts || null, rev: curRev + 1, wid: next._wid });
    });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method==="POST"&&path==="/_internal/delete-all"){
      return deleteAllProfileData(this);
    }
    if (request.method === "GET" && (path === "/api/data" || path === "/api/data/rev")) {
      return this.read(path);
    }
    if (request.method === "PUT" && path === "/api/data") {
      const parsed = await jsonBody(request);
      if (parsed.error) return parsed.error;
      const response=this.write(parsed.value);
      if(response.ok)await scheduleGarbageCollection(this);
      return response;
    }
    if (path.startsWith("/api/media/")){
      const response=await mediaRequest(this,request);
      if(response.ok && request.method!=="GET")await scheduleGarbageCollection(this);
      return response;
    }
    return json({ error: "not found" }, 404);
  }

  async alarm(){
    const grace=Math.max(0,Number(this.env.MEDIA_GC_GRACE_DAYS??14))*86400000;
    await garbageCollect(this,grace);
    await scheduleGarbageCollection(this);
  }
}

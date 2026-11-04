import { stampPut } from "../../api/sync-stamps.js";
import { ProfileStore } from "./profile-store.js";
import { initMedia, noteReferences, mediaRequest, deleteAllProfileData, garbageCollect, scheduleGarbageCollection, profileDeleted } from "./media.js";
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
    this.store = new ProfileStore(ctx.storage);
    initMedia(this);
  }

  current() {
    return this.store.current();
  }

  read(path) {
    if(profileDeleted(this))return json({error:"profile removed",code:"profile-deleted"},410);
    if (path === "/api/data/rev") {
      const { rev, wid, unreadable } = this.store.revision();
      if (unreadable) return json({ error: "state unreadable" }, 503);
      return json({ rev, ...(wid ? { wid } : {}) });
    }
    const { state, rev, unreadable } = this.current();
    if (unreadable) return json({ error: "state unreadable" }, 503);
    return json({ state: forClient(state), rev });
  }

  write(body) {
    if(profileDeleted(this))return json({error:"profile removed",code:"profile-deleted"},410);
    if (this.mediaSweepRunning) return json({error:"media maintenance in progress"},503);
    // This closure is sync by design: serializable CAS + JSON commit in one DO.
    return this.ctx.storage.transactionSync(() => {
      if(profileDeleted(this))return json({error:"profile removed",code:"profile-deleted"},410);
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
      this.store.save(next, next._rev);
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

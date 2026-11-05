import {test} from "node:test";
import assert from "node:assert/strict";
import {representativeProfile} from "./profile-fixtures.js";
import {stampPut} from "../sync-stamps.js";
import {referencedHashes} from "../media-references.js";

// Shared application-side contract, independent of filesystem/SQLite/DO/R2.
for(const size of [400,2000]) test(`Node profile model: ${size} workouts preserve future JSON and media references`,()=>{
  const original=representativeProfile(size);
  const copy=JSON.parse(JSON.stringify(original));
  const report={};
  stampPut(null,copy,{stamped:true,now:1700000005000,report});
  assert.deepEqual(copy.workouts,original.workouts);
  assert.deepEqual(copy.routines,original.routines);
  assert.deepEqual(copy.measurements,original.measurements);
  assert.deepEqual(copy.settings,original.settings);
  const refs=referencedHashes(copy);
  assert.equal(refs.has("a".repeat(64)),true);
  assert.equal(refs.size,1);
  assert.equal(copy.workouts.length,size);
});

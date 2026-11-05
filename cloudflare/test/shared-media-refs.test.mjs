// The original Node backend and Cloudflare Worker use exactly the same
// media-reference discovery. Its shared fixture is the product contract.
import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {referencedHashes as shared} from "../../api/media-references.js";
import {referencedHashes as worker} from "../src/media.js";

const fixture=new URL("../../api/test/fixtures/media-refs.json",import.meta.url);
const cases=JSON.parse(fs.readFileSync(fixture,"utf8")).referencedHashes;
test("all canonical Node/frontend media reference fixtures are shared with Cloudflare",()=>{
  assert.ok(cases.length>=10);
  for(const c of cases){
    assert.deepEqual([...shared(c.state)].sort(),[...c.expect].sort(),c.name);
    assert.deepEqual([...worker(c.state)].sort(),[...c.expect].sort(),c.name);
  }
});

import {describe,it,expect} from "vitest";
import {representativeProfile} from "../../../api/test/profile-fixtures.js";
import {exportBackupZip,readBackupFile,storeBackupMedia} from "./backup-media.js";
import {createMediaStore,memoryBackend} from "./media-store.js";
import {jpeg} from "./media-samples.test-util.js";
import {sha256Hex} from "./sha256.js";

// Tests the *existing* stock UI ZIP format with a representative whole profile;
// no backend-specific backup schema or Cloudflare-only feature is introduced.
describe("portable backup of representative training history",()=>{
  it("round-trips 400 workouts, all JSON fields and content-addressed media",async()=>{
    const state=representativeProfile(400);
    const bytes=jpeg(),hash=await sha256Hex(bytes);
    const ref={kind:"image",hash,mime:"image/jpeg",size:bytes.length,width:640,height:480,at:1700000000000};
    for(const w of state.workouts)if(w.media)w.media=[ref];
    state.dayPhotos={"2026-01-01":{_ts:1700000000000,m:ref}};
    state.customEx[0].media=ref;
    const originalMedia=createMediaStore(memoryBackend());
    await originalMedia.put(hash,new Blob([bytes],{type:"image/jpeg"}),{mime:"image/jpeg"});
    const out=await exportBackupZip(state,{media:originalMedia,now:new Date("2026-11-05T00:00:00Z")});
    expect(out.missing).toBe(0);
    expect(out.included).toBe(1);
    const parsed=await readBackupFile(new File([out.blob],"openGym-backup.zip",{type:"application/zip"}));
    expect(parsed.zip).toBe(true);
    expect(parsed.state.workouts).toHaveLength(400);
    expect(parsed.state.workouts[399].entries[2].sets[3].drops).toEqual([{w:25,r:5}]);
    expect(parsed.state.settings).toEqual(state.settings);
    expect(parsed.state.measurements).toEqual(state.measurements);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].hash).toBe(hash);
    const destinationMedia=createMediaStore(memoryBackend());
    expect(await storeBackupMedia(parsed.files,{media:destinationMedia})).toEqual({stored:1,skipped:0});
    const recovered=await destinationMedia.get(hash);
    expect(recovered?.blob).toBeDefined();
    expect(new Uint8Array(await recovered.blob.arrayBuffer())).toEqual(bytes);
  });
});

import {test} from "node:test";
import assert from "node:assert/strict";
import * as M from "../../api/test/media-samples.mjs";
import {sniffMedia,videoInfo,limits,maxBytes} from "../src/media-validation.js";
import {referencedHashes} from "../src/media.js";
import {sniffMedia as originalSniff,referencedHashes as originalRefs} from "../../api/media.js";

test("media MIME sniff matches upstream for supported and rejected formats",()=>{
  const samples=[
    M.jpeg(),M.png(),M.gif(),M.webp(),M.mp4(),M.mp4({brand:"qt  "}),
    M.ebml("webm"),M.ebml("matroska"),M.svg(),M.html(),M.pdf(),M.zip(),
    M.ftyp("avif"),M.ftyp("heic"),M.ftyp("mp42"),Buffer.alloc(4)
  ];
  for(const sample of samples){
    assert.equal(sniffMedia(sample)?.mime??null,originalSniff(sample)?.mime??null,
      "MIME mismatch for "+sample.subarray(0,16).toString("hex"));
  }
});

test("MP4/MOV duration parser matches upstream duration behavior",async()=>{
  // Old implementation's parser expects a file handle; expose a file descriptor
  // from temp bytes for strict behavioral comparison.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const {mp4Info}=await import("../../api/media.js");
  const samples=[
    M.mp4(),M.mp4({seconds:40}),M.mp4({seconds:75}),M.mp4({brand:"qt  ",seconds:10}),
    M.mp4({version:1,seconds:32}),M.mp4({moovAtEnd:true,seconds:10}),
    M.mp4({bigMdat:true}),M.mp4({moovPad:2000}),
    M.ftyp("isom"),M.jpeg(),M.mp4().subarray(0,90)
  ];
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gym-cf-media-"));
  try{
    for(let i=0;i<samples.length;i++){
      const file=path.join(dir,String(i));fs.writeFileSync(file,samples[i]);
      const fd=fs.openSync(file,"r");
      let expected;
      try{expected=mp4Info(fd,samples[i].length);}
      finally{fs.closeSync(fd);}
      assert.deepEqual(videoInfo(samples[i]),expected,"video parser mismatch sample "+i);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("media refs are identical to Node for nested workout/set/day photos",()=>{
  const a="a".repeat(64),b="b".repeat(64),c="c".repeat(64),d="d".repeat(64),e="e".repeat(64);
  const s={
    customEx:[{id:"cx",media:{hash:a,poster:{hash:b}}}],
    workouts:[{id:"w1",media:[{hash:c}],entries:[{sets:[{media:[{hash:d}]}]}]}],
    dayPhotos:{x:{m:{hash:e}}}
  };
  assert.deepEqual([...referencedHashes(s)],[...originalRefs(s)]);
  for(const invalid of [null,undefined,{},[],{customEx:[null]},{workouts:[{entries:[null]}]}]){
    assert.deepEqual([...referencedHashes(invalid)],[...originalRefs(invalid)]);
  }
});

test("upstream default media limits and caps retained",()=>{
  const v=limits({});
  assert.equal(v.imageMB,2);
  assert.equal(v.gifMB,8);
  assert.equal(v.videoMB,40);
  assert.equal(v.quotaMB,200);
  assert.equal(maxBytes(v,"video"),40*1048576);
});

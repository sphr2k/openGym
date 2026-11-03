/**
 * Pure Worker implementation of upstream api/media.js validation.
 * No node:fs, no content-type trust, no external video parsers.
 */
export const HASH_RE = /^[0-9a-f]{64}$/;
export const TYPES = {
  "image/jpeg": { kind: "image", category: "still", ext: "jpg", capMB: 2 },
  "image/png": { kind: "image", category: "still", ext: "png", capMB: 2 },
  "image/webp": { kind: "image", category: "still", ext: "webp", capMB: 2 },
  "image/gif": { kind: "gif", category: "still", ext: "gif", capMB: 8 },
  "video/mp4": { kind: "video", category: "video", ext: "mp4", capMB: 40 },
  "video/quicktime": { kind: "video", category: "video", ext: "mov", capMB: 40 },
  "video/webm": { kind: "video", category: "video", ext: "webm", capMB: 40 }
};
const MP4_BRANDS = new Set([
  "isom","iso2","iso3","iso4","iso5","iso6","mp41","mp42","avc1","M4V ","M4VP",
  "dash","mmp4","MSNV","3gp4","3gp5","3gp6","3g2a"
]);
const decoder = new TextDecoder("latin1");
const ascii = (u, off, len) => decoder.decode(u.subarray(off,off+len));
const start = (u,...b) => b.every((v,i)=>u[i]===v);

export function limits(env={}) {
  const num=(key, fallback,min)=> {
    const value=Number(env[key]);
    return env[key] == null || !Number.isFinite(value) || value<min ? fallback : value;
  };
  return {
    enabled: !/^(false|no|off|0)$/i.test(String(env.MEDIA_UPLOADS??"true").trim()),
    quotaMB: num("MEDIA_QUOTA_MB",200,0),
    imageMB: num("MEDIA_IMAGE_MAX_MB",2,0.001),
    gifMB: num("MEDIA_GIF_MAX_MB",8,0.001),
    videoMB: num("MEDIA_VIDEO_MAX_MB",40,0.001),
    videoSec: num("MEDIA_VIDEO_MAX_SEC",60,1),
    gcGraceDays: num("MEDIA_GC_GRACE_DAYS",14,0),
  };
}
export function mediaConfig(l){
  return {imageMB:l.imageMB,gifMB:l.gifMB,videoMB:l.videoMB,videoSec:l.videoSec,quotaMB:l.quotaMB,workouts:true,days:true,sets:true};
}
export function sniffMedia(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const match = mime => ({mime,...TYPES[mime]});
  if (start(u,0xff,0xd8,0xff)) return match("image/jpeg");
  if (start(u,0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)) return match("image/png");
  if (ascii(u,0,6)==="GIF87a" || ascii(u,0,6)==="GIF89a") return match("image/gif");
  if (ascii(u,0,4)==="RIFF" && ascii(u,8,4)==="WEBP") return match("image/webp");
  if (ascii(u,4,4)==="ftyp") {
    const brand=ascii(u,8,4);
    if (brand==="qt  ") return match("video/quicktime");
    if (MP4_BRANDS.has(brand)) return match("video/mp4");
    return null;
  }
  if (start(u,0x1a,0x45,0xdf,0xa3)) {
    return ebmlDocType(u)==="webm" ? match("video/webm") : null;
  }
  return null;
}
function vint(u,i,keepMarker){
  if(i>=u.length || u[i]===0)return null;
  const first=u[i];let len=1;
  while(len<=8 && !(first&(0x80>>(len-1))))len++;
  if(len>8 || i+len>u.length)return null;
  let n=keepMarker?first:first&(0xff>>len);
  for(let k=1;k<len;k++)n=n*256+u[i+k];
  return {n,len};
}
function ebmlDocType(u){
  const size=vint(u,4,false);if(!size)return null;
  let pos=4+size.len;
  const end=Math.min(u.length,pos+size.n);
  while(pos<end){
    const id=vint(u,pos,true);
    const len=id&&vint(u,pos+id.len,false);
    if(!len)return null;
    const body=pos+id.len+len.len;
    if(id.n===0x4282){
      if(body+len.n>u.length)return null;
      return ascii(u,body,len.n).replace(/\0+$/,'');
    }
    pos=body+len.n;
  }
  return null;
}
const view = u => new DataView(u.buffer,u.byteOffset,u.byteLength);
function boxAt(u,pos,end) {
  if (end-pos<8) return null;
  const v=view(u),raw=v.getUint32(pos),kind=ascii(u,pos+4,4);
  let size=raw,header=8;
  if(raw===1){
    if(end-pos<16)return null;
    const big=v.getBigUint64(pos+8);
    if(big>BigInt(Number.MAX_SAFE_INTEGER))return null;
    size=Number(big);header=16;
  } else if(raw===0)size=end-pos;
  return size>=header && size<=end-pos? {kind,begin:pos+header,end:pos+size,length:size-header}:null;
}
/** Validate QuickTime and MP4 box framing and duration from mvhd/mehd. */
export function videoInfo(buf) {
  const u=buf instanceof Uint8Array?buf:new Uint8Array(buf);
  if(u.length<32)return null;
  let pos=0,moov=null,brand=null,boxes=0;
  while(pos<u.length && boxes++<10000){
    const b=boxAt(u,pos,u.length);
    if(!b)return null;
    if(pos===0){
      if(b.kind!=="ftyp"||b.length<4)return null;
      brand=ascii(u,b.begin,4);
    }
    if(b.kind==="moov"){moov=b;break;}
    pos=b.end;
  }
  if(!moov || moov.length>8*1024*1024)return null;
  let timescale=0,duration=null,fragmentDuration=null,sawMvhd=false;
  const v=view(u);
  pos=moov.begin;
  while(pos<moov.end && boxes++<10000){
    const b=boxAt(u,pos,moov.end);
    if(!b)return null;
    if(b.kind==="mvhd"&&!sawMvhd){
      sawMvhd=true;
      const version=u[b.begin];
      if(version===1){
        if(b.length<32)return null;
        timescale=v.getUint32(b.begin+20);
        const d=v.getBigUint64(b.begin+24);
        duration=d===0n || d===0xffffffffffffffffn ? null : Number(d);
      } else {
        if(b.length<20)return null;
        timescale=v.getUint32(b.begin+12);
        const d=v.getUint32(b.begin+16);
        duration=d===0||d===0xffffffff?null:d;
      }
    } else if(b.kind==="mvex"){
      let inner=b.begin;
      while(inner<b.end && boxes++<10000){
        const c=boxAt(u,inner,b.end);
        if(!c)return null;
        if(c.kind==="mehd"&&c.length>=8){
          const ver=u[c.begin],d=ver===1&&c.length>=12?v.getBigUint64(c.begin+4):BigInt(v.getUint32(c.begin+4));
          if(d!==0n && d!==0xffffffffffffffffn && d!==0xffffffffn)fragmentDuration=Number(d);
        }
        inner=c.end;
      }
    }
    pos=b.end;
  }
  if(!sawMvhd || !timescale)return null;
  const d=duration??fragmentDuration;
  return {brand,durationSec:d==null?null:Math.round(d/timescale*1000)/1000};
}
export const messages = {
  "bad-request":"bad request","media-type":"that file type is not accepted",
  "media-too-large":"that file is too large","media-quota":"your space for photos and videos is full",
  "media-invalid":"that video could not be read","media-too-long":"that video is too long",
  "media-missing":"no such file","hash-mismatch":"the file does not match its name",
  busy:"too many uploads at once, try again in a moment"
};
export const quotaBytes = l => l.quotaMB>0?Math.round(l.quotaMB*1048576):0;
export const maxBytes = (l,kind)=>Math.round((kind==="video"?l.videoMB:kind==="gif"?l.gifMB:l.imageMB)*1048576);

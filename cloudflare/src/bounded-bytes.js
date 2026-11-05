/**
 * Bounded Workers ReadableStream -> Uint8Array for media sniffing and SHA-256.
 * Prefer one precisely sized allocation when Content-Length is available.
 * Unlike collecting chunks and flattening them, this retains one payload
 * buffer and returns a zero-copy subarray.
 */
export async function readBoundedBytes(request,max) {
  const declared=Number(request.headers.get("content-length")||0);
  if(declared>max)return null;
  const reader=request.body?.getReader();
  if(!reader)return new Uint8Array();
  let capacity=Number.isSafeInteger(declared) && declared>0
    ? declared : Math.min(max,64*1024);
  let buffer=new Uint8Array(capacity),size=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      const next=size+value.byteLength;
      if(next>max){
        await reader.cancel().catch(()=>{});
        return null;
      }
      if(next>capacity){
        let grown=Math.max(1,capacity);
        while(grown<next)grown=Math.min(max,grown*2);
        const larger=new Uint8Array(grown);
        larger.set(buffer.subarray(0,size));
        buffer=larger;
        capacity=grown;
      }
      buffer.set(value,size);
      size=next;
    }
  }finally{
    reader.releaseLock();
  }
  return buffer.subarray(0,size);
}

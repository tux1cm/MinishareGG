// Incremental RFC 1321 MD5 for verifying Drive binary checksums without buffering a file.
// Integrity check only; never used for passwords, OAuth or security signatures.
const K=Uint32Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296));
const SH=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
export class MD5 {
 constructor(){this.h=new Uint32Array([0x67452301,0xefcdab89,0x98badcfe,0x10325476]);this.tail=new Uint8Array(64);this.used=0;this.length=0n;this.finished=false;}
 block(bytes,offset=0){const words=new Uint32Array(16);for(let j=0;j<16;j++){const p=offset+j*4;words[j]=(bytes[p]|bytes[p+1]<<8|bytes[p+2]<<16|bytes[p+3]<<24)>>>0;}let [a,b,c,d]=this.h;
  for(let i=0;i<64;i++){let f,g;if(i<16){f=b&c|~b&d;g=i;}else if(i<32){f=d&b|~d&c;g=(5*i+1)%16;}else if(i<48){f=b^c^d;g=(3*i+5)%16;}else{f=c^(b|~d);g=7*i%16;}const sum=(a+f+K[i]+words[g])>>>0,shift=SH[(i>>4)*4+i%4],next=(b+((sum<<shift)|(sum>>>(32-shift))))>>>0;a=d;d=c;c=b;b=next;}
  this.h[0]=(this.h[0]+a)>>>0;this.h[1]=(this.h[1]+b)>>>0;this.h[2]=(this.h[2]+c)>>>0;this.h[3]=(this.h[3]+d)>>>0;
 }
 update(bytes){if(this.finished)throw new Error('Checksum already finalized');this.length+=BigInt(bytes.length);let pos=0;if(this.used){const n=Math.min(64-this.used,bytes.length);this.tail.set(bytes.subarray(0,n),this.used);this.used+=n;pos=n;if(this.used===64){this.block(this.tail);this.used=0;}}while(pos+64<=bytes.length){this.block(bytes,pos);pos+=64;}if(pos<bytes.length){this.tail.set(bytes.subarray(pos),0);this.used=bytes.length-pos;}return this;}
 digest(){if(this.finished)throw new Error('Checksum already finalized');let bits=this.length*8n;const padding=new Uint8Array(this.used<56?64-this.used:128-this.used);padding[0]=0x80;for(let i=0;i<8;i++){padding[padding.length-8+i]=Number(bits&255n);bits>>=8n;}this.update(padding);this.finished=true;return [...this.h].map(n=>[0,8,16,24].map(s=>((n>>>s)&255).toString(16).padStart(2,'0')).join('')).join('');}
}
export async function hashBlob(blob,signal){const hash=new MD5();for await(const part of blob.stream()){signal?.throwIfAborted();hash.update(part);}return hash.digest();}

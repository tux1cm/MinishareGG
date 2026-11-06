import {MD5,hashBlob} from './md5.js';
import {AppsScriptBridge} from './bridge.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function encode(bytes){let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(raw);}
function decode(value){return Uint8Array.from(atob(value),x=>x.charCodeAt(0));}
export function byteRange(header,total){
  if(!header)return {start:0,end:total-1,status:200};
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!total||(!m[1]&&!m[2]))throw new Error('INVALID_RANGE');
  let start,end;if(!m[1]){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw new Error('INVALID_RANGE');start=Math.max(0,total-suffix);end=total-1;}
  else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),total-1):total-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=total||end<start)throw new Error('INVALID_RANGE');return {start,end,status:206};
}
export class BackendDrive {
  constructor(url,bridge){this.bridge=bridge||new AppsScriptBridge(url);this.token='';this.usesBridge=true;this.snapshot={files:[],messages:[]};}
  async call(op,body={},signal){try{return await this.bridge.call(op,body,this.token,signal);}catch(e){if(e.message==='SESSION_EXPIRED')this.onUnauthorized?.();throw e;}}
  async login(password,remember){const result=await this.bridge.call('login',{password,remember,snapshot:true});this.token=result.session;if(result.snapshot){this.ownerId=result.snapshot.ownerId;this.snapshot={files:result.snapshot.files,messages:result.snapshot.messages};}return result;}
  async refresh(){const data=await this.call('snapshot');this.ownerId=data.ownerId;this.snapshot={files:data.files,messages:data.messages};return data;}
  async trash(){return (await this.call('trash.list')).files;}
  async purgeTrash(ids){let deleted=0;for(let i=0;i<ids.length;i+=20)deleted+=(await this.call('trash.purge',{driveIds:ids.slice(i,i+20)})).deleted;return deleted;}
  file(id){const file=this.snapshot.files.find(x=>x.id===id);if(!file)throw new Error('File không tồn tại');return file;}
  async record(doc){
    const key=`ms-record:${this.ownerId}:${doc.id}`;let ticket=sessionStorage.getItem(key);
    if(!ticket){ticket=(await this.call('record.prepare',{uuid:doc.id,type:doc.type})).ticket;sessionStorage.setItem(key,ticket);}
    return this.call('record.write',{ticket,doc});
  }
  async send(kind,text='',file_id=null,fromUpload=false){
    if(kind==='text'&&(!text.trim()||text.length>2047))throw new Error('Tin nhắn không hợp lệ');
    if(kind==='attachment')this.file(file_id);let id=crypto.randomUUID();
    const pendingKey=`ms-pending-text:${this.ownerId}`;if(kind==='text'){let pending=null;try{pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');}catch{}if(pending?.text===text)id=pending.id;else sessionStorage.setItem(pendingKey,JSON.stringify({id,text}));}
    if(fromUpload){let h=new MD5().update(new TextEncoder().encode(file_id+':upload-attachment')).digest();h=h.slice(0,12)+'3'+h.slice(13,16)+(parseInt(h[16],16)&3|8).toString(16)+h.slice(17);id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
    const result=await this.record({schema:1,type:'message',id,kind,text,file_id});if(kind==='text')sessionStorage.removeItem(pendingKey);return result;
  }
  async remove(id,isFile){if(isFile)return this.call('file.delete',{driveId:this.file(id).drive_id});return this.record({schema:1,type:'delete',id:crypto.randomUUID(),target:id});}
  async upload(file,progress,signal){
    const key=`ms-upload:${this.ownerId}:${file.name}:${file.size}:${file.lastModified}`;
    let task=JSON.parse(sessionStorage.getItem(key)||'null');if(!task){task={uuid:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(task));}
    const save=()=>sessionStorage.setItem(key,JSON.stringify(task));
    try{
      let init=await this.call('upload.start',{uuid:task.uuid,name:file.name,size:file.size,mime:file.type||'application/octet-stream'},signal);task.ticket=init.ticket;save();
      let status;try{status=await this.call('upload.status',{ticket:task.ticket},signal);}catch(e){if(e.message!=='UPLOAD_SESSION_EXPIRED')throw e;init=await this.call('upload.start',{uuid:task.uuid,name:file.name,size:file.size,mime:file.type||'application/octet-stream',restart:true},signal);task.ticket=init.ticket;save();status=await this.call('upload.status',{ticket:task.ticket},signal);}
      let failures=0;
      while(!status.complete){signal?.throwIfAborted();const offset=status.offset;if(!Number.isSafeInteger(offset)||offset<0||offset>=file.size)throw new Error('Offset upload không hợp lệ');const bytes=new Uint8Array(await file.slice(offset,Math.min(offset+init.chunkSize,file.size)).arrayBuffer());
        try{status=await this.call('upload.chunk',{ticket:task.ticket,offset,data:encode(bytes)},signal);failures=0;progress?.(Math.min(99,status.offset*100/file.size));}
        catch(e){if(signal?.aborted||/SESSION_EXPIRED|UPLOAD_CANCELLED|checksum|quota|403|401/i.test(e.message)||++failures>3)throw e;await pause(500*2**failures);status=await this.call('upload.status',{ticket:task.ticket},signal);}
      }
      progress?.(99);const md5=await hashBlob(file,signal);signal?.throwIfAborted();const published=await this.call('upload.finish',{ticket:task.ticket,md5},signal);signal?.throwIfAborted();
      sessionStorage.removeItem(key);this.snapshot.files=this.snapshot.files.filter(x=>x.id!==published.id).concat(published);return published.id;
    }catch(e){if(signal?.aborted&&task.ticket){await this.call('upload.cancel',{ticket:task.ticket});sessionStorage.removeItem(key);}throw e;}
  }
  async openMedia(driveId,range,signal){const info=await this.call('download.open',{driveId},signal);const span=byteRange(range,info.size);return {...info,...span,offset:span.start};}
  async readMedia(handle,signal){if(handle.offset>handle.end)return null;const length=Math.min(handle.chunkSize,handle.end-handle.offset+1);const data=await this.call('download.chunk',{ticket:handle.ticket,offset:handle.offset,length},signal);const bytes=decode(data.data);if(bytes.length!==length||data.length!==length)throw new Error('Chunk tải xuống bị thiếu');handle.offset+=bytes.length;return bytes;}
  async content(id,signal){const handle=await this.openMedia(this.file(id).drive_id,null,signal),owner=this;let stopped=false;return new Response(new ReadableStream({async pull(controller){try{signal?.throwIfAborted();if(stopped)return;const bytes=await owner.readMedia(handle,signal);if(bytes)controller.enqueue(bytes);else controller.close();}catch(e){controller.error(e);}},cancel(){stopped=true;}}),{headers:{'Content-Type':handle.mime,'Content-Length':String(handle.size)}});}
  async serveMedia(port,request){
    const cancellation=new AbortController();let handle,pulling=false;
    port.onmessage=async event=>{
      if(event.data?.type==='cancel'){cancellation.abort();port.close();return;}
      if(event.data?.type!=='pull'||pulling||!handle)return;pulling=true;
      try{const bytes=await this.readMedia(handle,cancellation.signal);if(bytes)port.postMessage({type:'chunk',buffer:bytes.buffer},[bytes.buffer]);else{port.postMessage({type:'end'});port.close();}}
      catch(e){port.postMessage({type:'error',error:e.message});port.close();}finally{pulling=false;}
    };
    try{handle=await this.openMedia(request.driveId,request.range,cancellation.signal);const headers={'Content-Type':handle.mime,'Content-Length':String(Math.max(0,handle.end-handle.start+1)),'Accept-Ranges':'bytes','Cache-Control':'no-store'};if(handle.status===206)headers['Content-Range']=`bytes ${handle.start}-${handle.end}/${handle.size}`;port.postMessage({type:'headers',status:handle.status,headers});}
    catch(e){port.postMessage({type:'error',error:e.message,status:e.message==='INVALID_RANGE'?416:502});port.close();}
  }
}

import {hashBlob,MD5} from './md5.js';
export const MARKER='minishare-gg-v1';
const API='https://www.googleapis.com/drive/v3';
const FIELDS='id,name,size,mimeType,createdTime,modifiedTime,md5Checksum,version,properties';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function project(records, blobs){
  const deleted=new Set(blobs.filter(x=>x.type==='delete').map(x=>x.target));
  const files=records.filter(x=>x.properties?.kind==='file'&&!deleted.has(x.properties.uuid)).map(x=>({id:x.properties.uuid,drive_id:x.id,name:x.name,size:Number(x.size||0),mime:x.mimeType,md5:x.md5Checksum,status:'ready',created_at:x.createdTime}));
  const byId=new Map(files.map(x=>[x.id,x]));
  const messages=blobs.filter(x=>x.type==='message'&&!deleted.has(x.id)&& (x.kind==='text'||byId.has(x.file_id))).map(x=>({...x,file_name:byId.get(x.file_id)?.name,file_size:byId.get(x.file_id)?.size}));
  messages.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
  return {files,messages};
}
export class Drive {
  constructor(token,transport=globalThis.fetch.bind(globalThis)){this.token=token;this.transport=transport;this.snapshot={files:[],messages:[]};this.recordCache=new Map();}
  async raw(url,init={},retry=true){
    const u=new URL(url);if(u.origin!=='https://www.googleapis.com')throw new Error('Drive URL không hợp lệ');
    for(let attempt=0;;attempt++){
      const r=await this.transport(url,{...init,headers:{Authorization:`Bearer ${this.token}`,...init.headers},redirect:'error'});
      if(retry&&[429,500,502,503,504].includes(r.status)&&attempt<4){await delay(500*2**attempt+Math.random()*200);continue;}
      if(!r.ok&&r.status!==308){if(r.status===401)this.onUnauthorized?.();const e=await r.json().catch(()=>({}));throw Object.assign(new Error(e.error?.message||`Google Drive HTTP ${r.status}`),{status:r.status});}return r;
    }
  }
  async json(path,method='GET',body){const r=await this.raw(API+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.status===204?{}:r.json();}
  async list(){let token='',all=[];do{const r=await this.json('/files?'+new URLSearchParams({q:`trashed=false and properties has { key='ms' and value='${MARKER}' }`,fields:`nextPageToken,files(${FIELDS})`,pageSize:'1000',pageToken:token}));all.push(...r.files);token=r.nextPageToken||'';}while(token);return all;}
  async refresh(){
    const [all,about]=await Promise.all([this.list(),this.json('/about?fields=storageQuota,user(emailAddress,permissionId)')]);
    const owner=about.user.permissionId;if(this.ownerId&&this.ownerId!==owner)throw new Error('Tài khoản Google đã thay đổi. Đăng nhập lại.');
    const records=all.filter(x=>['message','delete'].includes(x.properties?.kind)),blobs=new Array(records.length),active=new Set(records.map(x=>x.id));let cursor=0;
    const worker=async()=>{while(cursor<records.length){const index=cursor++,x=records[index],cached=this.recordCache.get(x.id);let doc;
      if(x.version&&cached?.version===x.version)doc=cached.doc;
      else{doc=await (await this.raw(`${API}/files/${encodeURIComponent(x.id)}?alt=media`)).json();if(x.version)this.recordCache.set(x.id,{version:x.version,doc:structuredClone(doc)});}
      blobs[index]={...doc,created_at:x.createdTime};
    }};
    await Promise.all(Array.from({length:Math.min(4,records.length)},worker));
    for(const id of this.recordCache.keys())if(!active.has(id))this.recordCache.delete(id);
    this.snapshot=project(all,blobs);this.ownerId=owner;
    return {...this.snapshot,usage:{used_bytes:Number(about.storageQuota.usage||0),limit_bytes:Number(about.storageQuota.limit||0),available_bytes:about.storageQuota.limit?Math.max(0,Number(about.storageQuota.limit)-Number(about.storageQuota.usage||0)):null}};
  }

  async newId(){return (await this.json('/files/generateIds?count=1&space=drive')).ids[0];}
  async record(doc){
    const key=`gg-record:${this.ownerId||''}:${doc.id}`;let id=sessionStorage.getItem(key);
    if(id){try{await this.json(`/files/${id}?fields=id`);return doc;}catch(e){if(e.status!==404)throw e;}}
    else{id=await this.newId();sessionStorage.setItem(key,id);}
    const meta={id,name:`${doc.type}-${doc.id}.json`,mimeType:'application/json',properties:{ms:MARKER,kind:doc.type,uuid:doc.id}};
    const boundary='minishare_'+crypto.randomUUID();const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
    try{await this.raw('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});}catch(e){try{await this.json(`/files/${id}?fields=id`);}catch{throw e;}}
    return doc;
  }
  async send(kind,text='',file_id=null,fromUpload=false){if(kind==='text'&&(!text.trim()||text.length>2047))throw new Error('Tin nhắn không hợp lệ');if(kind==='attachment'&&!this.snapshot.files.some(x=>x.id===file_id))throw new Error('File đã bị xóa');let id=crypto.randomUUID();if(fromUpload){let h=new MD5().update(new TextEncoder().encode(file_id+':upload-attachment')).digest();h=h.slice(0,12)+'3'+h.slice(13,16)+(parseInt(h[16],16)&3|8).toString(16)+h.slice(17);id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}return this.record({schema:1,type:'message',id,kind,text,file_id});}
  async remove(id,isFile){await this.record({schema:1,type:'delete',id:crypto.randomUUID(),target:id});if(isFile){const file=this.snapshot.files.find(f=>f.id===id);if(file)await this.json(`/files/${encodeURIComponent(file.drive_id)}`,'PATCH',{trashed:true});}}
  file(id){const f=this.snapshot.files.find(x=>x.id===id);if(!f)throw new Error('File không tồn tại');return f;}
  content(id,signal){return this.raw(`${API}/files/${encodeURIComponent(this.file(id).drive_id)}?alt=media`,{signal});}
  async upload(file,onProgress,signal){
    // Session and pre-generated Drive ID persist; source is reselected after closing the tab.
    const key=`gg-upload:${this.ownerId||''}:${file.name}:${file.size}:${file.lastModified}`;
    let task=JSON.parse(sessionStorage.getItem(key)||'null');
    if(!task){task={id:await this.newId(),uuid:crypto.randomUUID(),size:file.size,session:null};sessionStorage.setItem(key,JSON.stringify(task));}
    const save=()=>sessionStorage.setItem(key,JSON.stringify(task));
    let offset=0,complete=false;
    try{
      if(task.session){try{const r=await this.raw(task.session,{method:'PUT',headers:{'Content-Range':`bytes */${file.size}`},body:new Blob([]),signal});complete=r.status!==308;offset=Number((r.headers.get('Range')||'').split('-')[1]||-1)+1;}catch(e){if([404,410].includes(e.status))task.session=null;else throw e;}}
      if(!task.session){
        try{const existing=await this.json(`/files/${task.id}?fields=${FIELDS}`);complete=existing.properties?.kind==='file'&&Number(existing.size)===file.size;if(existing.id&&!complete)throw new Error('Phiên cũ hết hạn. Hủy tác vụ cũ rồi chọn lại file.');}catch(e){if(e.status!==404)throw e;}
        if(!complete){const about=await this.json('/about?fields=storageQuota');if(about.storageQuota.limit&&file.size>Number(about.storageQuota.limit)-Number(about.storageQuota.usage||0))throw new Error('Drive không đủ dung lượng');const r=await this.raw('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':file.type||'application/octet-stream','X-Upload-Content-Length':String(file.size)},body:JSON.stringify({id:task.id,name:file.name,properties:{ms:MARKER,kind:'pending',uuid:task.uuid}}),signal});task.session=r.headers.get('Location');if(!task.session)throw new Error('Drive không trả phiên resumable');save();}
      }
      let failures=0;
      while(!complete){signal?.throwIfAborted();if(offset<0||offset>=file.size)throw new Error('Drive trả offset không hợp lệ');const end=Math.min(offset+8*1024*1024,file.size);try{const r=await this.raw(task.session,{method:'PUT',headers:{'Content-Range':file.size?`bytes ${offset}-${end-1}/${file.size}`:'bytes */0'},body:file.slice(offset,end),signal},false);complete=r.status!==308;offset=complete?file.size:Number((r.headers.get('Range')||'').split('-')[1]||-1)+1;failures=0;onProgress?.(file.size?Math.min(99,offset*100/file.size):99);}catch(e){if(signal?.aborted||e.status&&![429,500,502,503,504].includes(e.status)||++failures>4)throw e;await delay(500*2**failures);const probe=await this.raw(task.session,{method:'PUT',headers:{'Content-Range':`bytes */${file.size}`},body:new Blob([]),signal});complete=probe.status!==308;offset=Number((probe.headers.get('Range')||'').split('-')[1]||-1)+1;}}
      const verified=await this.json(`/files/${task.id}?fields=${FIELDS}`);if(Number(verified.size)!==file.size)throw new Error('Sai dung lượng sau upload');if(verified.md5Checksum&&await hashBlob(file,signal)!==verified.md5Checksum)throw new Error('Checksum upload không khớp');signal?.throwIfAborted();
      await this.json(`/files/${task.id}`,'PATCH',{properties:{ms:MARKER,kind:'file',uuid:task.uuid}});signal?.throwIfAborted();sessionStorage.removeItem(key);this.snapshot.files.push({id:task.uuid,drive_id:task.id,name:file.name,size:file.size,mime:file.type,status:'ready',md5:verified.md5Checksum,created_at:verified.createdTime});return task.uuid;
    }catch(e){if(signal?.aborted){await this.record({schema:1,type:'delete',id:crypto.randomUUID(),target:task.uuid});try{await this.json(`/files/${task.id}`,'PATCH',{trashed:true});}catch(cleanup){if(cleanup.status!==404)throw new Error('Đã dừng truyền; chưa dọn được file tạm trên Drive.');}sessionStorage.removeItem(key);}throw e;}
  }
}

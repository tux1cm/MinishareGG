import {MD5} from './md5.js';
import {BackendDrive} from './backend.js';
import {AppsScriptBridge} from './bridge.js';
import {saveSession,loadSession,clearSession} from './session.js';
import {APPS_SCRIPT_URL} from './config.js';
const API_BASE='https://www.googleapis.com/drive/v3';
let drive=null,transferController=null,cancelQueue=false,serviceBridge=null;

const STORAGE_BUDGET_BYTES = Number.MAX_SAFE_INTEGER; // total project quota, not 50MB/file
const PROXY_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_TEXT_MAX = 6 * 1024 * 1024;
const PREVIEW_DOCX_MAX = 12 * 1024 * 1024;
const PREVIEW_BLOB_MAX = 36 * 1024 * 1024;
const state = { token: '', files: [], messages: [], usage: null, page: 'files', uploadsRunning: false, sending: false, refreshing: false, targetAttachment: false, pendingConfirm: null, previewFileId: null, previewObjectUrl: null, previewEpoch: 0 };
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const icon = (name, size=18) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fileType = name => {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  if(['jpg','jpeg','png','webp','gif','bmp'].includes(ext)) return 'IMG';
  if(['xlsx','xls','csv'].includes(ext)) return 'XLS';
  if(['doc','docx'].includes(ext)) return 'DOC';
  if(['mp4','mov','mkv','webm'].includes(ext)) return 'VID';
  if(['zip','7z','rar'].includes(ext)) return 'ZIP';
  if(ext==='pdf') return 'PDF';
  if(ext==='txt') return 'TXT';
  return 'FILE';
};
const badge = name => {const type=fileType(name);return `<span class="file-badge ${type.toLowerCase()}">${escapeHtml(type)}</span>`;};
// Chỉ hiện nút Xem cho định dạng trình duyệt xử lý được.
function previewKind(file){
  const ext=String(file?.name||'').split('.').pop().toLowerCase();
  if(['png','jpg','jpeg','webp','gif','bmp'].includes(ext))return 'image';
  if(ext==='pdf')return 'pdf';
  if(['txt','md','log','csv','json','xml','yaml','yml','ini','sql'].includes(ext))return 'text';
  if(ext==='docx')return 'docx'; // chỉ xem nội dung chữ, không bảo toàn bố cục Word
  if(['mp4','webm','mov'].includes(ext))return 'video';
  if(['mp3','m4a','aac','wav','ogg','flac'].includes(ext))return 'audio';
  return null; // ZIP/APK/DOC cũ và tệp khác không có trình xem tích hợp
}
const previewAction=(file,scope='file')=>file?.status==='ready'&&previewKind(file)
  ?`<button class="icon-button preview-action" data-${scope}-action="preview" data-id="${escapeHtml(file.id)}" aria-label="Xem trước ${escapeHtml(file.name)}" title="Xem trước">${icon('eye')}</button>`
  :`<span class="preview-spacer" aria-hidden="true"></span>`;

const fmtSize = bytes => {const n=Number(bytes)||0;return n>=1073741824?(n/1073741824).toFixed(1)+' GB':n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B';};
const fmtTime = date => {const t=new Date(date);return Number.isFinite(t.getTime())?new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(t):'—';};
const statusText = status => ({ready:'Đã đồng bộ trên Google Drive',uploading:'Đang chờ hoàn tất',deleting:'Đang xóa',delete_error:'Lỗi xóa — có thể thử lại'})[status]||status;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

function toast(message, level='good', duration=5400){
  const el=document.createElement('div');el.className=`toast ${level}`;el.innerHTML=icon(level==='bad'?'alert':'check')+'<span></span>';
  el.querySelector('span').textContent=message;$('toast-stack').append(el);setTimeout(()=>el.remove(),duration);
}
function switchPage(page){
  if(!['files','chat','settings'].includes(page))return;
  state.page=page;
  $$('.page').forEach(el=>{const active=el.id===`page-${page}`;el.hidden=!active;el.classList.toggle('active',active);});
  $$('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  if(page==='chat')scrollChat();
}
function updateConnection(){
  const connected=Boolean(state.token);
  $('status-dot').classList.toggle('online',connected);
  $('connection-label').textContent=connected?'Đã đăng nhập':'Chưa đăng nhập';
  $('mobile-status').textContent=connected?'Google Drive online':'Chưa đăng nhập';
  $('mobile-status').style.color=connected?'':'#ffbd72';
  $('settings-api').textContent='Google Drive · đăng nhập bằng mật khẩu MiniShare';
}
function showAuth(){
  $('auth-error').hidden=true;$('auth-password').value='';$('auth-modal').hidden=false;
  setTimeout(()=>$('auth-submit').focus(),80);
}
function hideAuth(){ $('auth-password').value='';$('auth-modal').hidden=true; }

async function request(path,opts={}){
  if(!drive)throw new Error('Chưa đăng nhập Google');
  if(opts.method==='POST'&&path==='/v1/messages')return drive.send(opts.json.kind,opts.json.text||'',opts.json.file_id,opts.json.from_upload||false);
  const match=path.match(/^\/v1\/(files|messages)\/([^/]+)$/);
  if(opts.method==='DELETE'&&match){await drive.remove(decodeURIComponent(match[2]),match[1]==='files');return {ok:true};}
  throw new Error('Thao tác Drive không được hỗ trợ');
}
function clearWebSession(){navigator.serviceWorker?.controller?.postMessage({type:'gg-auth-clear'});try{clearSession();}catch{}state.token='';drive=null;updateConnection();}
function backendClient(){
 if(!APPS_SCRIPT_URL)throw new Error('Chưa cấu hình backend MiniShare. Xem docs/APPS_SCRIPT_SETUP.md.');
 if(!serviceBridge)serviceBridge=new AppsScriptBridge(APPS_SCRIPT_URL);
 const backend=new BackendDrive(APPS_SCRIPT_URL,serviceBridge);backend.onUnauthorized=()=>{clearWebSession();showAuth();};return backend;
}
async function connect(password){
 const backend=backendClient(),remember=$('remember-session').checked;
 const session=await backend.login(password,remember);drive=backend;state.token=session.session;
 try{await loadAll();try{saveSession(session,remember);}catch{toast('Trình duyệt không lưu được phiên. Phiên hiện tại vẫn dùng được.');}hideAuth();updateConnection();toast('Đã đăng nhập MiniShare');}
 catch(e){clearWebSession();throw e;}
}
async function restoreSession(){
 let saved=null;try{saved=loadSession();}catch{}
 if(!saved){showAuth();return;}
 try{const backend=backendClient();backend.token=saved.session;drive=backend;state.token=saved.session;await loadAll();hideAuth();updateConnection();}
 catch(e){showAuth();$('auth-error').textContent=e.message;$('auth-error').hidden=false;}
}

async function loadAll(){
  if(!state.token)return;
  const activeDrive=drive;const snapshot=await activeDrive.refresh();if(drive!==activeDrive)return;state.files=snapshot.files;state.messages=snapshot.messages;state.usage=snapshot.usage;
  renderFiles();renderChat();renderAttachList();
}
async function refresh(silent=false){
  if(!state.token){showAuth();return;}
  if(state.refreshing)return;state.refreshing=true;for(const id of ['refresh-files','refresh-chat'])$(id).disabled=true;
  try{await loadAll();if(!silent)toast('Đã cập nhật dữ liệu từ Google Drive.');}
  catch(e){toast(e.message,'bad');}finally{state.refreshing=false;for(const id of ['refresh-files','refresh-chat'])$(id).disabled=false;}
}
function renderFiles(){
  const files=state.files;
  const ready=files.filter(f=>f.status==='ready');
  $('stat-total').textContent=String(files.length);
  $('stat-ready').textContent=String(ready.length);
  $('stat-size').textContent=state.usage?`${fmtSize(state.usage.used_bytes)} / ${fmtSize(state.usage.limit_bytes)}`:fmtSize(ready.reduce((acc,f)=>acc+Number(f.size||0),0));
  const keyword=$('file-search').value.trim().toLocaleLowerCase('vi');
  const filtered=files.filter(f=>String(f.name||'').toLocaleLowerCase('vi').includes(keyword));
  $('file-summary').textContent=`${filtered.length} tệp`;
  $('file-footer').textContent=`${ready.length} tệp đã đồng bộ • ${files.length-ready.length} đang chờ/xử lý • Còn ${fmtSize(state.usage?.available_bytes??0)} / ${state.usage?.limit_bytes?fmtSize(state.usage.limit_bytes):'theo tài khoản'}`;
  $('file-empty').hidden=filtered.length>0;
  $('file-empty').querySelector('h3').textContent=keyword?'Không tìm thấy tệp':'Chưa có tệp';
  $('file-empty').querySelector('p').textContent=keyword?'Hãy thử từ khóa khác.':'Chọn hoặc kéo thả tệp vào đây để tải lên Google Drive.';
  $('file-rows').innerHTML=filtered.map((f,index)=>{
    const ready=f.status==='ready';const time=fmtTime(f.updated_at||f.created_at);
    return `<tr data-file-row="${escapeHtml(f.id)}"><td class="file-number">${index+1}</td><td><div class="file-main">${badge(f.name)}<div class="file-info"><strong title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</strong><small class="${ready?'':'pending'}">${escapeHtml(statusText(f.status))}</small></div></div></td><td>${fmtSize(f.size)}</td><td>${escapeHtml(time)}</td><td><div class="file-actions">${previewAction(f)}<button class="icon-button cyan" data-file-action="download" data-id="${escapeHtml(f.id)}" aria-label="Tải xuống ${escapeHtml(f.name)}" title="Tải xuống" ${ready?'':'disabled'}>${icon('download')}</button><button class="icon-button" data-file-action="attach" data-id="${escapeHtml(f.id)}" title="Đính kèm vào Chat" aria-label="Đính kèm ${escapeHtml(f.name)}" ${ready?'':'disabled'}>${icon('paperclip')}</button><button class="icon-button delete" data-file-action="delete" data-id="${escapeHtml(f.id)}" title="Xóa tệp khỏi Google Drive và tin liên quan" aria-label="Xóa ${escapeHtml(f.name)}">${icon('trash')}</button></div></td></tr>`;
  }).join('');
}
function renderChat(){
  const el=$('chat-messages'); const messages=[...state.messages].reverse();
  $('chat-empty').hidden=messages.length>0;
  $('chat-count').hidden=!messages.length;$('chat-count').textContent=messages.length>99?'99+':String(messages.length);
  el.innerHTML=messages.map(m=>{
    const id=escapeHtml(m.id),time=fmtTime(m.created_at);
    if(m.kind==='attachment'){
      const name=m.file_name||'Tệp đã bị xóa';
      return `<div class="message-bubble attach-bubble" data-msg-id="${id}"><div class="attach-heading"><span>${icon('paperclip')} Tệp đính kèm</span><div class="message-actions"><button class="message-icon" data-msg-action="copy" data-id="${id}" title="Sao chép tên tệp" aria-label="Sao chép">${icon('copy',14)}</button></div></div><div class="attach-content">${badge(name)}<div class="attach-details"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small>${fmtSize(m.file_size)}</small></div>${(state.files.find(f=>f.id===m.file_id)&&previewKind(state.files.find(f=>f.id===m.file_id))) ? `<button class="icon-button preview-action" data-msg-action="preview" data-id="${id}" title="Xem trước" aria-label="Xem trước tệp đính kèm">${icon('eye')}</button>` : ''}<button class="icon-button cyan" data-msg-action="download" data-id="${id}" title="Tải tệp" aria-label="Tải tệp">${icon('download')}</button></div><div class="attach-button-row" style="justify-content:flex-end;margin-top:9px"><button class="attach-danger" data-msg-action="delete-message" data-id="${id}">Xóa tin</button><button class="attach-danger" data-msg-action="delete-file" data-id="${id}">Xóa tệp</button></div><div class="message-time">${escapeHtml(time)}</div></div>`;
    }
    return `<div class="message-bubble" data-msg-id="${id}"><div class="message-row"><div class="message-body">${escapeHtml(m.text||'')}</div><div class="message-actions"><button class="message-icon" data-msg-action="copy" data-id="${id}" title="Sao chép" aria-label="Sao chép tin nhắn">${icon('copy',14)}</button><button class="message-icon" data-msg-action="delete-message" data-id="${id}" title="Xóa tin" aria-label="Xóa tin nhắn">${icon('close',14)}</button></div></div><div class="message-time">${escapeHtml(time)}</div></div>`;
  }).join('');
}
function scrollChat(){const box=$('chat-scroll'); requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight;});}
function renderAttachList(){
  const q=$('attach-search').value.trim().toLocaleLowerCase('vi');
  const found=state.files.filter(f=>f.status==='ready'&&String(f.name).toLocaleLowerCase('vi').includes(q));
  $('attach-list').innerHTML=found.length?found.map(f=>`<button class="attach-choice" data-attach-id="${escapeHtml(f.id)}">${badge(f.name)}<span class="attach-choice-info"><strong>${escapeHtml(f.name)}</strong><small>${fmtSize(f.size)} • Đã đồng bộ Google Drive</small></span>${icon('paperclip')}</button>`).join(''):'<p style="text-align:center;color:var(--mute);padding:26px">Không có tệp phù hợp.</p>';
}
function showAttachmentPicker(){if(!state.token){showAuth();return;}$('attach-search').value='';renderAttachList();$('attach-modal').hidden=false;setTimeout(()=>$('attach-search').focus(),30);}
function hideAttachmentPicker(){ $('attach-modal').hidden=true; }
function askConfirm(text,{mode='delete',title='Xác nhận xóa',yesLabel='Xóa'}={}){
  if(state.pendingConfirm)return Promise.resolve(false);
  $('confirm-title').textContent=title;
  $('confirm-text').textContent=text;
  $('confirm-yes').textContent=yesLabel;
  $('confirm-yes').className=`button ${mode==='upload'?'primary':'danger'}`;
  $('confirm-icon').classList.toggle('upload-warning',mode==='upload');
  $('confirm-icon-use').setAttribute('href',mode==='upload'?'#i-alert':'#i-trash');
  $('confirm-modal').hidden=false;
  return new Promise(resolve=>state.pendingConfirm=resolve);
}
const askDelete=text=>askConfirm(text);
const askUploadWarning=name=>askConfirm(`Tệp “${name}” có tên gợi ý có thể chứa mật khẩu hoặc token. Bạn vẫn muốn tải tệp này lên Google Drive Storage?`,{
  mode:'upload',title:'Cảnh báo trước khi tải lên',yesLabel:'Vẫn tải lên'
});
function resolveDelete(ok){
  const resolver=state.pendingConfirm;state.pendingConfirm=null;
  $('confirm-modal').hidden=true;
  if(resolver)resolver(ok);
}
async function deleteMessage(msg){
  if(!await askDelete('Chỉ xóa tin nhắn này? Tệp đính kèm vẫn còn trên Google Drive.'))return;
  try{await request(`/v1/messages/${encodeURIComponent(msg.id)}`,{method:'DELETE'});await loadAll();toast('Đã xóa tin nhắn, giữ nguyên tệp.');}
  catch(e){toast(e.message,'bad');}
}
async function deleteFile(file){
  if(!file)return;
  if(!await askDelete(`Chuyển “${file.name}” vào thùng rác Google Drive và gỡ các đính kèm liên quan khỏi Chat?`))return;
  try{await request(`/v1/files/${encodeURIComponent(file.id)}`,{method:'DELETE',timeout:65000});await loadAll();toast('Đã xóa tệp khỏi Storage và Chat liên quan.');}
  catch(e){toast('Xóa chưa hoàn tất: '+e.message+'. Có thể thử lại.','bad',9000);await refresh(true);}
}
async function sendMessage(){
  if(!state.token){showAuth();return;}if(state.sending)return;
  const editor=$('message-input'),draft=editor.value,text=draft.trim();if(!text)return;
  if(text.length>2047){toast('Tin nhắn quá 2047 ký tự.','bad');return;}
  const btn=$('send-message');state.sending=true;btn.disabled=true;let sent=false;
  try{await request('/v1/messages',{method:'POST',json:{kind:'text',text}});sent=true;
    if(editor.value===draft){editor.value='';editor.style.height='46px';}
    await loadAll();scrollChat();
  }catch(e){toast(sent?'Tin đã gửi lên Drive. Bấm Làm mới để cập nhật danh sách.':e.message,'bad');}
  finally{state.sending=false;btn.disabled=false;editor.focus();}
}

async function sendAttachment(id,fromUpload=false){
  hideAttachmentPicker();
  try{await request('/v1/messages',{method:'POST',json:{kind:'attachment',file_id:id,from_upload:fromUpload}});await loadAll();switchPage('chat');scrollChat();toast('Đã đính kèm tệp có sẵn trên Google Drive.');}
  catch(e){toast(e.message,'bad');}
}
async function copyText(text){try{await navigator.clipboard.writeText(text);toast('Đã sao chép.');}catch{toast('Trình duyệt không cho truy cập clipboard.','bad');}}

// Xem trước từ private Storage: mỗi lần mở xin URL ký tạm thời, không làm public bucket.
function closePreview(){
  ++state.previewEpoch;
  $('preview-modal').hidden=true;
  $('preview-body').replaceChildren();
  state.previewFileId=null;
  if(state.previewObjectUrl){URL.revokeObjectURL(state.previewObjectUrl);state.previewObjectUrl=null;}
}
function previewInfo(message){
  const p=document.createElement('p');p.className='preview-info';p.textContent=message;
  $('preview-body').replaceChildren(p);
}
async function mediaSource(file){
 if(!('serviceWorker' in navigator))throw new Error('Trình duyệt không hỗ trợ xem media riêng tư. Hãy tải về.');
 await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Tải lại trang để bật xem media riêng tư')),5000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
 await new Promise((resolve,reject)=>{const channel=new MessageChannel();const timer=setTimeout(()=>reject(new Error('Không kết nối được trình xem media')),5000);channel.port1.onmessage=()=>{clearTimeout(timer);resolve();};navigator.serviceWorker.controller.postMessage({type:'gg-auth',mode:'bridge'},[channel.port2]);});
 return new URL('./__drive_media__/'+encodeURIComponent(file.drive_id),location.href).href;
}
async function previewSource(file){return file.id;}
async function fetchPreviewData(file,id,maxBytes){if(Number(file.size)>maxBytes)throw new Error('File quá lớn để xem trước. Hãy tải về.');const data=await (await drive.content(id)).blob();if(data.size>maxBytes)throw new Error('Nội dung vượt giới hạn xem trước');return data;}
// DOCX: giải nén riêng word/document.xml bằng API trình duyệt (không gửi file sang dịch vụ khác).
// Đây là bản xem chữ đơn giản; định dạng/bảng/hình trong Word có thể không giữ nguyên.
async function docxToText(blob){
  const buf=await blob.arrayBuffer(), v=new DataView(buf);
  let end=-1;
  for(let i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-65557);i--){
    if(v.getUint32(i,true)===0x06054b50){end=i;break;}
  }
  if(end<0)throw new Error('Không tìm thấy cấu trúc DOCX hợp lệ.');
  const count=v.getUint16(end+10,true), offset=v.getUint32(end+16,true);
  let p=offset;
  for(let i=0;i<count;i++){
    if(p+46>buf.byteLength||v.getUint32(p,true)!==0x02014b50)break;
    const method=v.getUint16(p+10,true),size=v.getUint32(p+20,true),unpacked=v.getUint32(p+24,true);
    const len=v.getUint16(p+28,true),extra=v.getUint16(p+30,true),comment=v.getUint16(p+32,true);
    const name=new TextDecoder().decode(new Uint8Array(buf,p+46,len));
    if(name==='word/document.xml'){
      if(unpacked>8*1024*1024)throw new Error('Nội dung DOCX quá lớn để xem trước.');
      const local=v.getUint32(p+42,true);
      if(v.getUint32(local,true)!==0x04034b50)throw new Error('DOCX bị lỗi cấu trúc ZIP.');
      const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true);
      if(start+size>buf.byteLength)throw new Error('DOCX thiếu dữ liệu.');
      let xmlBytes=new Uint8Array(buf,start,size);
      if(method===8){
        if(typeof DecompressionStream==='undefined')throw new Error('Trình duyệt chưa hỗ trợ xem DOCX; hãy tải về.');
        const stream=new Blob([xmlBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        xmlBytes=new Uint8Array(await new Response(stream).arrayBuffer());
      }else if(method!==0)throw new Error('Định dạng nén DOCX không được hỗ trợ.');
      if(xmlBytes.byteLength>8*1024*1024)throw new Error('DOCX quá lớn để xem trước.');
      const doc=new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes),'application/xml');
      if(doc.querySelector('parsererror'))throw new Error('Nội dung XML của DOCX không hợp lệ.');
      const lines=[...doc.getElementsByTagName('*')].filter(el=>el.localName==='p').map(el=>
        [...el.getElementsByTagName('*')].filter(n=>n.localName==='t').map(n=>n.textContent).join('')
      );
      return lines.join('\n').trim()||'(Tệp Word không có đoạn văn bản để hiển thị.)';
    }
    p+=46+len+extra+comment;
  }
  throw new Error('Không có nội dung Word (word/document.xml).');
}
async function previewFile(file){
  const kind=previewKind(file);
  if(!file||file.status!=='ready'||!kind)return;
  closePreview();
  const epoch=state.previewEpoch;
  state.previewFileId=file.id;
  $('preview-name').textContent=file.name;
  $('preview-type').textContent=`${fmtSize(file.size)} • Xem trước trên Web`;
  $('preview-modal').hidden=false;
  previewInfo('Đang chuẩn bị xem trước...');
  try{
    const url=await previewSource(file);
    if(epoch!==state.previewEpoch)return;
    const content=$('preview-body');
    const big=Number(file.size)>PREVIEW_BLOB_MAX;
    if(kind==='video'||kind==='audio'){
      const media=document.createElement(kind==='video'?'video':'audio');
      media.controls=true;media.preload='metadata';media.src=await mediaSource(file);if(epoch!==state.previewEpoch)return;
      media.className='preview-media';
      content.replaceChildren(media);
    }else if((kind==='image'||kind==='pdf') && big){
      // Browser xử lý qua liên kết ký trực tiếp, tránh nạp tệp lớn vào RAM JS.
      const view=document.createElement(kind==='image'?'img':'iframe');
      view.className=kind==='image'?'preview-image':'preview-pdf';
      view.src=await mediaSource(file);if(epoch!==state.previewEpoch)return;
      view.title=`Xem trước ${file.name}`;
      view.referrerPolicy='no-referrer';
      content.replaceChildren(view);
    }else{
      const blob=await fetchPreviewData(file,url,
        kind==='text'?PREVIEW_TEXT_MAX:kind==='docx'?PREVIEW_DOCX_MAX:PREVIEW_BLOB_MAX);
      if(epoch!==state.previewEpoch)return;
      if(kind==='text'||kind==='docx'){
        const pre=document.createElement('pre');pre.className='preview-text';
        pre.textContent=kind==='docx'?await docxToText(blob):await blob.text();
        if(epoch!==state.previewEpoch)return;
        content.replaceChildren(pre);
        if(kind==='docx')$('preview-type').textContent=`${fmtSize(file.size)} • Word: xem nội dung chữ (không giữ định dạng)`;
      }else{
        const objectUrl=URL.createObjectURL(blob);
        state.previewObjectUrl=objectUrl;
        const view=document.createElement(kind==='image'?'img':'iframe');
        view.className=kind==='image'?'preview-image':'preview-pdf';
        view.src=objectUrl;view.title=`Xem trước ${file.name}`;
        content.replaceChildren(view);
      }
    }
  }catch(e){if(epoch===state.previewEpoch)previewInfo(`Không thể xem trước: ${e.message}. Bạn có thể tải tệp về máy.`);}
}

// Download files using a SAME-ORIGIN blob: URL or a browser file stream.
// Google media is fetched with Authorization, then saved with its original filename.
// File System Access API streams large files directly to disk on Chrome/Edge.
const STREAM_TO_DISK_BYTES = 256 * 1024 * 1024;
function safeDownloadName(filename){
  let name=String(filename||'download').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_').replace(/[ .]+$/g,'');
  if(!name||name==='.'||name==='..')name='download';
  if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))name='_'+name;
  return name;
}
function downloadMime(file){
  const ext=String(file.name||'').split('.').pop().toLowerCase();
  const mime={
    mp4:'video/mp4',mov:'video/quicktime',mkv:'video/x-matroska',webm:'video/webm',avi:'video/x-msvideo',
    mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',
    png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',svg:'image/svg+xml',heic:'image/heic',heif:'image/heif',
    pdf:'application/pdf',txt:'text/plain',log:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',xml:'application/xml',
    html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',
    doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip:'application/zip',rar:'application/vnd.rar','7z':'application/x-7z-compressed',
    apk:'application/vnd.android.package-archive',exe:'application/vnd.microsoft.portable-executable'
  };
  return mime[ext]||file.mime||'application/octet-stream';
}
async function downloadFile(file){
 if(!file||file.status!=='ready')return;
 if(transferController){toast('Vui lòng đợi hoặc hủy tác vụ đang truyền.','bad');return;}
 let writable=null;
 const controller=new AbortController();transferController=controller;
 try{
   const expected=Number(file.size),name=safeDownloadName(file.name);
   if(typeof window.showSaveFilePicker==='function'){const handle=await window.showSaveFilePicker({suggestedName:name});writable=await handle.createWritable();}
   else if(expected>256*1024*1024)throw new Error('Trình duyệt này chưa hỗ trợ tải file lớn theo stream ra ổ đĩa. Dùng Chrome/Edge hoặc bản Windows.');
   showProgress(`Đang tải ${name}`,0);const res=await drive.content(file.id,controller.signal);const reader=res.body.getReader(),parts=[],hash=new MD5();let total=0;
   for(;;){controller.signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;hash.update(value);total+=value.length;if(total>expected)throw new Error('File vượt kích thước');if(writable)await writable.write(value);else parts.push(value);showProgress(`Đang tải ${name}`,expected?Math.min(99,100*total/expected):99);}
   if(total!==expected)throw new Error('File tải thiếu dữ liệu');if(file.md5&&hash.digest()!==file.md5)throw new Error('Checksum tải xuống không khớp');controller.signal.throwIfAborted();
   if(writable){await writable.close();writable=null;}else{const url=URL.createObjectURL(new Blob(parts,{type:downloadMime(file)}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}toast(`Đã tải ${name}`);
 }catch(e){if(writable)await writable.abort().catch(()=>{});toast(controller.signal.aborted?'Đã hủy tải xuống':e.message,'bad');}
 finally{transferController=null;hideProgress();}
}

function showProgress(title,percent){$('progress-box').hidden=false;$('progress-title').textContent=title;$('progress-percent').textContent=`${Math.max(0,Math.min(100,Math.round(percent)))}%`;$('progress-bar').style.width=`${Math.max(0,Math.min(100,percent))}%`;}
function hideProgress(){$('progress-box').hidden=true;}
async function uploadOne(file){
 if(!Number.isSafeInteger(file.size)||file.size<=0)throw new Error('File trống hoặc dung lượng không hợp lệ');
 transferController=new AbortController();
 try{return await drive.upload(file,p=>showProgress(`Đang tải ${file.name}`,p),transferController.signal);}finally{transferController=null;}
}
async function uploadFiles(fileList,attachAfter=false){
  const files=[...fileList].filter(f=>f instanceof File);
  if(!files.length)return;if(!state.token){toast('Hãy kết nối Google Drive trước khi tải tệp.','bad');showAuth();return;}
  if(state.uploadsRunning){toast('Đang có một lượt upload khác. Vui lòng chờ.','bad');return;}
  state.uploadsRunning=true;cancelQueue=false;
  const btn=$('upload-button');btn.disabled=true;let passed=0;
  try{
    for(let i=0;i<files.length;i++){
      if(cancelQueue)break;const f=files[i];
      try{const id=await uploadOne(f);if(!id)continue;passed++;toast(`Đã upload: ${f.name}`);if(attachAfter)await sendAttachment(id,true);}
      catch(e){toast(`Lỗi ${f.name}: ${e.message}`, 'bad',8500);}
    }
    await refresh(true);
    if(passed)toast(`Hoàn tất ${passed}/${files.length} tệp.`);
  }finally{state.uploadsRunning=false;btn.disabled=false;hideProgress();$('file-picker').value='';}
}
function openPicker(attach=false){state.targetAttachment=attach;$('file-picker').click();}

// UI wiring
$$('[data-page]').forEach(button=>button.addEventListener('click',()=>switchPage(button.dataset.page)));
$('refresh-files').addEventListener('click',()=>refresh());$('refresh-chat').addEventListener('click',()=>refresh());
$('file-search').addEventListener('input',renderFiles);$('upload-button').addEventListener('click',()=>openPicker(false));$('empty-upload').addEventListener('click',()=>openPicker(false));
$('file-picker').addEventListener('change',e=>uploadFiles(e.target.files,state.targetAttachment));
$('chat-attach').addEventListener('click',showAttachmentPicker);$('close-attach').addEventListener('click',hideAttachmentPicker);$('attach-cancel').addEventListener('click',hideAttachmentPicker);$('attach-search').addEventListener('input',renderAttachList);
$('attach-upload').addEventListener('click',()=>{hideAttachmentPicker();openPicker(true);});
$('attach-list').addEventListener('click',e=>{const btn=e.target.closest('[data-attach-id]');if(btn)sendAttachment(btn.dataset.attachId);});
$('file-rows').addEventListener('click',async e=>{const button=e.target.closest('[data-file-action]');if(!button)return;const file=state.files.find(f=>f.id===button.dataset.id);if(!file)return;if(button.dataset.fileAction==='preview')await previewFile(file);if(button.dataset.fileAction==='download')await downloadFile(file);if(button.dataset.fileAction==='attach')await sendAttachment(file.id);if(button.dataset.fileAction==='delete')await deleteFile(file);});
$('chat-messages').addEventListener('click',async e=>{const button=e.target.closest('[data-msg-action]');if(!button)return;const m=state.messages.find(x=>x.id===button.dataset.id);if(!m)return;switch(button.dataset.msgAction){case'copy':await copyText(m.kind==='attachment'?m.file_name||'':m.text||'');break;case'delete-message':await deleteMessage(m);break;case'delete-file':await deleteFile(state.files.find(f=>f.id===m.file_id));break;case'preview':await previewFile(state.files.find(f=>f.id===m.file_id));break;case'download':await downloadFile(state.files.find(f=>f.id===m.file_id));break;}});
$('send-message').addEventListener('click',sendMessage);$('message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}});$('message-input').addEventListener('input',e=>{e.target.style.height='46px';e.target.style.height=Math.min(115,Math.max(46,e.target.scrollHeight))+'px';});
$('change-token').addEventListener('click',()=>{clearWebSession();state.files=[];state.messages=[];renderFiles();renderChat();showAuth();});$('disconnect').addEventListener('click',()=>{clearWebSession();state.files=[];state.messages=[];renderFiles();renderChat();showAuth();toast('Đã đăng xuất.');});
$('auth-open-service').addEventListener('click',()=>{try{backendClient();serviceBridge.openWindow();}catch(e){$('auth-error').textContent=e.message;$('auth-error').hidden=false;}});
$('cancel-transfer').addEventListener('click',()=>{cancelQueue=true;transferController?.abort();});
$('auth-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('auth-submit');btn.disabled=true;$('auth-error').hidden=true;try{await connect($('auth-password').value);}catch(err){$('auth-error').textContent=err.message;$('auth-error').hidden=false;}finally{btn.disabled=false;}});
$('preview-close').addEventListener('click',closePreview);
$('preview-modal').addEventListener('click',e=>{if(e.target===$('preview-modal'))closePreview();});
$('preview-download').addEventListener('click',async()=>{const file=state.files.find(f=>f.id===state.previewFileId);if(file){closePreview();await downloadFile(file);}});
$('confirm-cancel').addEventListener('click',()=>resolveDelete(false));$('confirm-yes').addEventListener('click',()=>resolveDelete(true));
$('confirm-modal').addEventListener('click',e=>{if(e.target===$('confirm-modal'))resolveDelete(false);});$('attach-modal').addEventListener('click',e=>{if(e.target===$('attach-modal'))hideAttachmentPicker();});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('preview-modal').hidden)closePreview();else if(state.pendingConfirm)resolveDelete(false);else if(!$('attach-modal').hidden)hideAttachmentPicker();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();switchPage('files');$('file-search').focus();}});
let dropDepth=0;
window.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){dropDepth++;e.preventDefault();$('drop-overlay').hidden=false;}});
window.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files'))e.preventDefault();});
window.addEventListener('dragleave',e=>{e.preventDefault();dropDepth=Math.max(0,dropDepth-1);if(dropDepth===0)$('drop-overlay').hidden=true;});
window.addEventListener('drop',e=>{e.preventDefault();dropDepth=0;$('drop-overlay').hidden=true;if(e.dataTransfer?.files?.length)uploadFiles(e.dataTransfer.files,state.page==='chat');});
window.addEventListener('paste',e=>{const files=[...e.clipboardData?.items||[]].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();uploadFiles(files,state.page==='chat');}});
window.addEventListener('beforeunload',e=>{if(state.uploadsRunning||transferController){e.preventDefault();e.returnValue='';}});
// Manual refresh only; no periodic polling.
// Start the anonymous service connection while the user enters their password.
if(APPS_SCRIPT_URL){try{serviceBridge=new AppsScriptBridge(APPS_SCRIPT_URL);}catch{}}
updateConnection();renderFiles();renderChat();switchPage('files');restoreSession();
if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='127.0.0.1'||location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
if('serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',event=>{
 if(event.data?.type!=='minishare-media-request'||!event.ports[0])return;
 if(!drive||!state.token){event.ports[0].postMessage({type:'error',error:'Đăng nhập MiniShare để xem file.',status:401});return;}
 drive.serveMedia(event.ports[0],event.data);
});

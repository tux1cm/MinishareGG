const serviceOrigin=origin=>origin==='https://script.google.com'||origin==='https://script.googleusercontent.com'||/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/.test(origin);
export class AppsScriptBridge {
  constructor(url){
    if(!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(url))throw new Error('Chưa cấu hình địa chỉ backend MiniShare.');
    this.url=url;this.channel=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');this.pending=new Map();this.peer=null;this.peerOrigin='';
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
    this.listener=event=>{
      const data=event.data;if(!serviceOrigin(event.origin)||!data||data.channel!==this.channel)return;
      if(data.type==='minishare-ready'&&!this.peer){this.peer=event.source;this.peerOrigin=event.origin;this.resolveReady();return;}
      if(event.source!==this.peer||data.type!=='minishare-result')return;
      const task=this.pending.get(data.id);if(!task)return;this.pending.delete(data.id);task.finish(data.result);
    };
    window.addEventListener('message',this.listener);
    const params=new URLSearchParams({origin:location.origin,channel:this.channel});this.address=url+'?'+params;
    this.frame=document.createElement('iframe');this.frame.hidden=true;this.frame.title='Dịch vụ MiniShare';this.frame.src=this.address;
    this.frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');document.body.append(this.frame);
  }
  openWindow(){return window.open(this.address,'minishare_service','width=520,height=300');}
  async call(op,body={},session='',signal){
    signal?.throwIfAborted();
    let timer;try{await Promise.race([this.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Không kết nối được backend. Kiểm tra cấu hình hoặc bấm Mở kết nối dịch vụ.')),20000);})]);}finally{clearTimeout(timer);}
    signal?.throwIfAborted();const id=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',abort);this.pending.delete(id);};
      const abort=()=>{cleanup();reject(signal.reason||new DOMException('Đã hủy','AbortError'));};
      const timeout=setTimeout(()=>{cleanup();reject(new Error('Dịch vụ trả lời chậm. Thử lại hoặc Làm mới.'));},120000);
      this.pending.set(id,{finish:result=>{cleanup();if(result?.ok)resolve(result.result);else reject(new Error(result?.error||'Dịch vụ MiniShare trả lỗi.'));}});
      signal?.addEventListener('abort',abort,{once:true});
      try{this.peer.postMessage({type:'minishare-rpc',channel:this.channel,id,request:{op,body,session}},this.peerOrigin);}catch(error){cleanup();reject(error);}
    });
  }
  dispose(){window.removeEventListener('message',this.listener);this.frame.remove();for(const task of this.pending.values())task.finish({ok:false,error:'Phiên kết nối đã đóng.'});this.pending.clear();}
}

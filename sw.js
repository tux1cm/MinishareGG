// Public app shell only. Media is streamed through the signed MiniShare backend
// via the active page; no Google owner token enters the service worker.
const CACHE='minishare-google-web-v7';
const ASSETS=['./','./index.html','./app.js','./backend.js','./bridge.js','./session.js','./drive.js','./md5.js','./style.css','./assets/minishare.ico','./assets/minishare.png','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('minishare-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
const authorizedClients=new Set();
self.addEventListener('message',event=>{if(!event.source?.id)return;if(event.data?.type==='gg-auth'&&event.data.mode==='bridge'){authorizedClients.add(event.source.id);event.ports[0]?.postMessage({ok:true});}if(event.data?.type==='gg-auth-clear')authorizedClients.delete(event.source.id);});
async function mediaResponse(event,id){
 if(!authorizedClients.has(event.clientId))return new Response('MiniShare sign-in required',{status:401});
 const client=await self.clients.get(event.clientId);if(!client)return new Response('Open MiniShare to view media',{status:401});
 const channel=new MessageChannel();let headersResolve,headersReject,chunkResolve,chunkReject,closed=false;
 const headersReady=new Promise((resolve,reject)=>{headersResolve=resolve;headersReject=reject;});
 const initialTimer=setTimeout(()=>headersReject(new Error('Media service timed out')),120000);
 channel.port1.onmessage=event=>{const data=event.data;if(data?.type==='headers'){clearTimeout(initialTimer);headersResolve(data);}
  else if(data?.type==='error'){clearTimeout(initialTimer);const error=Object.assign(new Error(data.error||'Media service failed'),{status:data.status});headersReject(error);chunkReject?.(error);}
  else if(data?.type==='chunk'||data?.type==='end'){chunkResolve?.(data);}
 };
 client.postMessage({type:'minishare-media-request',driveId:id,range:event.request.headers.get('Range')},[channel.port2]);
 try{
  const initial=await headersReady;
  const stream=new ReadableStream({async pull(controller){
   if(closed)return;
   try{const data=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Media chunk timed out')),120000);chunkResolve=value=>{clearTimeout(timer);resolve(value);};chunkReject=error=>{clearTimeout(timer);reject(error);};channel.port1.postMessage({type:'pull'});});
    if(data.type==='end'){closed=true;controller.close();channel.port1.close();}else controller.enqueue(new Uint8Array(data.buffer));
   }catch(error){closed=true;controller.error(error);channel.port1.postMessage({type:'cancel'});channel.port1.close();}
  },cancel(){closed=true;channel.port1.postMessage({type:'cancel'});channel.port1.close();}});
  return new Response(stream,{status:initial.status,headers:initial.headers});
 }catch(error){channel.port1.close();return new Response(error.message,{status:error.status||502,headers:{'Cache-Control':'no-store'}});}
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const mediaPrefix=new URL('./__drive_media__/',self.registration.scope).pathname;
 if(url.pathname.startsWith(mediaPrefix)){const id=decodeURIComponent(url.pathname.slice(mediaPrefix.length));if(!/^[a-zA-Z0-9_-]+$/.test(id)){event.respondWith(new Response('Invalid file ID',{status:400}));return;}event.respondWith(mediaResponse(event,id));return;}
 if(url.pathname.endsWith('/config.js')){event.respondWith(fetch(request,{cache:'no-store'}));return;}
 event.respondWith(fetch(request).then(response=>{if(response.ok&&ASSETS.some(asset=>new URL(asset,self.registration.scope).pathname===url.pathname)){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)));}return response;}).catch(()=>caches.match(request)));
});

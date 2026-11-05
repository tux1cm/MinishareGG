// Static shell only; NEVER cache API calls or bearer tokens.
const CACHE='minishare-google-web-v2';
const ASSETS=['./','./index.html','./app.js','./drive.js','./md5.js','./style.css','./assets/minishare.ico','./assets/minishare.png','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('minishare-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
const accessTokens=new Map();
self.addEventListener('message',event=>{if(!event.source?.id)return;if(event.data?.type==='gg-auth'&&typeof event.data.token==='string'){accessTokens.set(event.source.id,event.data.token);event.ports[0]?.postMessage({ok:true});}if(event.data?.type==='gg-auth-clear')accessTokens.delete(event.source.id);});
self.addEventListener('fetch',event=>{
 const req=event.request;const url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin)return;
 if(url.pathname.endsWith('/OAuth.json')||url.pathname.endsWith('/Outh.json')||url.pathname.endsWith('/google-oauth.json'))return;
 const prefix=new URL('./__drive_media__/',self.registration.scope).pathname;
 if(url.pathname.startsWith(prefix)){
  event.respondWith((async()=>{const token=accessTokens.get(event.clientId);if(!token)return new Response('Google sign-in required',{status:401});const id=decodeURIComponent(url.pathname.slice(prefix.length));if(!/^[a-zA-Z0-9_-]+$/.test(id))return new Response('Invalid file ID',{status:400});const headers={Authorization:'Bearer '+token};if(req.headers.has('Range'))headers.Range=req.headers.get('Range');const r=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media',{headers,cache:'no-store',redirect:'error'});const responseHeaders=new Headers(r.headers);responseHeaders.set('Cache-Control','no-store');return new Response(r.body,{status:r.status,headers:responseHeaders});})());return;
 }

 event.respondWith(fetch(req).then(res=>{if(res.ok&&ASSETS.some(a=>new URL(a,self.registration.scope).pathname===url.pathname)){const c=res.clone();caches.open(CACHE).then(cache=>cache.put(req,c));}return res;}).catch(()=>caches.match(req)));
});

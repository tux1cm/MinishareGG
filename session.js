const KEY='minishare.password.session.v1';
const SNAPSHOT='minishare.password.snapshot.v1';
export function saveSession(session,remember,tab=sessionStorage,permanent=localStorage){
  clearSession(tab,permanent);(remember?permanent:tab).setItem(KEY,JSON.stringify(session));
}
export function loadSession(tab=sessionStorage,permanent=localStorage,now=Date.now()){
  for(const storage of [tab,permanent]){try{const session=JSON.parse(storage.getItem(KEY)||'null');if(session&&typeof session.session==='string'&&session.expiresAt>now)return session;storage.removeItem(KEY);storage.removeItem(SNAPSHOT);}catch{storage.removeItem(KEY);storage.removeItem(SNAPSHOT);}}
  return null;
}
export function clearSession(tab=sessionStorage,permanent=localStorage){for(const storage of [tab,permanent])try{storage.removeItem(KEY);storage.removeItem(SNAPSHOT);}catch{}}
export function saveSnapshot(data,session,url,tab=sessionStorage,permanent=localStorage,now=Date.now()){
  if(!session)return;try{const saved=JSON.parse(permanent.getItem(KEY)||'null'),storage=saved?.session===session.session?permanent:tab;const raw=JSON.stringify({session:session.session,url,saved_at:now,data});if(raw.length>2*1024*1024){storage.removeItem(SNAPSHOT);return;}storage.setItem(SNAPSHOT,raw);}catch{}
}
export function loadSnapshot(session,url,tab=sessionStorage,permanent=localStorage,now=Date.now()){
  if(!session||session.expiresAt<=now)return null;
  for(const storage of [tab,permanent])try{const item=JSON.parse(storage.getItem(SNAPSHOT)||'null');if(item&&item.session===session.session&&item.url===url&&now>=item.saved_at&&now-item.saved_at<86400000&&Array.isArray(item.data?.files)&&Array.isArray(item.data?.messages))return item.data;}catch{}
  return null;
}

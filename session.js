const KEY='minishare.password.session.v1';
export function saveSession(session,remember,tab=sessionStorage,permanent=localStorage){
  clearSession(tab,permanent);(remember?permanent:tab).setItem(KEY,JSON.stringify(session));
}
export function loadSession(tab=sessionStorage,permanent=localStorage,now=Date.now()){
  for(const storage of [tab,permanent]){try{const session=JSON.parse(storage.getItem(KEY)||'null');if(session&&typeof session.session==='string'&&session.expiresAt>now)return session;storage.removeItem(KEY);}catch{storage.removeItem(KEY);}}
  return null;
}
export function clearSession(tab=sessionStorage,permanent=localStorage){for(const storage of [tab,permanent])try{storage.removeItem(KEY);}catch{}}

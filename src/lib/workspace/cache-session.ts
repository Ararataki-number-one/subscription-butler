export const CACHE_SESSION_KEY = "ops-authenticated-cache-session";
type CacheSession = {actorId:string;mode:"owner"|"member";tokenHash?:string};
async function tokenHash(token:string) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}
/** Created only after the server has authenticated this browser session. */
export async function authenticatedCacheSession(actorId:string,memberToken:string):Promise<string> {
  const value:CacheSession=memberToken?{actorId,mode:"member",tokenHash:await tokenHash(memberToken)}:{actorId,mode:"owner"};
  return JSON.stringify(value);
}
/** A persistent actor ID is never authority to open a private offline snapshot. */
export async function cachedActorInSession(marker:string|null,currentToken:string):Promise<string|null> {
  if(!marker)return null;
  try {
    const value=JSON.parse(marker) as CacheSession;
    if(!value||typeof value.actorId!=="string"||!value.actorId)return null;
    if(value.mode==="owner")return currentToken?null:value.actorId;
    if(value.mode==="member"&&currentToken&&value.tokenHash===await tokenHash(currentToken))return value.actorId;
  }catch{/* An invalid or old marker never grants offline access. */}
  return null;
}

export type QueuedCommand = {id:string;type:string;payload:Record<string,unknown>};
type StoredCommand = {id:string;actorId:string;command:QueuedCommand;createdAt:string};
let opening: Promise<IDBDatabase> | undefined;
function database() {
  opening ??= new Promise<IDBDatabase>((resolve,reject) => {
    const request = indexedDB.open("subscription-butler-workspace",1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("snapshots",{keyPath:"actorId"});
      request.result.createObjectStore("outbox",{keyPath:"id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  return opening;
}
async function transaction<T>(store:string,mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,mode);
    const request = work(tx.objectStore(store));
    let result:T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? request.error);
  });
}
export async function cacheSnapshot(actorId:string,value:unknown) { await transaction("snapshots","readwrite",store=>store.put({actorId,value,at:new Date().toISOString()})); }
export async function cachedSnapshot(actorId:string) { return transaction<{actorId:string;value:unknown;at:string}|undefined>("snapshots","readonly",store=>store.get(actorId)); }
export async function enqueue(actorId:string,command:QueuedCommand) {
  await transaction("outbox","readwrite",store=>store.put({id:command.id,actorId,command,createdAt:new Date().toISOString()} satisfies StoredCommand));
}
export async function queued(actorId:string) {
  const rows = await transaction<StoredCommand[]>("outbox","readonly",store=>store.getAll());
  return rows.filter(row=>row.actorId === actorId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}
export async function dequeue(id:string) { await transaction("outbox","readwrite",store=>store.delete(id)); }
export async function clearOfflineData() {
  await transaction("snapshots","readwrite",store=>store.clear());
  await transaction("outbox","readwrite",store=>store.clear());
}
export async function clearSnapshotCache() { await transaction("snapshots","readwrite",store=>store.clear()); }

export interface Draft { key:string; user:string; instance:string; item:string; editor:string; version:number; generation:string; revision:number; updatedAt:string; values:Record<string,unknown>; }
let connection:Promise<IDBDatabase>|undefined;
function db(){return connection??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('personal-content-planner-drafts',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法保存浏览器草稿'));});}
async function run<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  const database=await db();return new Promise<T>((resolve,reject)=>{const t=database.transaction('drafts',mode);const r=operation(t.objectStore('drafts'));let value:T;r.onsuccess=()=>{value=r.result;};t.oncomplete=()=>resolve(value);t.onerror=()=>reject(new Error('浏览器草稿写入失败，请先复制未保存内容'));t.onabort=t.onerror;});
}
export const drafts={
  save:(d:Draft)=>run('readwrite',s=>s.put(d)),
  find:async(user:string,instance:string,item:string)=>(await run<Draft[]>('readonly',s=>s.getAll())).filter(d=>d.user===user&&d.instance===instance&&d.item===item).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),
  clearVersion:async(key:string,version:number)=>{const database=await db();return new Promise<void>((resolve,reject)=>{const t=database.transaction('drafts','readwrite');const s=t.objectStore('drafts');const r=s.get(key);r.onsuccess=()=>{if(r.result?.version===version)s.delete(key);};t.oncomplete=()=>resolve();t.onerror=()=>reject(new Error('草稿清理失败'));t.onabort=t.onerror;});},
  clearUser:async(user:string)=>{const database=await db();return new Promise<void>((resolve,reject)=>{const t=database.transaction('drafts','readwrite'),s=t.objectStore('drafts'),r=s.openCursor();r.onsuccess=()=>{const cursor=r.result;if(!cursor)return;if((cursor.value as Draft).user===user)cursor.delete();cursor.continue();};t.oncomplete=()=>resolve();t.onerror=()=>reject(new Error('本机草稿清理失败'));t.onabort=t.onerror;});}
};
export function shouldClearDraft(submitted:{key:string;version:number},current:{key:string;version:number}):boolean{return submitted.key===current.key&&submitted.version===current.version;}

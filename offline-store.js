/* Sorella Tea offline-first storage and sync layer. */
const ST_DB = 'sorella-tea-pos-offline-v1';
const ST_VERSION = 1;
const ST_STORES = ['state','orders','outbox','meta'];
function stOpen(){return new Promise((resolve,reject)=>{const r=indexedDB.open(ST_DB,ST_VERSION);r.onupgradeneeded=()=>{const d=r.result; if(!d.objectStoreNames.contains('state'))d.createObjectStore('state',{keyPath:'key'});if(!d.objectStoreNames.contains('orders'))d.createObjectStore('orders',{keyPath:'id'});if(!d.objectStoreNames.contains('outbox')){const s=d.createObjectStore('outbox',{keyPath:'operationId'});s.createIndex('status','status');}if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function stTx(store,mode,fn){const d=await stOpen();return new Promise((resolve,reject)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);let result;try{result=fn(s)}catch(e){reject(e);return}t.oncomplete=()=>resolve(result);t.onerror=()=>reject(t.error);});}
const localStore={
 async putState(state){return stTx('state','readwrite',s=>s.put({key:'snapshot',value:state}));},
 async getState(){return stTx('state','readonly',s=>new Promise((res,rej)=>{const r=s.get('snapshot');r.onsuccess=()=>res(r.result?.value||null);r.onerror=()=>rej(r.error);}));},
 async putOrder(order){return stTx('orders','readwrite',s=>s.put(order));},
 async queue(op){return stTx('outbox','readwrite',s=>s.put({...op,status:'pending',attempts:0,createdAt:op.createdAt||new Date().toISOString()}));},
 async pending(){return stTx('outbox','readonly',s=>new Promise((res,rej)=>{const r=s.getAll();r.onsuccess=()=>res(r.result.filter(x=>x.status!=='done'));r.onerror=()=>rej(r.error);}));},
 async remove(id){return stTx('outbox','readwrite',s=>s.delete(id));},
 async meta(key,value){return stTx('meta','readwrite',s=>s.put({key,value}));}
};
async function syncOfflineQueue(){if(!navigator.onLine)return {synced:0};const ops=await localStore.pending();let synced=0;for(const op of ops){try{const res=await fetch('/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(op)});if(!res.ok)throw new Error('sync '+res.status);await localStore.remove(op.operationId);synced++;}catch(e){break;}}return {synced,pending:(await localStore.pending()).length};}
window.localStore=localStore;window.syncOfflineQueue=syncOfflineQueue;

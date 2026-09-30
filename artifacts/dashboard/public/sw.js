const CACHE='universal-server-brand-v2';
const SHELL=['/','/manifest.json?v=2','/icons/universal.svg?v=2','/icons/universal-64.webp?v=2','/icons/universal-192.webp?v=2','/brand-overrides.css?v=2'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x.startsWith('universal-server-')&&x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||new URL(r.url).origin!==self.location.origin||new URL(r.url).pathname.startsWith('/api/'))return;e.respondWith(fetch(r).then(x=>{caches.open(CACHE).then(c=>c.put(r,x.clone())).catch(()=>{});return x}).catch(()=>caches.match(r).then(x=>x||caches.match('/'))))});

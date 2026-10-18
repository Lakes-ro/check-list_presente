const VERSION = 'giftlist-v3';
const STATIC_CACHE = `${VERSION}-static`;
const CDN_CACHE = `${VERSION}-cdn`;

const LOCAL_ASSETS = [
    './',
    'index.html',
    'style.css',
    'script.js',
    'supabase-config.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
];

const CDN_ASSETS = [
    'https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
];

const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const staticCache = await caches.open(STATIC_CACHE);
        await staticCache.addAll(LOCAL_ASSETS);

        // CDN é best-effort: uma falha não pode impedir a instalação
        const cdnCache = await caches.open(CDN_CACHE);
        await Promise.allSettled(CDN_ASSETS.map((url) => cdnCache.add(url)));

        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [STATIC_CACHE, CDN_CACHE];
        const names = await caches.keys();
        await Promise.all(names.filter((name) => !keep.includes(name)).map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(request);
    if (hit) return hit;

    const response = await fetch(request);
    if (response.status === 200) cache.put(request, response.clone());
    return response;
}

async function networkFirst(request) {
    const cache = await caches.open(STATIC_CACHE);
    const url = new URL(request.url);

    try {
        const response = await fetch(request);
        // Não guarda variações com query (ex.: ?list=TOKEN) para não acumular links compartilhados
        if (response.status === 200 && !url.search) cache.put(request, response.clone());
        return response;
    } catch (error) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === 'navigate') {
            const index = await cache.match('index.html');
            if (index) return index;
        }
        return Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request, CDN_CACHE));
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(networkFirst(request));
    }
    // Demais origens (ex.: *.supabase.co) vão direto para a rede, sem cache
});

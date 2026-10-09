const CACHE_NAME = 'cesium-ion-assets-v2';
const CACHEABLE_HOSTS = new Set([
  'assets.cesium.com',
  'assets.ion.cesium.com',
]);
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await caches.delete('cesium-tiles-cache-v1');
    await self.clients.claim();
  })());
});

function getCacheAgeMs(response) {
  const cacheControl = response.headers.get('Cache-Control') || '';
  if (/\b(?:no-store|no-cache)\b/i.test(cacheControl)) {
    return 0;
  }

  const age = Number(response.headers.get('Age') || 0) * 1000;
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (maxAge) {
    return Math.max(
      Math.min(Number(maxAge[1]) * 1000, MAX_CACHE_AGE_MS) - age,
      0
    );
  }

  const expires = Date.parse(response.headers.get('Expires') || '');
  const date = Date.parse(response.headers.get('Date') || '');
  if (Number.isFinite(expires) && Number.isFinite(date)) {
    return Math.max(
      Math.min(Math.max(expires - date, 0), MAX_CACHE_AGE_MS) - age,
      0
    );
  }

  return DEFAULT_CACHE_AGE_MS;
}

function reportCacheEvent(clientId, type) {
  if (!clientId) {
    return Promise.resolve();
  }

  return self.clients.get(clientId).then((client) => {
    if (client) {
      client.postMessage({ type });
    }
  }).catch((error) => {
    console.error('No se pudo informar el estado de la caché:', error);
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    request.headers.has('Range') ||
    !CACHEABLE_HOSTS.has(url.hostname)
  ) {
    return;
  }

  event.respondWith((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (error) {
      console.error('No se pudo abrir la caché de Cesium:', error);
      return fetch(request);
    }

    let cachedResponse;

    try {
      cachedResponse = await cache.match(request);
    } catch (error) {
      console.error('No se pudo leer la caché de Cesium:', error);
    }

    if (cachedResponse) {
      const cachedAt = Number(cachedResponse.headers.get('X-Local-Cached-At'));
      const maxAge = getCacheAgeMs(cachedResponse);
      if (Number.isFinite(cachedAt) && maxAge > 0 && Date.now() - cachedAt < maxAge) {
        reportCacheEvent(event.clientId, 'CESIUM_CACHE_HIT');
        return cachedResponse;
      }

      try {
        await cache.delete(request);
      } catch (error) {
        console.error('No se pudo eliminar un recurso vencido de la caché:', error);
      }
    }

    const networkResponse = await fetch(request);
    const maxAge = getCacheAgeMs(networkResponse);
    if (networkResponse.status === 200 && networkResponse.type !== 'opaque' && maxAge > 0) {
      try {
        const responseForCache = networkResponse.clone();
        const headers = new Headers(responseForCache.headers);
        headers.set('X-Local-Cached-At', String(Date.now()));
        const cacheableResponse = new Response(responseForCache.body, {
          status: responseForCache.status,
          statusText: responseForCache.statusText,
          headers,
        });
        await cache.put(request, cacheableResponse);
        reportCacheEvent(event.clientId, 'CESIUM_CACHE_STORED');
      } catch (error) {
        console.error('No se pudo guardar el recurso de Cesium en caché:', error);
      }
    }

    return networkResponse;
  })());
});

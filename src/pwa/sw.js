/**
 * Service worker of the GitHub Pages build (build/pages/): keeps the editor working offline
 * once it has been opened.
 *
 * build.mjs writes a hash of the page into CACHE, so every deploy changes this file's bytes:
 * the browser installs the new worker, which drops the previous cache. The open tab keeps
 * the old version until it reloads.
 *
 * Other projects may share the origin (a user's github.io), so only caches named vector-…
 * are this worker's to delete. And it answers from its own cache only: caches.match would
 * look in all of them, the next version's too while it installs.
 */
const CACHE = 'vector-__VERSION__';
const SHELL = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Pages lets the HTTP cache keep a file for ten minutes: without 'reload' the new
      // cache could be filled with the previous deploy's page.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('vector-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Any navigation inside the scope is the editor itself. Otherwise the page fetches
  // nothing (its CSP has connect-src 'none'): what comes here is the manifest and the
  // icons, all in the shell.
  const key = request.mode === 'navigate' ? './' : request;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(key, { ignoreSearch: true }))
      .then((cached) => cached ?? fetch(request)),
  );
});

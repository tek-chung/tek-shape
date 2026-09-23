/*
 * Caches the app shell and its immutable build assets so the reader opens
 * offline against the locally cached feed. Never caches Supabase auth or
 * reading requests: those are cross-origin and fall straight through.
 *
 * Bump CACHE whenever offline.html changes.
 */
const CACHE = "t-app-v3";
const SHELL = "/__shell";
const IMMUTABLE = "/_next/static/";

self.addEventListener("install", (event) => {
  // Take over straight away rather than waiting for every tab to close.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add("/offline.html"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => (key.startsWith("t-offline-") || key.startsWith("t-app-")) && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Network-first, keeping the last good shell so a cold offline launch still boots the app. */
async function navigate(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(SHELL, response.clone());
    }
    return response;
  } catch {
    // respondWith(undefined) surfaces as a network error, so always return a Response.
    const shell = await caches.match(SHELL);
    if (shell) return shell;
    const offline = await caches.match("/offline.html");
    return (
      offline ?? new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
    );
  }
}

/** Build assets are content-hashed, so a cache hit is always correct. */
async function asset(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") event.respondWith(navigate(request));
  else if (url.pathname.startsWith(IMMUTABLE)) event.respondWith(asset(request));
});

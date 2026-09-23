---
"blockdb": patch
---

The runtime recovers from a stale cached manifest after a redeploy (#32). On a host that caches every file (GitHub Pages sends `max-age=600`), a browser could reuse the previous deploy's `manifest.json`, which names files the new deploy removed, and queries failed with `DEPLOY_INTEGRITY` although the deploy was fine. The manifest is now fetched with `cache: "no-cache"`. When a file it names returns 404, the client refetches it with `cache: "reload"`; if the fresh manifest no longer names that file, it replaces the cached one and the query reruns once. `DEPLOY_INTEGRITY` is thrown only when the fresh manifest still names the missing file, and its message now mentions a stale cache as a possible cause. Concurrent queries share one refetch. A custom `fetch` should forward its `init` argument so the cache mode reaches the browser.

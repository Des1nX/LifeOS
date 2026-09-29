# LifeOS

A personal system for tasks, habits, goals, a day planner, finance, training, nutrition and health. All data stays on
the device (IndexedDB), and a backup can be exported and imported as JSON.

## Files

| File | Purpose |
|---|---|
| `LifeOS.html` | The whole app in a single file. It also works on its own (opened locally), just without offline caching. |
| `index.html` | Entry point that redirects to `LifeOS.html` (for hosts that serve `/`). |
| `manifest.json` | Web App Manifest (name, colours, icons, `start_url: ./LifeOS.html`), used for installing to the home screen. |
| `sw.js` | Service worker: offline app shell with a versioned cache `lifeos-vN`. |
| `icons/` | App icons (192, 512, maskable 512, apple-touch 180). |
| `qa/` | Test tooling only (Playwright, fingerprint, reference screenshots); not deployed. |

## Deployment

Deploy the whole repository root to a static host over **https** (GitHub Pages, Netlify, …), so that `LifeOS.html`,
`index.html`, `manifest.json`, `sw.js` and `icons/` sit next to each other. The app then:

- can be installed ("Add to Home Screen" / "Install app"),
- opens and reloads offline (the service worker serves the cached `LifeOS.html`),
- gets updates automatically: pages are *network-first*, so online you always load the latest `LifeOS.html`.

The service worker caches only the app's own files. It never reads, changes or deletes IndexedDB, so it doesn't touch
the data, export or import.

### Releasing a new version

1. Change `LifeOS.html` (and possibly the other files).
2. In `sw.js`, bump `CACHE_VERSION` (`lifeos-v1` → `lifeos-v2` …).
3. Deploy. The new worker installs its own cache, takes over immediately and deletes older `lifeos-*` caches.
   An open app shows the notice "Je připravená nová verze LifeOS — projeví se po obnovení stránky"
   ("A new LifeOS version is ready — it applies after a reload"). The data in IndexedDB stays untouched.

### Verifying installation (Chrome desktop / Android)

The automated tests check the manifest, the icons, installability (Chrome DevTools: `Page.getInstallabilityErrors`
without errors), the service worker, offline mode and updates. What can be verified by hand on a real device:

1. **Chrome desktop:** open the deployed `…/LifeOS.html` → DevTools → *Application* → *Manifest*: no errors,
   icons 192/512 + maskable; *Service workers*: `sw.js` *activated and running*; *Cache storage*: `lifeos-v1`.
   The address bar shows the *Install* icon → install → the app opens in its own window.
2. **Offline:** DevTools → *Network* → *Offline* → reload: the app loads with its data. Or close the installed app,
   turn off the internet and open it again.
3. **Android (Chrome):** menu → *Install app* / *Add to Home screen* → launch from the home screen (no address bar),
   turn on airplane mode, open the app again: the data is there.
4. **Update:** deploy with a higher `CACHE_VERSION` → on the next online launch the app shows the notice about the new
   version; after a reload DevTools *Cache storage* holds only the new `lifeos-vN`; the data stays.

Installation on iOS/Safari hasn't been tested on a real device (the `apple-touch-icon` and meta tags are ready).

## Tests

See `qa/README.md` (`cd qa && npm install && npm test`).

# LifeOS QA guards (dev-only)

Regression guards for `../LifeOS.html`. The app itself stays a single dependency-free file;
everything here is test tooling only (acorn, playwright, pngjs, pixelmatch as devDependencies).

```sh
cd qa && npm install          # uses the preinstalled Chromium
npm test                      # fingerprint check + smoke suite
npm run fingerprint           # business-logic fingerprint vs baseline/fingerprint.json
npm run smoke                 # Playwright suite (29 tests)
npm run screens:compare       # pixel-compare fresh screenshots with baseline/screens-8b
npm run screens               # re-record baseline/screens-8b (only after an intended UI change)
node shot.mjs <dir> <width> <theme> view[:action],...   # dev helper for quick screenshots
```

| Guard | What it proves |
|---|---|
| `fingerprint.mjs` | Every non-UI top-level declaration (model, migrations, XP/RPG, IndexedDB, boot, event wiring) is identical at AST level to the pre-8B file (`cd37304`). For `render*`/`open*`/`ui*` presentation functions, every data effect (logic calls, record mutations/assignments incl. the locals they read) must be identical; effects may only *move* between UI functions if the global multiset is unchanged. Navigation-only state (view, filters, render()) and DOM properties are reported for review. |
| `smoke.mjs` | 19 baseline tests (boot, onboarding, 21 views, navigation, quick add, task CRUD, XP idempotency, level rewards, IndexedDB round-trip, pagehide flush, IDs, export/import, reset, theme, golden values) + 10 Phase 8B tests (zero overflow at 320–1440 px, no duplicate ids, grouped toasts, task completion feedback, accessible names, touch targets, reduced motion/animations setting, keyboard/dialog, WCAG contrast, cs/en greeting). Any console error fails a test. |
| `baseline/golden.json` | Deterministic outputs of rule tables and calculators on `fixture.mjs` with a frozen clock (2026-09-23). |
| `baseline/screens/` | Pre-8B screenshots (mobile dark/light 390 px, desktop dark 1280 px). |
| `baseline/screens-8b/` | Phase 8B screenshots: 375/390/430/1280/1440 px × dark/light, 24 screens each. |

Only `fingerprint:update`, `--write-golden` and `screens` rewrite baselines — never run them to
make a failing change pass.

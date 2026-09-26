# LifeOS QA guards (dev-only)

Regression guards for `../LifeOS.html`. The app itself stays a single dependency-free file;
everything here is test tooling only.

```sh
cd qa && npm install          # acorn + playwright (uses the preinstalled Chromium)
npm test                      # fingerprint check + smoke suite
npm run fingerprint           # business-logic fingerprint vs baseline/fingerprint.json
npm run smoke                 # Playwright suite (19 tests)
node smoke.mjs --screens out/screens   # screenshots of all 21 views x 3 variants
```

| Guard | What it proves |
|---|---|
| `fingerprint.mjs` | Every non-UI top-level declaration (model, migrations, XP/RPG, IndexedDB, boot, event wiring) is byte-for-byte identical at AST level. For `render*`/`open*Form`/DOM builders, every state-touching expression (logic calls, mutations, assignments, incl. the locals they read) is identical; markup may change freely. |
| `smoke.mjs` | Boot, onboarding (full + skip), 21 views, navigation, health/stats tabs, 12 quick-add entries, task CRUD, XP idempotency, level rewards, IndexedDB round-trip, pagehide flush, ID stability, export/import, reset, theme, responsive overflow, zero console errors. |
| `baseline/golden.json` | Deterministic outputs of rule tables and calculators (XP curve, achievements, skills, quests, defaultState, legacy migration, statistics, health, streaks, finance...) on `fixture.mjs` with a frozen clock (2026-09-23). |
| `baseline/screens/` | Pre-Phase-8B screenshots: mobile dark/light (390 px), desktop dark (1280 px). |

Only `npm run fingerprint:update` / `node smoke.mjs --write-golden` rewrite baselines — never run
them to make a failing redesign pass.

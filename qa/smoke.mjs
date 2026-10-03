// Playwright smoke/regression suite for LifeOS.html.
//
//   node smoke.mjs                 run every test
//   node smoke.mjs --write-golden  (re)record baseline/golden.json from the current build
//   node smoke.mjs --screens [dir] save screenshots of every view (default: out/screens)
//
// Tests talk to the app the way a person does (clicks on the stable hooks: nav [data-v], #fabBtn,
// #settingsBtn, #themeBtn, form field ids, .check/.delbtn/.editBtn) and read state through the
// app's own globals (S, render, view...) plus a raw IndexedDB reader that does not use app code.
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixtureState, TODAY, NOW } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.LIFEOS_HTML ? path.resolve(process.env.LIFEOS_HTML) : path.resolve(here, '..', 'LifeOS.html');
const GOLDEN = path.join(here, 'baseline', 'golden.json');
const args = process.argv.slice(2);

export const VIEWS = ['home', 'tasks', 'habits', 'goals', 'character', 'more', 'finance', 'fitness', 'nutrition', 'notes',
  'journal', 'subscriptions', 'calendar', 'quests', 'statistics', 'search', 'health', 'goalDetail', 'habitDetail', 'settings', 'planner', 'week', 'intel']; // Reality QA: no Car screen (its data stays)
const NAV = ['home', 'calendar', 'tasks', 'habits', 'more']; // Reality QA: the phone bottom bar; the desktop sidebar adds NAV_ALL
const NAV_ALL = ['home', 'calendar', 'tasks', 'habits', 'goals', 'character', 'finance', 'fitness', 'nutrition', 'health', 'notes', 'journal', 'quests', 'statistics', 'more'];
const MORE_ITEMS = ['calendar', 'goals', 'week', 'intel', 'quests', 'notes', 'journal', 'search', 'fitness', 'nutrition', 'health', 'finance',
  'statistics', 'character', 'settings']; // Reality QA: Planner = Calendar, Subscriptions inside Finance, no Car
const QUICK_ADD = ['task', 'habit', 'goal', 'event', 'planner', 'expense', 'income', 'workout', 'meal', 'water', 'note', 'journal']; // Reality QA: no Car fuel entry

// ---------- harness ----------
// Serves the app like a static host: the PWA files next to LifeOS.html (sw.js, manifest.json, icons/, index.html) by
// path, anything else -> LifeOS.html. `serverOverrides` lets a test publish a new version of a file (e.g. sw.js).
const ROOT = path.dirname(APP);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json', '.png': 'image/png' };
export const serverOverrides = {};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (serverOverrides[p] != null) { res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/plain', 'cache-control': 'no-store' }); res.end(serverOverrides[p]); return; }
  const file = p && !p.includes('..') && path.join(ROOT, p);
  if (file && p !== 'LifeOS.html' && existsSync(file) && /^(sw\.js|manifest\.json|index\.html|icons\/[\w-]+\.png)$/.test(p)) {
    res.writeHead(200, { 'content-type': MIME[path.extname(p)], 'cache-control': 'no-store' }); res.end(readFileSync(file)); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(APP));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();

async function openApp({ state = null, viewport = { width: 390, height: 844 }, errors } = {}) {
  const context = await browser.newContext({ viewport, timezoneId: 'Europe/Prague', locale: 'cs-CZ', acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.clock.setFixedTime(NOW); // Date is frozen at the fixture's TODAY; timers still run for real
  await page.goto(URL_);
  await booted(page);
  if (state) {
    // Also swap the in-memory S: the app's pagehide/beforeunload flushSave() writes S on reload.
    await page.evaluate(async st => { S = st; await rawIdbPut(st); }, state);
    await reload(page);
  }
  return { context, page };
}
async function booted(page) {
  await page.waitForFunction(() => typeof S !== 'undefined' && S !== null && document.getElementById('app'));
  await injectRawIdb(page);
}
async function reload(page) { await page.reload(); await booted(page); }
// Raw IndexedDB access that does not go through the app's idbGet/idbSet.
async function injectRawIdb(page) {
  await page.evaluate(() => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('lifeos', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    window.rawIdbGet = async () => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => { db.close(); res(q.result); }; q.onerror = () => rej(q.error); }); };
    window.rawIdbPut = async v => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv', 'readwrite').objectStore('kv').put(v, 'state'); q.onsuccess = () => { db.close(); res(true); }; q.onerror = () => rej(q.error); }); };
  });
}
const settle = page => page.waitForTimeout(450); // > scheduleSave()'s 250 ms debounce
// Persist through the app's own flushSave() and wait until IndexedDB holds exactly S (for state
// changed by code paths that don't schedule a save themselves, e.g. boot settling, grantXp()).
const persist = async page => { await page.evaluate(() => flushSave()); await page.waitForFunction(async () => JSON.stringify(await rawIdbGet()) === JSON.stringify(S)); };
// Polish pass 3: restoring a backup asks first (it replaces all data) -- choose the file, then confirm the sheet.
const importFile = async (page, file) => { await page.setInputFiles('#st_impFile', file); await page.waitForSelector('.cf-sheet'); await page.click('#cf_ok'); };
const stateOf = page => page.evaluate(() => JSON.parse(JSON.stringify(S)));
const idbState = page => page.evaluate(async () => JSON.parse(JSON.stringify(await rawIdbGet()))); // JSON view, like stateOf (xpLog.key may be undefined)
const go = (page, v) => page.evaluate(v => { view = v; render(); }, v);
function allIds(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach(x => allIds(x, out));
  else if (obj && typeof obj === 'object') { if (typeof obj.id === 'string') out.push(obj.id); Object.values(obj).forEach(x => allIds(x, out)); }
  return out;
}
async function appText(page) { return page.evaluate(() => document.getElementById('app').innerText); }

// Smart Daily Command Center: Home shows the Command Center by default; the classic widget Home stays one switch away
// (Settings -> Chytrý Home). Tests of the classic widgets run with that switch off.
const classicState = () => { const s = fixtureState(); s.settings = { ...s.settings, widgets: { ...(s.settings.widgets || {}), smart: false } }; return s; };
const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, opts });
const notes = []; // non-failing observations about the baseline

// ---------- tests ----------
test('boot: fresh install shows onboarding, schemaVersion 8, no errors', async ({ page }) => {
  const s = await stateOf(page);
  assert.equal(s.schemaVersion, 8);
  assert.equal(s.settings.onboarded, false);
  assert.ok(await page.locator('.sheet').isVisible(), 'onboarding sheet visible');
  assert.match(await page.locator('.sheet h2').innerText(), /LifeOS/);
});

test('shell: stable DOM hooks the JS relies on are present', async ({ page }) => {
  for (const id of ['app', 'toasts', 'fabBtn', 'settingsBtn', 'themeBtn', 'manifestLink']) assert.equal(await page.locator('#' + id).count(), 1, '#' + id);
  assert.deepEqual(await page.$$eval('nav.bottom button', bs => bs.map(b => b.dataset.v)), NAV_ALL);
});

test('onboarding: full 6-step wizard via UI persists answers', async ({ page }) => {
  await page.fill('#ob_name', 'QA Hero'); await page.click('.sheet .btn:not(.ghost)');
  await page.locator('#ob_avatars button').nth(3).click(); await page.click('.sheet .btn:not(.ghost)');
  await page.fill('#ob_goal', 'QA goal'); await page.fill('#ob_goal_date', '2026-12-31'); await page.click('.sheet .btn:not(.ghost)');
  for (let i = 0; i < 3; i++) await page.locator('#ob_habits button').nth(i).click();
  await page.click('.sheet .btn:not(.ghost)');
  await page.fill('#ob_cal', '2500'); await page.click('.sheet .btn:not(.ghost)');
  await page.click('#ob_seed');
  await settle(page);
  const s = await stateOf(page);
  assert.equal(s.settings.onboarded, true);
  assert.equal(s.profile.name, 'QA Hero');
  assert.equal(s.profile.avatar, 'svg:rogue', 'polish pass: the 4th portrait (SVG avatars replace the emoji)');
  assert.ok(s.goals.some(g => g.title === 'QA goal' && g.targetDate === '2026-12-31'));
  assert.deepEqual(s.habits.map(h => h.name).slice(0, 3), ['Drink water', 'Exercise', 'Read']);
  assert.equal(s.habits.length, 5, '3 picked + 2 sample habits');
  assert.equal(s.tasks.length, 2, 'sample tasks');
  assert.equal(s.nutritionTargets.calories, 2500);
  await reload(page);
  assert.equal(await page.locator('.sheet').count(), 0, 'wizard not shown again');
  assert.equal((await stateOf(page)).profile.name, 'QA Hero');
});

test('onboarding: Skip finishes immediately and never re-traps', async ({ page }) => {
  await page.fill('#ob_name', 'Skipper'); await page.click('.sheet .btn:not(.ghost)');
  await page.click('.sheet [data-ob="skip"]'); // 8B: localized label, stable data-ob hook
  await settle(page);
  const s = await stateOf(page);
  assert.equal(s.settings.onboarded, true);
  assert.equal(s.tasks.length, 0);
  await reload(page);
  assert.equal(await page.locator('.sheet').count(), 0);
});

test('views: all 24 screens render with data and without errors (Phase 10 adds Planner, Weekly Planner adds the week, Intelligence its screen)', async ({ page }, ctx) => {
  await page.evaluate(() => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; });
  for (const v of VIEWS) {
    await go(page, v);
    const txt = await appText(page);
    assert.ok(txt.trim().length > 0 && await page.locator('#app > *').count() > 0, `view ${v} rendered content`);
    for (const bad of ['undefined', 'NaN', '[object Object]']) if (txt.includes(bad)) ctx.note(`view "${v}" shows "${bad}"`);
  }
}, { state: fixtureState() });

test('navigation: bottom nav, More grid, settings button and detail links', async ({ page }) => {
  for (const v of NAV) { await page.click(`nav.bottom button[data-v="${v}"]`); assert.equal(await page.evaluate(() => view), v); assert.equal(await page.locator(`nav.bottom button[data-v="${v}"].on`).count(), 1); }
  for (const [i, v] of MORE_ITEMS.entries()) {
    await page.click('nav.bottom button[data-v="more"]');
    await page.click(`#moreGrid [data-v="${v}"]`); // 8B: grouped sections, stable data-v hooks
    assert.equal(await page.evaluate(() => view), v, `More item ${i}`);
  }
  await page.click('#settingsBtn'); assert.equal(await page.evaluate(() => view), 'settings');
  await page.click('nav.bottom button[data-v="habits"]');
  await page.locator('#hlist .hTap', { hasText: 'Read' }).first().click();
  assert.equal(await page.evaluate(() => [view, currentHabitId].join()), 'habitDetail,h_read');
  await go(page, 'goals');
  await page.locator('.gTap').first().click();
  assert.equal(await page.evaluate(() => view), 'goalDetail');
}, { state: fixtureState() });

test('sub-navigation: health tabs, statistics periods', async ({ page }) => {
  await go(page, 'health');
  const n = await page.locator('#hTabs > *').count();
  assert.equal(n, 3, 'Reality QA: sleep, weight, active kcal (steps / heart rate are not entered by hand any more)');
  for (let i = 0; i < n; i++) { await page.locator('#hTabs > *').nth(i).click(); assert.ok((await appText(page)).length > 20); }
  await go(page, 'statistics');
  const p = await page.locator('#spTabs button').count();
  assert.ok(p >= 3, 'statistics periods');
  for (let i = 0; i < p; i++) { await page.locator('#spTabs button').nth(i).click(); assert.equal(await page.locator('#spTabs button').nth(i).getAttribute('class'), 'on'); }
}, { state: fixtureState() });

test('quick add: all 12 entries open their form (water logs directly; Phase 10 adds Planner block; Weekly Planner adds an entry that opens the week; Reality QA: no Car fuel)', async ({ page }) => {
  for (const t of QUICK_ADD) {
    await page.click('#fabBtn');
    assert.equal(await page.locator('.sheet .qopt[data-t]').count(), 13, '12 forms + "Naplánovat týden"');
    const water = (await stateOf(page)).waterLog.length;
    await page.click(`.sheet .qopt[data-t="${t}"]`);
    if (t === 'water') assert.equal((await stateOf(page)).waterLog.length, water + 1);
    else assert.equal(await page.locator('.sheet').count(), 1, `form for ${t}`);
    await page.evaluate(() => closeSheets());
  }
}, { state: fixtureState() });

test('tasks: add, edit (same id), complete, delete through the UI', async ({ page }) => {
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="task"]');
  await page.fill('#f_title', 'QA task'); await page.selectOption('#f_pri', 'High');
  // Polish pass: no manual XP field -- the reward follows the priority and is shown as a hint.
  assert.equal(await page.locator('#f_xp').count(), 0, 'no manual XP field');
  assert.match(await page.innerText('#f_xpHint'), /\+30 XP/, 'High priority = 30 XP');
  await page.click('#f_save');
  let s = await stateOf(page);
  const t = s.tasks.find(x => x.title === 'QA task');
  assert.ok(t && t.priority === 'High' && t.xpReward === undefined && t.dueDate === TODAY);
  assert.equal(await page.evaluate(() => view), 'tasks');
  const row = page.locator('.item', { hasText: 'QA task' });
  await row.locator('.editBtn').click(); await page.fill('#f_title', 'QA task edited'); await page.click('#f_save');
  s = await stateOf(page);
  assert.ok(s.tasks.some(x => x.id === t.id && x.title === 'QA task edited'), 'edit keeps id');
  const xp0 = s.totalXp;
  await page.locator('.item', { hasText: 'QA task edited' }).locator('.check').click();
  s = await stateOf(page);
  assert.ok(s.tasks.find(x => x.id === t.id).done);
  assert.ok(s.xpLog.some(x => x.key === `task:${t.id}:${TODAY}` && x.amount === 30));
  assert.ok(s.totalXp >= xp0 + 30);
  await page.click('#tf [data-f="Completed"]'); // done tasks leave the Today tab
  await page.locator('.item', { hasText: 'QA task edited' }).locator('.delbtn').click(); await page.click('#cf_ok');
  assert.ok(!(await stateOf(page)).tasks.some(x => x.id === t.id), 'deleted');
}, { state: fixtureState() });

test('XP: task/habit completion is exact and idempotent; xpLog sums match totalXp', async ({ page }) => {
  const before = await stateOf(page);
  await page.click('nav.bottom button[data-v="tasks"]');
  const check = tab => page.locator(`#tf [data-f="${tab}"]`).click().then(() => page.locator('.item', { hasText: 'Buy groceries' }).locator('.check').click());
  await check('Today');
  let s = await stateOf(page);
  const key = `task:t_med:${TODAY}`;
  assert.equal(s.xpLog.filter(x => x.key === key).length, 1);
  assert.equal(s.xpLog.find(x => x.key === key).amount, 20, 'Medium task = 20 XP (polish pass: XP by priority)');
  const newXp = s.xpLog.slice(before.xpLog.length).reduce((a, x) => a + x.amount, 0);
  assert.equal(s.totalXp - before.totalXp, newXp, 'totalXp delta equals new xpLog entries');
  const afterFirst = s.totalXp;
  await check('Completed'); await check('Today'); // uncheck + recheck
  s = await stateOf(page);
  assert.equal(s.totalXp, afterFirst, 're-checking the same task today grants nothing');
  assert.equal(s.xpLog.filter(x => x.key === key).length, 1);
  // Habit already done today whose XP key is in the ledger: toggle off/on must not grant again.
  await page.click('nav.bottom button[data-v="habits"]');
  const hc = () => page.locator('#hlist > .card', { hasText: 'Read' }).first().locator('.check').click();
  await hc(); assert.ok(!(await stateOf(page)).habits.find(h => h.id === 'h_read').completions.includes(TODAY));
  await hc(); s = await stateOf(page);
  assert.ok(s.habits.find(h => h.id === 'h_read').completions.includes(TODAY));
  assert.equal(s.totalXp, afterFirst, 'habit re-check is idempotent');
  // Counter habit (target 8, 3 done today): 5 more taps complete it and grant once.
  for (let i = 0; i < 6; i++) await page.locator('#hlist > .card', { hasText: 'Drink water' }).first().locator('.incBtn').click();
  s = await stateOf(page);
  assert.equal(s.habits.find(h => h.id === 'h_water').completions.filter(d => d === TODAY).length, 8, 'counter capped at target');
  assert.equal(s.xpLog.filter(x => x.key === `habit:h_water:${TODAY}`).length, 1);
}, { state: fixtureState() });

test('level system: crossing a level is logged once and survives reload (polish pass: no Skill/Attribute points any more)', async ({ page }) => {
  const b = await stateOf(page);
  const { level, into, need } = await page.evaluate(() => levelFromXp(S.totalXp));
  await page.evaluate(n => grantXp(n, 'QA level test'), need - into); // exactly reach the next level
  const s = await stateOf(page);
  assert.equal(await page.evaluate(() => levelFromXp(S.totalXp).level), level + 1);
  assert.equal(s.rpg.highestLevelRewarded, level + 1);
  const d = (x, y) => Object.fromEntries(Object.keys(x).map(k => [k, x[k] - y[k]]));
  // Polish pass: the Skill Tree and manual Attribute Points were removed -- a level-up pays no points,
  // the counters already stored stay exactly as they were (never deleted).
  assert.deepEqual(d(s.rpg.skillPoints, b.rpg.skillPoints), { available: 0, earned: 0, spent: 0 }, 'no Skill Points');
  assert.deepEqual(d(s.rpg.attributePoints, b.rpg.attributePoints), { available: 0, earned: 0, spent: 0 }, 'no Attribute Points');
  assert.equal(s.rpg.activityLog.find(a => a.type === 'levelup').title, 'Level ' + (level + 1));
  assert.equal(s.rpg.activityLog.filter(a => a.type === 'levelup' && a.title === 'Level ' + (level + 1)).length, 1, 'logged once');
  await persist(page); await reload(page);
  const r = await stateOf(page);
  assert.deepEqual(r.rpg, s.rpg, 'reload does not re-pay rewards');
  assert.equal(r.totalXp, s.totalXp);
}, { state: fixtureState() });

test('persistence: IndexedDB round-trip is lossless (fixture -> boot -> save -> reload)', async ({ page }) => {
  const booted1 = await stateOf(page);
  const fx = fixtureState();
  // Boot legitimately settles derived state (achievements/quests it now qualifies for grant XP),
  // so those grow; every stored record must come through migrate() untouched.
  const DERIVED = ['totalXp', 'xpLog', 'attrs', 'achievementsUnlocked', 'achievementUnlockedAt', 'rpg', 'quests', 'questResetDate', 'notificationLog', 'settings'];
  for (const k of Object.keys(fx)) if (!DERIVED.includes(k)) assert.deepEqual(booted1[k], fx[k], `migrate keeps ${k} unchanged`);
  assert.deepEqual(booted1.xpLog.slice(0, fx.xpLog.length), fx.xpLog, 'xpLog history kept as prefix');
  for (const [k, v] of Object.entries(fx.settings)) if (k !== 'widgets' && k !== 'widgetOrder') assert.deepEqual(booted1.settings[k], v, `settings.${k}`);
  // boot() settles derived state in memory but does not itself persist it (that happens on the
  // next save or on pagehide). Persist it through the app's own flushSave() and wait for the
  // write, so the reload below really boots the settled state instead of racing the unload.
  await persist(page);
  await reload(page);
  assert.deepEqual(await stateOf(page), booted1, 'second boot of a settled state changes nothing');
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="task"]');
  await page.fill('#f_title', 'Persist me'); await page.click('#f_save');
  await settle(page);
  const mem = await stateOf(page), disk = await idbState(page);
  assert.deepEqual(disk, mem, 'IndexedDB equals in-memory state after debounced save');
  await reload(page);
  assert.deepEqual(await stateOf(page), mem, 'reload restores identical state');
}, { state: fixtureState() });

test('persistence: pagehide flushes pending edits immediately', async ({ page }) => {
  await page.evaluate(() => { S.profile.name = 'Flushed'; scheduleSave(); dispatchEvent(new Event('pagehide')); });
  await page.waitForTimeout(100); // well under the 250 ms debounce
  assert.equal((await idbState(page)).profile.name, 'Flushed');
}, { state: fixtureState() });

test('IDs: unique, preserved through boot, reload, edit and export/import', async ({ page }) => {
  const fxIds = allIds(fixtureState());
  let ids = allIds(await stateOf(page));
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const id of fxIds) assert.ok(ids.includes(id), `id ${id} kept`);
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="task"]'); await page.fill('#f_title', 'New'); await page.click('#f_save');
  const s = await stateOf(page);
  const nid = s.tasks.find(t => t.title === 'New').id;
  assert.match(nid, /^[0-9a-z]{10,}$/, 'uid() format');
  ids = allIds(s); assert.equal(new Set(ids).size, ids.length);
  await settle(page); await reload(page);
  assert.deepEqual(allIds(await stateOf(page)), ids);
}, { state: fixtureState() });

test('export/import: backup JSON equals state; import restores it exactly', async ({ page }) => {
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  assert.equal(dl.suggestedFilename(), `lifeos-backup-${TODAY}.json`);
  const file = await dl.path();
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  const s = await stateOf(page);
  assert.deepEqual(exported, s, 'export equals state');
  await page.evaluate(() => { S.tasks = []; S.habits = []; S.totalXp = 0; render(); });
  await importFile(page, file);
  await page.waitForFunction(() => S.tasks.length > 0);
  assert.deepEqual(await stateOf(page), s, 'import restores identical state');
  await settle(page); await reload(page);
  assert.deepEqual(await stateOf(page), s, 'imported state persisted');
  await page.click('#settingsBtn');
  await page.setInputFiles('#st_impFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.cf-sheet').count(), 0, 'an invalid file never reaches the restore question');
  assert.deepEqual(await stateOf(page), s, 'invalid import is rejected without changes');
}, { state: fixtureState() });

test('reset: double confirm wipes data and restarts onboarding', async ({ page }) => {
  page.on('dialog', d => d.accept());
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.ok(await page.locator('.sheet h2').isVisible());
  const s = await stateOf(page);
  assert.equal(s.tasks.length, 0); assert.equal(s.totalXp, 0); assert.equal(s.schemaVersion, 8);
}, { state: fixtureState() });

test('theme: toggle switches data-theme and persists', async ({ page }) => {
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.click('#themeBtn');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await settle(page); await reload(page);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
}, { state: fixtureState() });

test('responsive: layouts render without horizontal overflow (320, 390, 768, 1280)', async ({ page }, ctx) => {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const v of VIEWS) {
      await page.evaluate(v => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; view = v; render(); }, v);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) ctx.note(`horizontal overflow ${over}px on "${v}" at ${width}px`);
    }
  }
}, { state: fixtureState() });

// ---------- Phase 8B UI/UX guards ----------
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440];
const allViews = async (page, fn) => { for (const v of VIEWS) { await page.evaluate(v => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; uiPlannerDay = todayStr(); view = v; render(); }, v); await fn(v); } };

test('8B layout: zero horizontal overflow on every screen at 320-1440 px', async ({ page }) => {
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await allViews(page, async v => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) bad.push(`${v}@${width}: ${over}px`);
    });
  }
  assert.deepEqual(bad, [], 'overflow');
}, { state: fixtureState() });

test('8B DOM: no duplicate element ids on any screen or open sheet', async ({ page }) => {
  const dupes = [];
  const check = async where => { const d = await page.evaluate(() => { const seen = {}; document.querySelectorAll('[id]').forEach(n => { seen[n.id] = (seen[n.id] || 0) + 1; }); return Object.entries(seen).filter(([, c]) => c > 1).map(([k, c]) => `${k}x${c}`); }); if (d.length) dupes.push(`${where}: ${d.join(', ')}`); };
  await allViews(page, v => check(v));
  for (const t of QUICK_ADD.filter(t => t !== 'water')) { await page.click('#fabBtn'); await page.click(`.sheet .qopt[data-t="${t}"]`); await check('form:' + t); await page.evaluate(() => closeSheets()); }
  assert.deepEqual(dupes, []);
}, { state: fixtureState() });

test('8B feedback: a boot that unlocks many achievements/quests shows at most 3 grouped toasts', async ({ page }) => {
  // fixtureState() qualifies for many unlocks on first boot (see persistence test).
  await page.waitForTimeout(150);
  const t = await page.$$eval('#toasts .toast', ns => ns.map(n => n.textContent));
  assert.ok(t.length >= 1 && t.length <= 3, `visible toasts: ${t.length} ${JSON.stringify(t)}`);
  assert.ok(t.some(x => /úspěch|achievement|🏆/i.test(x)), 'achievements summarised');
}, { state: fixtureState() });

test('8B feedback: a completed task stays visible in its done state before leaving the Today list', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  const row = page.locator('#tlist .item', { hasText: 'Buy groceries' });
  await row.locator('.check').click();
  assert.equal(await row.count(), 1, 'still on screen right after completion');
  assert.ok(await row.evaluate(n => n.classList.contains('is-completing')), 'completed state shown');
  assert.ok((await stateOf(page)).tasks.find(t => t.id === 't_med').done, 'state updated immediately');
  await page.waitForTimeout(900);
  assert.equal(await page.locator('#tlist .item', { hasText: 'Buy groceries' }).count(), 0, 'then filtered out as before');
}, { state: fixtureState() });

test('8B a11y: every visible button has an accessible name (icon-only buttons use aria-label)', async ({ page }) => {
  const bad = [];
  const scan = async where => {
    const b = await page.evaluate(() => [...document.querySelectorAll('button')].filter(n => n.offsetParent !== null || getComputedStyle(n).position === 'fixed').map(n => {
      const aria = (n.getAttribute('aria-label') || '').trim();
      const txt = [...n.childNodes].filter(c => c.nodeType === 3 || (c.nodeType === 1 && c.tagName !== 'svg' && !c.classList.contains('hide'))).map(c => c.textContent).join('').trim();
      const meaningful = /[\p{L}\p{N}]/u.test(txt);
      return aria || meaningful ? null : (n.id || n.className || n.outerHTML.slice(0, 60)) + ` "${txt}"`;
    }).filter(Boolean));
    if (b.length) bad.push(`${where}: ${[...new Set(b)].join(' | ')}`);
  };
  await allViews(page, v => scan(v));
  await page.click('#fabBtn'); await scan('quick-add'); await page.evaluate(() => closeSheets());
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('8B a11y: touch targets (buttons >= 36 px, inputs >= 44 px) on a 390 px phone', async ({ page }, ctx) => {
  const small = [];
  await allViews(page, async v => {
    const s = await page.evaluate(() => [...document.querySelectorAll('#app button, #app input:not([type=checkbox]):not(.hide), #app select, nav.bottom button, .topbar button, #fabBtn')].filter(n => n.offsetParent !== null || getComputedStyle(n).position === 'fixed').map(n => {
      const r = n.getBoundingClientRect(); const min = n.tagName === 'BUTTON' ? 36 : 44;
      // .check / .switch / button.chip draw a small visual but have an enlarged ::before hit area
      const hit = n.matches('.check,.switch') ? 18 : n.matches('button.chip') ? 14 : 0;
      return (Math.min(r.width, r.height) + hit < min && r.width > 0) ? `${n.className || n.tagName}(${Math.round(r.width)}x${Math.round(r.height)})` : null;
    }).filter(Boolean));
    s.forEach(x => small.push(`${v}: ${x}`));
  });
  const chips = small.filter(x => /chip/.test(x)), rest = small.filter(x => !/chip/.test(x));
  if (chips.length) ctx.note(`${chips.length} inline chip links are smaller than 36 px (secondary shortcuts inside rows)`);
  assert.deepEqual([...new Set(rest)], []);
}, { state: fixtureState() });

test('8B motion: Settings -> Animations off and prefers-reduced-motion disable decorative motion', async ({ page }) => {
  await page.evaluate(() => { S.settings.animations = false; render(); });
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('no-anim')));
  await page.evaluate(() => { S.settings.animations = true; view = 'tasks'; render(); });
  assert.ok(!(await page.evaluate(() => document.documentElement.classList.contains('no-anim'))));
  // contexts in this suite run with reducedMotion:'reduce' -> animation durations collapse
  const d = await page.evaluate(() => { view = 'home'; render(); return getComputedStyle(document.querySelector('#app > *')).animationDuration; });
  assert.ok(parseFloat(d) < 0.01, 'reduced motion duration ' + d);
}, { state: fixtureState() });

test('8B keyboard: Escape closes Quick Add, focus moves into the sheet, onboarding is not dismissable', async ({ page }) => {
  await page.focus('#fabBtn'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('.sheet').count(), 1);
  // openSheet() moves focus on a 30 ms timer; wait for it (a fixed 80 ms sleep was timing-sensitive under load)
  await page.waitForFunction(() => !!document.activeElement.closest('.sheet'), null, { timeout: 2000 }).catch(() => {});
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('.sheet')), 'focus inside sheet');
  assert.equal(await page.getAttribute('.sheet', 'role'), 'dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sheet').count(), 0, 'closed by Escape');
  await page.evaluate(() => showOnboarding(1)); await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sheet').count(), 1, 'onboarding stays open');
}, { state: fixtureState() });

test('8B contrast: key text/background pairs meet WCAG AA in dark and light', async ({ page }) => {
  const fails = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { S.settings.theme = t; applyTheme(); view = 'home'; render(); }, theme);
    const r = await page.evaluate(() => {
      const rgb = c => { const m = c.match(/[\d.]+/g).map(Number); return m.slice(0, 3); };
      const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const probe = (css, bgVar) => { const d = document.createElement('div'); d.style.cssText = css; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); const b = document.createElement('div'); b.style.background = `var(${bgVar})`; document.body.appendChild(b); const bg = getComputedStyle(b).backgroundColor; b.remove(); return [c, bg]; };
      const pairs = { 'text/bg': ['color:var(--text)', '--bg'], 'text/card': ['color:var(--text)', '--card'], 'sub/card': ['color:var(--sub)', '--card'], 'sub/card2': ['color:var(--sub)', '--card2'],
        'muted/card': ['color:var(--color-text-muted)', '--card'], 'accent/card': ['color:var(--accent)', '--card'], 'white/accent-fill': ['color:#fff', '--accent-strong'], 'gold/card': ['color:var(--gold)', '--card'], 'accent/card2': ['color:var(--accent)', '--card2'], 'success/card': ['color:var(--accent2)', '--card'], 'danger/card': ['color:var(--danger)', '--card'], 'warn/card': ['color:var(--warn)', '--card'] };
      return Object.fromEntries(Object.entries(pairs).map(([k, [c, b]]) => { const [fc, bc] = probe(c, b); return [k, Math.round(ratio(fc, bc) * 100) / 100]; }));
    });
    for (const [k, v] of Object.entries(r)) if (v < 4.5) fails.push(`${theme} ${k} ${v}`);
  }
  assert.deepEqual(fails, []);
}, { state: fixtureState() });

test('8B i18n: Czech mode greets in Czech, English mode in English (no "Good odpoledne")', async ({ page }) => {
  const greet = () => page.evaluate(() => { view = 'home'; render(); return document.querySelector('.hud-greet').textContent; });
  const cs = await greet();
  assert.match(cs, /^Dobr[éý] (ráno|odpoledne|večer),$/);
  await page.evaluate(() => { S.settings.language = 'en'; });
  assert.match(await greet(), /^Good (morning|afternoon|evening),$/);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
}, { state: fixtureState() });

test('8B CRUD: every create form saves exactly one record through the redesigned UI', async ({ page }) => {
  const forms = [
    ['openFinanceForm("expense")', 'expenses'], ['openFinanceForm("income")', 'income'], ['openHabitForm()', 'habits'], ['openGoalForm()', 'goals'],
    ['openWorkoutForm()', 'workouts'], ['openMealForm()', 'meals'], ['openNoteForm()', 'notes'], ['openJournalForm()', 'journal'], ['openEventForm()', 'events'],
    ['openSleepForm()', 'sleepLog'], ['openWeightForm()', 'weightLog'], ['openActiveCaloriesForm()', 'activeCaloriesLog'], // Reality QA: no steps / heart-rate / car forms (data kept, RQ19/RQ20/RQ26)
    ['openSubForm()', 'subscriptions'], ['openBudgetForm()', 'budgets'], ['openMilestoneForm("g_fit")', 'milestones'], ['openForm("task")', 'tasks'],
  ];
  const failures = [];
  for (const [open, coll] of forms) {
    await page.evaluate(() => closeSheets());
    const before = await page.evaluate(c => S[c].length, coll);
    await page.evaluate(o => eval(o), open);
    await page.waitForTimeout(40);
    // Fill every empty field the way a person would (text -> "QA x", numbers -> 5, times -> 07:00).
    const trace = [];
    for (const h of await page.$$('.sheet input:not([type=checkbox]):not([type=file]):not(.hide), .sheet textarea')) {
      const [type, val, id] = await h.evaluate(n => [n.type, n.value, n.id || n.className]);
      if (val) { trace.push(`${id}:had=${val}`); continue; }
      if (type === 'number') await h.fill('5'); else if (type === 'time') await h.fill('07:00'); else if (type === 'date') { trace.push(`${id}:date`); continue; } else await h.fill('QA ' + coll);
      trace.push(`${id}:filled->${await h.evaluate(n => n.value + '|' + (document.activeElement && document.activeElement.id) + '|' + n.isConnected)}`);
    }
    if (coll === 'budgets') await page.selectOption('#b_cat', 'fcat_transport'); // one budget per category is an app rule; Food already has one (11B: categories are records)
    const save = page.locator('.sheet [id$="_save"]').first();
    if (!(await save.count())) { failures.push(`${open}: no save button`); continue; }
    await save.click();
    await page.waitForTimeout(40);
    const after = await page.evaluate(c => S[c].length, coll);
    if (after !== before + 1) {
      const diag = await page.evaluate(() => ({ sheet: !!document.querySelector('.sheet'), toasts: [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent), queued: uiToastQueue.map(t => t.msg).concat(uiToastBurst),
        fields: [...document.querySelectorAll('.sheet input, .sheet select, .sheet textarea')].map(n => `${n.id || n.className}=${n.value}`), active: document.activeElement && (document.activeElement.id || document.activeElement.className) }));
      failures.push(`${open}: ${coll} ${before} -> ${after} ${JSON.stringify(diag)} TRACE ${trace.join(' ')}`);
    }
  }
  assert.deepEqual(failures, []);
}, { state: fixtureState() });

// ---------- Phase 9: Daily Score ----------
// Runs dailyScore(D) against a crafted state (defaultState() + patch, through migrate()).
const dsRun = (page, patch, D = TODAY) => page.evaluate(({ patch, D }) => { S = migrate(Object.assign(defaultState(), JSON.parse(JSON.stringify(patch)))); return dailyScore(D); }, { patch, D });
const T = (id, o) => ({ id, title: id, category: 'Work', priority: 'Medium', dueDate: TODAY, done: false, createdAt: NOW, ...o });
const H = (id, o) => ({ id, name: id, category: 'Health', type: 'good', frequency: 'daily', target: 1, weekdays: [], active: true, startDate: '2026-01-01', completions: [], brokenDates: [], createdAt: NOW, ...o });
const dayOff = n => { const x = new Date(`${TODAY}T00:00`); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

test('9 Daily Score: empty day has no score (never 0/100) and every area is N/A', async ({ page }) => {
  const r = await dsRun(page, {});
  assert.equal(r.score, null); assert.equal(r.label, null); assert.equal(r.relevant, 0); assert.equal(r.algo, 3); // polish pass: algo 2 adds training days; Reality QA: algo 3 adds sleep quality %
  for (const k of ['tasks', 'habits', 'nutrition', 'sleep', 'fitness', 'goals']) assert.equal(r.areas[k].score, null, k);
});

test('9 Daily Score: tasks only - priority weights, overdue done today counts, open overdue is info only', async ({ page }) => {
  const r = await dsRun(page, {
    tasks: [T('u', { priority: 'Urgent', done: true }), T('m', { priority: 'Medium' }), T('l', { priority: 'Low', done: true }),
      T('tomorrow', { dueDate: dayOff(1) }), T('undated', { dueDate: '' , done: true }),
      T('lateOpen', { dueDate: dayOff(-3) }), T('lateDoneToday', { dueDate: dayOff(-2), done: true, priority: 'High' }), T('lateDoneEarlier', { dueDate: dayOff(-5), done: true })],
    xpLog: [{ id: 'x1', amount: 30, reason: 'Task', ts: NOW, key: `task:lateDoneToday:${TODAY}` }, { id: 'x2', amount: 10, reason: 'Task', ts: NOW, key: `task:lateDoneEarlier:${dayOff(-5)}` }],
  });
  const t = r.areas.tasks;
  // weights: Urgent 2 (done) + Medium 1 + Low 1 (done) + High 1.5 (late, done today) = 5.5, done 4.5 -> 82
  assert.equal(t.total, 4); assert.equal(t.done, 3); assert.equal(t.lateDone, 1); assert.equal(t.openOverdue, 1);
  assert.equal(t.score, 82); assert.equal(r.score, 82); assert.equal(r.relevant, 1);
});

test('9 Daily Score: completed vs incomplete - unchecking a task lowers the score again', async ({ page }) => {
  const done = await dsRun(page, { tasks: [T('a', { done: true }), T('b', { done: true })], xpLog: [{ id: 'x', amount: 10, reason: 'Task', ts: NOW, key: `task:a:${TODAY}` }] });
  assert.equal(done.score, 100);
  const unchecked = await dsRun(page, { tasks: [T('a', { done: false }), T('b', { done: true })], xpLog: [{ id: 'x', amount: 10, reason: 'Task', ts: NOW, key: `task:a:${TODAY}` }] });
  assert.equal(unchecked.score, 50, 'xpLog key alone does not count as done');
  const none = await dsRun(page, { tasks: [T('a'), T('b')] });
  assert.equal(none.score, 0, 'planned but nothing done is a real 0');
});

test('9 Daily Score: habits only - scheduled, counters, bad habits, weekly necessity, inactive/future ignored', async ({ page }) => {
  const r = await dsRun(page, { habits: [
    H('dailyDone', { completions: [TODAY] }), H('dailyOpen'),
    H('notToday', { frequency: 'weekdays', weekdays: [1] }),                 // Monday only; TODAY is Wednesday
    H('counter', { target: 8, completions: [TODAY, TODAY, TODAY] }),          // 3/8
    H('badClean', { type: 'bad', completions: [TODAY] }), H('badBroken', { type: 'bad', brokenDates: [TODAY] }), H('badPending', { type: 'bad' }),
    H('inactive', { active: false }), H('future', { startDate: dayOff(2) }),
    H('weeklySlack', { frequency: 'weekly', target: 3 }),                     // Wed: 3 needed, 5 days left -> not needed
    H('weeklyNeeded', { frequency: 'weekly', target: 5 }),                    // Wed: 5 needed, 5 days left -> needed today, not done
  ] });
  const h = r.areas.habits;
  // (1 + 0 + 0.375 + 1 + 0 + 0) / 6 = 39.6 -> 40
  assert.equal(h.total, 6); assert.equal(h.done, 2); assert.equal(h.pending, 1); assert.equal(h.score, 40); assert.equal(r.score, 40);
  const onlyInactive = await dsRun(page, { habits: [H('i', { active: false }), H('w', { frequency: 'weekly', target: 1 })] });
  assert.equal(onlyInactive.areas.habits.score, null, 'nothing required today -> N/A');
});

// Stravování: one area (weight 15) made of calories 60 / protein 25 / water 15.
const NT = { calories: 2000, protein: 100, carbs: 250, fat: 70, water: 2000 };
const meal = (kcal, p, date = TODAY, q = 1) => ({ id: 'm' + kcal + date, name: 'm', type: 'Lunch', date, calories: String(kcal), protein: String(p), carbs: '0', fat: '0', servings: q });
const water = (ml, date = TODAY) => ({ id: 'w' + ml + date, date, amount: ml });

test('9 Stravování: one main area (no separate water area) combining calories + protein + water', async ({ page }) => {
  const r = await dsRun(page, { nutritionTargets: NT, meals: [meal(1800, 80)], waterLog: [water(1000)] });
  assert.deepEqual(Object.keys(r.areas).sort(), ['fitness', 'goals', 'habits', 'nutrition', 'sleep', 'tasks'], 'no water area');
  const n = r.areas.nutrition;
  // live today: calories 90, protein 80, water 50 -> (60*90 + 25*80 + 15*50)/100 = 81.5 -> 82
  assert.deepEqual(n.parts, { calories: 90, protein: 80, water: 50 });
  assert.equal(n.score, 82); assert.equal(n.mode, 'live');
  await page.evaluate(() => { view = 'home'; render(); });
  const rows = await page.$$eval('[data-ds="card"] .ds-row', ns => ns.map(n => n.dataset.area));
  assert.deepEqual(rows, ['tasks', 'habits', 'nutrition', 'sleep', 'fitness']);
  assert.match(await page.locator('[data-ds="card"] .ds-row[data-area="nutrition"] span').innerText(), /Stravování/);
});

test('9 Stravování: water not logged = N/A (not 0) and its weight re-normalizes to calories/protein', async ({ page }) => {
  const n = (await dsRun(page, { nutritionTargets: NT, meals: [meal(1800, 80)] })).areas.nutrition;
  assert.equal(n.parts.water, null, 'untracked water is N/A');
  // (60*90 + 25*80) / 85 = 87.06 -> 87 (would be 74 if water counted as 0)
  assert.equal(n.score, 87);
});

test('9 Stravování: water alone can score the area; nothing logged = N/A', async ({ page }) => {
  const n = (await dsRun(page, { nutritionTargets: NT, waterLog: [water(1500)] })).areas.nutrition;
  assert.deepEqual(n.parts, { calories: null, protein: null, water: 75 });
  assert.equal(n.score, 75, 'no penalty for missing calories/protein');
  const none = await dsRun(page, { nutritionTargets: NT });
  assert.equal(none.areas.nutrition.score, null); assert.equal(none.areas.nutrition.reason, 'no_data');
  assert.equal((await dsRun(page, { nutritionTargets: { calories: 0, protein: 0, water: 0 }, meals: [meal(500, 10)] })).areas.nutrition.reason, 'no_targets');
});

test('9 Stravování: today calories are live progress (capped, no bonus); a finished day uses the 90-110 % band', async ({ page }) => {
  const live = async kcal => (await dsRun(page, { nutritionTargets: NT, meals: [meal(kcal, 100)] })).areas.nutrition.parts.calories;
  assert.equal(await live(600), 30, 'midday 30 % is progress, not under-eating');
  assert.equal(await live(2000), 100);
  assert.equal(await live(3000), 100, 'over target: capped, no bonus');
  const D = dayOff(-1);
  const closed = async kcal => (await dsRun(page, { nutritionTargets: NT, meals: [meal(kcal, 100, D)] }, D)).areas.nutrition;
  assert.equal((await closed(600)).parts.calories, 0, '30 % on a finished day scores 0');
  assert.equal((await closed(600)).mode, 'closed');
  assert.equal((await closed(1800)).parts.calories, 100, '90 % inside the band');
  assert.equal((await closed(2200)).parts.calories, 100, '110 % inside the band');
  assert.equal((await closed(1400)).parts.calories, 50, '70 % -> halfway between 50 % and 90 %');
  assert.equal((await closed(3000)).parts.calories, 0, '150 % scores 0');
  const q = await dsRun(page, { nutritionTargets: NT, meals: [meal(1000, 50, D, 2)] }, D);
  assert.equal(q.areas.nutrition.score, 100, 'servings multiply like nutriTotals()');
});

test('9 Stravování: its total weight stays 15 whatever the internal re-normalization', async ({ page }) => {
  const tasks0 = [T('a')]; // tasks area = 0 (weight 30)
  const waterOnly = await dsRun(page, { tasks: tasks0, nutritionTargets: NT, waterLog: [water(2000)] });
  const full = await dsRun(page, { tasks: tasks0, nutritionTargets: NT, meals: [meal(2000, 100)], waterLog: [water(2000)] });
  const mealsOnly = await dsRun(page, { tasks: tasks0, nutritionTargets: NT, meals: [meal(2000, 100)] });
  for (const r of [waterOnly, full, mealsOnly]) { assert.equal(r.areas.nutrition.score, 100); assert.equal(r.score, 33, '(30*0 + 15*100)/45'); }
});

test('9 Stravování: a snapshot of a finished day uses the closed-day band', async ({ page }) => {
  // fixture today: 1150/2400 kcal (48 %) -> live 48, closed 0
  const live = await page.evaluate(d => dailyScore(d).areas.nutrition.parts.calories, TODAY);
  assert.equal(live, 48);
  await page.clock.setFixedTime(NOW + 86400000); await page.evaluate(() => render());
  const snap = (await stateOf(page)).dailyScores[TODAY];
  assert.equal(snap.areas.nutrition.mode, 'closed'); assert.equal(snap.areas.nutrition.parts.calories, 0); assert.equal(snap.algo, 3); // Reality QA: algo 3
}, { state: fixtureState() });

test('9 UI: Stravování detail lists calories/protein/water and "nesledováno" for untracked water', async ({ page }) => {
  await page.evaluate(() => { S.waterLog = []; view = 'home'; render(); });
  await page.click('[data-ds="card"]');
  const t = await page.locator('[data-ds="detail"] .ds-area[data-area="nutrition"]').innerText();
  assert.match(t, /Stravování/); assert.match(t, /Kalorie\s*48 %/); assert.match(t, /Protein\s*47 %/); assert.match(t, /Voda\s*nesledováno/);
  assert.match(t, /průběžný postup/);
}, { state: fixtureState() });

test('9 Daily Score: sleep band 7-9 h, longer duplicate wins, no entry = N/A', async ({ page }) => {
  const sl = (id, bed, wake, date = TODAY) => ({ id, date, bedtime: bed, wake, quality: '3', notes: '' });
  const s = async list => (await dsRun(page, { sleepLog: list })).areas.sleep;
  assert.equal((await s([sl('a', '23:00', '07:00')])).score, 100);
  assert.equal((await s([sl('a', '01:30', '07:00')])).score, 50);   // 5.5 h
  assert.equal((await s([sl('a', '22:00', '08:00')])).score, 85);   // 10 h
  assert.equal((await s([sl('a', '20:00', '08:00')])).score, 70);   // 12 h -> floor 70
  assert.equal((await s([sl('a', '03:00', '06:00')])).score, 0);    // 3 h
  const dup = await s([sl('short', '02:00', '07:00'), sl('long', '23:00', '07:00')]);
  assert.equal(dup.hours, 8); assert.equal(dup.score, 100, 'the longer entry is used, not the sum');
  assert.equal((await s([sl('y', '23:00', '07:00', dayOff(-1))])).score, null, 'yesterday\'s entry does not count today');
});

test('9 Daily Score: fitness only when planned; unplanned workout is a bonus outside the score', async ({ page }) => {
  const ev = { id: 'e1', title: 'Gym', date: TODAY, category: 'Fitness', recurring: 'none' };
  const wk = { id: 'w1', name: 'Push', date: TODAY, duration: '40', exercises: [] };
  const bonus = await dsRun(page, { workouts: [wk] });
  assert.equal(bonus.areas.fitness.score, null); assert.equal(bonus.areas.fitness.bonus, true); assert.equal(bonus.score, null, 'bonus never creates a score');
  assert.equal((await dsRun(page, { events: [ev], workouts: [wk] })).areas.fitness.score, 100);
  assert.equal((await dsRun(page, { events: [ev] })).areas.fitness.score, 0);
  assert.equal((await dsRun(page, { events: [{ ...ev, category: 'Work' }] })).areas.fitness.score, null, 'non-fitness events do not plan a workout');
});

test('9 Daily Score: combination re-normalizes weights over relevant areas only; goals are info only', async ({ page }) => {
  const r = await dsRun(page, {
    tasks: [T('a', { done: true }), T('b', { done: true }), T('c', { done: true }), T('d')],              // 75
    sleepLog: [{ id: 's', date: TODAY, bedtime: '23:00', wake: '07:00' }],                                 // 100
    workouts: [{ id: 'w', name: 'x', date: TODAY, exercises: [] }],                                        // unplanned -> N/A
    goals: [{ id: 'g', title: 'G', status: 'Active', createdAt: NOW }],
    milestones: [{ id: 'm', goalId: 'g', title: 'Step', completed: true, completedAt: NOW, xpReward: 25 }],
  });
  // (30*75 + 15*100) / 45 = 83.3 -> 83
  assert.equal(r.score, 83); assert.equal(r.relevant, 2); assert.equal(r.label, 'good');
  assert.equal(r.areas.goals.score, null); assert.deepEqual(r.areas.goals.milestones, ['Step']);
  const all100 = await dsRun(page, { tasks: [T('a', { done: true })], habits: [H('h', { completions: [TODAY] })] });
  assert.equal(all100.score, 100); assert.equal(all100.label, 'excellent');
});

test('9 Daily Score: labels follow the approved thresholds', async ({ page }) => {
  const labels = await page.evaluate(() => [100, 90, 89, 75, 74, 50, 49, 25, 24, 0, null].map(dailyScoreLabelKey));
  assert.deepEqual(labels, ['excellent', 'excellent', 'good', 'good', 'solid', 'solid', 'weaker', 'weaker', 'tough', 'tough', null]);
});

test('9 Daily Score: computing scores never changes any data (XP, level, attributes, points, achievements, quests)', async ({ page }) => {
  const before = await stateOf(page);
  await page.evaluate(() => { for (let i = -20; i <= 1; i++) { const d = new Date(); d.setDate(d.getDate() + i); dailyScore(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); } });
  assert.deepEqual(await stateOf(page), before);
}, { state: fixtureState() });

const DAY = 86400000;
const tick = async (page, ms) => { await page.clock.setFixedTime(NOW + ms); await page.evaluate(() => render()); };

test('9 history: first run starts the history today - no estimated past snapshots', async ({ page }) => {
  const s = await stateOf(page);
  assert.equal(s.dailyScoresSince, TODAY);
  assert.deepEqual(s.dailyScores, {}, 'past days with data are NOT back-filled');
  assert.equal(s.schemaVersion, 8);
}, { state: fixtureState() });

test('9 history: a finished day is snapshotted once, immutable, and XP/RPG data never change', async ({ page }) => {
  const live = await page.evaluate(d => dailyScore(d), TODAY);
  assert.ok(live.score != null);
  const rpgBefore = await page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.achievementsUnlocked, S.quests]));
  await tick(page, DAY);                                                     // next day: TODAY is finished
  const s1 = await stateOf(page);
  const snap = s1.dailyScores[TODAY];
  assert.ok(snap, 'snapshot written');
  // The snapshot is the closed-day result (live and finished day may differ by design: calories
  // are live progress during the day, the 90-110 % band once the day is over).
  const closed = await page.evaluate(d => dailyScore(d), TODAY);
  assert.equal(snap.score, closed.score); assert.equal(snap.algo, 3); assert.equal(snap.label, closed.label);
  for (const k of ['tasks', 'habits', 'sleep', 'fitness']) assert.deepEqual(snap.areas[k], live.areas[k], `${k} unchanged between live and closed`);
  assert.deepEqual(Object.keys(snap.areas).sort(), ['fitness', 'habits', 'nutrition', 'sleep', 'tasks']);
  // Only the new day's quest/achievement checks may run on boot of a new day - render() alone must not
  // touch RPG data. (Quests are only checked on boot/Quests screen, not here.)
  assert.equal(await page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.achievementsUnlocked, S.quests])), rpgBefore, 'Daily Score snapshots never change XP/RPG data');
  // Changing that day's data afterwards does not rewrite the stored snapshot.
  await page.evaluate(d => { S.tasks.filter(t => t.dueDate === d).forEach(t => { t.done = true; }); render(); }, TODAY);
  assert.deepEqual((await stateOf(page)).dailyScores[TODAY], snap, 'snapshot is immutable');
  await tick(page, 2 * DAY);
  const s2 = await stateOf(page);
  assert.deepEqual(s2.dailyScores[TODAY], snap);
  assert.ok(Object.values(s2.dailyScores).every(x => x.score != null), 'days without a score are never stored as 0');
}, { state: fixtureState() });

test('9 history: snapshots persist through save + reload and survive export/import', async ({ page }) => {
  await tick(page, DAY);
  await persist(page);
  const snap = (await stateOf(page)).dailyScores;
  assert.ok(Object.keys(snap).length >= 1);
  await reload(page);
  assert.deepEqual((await stateOf(page)).dailyScores, snap, 'reload keeps snapshots');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  const exported = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(exported.dailyScores, snap); assert.equal(exported.dailyScoresSince, TODAY);
  await page.evaluate(() => { S.dailyScores = {}; S.dailyScoresSince = null; });
  await importFile(page, file);
  await page.waitForFunction(() => Object.keys(S.dailyScores).length > 0);
  assert.deepEqual((await stateOf(page)).dailyScores, snap, 'import restores snapshots');
}, { state: fixtureState() });

test('9 history: a pre-Phase-9 backup (no dailyScores keys) imports cleanly; reset clears history', async ({ page }) => {
  const old = fixtureState(); delete old.dailyScores; delete old.dailyScoresSince;
  await page.click('#settingsBtn');
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.profile.name === 'Tester');
  let s = await stateOf(page);
  assert.deepEqual(s.dailyScores, {}); assert.equal(s.dailyScoresSince, TODAY); assert.equal(s.schemaVersion, 8);
  page.on('dialog', d => d.accept());
  await tick(page, DAY); await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  s = await stateOf(page);
  assert.deepEqual(s.dailyScores, {}); assert.equal(s.dailyScoresSince, null);
}, { state: fixtureState() });

test('9 UI: Home shows the live Daily Score with all five areas (polish pass: daily state, no "N/A", areas without data never scored as 0)', async ({ page }) => {
  const r = await page.evaluate(() => dailyScore(todayStr()));
  const card = page.locator('[data-ds="card"]');
  assert.equal(await card.count(), 1);
  assert.equal((await card.locator('.ring > span').innerText()).trim(), String(r.score));
  const want = { tasks: `${r.areas.tasks.score} %`, habits: `${r.areas.habits.done}/${r.areas.habits.total}`,
    nutrition: `${r.areas.nutrition.calories.toLocaleString('cs-CZ')} kcal`, sleep: `${String(r.areas.sleep.hours).replace('.', ',')} h`, fitness: '1/1' };
  for (const k of ['tasks', 'habits', 'nutrition', 'sleep', 'fitness']) {
    const txt = (await card.locator(`.ds-row[data-area="${k}"] b`).innerText()).trim().replace(/\u00a0/g, ' ');
    assert.equal(txt, want[k].replace(/\u00a0/g, ' '), k);
  }
  assert.doesNotMatch(await card.innerText(), /N\/A/);
  assert.equal(r.areas.fitness.score, null, 'fixture has an unplanned workout today -> not scored (bonus 1/1 shown)');
  assert.equal(await card.locator('.ds-row[data-area="fitness"].is-na').count(), 1, 'unscored area stays neutral');
}, { state: fixtureState() });

test('9 UI: an empty day shows "nothing to score yet", not 0/100', async ({ page }) => {
  await page.click('.sheet [data-ob="skip"]');
  const card = page.locator('[data-ds="card"]');
  assert.equal((await card.locator('.ring > span').innerText()).trim(), '—');
  assert.match(await card.innerText(), /Dnes zatím není co hodnotit/);
  assert.doesNotMatch(await card.innerText(), /0 \/ 100|\b0 %/);
  await card.click();
  assert.match(await page.locator('[data-ds="detail"]').innerText(), /Dnes zatím není co hodnotit/);
});

test('9 UI: detail explains every area (including N/A) and marks today as live', async ({ page }) => {
  await page.click('[data-ds="card"]');
  const d = page.locator('[data-ds="detail"]');
  assert.equal(await d.count(), 1);
  assert.match(await d.innerText(), /průběžné/);
  for (const k of ['tasks', 'habits', 'nutrition', 'sleep', 'fitness']) {
    const t = (await d.locator(`.ds-area[data-area="${k}"] .sub`).innerText()).trim();
    assert.ok(t.length > 10, `reason for ${k}: "${t}"`);
  }
  assert.match(await d.locator('.ds-area[data-area="fitness"]').innerText(), /Bonus/);
  assert.match(await d.innerText(), /oddělené od XP/);
  await page.waitForFunction(() => !!document.activeElement.closest('.sheet')); // openSheet() moves focus after 30 ms
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sheet').count(), 0);
}, { state: fixtureState() });

test('9 UI: widget order/visibility is untouched - hiding Level Progress hides the Daily Score card', async ({ page }) => {
  await page.evaluate(() => { S.settings.widgets.progress = false; render(); });
  assert.equal(await page.locator('[data-ds="card"]').count(), 0);
  await page.evaluate(() => { S.settings.widgets.progress = true; S.settings.widgetOrder = ['tasks', 'progress', ...S.settings.widgetOrder.filter(k => k !== 'tasks' && k !== 'progress')]; render(); });
  const order = await page.$$eval('.home > *', ns => ns.map(n => n.querySelector('[data-ds]') ? 'ds' : n.querySelector('#hTasks') ? 'tasks' : null).filter(Boolean));
  assert.deepEqual(order.slice(0, 2), ['tasks', 'ds']);
}, { state: classicState() });

test('9 UI: Daily Score card and detail fit 320/375/390/430 px without overflow', async ({ page }) => {
  const bad = [];
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { closeSheets(); view = 'home'; render(); });
    for (const where of ['home', 'detail']) {
      if (where === 'detail') await page.click('[data-ds="card"]');
      const over = await page.evaluate(() => { const sh = document.querySelector('.sheet'); return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, sh ? sh.scrollWidth - sh.clientWidth : 0); });
      if (over > 0) bad.push(`${where}@${width}: ${over}px`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('9 Statistics: averages/best come from stored snapshots only, missing days stay empty, bars open the stored day', async ({ page }) => {
  const snap = (score, label) => ({ score, label, algo: 1, areas: { tasks: { score }, habits: { score: null }, nutrition: { score: null }, sleep: { score: null }, fitness: { score: null } }, finalizedAt: NOW });
  await page.evaluate(({ a, b, c, d1, d2, d3 }) => { S.dailyScoresSince = todayStr(); /* nothing else to finalize */ S.dailyScores = { [d1]: a, [d2]: b, [d3]: c }; view = 'statistics'; render(); },
    { a: snap(60, 'solid'), b: snap(90, 'excellent'), c: snap(30, 'weaker'), d1: dayOff(-5), d2: dayOff(-3), d3: dayOff(-1) });
  const card = page.locator('[data-ds="stats"]');
  const vals = await card.locator('.stat-value').allInnerTexts();
  assert.deepEqual(vals.map(v => v.trim().split('\n')[0]), ['60', '60', '90'], '7d avg, 30d avg, best (from snapshots only)');
  assert.equal(await card.locator('.ds-bar').count(), 7);
  assert.equal(await card.locator(`.ds-bar[data-day="${dayOff(-4)}"]`).getAttribute('disabled'), '', 'a day without a snapshot is empty, not 0');
  await card.locator(`.ds-bar[data-day="${dayOff(-3)}"]`).click();
  const d = page.locator('[data-ds="detail"]');
  assert.match(await d.innerText(), /uložený snímek dne/);
  assert.equal((await d.locator('.ring > span').innerText()).trim(), '90', 'past day shows its stored snapshot, not a recomputation');
}, { state: fixtureState() });

test('8B fix: a late sheet auto-focus never steals focus from a field the user is typing in', async ({ page }) => {
  // Reproduces the race found by the CRUD test: openSheet()'s 30 ms focus timer firing late (slow device).
  await page.evaluate(() => { const o = window.setTimeout; window.setTimeout = (f, ms, ...a) => o(f, ms === 30 ? 400 : ms, ...a); });
  await page.evaluate(() => openFinanceForm('expense'));
  await page.focus('#f_desc'); await page.keyboard.type('Groceries');
  await page.waitForTimeout(500);                                   // the delayed timer has fired by now
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f_desc', 'focus stays where the user is');
  await page.keyboard.type(' more');
  assert.equal(await page.inputValue('#f_desc'), 'Groceries more');
  assert.equal(await page.inputValue('#f_amt'), '');
}, { state: fixtureState() });

// ---------- Phase 10: Daily Planner ----------
const PB = (o = {}) => ({ date: TODAY, startTime: '15:00', endTime: '16:00', title: 'Matematika', ...o });
// Snapshot of everything the planner must never touch (XP/RPG + Daily Score).
// Polish pass: quests now complete automatically after any action (render -> checkQuests). Tests that
// measure the exact reward of ONE action first close today's/this week's quest board, so the quest XP
// (tested on its own in the polish tests) does not blur the number under test.
const quietQuests = page => page.evaluate(() => ['daily', 'weekly'].forEach(p => questBoardFor(p).forEach(({ q }) => {
  const k = questKey(q.id, p); if (!S.quests.some(x => x.key === k)) S.quests.push({ key: k, questId: q.id, date: todayStr(), period: p });
})) || checkAchievements()); // settle achievements that count quests (Adventurer) before measuring
const untouchable = page => page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.achievementsUnlocked, S.achievementUnlockedAt, S.quests, levelFromXp(S.totalXp), dailyScore(todayStr()), S.dailyScores]));

test('10 planner: time validation - invalid times, same start/end and end before start are rejected', async ({ page }) => {
  const v = o => page.evaluate(f => plannerValidate(f), PB(o));
  assert.deepEqual(await v({}), {});
  assert.deepEqual(await v({ startTime: '16:00', endTime: '16:00' }), { endTime: 'end_before_start' }, 'same start/end');
  assert.deepEqual(await v({ startTime: '16:00', endTime: '15:00' }), { endTime: 'end_before_start' });
  assert.deepEqual(await v({ startTime: '25:00' }), { startTime: 'invalid' });
  assert.deepEqual(await v({ endTime: '10:60' }), { endTime: 'invalid' });
  assert.deepEqual(await v({ startTime: '' }), { startTime: 'invalid' });
  assert.deepEqual(await v({ title: '   ' }), { title: 'required' });
  assert.deepEqual(await v({ date: '2026-02-30' }), { date: 'invalid' });
  assert.equal(await page.evaluate(() => [plannerTimeToMin('00:00'), plannerTimeToMin('23:59'), plannerMinToTime(615)].join()), '0,1439,10:15');
});

test('10 planner: create / edit / delete through the CRUD functions; invalid input saves nothing', async ({ page }) => {
  await page.evaluate(() => { S.plannerBlocks = []; }); // start from an empty planner (fixture has blocks)
  const before = await untouchable(page);
  const r = await page.evaluate(f => { const r = plannerSaveBlock(f); return { ok: r.ok, id: r.block && r.block.id }; }, PB({ category: 'Learning' }));
  assert.ok(r.ok && r.id);
  let s = await stateOf(page);
  const b = s.plannerBlocks.find(x => x.id === r.id);
  assert.deepEqual({ ...b, id: 0, createdAt: 0, updatedAt: 0 }, { id: 0, date: TODAY, startTime: '15:00', endTime: '16:00', title: 'Matematika', description: '', category: 'Learning', taskId: '', goalId: '', workoutId: '', notes: '', workoutTemplateId: '', completed: false, createdAt: 0, updatedAt: 0 }); // 11A-9 adds the optional workoutTemplateId
  const bad = await page.evaluate(f => plannerSaveBlock(f), PB({ startTime: '17:00', endTime: '16:00' }));
  assert.equal(bad.ok, false); assert.equal((await stateOf(page)).plannerBlocks.length, 1, 'invalid block not saved');
  await page.evaluate(id => plannerSaveBlock({ ...S.plannerBlocks.find(b => b.id === id), title: 'Matika', endTime: '16:30' }, { id }), r.id);
  s = await stateOf(page);
  assert.equal(s.plannerBlocks.length, 1); assert.equal(s.plannerBlocks[0].id, r.id, 'edit keeps id'); assert.equal(s.plannerBlocks[0].title, 'Matika'); assert.equal(s.plannerBlocks[0].endTime, '16:30');
  assert.ok(await page.evaluate(id => plannerDeleteBlock(id), r.id));
  assert.equal((await stateOf(page)).plannerBlocks.length, 0);
  assert.equal(await untouchable(page), before, 'no XP/RPG/Daily Score change');
}, { state: fixtureState() });

test('10 planner: overlapping blocks and several blocks at the same time are allowed and laid out side by side', async ({ page }) => {
  await page.evaluate(() => { S.plannerBlocks = []; }); // start from an empty planner (fixture has blocks)
  for (const [a, b] of [['15:00', '16:00'], ['15:30', '17:00'], ['15:00', '16:00'], ['18:00', '19:00']]) assert.ok((await page.evaluate(f => plannerSaveBlock(f).ok, PB({ startTime: a, endTime: b }))));
  const lay = await page.evaluate(() => { const bl = plannerBlocksOn(todayStr()); const l = plannerLayout(bl.map(b => ({ id: b.id, start: plannerTimeToMin(b.startTime), end: plannerTimeToMin(b.endTime) }))); return bl.map(b => [b.startTime, b.endTime, l[b.id].col, l[b.id].cols]); });
  assert.equal(lay.length, 4);
  const cluster = lay.filter(x => x[0] !== '18:00');
  assert.deepEqual(cluster.map(x => x[3]), [3, 3, 3], 'three overlapping blocks share 3 columns');
  assert.deepEqual(new Set(cluster.map(x => x[2])).size, 3, 'each in its own column');
  assert.deepEqual(lay.find(x => x[0] === '18:00').slice(2), [0, 1], 'a separate block uses the full width');
  assert.deepEqual(await page.evaluate(() => plannerLayout([{ id: 'a', start: 60, end: 120 }, { id: 'b', start: 120, end: 180 }])), { a: { col: 0, cols: 1 }, b: { col: 0, cols: 1 } }, 'touching blocks do not overlap');
}, { state: fixtureState() });

test('10 planner: block completion and task completion are independent (no side effects, no XP)', async ({ page }) => {
  await page.evaluate(() => { S.plannerBlocks = []; }); // start from an empty planner (fixture has blocks)
  const id = await page.evaluate(() => plannerSaveBlock({ date: todayStr(), startTime: '15:00', endTime: '16:00', title: 'Write report', taskId: 't_open' }).block.id);
  const before = await untouchable(page);
  await page.evaluate(id => plannerToggleCompleted(id), id);
  let s = await stateOf(page);
  assert.equal(s.plannerBlocks[0].completed, true);
  assert.equal(s.tasks.find(t => t.id === 't_open').done, false, 'completing the block does not complete the task');
  assert.equal(await untouchable(page), before, 'no XP / Daily Score change from block completion');
  await page.evaluate(id => plannerToggleCompleted(id), id);
  // complete the task through the real UI: the block keeps its own completed flag
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Write report' }).locator('.check').click();
  s = await stateOf(page);
  assert.equal(s.tasks.find(t => t.id === 't_open').done, true);
  assert.equal(s.plannerBlocks[0].completed, false, 'completing the task does not complete the block');
}, { state: fixtureState() });

test('10 planner: deleting a linked task (or goal/workout) leaves the block working, links resolve to null', async ({ page }) => {
  await page.evaluate(() => { S.plannerBlocks = []; }); // start from an empty planner (fixture has blocks)
  await page.evaluate(() => plannerSaveBlock({ date: todayStr(), startTime: '15:00', endTime: '16:00', title: 'x', taskId: 't_open', goalId: 'g_fit', workoutId: 'w2' }));
  await page.evaluate(() => { S.tasks = S.tasks.filter(t => t.id !== 't_open'); S.goals = S.goals.filter(g => g.id !== 'g_fit'); S.workouts = S.workouts.filter(w => w.id !== 'w2'); });
  assert.deepEqual(await page.evaluate(() => plannerLinks(S.plannerBlocks[0])), { task: null, goal: null, workout: null, template: null }); // 11A-9: + template link
  assert.equal(await page.evaluate(() => plannerDaySummary(todayStr()).planned), 1);
}, { state: fixtureState() });

test('10 UI: Quick Add -> Planner block creates a real block that appears in the planner immediately', async ({ page }) => {
  const before = await untouchable(page);
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="planner"]');
  await page.fill('#pb_title', 'Učení angličtiny'); await page.fill('#pb_start', '19:00'); await page.fill('#pb_end', '20:00');
  await page.selectOption('#pb_cat', 'Learning'); await page.fill('#pb_notes', 'slovíčka lekce 5');
  await page.click('#pb_save');
  const s = await stateOf(page);
  const b = s.plannerBlocks.find(x => x.title === 'Učení angličtiny');
  assert.ok(b && b.date === TODAY && b.startTime === '19:00' && b.endTime === '20:00' && b.category === 'Learning' && b.completed === false);
  assert.equal(await page.evaluate(() => [view, uiCalMode].join()), 'calendar,today', 'Reality QA: the unified Calendar (day view) replaces the Planner screen');
  assert.equal(await page.locator(`.cg-it[data-kind="block"][data-id="${b.id}"]`).count(), 1, 'visible on the timeline');
  assert.equal(await untouchable(page), before, 'no XP/RPG/Daily Score change');
}, { state: fixtureState() });

test('10 UI: invalid or equal times show an error and save nothing; overlap is allowed', async ({ page }) => {
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  const n0 = (await stateOf(page)).plannerBlocks.length;
  await page.click('#calAdd'); await page.click('[data-add="block"]');
  await page.fill('#pb_title', 'X'); await page.fill('#pb_start', '15:00'); await page.fill('#pb_end', '15:00');
  await page.click('#pb_save');
  assert.equal(await page.locator('[data-err="endTime"]').isVisible(), true);
  assert.match(await page.locator('[data-err="endTime"]').innerText(), /Konec musí být po začátku/);
  assert.equal(await page.getAttribute('#pb_end', 'aria-invalid'), 'true');
  assert.equal((await stateOf(page)).plannerBlocks.length, n0, 'nothing saved');
  await page.fill('#pb_end', '16:00'); await page.click('#pb_save');          // overlaps Matematika + Konzultace
  const lefts = await page.$$eval('.cg-it[data-kind="block"]', ns => ns.filter(n => n.style.top === ns.find(m => m.dataset.id === 'pb_math').style.top).map(n => n.style.left));
  assert.equal(new Set(lefts).size, lefts.length, 'same-time blocks are side by side');
  assert.equal((await stateOf(page)).plannerBlocks.length, n0 + 1);
}, { state: fixtureState() });

test('10 UI: edit and delete a block through the sheet; the timeline check toggles only the block', async ({ page }) => {
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('.cg-it[data-kind="block"][data-id="pb_call"]');
  await page.fill('#pb_title', 'Konzultace s učitelem'); await page.fill('#pb_end', '17:00'); await page.click('#pb_save');
  let s = await stateOf(page);
  assert.deepEqual([s.plannerBlocks.find(b => b.id === 'pb_call').title, s.plannerBlocks.find(b => b.id === 'pb_call').endTime], ['Konzultace s učitelem', '17:00']);
  const taskBefore = JSON.stringify(s.tasks.find(t => t.id === 't_open'));
  await page.click('.cg-it[data-kind="block"][data-id="pb_math"] .cg-chk');
  s = await stateOf(page);
  assert.equal(s.plannerBlocks.find(b => b.id === 'pb_math').completed, true);
  assert.equal(JSON.stringify(s.tasks.find(t => t.id === 't_open')), taskBefore, 'linked task untouched');
  page.on('dialog', d => d.accept());
  await page.click('.cg-it[data-kind="block"][data-id="pb_call"]'); await page.click('#pb_delete'); await page.click('#cf_ok');
  assert.ok(!(await stateOf(page)).plannerBlocks.some(b => b.id === 'pb_call'));
  assert.equal(await page.locator('.cg-it[data-id="pb_call"]').count(), 0);
}, { state: fixtureState() });

test('10 UI: Task -> Naplánovat creates a linked block, the task itself stays unchanged, links work both ways', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  const taskBefore = JSON.stringify((await stateOf(page)).tasks.find(t => t.id === 't_med'));
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.editBtn').click();
  await page.click('#f_plan');
  assert.equal(await page.inputValue('#pb_title'), 'Buy groceries');
  assert.match(await page.innerText('#pb_link'), /Buy groceries/, 'polish pass: the task is the one Linked item');
  await page.fill('#pb_start', '12:00'); await page.fill('#pb_end', '12:30'); await page.click('#pb_save');
  const s = await stateOf(page);
  const b = s.plannerBlocks.find(x => x.taskId === 't_med');
  assert.ok(b); assert.equal(JSON.stringify(s.tasks.find(t => t.id === 't_med')), taskBefore, 'task unchanged');
  assert.match(await page.locator(`.cg-it[data-id="${b.id}"]`).innerText(), /Buy groceries/);
  // task side: chip on the row opens the planner day
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.planLink').click();
  assert.equal(await page.evaluate(() => [view, uiCalMode, uiCalDay].join()), `calendar,today,${TODAY}`);
  // block side: shows the task and its done state after the task is completed
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.check').click();
  await page.waitForTimeout(700);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  const blk = page.locator(`.cg-it[data-id="${b.id}"]`);
  assert.match(await blk.getAttribute('aria-label'), /úkol hotový/);
  // Reality QA: the calendar item says it in its label; a 30 min item is short, so the link line is hidden (the label keeps it)
  assert.equal(await blk.locator('.cg-lk').count(), 1, 'the block carries the linked task state');
  assert.equal((await stateOf(page)).plannerBlocks.find(x => x.id === b.id).completed, false, 'block keeps its own completed flag');
}, { state: fixtureState() });

test('10 UI: deleting the linked task does not crash the planner', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Write report' }).locator('.delbtn').click(); await page.click('#cf_ok');
  assert.ok(!(await stateOf(page)).tasks.some(t => t.id === 't_open'));
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.match(await page.locator('.cg-it[data-id="pb_math"]').innerText(), /smazáno/);
}, { state: fixtureState() });

test('10 UI: Home shows Today\'s plan (polish pass: its own widget right after the Daily Score) and opens the day overview / planner', async ({ page }) => {
  const card = page.locator('[data-plan="home"]');
  assert.equal(await card.count(), 1);
  assert.deepEqual((await card.locator('.plan-row .plan-time b').allInnerTexts()).map(x => x.trim()), ['08:00', '15:00', '15:30', '17:00'], "today's blocks only, by time");
  assert.deepEqual((await card.locator('.plan-row .plan-time small').allInnerTexts()).map(x => x.trim()), ['09:00', '16:00', '16:30', '18:15'], 'with end times');
  const order = await page.evaluate(() => [...document.querySelectorAll('#app .hud-wrap, #app [data-plan="home"], #hTasks, #hHabits')].map(n => n.id || n.dataset.plan || 'score'));
  assert.deepEqual(order, ['score', 'home', 'hTasks', 'hHabits'], 'Daily Score -> plan -> tasks -> habits');
  await card.click();
  const ov = page.locator('#dayOverview');
  assert.equal(await ov.count(), 1, 'day overview sheet');
  assert.equal(await ov.locator('.plan-row').count(), 4);
  await page.click('#dovPlanner');
  assert.equal(await page.evaluate(() => [view, uiCalMode, uiCalDay].join()), `calendar,today,${TODAY}`);
  await page.evaluate(() => { S.settings.widgets.tasks = false; view = 'home'; render(); });
  assert.equal(await page.locator('[data-plan="home"]').count(), 1, 'independent of the tasks widget');
  await page.evaluate(() => { S.settings.widgets.planner = false; view = 'home'; render(); });
  assert.equal(await page.locator('[data-plan="home"]').count(), 0, 'its own widget key can hide it');
}, { state: classicState() });

test('10 UI: day navigation (prev/next/Today) and read-only calendar events (never copied)', async ({ page }) => {
  const events = JSON.stringify((await stateOf(page)).events);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.equal(await page.locator('.cg-it[data-kind="event"][data-id="ev1"]').count(), 1, "today's timed event shown in the day");
  await page.click('#calNextD');
  assert.equal(await page.evaluate(() => uiCalDay), dayOff(1));
  assert.match(await page.locator('#calDayPanel .cg').innerText(), /Učení/);
  await page.click('#calMode [data-m="today"]'); assert.equal(await page.evaluate(() => uiCalDay), TODAY);
  await page.click('#calPrevD'); assert.equal(await page.evaluate(() => uiCalDay), dayOff(-1));
  assert.equal(JSON.stringify((await stateOf(page)).events), events, 'calendar events untouched');
  assert.equal((await stateOf(page)).plannerBlocks.length, 5, 'events were not copied into blocks');
}, { state: fixtureState() });

test('10 Search: planner blocks are found by title, description and notes and open in the planner', async ({ page }) => {
  await page.evaluate(() => { view = 'search'; render(); });
  for (const q of ['Matem', 'Kapitola', 'Zoom']) {
    await page.fill('#gs', q);
    assert.ok(await page.locator('#gsRes .search-hit', { hasText: q === 'Zoom' ? 'Konzultace' : 'Matematika' }).count() >= 1, q);
  }
  await page.fill('#gs', 'Kapitola');
  await page.locator('#gsRes .search-hit', { hasText: 'Matematika' }).click();
  assert.equal(await page.evaluate(() => [view, uiCalDay].join()), `calendar,${TODAY}`);
  assert.equal(await page.inputValue('#pb_title'), 'Matematika', 'block opened for editing');
}, { state: fixtureState() });

test('10 data: planner blocks survive reload + export/import; reset removes them; old state gets []', async ({ page }) => {
  await persist(page); await reload(page);
  const blocks = (await stateOf(page)).plannerBlocks;
  assert.equal(blocks.length, 5);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).plannerBlocks, blocks);
  await page.evaluate(() => { S.plannerBlocks = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.plannerBlocks.length === 5);
  const old = fixtureState(); delete old.plannerBlocks;
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => Array.isArray(S.plannerBlocks) && S.plannerBlocks.length === 0);
  assert.equal((await stateOf(page)).schemaVersion, 8);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.equal(await page.locator('.cg-it[data-kind="block"]').count(), 0);
  page.on('dialog', d => d.accept());
  await page.evaluate(() => { S.plannerBlocks = [{ id: 'x', date: todayStr(), startTime: '10:00', endTime: '11:00', title: 'x' }]; });
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual((await stateOf(page)).plannerBlocks, []);
}, { state: fixtureState() });

test('10 invariants: a full planner session changes no XP/log/level/attributes/points/achievements/quests/Daily Score, tasks or events', async ({ page }) => {
  const other = () => page.evaluate(() => JSON.stringify([S.tasks, S.events, S.goals, S.workouts, S.habits]));
  const [u0, o0] = [await untouchable(page), await other()];
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('#calAdd'); await page.click('[data-add="block"]'); await page.fill('#pb_title', 'Test'); await page.fill('#pb_start', '11:00'); await page.fill('#pb_end', '11:45');
  await page.click('#pb_link'); await page.click('[data-lk-type="task"][data-lk-id="t_open"]'); await page.click('#pb_save');
  const id = (await stateOf(page)).plannerBlocks.find(b => b.title === 'Test').id;
  await page.click(`.cg-it[data-kind="block"][data-id="${id}"] .cg-chk`); await page.click(`.cg-it[data-kind="block"][data-id="pb_math"] .cg-chk`); await page.click(`.cg-it[data-kind="block"][data-id="pb_math"] .cg-chk`);
  await page.click(`.cg-it[data-kind="block"][data-id="${id}"]`); await page.fill('#pb_title', 'Test 2'); await page.click('#pb_save');
  page.on('dialog', d => d.accept());
  await page.click(`.cg-it[data-kind="block"][data-id="${id}"]`); await page.click('#pb_delete'); await page.click('#cf_ok');
  await page.click('#calNextD'); await page.click('#calMode [data-m="today"]');
  assert.equal(await untouchable(page), u0, 'XP / RPG / Daily Score unchanged');
  assert.equal(await other(), o0, 'tasks, events, goals, workouts, habits unchanged');
}, { state: fixtureState() });

// ---------- Phase 11A step 1: exercise library + muscle groups ----------
const EX = o => ({ name: 'Test lift', measurement: 'weight_reps', increment: '', muscles: {}, notes: '', ...o });
const libSorted = s => [...s.exerciseLibrary].sort((a, b) => a.name.localeCompare(b.name));

test('11A library: muscle percentages are normalized to exactly 100 % (unknown groups, negatives, empty dropped)', async ({ page }) => {
  const n = m => page.evaluate(m => normalizeMuscles(m), m);
  assert.deepEqual(await page.evaluate(() => MUSCLE_GROUPS), ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Abs', 'Glutes', 'Forearms']);
  assert.deepEqual(await n({ Chest: 70, Triceps: 20, Shoulders: 10 }), { Chest: 70, Shoulders: 10, Triceps: 20 });
  assert.deepEqual(await n({ Chest: 1, Triceps: 1, Shoulders: 1 }), { Chest: 34, Shoulders: 33, Triceps: 33 });
  assert.deepEqual(await n({ Chest: '50', Back: 50, Legs: 50 }), { Chest: 34, Back: 33, Legs: 33 });
  assert.deepEqual(await n({ Chest: 140, Triceps: 60 }), { Chest: 70, Triceps: 30 });
  assert.deepEqual(await n({ Chest: 80, Quads: 20, Abs: -5, Glutes: 'x', Back: 0 }), { Chest: 100 }, 'unknown/negative/NaN/zero dropped');
  assert.deepEqual(await n({}), {}); assert.deepEqual(await n(null), {}); assert.deepEqual(await n({ Chest: 0 }), {});
  const sums = await page.evaluate(() => Array.from({ length: 300 }, (_, i) => {
    const m = {}; MUSCLE_GROUPS.forEach((g, j) => { if ((i * 7 + j * 3) % 4) m[g] = ((i + 1) * (j + 3) * 37) % 97; });
    const r = normalizeMuscles(m); const k = Object.keys(r); return k.length ? Object.values(r).reduce((a, b) => a + b, 0) : 100;
  }));
  assert.ok(sums.every(s => s === 100), 'every non-empty normalization sums to 100');
  assert.ok(await page.evaluate(() => EXERCISE_PRESETS.every(p => Object.values(normalizeMuscles(p.muscles)).reduce((a, b) => a + b, 0) === 100 && MEASUREMENTS.includes(p.measurement))));
});

test('11A library: save validates (required, duplicate, measurement, increment, muscles); edit keeps the id; all 4 measurement types', async ({ page }) => {
  const u0 = await untouchable(page);
  const save = (f, id) => page.evaluate(({ f, id }) => { const r = exerciseSave(f, id); return JSON.parse(JSON.stringify(r)); }, { f, id });
  const n0 = (await stateOf(page)).exerciseLibrary.length;
  assert.deepEqual((await save(EX({ name: '  ' }))).errors, { name: 'required' });
  assert.deepEqual((await save(EX({ name: ' bench  PRESS ' }))).errors, { name: 'duplicate' }, 'case/space-insensitive duplicate of the seeded "Bench press"');
  assert.deepEqual((await save(EX({ measurement: 'kg' }))).errors, { measurement: 'invalid' });
  assert.deepEqual((await save(EX({ increment: '-1' }))).errors, { increment: 'invalid' });
  assert.deepEqual((await save(EX({ muscles: { Quads: 50 } }))).errors, { muscles: 'invalid' });
  assert.deepEqual((await save(EX({ muscles: { Chest: -10 } }))).errors, { muscles: 'invalid' });
  assert.equal((await stateOf(page)).exerciseLibrary.length, n0, 'invalid input saves nothing');
  const made = {};
  for (const [name, measurement, inc] of [['Pull-up X', 'reps', 1], ['Plank X', 'time', 5], ['Run X', 'distance_time', 0], ['Row X', 'weight_reps', 2.5]]) {
    const r = await save(EX({ name, measurement, muscles: { Back: 2, Biceps: 1 } }));
    assert.equal(r.ok, true); assert.equal(r.exercise.measurement, measurement); assert.equal(r.exercise.increment, inc, `default increment for ${measurement}`);
    assert.deepEqual(r.exercise.muscles, { Back: 67, Biceps: 33 }); assert.equal(r.exercise.source, 'user'); assert.equal(r.exercise.archived, false);
    made[name] = r.exercise.id;
  }
  const e = await save(EX({ name: 'Pull-up X2', measurement: 'reps', increment: '2', muscles: { Back: 60, Biceps: 30, Forearms: 10 }, notes: 'wide' }), made['Pull-up X']);
  assert.equal(e.exercise.id, made['Pull-up X'], 'edit keeps id'); assert.equal(e.exercise.increment, 2); assert.equal(e.exercise.notes, 'wide');
  assert.equal((await stateOf(page)).exerciseLibrary.length, n0 + 4);
  assert.equal((await save(EX({ name: 'pull-up x2' }), made['Pull-up X'])).ok, true, 'renaming a record to its own name is not a duplicate');
  assert.equal(await untouchable(page), u0, 'no XP / RPG / Daily Score change');
}, { state: fixtureState() });

test('11A migration: an old state gets bare exercise names from its history; workouts untouched; idempotent; existing library kept', async ({ page }) => {
  const s = await stateOf(page); // fixture has no exerciseLibrary -> seeded at boot
  assert.equal(s.schemaVersion, 8);
  assert.deepEqual(libSorted(s).map(x => [x.name, x.measurement, x.source, x.muscles, x.archived]),
    [['Bench press', 'weight_reps', 'history', {}, false], ['Deadlift', 'weight_reps', 'history', {}, false], ['Overhead press', 'weight_reps', 'history', {}, false]],
    'names only - the old free-text muscle ("Chest") is never turned into invented percentages');
  assert.deepEqual(s.workouts, fixtureState().workouts.map(w => ({ ...w })), 'workout history is not modified');
  const r = await page.evaluate(() => {
    const again = migrate(JSON.parse(JSON.stringify(S)));
    const legacy = o => { const st = Object.assign(defaultState(), o); if (!('exerciseLibrary' in o)) delete st.exerciseLibrary; return st; };
    const dupes = migrate(legacy({ tasks: [], workouts: [
      { id: 'a', name: 'A', date: '2026-01-01', exercises: [{ name: ' squat ' }, { name: 'Squat' }, { name: 'SQUAT' }, { name: '' }] },
      { id: 'b', name: 'B', date: '2026-01-02', exercises: [{ name: 'Front  squat' }] }, { id: 'c', name: 'C', date: '2026-01-03' }] }));
    const kept = migrate(Object.assign(defaultState(), { tasks: [], exerciseLibrary: [], workouts: [{ id: 'a', name: 'A', date: '2026-01-01', exercises: [{ name: 'Squat' }] }] }));
    const fixed = migrate(Object.assign(defaultState(), { tasks: [], exerciseLibrary: [{ id: 'x1', name: 'Odd', measurement: 'bogus', muscles: { Chest: 3, Back: 1, Nope: 5 } }] }));
    const fresh = defaultState();
    return { same: JSON.stringify(again.exerciseLibrary) === JSON.stringify(S.exerciseLibrary), dupes: dupes.exerciseLibrary.map(x => x.name), kept: kept.exerciseLibrary, fixed: fixed.exerciseLibrary[0], fresh: fresh.exerciseLibrary, wk: dupes.workouts[0].exercises.length };
  });
  assert.equal(r.same, true, 're-running migrate() keeps the same library (same ids)');
  assert.deepEqual(r.dupes, ['squat', 'Front squat'], 'one record per distinct name (trimmed, case-insensitive), empty names skipped');
  assert.equal(r.wk, 4, 'the old workout still has all 4 exercise rows');
  assert.deepEqual(r.kept, [], 'a user who emptied the library does not get it re-seeded');
  assert.equal(r.fixed.id, 'x1'); assert.equal(r.fixed.measurement, 'weight_reps'); assert.deepEqual(r.fixed.muscles, { Chest: 75, Back: 25 });
  assert.deepEqual(r.fresh, [], 'a fresh install starts with an empty library');
  // Old workouts still render and compute exactly as before.
  await page.evaluate(() => { fitnessTab = 'workouts'; view = 'fitness'; render(); });
  assert.match(await appText(page), /Push day/);
  assert.deepEqual(await page.evaluate(() => S.workouts.map(w => [workoutVolume(w), workoutTotalSets(w), workoutTotalReps(w)])), [[3910, 7, 62], [2100, 3, 15]]);
}, { state: fixtureState() });

test('11A library: delete removes an unused exercise, archives one that is referenced by id; restore respects duplicates', async ({ page }) => {
  const r = await page.evaluate(() => {
    const a = exerciseSave({ name: 'Unused', measurement: 'reps', muscles: {} }).exercise;
    const b = exerciseSave({ name: 'Used', measurement: 'weight_reps', muscles: { Chest: 1 } }).exercise;
    S.workouts.push({ id: 'wx', name: 'New model', date: todayStr(), exercises: [], entries: [{ id: 'en1', exerciseId: b.id, sets: [] }] });
    const out = { del: exerciseDelete(a.id), arch: exerciseDelete(b.id), missing: exerciseDelete('nope') };
    out.gone = !S.exerciseLibrary.some(x => x.id === a.id);
    out.archived = S.exerciseLibrary.find(x => x.id === b.id).archived;
    out.findByName = exerciseFind('used'); out.findById = exerciseFind(b.id).id === b.id;
    const c = exerciseSave({ name: 'Used', measurement: 'reps', muscles: {} });
    out.newOk = c.ok; out.restoreBlocked = exerciseRestore(b.id);
    exerciseDelete(c.exercise.id); out.restoreOk = exerciseRestore(b.id);
    out.entryIntact = S.workouts.find(w => w.id === 'wx').entries[0].exerciseId === b.id;
    return out;
  });
  assert.deepEqual(r, { del: 'deleted', arch: 'archived', missing: null, gone: true, archived: true, findByName: null, findById: true, newOk: true, restoreBlocked: false, restoreOk: true, entryIntact: true });
}, { state: fixtureState() });

test('11A UI: Fitness tabs, add exercise with muscles (normalized on save), validation errors, catalog, edit and delete', async ({ page }) => {
  const u0 = await untouchable(page);
  await page.evaluate(() => { fitnessTab = 'workouts'; view = 'fitness'; render(); });
  await page.click('#fitTabs [data-k="library"]');
  assert.equal(await page.locator('#exLib .ex-card').count(), 3, 'seeded names are listed');
  assert.match(await page.locator('#exLib').innerText(), /Svaly nevyplněné/);
  await page.click('#uiAddEx'); await page.click('#ex_save');
  assert.equal(await page.locator('#ex_name_err').isVisible(), true);
  assert.match(await page.locator('#ex_name_err').innerText(), /Vyplň název/);
  await page.fill('#ex_name', 'bench press'); await page.click('#ex_save');
  assert.match(await page.locator('#ex_name_err').innerText(), /už v knihovně/);
  assert.equal((await stateOf(page)).exerciseLibrary.length, 3, 'nothing saved');
  await page.fill('#ex_name', 'Chin-up'); await page.selectOption('#ex_meas', 'reps');
  assert.equal(await page.inputValue('#ex_inc'), '1');
  await page.fill('[data-muscle="Back"]', '50'); await page.fill('[data-muscle="Biceps"]', '50'); await page.fill('[data-muscle="Forearms"]', '50');
  assert.match(await page.locator('#ex_sum').innerText(), /150 %.*100 %/);
  await page.click('#ex_save');
  let x = (await stateOf(page)).exerciseLibrary.find(e => e.name === 'Chin-up');
  assert.deepEqual([x.measurement, x.increment, x.muscles], ['reps', 1, { Back: 34, Biceps: 33, Forearms: 33 }]);
  assert.match(await page.locator(`[data-ex="${x.id}"]`).innerText(), /Záda 34 %/);
  // catalog
  await page.click('#uiExCatalog');
  assert.equal(await page.locator('[data-preset="Bench Press"]').count(), 0, 'already in the library (case-insensitive) is not offered');
  await page.click('[data-preset="Plank"] .catAdd');
  await page.evaluate(() => closeSheets());
  const plank = (await stateOf(page)).exerciseLibrary.find(e => e.name === 'Plank');
  assert.deepEqual([plank.measurement, plank.source, plank.muscles], ['time', 'preset', { Shoulders: 10, Abs: 80, Glutes: 10 }]);
  // edit: open the seeded Deadlift and give it muscles
  const dl = (await stateOf(page)).exerciseLibrary.find(e => e.name === 'Deadlift');
  await page.click(`[data-ex="${dl.id}"] .ex-open`);
  await page.fill('[data-muscle="Back"]', '40'); await page.fill('[data-muscle="Legs"]', '40'); await page.fill('[data-muscle="Glutes"]', '20');
  await page.click('#ex_save');
  x = (await stateOf(page)).exerciseLibrary.find(e => e.id === dl.id);
  assert.deepEqual([x.name, x.source, x.muscles], ['Deadlift', 'history', { Back: 40, Legs: 40, Glutes: 20 }]);
  // delete (unused -> really deleted)
  page.on('dialog', d => d.accept());
  await page.click(`[data-ex="${dl.id}"] .ex-open`); await page.click('#ex_delete'); await page.click('#cf_ok');
  assert.equal((await stateOf(page)).exerciseLibrary.some(e => e.id === dl.id), false);
  await page.click('#fitTabs [data-k="workouts"]');
  assert.equal(await page.locator('#addW').count(), 1, 'workouts tab is back');
  assert.equal(await untouchable(page), u0, 'no XP / RPG / Daily Score change');
  assert.deepEqual((await stateOf(page)).workouts, fixtureState().workouts, 'workouts unchanged');
}, { state: fixtureState() });

test('11A UI: library, exercise form and catalog fit 320-1440 px without overflow; no duplicate ids', async ({ page }) => {
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const open of [null, 'form', 'catalog']) {
      await page.evaluate(o => { closeSheets(); fitnessTab = 'library'; view = 'fitness'; render(); if (o === 'form') openExerciseForm(S.exerciseLibrary[0]); if (o === 'catalog') openExerciseCatalog(); }, open);
      const r = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        const sheet = document.querySelector('.sheet');
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i) };
      });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length) bad.push(`${open || 'list'}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('11A data: library survives reload + export/import; old backup is seeded; reset empties it', async ({ page }) => {
  await page.evaluate(() => { exerciseAddPreset('Pull-up'); });
  await persist(page); await reload(page);
  const lib = (await stateOf(page)).exerciseLibrary;
  assert.equal(lib.length, 4);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).exerciseLibrary, lib);
  await page.evaluate(() => { S.exerciseLibrary = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.exerciseLibrary.length === 4);
  assert.deepEqual((await stateOf(page)).exerciseLibrary, lib, 'import restores it exactly (same ids)');
  const old = fixtureState(); delete old.exerciseLibrary;
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.exerciseLibrary.length === 3 && S.exerciseLibrary.every(x => x.source === 'history'));
  assert.equal((await stateOf(page)).schemaVersion, 8);
  page.on('dialog', d => d.accept());
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual((await stateOf(page)).exerciseLibrary, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 2: workout templates ----------
const libIds = page => page.evaluate(() => {
  ['Plank', 'Running', 'Pull-up'].forEach(n => exerciseAddPreset(n));
  return Object.fromEntries(S.exerciseLibrary.map(x => [x.name, x.id]));
});

test('11A templates: validation per measurement type, normalization, edit keeps ids, delete; nothing else changes', async ({ page }) => {
  const u0 = await untouchable(page); const w0 = JSON.stringify((await stateOf(page)).workouts);
  const L = await libIds(page);
  const save = (f, id) => page.evaluate(({ f, id }) => JSON.parse(JSON.stringify(templateSave(f, id))), { f, id });
  const E = (exerciseId, o) => ({ exerciseId, sets: '3', repsMin: '8', repsMax: '12', weight: '', seconds: '', distance: '', rest: '', ...o });
  assert.deepEqual((await save({ name: ' ', exercises: [] })).errors, { name: 'required', exercises: 'empty' });
  assert.deepEqual((await save({ name: 'X', exercises: [E('nope')] })).errors, { 'ex.0.exerciseId': 'required' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { sets: '0' })] })).errors, { 'ex.0.sets': 'invalid' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { sets: '21' })] })).errors, { 'ex.0.sets': 'invalid' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { sets: '2.5' })] })).errors, { 'ex.0.sets': 'invalid' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { repsMin: '10', repsMax: '8' })] })).errors, { 'ex.0.repsMax': 'range' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Pull-up'], { repsMin: '' })] })).errors, { 'ex.0.repsMin': 'invalid' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { weight: '-5' })] })).errors, { 'ex.0.weight': 'invalid' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Plank'])] })).errors, { 'ex.0.seconds': 'invalid' }, 'time needs seconds, reps are irrelevant');
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Running'], { sets: '1' })] })).errors, { 'ex.0.distance': 'required' });
  assert.deepEqual((await save({ name: 'X', exercises: [E(L['Bench press'], { rest: '-1' })] })).errors, { 'ex.0.rest': 'invalid' });
  assert.equal((await stateOf(page)).workoutTemplates.length, 0, 'invalid input saves nothing');
  const r = await save({ name: ' Push A ', notes: 'n', exercises: [
    E(L['Bench press'], { sets: '4', repsMin: '6', repsMax: '8', weight: '70', rest: '120' }),
    E(L['Pull-up'], { repsMax: '', weight: '20' }),
    E(L['Plank'], { sets: '2', seconds: '60', repsMin: '8', weight: '10' }),
    E(L['Running'], { sets: '1', distance: '5', seconds: '' })] });
  assert.equal(r.ok, true);
  const t = r.template;
  assert.equal(t.name, 'Push A');
  const pick = te => [te.sets, te.repsMin, te.repsMax, te.weight, te.seconds, te.distance, te.rest];
  assert.deepEqual(t.exercises.map(pick), [[4, 6, 8, 70, null, null, 120], [3, 8, 8, null, null, null, null], [2, null, null, null, 60, null, null], [1, null, null, null, null, 5, null]],
    'numbers only; repsMax defaults to repsMin; fields of other measurement types are cleared (no kg on pull-ups/plank)');
  const r2 = await save({ name: 'Push A2', notes: '', exercises: [t.exercises[1], { ...t.exercises[0], sets: 5 }] }, t.id);
  assert.equal(r2.template.id, t.id);
  assert.deepEqual(r2.template.exercises.map(te => te.id), [t.exercises[1].id, t.exercises[0].id], 'row ids survive reordering');
  assert.equal(r2.template.exercises[1].sets, 5);
  assert.deepEqual(await page.evaluate(id => templateSummary(templateFind(id)), t.id), { exercises: 2, sets: 8 });
  // a library exercise used by a template is archived instead of deleted; the template still resolves it
  const arch = await page.evaluate(id => [exerciseDelete(id), exerciseFind(id).name], L['Pull-up']);
  assert.deepEqual(arch, ['archived', 'Pull-up']);
  assert.equal(await page.evaluate(id => templateDelete(id), t.id), true);
  assert.equal((await stateOf(page)).workoutTemplates.length, 0);
  assert.equal(await untouchable(page), u0, 'no XP / RPG / Daily Score change');
  assert.equal(JSON.stringify((await stateOf(page)).workouts), w0, 'workouts unchanged');
}, { state: fixtureState() });

test('11A UI: create, validate, reorder, edit and delete a template; fields follow the exercise measurement', async ({ page }) => {
  const L = await libIds(page);
  await page.evaluate(() => { fitnessTab = 'workouts'; view = 'fitness'; render(); });
  await page.click('#fitTabs [data-k="templates"]');
  assert.match(await appText(page), /Zatím žádné šablony/);
  await page.click('#uiAddTpl');
  await page.click('#tp_save');
  assert.match(await page.locator('[data-err="name"]').innerText(), /Vyplň název/);
  assert.match(await page.locator('.tp-row [data-ferr="exerciseId"]').innerText(), /Povinné/);
  await page.fill('#tp_name', 'Full body');
  const rows = page.locator('.tp-row');
  await rows.nth(0).locator('.tp-ex').selectOption(L['Bench press']);
  assert.deepEqual(await rows.nth(0).locator('[data-f]').evaluateAll(ns => ns.map(n => n.dataset.f)), ['sets', 'repsMin', 'repsMax', 'weight', 'rest']);
  await rows.nth(0).locator('[data-f="weight"]').fill('70');
  await page.click('#tp_addEx');
  await rows.nth(1).locator('.tp-ex').selectOption(L['Plank']);
  assert.deepEqual(await rows.nth(1).locator('[data-f]').evaluateAll(ns => ns.map(n => n.dataset.f)), ['sets', 'seconds', 'rest'], 'time exercise: no reps, no kg');
  await rows.nth(1).locator('[data-f="seconds"]').fill('');
  await page.click('#tp_save');
  assert.match(await rows.nth(1).locator('[data-ferr="seconds"]').innerText(), /Neplatná/);
  assert.equal(await rows.nth(1).locator('[data-f="seconds"]').getAttribute('aria-invalid'), 'true');
  assert.equal((await stateOf(page)).workoutTemplates.length, 0, 'nothing saved');
  await rows.nth(1).locator('[data-f="seconds"]').fill('45');
  await rows.nth(1).locator('.tpUp').click();
  await page.click('#tp_save');
  let t = (await stateOf(page)).workoutTemplates[0];
  assert.deepEqual(t.exercises.map(te => [te.exerciseId, te.sets, te.seconds, te.weight]), [[L['Plank'], 3, 45, null], [L['Bench press'], 3, null, 70]]);
  assert.match(await page.locator(`[data-tpl="${t.id}"]`).innerText(), /2 cviků · 6 sérií[\s\S]*Plank · Bench press/);
  await page.click(`[data-tpl="${t.id}"] .tpl-open`);
  assert.equal(await page.inputValue('#tp_name'), 'Full body');
  await rows.nth(0).locator('.tpRm').click();
  await page.click('#tp_save');
  t = (await stateOf(page)).workoutTemplates[0];
  assert.deepEqual(t.exercises.map(te => te.exerciseId), [L['Bench press']]);
  page.on('dialog', d => d.accept());
  await page.click(`[data-tpl="${t.id}"] .tpl-open`); await page.click('#tp_delete'); await page.click('#cf_ok');
  assert.equal((await stateOf(page)).workoutTemplates.length, 0);
}, { state: fixtureState() });

test('11A UI: templates list and form fit 320-1440 px without overflow; no duplicate ids; empty library hint', async ({ page }) => {
  await page.evaluate(() => {
    exerciseAddPreset('Running'); exerciseAddPreset('Plank');
    const id = n => exerciseFind(n).id;
    templateSave({ name: 'A very long template name that should wrap or truncate nicely on a phone', exercises: [
      { exerciseId: id('Bench press'), sets: 4, repsMin: 6, repsMax: 8, weight: 72.5, rest: 180 }, { exerciseId: id('Running'), sets: 1, distance: 5, seconds: 1500 },
      { exerciseId: id('Plank'), sets: 3, seconds: 60 }, { exerciseId: id('Deadlift'), sets: 3, repsMin: 5 }] });
  });
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const open of [null, 'form']) {
      await page.evaluate(o => { closeSheets(); fitnessTab = 'templates'; view = 'fitness'; render(); if (o) openTemplateForm(S.workoutTemplates[0]); }, open);
      const r = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id); const sheet = document.querySelector('.sheet');
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i) };
      });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length) bad.push(`${open || 'list'}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
  await page.evaluate(() => { closeSheets(); S.exerciseLibrary = []; openTemplateForm(); });
  assert.match(await page.locator('.sheet').innerText(), /Nejdřív si přidej cviky/);
  assert.equal(await page.locator('#tp_addEx').isDisabled(), true);
  await page.click('#tp_golib');
  assert.equal(await page.evaluate(() => fitnessTab), 'library');
}, { state: fixtureState() });

test('11A data: templates survive reload + export/import; old backup gets []; reset empties them', async ({ page }) => {
  await page.evaluate(() => templateSave({ name: 'Pull', exercises: [{ exerciseId: exerciseFind('Deadlift').id, sets: 3, repsMin: 5 }] }));
  await persist(page); await reload(page);
  const tpls = (await stateOf(page)).workoutTemplates;
  assert.equal(tpls.length, 1);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).workoutTemplates, tpls);
  await page.evaluate(() => { S.workoutTemplates = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.workoutTemplates.length === 1);
  assert.deepEqual((await stateOf(page)).workoutTemplates, tpls);
  const old = fixtureState(); delete old.workoutTemplates;
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => Array.isArray(S.workoutTemplates) && S.workoutTemplates.length === 0);
  page.on('dialog', d => d.accept());
  await page.evaluate(() => templateSave({ name: 'x', exercises: [{ exerciseId: S.exerciseLibrary[0].id, sets: 1, repsMin: 1 }] }));
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual((await stateOf(page)).workoutTemplates, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 3: active workout model ----------
// A state with no workouts at all and a Fitness event today, so "a workout counts" is observable
// in every consumer (quests, achievements, Daily Score, Home, Statistics, search, history).
const noWorkoutState = () => {
  const s = fixtureState(); s.workouts = []; s.achievementsUnlocked = ['first_task']; s.quests = [];
  s.events.push({ id: 'ev_gym', title: 'Gym', description: '', date: TODAY, category: 'Fitness', start: '17:00', end: '18:00', location: '', recurring: 'none', reminder: '', linkedTaskId: '', linkedGoalId: '', linkedHabitId: '', createdAt: NOW });
  return s;
};
const setupTpl = page => page.evaluate(() => {
  exerciseAddPreset('Bench Press'); exerciseAddPreset('Deadlift'); exerciseAddPreset('Plank'); exerciseAddPreset('Pull-up');
  const id = n => exerciseFind(n).id;
  return templateSave({ name: 'Push A', exercises: [{ exerciseId: id('Bench press'), sets: 2, repsMin: 8, repsMax: 10, weight: 70 },
    { exerciseId: id('Pull-up'), sets: 2, repsMin: 6 }, { exerciseId: id('Plank'), sets: 1, seconds: 60 }] }).template.id;
});
const consumers = page => page.evaluate(() => {
  const ds = dailyScoreFitness(todayStr());
  return { completed: completedWorkouts(S).length, ds: ds.score, dsWorkouts: ds.workouts, dq_workout: DAILY_QUESTS.find(q => q.id === 'dq_workout').check(S),
    dq_log_val: DAILY_QUESTS.find(q => q.id === 'dq_nutrition').val(S), /* polish pass: dq_log was replaced by the meal quest */ wq: WEEKLY_QUESTS.find(q => q.id === 'wq_workouts').val(S),
    ach: ACHV.find(a => a.id === 'first_workout').cond(S), achProg: ACHV.find(a => a.id === 'fitness_beast').progress(S),
    stats: computeStats('week').fitness.count,
    searchN: (searchGroups('Push A').find(g => g[2] === 'workout') || [])[3]?.length || 0, prs: exercisePRs().length };
});

test('11A active: isCompletedWorkout - active is not done, done is done, a record without status is done (old data untouched)', async ({ page }) => {
  const r = await page.evaluate(() => [isCompletedWorkout({}), isCompletedWorkout({ status: 'done' }), isCompletedWorkout({ status: 'active' }), isCompletedWorkout(null),
    completedWorkouts(S).map(w => w.id), S.workouts.map(w => 'status' in w)]);
  assert.deepEqual(r, [true, true, false, false, ['w1', 'w2'], [false, false]], 'old workouts are interpreted as done and not rewritten');
}, { state: fixtureState() });

test('11A active: Start creates ONE active record in workouts[] from the template (copied plan); a second Start resumes it', async ({ page }) => {
  const tid = await setupTpl(page);
  const r = await page.evaluate(tid => { const a = workoutStart({ templateId: tid }); const b = workoutStart({ templateId: tid }); const c = workoutStart({}); return JSON.parse(JSON.stringify({ a, b, c, n: S.workouts.length })); }, tid);
  const w = r.a.workout;
  assert.equal(r.a.ok, true); assert.equal(w.status, 'active'); assert.equal(w.templateId, tid); assert.equal(w.date, TODAY); assert.deepEqual(w.exercises, []);
  assert.deepEqual([r.b.ok, r.b.reason, r.b.workout.id, r.c.workout.id, r.n], [false, 'active_exists', w.id, w.id, 3], 'no duplicate active workout');
  assert.deepEqual(w.entries.map(en => [en.name, en.measurement, en.sets.length, en.target.sets]), [['Bench press', 'weight_reps', 2, 2], ['Pull-up', 'reps', 2, 2], ['Plank', 'time', 1, 1]]);
  assert.deepEqual(w.entries[0].sets.map(st => [st.weight, st.reps, st.done, st.warmup]), [[70, 8, false, false], [70, 8, false, false]], 'sets prefilled from the plan, not done');
  assert.deepEqual(w.entries[1].sets[0].weight, null, 'no kg on a reps exercise');
  assert.equal(w.entries[2].sets[0].seconds, 60);
  // the plan is a copy: editing / deleting the template or the library exercise never rewrites the workout
  await page.evaluate(tid => { const t = templateFind(tid); templateSave({ name: 'Changed', exercises: [t.exercises[0]] }, tid); exerciseSave({ name: 'Bench renamed', measurement: 'weight_reps', muscles: {} }, exerciseFind('Bench press').id); templateDelete(tid); }, tid);
  const after = (await stateOf(page)).workouts.find(x => x.id === w.id);
  assert.deepEqual(after.entries.map(en => en.name), ['Bench press', 'Pull-up', 'Plank']);
  assert.equal(after.name, 'Push A');
}, { state: fixtureState() });

test('11A active: Start grants nothing and counts nowhere; Finish counts everywhere and pays the 80 XP exactly once', async ({ page }) => {
  const tid = await setupTpl(page);
  const u0 = await untouchable(page);
  const c0 = await consumers(page);
  assert.deepEqual([c0.completed, c0.ds, c0.dq_workout, c0.dq_log_val, c0.wq, c0.ach, c0.achProg, c0.stats, c0.searchN, c0.prs], [0, 0, false, 1, 0, false, 0, 0, 0, 0],
    'baseline: Fitness planned today, nothing done (dq_log is already met by a meal)');
  const wid = await page.evaluate(tid => { const w = workoutStart({ templateId: tid }).workout; const en = w.entries[0]; workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true, weight: 72.5, reps: 8 }); return w.id; }, tid);
  // everything that could react to it runs: quest check, achievements, all screens
  await page.evaluate(() => { checkQuests(); checkAchievements(); for (const v of ['home', 'fitness', 'quests', 'statistics', 'character', 'calendar', 'planner', 'search']) { view = v; render(); } });
  assert.deepEqual(await consumers(page), c0, 'an active workout is invisible to quests, achievements, Daily Score, stats, search and PRs');
  assert.equal(await untouchable(page), u0, 'Start: no Character XP, no quest, no achievement, no Daily Score change');
  const x0 = await page.evaluate(() => ({ xp: S.totalXp, str: S.attrs.STR, vit: S.attrs.VIT, log: S.xpLog.length }));
  const fin = await page.evaluate(wid => JSON.parse(JSON.stringify(workoutFinish(wid))), wid);
  assert.equal(fin.ok, true); assert.equal(fin.granted, true);
  const x1 = await page.evaluate(wid => ({ xp: S.totalXp, str: S.attrs.STR, vit: S.attrs.VIT, log: S.xpLog.length, wk: S.xpLog.filter(e => e.key === `workout:${wid}:${todayStr()}`),
    ach: S.achievementsUnlocked.includes('first_workout') }), wid);
  assert.equal(x1.wk.length, 1); assert.equal(x1.wk[0].amount, 80); assert.equal(x1.wk[0].reason, 'Workout: Push A');
  assert.equal(x1.ach, true, 'Finish runs the normal achievement check: Beast Mode (first workout) unlocks now');
  assert.equal(x1.xp - x0.xp, 80 + 20, '80 workout XP + 20 from the Beast Mode achievement');
  // balancing: the workout's 48 attribute points follow the fitness profile (STR 24, VIT 14, DEX 10); no flat +20 VIT any more
  assert.equal(x1.vit - x0.vit, 14); assert.equal(x1.str - x0.str, 24);
  const w = (await stateOf(page)).workouts.find(z => z.id === wid);
  assert.equal(w.status, 'done'); assert.ok(w.finishedAt >= w.startedAt); assert.equal(w.duration, '1');
  await page.evaluate(() => { checkQuests(); checkAchievements(); });
  const c1 = await consumers(page);
  assert.deepEqual([c1.completed, c1.ds, c1.dsWorkouts, c1.dq_workout, c1.wq, c1.ach, c1.achProg, c1.stats, c1.searchN], [1, 100, 1, true, 1, true, 10, 1, 1], 'after Finish it counts everywhere');
  // exactly once: a second Finish (or a replay of the ledger key) pays nothing
  const x1b = await page.evaluate(() => ({ xp: S.totalXp, vit: S.attrs.VIT })); // after the quest check (quest rewards have their own attributes)
  const x2 = await page.evaluate(wid => { const r = workoutFinish(wid); const g = grantXp(80, 'Workout: Push A', 'STR', `workout:${wid}:${todayStr()}`); return { r, g, xp: S.totalXp, vit: S.attrs.VIT }; }, wid);
  assert.deepEqual(x2.r, { ok: false }); assert.ok(!x2.g);
  assert.deepEqual([x2.xp, x2.vit], [x1b.xp, x1b.vit], 'a second Finish pays nothing');
  // quest XP comes from the (unchanged) quest rules, not from Finish itself
  assert.ok(await page.evaluate(() => S.quests.some(q => q.questId === 'dq_workout')));
}, { state: noWorkoutState() });

test('11A active: Finish pays exactly what the Log Workout form pays (same XP and attributes; polish pass: no skill bonus)', async ({ page }) => {
  const tid = await setupTpl(page);
  await quietQuests(page);
  const delta = async fn => page.evaluate(async fn => {
    const b = { xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT };
    await (new Function('tid', fn))(window.__tid);
    return { xp: S.totalXp - b.xp, STR: S.attrs.STR - b.STR, VIT: S.attrs.VIT - b.VIT };
  }, fn);
  // first_workout is pre-unlocked so neither path also pays the one-off achievement XP
  await page.evaluate(tid => { window.__tid = tid; S.achievementsUnlocked.push('first_workout'); }, tid);
  // polish pass 3: both paths need real content (one finished working set / one logged exercise with sets)
  const viaFinish = await delta('const w = workoutStart({ templateId: tid }).workout; const en = w.entries[0]; workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true }); workoutFinish(w.id);');
  await page.evaluate(() => { closeSheets(); view = 'fitness'; fitnessTab = 'workouts'; render(); });
  const b = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT }));
  await page.click('#addW'); await page.fill('#w_name', 'Legacy log'); await page.fill('.ex-edit .exn', 'Bench'); await page.fill('.ex-edit .exs', '3'); await page.fill('.ex-edit .exr', '5'); await page.click('#w_save');
  const a = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT }));
  const viaForm = { xp: a.xp - b.xp, STR: a.STR - b.STR, VIT: a.VIT - b.VIT };
  assert.deepEqual(viaFinish, viaForm);
  assert.deepEqual([viaFinish.xp, viaFinish.STR, viaFinish.VIT], [80, 24, 14], '80 Character XP; STR 24 + VIT 14 from the fitness profile (balancing: no flat +20 VIT)');
}, { state: noWorkoutState() });

test('11A active: an active workout survives reload and is resumed (same id, same values); discard removes it without any reward', async ({ page }) => {
  const tid = await setupTpl(page);
  const wid = await page.evaluate(tid => {
    const w = workoutStart({ templateId: tid }).workout; const en = w.entries[1];
    workoutUpdateSet(w.id, en.id, en.sets[0].id, { reps: 12, done: true }); workoutAddSet(w.id, en.id, { warmup: true });
    workoutAddEntry(w.id, exerciseFind('Deadlift').id); return w.id;
  }, tid);
  const before = (await stateOf(page)).workouts.find(w => w.id === wid);
  await persist(page); await reload(page);
  const r = await page.evaluate(() => { const a = activeWorkout(); const again = workoutStart({}); return JSON.parse(JSON.stringify({ a, again: again.workout.id, n: S.workouts.filter(w => w.status === 'active').length })); });
  assert.deepEqual(r.a, before, 'identical after reload');
  assert.equal(r.again, wid); assert.equal(r.n, 1);
  assert.deepEqual(r.a.entries.map(en => en.name), ['Bench press', 'Pull-up', 'Plank', 'Deadlift']);
  assert.deepEqual(r.a.entries[1].sets.map(s => [s.reps, s.done, s.warmup]), [[12, true, false], [6, false, false], [6, false, true]]);
  const u0 = await untouchable(page);
  assert.equal(await page.evaluate(wid => workoutDiscard(wid), wid), true);
  assert.equal(await page.evaluate(() => activeWorkout()), null);
  assert.equal(await untouchable(page), u0);
  assert.equal(await page.evaluate(() => workoutDiscard('w1')), false, 'a done workout is never discarded this way');
}, { state: fixtureState() });

test('11A active: volume/sets/reps of new workouts count only done working sets; legacy workouts unchanged; set edits are typed', async ({ page }) => {
  const tid = await setupTpl(page);
  const r = await page.evaluate(tid => {
    const w = workoutStart({ templateId: tid }).workout; const [b, p, pl] = w.entries;
    workoutUpdateSet(w.id, b.id, b.sets[0].id, { done: true, weight: '80', reps: '8' });
    workoutUpdateSet(w.id, b.id, b.sets[1].id, { done: false, weight: 80, reps: 8 });                // not done
    const wu = workoutAddSet(w.id, b.id, { warmup: true, done: true, weight: 40, reps: 10 });      // warm-up
    workoutUpdateSet(w.id, p.id, p.sets[0].id, { done: true, reps: 10 }); workoutUpdateSet(w.id, p.id, p.sets[1].id, { done: true, reps: 'x' });
    workoutUpdateSet(w.id, pl.id, pl.sets[0].id, { done: true, seconds: 75 });
    const st = b.sets[0];
    return { vol: workoutVolume(w), sets: workoutTotalSets(w), reps: workoutTotalReps(w), types: [typeof st.weight, typeof st.reps, p.sets[1].reps], wu: wu.warmup,
      legacy: S.workouts.filter(x => !x.entries).map(x => [workoutVolume(x), workoutTotalSets(x), workoutTotalReps(x)]) };
  }, tid);
  assert.deepEqual(r, { vol: 640, sets: 4, reps: 18, types: ['number', 'number', null], wu: true, legacy: [[3910, 7, 62], [2100, 3, 15]] });
}, { state: fixtureState() });

test('11A active: the Fitness page lists only finished workouts; export/import keeps an active workout; old backups count as done', async ({ page }) => {
  const tid = await setupTpl(page);
  await page.evaluate(tid => workoutStart({ templateId: tid }), tid);
  await page.evaluate(() => { fitnessTab = 'workouts'; view = 'fitness'; render(); });
  const hist = await page.locator('#wList').innerText();
  assert.ok(!/Push A/.test(hist), 'the active workout is not in the history list');
  assert.match(hist, /Pull day/);
  assert.match(await page.locator('#wkResume').innerText(), /Push A/, 'it is shown separately as the workout in progress');
  await page.evaluate(() => { view = 'home'; render(); });
  assert.ok(!/Naposledy: Push A|Last: Push A/.test(await appText(page)), 'Home "last workout" ignores it');
  await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  const wk = (await stateOf(page)).workouts;
  await page.evaluate(() => { S.workouts = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.workouts.length === 3);
  assert.deepEqual((await stateOf(page)).workouts, wk);
  assert.equal(await page.evaluate(() => activeWorkout().name), 'Push A');
  const old = fixtureState();
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.workouts.length === 2);
  assert.deepEqual(await page.evaluate(() => [completedWorkouts(S).length, activeWorkout(), S.workouts.some(w => 'status' in w)]), [2, null, false]);
}, { state: fixtureState() });

// ---------- Phase 11A step 4: active workout UI ----------
const openWorkouts = page => page.evaluate(() => { closeSheets(); uiWorkoutView = null; fitnessTab = 'workouts'; view = 'fitness'; render(); });
const active = page => page.evaluate(() => { const a = activeWorkout(); return a ? JSON.parse(JSON.stringify(a)) : null; });
const entryCard = (page, name) => page.locator('.wk-entry', { has: page.locator('.item-title', { hasText: name }) });
const setRow = (page, name, i) => entryCard(page, name).locator('.ws-list .ws-row').nth(i);

test('11A UI: Start from a template (Fitness and Templates tab) opens the live screen with plan, last and set rows; no XP at Start', async ({ page }) => {
  await setupTpl(page);
  const u0 = await untouchable(page);
  await openWorkouts(page);
  assert.equal(await page.locator('#wkStartCard').count(), 1);
  await page.click('[data-start-tpl] .wkStartTpl');
  assert.equal(await page.locator('#wkLive').count(), 1, 'live screen');
  const w = await active(page);
  assert.equal(w.name, 'Push A');
  assert.equal(await page.locator('.wk-entry').count(), 3);
  const bench = await entryCard(page, 'Bench press').innerText();
  assert.match(bench, /PLÁN\s*2 × 8–10 @ 70 kg/i);
  assert.match(bench, /MINULE\s*80 kg × 8, 8, 8, 8/i, 'last performance from the legacy history');
  assert.equal(await entryCard(page, 'Plank').locator('.ws-head').innerText().then(t => /S/.test(t) && !/KG/.test(t)), true, 'time exercise: seconds column, no kg');
  assert.equal(await entryCard(page, 'Pull-up').locator('[data-f="weight"]').count(), 0, 'reps exercise: no kg input');
  assert.equal(await untouchable(page), u0, 'no XP / quest / achievement / Daily Score change at Start');
  // back to the list: the resume card replaces the start panel; the Templates-tab Start resumes, never duplicates
  await page.click('#wkBack');
  assert.equal(await page.locator('#wkResume').count(), 1);
  assert.equal(await page.locator('#wkStartCard').count(), 0);
  await page.click('#fitTabs [data-k="templates"]');
  await page.click('.tpl-card .tplStart');
  assert.equal(await page.locator('#wkLive').count(), 1);
  assert.equal(await page.evaluate(() => S.workouts.filter(w => w.status === 'active').length), 1, 'no duplicate');
  await page.evaluate(() => { uiWorkoutView = null; view = 'home'; render(); });
  assert.match(await appText(page), /Rozpracovaný trénink: Push A/);
}, { state: classicState() });

test('11A UI: blank workout - add exercises from library and catalog, fill/complete sets, warm-up, add and remove sets', async ({ page }) => {
  await openWorkouts(page);
  await page.click('#wkBlank');
  let w = await active(page);
  assert.deepEqual([w.name, w.entries.length, w.templateId], ['Trénink', 0, '']);
  assert.match(await page.locator('#wkEntries').innerText(), /Zatím žádné cviky/);
  await page.click('#wkAddEx');
  await page.click('[data-pick-preset="Pull-up"]');                       // catalog -> library + entry
  await page.click('#wkAddEx');
  await page.click(`[data-pick="${await page.evaluate(() => exerciseFind('Deadlift').id)}"]`);
  w = await active(page);
  assert.deepEqual(w.entries.map(en => [en.name, en.measurement, en.sets.length, en.target]), [['Pull-up', 'reps', 1, null], ['Deadlift', 'weight_reps', 1, null]]);
  assert.equal(await page.evaluate(() => exerciseFind('Pull-up').source), 'preset');
  // placeholders come from the last Deadlift (140 x 5) because there is no plan
  const dl0 = setRow(page, 'Deadlift', 0);
  assert.equal(await dl0.locator('[data-f="weight"]').getAttribute('placeholder'), '140');
  // fill a set
  await dl0.locator('[data-f="weight"]').fill('150'); await dl0.locator('[data-f="reps"]').fill('3');
  w = await active(page);
  assert.deepEqual([w.entries[1].sets[0].weight, w.entries[1].sets[0].reps, w.entries[1].sets[0].done], [150, 3, false], 'typed numbers are stored as you type');
  await dl0.locator('.ws-done').click();
  assert.equal(await setRow(page, 'Deadlift', 0).getAttribute('class').then(c => c.includes('is-done')), true);
  assert.equal(await page.locator('#wkProg').innerText(), '1/2');
  // add a set (copies the previous values), tick an untouched set -> placeholders adopted
  await entryCard(page, 'Deadlift').locator('.wkAddSet').click();
  assert.equal(await setRow(page, 'Deadlift', 1).locator('[data-f="weight"]').inputValue(), '150');
  await entryCard(page, 'Pull-up').locator('.ws-done').first().click();
  w = await active(page);
  assert.deepEqual([w.entries[0].sets[0].reps, w.entries[0].sets[0].done], [null, true], 'no plan and no history -> nothing invented');
  // warm-up: + Rozcvička goes first and is labelled R; the number badge toggles it
  await entryCard(page, 'Deadlift').locator('.wkAddWu').click();
  assert.equal(await setRow(page, 'Deadlift', 0).locator('.ws-num').innerText(), 'R');
  await setRow(page, 'Deadlift', 0).locator('[data-f="weight"]').fill('60'); await setRow(page, 'Deadlift', 0).locator('[data-f="reps"]').fill('5');
  await setRow(page, 'Deadlift', 0).locator('.ws-done').click();
  w = await active(page);
  assert.deepEqual(w.entries[1].sets.map(s => [s.warmup, s.weight, s.reps, s.done]), [[true, 60, 5, true], [false, 150, 3, true], [false, 150, 3, false]]);
  assert.equal(await page.evaluate(() => workoutVolume(activeWorkout())), 450, 'warm-up and unfinished sets excluded');
  await setRow(page, 'Deadlift', 2).locator('.ws-num').click();
  assert.equal((await active(page)).entries[1].sets[2].warmup, true, 'badge toggles warm-up');
  await setRow(page, 'Deadlift', 2).locator('.ws-num').click();
  // remove a set, remove an exercise (with confirmation)
  await setRow(page, 'Deadlift', 2).locator('.ws-rm').click();
  assert.equal((await active(page)).entries[1].sets.length, 2);
  await entryCard(page, 'Pull-up').locator('.wkRmEx').click(); await page.click('#cf_ok');
  assert.deepEqual((await active(page)).entries.map(en => en.name), ['Deadlift']);
}, { state: fixtureState() });

test('11A UI: reload keeps the active workout (values, done, warm-up, plan) and Continue resumes it without a duplicate', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('[data-f="weight"]').fill('72.5');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await entryCard(page, 'Bench press').locator('.wkAddWu').click();
  await page.fill('#wk_notes', 'heavy day');
  const before = await active(page);
  await persist(page); await reload(page);
  assert.deepEqual(await active(page), before);
  await openWorkouts(page);
  await page.click('#wkContinue');
  assert.equal(await page.locator('#wkLive').count(), 1);
  assert.equal(await setRow(page, 'Bench press', 0).locator('.ws-num').innerText(), 'R');
  assert.equal(await setRow(page, 'Bench press', 1).locator('[data-f="weight"]').inputValue(), '72.5');
  assert.equal(await setRow(page, 'Bench press', 1).getAttribute('class').then(c => c.includes('is-done')), true);
  assert.match(await entryCard(page, 'Bench press').innerText(), /PLÁN\s*2 × 8–10 @ 70 kg/i);
  assert.equal(await page.inputValue('#wk_notes'), 'heavy day');
  assert.equal(await page.evaluate(() => S.workouts.length), 3, 'no duplicate');
}, { state: fixtureState() });

test('11A UI: Finish -> done + summary; XP only once; history shows it and opens the entries editor (legacy workouts keep the old form)', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await setRow(page, 'Bench press', 1).locator('.ws-done').click();
  const wid = (await active(page)).id;
  await quietQuests(page);
  const x0 = await page.evaluate(() => S.totalXp);
  await page.click('#wkFinish');
  assert.equal(await page.locator('#wkSummary').count(), 1, 'summary shown');
  const sum = await page.locator('#wkSummary').innerText();
  assert.match(sum, /Trénink dokončen/); assert.match(sum, /\+80 Character XP/); assert.match(sum, /1\s*120\s*kg/, 'volume 2 x 8 x 70');
  assert.equal(await page.locator('#wkSummary [data-slot="performance"]').count(), 1, 'slot for Performance (later step)');
  const w = (await stateOf(page)).workouts.find(x => x.id === wid);
  assert.deepEqual([w.status, typeof w.finishedAt, w.duration], ['done', 'number', '1']);
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 80);
  // a second Finish (double tap / stale button) pays nothing
  await page.evaluate(wid => uiFinishWorkout(workoutFindById(wid)), wid);
  assert.equal(await page.evaluate(() => S.xpLog.filter(e => e.key && e.key.startsWith('workout:')).length), 1);
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 80);
  await page.click('#wkSumOk');
  // history + editor
  const card = page.locator('.workout-card', { hasText: 'Push A' });
  assert.match(await card.innerText(), /Bench press\s*2× · 70 kg × 8, 8/);
  await card.locator('.editBtn').click();
  assert.equal(await page.locator('.wk-edit-head').count(), 1, 'entries editor');
  assert.equal(await page.locator('#wkFinish').count() + await page.locator('#wkDiscard').count(), 0);
  await setRow(page, 'Bench press', 1).locator('[data-f="reps"]').fill('10');
  await page.fill('#wk_dur', '55');
  await page.click('#wkSaveBack');
  const w2 = (await stateOf(page)).workouts.find(x => x.id === wid);
  assert.deepEqual([w2.entries[0].sets[1].reps, w2.duration, w2.status], [10, '55', 'done']);
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 80, 'editing never re-grants XP');
  await page.locator('.workout-card', { hasText: 'Pull day' }).locator('.editBtn').click();
  assert.equal(await page.locator('#w_name').inputValue(), 'Pull day', 'legacy workout opens the legacy form');
}, { state: fixtureState() });

test('11A UI: Finish with no completed working set asks first - Cancel keeps it active, Dokončit finishes it (polish pass 3: without XP)', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await entryCard(page, 'Bench press').locator('.wkAddWu').click();
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();            // a done warm-up is not a working set
  const u0 = await untouchable(page);
  await page.click('#wkFinishTop');
  assert.match(await page.locator('.cf-sheet').innerText(), /Tento trénink nemá žádnou dokončenou sérii\. Opravdu ho chceš dokončit\?/);
  assert.equal(await page.locator('#cf_cancel').innerText(), 'Zrušit');
  assert.equal(await page.locator('#cf_ok').innerText(), 'Dokončit');
  await page.click('#cf_cancel');
  assert.equal((await active(page)).status, 'active');
  assert.equal(await untouchable(page), u0, 'Cancel changes nothing');
  assert.equal(await page.locator('#wkLive').count(), 1, 'still on the live screen');
  await quietQuests(page);
  const x0 = await page.evaluate(() => S.totalXp);
  await page.click('#wkFinish'); await page.click('#cf_ok');
  assert.equal(await active(page), null);
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 0, 'polish pass 3: a workout without a finished working set pays no XP');
  assert.equal(await page.locator('#wkSummary').count(), 1);
}, { state: fixtureState() });

test('11A UI: Discard (with confirmation) removes only the active workout - no XP, achievements, Daily Score, stats or new records', async ({ page }) => {
  await setupTpl(page);
  const snap = () => page.evaluate(() => JSON.stringify([completedWorkouts(S), computeStats('all').fitness, S.plannerBlocks, S.workoutTemplates, S.quests]));
  const [u0, s0] = [await untouchable(page), await snap()];
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await page.click('#wkDiscard');
  assert.match(await page.locator('.cf-sheet').innerText(), /Zahodit rozpracovaný trénink/);
  await page.click('#cf_cancel');
  assert.notEqual(await active(page), null, 'cancel keeps it');
  await page.click('#wkDiscard'); await page.click('#cf_ok');
  assert.equal(await active(page), null);
  assert.equal(await page.locator('#wkStartCard').count(), 1, 'back to the start panel');
  assert.equal(await untouchable(page), u0);
  assert.equal(await snap(), s0);
  assert.equal(await page.evaluate(() => S.workouts.length), 2);
}, { state: fixtureState() });

test('11A UI: start panel, live screen, editor and its sheets fit 320-1440 px; no duplicate ids; buttons >= 36 px', async ({ page }) => {
  await setupTpl(page);
  await page.evaluate(() => {
    const w = workoutStart({ templateId: S.workoutTemplates[0].id }).workout; workoutAddEntry(w.id, exerciseFind('Deadlift').id);
    exerciseAddPreset('Running'); workoutAddEntry(w.id, exerciseFind('Running').id);
    workoutAddSet(w.id, w.entries[0].id, { warmup: true }); workoutUpdateSet(w.id, w.entries[0].id, w.entries[0].sets[0].id, { done: true, weight: 102.5, reps: 12 });
    workoutFinish(w.id); workoutStart({ templateId: S.workoutTemplates[0].id });
  });
  const screens = ['start', 'resume', 'live', 'edit', 'confirm', 'add', 'summary'];

  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of screens) {
      await page.evaluate(k => {
        closeSheets(); if (!activeWorkout()) workoutStart({ templateId: S.workoutTemplates[0].id });
        ({ start: () => { uiWorkoutView = null; S.workouts = S.workouts.filter(w => w.status !== 'active'); }, resume: () => { uiWorkoutView = null; }, live: () => { uiWorkoutView = { mode: 'active' }; },
          edit: () => { uiWorkoutView = { mode: 'edit', id: completedWorkouts(S).find(w => w.entries).id }; }, confirm: () => { uiWorkoutView = { mode: 'active' }; },
          add: () => { uiWorkoutView = { mode: 'active' }; }, summary: () => { uiWorkoutView = null; } })[k]();
        fitnessTab = 'workouts'; view = 'fitness'; render();
        if (k === 'confirm') uiConfirmSheet({ title: 'x', text: uiWkT('empty_q'), ok: uiWkT('finish_sm') }, () => {});
        if (k === 'add') openWorkoutAddExercise(activeWorkout());
        if (k === 'summary') openWorkoutSummary(completedWorkouts(S).find(w => w.entries), true);
      }, k);
      const r = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id); const sheet = document.querySelector('.sheet');
        const small = [...document.querySelectorAll('#app button, .sheet button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 36).map(b => b.className || b.textContent);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i), small };
      });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length || r.small.length) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('11A UI: export/import keeps the active workout and it can be continued and finished afterwards', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  const wk = await active(page);
  await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  await page.evaluate(() => { S.workouts = S.workouts.filter(w => w.status !== 'active'); });
  await importFile(page, file);
  await page.waitForFunction(() => !!activeWorkout());
  assert.deepEqual(await active(page), wk);
  await openWorkouts(page);
  await page.click('#wkContinue');
  await quietQuests(page);
  const x0 = await page.evaluate(() => S.totalXp);
  await page.click('#wkFinish');
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 80);
  assert.equal(await page.evaluate(id => workoutFindById(id).status, wk.id), 'done');
}, { state: fixtureState() });

// ---------- Phase 11A step 5: PR engine + history ----------
// Builders for finished new-model workouts. f = finishedAt offset in hours relative to NOW.
const PRL = [['xb', 'Bench press', 'weight_reps'], ['xp', 'Pull-up', 'reps'], ['xk', 'Plank', 'time'], ['xr', 'Running', 'distance_time']]
  .map(([id, name, measurement]) => ({ id, name, measurement, muscles: {}, increment: 2.5, notes: '', archived: false, source: 'user', aliases: [], createdAt: NOW, updatedAt: NOW }));
const PW = (id, date, h, entries) => ({ id, name: id, date, status: 'done', startedAt: NOW + (h - 1) * 3600e3, finishedAt: NOW + h * 3600e3, duration: '60', notes: '', exercises: [], entries, createdAt: NOW + h * 3600e3 });
const PE = (exerciseId, sets, measurement = PRL.find(x => x.id === exerciseId)?.measurement || 'weight_reps', name = PRL.find(x => x.id === exerciseId)?.name || exerciseId) =>
  ({ id: 'en_' + Math.random().toString(36).slice(2, 8), exerciseId, name, measurement, target: null, notes: '',
    sets: sets.map(s => ({ id: 'st_' + Math.random().toString(36).slice(2, 8), weight: null, reps: null, seconds: null, distance: null, rpe: null, warmup: false, done: true, ...s })) });
const ws = (w, reps) => ({ weight: w, reps });
// Run: install workouts (+ optional legacy rows / library), return PRs of every workout and the strip.
const prRun = (page, workouts, extra = {}) => page.evaluate(({ workouts, lib, extra }) => {
  S.exerciseLibrary = extra.lib || lib; S.workouts = workouts;
  const idx = exerciseHistoryIndex();
  const strip = t => ({ ...t, exerciseId: undefined, workoutId: t.workoutId, date: undefined, name: t.name, measurement: undefined });
  const per = Object.fromEntries(S.workouts.map(w => [w.id, workoutPRs(w, idx).map(p => { const { exerciseId, name, measurement, date, ...r } = p; return r; })]));
  return { per, strip: exercisePRs().map(p => [p.name, p.type, p.workoutId]) };
}, { workouts, lib: PRL, extra });
const only = (per, id) => per[id].map(({ workoutId, ...r }) => r);

test('11A PR: 120x1 -> 120x2 is a Rep PR; 120x2 -> 130x1 is a Weight PR (and not also a Rep PR); the first performance is never a PR', async ({ page }) => {
  let r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [ws(120, 1)])]), PW('b', '2026-09-03', -40, [PE('xb', [ws(120, 2)])])]);
  assert.deepEqual(only(r.per, 'a'), [], 'first performance');
  assert.deepEqual(only(r.per, 'b'), [{ type: 'reps', weight: 120, reps: 2, prevReps: 1 }]);
  r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [ws(120, 2)])]), PW('b', '2026-09-03', -40, [PE('xb', [ws(130, 1)])])]);
  assert.deepEqual(only(r.per, 'b'), [{ type: 'weight', weight: 130, reps: 1, prevWeight: 120 }]);
  r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [ws(120, 2)])]), PW('b', '2026-09-03', -40, [PE('xb', [ws(120, 2)])])]);
  assert.deepEqual(only(r.per, 'b'), [], 'equal is not a PR');
});

test('11A PR: warm-ups and unfinished sets never make or block a PR; volume alone is never a PR', async ({ page }) => {
  let r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [{ weight: 300, reps: 1, warmup: true }, ws(100, 5), { weight: 200, reps: 5, done: false }])]),
    PW('b', '2026-09-03', -40, [PE('xb', [{ weight: 250, reps: 3, warmup: true }, { weight: 180, reps: 1, done: false }, ws(110, 5)])])]);
  assert.deepEqual(only(r.per, 'b'), [{ type: 'weight', weight: 110, reps: 5, prevWeight: 100 }], 'only working, done sets on both sides');
  r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [ws(100, 5), ws(100, 5), ws(100, 5)])]), PW('b', '2026-09-03', -40, [PE('xb', Array(6).fill(ws(100, 5)))])]);
  assert.deepEqual(only(r.per, 'b'), [], 'twice the volume, same best sets -> no PR');
  r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xb', [ws(60, 8, 0)].map(s => ({ ...s, warmup: true })))]), PW('b', '2026-09-03', -40, [PE('xb', [ws(60, 8)])])]);
  assert.deepEqual(only(r.per, 'b'), [], 'a history of warm-ups only is no history: first working performance');
});

test('11A PR: dominance - lower weight with more reps; several candidates -> only the best Weight PR and the best Rep PR', async ({ page }) => {
  const base = PW('a', '2026-09-01', -50, [PE('xb', [ws(100, 5)])]);
  const run = sets => prRun(page, [base, PW('b', '2026-09-03', -40, [PE('xb', sets)])]).then(r => only(r.per, 'b'));
  assert.deepEqual(await run([ws(90, 8)]), [{ type: 'reps', weight: 90, reps: 8, prevReps: 5 }], '90x8 beats nothing heavier-and-longer');
  assert.deepEqual(await run([ws(90, 5)]), [], '90x5 is dominated by 100x5');
  assert.deepEqual(await run([ws(100, 5)]), []);
  assert.deepEqual(await run([ws(105, 3), ws(110, 2), ws(100, 7), ws(95, 9), ws(90, 4)]),
    [{ type: 'weight', weight: 110, reps: 2, prevWeight: 100 }, { type: 'reps', weight: 100, reps: 7, prevReps: 5 }], 'one of each type, the best one');
});

test('11A PR: reps, time and distance_time measurements', async ({ page }) => {
  let r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xp', [{ reps: 10 }, { reps: 8 }]), PE('xk', [{ seconds: 60 }])]),
    PW('b', '2026-09-03', -40, [PE('xp', [{ reps: 12 }, { reps: 11 }]), PE('xk', [{ seconds: 75 }, { seconds: 30 }])]),
    PW('c', '2026-09-05', -30, [PE('xp', [{ reps: 12 }]), PE('xk', [{ seconds: 70 }])])]);
  assert.deepEqual(only(r.per, 'b'), [{ type: 'reps', reps: 12, prevReps: 10 }, { type: 'time', seconds: 75, prevSeconds: 60 }]);
  assert.deepEqual(only(r.per, 'c'), [], 'equal reps / shorter time');
  r = await prRun(page, [PW('a', '2026-09-01', -50, [PE('xr', [{ distance: 5, seconds: 1800 }])]),
    PW('b', '2026-09-03', -40, [PE('xr', [{ distance: 6, seconds: 2160 }])]),
    PW('c', '2026-09-05', -30, [PE('xr', [{ distance: 5, seconds: 1620 }])]),
    PW('d', '2026-09-07', -20, [PE('xr', [{ distance: 4, seconds: 1700 }])]),
    PW('e', '2026-09-09', -10, [PE('xr', [{ distance: 3 }])])]);
  assert.deepEqual(only(r.per, 'b'), [{ type: 'distance', distance: 6, seconds: 2160, prevDistance: 5 }]);
  assert.deepEqual(only(r.per, 'c'), [{ type: 'pace', distance: 5, seconds: 1620, prevSeconds: 1800 }], '5 km faster than every earlier >= 5 km effort');
  assert.deepEqual(only(r.per, 'd'), [], '4 km in 28:20 is slower than the 5 km in 27:00 -> no pace PR');
  assert.deepEqual(only(r.per, 'e'), [], 'distance without time: no pace, not the longest');
  assert.deepEqual(r.strip.filter(x => x[0] === 'Running'), [['Running', 'pace', 'c'], ['Running', 'distance', 'b']]);
});

test('11A PR: comparison follows when workouts happened (date, then finish time), never their position in the array', async ({ page }) => {
  const a = PW('a', '2026-09-01', -50, [PE('xb', [ws(100, 5)])]), b = PW('b', '2026-09-03', -40, [PE('xb', [ws(110, 5)])]);
  const same1 = PW('s1', '2026-09-05', -30, [PE('xb', [ws(120, 1)])]), same2 = PW('s2', '2026-09-05', -29, [PE('xb', [ws(125, 1)])]);
  const r1 = await prRun(page, [a, b, same1, same2]);
  const r2 = await prRun(page, [same2, b, same1, a]);
  assert.deepEqual(r2.per, r1.per);
  assert.deepEqual(only(r1.per, 'a'), []); assert.equal(only(r1.per, 'b')[0].type, 'weight');
  assert.equal(only(r1.per, 's2')[0].prevWeight, 120, 'same day: the later finish is compared against the earlier one');
});

test('11A history: legacy "4 x 8 @ 80" = four working sets; legacy + new records join; rename keeps history; similar names never merge', async ({ page }) => {
  const legacy = { id: 'L1', name: 'Old', date: '2026-08-01', duration: '60', notes: '', createdAt: NOW - 90 * 864e5,
    exercises: [{ id: 'l1', name: 'Bench press', sets: '4', reps: '8', weight: '80' }, { id: 'l2', name: 'Incline bench press', sets: '3', reps: '5', weight: '200' }, { id: 'l3', name: 'bench  PRESS ', sets: '1', reps: '1', weight: '0' }] };
  const r = await page.evaluate(({ legacy, lib }) => {
    S.exerciseLibrary = lib; S.workouts = [legacy];
    const h = exerciseHistoryBefore('xb', 'Bench press', null);
    return { sets: h.sets, work: h.work, best: h.best, recordUntouched: JSON.stringify(S.workouts[0]) === JSON.stringify(legacy) };
  }, { legacy, lib: PRL });
  assert.deepEqual(r.sets, [...Array(4).fill({ weight: 80, reps: 8, seconds: null, distance: null, rpe: null }), { weight: 0, reps: 1, seconds: null, distance: null, rpe: null }], 'exact-name rows (case/space-normalized) only');
  assert.equal(r.work, 2560); assert.deepEqual(r.best, { weight: 80, reps: 8, seconds: null, distance: null, rpe: null });
  assert.equal(r.recordUntouched, true, 'legacy record is not rewritten');
  // new workout vs legacy history: 80 x 9 is a rep PR; the 200 kg "Incline bench press" never counts for Bench press
  let p = await prRun(page, [legacy, PW('n1', '2026-09-01', -50, [PE('xb', [ws(80, 9), ws(150, 1)])])]);
  assert.deepEqual(only(p.per, 'n1'), [{ type: 'weight', weight: 150, reps: 1, prevWeight: 80 }, { type: 'reps', weight: 80, reps: 9, prevReps: 8 }]);
  // rename: legacy history stays attached through the alias, and a NEW exercise later called "Bench press" does not steal it
  const after = await page.evaluate(() => {
    exerciseSave({ name: 'Barbell bench', measurement: 'weight_reps', muscles: {} }, 'xb');
    const nb = exerciseSave({ name: 'Bench press', measurement: 'weight_reps', muscles: {} }).exercise;
    const idx = exerciseHistoryIndex();
    return { aliases: exerciseFind('xb').aliases, xb: idx.get('xb').sessions.map(s => s.workoutId), nb: idx.get(nb.id).sessions.length,
      last: exerciseLastPerformance('xb', 'Barbell bench', null).workoutId, incline: [...idx.values()].find(g => g.name === 'Incline bench press').sessions.length };
  });
  assert.deepEqual(after, { aliases: ['bench press'], xb: ['L1', 'n1'], nb: 0, last: 'n1', incline: 1 });
}, { state: fixtureState() });

test('11A PR: result.prs is a snapshot; editing and deleting workouts recompute the current records', async ({ page }) => {
  await page.evaluate(lib => { S.exerciseLibrary = lib; S.workouts = []; }, PRL);
  let tick = 0;
  const fin = async sets => { await page.clock.setFixedTime(NOW + (++tick) * 60e3); return page.evaluate(sets => { const w = workoutStart({}).workout; const en = workoutAddEntry(w.id, 'xb');
    en.sets = sets.map(s => Object.assign(workoutNewSet(null), s, { done: true })); return JSON.parse(JSON.stringify(workoutFinish(w.id).workout)); }, sets); };
  const w1 = await fin([ws(100, 5)]), w2 = await fin([ws(110, 5)]);
  assert.deepEqual(w1.result.prs, []);
  assert.deepEqual(w2.result.prs.map(p => [p.type, p.weight, p.prevWeight]), [['weight', 110, 100]]);
  assert.deepEqual(await page.evaluate(() => exercisePRs().map(p => [p.type, p.weight])), [['weight', 110]]);
  // edit the finished workout: 110 -> 95; the snapshot stays, the current records follow the data
  await page.evaluate(id => { const w = workoutFindById(id); workoutUpdateSet(w.id, w.entries[0].id, w.entries[0].sets[0].id, { weight: 95 }); }, w2.id);
  assert.deepEqual(await page.evaluate(id => workoutFindById(id).result.prs.map(p => [p.type, p.weight]), w2.id), [['weight', 110]], 'snapshot unchanged');
  assert.deepEqual(await page.evaluate(id => workoutPRs(workoutFindById(id)).map(p => p.type), w2.id), [], 'dynamic: 95x5 is no longer a record');
  assert.deepEqual(await page.evaluate(() => exercisePRs()), []);
  // delete: the first workout goes away -> the second becomes the first performance -> no records
  await page.evaluate(id => { const w = workoutFindById(id); workoutUpdateSet(w.id, w.entries[0].id, w.entries[0].sets[0].id, { weight: 110 }); }, w2.id);
  assert.equal(await page.evaluate(() => exercisePRs().length), 1);
  await page.evaluate(id => { S.workouts = S.workouts.filter(w => w.id !== id); }, w1.id);
  assert.deepEqual(await page.evaluate(() => exercisePRs()), [], 'deleting recomputes');
}, { state: fixtureState() });

test('11A UI: Finish with a PR shows it in the summary, in the history card and in the Fitness PR strip; strip survives reload', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('[data-f="weight"]').fill('85');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await setRow(page, 'Bench press', 1).locator('[data-f="weight"]').fill('80'); await setRow(page, 'Bench press', 1).locator('[data-f="reps"]').fill('9');
  await setRow(page, 'Bench press', 1).locator('.ws-done').click();
  await page.click('#wkFinish');
  const sum = await page.locator('#wkSummary [data-slot="prs"]');
  assert.equal(await sum.isVisible(), true);
  assert.match(await sum.innerText(), /Bench press[\s\S]*Váha[\s\S]*85 kg × 8[\s\S]*Bench press[\s\S]*Opakování[\s\S]*80 kg × 9/);
  await page.click('#wkSumOk');
  assert.match(await page.locator('.workout-card', { hasText: 'Push A' }).innerText(), /Bench press · Váha/); // polish pass: the trophy is a line icon now
  const strip = async () => page.locator('#prList').innerText();
  assert.match(await strip(), /BENCH PRESS[\s\S]*85\s*kg[\s\S]*Váha · × 8/i);
  await persist(page); await reload(page); await openWorkouts(page);
  assert.match(await strip(), /85\s*kg/);
  assert.equal(await page.locator('#prList .pr-card').count(), 2, 'Weight PR + Rep PR of Bench press (legacy single sessions are no records)');
}, { state: fixtureState() });

test('11A PR data: export/import keeps result.prs and the same records; an old backup derives records from legacy history only', async ({ page }) => {
  await page.evaluate(lib => { S.exerciseLibrary = lib; S.workouts = []; }, PRL);
  for (const [i, wt] of [100, 105].entries()) {
    await page.clock.setFixedTime(NOW + (i + 1) * 60e3);
    await page.evaluate(w => { const a = workoutStart({}).workout; const en = workoutAddEntry(a.id, 'xb'); en.sets = [Object.assign(workoutNewSet(null), { weight: w, reps: 5, done: true })]; workoutFinish(a.id); }, wt);
  }
  assert.deepEqual(await page.evaluate(() => S.workouts.map(w => (w.result.prs || []).map(p => p.weight))), [[], [105]]);
  const before = await page.evaluate(() => JSON.stringify([exercisePRs(), S.workouts.map(w => w.result)]));
  await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  await page.evaluate(() => { S.workouts = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.workouts.length === 2);
  assert.equal(await page.evaluate(() => JSON.stringify([exercisePRs(), S.workouts.map(w => w.result)])), before);
  const old = fixtureState();
  old.workouts.push({ id: 'w0', name: 'Older push', date: '2026-09-10', duration: '50', notes: '', createdAt: NOW - 13 * 864e5, exercises: [{ id: 'ex0', name: 'Bench press', sets: '3', reps: '8', weight: '75', muscle: '', rpe: '', rest: '' }] });
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.workouts.length === 3);
  assert.deepEqual(await page.evaluate(() => exercisePRs().map(p => [p.name, p.type, p.weight, p.prevWeight, p.workoutId])), [['Bench press', 'weight', 80, 75, 'w1']]);
  assert.deepEqual(await page.evaluate(() => [S.workouts.some(w => 'result' in w || 'status' in w), computeStats('all').fitness.prs.length]), [false, 1], 'old records untouched; Statistics counts the same records');
}, { state: fixtureState() });

test('11A UI: PR strip, summary with PRs and history cards fit 320-1440 px', async ({ page }) => {
  await page.evaluate(lib => { S.exerciseLibrary = lib; }, PRL);
  for (const [i, v] of [[100, 5, 5, 1800], [112.5, 8, 10.5, 3000]].entries()) {
    await page.clock.setFixedTime(NOW + (i + 1) * 60e3);
    await page.evaluate(([w, r, d, sec]) => {
      const a = workoutStart({ name: 'A long workout name for a narrow phone screen' }).workout;
      for (const [id, st] of [['xb', { weight: w, reps: r }], ['xp', { reps: r + 7 }], ['xk', { seconds: sec / 10 }], ['xr', { distance: d, seconds: sec }]]) {
        const en = workoutAddEntry(a.id, id); en.sets = [Object.assign(workoutNewSet(null), st, { done: true })];
      }
      workoutFinish(a.id);
    }, v);
  }
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const sheet of [false, true]) {
      await page.evaluate(sh => { closeSheets(); uiWorkoutView = null; fitnessTab = 'workouts'; view = 'fitness'; render(); if (sh) openWorkoutSummary(completedWorkouts(S).find(w => (w.result?.prs || []).length), true); }, sheet);
      const r = await page.evaluate(() => { const s = document.querySelector('.sheet'); return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0 }; });
      if (r.over > 0 || r.sheetOver > 0) bad.push(`${sheet ? 'summary' : 'page'}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.equal(await page.locator('#prList .pr-card').count(), 4, 'bench weight, pull-up reps, plank time, running distance');
}, { state: fixtureState() });

// ---------- Phase 11A step 6: progressive overload suggestions ----------
// sugRun: history = earlier finished workouts (PW/PE builders), then an active workout whose entry
// has the given target (template copy) and nWork working sets; returns exerciseSuggestion().
const sugRun = (page, { history = [], exerciseId = 'xb', target = null, nWork = 3, inc } = {}) => page.evaluate(({ history, lib, exerciseId, target, nWork, inc }) => {
  S.exerciseLibrary = JSON.parse(JSON.stringify(lib)); if (inc != null) S.exerciseLibrary.find(x => x.id === exerciseId).increment = inc;
  S.workouts = history;
  const w = workoutStart({}).workout; const en = workoutAddEntry(w.id, exerciseId);
  en.target = target; en.sets = Array.from({ length: nWork }, () => workoutNewSet(target));
  const s = exerciseSuggestion(en, w);
  return s && { kind: s.kind, sets: s.sets, weight: s.weight, text: uiSuggestionText(s) };
}, { history, lib: PRL, exerciseId, target, nWork, inc });
const T810 = { sets: 3, repsMin: 8, repsMax: 10, weight: 70, seconds: null, distance: null, rest: null };
const SH = (sets, eid = 'xb') => [PW('h1', '2026-09-10', -300, [PE(eid, sets)])];
const S3 = (w, ...reps) => reps.map(r => ({ weight: w, reps: r }));

test('11A overload: all sets at the top of the range -> +step kg at the bottom of the range', async ({ page }) => {
  const r = await sugRun(page, { history: SH(S3(70, 10, 10, 10)), target: T810 });
  assert.deepEqual([r.kind, r.weight, r.sets], ['increase', 72.5, Array(3).fill({ weight: 72.5, reps: 8 })]);
  assert.equal(r.text.main, '↑ 72,5 kg × 8');
  const r2 = await sugRun(page, { history: SH(S3(100, 10, 10, 10)), target: T810, inc: 5 });
  assert.deepEqual([r2.kind, r2.weight], ['increase', 105], "uses the exercise's own progression step");
}, { state: fixtureState() });

test('11A overload: one set below the top -> same weight, +1 rep on the weakest set, never above the top', async ({ page }) => {
  let r = await sugRun(page, { history: SH(S3(70, 10, 9, 8)), target: T810 });
  assert.deepEqual([r.kind, r.sets.map(s => [s.weight, s.reps])], ['reps', [[70, 10], [70, 9], [70, 9]]]);
  assert.equal(r.text.main, '70 kg × 10, 9, 9');
  r = await sugRun(page, { history: SH(S3(70, 10, 10, 9)), target: T810 });
  assert.deepEqual(r.sets.map(s => s.reps), [10, 10, 10], 'capped at repsMax');
  r = await sugRun(page, { history: SH([...S3(70, 10, 10), { weight: 60, reps: 6 }]), target: T810 });
  assert.deepEqual([r.kind, r.sets.map(s => [s.weight, s.reps])], ['increase', [[72.5, 8], [72.5, 8], [72.5, 8]]], 'judged on the sets at the top weight (a lighter back-off set does not block)');
}, { state: fixtureState() });

test('11A overload: every set below the range -> repeat the weight, neutral wording', async ({ page }) => {
  const r = await sugRun(page, { history: SH(S3(70, 7, 6, 6)), target: T810 });
  assert.deepEqual([r.kind, r.sets.map(s => [s.weight, s.reps])], ['below', [[70, 7], [70, 6], [70, 6]]]);
  assert.equal(r.text.note, 'Zkus příště zopakovat 70 kg a postupně se vrátit k cílovému rozsahu.');
  assert.ok(!/selhal|špatn|fail/i.test(r.text.main + r.text.note));
}, { state: fixtureState() });

test('11A overload: historical RPE >= 9.5 holds weight and reps; no RPE (or lower) gives the normal suggestion', async ({ page }) => {
  let r = await sugRun(page, { history: SH([{ weight: 70, reps: 10 }, { weight: 70, reps: 10, rpe: 9.5 }, { weight: 70, reps: 10 }]), target: T810 });
  assert.deepEqual([r.kind, r.sets.map(s => [s.weight, s.reps])], ['hold', [[70, 10], [70, 10], [70, 10]]], 'no weight increase');
  r = await sugRun(page, { history: SH([{ weight: 70, reps: 10, rpe: 9 }, ...S3(70, 10, 10)]), target: T810 });
  assert.equal(r.kind, 'increase');
  r = await sugRun(page, { history: SH(S3(70, 10, 10, 10)), target: T810 });
  assert.equal(r.kind, 'increase', 'RPE missing -> normal');
  r = await sugRun(page, { history: SH([{ weight: 70, reps: 9, rpe: 10 }, ...S3(70, 9, 8)]) });
  assert.equal(r.kind, 'hold', 'also without a template');
  // a legacy row's RPE (fixture Bench press: 4 x 8 @ 80, RPE 8) is read but below the threshold
  r = await page.evaluate(ws => { S.workouts = ws; const w = workoutStart({}).workout; const en = workoutAddEntry(w.id, exerciseFind('Bench press').id); const s = exerciseSuggestion(en, w); return [s.kind, s.basisWorkoutId]; }, fixtureState().workouts);
  assert.deepEqual(r, ['baseline', 'w1']);
}, { state: fixtureState() });

test('11A overload: reps +1, time +step, distance_time none; without a template a baseline; without history the plan', async ({ page }) => {
  let r = await sugRun(page, { exerciseId: 'xp', history: SH([{ reps: 12 }], 'xp'), nWork: 1, target: { sets: 1, repsMin: 8, repsMax: 12 } });
  assert.deepEqual([r.kind, r.sets, r.text.main], ['reps', [{ reps: 13 }], '↑ 13 opak.'], 'reps: 12 -> 13, no kg, range does not cap a bodyweight exercise');
  r = await sugRun(page, { exerciseId: 'xk', history: SH([{ seconds: 60 }], 'xk'), nWork: 1, inc: 5 });
  assert.deepEqual([r.kind, r.sets, r.text.main], ['time', [{ seconds: 65 }], '↑ 1:05'], '60 s -> 65 s with a 5 s step');
  r = await sugRun(page, { exerciseId: 'xk', history: SH([{ seconds: 60 }], 'xk'), nWork: 1, inc: 15 });
  assert.deepEqual(r.sets, [{ seconds: 75 }]);
  r = await sugRun(page, { exerciseId: 'xr', history: SH([{ distance: 5, seconds: 1500 }], 'xr'), nWork: 1, target: { sets: 1, distance: 5 } });
  assert.equal(r, null, 'distance_time: no suggestion');
  r = await sugRun(page, { history: SH(S3(70, 10, 10, 10)) });
  assert.deepEqual([r.kind, r.sets.map(s => [s.weight, s.reps])], ['baseline', [[70, 11], [70, 10], [70, 10]]], 'no template: same weight +1 rep, never more weight');
  r = await sugRun(page, { target: T810 });
  assert.deepEqual([r.kind, r.sets, r.text.note], ['plan', Array(3).fill({ weight: 70, reps: 8 }), 'Podle plánu — zatím bez historie.']);
  assert.equal(await sugRun(page, {}), null, 'no template, no history -> nothing');
  r = await sugRun(page, { history: [PW('h1', '2026-09-10', -300, [PE('xb', [{ weight: 200, reps: 10, warmup: true }, ...S3(70, 8, 8)])])], target: T810 });
  assert.equal(r.weight, 70, 'warm-ups never enter a suggestion');
}, { state: fixtureState() });

test('11A UI: "Použít doporučení" prefills only this workout; template, history and XP unchanged; survives reload', async ({ page }) => {
  await page.evaluate(lib => { S.exerciseLibrary = lib; }, PRL);
  const tid = await page.evaluate(() => templateSave({ name: 'Push A', exercises: [{ exerciseId: 'xb', sets: 3, repsMin: 8, repsMax: 10, weight: 70 }, { exerciseId: 'xr', sets: 1, distance: 5 }] }).template.id);
  await page.evaluate(() => { const w = workoutStart({ templateId: S.workoutTemplates[0].id }).workout; w.date = '2026-09-22'; w.entries[0].sets.forEach(s => Object.assign(s, { reps: 10, done: true })); w.entries[1].sets[0].done = true; workoutFinish(w.id); });
  const frozen = () => page.evaluate(() => JSON.stringify([S.workoutTemplates, completedWorkouts(S), S.totalXp, S.xpLog, S.attrs, S.rpg, S.achievementsUnlocked, S.quests, dailyScore(todayStr()), exercisePRs()]));
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  const f0 = await frozen();
  const card = entryCard(page, 'Bench press');
  assert.match(await card.locator('[data-slot="suggestion"]').innerText(), /DOPORUČENÍ\s*↑ 72,5 kg × 8/i);
  assert.match(await card.innerText(), /PLÁN\s*3 × 8–10 @ 70 kg[\s\S]*MINULE\s*70 kg × 10, 10, 10/i, 'plan and last stay separate from the suggestion');
  assert.equal(await entryCard(page, 'Running').locator('[data-slot="suggestion"]').isHidden(), true, 'distance_time: nothing shown');
  // one set already done by the user stays as it is
  await setRow(page, 'Bench press', 0).locator('[data-f="reps"]').fill('9'); await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await card.locator('.wkApplySug').click();
  const w = await active(page);
  assert.deepEqual(w.entries[0].sets.map(s => [s.weight, s.reps, s.done]), [[70, 9, true], [72.5, 8, false], [72.5, 8, false]]);
  assert.equal(await entryCard(page, 'Bench press').locator('.wkApplySug').isDisabled(), true);
  assert.match(await entryCard(page, 'Bench press').locator('.wkApplySug').innerText(), /Odpovídá/);
  assert.equal(await frozen(), f0, 'template, finished history, XP/RPG/quests/achievements/Daily Score and PRs unchanged');
  assert.equal(await page.evaluate(id => templateFind(id).exercises[0].weight, tid), 70, 'template weight is still 70');
  await persist(page); await reload(page);
  assert.deepEqual((await active(page)).entries[0].sets.map(s => [s.weight, s.reps, s.done]), [[70, 9, true], [72.5, 8, false], [72.5, 8, false]]);
  // the edit screen of a finished workout never shows a suggestion
  await page.evaluate(() => { uiWorkoutView = { mode: 'edit', id: completedWorkouts(S).find(w => w.entries).id }; view = 'fitness'; render(); });
  assert.equal(await page.locator('.wkApplySug').count(), 0);
}, { state: fixtureState() });

test('11A UI: suggestions fit 320-1440 px (all kinds) without overflow', async ({ page }) => {
  await page.evaluate(lib => {
    S.exerciseLibrary = lib;
    const t = templateSave({ name: 'All', exercises: [{ exerciseId: 'xb', sets: 3, repsMin: 8, repsMax: 10, weight: 102.5 }, { exerciseId: 'xp', sets: 3, repsMin: 8 }, { exerciseId: 'xk', sets: 2, seconds: 90 }] }).template;
    const w = workoutStart({ templateId: t.id }).workout; w.date = '2026-09-20';
    w.entries.forEach(en => en.sets.forEach(s => Object.assign(s, { done: true, reps: s.reps != null ? s.reps + 2 : null })));
    workoutFinish(w.id); workoutStart({ templateId: t.id });
  }, PRL);
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
    const r = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, n: document.querySelectorAll('.wkApplySug').length,
      clipped: [...document.querySelectorAll('.wk-suggestion')].filter(s => s.scrollWidth > s.clientWidth + 1).length }));
    if (r.over > 0 || r.n !== 3 || r.clipped) bad.push(`${width}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 7: Workout Performance + Feeling ----------
// PUSH A from the approved simulation: bench 4x8@70, incline 3x10@26, ohp 3x8@45, lateral 3x12@10.
const PFL = [...PRL, ...[['xi', 'Incline press'], ['xo', 'Overhead press'], ['xl', 'Lateral raise'], ['xd', 'Dips']]
  .map(([id, name]) => ({ id, name, measurement: 'weight_reps', muscles: {}, increment: 2.5, notes: '', archived: false, source: 'user', aliases: [], createdAt: NOW, updatedAt: NOW }))];
const TG = { xb: [4, 8, 70], xi: [3, 10, 26], xo: [3, 8, 45], xl: [3, 12, 10] };
const PT = (eid, sets) => ({ ...PE(eid, sets, 'weight_reps', PFL.find(x => x.id === eid).name), target: TG[eid] ? { sets: TG[eid][0], repsMin: TG[eid][1], repsMax: TG[eid][1], weight: TG[eid][2], seconds: null, distance: null, rest: null } : null });
const rep = (w, ...r) => r.map(x => ({ weight: w, reps: x }));
const PREV_A = () => PW('prev', '2026-09-20', -72, [PT('xb', rep(70, 8, 8, 8, 8)), PT('xi', rep(26, 10, 10, 10)), PT('xo', rep(45, 8, 8, 8)), PT('xl', rep(10, 12, 12, 12))]);
const CUR = (o = {}) => { const m = { xb: rep(70, 8, 8, 8, 8), xi: rep(26, 10, 10, 10), xo: rep(45, 8, 8, 8), xl: rep(10, 12, 12, 12), ...o };
  // w.plan = the template copy taken at Start (so a skipped/removed planned exercise still counts)
  return { ...PW('cur', '2026-09-23', -1, Object.entries(m).filter(([, v]) => v).map(([k, v]) => PT(k, v))), plan: ['xb', 'xi', 'xo', 'xl'].map(k => { const e = PT(k, []); return { exerciseId: k, name: e.name, measurement: 'weight_reps', target: e.target }; }) }; };
const perfRun = (page, workouts) => page.evaluate(({ workouts, lib }) => { S.exerciseLibrary = lib; S.workouts = workouts; return workoutPerformance(S.workouts.find(w => w.id === 'cur')); }, { workouts, lib: PFL });
const sc = p => [p.score, p.parts.plan, p.parts.target, p.parts.prev, p.prBonus];

test('11A performance: the 9 approved scenarios through the real engine (template, work-based comparison, floor 0.2, slope 3)', async ({ page }) => {
  const P = PREV_A;
  assert.deepEqual(sc(await perfRun(page, [CUR()])), [100, 100, 100, null, 0], '1 new, no history: prev N/A, renormalized');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR()])), [96, 100, 100, 85, 0], '2 same as last time');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xb: rep(72.5, 8, 8, 8, 8) })])), [100, 100, 100, 89, 5], '3 slightly better + weight PR');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xb: rep(70, 8, 8, 7, 6) })])), [93, 100, 97, 78, 0], '4 slightly worse (fatigue drop is visible)');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xb: rep(67.5, 8, 8, 8, 8) })])), [95, 100, 99, 82, 0], '4b lower weight');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xb: rep(60, 8, 7, 6, 5), xo: rep(40, 7, 6, 6), xi: rep(22, 10, 8, 8) })])), [76, 100, 78, 36, 0], '5 much worse');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xb: [{ weight: 75, reps: 6 }, ...rep(70, 8, 8, 8)] })])), [100, 100, 98, 81, 5], '6 PR');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xd: rep(0, 10, 10, 10) })])), [96, 100, 100, 85, 0], '8 extra exercise without history does not lower it');
  assert.deepEqual(sc(await perfRun(page, [P(), CUR({ xl: null })])), [87, 77, 100, 85, 0], '9 skipped lateral (10 of 13 planned sets)');
  const labels = await page.evaluate(() => [100, 95, 94, 85, 84, 70, 69, 0].map(performanceLabelKey));
  assert.deepEqual(labels, ['excellent', 'excellent', 'good', 'good', 'fair', 'fair', 'weak', 'weak']);
}, { state: fixtureState() });

test('11A performance: plan and target completion - partial sets, repsMin as the bar, weight target, time, distance_time, N/A factors', async ({ page }) => {
  const one = (eid, target, sets, meas) => PW('cur', '2026-09-23', -1, [{ ...PE(eid, sets, meas), target }]);
  const T = (o) => ({ sets: 3, repsMin: null, repsMax: null, weight: null, seconds: null, distance: null, rest: null, ...o });
  // range 8-10: 8 reps = 100 %, 7 = 87.5 %; weight 65/70 = 92.9 %
  let p = await perfRun(page, [one('xb', T({ repsMin: 8, repsMax: 10, weight: 70 }), [{ weight: 70, reps: 8 }, { weight: 70, reps: 7 }, { weight: 65, reps: 10 }])]);
  assert.deepEqual(sc(p), [97, 100, 93, null, 0], 'target = (1 + 0.875 + 0.9286)/3');
  // partial: 2 of 3 planned sets done (an unfinished and a warm-up set do not count)
  p = await perfRun(page, [one('xb', T({ repsMin: 8, weight: 70 }), [{ weight: 70, reps: 8 }, { weight: 70, reps: 8 }, { weight: 70, reps: 8, done: false }, { weight: 100, reps: 8, warmup: true }])]);
  assert.deepEqual(sc(p), [82, 67, 100, null, 0], '(40 x 0.667 + 35 x 1) / 75');
  // no weight target -> only the reps factor
  p = await perfRun(page, [one('xb', T({ repsMin: 10 }), [{ weight: 20, reps: 10 }, { weight: 20, reps: 5 }, { weight: 20, reps: 10 }])]);
  assert.equal(p.parts.target, 83);
  p = await perfRun(page, [one('xk', T({ seconds: 60 }), [{ seconds: 60 }, { seconds: 45 }, { seconds: 30 }], 'time')]);
  assert.deepEqual(sc(p), [88, 100, 75, null, 0], 'time: min(1, s / 60); (40 + 35 x 0.75) / 75 = 88.3');
  p = await perfRun(page, [one('xr', T({ sets: 1, distance: 5 }), [{ distance: 4, seconds: 1500 }], 'distance_time')]);
  assert.deepEqual(sc(p), [91, 100, 80, null, 0], 'distance_time: min(1, km / 5)');
  p = await perfRun(page, [one('xr', T({ sets: 1, seconds: 1800 }), [{ distance: 4, seconds: 1500 }], 'distance_time')]);
  assert.deepEqual(sc(p), [100, 100, null, null, 0], 'no km target -> target N/A (not faked), plan alone');
  // a planned exercise removed from the workout still counts as planned (w.plan)
  const r = await page.evaluate(lib => { S.exerciseLibrary = lib; S.workouts = [];
    const t = templateSave({ name: 'Two', exercises: [{ exerciseId: 'xb', sets: 2, repsMin: 5, weight: 50 }, { exerciseId: 'xi', sets: 2, repsMin: 5, weight: 20 }] }).template;
    const w = workoutStart({ templateId: t.id }).workout; w.entries[0].sets.forEach(s => s.done = true); workoutRemoveEntry(w.id, w.entries[1].id);
    return [w.plan.length, workoutFinish(w.id).workout.result.performance.parts.plan]; }, PFL);
  assert.deepEqual(r, [2, 50]);
}, { state: fixtureState() });

test('11A performance: compared to previous uses total work / reps / seconds / distance; exercises without history are left out', async ({ page }) => {
  const ch = (m, cur, prev) => page.evaluate(({ m, cur, prev }) => Math.round(performanceChange(m, cur, prev) * 1000) / 1000, { m, cur, prev });
  assert.equal(await ch('weight_reps', rep(70, 8, 8, 7, 6), rep(70, 8, 8, 8, 8)), -0.094, 'work 2030 vs 2240 (a best-set comparison would say 0)');
  assert.equal(await ch('weight_reps', rep(0, 12, 12), rep(0, 10, 10)), 0.2, 'bodyweight logged as 0 kg -> total reps');
  assert.equal(await ch('reps', [{ reps: 10 }, { reps: 9 }], [{ reps: 10 }, { reps: 10 }]), -0.05);
  assert.equal(await ch('time', [{ seconds: 90 }], [{ seconds: 60 }]), 0.5);
  assert.equal(await ch('distance_time', [{ distance: 5, seconds: 1500 }], [{ distance: 5, seconds: 1800 }]), 0.2, 'same distance -> pace');
  assert.equal(await ch('distance_time', [{ distance: 6, seconds: 2400 }], [{ distance: 5, seconds: 1500 }]), 0.2, 'longer distance');
  const f = await page.evaluate(() => [0.1, 0.005, 0, -0.005, -0.1, -0.2, -0.3, -0.9].map(c => Math.round(performanceCompareScore(c) * 1000) / 1000));
  assert.deepEqual(f, [1, 0.85, 0.85, 0.85, 0.55, 0.25, 0.2, 0.2]);
  // only exercises with history: bench has history (same) -> 85; dips has none -> ignored
  const p = await perfRun(page, [PW('prev', '2026-09-20', -72, [PT('xb', rep(70, 8, 8, 8, 8))]), PW('cur', '2026-09-23', -1, [PT('xb', rep(70, 8, 8, 8, 8)), PT('xd', rep(0, 10, 10))])]);
  assert.deepEqual(sc(p), [96, 100, 100, 85, 0]);
}, { state: fixtureState() });

test('11A performance: no template -> latest earlier same-name workout (exact, case-insensitive) is the plan; none -> "—"', async ({ page }) => {
  const noTpl = (name, sets) => ({ ...PW('cur', '2026-09-23', -1, [PE('xb', sets), PE('xo', rep(45, 8, 8, 8))]), name });
  const prevA = (id, name, date, h, sets) => ({ ...PW(id, date, h, [PE('xb', sets), PE('xo', rep(45, 8, 8, 8))]), name });
  let p = await perfRun(page, [prevA('old', 'Push A', '2026-09-10', -300, rep(60, 5, 5, 5)), prevA('prev', 'PUSH  a', '2026-09-20', -72, rep(70, 8, 8, 8)), noTpl('push A', rep(70, 8, 8, 8))]);
  assert.deepEqual([...sc(p), p.planSource, p.planWorkoutId], [96, 100, 100, 85, 0, 'previous', 'prev'], 'same performance as the latest same-name workout = 96, not 85');
  p = await perfRun(page, [prevA('prev', 'Push A', '2026-09-20', -72, rep(70, 8, 8, 8)), noTpl('Push A', rep(70, 8, 6))]);
  assert.deepEqual(sc(p), [80, 83, 95, 53, 0], 'implicit plan: 5 of 6 sets; targets = last values set by set (4.75/5); bench work -41.7 % -> 0.2, OHP 0.85');
  p = await perfRun(page, [prevA('prev', 'Push A2', '2026-09-20', -72, rep(70, 8, 8, 8)), noTpl('Push A', rep(70, 8, 8, 8))]);
  assert.deepEqual([p.score, p.label, p.planSource], [null, null, null], 'no fuzzy name matching -> no plan -> —');
  p = await perfRun(page, [prevA('later', 'Push A', '2026-09-25', 30, rep(70, 8, 8, 8)), noTpl('Push A', rep(70, 8, 8, 8))]);
  assert.equal(p.score, null, 'only EARLIER workouts can be the implicit plan');
  // legacy same-name workout as implicit plan (fixture "Push day": Bench press 4x8@80, Overhead press 3x10@45)
  const r = await page.evaluate(ws => { S.workouts = ws; S.exerciseLibrary = []; S.exerciseLibrary = exerciseSeedFromHistory(ws);
    const w = workoutStart({ name: 'Push day' }).workout; const b = workoutAddEntry(w.id, exerciseFind('Bench press').id);
    b.sets = Array.from({ length: 4 }, () => Object.assign(workoutNewSet(null), { weight: 80, reps: 8, done: true }));
    return workoutFinish(w.id).workout.result.performance; }, fixtureState().workouts);
  assert.deepEqual([r.score, r.parts.plan, r.parts.target, r.parts.prev, r.planSource], [79, 57, 100, 85, 'previous'], '4 of 7 planned legacy sets (OHP skipped): 40 x 4/7 + 35 + 25 x 0.85 = 79.1');
}, { state: fixtureState() });

test('11A performance: PR bonus +5 per record (Weight + Rep on one exercise = +10), never above +10 or 100', async ({ page }) => {
  const P = PREV_A;
  let p = await perfRun(page, [P(), CUR({ xb: [{ weight: 75, reps: 6 }, ...rep(70, 8, 8, 8)] })]);
  assert.equal(p.prBonus, 5);
  p = await perfRun(page, [P(), CUR({ xl: rep(10, 12, 12, 11), xb: [{ weight: 75, reps: 6 }, { weight: 70, reps: 9 }, ...rep(70, 8, 7)] })]);
  assert.deepEqual([p.prBonus, p.score], [10, 100], 'weight PR 75x6 + rep PR 70x9 on the bench');
  const n = await page.evaluate(() => workoutPRs(S.workouts.find(w => w.id === 'cur')).map(x => x.type));
  assert.deepEqual(n, ['weight', 'reps']);
  p = await perfRun(page, [P(), CUR({ xb: [{ weight: 75, reps: 6 }, { weight: 70, reps: 9 }, ...rep(70, 8, 8)], xo: [{ weight: 47.5, reps: 8 }, ...rep(45, 8, 8)] })]);
  assert.equal(p.prBonus, 10, 'three PRs are still +10');
  p = await perfRun(page, [P(), CUR({ xb: rep(60, 8, 7, 6, 5), xo: [{ weight: 50, reps: 3 }, ...rep(40, 6, 6)], xi: rep(22, 10, 8, 8) })]);
  assert.equal(p.prBonus, 5); assert.ok(p.score < 100);
}, { state: fixtureState() });

test('11A performance: snapshot at Finish (score, parts, label); editing the finished workout never rewrites it', async ({ page }) => {
  await page.evaluate(lib => { S.exerciseLibrary = lib; S.workouts = []; }, PFL);
  const tid = await page.evaluate(() => templateSave({ name: 'Push A', exercises: [{ exerciseId: 'xb', sets: 2, repsMin: 8, repsMax: 10, weight: 70 }] }).template.id);
  const finish = async (reps, h) => { await page.clock.setFixedTime(NOW + h * 60e3);
    return page.evaluate(({ tid, reps }) => { const w = workoutStart({ templateId: tid }).workout; w.entries[0].sets.forEach((s, i) => Object.assign(s, { reps: reps[i], done: true })); return JSON.parse(JSON.stringify(workoutFinish(w.id).workout)); }, { tid, reps }); };
  await finish([8, 8], 1);
  const w = await finish([8, 6], 2);
  assert.deepEqual(w.result.performance, { score: 83, label: 'fair', parts: { plan: 100, target: 88, prev: 48 }, prBonus: 0, planSource: 'template', planWorkoutId: null }, '40 + 35 x 0.875 + 25 x 0.475 = 82.5 -> 83');
  await page.evaluate(id => { const x = workoutFindById(id); workoutUpdateSet(x.id, x.entries[0].id, x.entries[0].sets[1].id, { reps: 10 }); }, w.id);
  const after = await page.evaluate(id => { const x = workoutFindById(id); return [x.result.performance, workoutPerformance(x)]; }, w.id);
  assert.deepEqual(after[0], w.result.performance, 'snapshot unchanged after the edit');
  assert.notDeepEqual(after[1].score, w.result.performance.score, 'a fresh calculation would differ - proving the snapshot is not recomputed');
}, { state: fixtureState() });

test('11A UI: summary shows Performance + optional Feeling; Feeling changes later in the editor and never touches score, XP or RPG', async ({ page }) => {
  await setupTpl(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('.ws-done').click(); await setRow(page, 'Bench press', 1).locator('.ws-done').click();
  await page.click('#wkFinish');
  const perf = page.locator('#wkSummary [data-slot="performance"]');
  assert.equal(await perf.isVisible(), true);
  const wid = await page.evaluate(() => completedWorkouts(S).find(w => w.entries).id);
  const snap = await page.evaluate(id => workoutFindById(id).result.performance, wid);
  assert.match(await perf.innerText(), new RegExp(`${snap.score}[\\s\\S]*PERFORMANCE[\\s\\S]*Plán[\\s\\S]*Cíle[\\s\\S]*Vs\\. minule`, 'i'));
  assert.equal(await page.evaluate(id => workoutFindById(id).result.feeling, wid), undefined, 'Feeling is optional - nothing stored until chosen');
  const frozen = () => page.evaluate(id => JSON.stringify([workoutFindById(id).result.performance, workoutFindById(id).result.prs, S.totalXp, S.xpLog, S.attrs, S.rpg, S.achievementsUnlocked, S.quests, dailyScore(todayStr()), exercisePRs()]), wid);
  const f0 = await frozen();
  await page.click('#wkSumFeel [data-feel="good"]');
  assert.equal(await page.evaluate(id => workoutFindById(id).result.feeling, wid), 'good');
  assert.equal(await page.getAttribute('#wkSumFeel [data-feel="good"]', 'aria-pressed'), 'true');
  await page.click('#wkSumOk');
  assert.match(await page.locator('.workout-card', { hasText: 'Push A' }).innerText(), new RegExp(`${snap.score}[\\s\\S]*Dobře`)); // polish pass: icons instead of ⚡ / 🙂
  await page.locator('.workout-card', { hasText: 'Push A' }).locator('.editBtn').click();
  assert.match(await page.locator('.wk-edit-result').innerText(), /Hodnoceno při dokončení/);
  await page.click('#wkEditFeel [data-feel="bad"]');
  assert.equal(await page.evaluate(id => workoutFindById(id).result.feeling, wid), 'bad');
  await page.click('#wkEditFeel [data-feel="bad"]');
  assert.equal(await page.evaluate(id => workoutFindById(id).result.feeling, wid), null, 'tapping the chosen one again clears it');
  await page.click('#wkEditFeel [data-feel="great"]');
  assert.equal(await frozen(), f0, 'Feeling changes nothing else (Performance, PRs, XP, RPG, achievements, quests, Daily Score)');
  assert.equal(await page.evaluate(id => workoutSetFeeling(id, 'amazing'), wid), false, 'only Bad/Normal/Good/Great');
  await persist(page); await reload(page);
  assert.equal(await page.evaluate(id => workoutFindById(id).result.feeling, wid), 'great');
}, { state: fixtureState() });

test('11A UI: a workout without plan shows "—" (not rated); Performance/Feeling layouts fit 320-1440 px', async ({ page }) => {
  await openWorkouts(page);
  await page.click('#wkBlank');
  await page.click('#wkAddEx'); await page.click('[data-pick-preset="Plank"]');
  await setRow(page, 'Plank', 0).locator('[data-f="seconds"]').fill('60'); await setRow(page, 'Plank', 0).locator('.ws-done').click();
  await page.click('#wkFinish');
  assert.match(await page.locator('#wkSummary [data-perf="na"]').innerText(), /Bez hodnocení/);
  assert.equal(await page.evaluate(() => completedWorkouts(S).find(w => w.entries).result.performance.score), null);
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of ['summary', 'summary-na', 'edit', 'list']) {
      await page.evaluate(k => {
        closeSheets(); uiWorkoutView = null; fitnessTab = 'workouts'; view = 'fitness';
        const w = completedWorkouts(S).find(x => x.entries); w.result.performance = k === 'summary-na' ? { score: null, label: null, parts: { plan: null, target: null, prev: null }, prBonus: 0, planSource: null, planWorkoutId: null } : { score: 88, label: 'good', parts: { plan: 100, target: 81, prev: null }, prBonus: 5, planSource: 'previous', planWorkoutId: 'x' };
        w.result.feeling = 'great';
        if (k === 'edit') uiWorkoutView = { mode: 'edit', id: w.id };
        render(); if (k.startsWith('summary')) openWorkoutSummary(w, true);
      }, k);
      const r = await page.evaluate(() => { const s = document.querySelector('.sheet'); const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i) }; });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 8: Muscle XP + Svaly ----------
const MX = (id, name, measurement, muscles) => ({ id, name, measurement, muscles, increment: 2.5, notes: '', archived: false, source: 'user', aliases: [], createdAt: NOW, updatedAt: NOW });
const ML = [MX('mb', 'Bench press', 'weight_reps', { Chest: 70, Triceps: 20, Shoulders: 10 }), MX('mp', 'Pull-up', 'reps', { Back: 65, Biceps: 25, Forearms: 10 }),
  MX('mk', 'Plank', 'time', { Abs: 80, Shoulders: 10, Glutes: 10 }), MX('mr', 'Running', 'distance_time', { Legs: 80, Glutes: 20 }),
  MX('mc', 'Curl', 'weight_reps', { Biceps: 85, Forearms: 15 }), MX('ms', 'Squat', 'weight_reps', { Legs: 65, Glutes: 25, Abs: 10 }),
  MX('mn', 'Unmapped', 'weight_reps', {}), MX('c1', 'Fly 1', 'weight_reps', { Chest: 100 }), MX('c2', 'Fly 2', 'weight_reps', { Chest: 100 }), MX('c3', 'Fly 3', 'weight_reps', { Chest: 100 })];
const mxInit = page => page.evaluate(lib => { S.exerciseLibrary = lib; S.workouts = []; S.muscleProgress = { log: [] }; S.achievementsUnlocked.push('first_workout'); }, ML);
// spec: [[exerciseId, [set, ...]], ...]; a set is {weight,reps,seconds,...}; done:true unless given
let mxTick = 0;
const mxFinish = async (page, spec, { date = TODAY, finish = true, name = 'M' } = {}) => {
  await page.clock.setFixedTime(NOW + (++mxTick) * 60e3);
  return page.evaluate(({ spec, date, finish, name }) => {
    const w = workoutStart({ name }).workout; w.date = date;
    spec.forEach(([eid, sets]) => { const en = workoutAddEntry(w.id, eid); en.sets = sets.map(s => Object.assign(workoutNewSet(null), { done: true }, s)); });
    if (finish) workoutFinish(w.id);
    return { id: w.id, xp: workoutMuscleXp(w.id), log: S.muscleProgress.log.filter(r => r.workoutId === w.id).map(({ ts, ...r }) => r) };
  }, { spec, date, finish, name });
};
const B = n => Array.from({ length: n }, () => ({ weight: 60, reps: 8 }));
const totals = page => page.evaluate(() => muscleTotals());

test('11A muscle XP: 1 set = 10 XP by %, more sets, max 6 per exercise per workout (entries of one exercise combined)', async ({ page }) => {
  await mxInit(page);
  let r = await mxFinish(page, [['mb', B(1)]]);
  assert.deepEqual(r.xp, { Chest: 7, Shoulders: 1, Triceps: 2 });
  r = await mxFinish(page, [['mb', B(3)]]);
  assert.deepEqual(r.xp, { Chest: 21, Shoulders: 3, Triceps: 6 }, '30 XP -> 21/6/3');
  assert.deepEqual(r.log, [{ key: `muscle:${r.id}:mb`, workoutId: r.id, exerciseId: 'mb', date: TODAY, units: 3, baseXp: 30, prXp: 0, xp: { Chest: 21, Triceps: 6, Shoulders: 3 } }]);
  r = await mxFinish(page, [['mb', B(8)]]);
  assert.deepEqual([r.log[0].units, r.log[0].baseXp], [6, 60], 'max 6 sets');
  r = await mxFinish(page, [['mb', B(4)], ['mp', [{ reps: 10 }]], ['mb', B(4)]]);
  assert.deepEqual(r.log.map(x => [x.exerciseId, x.units]), [['mb', 6], ['mp', 1]], 'the limit is per exercise and workout, entries of the same exercise counted together');
}, { state: fixtureState() });

test('11A muscle XP: warm-ups, unfinished sets, active and discarded workouts never count', async ({ page }) => {
  await mxInit(page);
  let r = await mxFinish(page, [['mb', [{ weight: 100, reps: 5, warmup: true }, { weight: 60, reps: 8, done: false }, { weight: 60, reps: 8 }, { weight: 60, reps: 8, warmup: true, done: true }]]]);
  assert.equal(r.log[0].units, 1, 'only the one done working set');
  const act = await mxFinish(page, [['mb', B(5)]], { finish: false });
  assert.deepEqual(act.log, [], 'active: nothing');
  await persist(page); await reload(page);
  assert.equal(await page.evaluate(id => S.muscleProgress.log.some(x => x.workoutId === id), act.id), false, 'recovery at load skips the active workout');
  await page.evaluate(id => workoutDiscard(id), act.id);
  assert.equal(await page.evaluate(id => S.muscleProgress.log.some(x => x.workoutId === id), act.id), false, 'discarded: nothing');
}, { state: fixtureState() });

test('11A muscle XP: time and distance_time = floor(total seconds / 60), max 6; no time = 0; distance unused', async ({ page }) => {
  await mxInit(page);
  let r = await mxFinish(page, [['mk', [{ seconds: 50 }]]]);
  assert.deepEqual([r.log[0].units, r.xp], [0, {}], 'a set without a full minute gives nothing');
  r = await mxFinish(page, [['mk', [{ seconds: 45 }, { seconds: 45 }]]]);
  assert.deepEqual([r.log[0].units, r.xp], [1, { Abs: 8, Shoulders: 1, Glutes: 1 }], '45 + 45 s = 90 s = 1 unit');
  r = await mxFinish(page, [['mk', [{ seconds: 55 }]]]);
  assert.equal(await page.evaluate(id => workoutFindById(id).result.prs.length, r.id), 1, '55 s is a time PR');
  assert.deepEqual([r.log[0].units, r.log[0].baseXp, r.log[0].prXp, r.xp], [0, 0, 0, {}], 'plank 55 s: 0 units -> no base XP and no PR XP');
  r = await mxFinish(page, [['mk', [{ seconds: 65 }]]]);
  assert.deepEqual([r.log[0].units, r.log[0].baseXp, r.log[0].prXp, r.xp], [1, 10, 15, { Abs: 20, Shoulders: 3, Glutes: 2 }], 'plank 65 s: 1 unit + PR -> 10 + 15 = 25 XP (20/2.5/2.5 -> 20/3/2)');
  r = await mxFinish(page, [['mk', [{ seconds: 600 }]]]);
  assert.equal(r.log[0].units, 6);
  r = await mxFinish(page, [['mr', [{ distance: 5, seconds: 1500 }]]]);
  assert.deepEqual([r.log[0].units, r.xp], [6, { Legs: 48, Glutes: 12 }], '25 min run -> 60 XP');
  r = await mxFinish(page, [['mr', [{ distance: 12, seconds: 150 }]]]);
  assert.equal(r.log[0].units, 2, '2:30 -> 2 units, the 12 km play no role');
  r = await mxFinish(page, [['mr', [{ distance: 5 }]]]);
  assert.deepEqual([r.log[0].units, r.xp], [0, {}], 'no time -> 0');
}, { state: fixtureState() });

test('11A muscle XP: PR +15 once per exercise (Weight + Rep PR still +15), split by the same %', async ({ page }) => {
  await mxInit(page);
  await mxFinish(page, [['mb', [{ weight: 100, reps: 5 }]]], { date: '2026-09-20' });
  let r = await mxFinish(page, [['mb', [{ weight: 110, reps: 5 }]]], { date: '2026-09-21' });
  assert.deepEqual([r.log[0].prXp, r.xp], [15, { Chest: 18, Triceps: 5, Shoulders: 2 }], '25 XP: 17.5/5/2.5 -> 18/5/2');
  r = await mxFinish(page, [['mb', [{ weight: 115, reps: 2 }, { weight: 110, reps: 7 }]]], { date: '2026-09-22' });
  assert.equal(await page.evaluate(id => workoutFindById(id).result.prs.length, r.id), 2, 'a Weight PR and a Rep PR');
  assert.deepEqual([r.log[0].baseXp, r.log[0].prXp, r.xp], [20, 15, { Chest: 25, Triceps: 7, Shoulders: 3 }], 'still +15: 35 XP -> 24.5/7/3.5 -> 25/7/3');
}, { state: fixtureState() });

test('11A muscle XP: several exercises and muscle groups; largest-remainder rounding always adds up', async ({ page }) => {
  await mxInit(page);
  const r = await mxFinish(page, [['mb', B(3)], ['mp', [{ reps: 10 }, { reps: 8 }]], ['mc', B(1)], ['ms', B(2)]]);
  assert.deepEqual(r.xp, { Chest: 21, Triceps: 6, Shoulders: 3, Back: 13, Biceps: 14, Forearms: 3, Legs: 13, Glutes: 5, Abs: 2 });
  const sums = await page.evaluate(() => Array.from({ length: 200 }, (_, i) => { const m = {}; MUSCLE_GROUPS.forEach((g, j) => { if ((i + j) % 3) m[g] = (i * 7 + j * 13) % 50 + 1; });
    const t = (i % 13) * 5 + 10; const s = muscleSplit(t, m); return Object.values(s).reduce((a, b) => a + b, 0) === t; }));
  assert.ok(sums.every(Boolean), 'the parts always equal the total');
  assert.deepEqual(await page.evaluate(() => [muscleSplit(10, { Biceps: 85, Forearms: 15 }), muscleSplit(10, { Chest: 1, Back: 1, Legs: 1 })]), [{ Biceps: 9, Forearms: 1 }, { Chest: 4, Back: 3, Legs: 3 }], 'ties go to the earlier muscle group');
}, { state: fixtureState() });

test('11A muscle XP: daily cap 150 per muscle - within a workout, shared across workouts of the day, other muscles and days unaffected', async ({ page }) => {
  await mxInit(page);
  let r = await mxFinish(page, [['c1', B(6)], ['c2', B(6)], ['c3', B(6)], ['mc', B(6)]]);
  assert.deepEqual(r.log.map(x => [x.exerciseId, x.xp]), [['c1', { Chest: 60 }], ['c2', { Chest: 60 }], ['c3', { Chest: 30 }], ['mc', { Biceps: 51, Forearms: 9 }]], 'Chest stops at 150; Biceps untouched');
  await mxInit(page);
  const a = await mxFinish(page, [['c1', B(6)], ['c2', B(6)]], { date: '2026-09-22' });
  const b = await mxFinish(page, [['c3', B(6)], ['mb', B(6)]], { date: '2026-09-22' });
  const c = await mxFinish(page, [['c3', B(6)]], { date: '2026-09-23' });
  assert.deepEqual(a.xp, { Chest: 120 });
  assert.deepEqual(b.log.map(x => x.xp), [{ Chest: 30 }, { Triceps: 12, Shoulders: 6 }], 'second workout of the day: 30 Chest left, Chest part of the bench capped to 0, Triceps/Shoulders full');
  assert.deepEqual(c.xp, { Chest: 60 }, 'a new day starts from zero');
  assert.equal((await totals(page)).Chest, 210);
}, { state: fixtureState() });

test('11A muscle levels: round(100 x n^1.2) per level from level 1 at 0 XP; progress to the next level', async ({ page }) => {
  const r = await page.evaluate(() => ({ need: [1, 2, 5, 10, 15, 20, 30].map(muscleXpNeed),
    lv: [0, 99, 100, 329, 330, 1000].map(x => { const l = muscleLevelFromXp(x); return [l.level, l.into, l.need]; }) }));
  assert.deepEqual(r.need, [100, 230, 690, 1585, 2578, 3641, 5923]);
  assert.deepEqual(r.lv, [[1, 0, 100], [1, 99, 100], [2, 0, 230], [2, 229, 230], [3, 0, 374], [4, 296, 528]]);
  await mxInit(page);
  await page.evaluate(() => { S.muscleProgress.log.push({ key: 'x', workoutId: 'x', exerciseId: 'x', date: '2026-01-01', units: 0, baseXp: 0, prXp: 0, xp: { Legs: 412 }, ts: 1 }); fitnessTab = 'muscles'; view = 'fitness'; render(); });
  const legs = await page.locator('[data-muscle-card="Legs"]').innerText();
  assert.match(legs, /Nohy[\s\S]*Level 3[\s\S]*412\s*XP[\s\S]*82 \/ 374 do dalšího levelu/);
  assert.equal(await page.locator('[data-muscle-card="Legs"] [role="progressbar"]').getAttribute('aria-valuenow'), '82');
  assert.equal(await page.evaluate(() => S.totalXp) > 0, true);
  assert.equal(await page.evaluate(() => levelFromXp(S.totalXp).level) >= 1, true, 'Character level helper untouched');
}, { state: fixtureState() });

test('11A muscle XP: idempotent - reload, render, editing, a second Finish, export/import; recovery rebuilds a missing log identically', async ({ page }) => {
  await mxInit(page);
  const w = await mxFinish(page, [['mb', B(3)], ['mp', [{ reps: 10 }]]]);
  const t0 = await totals(page), n0 = await page.evaluate(() => S.muscleProgress.log.length);
  const log0 = await page.evaluate(() => S.muscleProgress.log.map(({ ts, ...r }) => r));
  await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(backup.muscleProgress.log.length, n0, 'the log is part of the backup');
  await reload(page);
  for (const v of ['home', 'fitness', 'statistics', 'character']) await page.evaluate(v => { fitnessTab = 'muscles'; view = v; render(); }, v);
  await page.evaluate(id => { const x = workoutFindById(id); workoutAddSet(x.id, x.entries[0].id, { done: true }); workoutFinish(id); muscleAwardWorkout(x); muscleRecover(S); }, w.id);
  assert.deepEqual(await totals(page), t0, 'reload, renders, an edit (+1 done set), a second Finish and recovery pay nothing');
  assert.equal(await page.evaluate(() => S.muscleProgress.log.length), n0);
  await page.click('#settingsBtn');
  await importFile(page, file);
  await page.waitForFunction(() => workoutFindById(completedWorkouts(S)[0].id).entries[0].sets.length === 3);
  assert.deepEqual(await totals(page), t0, 'import of the full backup: no double pay');
  delete backup.muscleProgress;
  await importFile(page, { name: 'nolog.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => S.muscleProgress.log.map(({ ts, ...r }) => r)), log0, 'a backup without the log is rebuilt once from its stored data and snapshots - identical');
  assert.deepEqual(await totals(page), t0);
}, { state: fixtureState() });

test('11A muscle XP: history - legacy exercises[] never pay; a record with exerciseId and no log is recovered once; the mapping is a Finish snapshot', async ({ page }) => {
  // legacy fixture workouts ("Bench press" 4x8, "Deadlift" 3x5) + a library that now maps those names -> still 0
  await page.evaluate(() => { S.exerciseLibrary.forEach(x => { x.muscles = { Chest: 100 }; }); S.muscleProgress = { log: [] }; muscleRecover(S); });
  assert.deepEqual(await page.evaluate(() => S.muscleProgress.log), [], 'no guessing from names');
  const old = fixtureState(); old.exerciseLibrary = ML; old.muscleProgress = undefined;
  old.workouts.push({ id: 'pre8', name: 'Before step 8', date: '2026-09-22', status: 'done', startedAt: NOW - 864e5, finishedAt: NOW - 864e5 + 3600e3, duration: '60', notes: '', exercises: [], createdAt: NOW - 864e5,
    entries: [{ id: 'e1', exerciseId: 'mb', name: 'Bench press', measurement: 'weight_reps', target: null, notes: '', sets: [1, 2].map(i => ({ id: 's' + i, weight: 60, reps: 8, seconds: null, distance: null, rpe: null, warmup: false, done: true })) }], result: { prs: [] } });
  await page.click('#settingsBtn');
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.workouts.some(w => w.id === 'pre8'));
  const r = await page.evaluate(() => ({ log: S.muscleProgress.log.map(x => [x.workoutId, x.exerciseId, x.xp]), snap: workoutFindById('pre8').entries[0].muscles }));
  assert.deepEqual(r.log, [['pre8', 'mb', { Chest: 14, Triceps: 4, Shoulders: 2 }]], 'only the record with an exerciseId; legacy rows 0');
  assert.deepEqual(r.snap, { Chest: 70, Shoulders: 10, Triceps: 20 }, 'the mapping used is stored on the entry');
  // later library change / archive / delete and editing the workout never change past XP; a new workout uses the new mapping
  const t0 = await totals(page);
  await page.evaluate(() => { exerciseSave({ name: 'Bench press', measurement: 'weight_reps', muscles: { Back: 100 } }, 'mb'); workoutUpdateSet('pre8', 'e1', 's1', { reps: 20 }); });
  assert.deepEqual(await totals(page), t0);
  assert.equal(await page.evaluate(() => exerciseDelete('mb')), 'archived');
  await page.evaluate(() => { S.exerciseLibrary = S.exerciseLibrary.filter(x => x.id !== 'mb'); muscleRecover(S); });
  assert.deepEqual(await totals(page), t0, 'archived, then removed from the library: history unchanged');
  await page.evaluate(() => { S.exerciseLibrary.push(JSON.parse(JSON.stringify(Object.assign({}, S.exerciseLibrary[0], { id: 'mb', name: 'Bench press', muscles: { Back: 100 }, archived: false })))); });
  const w = await mxFinish(page, [['mb', B(1)]]);
  assert.deepEqual(w.xp, { Back: 10 }, 'new workout -> current mapping');
  // deleting a finished workout keeps its Muscle XP (no refund)
  const t1 = await totals(page);
  await page.evaluate(() => { S.workouts = S.workouts.filter(x => x.id !== 'pre8'); muscleRecover(S); });
  assert.deepEqual(await totals(page), t1);
  assert.ok(await page.evaluate(() => S.muscleProgress.log.some(x => x.workoutId === 'pre8')), 'the log keeps the record');
}, { state: fixtureState() });

test('11A muscle XP is parallel: Character XP 80 + VIT (polish pass: fitness profile, no skill bonus), Daily Score, Performance, PRs, Feeling, quests and achievements unchanged', async ({ page }) => {
  await mxInit(page);
  await quietQuests(page);
  const b = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT, log: S.xpLog.length }));
  const w = await mxFinish(page, [['mb', B(3)], ['c1', B(6)]]);
  const a = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT, log: S.xpLog.length }));
  const newLog = await page.evaluate(n => S.xpLog.slice(n).map(e => [e.amount, e.reason]), b.log);
  assert.deepEqual([a.xp - b.xp, a.VIT - b.VIT, newLog], [80, 14, [[80, 'Workout: M']]], 'Character XP: the one 80 XP entry; VIT 14 from the fitness profile (balancing: no flat +20)');
  assert.ok(a.STR - b.STR > 0);
  assert.ok(Object.keys(await totals(page)).length > 0);
  // everything else is computed without reading the Muscle XP log: wipe or inflate it -> same results
  const probe = () => page.evaluate(id => { const x = workoutFindById(id); return JSON.stringify([dailyScore(todayStr()), workoutPerformance(x), x.result.performance, workoutPRs(x), exercisePRs(), x.result.feeling,
    [DAILY_QUESTS, WEEKLY_QUESTS].flat().map(q => [q.id, q.check(S), q.val(S)]), ACHV.map(ac => [ac.id, ac.cond(S)]), S.totalXp, levelFromXp(S.totalXp), S.attrs, S.rpg]); }, w.id);
  const p0 = await probe();
  await page.evaluate(() => { window.__log = S.muscleProgress.log; S.muscleProgress.log = [{ key: 'k', workoutId: 'k', exerciseId: 'k', date: todayStr(), units: 6, baseXp: 60, prXp: 0, xp: { Chest: 99999 }, ts: 1 }]; });
  assert.equal(await probe(), p0);
  await page.evaluate(id => { S.muscleProgress.log = window.__log; workoutSetFeeling(id, 'great'); }, w.id);
  const t0 = await totals(page);
  await page.evaluate(id => workoutSetFeeling(id, 'bad'), w.id);
  assert.deepEqual(await totals(page), t0, 'Feeling never changes Muscle XP');
  assert.equal(await page.evaluate(id => workoutFindById(id).result.performance.score, w.id), JSON.parse(p0)[2].score);
}, { state: fixtureState() });

test('11A UI: Svaly tab lists all 9 muscle groups (Czech names, level, XP, progress) and the summary shows the earned Muscle XP', async ({ page }) => {
  await mxInit(page);
  await openWorkouts(page);
  await page.click('#wkBlank');
  await page.click('#wkAddEx'); await page.click('[data-pick="mb"]');
  await setRow(page, 'Bench press', 0).locator('[data-f="weight"]').fill('60'); await setRow(page, 'Bench press', 0).locator('[data-f="reps"]').fill('8');
  await entryCard(page, 'Bench press').locator('.wkAddSet').click(); await entryCard(page, 'Bench press').locator('.wkAddSet').click();
  for (const i of [0, 1, 2]) await setRow(page, 'Bench press', i).locator('.ws-done').click();
  await page.click('#wkFinish');
  assert.match(await page.locator('#wkSummary .wk-muscles').innerText(), /SVALY[\s\S]*Prsa \+21 XP[\s\S]*Triceps \+6 XP[\s\S]*Ramena \+3 XP/i);
  assert.match(await page.locator('#wkSummary').innerText(), /\+80 Character XP/, 'Character XP shown separately');
  await page.click('#wkSumOk');
  await page.click('#fitTabs [data-k="muscles"]');
  assert.match(await appText(page), /Svaly získávají XP podle toho, jaké cviky a série trénuješ\. Různé svaly proto mohou postupovat různým tempem\./);
  const names = await page.locator('.mu-card .item-title').allInnerTexts();
  assert.deepEqual(names, ['Prsa', 'Záda', 'Ramena', 'Biceps', 'Triceps', 'Nohy', 'Břicho', 'Hýždě', 'Předloktí']);
  assert.match(await page.locator('[data-muscle-card="Chest"]').innerText(), /Level 1[\s\S]*21\s*XP[\s\S]*21 \/ 100/);
  // no summary block when nothing was earned
  await page.evaluate(() => { closeSheets(); const w = workoutStart({}).workout; workoutAddEntry(w.id, 'mn').sets.forEach(s => Object.assign(s, { weight: 10, reps: 5, done: true })); const r = workoutFinish(w.id); openWorkoutSummary(r.workout, true); });
  assert.equal(await page.locator('#wkSummary .wk-muscles').count(), 0, 'unmapped exercise: no Muscle XP, no block');
}, { state: fixtureState() });

test('11A UI: Svaly tab, 4 Fitness tabs and the summary with muscles fit 320-1440 px', async ({ page }) => {
  await mxInit(page);
  await mxFinish(page, [['mb', B(6)], ['mp', B(6)], ['mk', [{ seconds: 400 }]], ['mr', [{ distance: 5, seconds: 1500 }]], ['mc', B(6)], ['ms', B(6)]]);
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of ['muscles', 'summary', 'workouts']) {
      await page.evaluate(k => { closeSheets(); uiWorkoutView = null; fitnessTab = k === 'muscles' ? 'muscles' : 'workouts'; view = 'fitness'; render(); if (k === 'summary') openWorkoutSummary(completedWorkouts(S).find(w => w.entries), true); }, k);
      const r = await page.evaluate(() => { const s = document.querySelector('.sheet'); const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i), cards: document.querySelectorAll('.mu-card').length }; });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length || (k === 'muscles' && r.cards !== 9)) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 9: Planner <-> Workout Template <-> Active Workout ----------
// Fixture: old planner blocks (pb_math, pb_push ... no workoutTemplateId) + a "Push A" template (Bench press 3 x 8-10 @ 80).
const plSetup = page => page.evaluate(() => {
  const bench = exerciseFind('Bench press'); bench.muscles = { Chest: 70, Triceps: 20, Shoulders: 10 };
  const t = templateSave({ name: 'Push A', exercises: [{ exerciseId: bench.id, sets: 3, repsMin: 8, repsMax: 10, weight: 80 }] }).template;
  const b = plannerSaveBlock({ title: 'Push A', date: todayStr(), startTime: '14:00', endTime: '15:15', category: 'Fitness', workoutTemplateId: t.id, notes: 'heavy' }).block;
  return { tid: t.id, bid: b.id };
});
const blk = (page, id) => page.evaluate(id => JSON.parse(JSON.stringify(S.plannerBlocks.find(b => b.id === id))), id);
const plView = page => page.evaluate(() => { closeSheets(); uiWorkoutView = null; uiPlannerDay = todayStr(); view = 'planner'; render(); });

test('11A planner: workout block model - template reference only, edit template/date/time, old blocks unchanged, reload + export/import keep links', async ({ page }) => {
  const old0 = await page.evaluate(() => JSON.stringify([S.plannerBlocks, S.plannerBlocks.map(plannerLinks)]));
  const { tid, bid } = await plSetup(page);
  let b = await blk(page, bid);
  assert.equal(b.workoutTemplateId, tid);
  assert.ok(!('exercises' in b) && !('plan' in b), 'the template is referenced, never copied into the block');
  assert.equal(await page.evaluate(id => plannerLinks(S.plannerBlocks.find(x => x.id === id)).template.name, bid), 'Push A');
  assert.equal(await page.evaluate(o => JSON.stringify([S.plannerBlocks.filter(b => b.id !== o), S.plannerBlocks.filter(b => b.id !== o).map(plannerLinks)]), bid), old0, 'old blocks (no workoutTemplateId) and their links unchanged');
  const t2 = await page.evaluate(() => templateSave({ name: 'Pull B', exercises: [{ exerciseId: exerciseFind('Deadlift').id, sets: 3, repsMin: 5 }] }).template.id);
  await page.evaluate(({ bid, t2 }) => { const b = S.plannerBlocks.find(x => x.id === bid); plannerSaveBlock(Object.assign({}, b, { workoutTemplateId: t2, date: addDays(todayStr(), 1), startTime: '07:00', endTime: '08:30' }), b); }, { bid, t2 });
  b = await blk(page, bid);
  assert.deepEqual([b.workoutTemplateId, b.date, b.startTime, b.endTime, b.notes, b.completed], [t2, await page.evaluate(() => addDays(todayStr(), 1)), '07:00', '08:30', 'heavy', false]);
  await persist(page); await reload(page);
  assert.deepEqual(await blk(page, bid), b, 'reload');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).plannerBlocks.find(x => x.id === bid), b);
  await page.evaluate(() => { S.plannerBlocks = []; });
  await importFile(page, file);
  await page.waitForFunction(id => S.plannerBlocks.some(x => x.id === id), bid);
  assert.deepEqual(await blk(page, bid), b, 'export/import');
  assert.equal(await page.evaluate(id => plannerLinks(S.plannerBlocks.find(x => x.id === id)).template.name, bid), 'Pull B');
}, { state: fixtureState() });

test('11A planner: Start creates one standard active workout (plan snapshot, plannerBlockId) - no XP, no quest, no Daily Score change, block not completed', async ({ page }) => {
  const { tid, bid } = await plSetup(page);
  const u0 = await untouchable(page);
  await plView(page);
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"] .cg-wk`);
  assert.equal(await page.locator('#wkLive').count(), 1, 'live workout screen');
  const w = await active(page);
  assert.deepEqual([w.templateId, w.plannerBlockId, w.status, w.date], [tid, bid, 'active', TODAY]);
  assert.deepEqual(w.plan.map(p => [p.name, p.target.sets, p.target.repsMin, p.target.repsMax, p.target.weight]), [['Bench press', 3, 8, 10, 80]], 'w.plan = the template at Start');
  const b = await blk(page, bid);
  assert.deepEqual([b.completed, b.workoutId], [false, w.id], 'block: only a reference to the workout');
  assert.equal(await untouchable(page), u0, 'Start from the planner: 0 XP, no quest/achievement, Daily Score unchanged');
  // editing the template or the block afterwards never changes the running workout
  await page.evaluate(({ tid, bid }) => { templateSave({ name: 'Push A v2', exercises: [{ exerciseId: exerciseFind('Deadlift').id, sets: 5, repsMin: 3 }] }, tid);
    const b = S.plannerBlocks.find(x => x.id === bid); plannerSaveBlock(Object.assign({}, b, { startTime: '16:00', endTime: '17:00', title: 'Moved' }), b); }, { tid, bid });
  assert.deepEqual(await active(page), w, 'template/block edits do not touch the active workout');
  // second Start from the same block: continue, no second workout
  await plView(page);
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"] .cg-wk`);
  assert.equal(await page.evaluate(() => S.workouts.filter(x => x.status === 'active').length), 1);
  assert.equal(await page.locator('#wkLive').count(), 1);
}, { state: fixtureState() });

test('11A planner: an active workout from elsewhere is offered for continuation, never a second one', async ({ page }) => {
  const { bid } = await plSetup(page);
  await page.evaluate(() => workoutStart({ name: 'Spontaneous' }));
  await plView(page);
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"] .cg-wk`);
  assert.match(await page.locator('.cf-sheet').innerText(), /Trénink už probíhá[\s\S]*Máš rozpracovaný trénink „Spontaneous“/);
  await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => S.workouts.filter(x => x.status === 'active').length), 1);
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"] .cg-wk`); await page.click('#cf_ok');
  assert.equal((await active(page)).name, 'Spontaneous', 'continues the existing workout');
  assert.equal(await page.evaluate(() => S.workouts.filter(x => x.status === 'active').length), 1);
  assert.deepEqual(await page.evaluate(id => [S.plannerBlocks.find(x => x.id === id).workoutId, plannerBlockWorkoutState(S.plannerBlocks.find(x => x.id === id))], bid), ['', null], 'the block is not linked to someone else\'s workout');
}, { state: fixtureState() });

test('11A planner: finishing the workout never completes the block and completing the block never finishes the workout; the usual rewards only', async ({ page }) => {
  const { bid } = await plSetup(page);
  const wid = await page.evaluate(id => plannerStartWorkout(id).workout.id, bid);
  await page.evaluate(id => plannerToggleCompleted(id), bid);
  assert.deepEqual([(await blk(page, bid)).completed, (await active(page)).status], [true, 'active'], 'block done, workout still active');
  await page.evaluate(id => plannerToggleCompleted(id), bid);
  await quietQuests(page);
  const x0 = await page.evaluate(() => ({ xp: S.totalXp, VIT: S.attrs.VIT }));
  await page.evaluate(id => { const w = workoutFindById(id); w.entries[0].sets.forEach(s => s.done = true); workoutFinish(id); }, wid);
  const x1 = await page.evaluate(() => ({ xp: S.totalXp, VIT: S.attrs.VIT }));
  assert.deepEqual([x1.xp - x0.xp, x1.VIT - x0.VIT], [80, 14], 'standard 80 Character XP + VIT 14 (fitness profile), nothing for "following the plan"');
  const b = await blk(page, bid);
  assert.equal(b.completed, false, 'workout finished, block not completed');
  assert.equal(await page.evaluate(id => plannerBlockWorkoutState(S.plannerBlocks.find(x => x.id === id)), bid), 'done', 'informative state only');
  // the planner reference does not influence Performance, PRs, Muscle XP, Feeling or Daily Score
  const probe = () => page.evaluate(id => { const w = workoutFindById(id); return JSON.stringify([workoutPerformance(w), workoutPRs(w), w.result.feeling || null, dailyScore(todayStr()),
    (() => { const st = JSON.parse(JSON.stringify(S)); const c = st.workouts.find(x => x.id === id); st.muscleProgress = { log: [] }; muscleAwardWorkout(c, st); return muscleTotals(st); })()]); }, wid);
  const p0 = await probe();
  await page.evaluate(id => { workoutFindById(id).plannerBlockId = ''; }, wid);
  assert.equal(await probe(), p0, 'same results without the planner reference');
  assert.deepEqual(JSON.parse(p0)[4], await page.evaluate(id => workoutMuscleXp(id), wid), 'Muscle XP paid = Muscle XP of the same workout without the reference');
  await page.evaluate(({ id, bid }) => { workoutFindById(id).plannerBlockId = bid; workoutSetFeeling(id, 'good'); }, { id: wid, bid });
  assert.equal((await blk(page, bid)).completed, false, 'Feeling does not touch the block either');
}, { state: fixtureState() });

test('11A planner: a deleted or unknown template never breaks the planner - "Šablona není dostupná", no Start, reference kept on save', async ({ page }) => {
  const { tid, bid } = await plSetup(page);
  const unknown = await page.evaluate(() => plannerSaveBlock({ title: 'Legs', date: todayStr(), startTime: '19:00', endTime: '20:00', workoutTemplateId: 'tpl_never_existed' }).block.id);
  await page.evaluate(id => templateDelete(id), tid);
  await plView(page);
  for (const id of [bid, unknown]) {
    assert.match(await page.locator(`.cg-it[data-id="${id}"]`).innerText(), /Šablona není dostupná/);
    assert.equal(await page.locator(`.cg-it[data-kind="block"][data-id="${id}"] .cg-wk`).count(), 0, 'no Start without a template');
  }
  assert.deepEqual(await page.evaluate(id => plannerStartWorkout(id), bid), { ok: false, reason: 'no_template' });
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"]`);
  assert.match(await page.innerText('#pb_link'), /Šablona není dostupná/, 'the missing template stays the Linked item (never auto-replaced)');
  await page.fill('#pb_notes', 'still here'); await page.click('#pb_save');
  assert.deepEqual([(await blk(page, bid)).workoutTemplateId, (await blk(page, bid)).notes], [tid, 'still here']);
  await page.evaluate(() => { view = 'home'; render(); view = 'search'; render(); });
  assert.equal(await page.evaluate(() => activeWorkout()), null);
  // note: templates have no archive state in the current model (only delete), so "archived" = unavailable = this case
}, { state: fixtureState() });

test('11A planner UI: Home Today\'s plan shows the workout block (icon, template, time) with Pokračovat / Dokončeno; other blocks as before', async ({ page }) => {
  const { bid } = await plSetup(page);
  await page.evaluate(() => { view = 'home'; render(); });
  const row = page.locator(`[data-plan="home"] [data-block="${bid}"]`);
  assert.match(await row.innerText(), /14:00[\s\S]*Push A/); assert.equal(await row.locator('.plan-t svg').count(), 1, 'workout icon');
  assert.equal(await row.locator('.planWkGo').count(), 0);
  await page.evaluate(id => plannerStartWorkout(id), bid);
  await page.evaluate(() => { view = 'home'; render(); });
  await row.locator('.planWkGo').click();
  assert.equal(await page.locator('#wkLive').count(), 1, 'Pokračovat opens the active workout');
  await page.click('#wkFinish'); await page.click('#cf_ok'); await page.click('#wkSumOk');
  await page.evaluate(() => { view = 'home'; render(); });
  assert.match(await row.innerText(), /Dokončeno/);
  assert.equal((await blk(page, bid)).completed, false, 'informative only');
  assert.match(await page.locator('[data-plan="home"] [data-block="pb_math"]').innerText(), /15:00[\s\S]*Matematika/, 'other rows unchanged');
  assert.equal(await page.locator('[data-plan="home"] .plan-row[data-block="pb_math"]').count(), 1);
}, { state: classicState() });

test('11A planner UI: Quick Add -> Planner block -> Linked workout (polish pass: no Block/Workout switch), then Search finds it, opens it and Start works; Fitness shows "Naplánováno na"', async ({ page }) => {
  await page.evaluate(() => { const bench = exerciseFind('Bench press'); templateSave({ name: 'Push A', exercises: [{ exerciseId: bench.id, sets: 3, repsMin: 8, weight: 80 }] }); });
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="planner"]');
  assert.equal(await page.locator('[data-pbtype]').count(), 0, 'no Block / Workout switch');
  for (const id of ['pb_task', 'pb_goal', 'pb_workout', 'pb_desc', 'pb_tpl']) assert.equal(await page.locator('#' + id).count(), 0, `no #${id} field`);
  await page.fill('#pb_start', '18:00'); await page.fill('#pb_end', '19:00');
  const n0 = await page.evaluate(() => S.plannerBlocks.length);
  const tid = await page.evaluate(() => S.workoutTemplates[0].id);
  await page.click('#pb_link');
  await page.click(`[data-lk-type="workout"][data-lk-id="${tid}"]`);
  assert.equal(await page.inputValue('#pb_cat'), 'Fitness', 'linking a workout sets the Fitness category');
  assert.equal(await page.inputValue('#pb_title'), 'Push A', 'title filled from the template');
  await page.click('#pb_save');
  const b = (await stateOf(page)).plannerBlocks.find(x => x.startTime === '18:00');
  assert.deepEqual([b.workoutTemplateId, b.title, b.category, (await stateOf(page)).plannerBlocks.length], [tid, 'Push A', 'Fitness', n0 + 1]);
  // a general block from the same form has no template
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="planner"]');
  await page.fill('#pb_title', 'Čtení'); await page.fill('#pb_start', '21:00'); await page.fill('#pb_end', '21:30'); await page.click('#pb_save');
  assert.equal((await stateOf(page)).plannerBlocks.find(x => x.title === 'Čtení').workoutTemplateId, '');
  // Search
  const g = await page.evaluate(() => searchGroups('push a').find(x => x[2] === 'plannerBlock')[3].map(i => [i.title, i.meta]));
  assert.ok(g.some(([t, m]) => t === 'Push A' && /18:00–19:00 · 🏋️ Push A/.test(m)));
  await page.evaluate(id => searchNavigate('plannerBlock', S.plannerBlocks.find(x => x.id === id)), b.id);
  await page.click('#pb_startwk');
  const w = await active(page);
  assert.deepEqual([w.plannerBlockId, w.templateId], [b.id, tid]);
  await page.click('#wkBack');
  assert.match(await page.locator('#wkResume').innerText(), /Naplánováno na: 18:00 – Push A/);
}, { state: fixtureState() });

test('11A planner UI: planner with workout blocks, the block form and Home fit 320-1440 px', async ({ page }) => {
  const { bid } = await plSetup(page);
  await page.evaluate(() => { plannerSaveBlock({ title: 'A very long workout block title for narrow screens', date: todayStr(), startTime: '14:30', endTime: '15:00', workoutTemplateId: 'gone' }); });
  await page.evaluate(id => plannerStartWorkout(id), bid);
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of ['planner', 'form', 'home', 'fitness']) {
      await page.evaluate(({ k, bid }) => { closeSheets(); uiWorkoutView = null; fitnessTab = 'workouts'; uiPlannerDay = todayStr(); view = k === 'form' ? 'planner' : k; render(); if (k === 'form') openPlannerForm(S.plannerBlocks.find(x => x.id === bid)); }, { k, bid });
      const r = await page.evaluate(() => { const s = document.querySelector('.sheet'); const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i) }; });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Phase 11A step 10: final QA regressions ----------
test('11A QA fix: a suggestion is never shown as applied unless its values are really in place; the redundant no-history "plan" box is hidden', async ({ page }) => {
  await plSetup(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  assert.equal(await entryCard(page, 'Bench press').locator('[data-slot="suggestion"]').isHidden(), false, 'history exists (legacy 4x8@80) -> a real suggestion');
  await page.evaluate(() => { const w = activeWorkout(); workoutDiscard(w.id); exerciseAddPreset('Plank'); templateSave({ name: 'Core', exercises: [{ exerciseId: exerciseFind('Plank').id, sets: 2, seconds: 60 }] }); });
  await openWorkouts(page);
  await page.locator('[data-start-tpl]', { hasText: 'Core' }).locator('.wkStartTpl').click();
  assert.equal(await entryCard(page, 'Plank').locator('[data-slot="suggestion"]').isHidden(), true, 'no history + prefilled = plan -> nothing to suggest');
  // with history: the button is active until the user applies it, then "Odpovídá"
  await page.evaluate(() => { const w = activeWorkout(); w.entries[0].sets.forEach(s => s.done = true); w.date = '2026-09-22'; workoutFinish(w.id); });
  await openWorkouts(page);
  await page.locator('[data-start-tpl]', { hasText: 'Core' }).locator('.wkStartTpl').click();
  const btn = entryCard(page, 'Plank').locator('.wkApplySug');
  assert.deepEqual([await btn.isDisabled(), (await btn.innerText()).trim()], [false, 'Použít doporučení']);
  await btn.click();
  assert.deepEqual([await entryCard(page, 'Plank').locator('.wkApplySug').isDisabled(), (await entryCard(page, 'Plank').locator('.wkApplySug').innerText()).trim()], [true, 'Odpovídá']); // polish pass 2: ✓ is a check icon
}, { state: fixtureState() });

test('11A QA fix: history and Home "Naposledy" are newest-first by real time; Search opens the right editor for new and legacy workouts', async ({ page }) => {
  await page.clock.setFixedTime(NOW + 3600e3);
  const wid = await page.evaluate(() => { const w = workoutStart({ name: 'Evening push' }).workout; workoutFinish(w.id); return w.id; });
  await openWorkouts(page);
  assert.deepEqual((await page.locator('#wList .workout-card .item-title').allInnerTexts()).slice(0, 2), ['Evening push', 'Pull day'], 'same day: the later one first');
  await page.evaluate(() => { view = 'home'; render(); });
  assert.match(await appText(page), /Naposledy: Evening push/);
  await page.evaluate(id => searchNavigate('workout', workoutFindById(id)), wid);
  assert.equal(await page.locator('.wk-edit-head').count(), 1, 'Fitness 2.0 workout -> entries editor');
  assert.equal(await page.locator('#w_name').count(), 0);
  await page.evaluate(() => { uiWorkoutView = null; searchNavigate('workout', workoutFindById('w2')); });
  assert.equal(await page.inputValue('#w_name'), 'Pull day', 'legacy workout -> legacy form');
}, { state: classicState() });

test('11A QA fix: a finished workout shows plan, Performance, Feeling, PRs and Muscle XP in history and in its detail; PR strip reads "9 opak."', async ({ page }) => {
  await plSetup(page);
  await openWorkouts(page);
  await page.click('[data-start-tpl] .wkStartTpl');
  await setRow(page, 'Bench press', 0).locator('[data-f="reps"]').fill('9');
  for (const i of [0, 1]) await setRow(page, 'Bench press', i).locator('.ws-done').click();
  await page.click('#wkFinish'); await page.click('#wkSumFeel [data-feel="great"]'); await page.click('#wkSumOk');
  const card = page.locator('.workout-card', { hasText: 'Push A' });
  const t = await card.innerText();
  for (const re of [/2× · 80 kg × 9, 8/, /(^|\n)\d+ · /, /Skvěle/, /Bench press · Opakování/, /\+\d+ Muscle XP/, /Plán: Push A · 1 cviků · 3 sérií/]) assert.match(t, re);
  await card.locator('.editBtn').click();
  const d = await page.locator('.wk-edit-result').innerText();
  for (const re of [/Plán: Push A/, /PERFORMANCE/i, /SVALY[\s\S]*Prsa \+\d+ XP/i, /NOVÉ OSOBNÍ REKORDY[\s\S]*80 kg × 9/i, /Jak ses cítil/i]) assert.match(d, re);
  await page.click('#wkBack');
  assert.match(await page.locator('#prList').innerText(), /9\s*opak\.[\s\S]*Opakování · @ 80 kg/);
}, { state: fixtureState() });

test('11A final: full lifecycle Planner -> Start -> reload -> continue -> sets -> Finish -> edit -> delete, and every Fitness collection survives export/import/reset', async ({ page }) => {
  const { tid, bid } = await plSetup(page);
  const u0 = await untouchable(page);
  await plView(page);
  await page.click(`.cg-it[data-kind="block"][data-id="${bid}"] .cg-wk`);
  await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  assert.equal(await untouchable(page), u0, 'nothing granted before Finish');
  assert.equal(await page.evaluate(() => S.muscleProgress.log.length), 0);
  await persist(page); await reload(page);
  await page.evaluate(() => { view = 'calendar'; render(); view = 'home'; render(); });
  await page.locator(`[data-plan="home"] [data-block="${bid}"] .planWkGo`).click();
  await setRow(page, 'Bench press', 1).locator('[data-f="reps"]').fill('10'); await setRow(page, 'Bench press', 1).locator('.ws-done').click();
  await entryCard(page, 'Bench press').locator('.wkAddWu').click(); await setRow(page, 'Bench press', 0).locator('.ws-done').click();
  await quietQuests(page);
  const x0 = await page.evaluate(() => ({ xp: S.totalXp, VIT: S.attrs.VIT }));
  await page.click('#wkFinish');
  const w = await page.evaluate(() => JSON.parse(JSON.stringify(completedWorkouts(S).find(x => x.entries))));
  const x1 = await page.evaluate(() => ({ xp: S.totalXp, VIT: S.attrs.VIT }));
  assert.equal(x1.VIT - x0.VIT, 14, 'VIT 14 (fitness profile; balancing: no flat +20)'); assert.ok(x1.xp - x0.xp >= 80, '80 workout XP (+ any achievement the finish unlocks via the unchanged rules)');
  assert.equal(await page.evaluate(id => S.xpLog.filter(e => e.key === `workout:${id}:${todayStr()}`).map(e => e.amount).join(), w.id), '80');
  assert.deepEqual([w.status, w.result.prs.map(p => p.type), w.result.performance.planSource, w.plannerBlockId, (await blk(page, bid)).completed], ['done', ['reps'], 'template', bid, false]);
  assert.deepEqual(await page.evaluate(id => S.muscleProgress.log.filter(r => r.workoutId === id).map(r => [r.units, r.prXp, r.xp]), w.id), [[2, 15, { Chest: 25, Triceps: 7, Shoulders: 3 }]], '2 working sets (warm-up ignored) + PR');
  await page.click('#wkSumOk');
  // edit: snapshots stay; current records follow; delete: Muscle XP stays
  await page.evaluate(id => { const x = workoutFindById(id); workoutUpdateSet(x.id, x.entries[0].id, x.entries[0].sets.find(s => !s.warmup && s.reps === 10).id, { reps: 8 }); }, w.id);
  const after = await page.evaluate(id => { const x = workoutFindById(id); return [x.result, workoutPRs(x).length, exercisePRs().length]; }, w.id);
  assert.deepEqual(after[0], w.result, 'PR + Performance snapshots unchanged'); assert.deepEqual([after[1], after[2]], [0, 0], 'current records recomputed');
  await page.evaluate(id => { const x = workoutFindById(id); x.entries[0].sets.find(s => !s.warmup && s.reps === 8 && s.done).reps = 10; }, w.id);
  const keep = await page.evaluate(() => JSON.stringify(['workouts', 'workoutTemplates', 'exerciseLibrary', 'muscleProgress', 'plannerBlocks'].map(k => S[k])));
  await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  await page.evaluate(() => { S.workouts = []; S.workoutTemplates = []; S.exerciseLibrary = []; S.muscleProgress = { log: [] }; S.plannerBlocks = []; });
  await importFile(page, file);
  await page.waitForFunction(() => S.workoutTemplates.length === 1);
  assert.equal(await page.evaluate(() => JSON.stringify(['workouts', 'workoutTemplates', 'exerciseLibrary', 'muscleProgress', 'plannerBlocks'].map(k => S[k]))), keep, 'export/import: identical');
  await reload(page);
  assert.equal(await page.evaluate(() => JSON.stringify(['workouts', 'workoutTemplates', 'exerciseLibrary', 'muscleProgress', 'plannerBlocks'].map(k => S[k]))), keep, 'reload: identical');
  const mx = await totals(page);
  await page.evaluate(id => { S.workouts = S.workouts.filter(x => x.id !== id); }, w.id);
  assert.deepEqual(await totals(page), mx, 'deleting the workout keeps its Muscle XP');
  page.on('dialog', d => d.accept());
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual(await page.evaluate(() => [S.workouts, S.workoutTemplates, S.exerciseLibrary, S.muscleProgress, S.plannerBlocks]), [[], [], [], { log: [] }, []], 'reset empties every Fitness 2.0 collection');
  void tid;
}, { state: classicState() });

test('11A final: Fitness screens at 320/375/390/430/768/1024/1440 - no overflow, no clipped values, buttons >= 36 px, no duplicate ids', async ({ page }) => {
  const { bid } = await plSetup(page);
  await page.evaluate(() => { templateSave({ name: 'A really very long template name that keeps going on and on', exercises: [{ exerciseId: exerciseFind('Deadlift').id, sets: 3, repsMin: 5 }] }); });
  await page.evaluate(id => { const w = plannerStartWorkout(id).workout; w.entries[0].sets.forEach(s => Object.assign(s, { reps: 12, done: true })); w.name = 'Push A with an extremely long workout name for tiny screens'; workoutFinish(w.id); plannerStartWorkout(id); }, bid);
  const screens = ['workouts', 'templates', 'library', 'muscles', 'live', 'edit', 'summary', 'tplform', 'planner', 'home'];
  const bad = [];
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of screens) {
      await page.evaluate(k => {
        closeSheets(); uiWorkoutView = null; view = 'fitness'; fitnessTab = ['templates', 'library', 'muscles'].includes(k) ? k : 'workouts'; uiPlannerDay = todayStr();
        const done = completedWorkouts(S).find(w => w.entries);
        if (k === 'live') uiWorkoutView = { mode: 'active' }; if (k === 'edit') uiWorkoutView = { mode: 'edit', id: done.id };
        if (k === 'planner' || k === 'home') view = k;
        render(); if (k === 'summary') openWorkoutSummary(done, true); if (k === 'tplform') openTemplateForm(S.workoutTemplates[0]);
      }, k);
      const r = await page.evaluate(() => {
        const s = document.querySelector('.sheet'); const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        const scope = s || document.getElementById('app');
        const small = [...scope.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 36 && !b.closest('.pl-block.is-compact') && !b.matches('.check, button.chip')) /* 8B: .check has a 46 px ::before hit area; chips are 30 px by design */.map(b => b.className.split(' ')[0] || b.textContent.trim());
        const clipped = [...scope.querySelectorAll('.stat-value,.pr-v,.wk-perf-score,.mu-lvl,.ws-in,.wk-sug-main')].filter(n => n.offsetParent && n.scrollWidth > n.clientWidth + 1).map(n => n.className);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i), small, clipped };
      });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length || r.small.length || r.clipped.length) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Phase 11B: Finance 2.0 model ----------
// finSetup: fixture (e1 Food 420 on 09-23, e2 Transport 1200 on 09-20, i1 Salary 42000 on 09-15, budget Food 6000,
// subscriptions Spotify 169 monthly next 09-27 + iCloud 790 yearly next 2027-01-21) plus 2 accounts and 4 transactions:
//   A1 bank opening 10000 (from 09-01): Housing -3000 (09-05), Food -850 (09-10), Other income +5000 (09-15)
//   A2 cash opening 2000 (from 09-01): Entertainment -300 (09-12)
// Hand totals for 2026-09: income 42000+5000 = 47000; expenses 420+1200+850+3000+300 = 5770; net 41230.
const finSetup = page => page.evaluate(() => {
  const acc = (name, type, ob) => financeAccountSave({ name, type, currency: 'CZK', openingBalance: ob, openingDate: '2026-09-01' }).account.id;
  const a1 = acc('Hlavní účet', 'bank', 10000), a2 = acc('Peněženka', 'cash', 2000);
  const cat = n => financeCategoryOf({ category: n }, null).id;
  const tx = (kind, amount, c, date, accountId, description) => financeSaveTransaction(kind, { amount, categoryId: cat(c), date, accountId, description }).tx.id;
  tx('expense', 3000, 'Housing', '2026-09-05', a1, 'Nájem'); tx('expense', 850, 'Food', '2026-09-10', a1, 'Restaurace');
  tx('income', 5000, 'Other income', '2026-09-15', a1, 'Bonus'); tx('expense', 300, 'Entertainment', '2026-09-12', a2, 'Kino');
  return { a1, a2 };
});
const fin = (page, fn, arg) => page.evaluate(new Function('arg', `return JSON.parse(JSON.stringify((${fn})(arg)))`), arg);

test('11B migration: old finance data is kept byte-identical; categories are seeded from defaults + history; idempotent; new collections empty', async ({ page }) => {
  const s = await stateOf(page); const fx = fixtureState();
  for (const k of ['expenses', 'income', 'budgets', 'subscriptions']) assert.deepEqual(s[k], fx[k], `${k} untouched`);
  assert.deepEqual([s.accounts, s.recurringFinance, s.savingsGoals, s.investments], [[], [], [], []]);
  const cats = s.financeCategories.map(c => [c.id, c.name, c.type, c.active]);
  for (const c of [['fcat_food', 'Food', 'expense', true], ['fcat_transport', 'Transport', 'expense', true], ['fcat_salary', 'Salary', 'income', true]]) assert.ok(cats.some(x => JSON.stringify(x) === JSON.stringify(c)), c[0]);
  assert.equal(s.schemaVersion, 8);
  const r = await page.evaluate(() => {
    const again = migrate(JSON.parse(JSON.stringify(S)));
    const legacy = o => { const st = Object.assign(defaultState(), o); delete st.financeCategories; return st; };
    const custom = migrate(legacy({ tasks: [], expenses: [{ id: 'x', amount: 5, category: 'Dárky', date: '2026-01-01' }], income: [{ id: 'y', amount: 9, category: 'Dárky', date: '2026-01-02' }] }));
    return { same: JSON.stringify(again.financeCategories) === JSON.stringify(S.financeCategories), gift: custom.financeCategories.find(c => c.name === 'Dárky'),
      label: financeCategoryLabel(S.expenses[0], 'expense'), fresh: defaultState().financeCategories };
  });
  assert.equal(r.same, true, 're-running migrate keeps the same categories');
  assert.deepEqual([r.gift.id, r.gift.type], ['fcat_darky', 'both'], 'a history-only name becomes a category (expense + income -> both)');
  assert.equal(r.label, 'Food', 'old transactions resolve their category by name');
  assert.deepEqual(r.fresh, [], 'defaultState itself is empty; seeding happens in migrate');
}, { state: fixtureState() });

test('11B transactions: create / edit / delete expense and income; validation; totals from real data only', async ({ page }) => {
  const { a1 } = await finSetup(page);
  const t = await fin(page, () => financeMonthTotals('2026-09'));
  assert.deepEqual([t.income, t.expenses, t.net, t.expenseCount, t.incomeCount], [47000, 5770, 41230, 5, 2]);
  assert.deepEqual(t.byCategory.map(c => [c.name, c.amount, c.pct]), [['Housing', 3000, 52], ['Food', 1270, 22], ['Transport', 1200, 20.8], ['Entertainment', 300, 5.2]],
    'old text "Food" (420) and new categoryId Food (850) are one category');
  assert.deepEqual(await fin(page, () => financeSaveTransaction('expense', { amount: 0, date: '2026-09-01' }).errors), { amount: 'invalid' });
  assert.deepEqual(await fin(page, () => financeSaveTransaction('expense', { amount: 5, date: '2026-02-30' }).errors), { date: 'invalid' });
  assert.deepEqual(await fin(page, () => financeSaveTransaction('income', { amount: 5, date: '2026-09-01', accountId: 'nope' }).errors), { accountId: 'invalid' });
  const r = await page.evaluate(a1 => {
    const e = financeSaveTransaction('expense', { amount: 99.999, categoryId: 'fcat_shopping', date: '2026-09-18', accountId: a1, description: 'Tričko', tags: 'móda, léto' }).tx;
    const edit = financeSaveTransaction('expense', { amount: 120, categoryId: 'fcat_shopping', date: '2026-09-18', accountId: a1, description: 'Tričko 2', tags: ['móda'] }, e.id);
    const i = financeSaveTransaction('income', { amount: 700, categoryId: 'fcat_salary', date: '2026-10-02' }).tx;
    const out = { e: JSON.parse(JSON.stringify(e)), sameId: edit.tx.id === e.id, created: edit.created, t1: financeMonthTotals('2026-09'), oct: financeMonthTotals('2026-10').income };
    out.delE = financeDeleteTransaction('expense', e.id); out.delI = financeDeleteTransaction('income', i.id); out.t2 = financeMonthTotals('2026-09');
    return out;
  }, a1);
  assert.deepEqual([r.e.amount, r.e.category, r.e.tags, r.sameId, r.created], [120, 'Shopping', ['móda'], true, false], 'edit keeps the id; amounts rounded to 0.01');
  assert.deepEqual([r.t1.expenses, r.oct, r.delE, r.delI, r.t2.expenses], [5890, 700, true, true, 5770], 'month filter + delete recompute');
}, { state: fixtureState() });

test('11B categories: create, edit (rename keeps history linked), deactivate/reactivate, used categories are never deleted', async ({ page }) => {
  await finSetup(page);
  assert.deepEqual(await fin(page, () => financeCategorySave({ name: ' food ', type: 'expense' }).errors), { name: 'duplicate' });
  assert.deepEqual(await fin(page, () => financeCategorySave({ name: '', type: 'expense' }).errors), { name: 'required' });
  const r = await page.evaluate(() => {
    const c = financeCategorySave({ name: 'Dárky', type: 'expense', icon: '🎁', color: '#ff0000' }).category;
    const e = financeSaveTransaction('expense', { amount: 500, categoryId: c.id, date: '2026-09-20' }).tx;
    financeCategorySave({ name: 'Jídlo a pití', type: 'expense', icon: '🍎' }, 'fcat_food');
    const old = S.expenses.find(x => x.id === 'e1');
    const out = { oldLabel: financeCategoryLabel(old, 'expense'), oldText: old.category, oldId: old.categoryId, food: financeMonthTotals('2026-09').byCategory.find(x => x.categoryId === 'fcat_food').amount };
    financeCategorySetActive(c.id, false);
    out.picker = financeCategoriesFor('expense').some(x => x.id === c.id); out.pickerKeep = financeCategoriesFor('expense', c.id).some(x => x.id === c.id);
    out.histLabel = financeCategoryLabel(S.expenses.find(x => x.id === e.id), 'expense');
    out.delUsed = financeCategoryDelete(c.id); out.stillThere = !!financeCategoryById(c.id);
    financeCategorySetActive(c.id, true); out.back = financeCategoriesFor('expense').some(x => x.id === c.id);
    const u = financeCategorySave({ name: 'Nepoužitá', type: 'income' }).category; out.delUnused = financeCategoryDelete(u.id);
    return out;
  });
  assert.deepEqual(r, { oldLabel: 'Jídlo a pití', oldText: 'Food', oldId: 'fcat_food', food: 1270, picker: false, pickerKeep: true, histLabel: 'Dárky', delUsed: 'deactivated', stillThere: true, back: true, delUnused: 'deleted' });
}, { state: fixtureState() });

test('11B accounts: balance = opening + income - expenses (from the opening date); checkpoint + difference never rewrite history', async ({ page }) => {
  const { a1, a2 } = await finSetup(page);
  assert.deepEqual(await fin(page, () => financeAccountSave({ name: '', type: 'bank' }).errors), { name: 'required' });
  assert.deepEqual(await fin(page, () => financeAccountSave({ name: 'X', type: 'crypto' }).errors), { type: 'invalid' });
  const r = await page.evaluate(({ a1, a2 }) => {
    const A1 = financeAccountById(a1), A2 = financeAccountById(a2);
    financeSaveTransaction('expense', { amount: 111, date: '2026-08-20', accountId: a1 }); // before the opening date: already inside the opening balance
    const before = JSON.stringify([S.expenses, S.income]);
    const bad = financeAccountAddCheckpoint(a1, { date: '2026-09-12', balance: '' }).errors;
    financeAccountAddCheckpoint(a1, { date: '2026-09-12', balance: 6000, note: 'výpis' });
    return { b1: financeAccountBalance(A1), b2: financeAccountBalance(A2), st: financeAccountStatus(A1), bad, untouched: JSON.stringify([S.expenses, S.income]) === before,
      at: financeBalanceAt('2026-09-30'), deact: (financeAccountSetActive(a2, false), financeAccountById(a2).active) };
  }, { a1, a2 });
  assert.deepEqual([r.b1, r.b2], [11150, 1700], 'A1 10000+5000-3000-850; A2 2000-300');
  assert.deepEqual([r.st.calculated, r.st.checkpoint.balance, r.st.calculatedAtCheckpoint, r.st.difference, r.st.fromCheckpoint], [11150, 6000, 6150, -150, 11000],
    'on 09-12 the calculation says 6150, the real balance was 6000 -> difference -150; after it +5000 income');
  assert.deepEqual([r.bad, r.untouched], [{ balance: 'invalid' }, true]);
  assert.equal(r.at, 11150 + 1700 + 42000 - 420 - 1200, 'all money at 09-30 = accounts + transactions without an account (the 111 before the opening date is already inside the opening balance)');
  assert.equal(r.deact, false);
}, { state: fixtureState() });

test('11B budgets: default + per-month override, spent / remaining / % / status, only expenses count', async ({ page }) => {
  await finSetup(page);
  assert.deepEqual(await fin(page, () => financeBudgetSave({ categoryId: 'nope', amount: 5 }).errors), { categoryId: 'required' });
  assert.deepEqual(await fin(page, () => financeBudgetSave({ categoryId: 'fcat_food', amount: -1 }).errors), { amount: 'invalid' });
  const r = await page.evaluate(() => {
    financeBudgetSave({ categoryId: 'fcat_food', amount: 9000, month: '2026-10', note: 'návštěva' });
    financeBudgetSave({ categoryId: 'fcat_housing', amount: 3200 });
    financeBudgetSave({ categoryId: 'fcat_entertainment', amount: 250 });
    financeBudgetSave({ categoryId: 'fcat_food', amount: 9500, month: '2026-10' }); // same slot -> replaced, not duplicated
    // income, savings and investments never touch a budget
    financeSaveTransaction('income', { amount: 999, categoryId: 'fcat_food', date: '2026-09-02' });
    const g = financeSavingsSave({ name: 'X', targetAmount: 100 }).goal; financeSavingsContribute(g.id, { amount: 50, date: '2026-09-02' });
    const u = m => financeBudgetUsage(m).map(b => [b.name, b.limit, b.spent, b.remaining, b.pct, b.status, b.override]);
    return { sep: u('2026-09'), oct: u('2026-10'), n: S.budgets.length };
  });
  assert.deepEqual(r.sep, [['Entertainment', 250, 300, -50, 120, 'over', false], ['Housing', 3200, 3000, 200, 93.8, 'near', false], ['Food', 6000, 1270, 4730, 21.2, 'under', false]]);
  assert.deepEqual(r.oct.find(b => b[0] === 'Food'), ['Food', 9500, 0, 9500, 0, 'under', true], 'October uses its own override; September keeps the default');
  assert.equal(r.n, 4, 'legacy Food default + Food October + Housing + Entertainment');
}, { state: fixtureState() });

test('11B recurring + subscriptions: a plan is never money; confirming creates ONE transaction; nothing is counted twice', async ({ page }) => {
  const { a1 } = await finSetup(page);
  assert.deepEqual(await fin(page, () => financeRecurringSave({ name: 'x', type: 'expense', amount: 0, frequency: 'monthly', startDate: '2026-09-01' }).errors), { amount: 'invalid' });
  const r = await page.evaluate(a1 => {
    const net = financeRecurringSave({ type: 'expense', name: 'Nájem garáže', amount: 1500, categoryId: 'fcat_housing', accountId: a1, frequency: 'monthly', startDate: '2026-01-31' }).recurring;
    const out = { totals0: financeMonthTotals('2026-09').expenses, exp0: financeExpectedMonth('2026-09') };
    out.feb = financeOccurrences('monthly', '2026-01-31', '2026-02-01', '2026-02-28'); out.weekly = financeOccurrences('weekly', '2026-09-02', '2026-09-01', '2026-09-30');
    const c1 = financeConfirmExpected('recurring', net.id, '2026-09-30'); const c2 = financeConfirmExpected('recurring', net.id, '2026-09-30');
    out.c = [c1.created, c2.created, c1.tx.id === c2.tx.id, c1.tx.recurringId === net.id, c1.tx.recurringFor, c1.tx.accountId === a1, c1.tx.categoryId];
    out.totals1 = financeMonthTotals('2026-09').expenses; out.exp1 = financeExpectedMonth('2026-09');
    // Spotify subscription (09-27): expected until paid, then one expense
    const s1 = financeConfirmExpected('subscription', 's1', '2026-09-27'); out.sub = [s1.tx.subscriptionId, s1.tx.recurringFor, s1.tx.amount, s1.tx.category];
    out.totals2 = financeMonthTotals('2026-09').expenses; out.exp2 = financeExpectedMonth('2026-09');
    // a plan that covers an existing subscription replaces it in the list (Netflix: subscription + plan + payment = 299 once)
    S.subscriptions.push({ id: 's3', name: 'Netflix', price: 299, period: 'Monthly', nextPayment: '2026-10-05', category: '', notes: '', active: true, createdAt: Date.parse('2026-09-01') });
    const nf = financeRecurringSave({ type: 'expense', name: 'Netflix', amount: 299, frequency: 'monthly', startDate: '2026-09-05', subscriptionId: 's3' }).recurring;
    out.nfList = financeExpectedMonth('2026-09').items.filter(i => i.name === 'Netflix').map(i => i.source);
    financeConfirmExpected('recurring', nf.id, '2026-09-05');
    out.totals3 = financeMonthTotals('2026-09').expenses; out.nfList2 = financeExpectedMonth('2026-09').items.filter(i => i.name === 'Netflix').map(i => [i.source, !!i.realized]);
    out.monthly = [financeMonthlyEquivalent(100, 'weekly'), financeMonthlyEquivalent(1200, 'yearly')];
    return JSON.parse(JSON.stringify(out));
  }, a1);
  assert.equal(r.totals0, 5770, 'creating a plan adds no money');
  assert.deepEqual(r.exp0.items.map(i => [i.source, i.name, i.date, !!i.realized]), [['subscription', 'Spotify', '2026-09-27', false], ['recurring', 'Nájem garáže', '2026-09-30', false]]);
  assert.deepEqual([r.exp0.pendingExpense, r.feb, r.weekly], [1669, ['2026-02-28'], ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30']], '31st -> last day of February');
  assert.deepEqual(r.c, [true, false, true, true, '2026-09-30', true, 'fcat_housing'], 'confirm twice -> the same single transaction');
  assert.deepEqual([r.totals1, r.exp1.pendingExpense, r.exp1.realized], [7270, 169, 1]);
  assert.deepEqual([...r.sub, r.totals2, r.exp2.pendingExpense], ['s1', '2026-09-27', 169, 'Subscriptions', 7439, 0]);
  assert.deepEqual([r.nfList, r.totals3, r.nfList2], [['recurring'], 7738, [['recurring', true]]], 'subscription + plan + payment = 299 counted once');
  assert.deepEqual(r.monthly, [433.33, 100]);
}, { state: fixtureState() });

test('11B savings: contributions, progress, remaining, deadline maths (monthly / weekly / overdue)', async ({ page }) => {
  assert.deepEqual(await fin(page, () => financeSavingsSave({ name: 'X', targetAmount: 0 }).errors), { targetAmount: 'invalid' });
  const r = await page.evaluate(() => {
    const g = financeSavingsSave({ name: 'Dovolená', targetAmount: 30000, deadline: '2027-03-23' }).goal;
    const bad = financeSavingsContribute(g.id, { amount: 0, date: '2026-09-01' }).errors;
    financeSavingsContribute(g.id, { amount: 5000, date: '2026-09-01', note: 'start' }); financeSavingsContribute(g.id, { amount: 2500, date: '2026-09-15' });
    const late = financeSavingsSave({ name: 'Late', targetAmount: 1000, deadline: '2026-09-01' }).goal; financeSavingsContribute(late.id, { amount: 400, date: '2026-08-01' });
    const done = financeSavingsSave({ name: 'Done', targetAmount: 100 }).goal; financeSavingsContribute(done.id, { amount: 150, date: '2026-09-01' }); financeSavingsContribute(done.id, { amount: -20, date: '2026-09-02' });
    return { p: financeSavingsProgress(g), late: financeSavingsProgress(late), done: financeSavingsProgress(done), bad, month: financeMonthTotals('2026-09').savingsContributions, total: financeSavingsTotal() };
  });
  assert.deepEqual(r.bad, { amount: 'invalid' });
  const p = r.p;
  assert.deepEqual([p.current, p.target, p.remaining, p.pct, p.daysLeft, p.monthsLeft], [7500, 30000, 22500, 25, 181, 5.9]);
  assert.deepEqual([p.requiredMonthly, p.requiredWeekly], [3783.67, 870.17], '22500 / (181 / 30.4375) and 22500 / (181 / 7)');
  assert.deepEqual([r.late.overdue, r.late.requiredMonthly, r.late.remaining], [true, 600, 600], 'deadline passed: the whole remainder is due now');
  assert.deepEqual([r.done.current, r.done.remaining, r.done.pct, r.done.done, r.done.requiredMonthly], [130, 0, 100, true, null], 'withdrawal as a negative contribution');
  assert.deepEqual([r.month, r.total], [7500 + 150 - 20, 7500 + 400 + 130]);
}, { state: fixtureState() });

test('11B investments: contributions + manual valuations -> invested, value, gain, %; month change split into new money and market change', async ({ page }) => {
  const r = await page.evaluate(() => {
    const etf = financeInvestmentSave({ name: 'World ETF', ticker: 'vwce', type: 'etf' }).investment;
    financeInvestmentAdd(etf.id, 'contribution', { amount: 10000, date: '2026-08-01' }); financeInvestmentAdd(etf.id, 'valuation', { value: 10400, date: '2026-08-31' });
    financeInvestmentAdd(etf.id, 'contribution', { amount: 5000, date: '2026-09-10' }); financeInvestmentAdd(etf.id, 'valuation', { value: 16500, date: '2026-09-20' });
    const bad = [financeInvestmentAdd(etf.id, 'valuation', { value: -1, date: '2026-09-21' }).errors, financeInvestmentAdd(etf.id, 'contribution', { amount: 0, date: '2026-09-21' }).errors];
    const nov = financeInvestmentSave({ name: 'Spořicí dluhopis', type: 'bond' }).investment; financeInvestmentAdd(nov.id, 'contribution', { amount: 2000, date: '2026-09-01' });
    return { etf: financeInvestmentPerformance(etf), aug: financeInvestmentPerformance(etf, '2026-08-31'), nov: financeInvestmentPerformance(nov), sum: financeInvestmentsSummary(), ch: financeInvestmentMonthChange('2026-09'), bad, ticker: etf.ticker };
  });
  assert.deepEqual([r.etf.invested, r.etf.value, r.etf.gain, r.etf.pct, r.etf.hasValuation], [15000, 16500, 1500, 10, true]);
  assert.deepEqual([r.aug.invested, r.aug.value, r.aug.gain, r.aug.pct], [10000, 10400, 400, 4]);
  assert.deepEqual([r.nov.value, r.nov.gain, r.nov.hasValuation], [2000, 0, false], 'no valuation yet: value = invested, flagged');
  assert.deepEqual([r.sum.invested, r.sum.value, r.sum.gain, r.sum.pct], [17000, 18500, 1500, 8.8]);
  assert.deepEqual([r.ch.valueStart, r.ch.valueEnd, r.ch.change, r.ch.contributions, r.ch.marketChange], [10400, 18500, 8100, 7000, 1100]);
  assert.deepEqual(r.bad, [{ value: 'invalid' }, { amount: 'invalid' }]); assert.equal(r.ticker, 'VWCE');
}, { state: fixtureState() });

test('11B review + series: facts for a month from the same helpers; empty months are zero, never invented', async ({ page }) => {
  const { a1 } = await finSetup(page);
  const r = await fin(page, a1 => { const rv = financeMonthReview('2026-09'); const empty = financeMonthReview('2025-01');
    return { t: [rv.totals.income, rv.totals.expenses, rv.totals.net], top: rv.topCategories.map(c => c.name), acc: rv.accounts.map(a => [a.account.name, a.balance]), end: rv.balanceEnd,
      empty: [empty.totals.income, empty.totals.expenses, empty.topCategories.length, empty.budgets.map(b => b.spent)], series: financeMonthSeries('2026-09', 3).map(x => [x.ym, x.income, x.expenses, x.net]) }; }, a1);
  assert.deepEqual(r.t, [47000, 5770, 41230]);
  assert.deepEqual(r.top, ['Housing', 'Food', 'Transport', 'Entertainment']);
  assert.deepEqual(r.acc, [['Hlavní účet', 11150], ['Peněženka', 1700]]);
  assert.equal(r.end, 11150 + 1700 + 42000 - 1620);
  assert.deepEqual(r.empty, [0, 0, 0, [0]]);
  assert.deepEqual(r.series, [['2026-07', 0, 0, 0], ['2026-08', 0, 0, 0], ['2026-09', 47000, 5770, 41230]]);
}, { state: fixtureState() });

test('11B XP: only a NEW transaction runs the existing once-a-day Finance XP; categories, budgets, accounts, plans, savings, investments and edits grant nothing', async ({ page }) => {
  const x = () => page.evaluate(() => ({ xp: S.totalXp, wis: S.attrs.WIS, log: S.xpLog.length }));
  await page.evaluate(() => { S.financeXpDate = null; });
  const x0 = await x();
  const { a1 } = await page.evaluate(() => {
    const a1 = financeAccountSave({ name: 'A', type: 'bank' }).account.id; financeCategorySave({ name: 'Nové', type: 'expense' }); financeBudgetSave({ categoryId: 'fcat_food', amount: 1 });
    financeRecurringSave({ type: 'expense', name: 'R', amount: 1, frequency: 'monthly', startDate: '2026-10-01' }); const g = financeSavingsSave({ name: 'G', targetAmount: 1 }).goal; financeSavingsContribute(g.id, { amount: 1, date: '2026-09-01' });
    const i = financeInvestmentSave({ name: 'I' }).investment; financeInvestmentAdd(i.id, 'valuation', { value: 1, date: '2026-09-01' }); financeAccountAddCheckpoint(a1, { date: '2026-09-01', balance: 1 });
    return { a1 };
  });
  assert.deepEqual(await x(), x0, 'no XP for setting things up');
  const id = await page.evaluate(() => financeSaveTransaction('expense', { amount: 10, date: todayStr() }).tx.id);
  const x1 = await x();
  assert.equal(x1.xp - x0.xp, 5, '+5 WIS XP (existing rule), once per day');
  await page.evaluate(id => { financeSaveTransaction('income', { amount: 10, date: todayStr() }); financeSaveTransaction('expense', { amount: 11, date: todayStr() }, id); }, id);
  assert.equal((await x()).xp, x1.xp, 'second transaction the same day and an edit: nothing');
  void a1;
}, { state: fixtureState() });

// ---------- Phase 11B: Finance 2.0 UI ----------
const T_ = async loc => (await loc.innerText()).replace(/[\u00a0\u202f]/g, ' ');
const finGo = (page, v = 'dashboard', ym = null) => page.evaluate(({ v, ym }) => { closeSheets(); view = 'home'; render(); finKeepView = true; finView = v; finMonth = ym; view = 'finance'; render(); window.scrollTo(0, 0); }, { v, ym });
const kpi = async (page, id) => (await T_(page.locator('#' + id + ' .stat-value'))).replace(/\s/g, '');

test('11B UI: dashboard KPIs, month selector, expected payments, budgets and charts show the real month numbers', async ({ page }) => {
  await finSetup(page);
  await finGo(page);
  assert.match(await T_(page.locator('#finMonthLabel')), /Září 2026/);
  assert.deepEqual([await kpi(page, 'kpiNet'), await kpi(page, 'kpiInc'), await kpi(page, 'kpiExp')], ['+41230', '47000', '5770']);
  assert.match(await kpi(page, 'kpiBud'), /21%/, 'Food 1270 of 6000 (the only budget)');
  const ex = await T_(page.locator('#finExpected'));
  assert.match(ex, /Spotify[\s\S]*27\.09\.2026[\s\S]*−169[\s\S]*Zaplaceno/);
  assert.match(await T_(page.locator('.fin-hbars').first()), /Bydlení[\s\S]*3 000 · 52 %[\s\S]*Jídlo[\s\S]*1 270 · 22 %/);
  assert.equal(await page.locator('.fin-cols .fin-col').count(), 6);
  assert.match((await page.locator('.fin-cols').getAttribute('aria-label')).replace(/[\u00a0\u202f]/g, ' '), /Září 2026: Příjmy 47 000, Výdaje 5 770/);
  assert.equal(await page.locator('.fin-line circle title').count(), 6, 'balance trend: 6 points with tooltips');
  // previous month: nothing there -> zeros and empty states, never invented
  await page.click('#finPrev');
  assert.deepEqual([await kpi(page, 'kpiNet'), await kpi(page, 'kpiInc'), await kpi(page, 'kpiExp')], ['+0', '0', '0']);
  assert.match(await T_(page.locator('.fin-charts')), /Za toto období nejsou data/);
  assert.equal(await page.locator('#finThisMonth').count(), 1);
  await page.click('#finThisMonth');
  assert.match(await T_(page.locator('#finMonthLabel')), /Září 2026/);
  await page.fill('#finMonthInput', '2026-10'); await page.dispatchEvent('#finMonthInput', 'change');
  assert.match(await T_(page.locator('#finMonthLabel')), /Říjen 2026/);
}, { state: fixtureState() });

test('11B UI: expense and income create / edit / delete through the form and the detail sheet', async ({ page }) => {
  const { a1 } = await finSetup(page);
  await finGo(page);
  await page.click('#addExp');
  await page.click('#f_save');
  assert.match(await T_(page.locator('[data-err="f_amt"]')), /větší než 0/);
  await page.fill('#f_amt', '249.5'); await page.selectOption('#f_cat', 'fcat_shopping'); await page.selectOption('#f_acc', a1);
  await page.fill('#f_date', '2026-09-21'); await page.fill('#f_desc', 'Batoh'); await page.fill('#f_tags', 'výlet, léto'); await page.click('#f_save');
  let x = (await stateOf(page)).expenses.find(e => e.description === 'Batoh');
  assert.deepEqual([x.amount, x.categoryId, x.category, x.accountId, x.tags], [249.5, 'fcat_shopping', 'Shopping', a1, ['výlet', 'léto']]);
  assert.equal(await kpi(page, 'kpiExp'), '6019,5');
  await page.click(`.fin-tx[data-tx="${x.id}"]`);
  assert.match(await T_(page.locator('.fin-detail')), /Batoh[\s\S]*−249,5[\s\S]*Nákupy[\s\S]*Hlavní účet[\s\S]*výlet, léto/);
  await page.click('#fd_edit'); await page.fill('#f_amt', '300'); await page.click('#f_save');
  x = (await stateOf(page)).expenses.find(e => e.id === x.id);
  assert.equal(x.amount, 300);
  await page.click(`.fin-tx[data-tx="${x.id}"]`); await page.click('#fd_del'); await page.click('#cf_ok');
  assert.equal((await stateOf(page)).expenses.some(e => e.id === x.id), false);
  await page.click('#addInc'); await page.fill('#f_amt', '1500'); await page.selectOption('#f_cat', 'fcat_salary'); await page.fill('#f_desc', 'Brigáda'); await page.fill('#f_date', '2026-09-22'); await page.click('#f_save');
  const inc = (await stateOf(page)).income.find(i => i.description === 'Brigáda');
  assert.equal(await kpi(page, 'kpiInc'), '48500');
  await page.click(`.fin-tx[data-tx="${inc.id}"]`); await page.click('#fd_edit'); await page.fill('#f_amt', '1600'); await page.click('#f_save');
  assert.equal(await kpi(page, 'kpiInc'), '48600');
  await page.click(`.fin-tx[data-tx="${inc.id}"]`); await page.click('#fd_del'); await page.click('#cf_ok');
  assert.equal(await kpi(page, 'kpiInc'), '47000');
  // "repeat as a plan": the transaction is the first realized occurrence -> counted once
  await page.click('#addExp'); await page.fill('#f_amt', '450'); await page.fill('#f_desc', 'Posilovna'); await page.fill('#f_date', '2026-09-03'); await page.selectOption('#f_repeat', 'monthly'); await page.click('#f_save');
  const s = await stateOf(page); const tx = s.expenses.find(e => e.description === 'Posilovna'); const plan = s.recurringFinance.find(r => r.name === 'Posilovna');
  assert.deepEqual([tx.recurringId, tx.recurringFor, plan.startDate, plan.amount], [plan.id, '2026-09-03', '2026-09-03', 450]);
  assert.equal(await kpi(page, 'kpiExp'), '6220');
  assert.match(await T_(page.locator('#finExpected')), /Posilovna[\s\S]*zaplaceno/);
}, { state: fixtureState() });

test('11B UI: categories, budgets (default + override), accounts with checkpoint, savings contribution, investment valuation, recurring confirm', async ({ page }) => {
  const { a1 } = await finSetup(page);
  // categories
  await finGo(page, 'cats');
  await page.click('#addCat'); await page.fill('#fc_name', 'Dárky'); await page.fill('#fc_icon', '🎁'); await page.click('#fc_save');
  const gift = (await stateOf(page)).financeCategories.find(c => c.name === 'Dárky');
  await page.click(`[data-fcat="${gift.id}"] .catAct`);
  assert.equal((await stateOf(page)).financeCategories.find(c => c.id === gift.id).active, false);
  await page.click(`[data-fcat="fcat_food"] .catEdit`); await page.fill('#fc_name', 'Jídlo a pití'); await page.click('#fc_save');
  assert.match(await T_(page.locator('[data-fcat="fcat_food"]')), /Jídlo a pití/);
  // budgets
  await finGo(page, 'budgets', '2026-09');
  await page.click('#addBud'); await page.selectOption('#b_cat', 'fcat_housing'); await page.fill('#b_amt', '3200'); await page.click('#b_save');
  await page.click('#addBud'); await page.selectOption('#b_cat', 'fcat_housing'); await page.fill('#b_amt', '2500'); await page.selectOption('#b_scope', '2026-09'); await page.click('#b_save');
  assert.match(await T_(page.locator('#finBudList')), /Bydlení[\s\S]*3 000 \/ 2 500[\s\S]*nad limitem · 120 %[\s\S]*přes o 500/);
  await page.click('#finNext');
  assert.match(await T_(page.locator('#finBudList')), /Bydlení[\s\S]*0 \/ 3 200/, 'October falls back to the default');
  // accounts
  await finGo(page, 'accounts');
  assert.match(await T_(page.locator(`[data-account="${a1}"]`)), /Hlavní účet[\s\S]*11 150/);
  await page.click(`[data-account="${a1}"]`); await page.fill('#cp_bal', '6000'); await page.fill('#cp_date', '2026-09-12'); await page.click('#cp_save');
  assert.match(await T_(page.locator('#accDetail')), /Vypočtený zůstatek[\s\S]*11 150[\s\S]*Poslední kontrola[\s\S]*6 000[\s\S]*Rozdíl ke dni kontroly[\s\S]*−150/);
  await page.evaluate(() => closeSheets());
  await page.click('#addAcc'); await page.fill('#a_name', 'Spořák'); await page.selectOption('#a_type', 'bank'); await page.fill('#a_open', '50000'); await page.click('#a_save');
  assert.match(await T_(page.locator('#finAccList')), /Spořák[\s\S]*50 000/);
  // savings
  await finGo(page, 'savings');
  await page.click('#addGoal'); await page.fill('#g_name', 'Dovolená'); await page.fill('#g_target', '30000'); await page.fill('#g_dead', '2027-03-23'); await page.click('#g_save');
  const gid = (await stateOf(page)).savingsGoals[0].id;
  await page.click(`[data-goal="${gid}"]`); await page.fill('#c_amt', '7500'); await page.click('#c_save');
  assert.match(await T_(page.locator('#goalDetail')), /7 500 \/ 30 000 \(25 %\)[\s\S]*22 500[\s\S]*3 783,67 měsíčně · 870,17 týdně/);
  await page.evaluate(() => closeSheets());
  // investments
  await finGo(page, 'invest');
  await page.click('#addInv'); await page.fill('#i_name', 'World ETF'); await page.fill('#i_ticker', 'vwce'); await page.fill('#i_first', '15000'); await page.fill('#i_fdate', '2026-08-01'); await page.click('#i_save');
  const iid = (await stateOf(page)).investments[0].id;
  await page.click(`[data-investment="${iid}"]`); await page.fill('#iv_val', '16500'); await page.fill('#iv_date', '2026-09-20'); await page.click('#iv_save');
  assert.match(await T_(page.locator('#invDetail')), /16 500[\s\S]*Vloženo[\s\S]*15 000[\s\S]*\+1 500 · \+10 %/);
  await page.evaluate(() => closeSheets());
  // recurring: create a plan, confirm it once
  await finGo(page, 'recurring', '2026-09');
  await page.click('#addRec'); await page.fill('#r_name', 'Internet'); await page.fill('#r_amt', '600'); await page.fill('#r_start', '2026-09-10'); await page.click('#r_save');
  const e0 = (await stateOf(page)).expenses.length;
  await page.locator('[data-exp^="recurring:"]', { hasText: 'Internet' }).locator('.finConfirm').click();
  const e1 = await stateOf(page);
  assert.equal(e1.expenses.length, e0 + 1);
  assert.match(await T_(page.locator('[data-exp^="recurring:"]', { hasText: 'Internet' })), /zaplaceno/);
  assert.equal(await page.locator('[data-exp^="recurring:"]', { hasText: 'Internet' }).locator('.finConfirm').count(), 0, 'no second confirm');
  void gift;
}, { state: fixtureState() });

test('11B integration: Home = Finance, Statistics, Search, Quick Add, subscriptions never double counted', async ({ page }) => {
  await finSetup(page);
  await page.evaluate(() => { view = 'home'; render(); });
  const homeNet = await page.getAttribute('[data-nav="finance"] [data-fin-net]', 'data-fin-net');
  const finNet = await page.evaluate(() => financeMonthTotals(finYm()).net);
  assert.equal(Number(homeNet), finNet);
  assert.equal(finNet, 41230);
  const st = await page.evaluate(() => { const g = financeSavingsSave({ name: 'G', targetAmount: 100 }).goal; financeSavingsContribute(g.id, { amount: 40, date: '2026-09-01' });
    const i = financeInvestmentSave({ name: 'I' }).investment; financeInvestmentAdd(i.id, 'contribution', { amount: 100, date: '2026-09-01' }); financeInvestmentAdd(i.id, 'valuation', { value: 130, date: '2026-09-02' });
    const s = computeStats('year').finance; return [s.income, s.expenses, s.balance, s.savings, s.investments, s.byCategory.Housing]; });
  assert.deepEqual(st, [47000, 5770, 41230, 40, 130, 3000]);
  await page.evaluate(() => { statsPeriod = 'year'; view = 'statistics'; render(); });
  assert.match((await appText(page)).replace(/[\u00a0\u202f]/g, ' '), /Úspory\s*40[\s\S]*Investice\s*130/);
  // Search
  const g = await page.evaluate(() => searchGroups('hlavní').map(x => [x[2], x[3].map(i => i.title)]).filter(x => x[1].length));
  assert.deepEqual(g, [['account', ['Hlavní účet']]]);
  await page.evaluate(() => searchNavigate('account', S.accounts[0]));
  assert.equal(await page.locator('#accDetail').count(), 1);
  await page.evaluate(() => { closeSheets(); searchNavigate('expense', S.expenses.find(e => e.description === 'Nájem')); });
  assert.match(await T_(page.locator('.fin-detail')), /Nájem[\s\S]*3 000/);
  assert.ok(await page.evaluate(() => searchGroups('bydlení').some(x => x[2] === 'expense' && x[3].length)), 'expenses found by category name');
  // Quick Add -> the Finance 2.0 form
  await page.evaluate(() => { closeSheets(); view = 'home'; render(); });
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="expense"]');
  assert.equal(await page.locator('#f_acc').count(), 1);
  await page.fill('#f_amt', '99'); await page.selectOption('#f_cat', 'fcat_food'); await page.click('#f_save');
  assert.equal(await page.evaluate(() => financeMonthTotals(finYm()).expenses), 5869);
  // subscription + plan covering it + payment = counted once (Netflix 299)
  const r = await page.evaluate(() => {
    S.subscriptions.push({ id: 'nf', name: 'Netflix', price: 299, period: 'Monthly', nextPayment: '2026-09-25', category: '', notes: '', active: true, createdAt: Date.parse('2026-09-01') });
    const before = financeMonthTotals('2026-09').expenses;
    const p = financeRecurringSave({ type: 'expense', name: 'Netflix', amount: 299, frequency: 'monthly', startDate: '2026-09-25', subscriptionId: 'nf' }).recurring;
    const listed = financeExpectedMonth('2026-09').items.filter(i => i.name === 'Netflix').length;
    financeConfirmExpected('recurring', p.id, '2026-09-25'); financeConfirmExpected('subscription', 'nf', '2026-09-25');
    return { before, after: financeMonthTotals('2026-09').expenses, listed, n: S.expenses.filter(e => e.description === 'Netflix').length };
  });
  assert.deepEqual(r, { before: 5869, after: 6168, listed: 1, n: 1 }, 'one Netflix payment of 299, not 598 or 897');
}, { state: classicState() });

test('11B data: reload, export/import of every Finance collection, old backup, reset (no orphans, UI works)', async ({ page }) => {
  await finSetup(page);
  await page.evaluate(() => {
    financeBudgetSave({ categoryId: 'fcat_food', amount: 9000, month: '2026-10' });
    financeRecurringSave({ type: 'income', name: 'Nájem od podnájemníka', amount: 4000, frequency: 'monthly', startDate: '2026-09-01' });
    const g = financeSavingsSave({ name: 'G', targetAmount: 100 }).goal; financeSavingsContribute(g.id, { amount: 40, date: '2026-09-01' });
    const i = financeInvestmentSave({ name: 'I' }).investment; financeInvestmentAdd(i.id, 'contribution', { amount: 100, date: '2026-09-01' }); financeInvestmentAdd(i.id, 'valuation', { value: 130, date: '2026-09-02' });
    financeAccountAddCheckpoint(S.accounts[0].id, { date: '2026-09-12', balance: 6000 }); financeCategorySave({ name: 'Dárky', type: 'both' });
  });
  const K = ['expenses', 'income', 'budgets', 'financeCategories', 'recurringFinance', 'accounts', 'savingsGoals', 'investments', 'subscriptions'];
  const snap = () => page.evaluate(K => JSON.stringify(K.map(k => S[k])), K);
  const s0 = await snap();
  await persist(page); await reload(page);
  assert.deepEqual(JSON.parse(await snap()), JSON.parse(s0), 'reload (same data; key order may differ after migrate)');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(K.filter(k => !(k in backup)), [], 'every collection is in the backup');
  assert.ok(backup.savingsGoals[0].contributions.length && backup.investments[0].valuations.length && backup.accounts[0].checkpoints.length);
  await page.evaluate(K => K.forEach(k => { S[k] = []; }), K);
  await importFile(page, file);
  await page.waitForFunction(() => S.investments.length === 1);
  assert.deepEqual(JSON.parse(await snap()), JSON.parse(s0), 'import restores all of it');
  const old = fixtureState();
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => S.investments.length === 0 && S.accounts.length === 0);
  const o = await stateOf(page);
  assert.deepEqual([o.expenses, o.income, o.budgets, o.subscriptions], [old.expenses, old.income, old.budgets, old.subscriptions], 'old backup: untouched');
  assert.ok(o.financeCategories.length >= 11);
  await finGo(page); assert.match((await appText(page)).replace(/[\u00a0\u202f]/g, ' '), /Září 2026/);
  page.on('dialog', d => d.accept());
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual(await page.evaluate(K => K.map(k => S[k]), K), K.map(() => []), 'reset empties every Finance collection');
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); view = 'finance'; render(); });
  assert.match((await appText(page)).replace(/[\u00a0\u202f]/g, ' '), /V tomto měsíci žádné transakce/);
}, { state: fixtureState() });

test('11B UI: every Finance screen and sheet fits 320-1440 px (long names, big amounts) without overflow, clipping or duplicate ids', async ({ page }) => {
  await page.evaluate(() => {
    const a = financeAccountSave({ name: 'Velmi dlouhý název bankovního účtu u Komerční banky – rodinný', type: 'bank', openingBalance: 123456789.55, openingDate: '2026-01-01' }).account.id;
    const c = financeCategorySave({ name: 'Kategorie s opravdu extrémně dlouhým názvem pro test', type: 'expense' }).category.id;
    financeSaveTransaction('expense', { amount: 98765432.1, categoryId: c, accountId: a, date: '2026-09-10', description: 'Popis transakce, který je hodně dlouhý a nevejde se na jeden řádek' });
    financeSaveTransaction('income', { amount: 123456789, categoryId: 'fcat_salary', date: '2026-09-11' });
    financeBudgetSave({ categoryId: c, amount: 50000000 });
    financeRecurringSave({ type: 'expense', name: 'Opakovaná platba s dlouhým názvem za pojištění domácnosti', amount: 1234567, frequency: 'monthly', startDate: '2026-09-28', accountId: a });
    const g = financeSavingsSave({ name: 'Spořicí cíl na nové auto pro celou rodinu a výlety', targetAmount: 1500000, deadline: '2027-12-31' }).goal; financeSavingsContribute(g.id, { amount: 250000, date: '2026-09-01' });
    const i = financeInvestmentSave({ name: 'iShares Core MSCI World UCITS ETF USD (Acc)', ticker: 'SWDA.L', type: 'etf' }).investment; financeInvestmentAdd(i.id, 'contribution', { amount: 9999999, date: '2026-08-01' }); financeInvestmentAdd(i.id, 'valuation', { value: 12345678, date: '2026-09-01' });
    financeAccountAddCheckpoint(a, { date: '2026-09-12', balance: 30000000 });
  });
  const pages = ['dashboard', 'tx', 'budgets', 'accounts', 'savings', 'invest', 'recurring', 'cats', 'review'];
  const sheets = { exp: () => openFinanceForm('expense'), bud: () => openBudgetForm(), acc: () => openAccountDetail(S.accounts[0]), goal: () => openSavingsDetail(S.savingsGoals[0]),
    inv: () => openInvestmentDetail(S.investments[0]), rec: () => openRecurringForm(S.recurringFinance[0]), cat: () => openFinanceCategoryForm(S.financeCategories[0]), txd: () => openFinanceTxDetail('expense', S.expenses[S.expenses.length - 1]) };
  const bad = [];
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const k of [...pages, ...Object.keys(sheets)]) {
      await page.evaluate(({ k, pages }) => { closeSheets(); finKeepView = true; finView = pages.includes(k) ? k : 'dashboard'; finMonth = '2026-09'; view = 'finance'; render(); }, { k, pages });
      if (sheets[k]) await page.evaluate(k => ({ exp: () => openFinanceForm('expense'), bud: () => openBudgetForm(), acc: () => openAccountDetail(S.accounts[0]), goal: () => openSavingsDetail(S.savingsGoals[0]),
        inv: () => openInvestmentDetail(S.investments[0]), rec: () => openRecurringForm(S.recurringFinance[0]), cat: () => openFinanceCategoryForm(S.financeCategories[0]), txd: () => openFinanceTxDetail('expense', S.expenses[S.expenses.length - 1]) })[k](), k);
      const r = await page.evaluate(() => {
        const s = document.querySelector('.sheet'), scope = s || document.getElementById('app'); const ids = [...document.querySelectorAll('[id]')].map(n => n.id);
        const clipped = [...scope.querySelectorAll('.stat-value,.fin-amt,.fin-big,.big,.num')].filter(n => n.offsetParent && n.getBoundingClientRect().right > (s ? s.getBoundingClientRect().right : document.documentElement.clientWidth) + 1).map(n => n.textContent.trim().slice(0, 20));
        const small = [...scope.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 36 && !b.matches('button.chip')).map(b => b.id || b.className);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: s ? s.scrollWidth - s.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i), clipped, small };
      });
      if (r.over > 0 || r.sheetOver > 0 || r.dup.length || r.clipped.length || r.small.length) bad.push(`${k}@${width}: ${JSON.stringify(r)}`);
    }
  }
  assert.deepEqual(bad, []);
  void sheets;
}, { state: fixtureState() });

// ---------- Polish pass 1 ----------
const PPW = [320, 375, 390, 430, 768, 1024, 1440];
const overflowOf = page => page.evaluate(() => {
  const vw = document.documentElement.clientWidth, bad = [];
  if (document.documentElement.scrollWidth > vw) bad.push('page ' + (document.documentElement.scrollWidth - vw));
  document.querySelectorAll('.sheet *').forEach(n => { const r = n.getBoundingClientRect(); if (r.width && (r.right > vw + 1 || r.left < -1)) bad.push((n.id || n.className || n.tagName) + ' ' + Math.round(r.right)); });
  return bad.slice(0, 5);
});
const dupIds = page => page.evaluate(() => { const seen = {}; document.querySelectorAll('[id]').forEach(n => { seen[n.id] = (seen[n.id] || 0) + 1; }); return Object.entries(seen).filter(([, c]) => c > 1).map(([k]) => k); });
const EMOJI_RX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B50}\u{23F0}-\u{23FA}]/u;

test('P1 quests: the board is picked from real relevance (priority tasks, planner, training day), stable for the day, max 3', async ({ page }) => {
  const b = await page.evaluate(() => questBoardFor('daily').map(x => x.q.id));
  assert.equal(b.length, 3);
  assert.equal(b[0], 'dq_priority', 'a High/Urgent task is due today -> the priority mission comes first');
  assert.ok(b.includes('dq_plan_all'), 'planner blocks today -> the planner mission');
  assert.ok(!b.includes('dq_workout'), 'no workout planned today (no training days, no Fitness event) -> no workout quest');
  // relevance follows the user's real day: training days make the workout quest relevant
  const withTraining = await page.evaluate(() => { S.settings.trainingDays = [3]; return questCandidates('daily', todayStr()).map(x => x.q.id); });
  assert.ok(withTraining.includes('dq_workout') || withTraining.includes('dq_workout_pr'), 'Wednesday is a training day');
  // the board itself stays as picked for the whole day
  assert.deepEqual(await page.evaluate(() => questBoardFor('daily').map(x => x.q.id)), b, 'stable during the day');
  const w = await page.evaluate(() => questBoardFor('weekly').map(x => x.q.id));
  assert.equal(w.length, 3);
  // an empty profile still gets a sensible, non-random fallback
  const empty = await page.evaluate(() => { const keep = S; S = migrate(defaultState()); S.settings.onboarded = true; const r = questCandidates('daily', todayStr()).map(x => x.q.id); S = keep; return r; });
  assert.deepEqual(empty, ['dq_nutrition']);
}, { state: fixtureState() });

test('P1 quests: completion uses the real completion logic, pays once, survives reload and never pays a top-up that is already done', async ({ page }) => {
  await go(page, 'home');
  assert.equal(await page.locator('#hQuests .quest-row').count(), 3, 'Home shows the daily quests');
  assert.equal(await page.locator('#hRem .reminder', { hasText: /Výprava|Quest/ }).count(), 0, 'quests are no longer mixed into the reminder strip');
  const done0 = await page.evaluate(() => S.quests.filter(q => q.questId === 'dq_priority').length);
  assert.equal(done0, 0);
  // the only High task due today is "Write report" -> completing it through the UI completes the priority quest
  await page.click('nav.bottom button[data-v="tasks"]');
  const xp0 = await page.evaluate(() => S.totalXp);
  await page.locator('.item', { hasText: 'Write report' }).locator('.check').click();
  await page.waitForTimeout(800);
  const s = await stateOf(page);
  const qrec = s.quests.filter(q => q.key === `dq_priority:${TODAY}`);
  assert.equal(qrec.length, 1, 'quest recorded once');
  const questXp = s.xpLog.filter(e => /^Quest: /.test(e.reason) && e.ts >= 0 && e.reason.includes('prioritní'));
  assert.equal(questXp.length, 1); assert.equal(questXp[0].amount, 40);
  assert.equal(s.totalXp - xp0, 30 + 40, 'High task 30 XP + the quest 40 XP, nothing else');
  // re-render, reopen, reload: nothing is paid again
  await page.evaluate(() => { for (let i = 0; i < 3; i++) { checkQuests(); render(); } });
  await persist(page); await reload(page);
  await page.evaluate(() => { checkQuests(); render(); });
  const r = await stateOf(page);
  assert.equal(r.quests.filter(q => q.key === `dq_priority:${TODAY}`).length, 1);
  assert.equal(r.totalXp, s.totalXp, 'idempotent across render + reload');
  // top-up: a quest that becomes relevant through the action that completes it is never added as free XP
  const t = await page.evaluate(() => {
    S.questBoard = { daily: { stamp: todayStr(), items: [{ id: 'dq_nutrition', p: {} }] }, weekly: S.questBoard.weekly };
    S.sleepLog.push({ id: 'sl_new', date: todayStr(), bedtime: '23:00', wake: '07:00', quality: 4, notes: '', createdAt: Date.now() });
    const before = S.totalXp; checkQuests(); return { ids: S.questBoard.daily.items.map(i => i.id), gained: S.totalXp - before };
  });
  assert.ok(!t.ids.includes('dq_sleep'), 'already satisfied sleep quest is not topped up');
}, { state: classicState() });

test('P1 quests: weekly quests + Quests screen + titles with real parameters (category, habit, targets)', async ({ page }) => {
  await go(page, 'quests');
  assert.equal(await page.locator('#dqL .quest-row').count(), 3);
  assert.equal(await page.locator('#wqL .quest-row').count(), 3);
  const titles = await page.evaluate(() => [...DAILY_QUESTS, ...WEEKLY_QUESTS].map(q => q.cs));
  assert.ok(titles.every(t => t && t.length > 8), 'every quest has a real Czech title');
  const cat = await page.evaluate(() => { const q = DAILY_QUESTS.find(x => x.id === 'dq_category'); return questTitle(q, { cat: 'Work' }); });
  assert.equal(cat, 'Dokonči úkol z kategorie: Práce');
  const wk = await page.evaluate(() => questTitle(WEEKLY_QUESTS.find(x => x.id === 'wq_workouts'), {}));
  assert.equal(wk, 'Odtrénuj svůj tréninkový týden (3×)', 'falls back to the weekly workout target');
  const wk2 = await page.evaluate(() => { S.settings.trainingDays = [1, 3, 5, 6]; return questTitle(WEEKLY_QUESTS.find(x => x.id === 'wq_workouts'), {}); });
  assert.equal(wk2, 'Odtrénuj svůj tréninkový týden (4×)', 'follows the training days');
  assert.doesNotMatch(await appText(page), EMOJI_RX);
}, { state: fixtureState() });

test('P2 Home: order Daily Score -> plan -> tasks -> habits; old widget orders get the new widgets in place, custom orders are kept', async ({ page }) => {
  const r = await page.evaluate(() => {
    const m = o => migrate(Object.assign(JSON.parse(JSON.stringify(S)), { settings: Object.assign({}, S.settings, { widgetOrder: o }) })).settings.widgetOrder;
    return { def: m(['reminders', 'progress', 'tasks', 'habits', 'goals', 'nutrition', 'finance', 'fitness', 'health']),
      custom: m(['tasks', 'health', 'progress', 'habits', 'reminders', 'goals', 'nutrition', 'finance', 'fitness']),
      again: m(['reminders', 'progress', 'planner', 'tasks', 'habits', 'quests', 'goals', 'nutrition', 'finance', 'fitness', 'health']) };
  });
  assert.deepEqual(r.def, ['reminders', 'progress', 'planner', 'tasks', 'habits', 'quests', 'goals', 'nutrition', 'finance', 'fitness', 'health']);
  assert.deepEqual(r.custom, ['tasks', 'health', 'progress', 'planner', 'habits', 'quests', 'reminders', 'goals', 'nutrition', 'finance', 'fitness'], 'own order kept, new ones next to their neighbours');
  assert.deepEqual(r.again, r.def, 'idempotent');
  await go(page, 'home');
  const order = await page.evaluate(() => [...document.querySelectorAll('#app .hud-wrap, #app [data-plan="home"], #hTasks, #hHabits, #hQuests')].map(n => n.id || n.dataset.plan || 'score'));
  assert.deepEqual(order, ['score', 'home', 'hTasks', 'hHabits', 'hQuests']);
  // Settings -> Nástěnka lists and toggles the two new widgets
  await page.click('#settingsBtn');
  assert.match(await page.locator('#st_widgets').innerText(), /Dnešní plán[\s\S]*Denní questy/);
}, { state: classicState() });

test('P3 Daily Score: training day = 0/1 until the workout is done (scored), rest day = "Den volna" (never a missed workout), unset = old rule', async ({ page }) => {
  const r = await page.evaluate(() => {
    const D = todayStr(); // Wednesday = 3
    S.events = S.events.filter(e => e.category !== 'Fitness');
    const w = S.workouts; S.workouts = [];
    const unset = dailyScoreFitness(D);
    S.settings.trainingDays = [1, 3, 5];
    const training = dailyScoreFitness(D), scoreT = dailyScore(D).score;
    S.settings.trainingDays = [1, 5];
    const rest = dailyScoreFitness(D), scoreR = dailyScore(D).score;
    S.settings.trainingDays = null; const scoreU = dailyScore(D).score;
    S.settings.trainingDays = [1, 3, 5]; S.workouts = w;
    const done = dailyScoreFitness(D);
    return { unset, training, rest, done, scoreT, scoreR, scoreU };
  });
  assert.deepEqual([r.unset.score, r.unset.rest], [null, false], 'no schedule, no calendar plan: not scored (as before)');
  assert.deepEqual([r.training.score, r.training.source], [0, 'training'], 'training day without a workout: 0');
  assert.deepEqual([r.rest.score, r.rest.rest, r.rest.reason], [null, true, 'rest_day'], 'rest day: not scored');
  assert.equal(r.scoreR, r.scoreU, 'a rest day scores exactly like a day without a plan (no penalty)');
  assert.ok(r.scoreT < r.scoreU, 'a missed training day does count');
  assert.deepEqual([r.done.score, r.done.workouts], [100, 1]);
  // presentation: 0/1 on a training day, "Den volna" on a rest day, never N/A
  await page.evaluate(() => { S.events = S.events.filter(e => e.category !== 'Fitness'); S.workouts = S.workouts.filter(w => w.date !== todayStr()); S.settings.trainingDays = [3]; view = 'home'; render(); });
  assert.equal((await page.locator('[data-ds="card"] .ds-row[data-area="fitness"] b').innerText()).trim(), '0/1');
  await page.evaluate(() => { S.settings.trainingDays = [1]; render(); });
  assert.equal((await page.locator('[data-ds="card"] .ds-row[data-area="fitness"] b').innerText()).trim(), 'Den volna');
  await page.click('[data-ds="card"]');
  assert.match(await page.locator('[data-ds="detail"] [data-area="fitness"]').innerText(), /Den volna podle tvých tréninkových dnů/);
  assert.doesNotMatch(await page.locator('[data-ds="detail"]').innerText(), /N\/A/);
}, { state: fixtureState() });

test('P3 Settings: training days toggle per weekday, persist, and can be cleared', async ({ page }) => {
  await page.click('#settingsBtn');
  assert.equal(await page.locator('#st_training .td-day').count(), 7);
  assert.equal(await page.locator('#st_training .td-day').first().innerText().then(t => t.split('\n')[0]), 'Po', 'Monday first');
  for (const d of [1, 3, 5]) await page.click(`#st_training .td-day[data-day="${d}"]`);
  assert.deepEqual((await stateOf(page)).settings.trainingDays, [1, 3, 5]);
  await page.click('#st_training .td-day[data-day="3"]');
  assert.deepEqual((await stateOf(page)).settings.trainingDays, [1, 5]);
  await persist(page); await reload(page);
  assert.deepEqual((await stateOf(page)).settings.trainingDays, [1, 5]);
  await page.click('#settingsBtn'); await page.click('#st_td_clear');
  assert.equal((await stateOf(page)).settings.trainingDays, null);
}, { state: fixtureState() });

test('P4 attributes: grow automatically by the category profile (deterministic split, same total), no manual points, no Skill Tree', async ({ page }) => {
  const g = await page.evaluate(() => ['fitness', 'work', 'learning', 'social', 'discipline', 'STR', 'nope'].map(p => [p, rpgAttrGains(48, p)]));
  for (const [p, x] of g.slice(0, 6)) assert.equal(Object.values(x).reduce((a, v) => a + v, 0), 48, `${p}: total unchanged (no multiplier)`);
  assert.deepEqual(Object.fromEntries(g), { fitness: { STR: 24, DEX: 10, VIT: 14 }, work: { INT: 17, FOC: 22, SOC: 9 }, learning: { INT: 29, FOC: 19 }, social: { SOC: 48 }, discipline: { DEX: 48 }, STR: { STR: 48 }, nope: {} });
  // a Work task through the UI: INT + FOC + SOC grow, logged on the XP entry
  await page.click('nav.bottom button[data-v="tasks"]');
  await quietQuests(page);
  const a0 = (await stateOf(page)).attrs;
  await page.locator('.item', { hasText: 'Write report' }).locator('.check').click();
  await page.waitForTimeout(800);
  const s = await stateOf(page);
  const e = s.xpLog.find(x => x.key === `task:t_open:${TODAY}`);
  assert.deepEqual([e.amount, e.attrs], [30, { INT: 6, FOC: 8, SOC: 4 }]);
  for (const k of ['INT', 'FOC', 'SOC']) assert.equal(s.attrs[k] - a0[k], e.attrs[k], k);
  assert.equal(s.attrs.STR, a0.STR);
  // Character: automatic attributes explained, no + buttons, no points, no Skill Tree, no Settings shortcut
  await page.click('nav.bottom button[data-v="more"]'); await page.click('#moreGrid [data-v="character"]'); // Reality QA: Character sits in More on phones (sidebar on desktop)
  const txt = await appText(page);
  assert.match(txt, /rostou automaticky/);
  for (const re of [/Strom dovedností/i, /Skill Tree/i, /bodů atributů/i, /Skill body/i, /Body atributů/i, /Nastavení/]) assert.doesNotMatch(txt, re);
  assert.equal(await page.locator('.spendAttrBtn, .unlockSkillBtn, .skill-node').count(), 0);
  assert.match(await page.locator('.attr-row[data-attr="STR"] .attr-src').innerText(), /Fitness/);
  assert.match(await page.locator('.attr-row[data-attr="INT"] .attr-src').innerText(), /Učení[\s\S]*Práce/);
  // stored Skill Tree / points data is not deleted (export keeps it)
  assert.ok(s.rpg.skillTree && Array.isArray(s.rpg.skillTree.unlocked));
}, { state: fixtureState() });

test('P5 XP by priority: tasks Low/Medium/High/Urgent = 10/20/30/40, habits Low/Medium/High = 10/15/25; old records keep working and are not rewritten', async ({ page }) => {
  const r = await page.evaluate(() => ({ t: ['Low', 'Medium', 'High', 'Urgent', undefined].map(p => taskXp({ priority: p })),
    h: [{ priority: 'Low' }, { priority: 'High' }, { xpReward: 5 }, { xpReward: 15 }, { xpReward: 30 }, {}].map(habitXp) }));
  assert.deepEqual(r.t, [10, 20, 30, 40, 20]);
  assert.deepEqual(r.h, [10, 25, 10, 15, 25, 15], 'old habits: importance read from their old xpReward');
  const raw = await page.evaluate(async () => (await rawIdbGet()).habits.find(h => h.id === 'h_read'));
  assert.equal('priority' in raw, false, 'migration does not rewrite the habit');
  // task form: no XP field, the hint follows the priority
  await page.click('nav.bottom button[data-v="tasks"]'); await page.click('#uiAddTask');
  for (const [p, xp] of [['Low', 10], ['Medium', 20], ['High', 30], ['Urgent', 40]]) { await page.selectOption('#f_pri', p); assert.match(await page.innerText('#f_xpHint'), new RegExp(`\\+${xp} XP`)); }
  await page.evaluate(() => closeSheets());
  // habit form: Importance instead of XP reward; saving an old habit keeps its completions and id
  await page.evaluate(() => openHabitForm(S.habits.find(h => h.id === 'h_read')));
  assert.equal(await page.locator('#h_xp').count(), 0);
  assert.equal(await page.inputValue('#h_pri'), 'Medium');
  await page.selectOption('#h_pri', 'High');
  assert.match(await page.innerText('#h_xpHint'), /\+25 XP/);
  const before = (await stateOf(page)).habits.find(h => h.id === 'h_read');
  await page.click('#h_save');
  const after = (await stateOf(page)).habits.find(h => h.id === 'h_read');
  assert.deepEqual([after.id, after.completions, after.priority], [before.id, before.completions, 'High']);
  // a completed task keeps the XP it was paid (ledger unchanged)
  assert.equal((await stateOf(page)).xpLog.find(x => x.key === 'task:t_old:' + dayOff(-2)).amount, 200);
}, { state: fixtureState() });

test('P6 categories: create a custom category in Settings, use it for a task/habit/goal/block, rename keeps items, archive hides it from pickers only', async ({ page }) => {
  await page.click('#settingsBtn');
  assert.ok(await page.locator('#st_categories .cat-row').count() >= 8, 'built-in categories listed');
  await page.click('#st_categories [data-addcat="life"]');
  await page.click('#cf_save');
  assert.match(await page.locator('[data-err="name"]').innerText(), /Vyplň název/);
  await page.fill('#cf_name', 'práce'); await page.click('#cf_save');
  assert.match(await page.locator('[data-err="name"]').innerText(), /už existuje/, 'duplicate of the built-in label');
  await page.fill('#cf_name', 'Hudba'); await page.click('.cf-ic[data-icon="music"]'); await page.click('.cf-col[data-color="#ec4899"]'); await page.selectOption('#cf_profile', 'learning');
  await page.click('#cf_save');
  const c = (await stateOf(page)).lifeCategories.find(x => x.name === 'Hudba');
  assert.deepEqual([c.icon, c.color, c.profile, c.archived, c.scope], ['music', '#ec4899', 'learning', false, 'life']);
  // used in forms
  await page.click('nav.bottom button[data-v="tasks"]'); await page.click('#uiAddTask');
  await page.fill('#f_title', 'Kytara'); await page.selectOption('#f_cat', c.key); await page.click('#f_save');
  const t = (await stateOf(page)).tasks.find(x => x.title === 'Kytara');
  assert.equal(t.category, c.key);
  assert.match(await page.locator('.item', { hasText: 'Kytara' }).innerText(), /Hudba/);
  // attributes follow the custom category's profile
  await quietQuests(page);
  await page.locator('.item', { hasText: 'Kytara' }).locator('.check').click(); await page.waitForTimeout(800);
  assert.deepEqual((await stateOf(page)).xpLog.find(x => x.key === `task:${t.id}:${TODAY}`).attrs, { INT: 7, FOC: 5 }, 'learning profile: 20 XP -> 12 attribute points');
  for (const f of ['openHabitForm()', 'openGoalForm()', 'openPlannerForm(null,{date:todayStr()})']) {
    await page.evaluate(f => { closeSheets(); eval(f); }, f);
    assert.equal(await page.locator(`.sheet option[value="${c.key}"]`).count(), 1, f);
  }
  await page.evaluate(() => closeSheets());
  // rename: label changes everywhere, the record keeps the key
  await page.evaluate(k => catSave({ name: 'Muzika', icon: 'music', color: '#ec4899', profile: 'learning' }, 'life', k), c.key);
  await page.evaluate(() => { view = 'tasks'; taskFilter = 'Completed'; render(); });
  assert.match(await page.locator('.item', { hasText: 'Kytara' }).innerText(), /Muzika/);
  assert.equal((await stateOf(page)).tasks.find(x => x.id === t.id).category, c.key);
  // archive: hidden for new items, still shown on the old one and when that one is edited
  await page.evaluate(k => catSetArchived(k, 'life', true), c.key);
  await page.evaluate(() => { closeSheets(); openForm('task'); });
  assert.equal(await page.locator(`.sheet option[value="${c.key}"]`).count(), 0, 'archived: not offered');
  await page.evaluate(id => { closeSheets(); openTaskEditForm(S.tasks.find(x => x.id === id)); }, t.id);
  assert.equal(await page.inputValue('#f_cat'), c.key, 'the existing task keeps its archived category');
  await page.evaluate(() => closeSheets());
  // built-ins can be renamed too; old records with the built-in key follow the new label
  await page.evaluate(() => catSave({ name: 'Kariéra', icon: 'briefcase', color: '', profile: 'work' }, 'life', 'Work'));
  assert.equal(await page.evaluate(() => catLabel('Work', 'life')), 'Kariéra');
  assert.equal((await stateOf(page)).tasks.find(x => x.id === 't_open').category, 'Work', 'record not rewritten');
  // notes scope
  await page.evaluate(() => { const r = catSave({ name: 'Recepty', icon: 'apple' }, 'notes'); window.__nk = r.category.key; openNoteForm(); });
  assert.equal(await page.locator(`#n_cat option[value="${await page.evaluate(() => window.__nk)}"]`).count(), 1);
  // Reality QA: defaults are Osobní / Práce; the other built-in note categories are archived (not offered, still resolvable)
  assert.deepEqual(await page.$$eval('#n_cat option', os => ['Personal', 'Work'].map(k => os.some(o => o.value === k))), [true, true], 'Osobní / Práce offered');
  assert.equal(await page.locator('#n_cat option[value="School"]').count(), 0, 'other built-ins archived: not offered for a new note');
  await page.evaluate(() => { closeSheets(); S.notes.push({ id: 'n_school', title: 'Old', content: 'x', category: 'School', tags: [], pinned: false, favorite: true, createdAt: 1, updatedAt: 1 }); openNoteForm(S.notes.find(n => n.id === 'n_school')); });
  assert.equal(await page.inputValue('#n_cat'), 'School', 'an old note keeps its built-in category');
}, { state: fixtureState() });

test('P6 categories: reload, export/import, old backup and reset', async ({ page }) => {
  const key = await page.evaluate(() => catSave({ name: 'Zahrada', icon: 'leaf', color: '#10b981', profile: 'health' }, 'life').category.key);
  await persist(page); await reload(page);
  assert.equal(await page.evaluate(k => catLabel(k, 'life'), key), 'Zahrada');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path();
  const exp = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(exp.lifeCategories.some(c => c.key === key));
  assert.ok('questBoard' in exp && 'trainingDays' in exp.settings);
  await page.evaluate(() => { S.lifeCategories = []; });
  await importFile(page, file);
  await page.waitForFunction(k => S.lifeCategories.some(c => c.key === k), key);
  const old = fixtureState(); delete old.lifeCategories; delete old.questBoard;
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => Array.isArray(S.lifeCategories) && S.lifeCategories.length === 0);
  assert.equal(await page.evaluate(() => catList('life').length), 8, 'an old backup gets the built-ins');
  assert.equal(await page.evaluate(() => catLabel('Learning', 'life')), 'Učení');
  page.on('dialog', d => d.accept());
  await page.evaluate(() => { S.lifeCategories = [{ key: 'cat_x', scope: 'life', name: 'x', icon: 'tag' }]; S.profile.photo = 'data:image/jpeg;base64,xx'; });
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  const s = await stateOf(page);
  assert.deepEqual([s.lifeCategories, s.profile.photo, s.settings.trainingDays, s.profile.avatar], [[], undefined, null, 'svg:mage']);
}, { state: fixtureState() });

test('P7 planner: one Linked field (tasks blue, goals red, workouts purple); a changed link replaces the others, an untouched one keeps old multi-links and the description', async ({ page }) => {
  await page.evaluate(() => { const bench = exerciseFind('Bench press') || exerciseAddPreset('Bench Press'); templateSave({ name: 'Push A', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 3, repsMin: 8 }] }); uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('#calAdd'); await page.click('[data-add="block"]');
  const labels = await page.locator('.pl-form label').allInnerTexts();
  // Reality QA: multi-day end date and repeat (with an optional end) join the form; the rest is unchanged
  assert.deepEqual(labels.map(l => l.trim()), ['Název', 'Datum', 'Začátek', 'Datum konce', 'Konec', 'Opakování', 'Opakovat do (nepovinné)', 'Kategorie', 'Propojeno', 'Poznámky']);
  await page.click('#pb_link');
  const groups = await page.$$eval('#pb_linkList .lk-group', gs => gs.map(g => [g.className.split(' ')[1], getComputedStyle(g.querySelector('.lk-gh i')).backgroundColor]));
  // Reality QA: a block can also be a planned Rutina (its own group, between projects and workouts)
  assert.deepEqual(groups.map(g => g[0]), ['lk-task', 'lk-goal', 'lk-habit', 'lk-workout']);
  const col = Object.fromEntries(groups);
  assert.deepEqual([col['lk-task'], col['lk-goal'], col['lk-workout']], ['rgb(96, 165, 250)', 'rgb(248, 113, 113)', 'rgb(167, 139, 250)'], 'blue / red / purple (dark theme)');
  assert.ok(![col['lk-task'], col['lk-goal'], col['lk-workout']].includes(col['lk-habit']), 'routines have their own colour');
  assert.ok(await page.locator('#pb_linkList [data-lk-type="task"] .lk-main small').first().innerText(), 'items carry a small detail');
  await page.fill('#pb_linkFilter', 'report');
  assert.equal(await page.locator('#pb_linkList [data-lk-type]').count(), 1, 'filter');
  await page.click('[data-lk-type="task"][data-lk-id="t_open"]');
  assert.equal(await page.inputValue('#pb_title'), 'Write report'); assert.equal(await page.inputValue('#pb_cat'), 'Work');
  await page.fill('#pb_start', '19:00'); await page.fill('#pb_end', '19:30'); await page.click('#pb_save');
  let b = (await stateOf(page)).plannerBlocks.find(x => x.startTime === '19:00' && x.date === TODAY && x.title === 'Write report');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.workoutTemplateId], ['t_open', '', '', '']);
  // old block with several links + description: an untouched Linked field keeps all of them
  await page.evaluate(() => { const x = S.plannerBlocks.find(b => b.id === 'pb_push'); x.taskId = 't_med'; x.description = 'old description'; render(); });
  await page.click('.cg-it[data-kind="block"][data-id="pb_push"]');
  assert.match(await page.innerText('#pb_link'), /Buy groceries/, 'primary link shown');
  await page.fill('#pb_notes', 'n'); await page.click('#pb_save');
  b = await blk(page, 'pb_push');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.description, b.notes], ['t_med', 'g_fit', 'w2', 'old description', 'n'], 'nothing lost');
  // choosing a workout replaces the other links; removing the link clears it
  await page.click('.cg-it[data-kind="block"][data-id="pb_push"]'); await page.click('#pb_link');
  const tid = await page.evaluate(() => S.workoutTemplates[0].id);
  await page.click(`[data-lk-type="workout"][data-lk-id="${tid}"]`); await page.click('#pb_save');
  b = await blk(page, 'pb_push');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.workoutTemplateId], ['', '', '', tid]);
  assert.equal(await page.locator('.cg-it[data-kind="block"][data-id="pb_push"] .cg-wk').count(), 1, 'a linked workout can be started');
  await page.click('.cg-it[data-kind="block"][data-id="pb_push"]'); await page.click('#pb_link'); await page.click('[data-lk-clear]'); await page.click('#pb_save');
  b = await blk(page, 'pb_push');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.workoutTemplateId], ['', '', '', '']);
}, { state: fixtureState() });

// Pointer drag on an element (mouse or synthetic touch pointer).
const drag = (page, sel, dy, type = 'mouse', ms = 300) => page.evaluate(async ({ sel, dy, type, ms }) => {
  const el = document.querySelector(sel); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + Math.min(10, r.height / 2);
  const ev = (t, yy) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: type, clientX: x, clientY: yy, button: 0, buttons: t === 'pointerup' ? 0 : 1, isPrimary: true }));
  ev('pointerdown', y); const steps = 6;
  for (let i = 1; i <= steps; i++) { await new Promise(r => setTimeout(r, ms / steps)); ev('pointermove', y + dy * i / steps); }
  ev('pointerup', y + dy);
}, { sel, dy, type, ms });

test('P8 sheets: pull down by the grab strip or title closes (mouse + touch); a short drag springs back; content drags and scrolling never close', async ({ page }) => {
  const open = () => page.evaluate(() => { closeSheets(); openTaskEditForm(S.tasks.find(t => t.id === 't_open')); });
  await open();
  assert.equal(await page.locator('.sheet .sheet-grab').count(), 1);
  await drag(page, '.sheet .sheet-grab', 40); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 1, 'short slow drag: springs back');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sheet')).transform), 'none');
  await drag(page, '.sheet .sheet-grab', 260); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'mouse: pulled down -> closed');
  await open(); await drag(page, '.sheet h3', 260, 'touch'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'touch on the title -> closed');
  await open(); await drag(page, '.sheet #f_desc', 300, 'touch'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 1, 'dragging inside the content never closes');
  await page.setViewportSize({ width: 390, height: 500 });
  await page.evaluate(() => { const s = document.querySelector('.sheet'); s.scrollTop = 200; s.dispatchEvent(new Event('scroll')); });
  await page.mouse.move(195, 400); await page.mouse.wheel(0, -600); await page.waitForTimeout(200);
  assert.equal(await page.locator('.sheet-bg').count(), 1, 'scrolling the content never closes');
  // fast flick
  await drag(page, '.sheet .sheet-grab', 70, 'touch', 40); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'a quick flick closes');
  // Escape, backdrop and the other close paths still work; onboarding cannot be pulled away
  await open(); await page.waitForTimeout(60); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'Escape');
  await open(); await page.mouse.click(5, 5);
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'backdrop');
  await page.evaluate(() => showOnboarding(1)); await drag(page, '.sheet .sheet-grab', 300); await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-bg').count(), 1, 'onboarding stays');
}, { state: fixtureState() });

test('P8 sheets: every Quick Add form, picker and category sheet has the grab strip', async ({ page }) => {
  for (const t of QUICK_ADD.filter(t => t !== 'water' && t !== 'fuel')) {
    await page.click('#fabBtn'); await page.click(`.sheet .qopt[data-t="${t}"]`);
    assert.equal(await page.locator('.sheet .sheet-grab').count(), 1, t);
    await page.evaluate(() => closeSheets());
  }
  for (const f of ['openAvatarPicker()', "openCategoryForm('life')", 'openDayOverview(todayStr())', 'uiOpenDailyScore(todayStr())']) {
    await page.evaluate(f => { closeSheets(); eval(f); }, f);
    assert.equal(await page.locator('.sheet .sheet-grab').count(), 1, f);
  }
}, { state: fixtureState() });

test('P9 avatar: SVG portraits (no emoji), own photo uploaded + cropped to a 256 px square, stored locally, removable; old emoji avatar shows a portrait', async ({ page }) => {
  assert.equal(await page.evaluate(() => S.profile.avatar), '🦸', 'fixture keeps its old stored value');
  await go(page, 'home');
  assert.equal(await page.locator('.hud .avatar svg').count(), 1, 'old emoji value -> portrait');
  assert.doesNotMatch(await page.locator('.hud .avatar').innerText(), EMOJI_RX);
  await page.click('#settingsBtn'); await page.click('#st_avatar');
  assert.equal(await page.locator('#avatarPicker .av-opt').count(), 8);
  await page.click('#avatarPicker [data-av="druid"]');
  assert.equal((await stateOf(page)).profile.avatar, 'svg:druid');
  // photo: 400x300 PNG -> crop sheet -> save
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 400, height: 300 }); for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 200; png.data[i + 1] = (i / 4) % 400 < 200 ? 40 : 160; png.data[i + 2] = 90; png.data[i + 3] = 255; }
  await page.click('#st_avatar');
  await page.setInputFiles('#avFile', { name: 'me.png', mimeType: 'image/png', buffer: PNG.sync.write(png) });
  await page.waitForSelector('#photoCrop');
  await page.fill('#cropZoom', '2'); await page.dispatchEvent('#cropZoom', 'input');
  await page.mouse.move(195, 500); // drag inside the crop box pans, never closes the sheet
  const box = await page.locator('#cropBox').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 160, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.locator('#photoCrop').count(), 1);
  await page.click('#cropSave');
  const p = (await stateOf(page)).profile;
  assert.equal(p.avatar, 'photo'); assert.match(p.photo, /^data:image\/jpeg;base64,/);
  const dim = await page.evaluate(src => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = src; }), p.photo);
  assert.deepEqual(dim, [256, 256], 'square crop');
  assert.ok(p.photo.length < 60000, 'small enough for local storage');
  await persist(page); await reload(page);
  await go(page, 'character');
  assert.equal(await page.locator('.char-hero .avatar img').count(), 1, 'photo shown after reload');
  await page.click('#charAvatar'); await page.click('#avRemovePhoto'); await page.click('#cf_ok');
  const q = (await stateOf(page)).profile;
  assert.deepEqual([q.avatar, q.photo], ['svg:mage', undefined]);
}, { state: fixtureState() });

test('P10 goals: the progress mode explains what Automatic and Manual do, with the goal\'s real current source', async ({ page }) => {
  await page.evaluate(() => openGoalForm(S.goals.find(g => g.id === 'g_fit')));
  assert.equal(await page.locator('#g_mode option').first().innerText(), 'Automaticky');
  const auto = await page.innerText('#g_modeHelp');
  assert.match(auto, /Automaticky:.*propojených úkolů/);
  assert.match(auto, /Teď: 0 z 1 propojených úkolů hotovo → 0 %/);
  await page.selectOption('#g_mode', 'manual');
  assert.match(await page.innerText('#g_modeHelp'), /Ručně: postup zadáváš sám/);
  assert.equal(await page.locator('#manualWrap').isVisible(), true);
  await page.evaluate(() => { closeSheets(); openGoalForm(); });
  assert.match(await page.innerText('#g_modeHelp'), /Po uložení propoj s projektem úkoly/);
}, { state: fixtureState() });

test('P11 design: no Apple emoji in the UI chrome of the main screens and sheets (user text excluded); icons are SVG', async ({ page }) => {
  const bad = [];
  for (const v of ['home', 'tasks', 'habits', 'goals', 'character', 'more', 'quests', 'planner', 'settings', 'statistics', 'nutrition', 'journal', 'notes', 'health', 'goalDetail', 'habitDetail', 'calendar', 'search']) {
    await page.evaluate(v => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; uiPlannerDay = todayStr(); view = v; render(); }, v);
    const found = await page.evaluate(() => { const rx = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B50}]/u, out = [];
      const w = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) if (rx.test(n.nodeValue) && !n.parentElement.closest('.note-body,input,textarea,[data-user-text]')) out.push(n.nodeValue.trim().slice(0, 30));
      return out; });
    if (found.length) bad.push(`${v}: ${found.join(' | ')}`);
  }
  for (const f of ['openQuickAdd()', 'openForm("task")', 'openHabitForm()', 'openGoalForm()', 'openAvatarPicker()', "openCategoryForm('life')"]) {
    await page.evaluate(f => { closeSheets(); eval(f); }, f);
    const t = await page.locator('.sheet').innerText();
    if (EMOJI_RX.test(t)) bad.push(`${f}: ${t.match(EMOJI_RX)[0]}`);
  }
  assert.deepEqual(bad, []);
  await page.evaluate(() => { closeSheets(); view = 'more'; render(); });
  assert.equal(await page.locator('#moreGrid .qopt .ic svg').count(), 15, 'Weekly Planner adds the 17th destination, Intelligence the 18th; Reality QA: Planner is part of the Calendar, Subscriptions sit in Finance, Car is out of the UI (18 - 3)');
}, { state: fixtureState() });

test('P12 layout: new screens and sheets fit 320-1440 px in dark + light, no duplicate ids, no console errors', async ({ page }) => {
  const bad = [];
  const sheets = ['openAvatarPicker()', "openCategoryForm('life')", "openCategoryForm('life','Work')", 'openDayOverview(todayStr())', 'openPlannerForm(null,{date:todayStr()})',
    'openTaskEditForm(S.tasks[0])', 'openHabitForm(S.habits[0])', 'openGoalForm(S.goals[0])', 'uiOpenDailyScore(todayStr())'];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { S.settings.theme = t; applyTheme(); S.settings.trainingDays = [1, 3, 5]; }, theme);
    for (const width of PPW) {
      await page.setViewportSize({ width, height: 900 });
      for (const v of ['home', 'character', 'planner', 'settings', 'quests', 'goals']) {
        await page.evaluate(v => { closeSheets(); uiPlannerDay = todayStr(); view = v; render(); }, v);
        const o = await overflowOf(page); if (o.length) bad.push(`${v}@${width}/${theme}: ${o}`);
        const d = await dupIds(page); if (d.length) bad.push(`${v}@${width} dup ${d}`);
      }
      for (const f of sheets) {
        await page.evaluate(f => { closeSheets(); eval(f); }, f);
        if (f.startsWith('openPlannerForm')) await page.click('#pb_link');
        const o = await overflowOf(page); if (o.length) bad.push(`${f}@${width}/${theme}: ${o}`);
        const d = await dupIds(page); if (d.length) bad.push(`${f}@${width} dup ${d}`);
      }
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });


// ---------- Balancing (approved attribute rewards) ----------
test('B1 balancing: a workout pays 80 XP and exactly 48 attribute points (STR 24, VIT 14, DEX 10) - no flat +20 VIT, form and Finish alike; stored VIT untouched', async ({ page }) => {
  await quietQuests(page);
  const vit0 = await page.evaluate(() => S.attrs.VIT);
  const d = await page.evaluate(() => { const a = { ...S.attrs }; exerciseAddPreset('Bench Press');
    const t = templateSave({ name: 'B', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 1, repsMin: 5, weight: 50 }] }).template.id;
    const w = workoutStart({ templateId: t }).workout; workoutUpdateSet(w.id, w.entries[0].id, w.entries[0].sets[0].id, { done: true }); workoutFinish(w.id);
    const e = S.xpLog.find(x => x.key === `workout:${w.id}:${todayStr()}`);
    return { amount: e.amount, attrs: e.attrs, delta: Object.fromEntries(Object.keys(ATTRS).map(k => [k, S.attrs[k] - a[k]])) }; });
  assert.equal(d.amount, 80, 'Character XP unchanged');
  assert.deepEqual(d.attrs, { STR: 24, DEX: 10, VIT: 14 });
  assert.deepEqual(d.delta, { STR: 24, INT: 0, DEX: 10, VIT: 14, WIS: 0, FOC: 0, SOC: 0 }, '48 points in total, nothing else');
  assert.ok(vit0 >= 60, 'VIT gathered earlier is kept (never recalculated or deleted)');
  // the Log Workout form pays the same
  await page.evaluate(() => { S.achievementsUnlocked.push('first_workout'); closeSheets(); view = 'fitness'; fitnessTab = 'workouts'; render(); });
  const b = await page.evaluate(() => ({ ...S.attrs, xp: S.totalXp }));
  await page.click('#addW'); await page.fill('#w_name', 'Legacy log'); await page.fill('.ex-edit .exn', 'Squat'); await page.fill('.ex-edit .exs', '3'); await page.fill('.ex-edit .exr', '5'); await page.click('#w_save');
  const a = await page.evaluate(() => ({ ...S.attrs, xp: S.totalXp }));
  assert.deepEqual([a.xp - b.xp, a.STR - b.STR, a.VIT - b.VIT, a.DEX - b.DEX], [80, 24, 14, 10]);
}, { state: fixtureState() });

test('B2 balancing: each meal type pays its 10 XP once a day (polish pass 3); only the first meal logged each day gives attribute points (+6 VIT)', async ({ page }) => {
  await quietQuests(page);
  const log = () => page.evaluate(() => S.xpLog.filter(x => x.reason === 'Meal logged').map(x => [x.amount, x.attrs || null]));
  const vit = () => page.evaluate(() => S.attrs.VIT);
  const v0 = await vit(), n0 = (await log()).length;
  for (const [name, type] of [['Snídaně', 'Breakfast'], ['Oběd', 'Lunch'], ['Večeře', 'Dinner']]) {
    await page.evaluate(() => { closeSheets(); openMealForm(); });
    await page.fill('#m_name', name); await page.selectOption('#m_type', type); await page.fill('#m_cal', '500'); await page.click('#m_save');
  }
  // the "repeat meal" button is the other way to log a meal
  await page.evaluate(() => { view = 'nutrition'; render(); });
  await page.locator('.meal-item .repeatBtn').first().click();
  const l = (await log()).slice(n0);
  assert.deepEqual(l, [[10, { VIT: 6 }], [10, null], [10, null]], 'XP once per meal type, attributes only once; repeating a meal of an already rewarded type pays nothing');
  assert.equal(await vit() - v0, 6);
  // next day: the first meal counts again
  await page.clock.setFixedTime(NOW + 86400000);
  await page.evaluate(() => { closeSheets(); openMealForm(); });
  await page.fill('#m_name', 'Zítra'); await page.fill('#m_cal', '300'); await page.click('#m_save');
  assert.deepEqual((await log()).slice(-1), [[10, { VIT: 6 }]]);
  // reload / export / import keep the ledger that decides it
  await persist(page); await reload(page);
  assert.equal(await page.evaluate(() => mealAttrProfile()), null, 'after reload the day already had its meal attributes');
}, { state: fixtureState() });

test('B3 balancing: quests keep their XP, grow attributes at 30 % of it, by the kind of activity (never all FOC/DEX)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const Q = id => [...DAILY_QUESTS, ...WEEKLY_QUESTS].find(q => q.id === id);
    const prof = (id, p) => JSON.stringify(rpgProfileOf(questAttrOf(Q(id), p)));
    return {
      xp: [...DAILY_QUESTS, ...WEEKLY_QUESTS].map(q => [q.id, q.xp]),
      priority: prof('dq_priority'), work: JSON.stringify(ATTR_PROFILES.work),
      plan: [prof('dq_plan_all'), prof('dq_plan_morning'), prof('wq_planner')],
      category: [prof('dq_category', { cat: 'Learning' }), prof('dq_category', { cat: 'Social' })],
      habits: ['dq_habits', 'dq_streak', 'dq_score', 'wq_streak', 'wq_score'].map(id => prof(id)),
      fitness: ['dq_workout', 'dq_workout_pr', 'wq_workouts'].map(id => prof(id)),
      food: prof('dq_nutrition'), sleep: prof('dq_sleep'),
      mix: JSON.stringify(questTaskProfile([{ category: 'Learning' }, { category: 'Social' }])), none: questTaskProfile([]),
    };
  });
  assert.deepEqual(r.xp, [['dq_priority', 40], ['dq_workout', 40], ['dq_workout_pr', 60], ['dq_plan_all', 35], ['dq_habits', 40], ['dq_category', 20], ['dq_tasks', 30], ['dq_streak', 25], ['dq_score', 40],
    ['dq_plan_morning', 25], ['dq_sleep', 15], ['dq_nutrition', 15], ['dq_calories', 30], ['dq_water', 20],
    ['wq_workouts', 150], ['wq_routine_week', 120], ['wq_sleep_week', 120], ['wq_tasks', 150], ['wq_streak', 150], ['wq_goal', 100], ['wq_score', 120], ['wq_planner', 100]],
    'quest XP unchanged; Reality QA [XP-impacting, intended]: 4 behaviour quests join the pools (the board still holds 3 daily + 3 weekly, XP once per quest)');
  assert.equal(r.priority, r.work, 'the only priority task today is a Work task -> work profile');
  assert.deepEqual(r.plan, Array(3).fill('{"FOC":0.5,"DEX":0.5}'), 'planner -> FOC + DEX');
  assert.deepEqual(r.category, ['{"INT":0.6,"FOC":0.4}', '{"SOC":1}'], 'category quest -> that category');
  assert.deepEqual(r.habits, Array(5).fill('{"DEX":1}'), 'habits / streak / Daily Score -> DEX');
  assert.deepEqual(r.fitness, Array(3).fill('{"STR":0.5,"VIT":0.3,"DEX":0.2}'), 'workout quests -> fitness');
  assert.equal(r.food, '{"VIT":1}'); assert.equal(r.sleep, '{"VIT":0.6,"FOC":0.4}');
  assert.equal(r.mix, '{"INT":0.3,"FOC":0.2,"SOC":0.5}', 'a task quest mixes the categories of the tasks it counted');
  assert.equal(r.none, 'work', 'uncategorized tasks -> work profile');
  // end to end: completing the priority task pays the quest 40 XP and 12 attribute points (30 %) of the work profile
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Write report' }).locator('.check').click(); await page.waitForTimeout(800);
  const e = await page.evaluate(() => S.xpLog.find(x => /^Quest: /.test(x.reason) && x.reason.includes('prioritní')));
  assert.equal(e.amount, 40);
  assert.deepEqual(e.attrs, { INT: 4, FOC: 6, SOC: 2 }, 'round(40 x 0.3) = 12 points, work profile');
}, { state: fixtureState() });

test('B4 balancing: a simulated week follows behaviour - no attribute runs away, WIS stays the slow one, each day type leads with its own attributes', async ({ page }) => {
  const r = await page.evaluate(() => {
    const add = (acc, g, n = 1) => { Object.entries(g).forEach(([k, v]) => acc[k] = (acc[k] || 0) + v * n); return acc; };
    const G = (xp, p, rate = ATTR_RATE) => rpgAttrGains(Math.round(xp * rate), p);
    const Q = (id, p) => { const q = [...DAILY_QUESTS, ...WEEKLY_QUESTS].find(x => x.id === id); return G(q.xp, questAttrOf(q, p), QUEST_ATTR_RATE); };
    const T = c => ({ category: c });
    const day = {
      fitness: add(add(add(add(add(G(80, 'fitness'), G(15, 'fitness')), G(20, 'personal')), G(10, 'nutrition')), G(10, 'sleep')), add(add(Q('dq_workout'), Q('dq_habits')), Q('dq_nutrition'))),
      study: add(add(add(add(add(add(G(20, 'learning'), G(20, 'learning')), G(30, 'learning')), G(10, 'learning')), G(15, 'learning')), add(G(15, 'reflection'), add(G(10, 'nutrition'), G(10, 'sleep')))), add(Q('dq_category', { cat: 'Learning' }), add(Q('dq_habits'), Q('dq_nutrition')))),
      productive: add(add(add(G(30, 'work'), G(30, 'work')), add(G(40, 'work'), add(G(20, 'work'), G(20, 'work')))), add(add(G(20, 'work'), G(15, 'health')), add(add(G(15, 'discipline'), G(10, 'nutrition')), add(G(10, 'sleep'), add(add(Q('dq_priority'), Q('dq_plan_all')), Q('dq_tasks')))))),
      social: add(add(add(G(20, 'social'), G(20, 'social')), add(G(10, 'personal'), G(15, 'social'))), add(add(G(10, 'nutrition'), G(10, 'sleep')), add(Q('dq_category', { cat: 'Social' }), add(Q('dq_habits'), Q('dq_nutrition'))))),
    };
    const week = add(add(add(add({}, day.fitness, 3), day.productive, 2), day.study), day.social);
    add(week, add(add(Q('wq_workouts'), Q('wq_streak')), G(150, 'work', QUEST_ATTR_RATE)));
    const top = g => Object.keys(g).sort((a, b) => g[b] - g[a]).slice(0, 2);
    return { day, week, top: Object.fromEntries(Object.entries(day).map(([k, g]) => [k, top(g)])) };
  });
  const tot = Object.values(r.week).reduce((a, v) => a + v, 0);
  const share = k => (r.week[k] || 0) / tot;
  for (const k of ['STR', 'INT', 'DEX', 'VIT', 'FOC', 'SOC']) assert.ok(share(k) <= 0.25, `${k} ${Math.round(share(k) * 100)} % <= 25 %`);
  assert.ok(share('WIS') < 0.05, 'WIS grows slowest (variant A)');
  const main = ['STR', 'INT', 'DEX', 'VIT', 'FOC', 'SOC'].map(k => r.week[k]);
  assert.ok(Math.max(...main) / Math.min(...main) < 2.5, `no runaway attribute: ${JSON.stringify(r.week)}`);
  assert.ok(r.day.fitness.STR >= 30 && r.day.fitness.VIT <= 40, 'fitness day: STR leads with VIT, no VIT flood');
  assert.deepEqual(r.top.study.sort(), ['FOC', 'INT'], 'study day -> INT/FOC');
  assert.equal(r.top.productive[0], 'FOC', 'work day -> FOC first');
  assert.equal(r.top.social[0], 'SOC', 'social day -> SOC');
}, { state: fixtureState() });

// ---------- Polish pass 2 (UI/UX only) ----------
const GLYPH_RX = /[＋✓✗✕↻↑↓‹›]/;
test('Q1 sheets: one chrome everywhere - grab strip, title, close button (works, keyboard reachable), hidden for onboarding; sticky Save stays in view', async ({ page }) => {
  const forms = ['openForm("task")', 'openTaskEditForm(S.tasks[0])', 'openHabitForm(S.habits[0])', 'openGoalForm(S.goals[0])', 'openPlannerForm(null,{date:todayStr()})',
    "openFinanceForm('expense')", 'openWorkoutForm()', 'openMealForm()', 'openAvatarPicker()', "openCategoryForm('life')", 'openSleepForm()', 'uiOpenDailyScore(todayStr())', 'openDayOverview(todayStr())'];
  for (const f of forms) {
    await page.evaluate(f => { closeSheets(); eval(f); }, f);
    assert.equal(await page.locator('.sheet .sheet-grab').count(), 1, f + ' grab');
    assert.equal(await page.locator('.sheet .sheet-x').count(), 1, f + ' close');
    assert.ok((await page.locator('.sheet h2, .sheet h3').first().innerText()).trim().length > 2, f + ' title');
    const save = page.locator('.sheet .btn[id$="_save"]');
    if (await save.count()) { const b = await save.boundingBox(); assert.ok(b && b.y + b.height <= 845, `${f}: Save visible without scrolling (${b && Math.round(b.y + b.height)})`); }
  }
  await page.click('.sheet .sheet-x');
  assert.equal(await page.locator('.sheet-bg').count(), 0, 'close button closes');
  await page.evaluate(() => { openForm('task'); });
  assert.notEqual(await page.evaluate(() => document.activeElement.className), 'sheet-x', 'focus never lands on the close button first');
  await page.evaluate(() => { closeSheets(); showOnboarding(1); });
  assert.equal(await page.locator('.sheet .sheet-x').count(), 0, 'onboarding cannot be closed');
}, { state: fixtureState() });

test('Q2 icons: no typographic glyphs or emoji as button icons on any screen or main sheet; delete buttons are a trash icon; user text untouched', async ({ page }) => {
  const bad = [];
  const scan = where => page.evaluate(({ where, g }) => { const rx = new RegExp(g), ex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B50}]/u, out = [];
    document.querySelectorAll('#app button, #app .btn, #app .chip, .sheet button, .sheet .chip').forEach(b => { [...b.childNodes].forEach(n => { if (n.nodeType === 3 && (rx.test(n.nodeValue) || ex.test(n.nodeValue)) && !b.closest('[data-user-text],.item-title')) out.push(`${where}: "${b.textContent.trim().slice(0, 24)}"`); }); });
    return out; }, { where, g: GLYPH_RX.source });
  await allViews(page, async v => bad.push(...await scan(v)));
  for (const f of ['openQuickAdd()', 'openForm("task")', 'openHabitForm(S.habits[0])', 'openPlannerForm(S.plannerBlocks[0])', "openFinanceForm('expense')", 'openMealForm()']) {
    await page.evaluate(f => { closeSheets(); eval(f); }, f); bad.push(...await scan(f));
  }
  assert.deepEqual(bad, []);
  await page.evaluate(() => { closeSheets(); view = 'tasks'; render(); });
  assert.ok(await page.locator('#tlist .delbtn svg').count() >= 1, 'delete = trash icon');
  await page.evaluate(() => { view = 'home'; render(); });
  assert.equal(await page.locator('#hTasks .delbtn:visible, #hHabits .delbtn:visible').count(), 0, 'no delete buttons on the dashboard');
  // live-updated parts (search while typing, a redrawn workout card) get the same icons
  await page.evaluate(() => { view = 'search'; render(); });
  await page.fill('#gs', 'read');
  const st = await page.locator('#gsRes').innerText();
  assert.doesNotMatch(st, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]|›/u, 'search results: icons, not emoji/glyphs');
  assert.ok(await page.locator('#gsRes .icon-circle svg').count() >= 1);
  // a user-typed emoji in a task title stays as typed
  await page.evaluate(() => { S.tasks[1].title = 'Nákup 🍎'; view = 'tasks'; render(); });
  assert.match(await page.locator('.item', { hasText: 'Nákup' }).locator('.item-title').innerText(), /🍎/);
}, { state: fixtureState() });

test('Q3 Home: quest board shows progress pips and XP still to earn from the real board; task rows are compact (priority dot, inline links)', async ({ page }) => {
  await go(page, 'home');
  const r = await page.evaluate(() => { const b = questBoardFor('daily'); const done = b.filter(x => questDone(x.q, 'daily')); return { n: b.length, done: done.length, left: b.filter(x => !questDone(x.q, 'daily')).reduce((a, x) => a + x.q.xp, 0) }; });
  assert.equal(await page.locator('.quest-board .qb-pips i').count(), r.n);
  assert.equal(await page.locator('.quest-board .qb-pips i.on').count(), r.done);
  assert.match(await page.locator('.quest-board .qb-title').innerText(), new RegExp(`Splněno ${r.done} z ${r.n}[\\s\\S]*\\+${r.left} XP`));
  const row = page.locator('#hTasks .task-item', { hasText: 'Write report' });
  assert.equal(await row.locator('.prio[data-p="High"]').count(), 1);
  assert.equal(await row.locator('.meta-link.linkGoal, .meta-link.planLink').count(), 2);
  await row.locator('.planLink').click();
  assert.equal(await page.evaluate(() => view), 'calendar', 'inline link still navigates (Reality QA: to the Calendar day)');
  assert.equal(await page.locator('[data-ds="card"] .ds-counts').count(), 0, 'no duplicated counts under the score');
}, { state: classicState() });

test('Q4 Character + achievements + goals: attribute meanings, Czech achievement texts, Automatic mode sentence', async ({ page }) => {
  await go(page, 'character');
  assert.equal(await page.locator('.attr-row .attr-mean').count(), 7);
  assert.match(await page.locator('.attr-row[data-attr="VIT"] .attr-mean').innerText(), /zdraví, spánek, jídlo/);
  assert.match(await page.locator('.attr-row[data-attr="STR"] .attr-src').innerText(), /Roste z: Fitness/);
  const t = await page.locator('.ach-grid').innerText();
  assert.match(t, /První krok/); assert.doesNotMatch(t, /Complete your first task/);
  await page.evaluate(() => openGoalForm(S.goals[0]));
  assert.match(await page.innerText('#g_modeHelp'), /Progress se počítá automaticky podle dokončených propojených úkolů/);
}, { state: fixtureState() });

test('Q5 avatar picker: selected state with a check, current name under the preview, crop zoom buttons step the zoom', async ({ page }) => {
  await page.evaluate(() => openAvatarPicker());
  assert.equal(await page.locator('#avatarPicker .av-opt.is-selected .av-check').count(), 1);
  assert.equal(await page.locator('#avatarPicker .av-opt .av-check').count(), 1, 'only one selected');
  assert.equal((await page.locator('.av-cur-name').innerText()).trim(), 'Paladin');
  const { PNG } = await import('pngjs'); const png = new PNG({ width: 300, height: 300 }); png.data.fill(180);
  await page.setInputFiles('#avFile', { name: 'a.png', mimeType: 'image/png', buffer: PNG.sync.write(png) });
  await page.waitForSelector('#photoCrop');
  await page.click('#cropIn'); await page.click('#cropIn');
  assert.equal(await page.inputValue('#cropZoom'), '1.5');
  await page.click('#cropOut');
  assert.equal(await page.inputValue('#cropZoom'), '1.25');
  for (let i = 0; i < 6; i++) await page.click('#cropOut');
  assert.equal(await page.inputValue('#cropZoom'), '1', 'never below 1');
}, { state: fixtureState() });

test('Q6 layout: required screens and sheets at 320-1440 px, dark + light: no overflow, no duplicate ids, no console errors', async ({ page }) => {
  const bad = [];
  const views = ['home', 'planner', 'tasks', 'habits', 'goals', 'character', 'quests', 'finance', 'fitness', 'nutrition', 'health', 'settings', 'more', 'statistics'];
  const sheets = ['uiOpenDailyScore(todayStr())', 'openTaskEditForm(S.tasks[0])', 'openHabitForm(S.habits[0])', 'openGoalForm(S.goals[0])', 'openAvatarPicker()', "openFinanceForm('expense')", 'openMealForm()', 'openDayOverview(todayStr())'];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { S.settings.theme = t; applyTheme(); }, theme);
    for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const v of views) {
        await page.evaluate(v => { closeSheets(); uiPlannerDay = todayStr(); view = v; render(); }, v);
        const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 0) bad.push(`${v}@${width}/${theme}: ${o}px`);
      }
      for (const f of sheets) {
        await page.evaluate(f => { closeSheets(); eval(f); }, f);
        const o = await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [...document.querySelectorAll('.sheet *')].filter(n => { const r = n.getBoundingClientRect(); return r.width && r.right > vw + 1; }).length; });
        if (o) bad.push(`${f}@${width}/${theme}: ${o} el`);
        const d = await page.evaluate(() => { const s = {}; document.querySelectorAll('[id]').forEach(n => { s[n.id] = (s[n.id] || 0) + 1; }); return Object.keys(s).filter(k => s[k] > 1); });
        if (d.length) bad.push(`${f} dup ${d}`);
      }
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Core reliability pass (A1 tabs, A3 deletes, A2 performance, B1 minute tick) ----------
async function extraTab(page, errs) {
  const p = await page.context().newPage();
  p.on('pageerror', e => errs.push(`pageerror: ${e.message}`)); p.on('console', m => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  p.on('dialog', d => { errs.push('native dialog: ' + d.message()); d.dismiss(); });
  await p.clock.setFixedTime(NOW); await p.goto(URL_); await injectRawIdb(p);
  return p;
}
const tabState = p => p.evaluate(() => ({ booted: !!S, active: tabActive, blocked: !!document.getElementById('tabLock') }));
const ownerReady = p => p.waitForFunction(() => S && tabActive && !document.getElementById('tabLock'), null, { timeout: 8000 });

test('R1 tabs: one active tab; the other says so, never loads or saves; takeover saves first; close hands over; nothing is lost', async ({ page }) => {
  const errs = []; page.on('dialog', d => { errs.push('native dialog: ' + d.message()); d.dismiss(); });
  const B = await extraTab(page, errs);
  await B.waitForSelector('#tabLock');
  assert.deepEqual(await tabState(B), { booted: false, active: false, blocked: true }, 'B is blocked and never loaded the data');
  assert.match(await B.locator('#tabLock').innerText(), /otevřený v jiné záložce[\s\S]*Používat zde/);
  assert.equal(await B.evaluate(() => [...document.querySelectorAll('body > :not(#tabLock):not(script)')].every(n => n.inert)), true, 'app behind the screen is inert');
  assert.deepEqual(await tabState(page), { booted: true, active: true, blocked: false }, 'A stays the owner');
  // change in A
  await page.evaluate(() => { S.tasks.push({ id: 'tabA', title: 'from tab A', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await settle(page);
  // change in B: impossible (no data) and its save paths write nothing
  await B.evaluate(() => { flushSave(); scheduleSave(); }); await settle(B);
  assert.ok((await idbState(page)).tasks.some(t => t.id === 'tabA'), 'A saved');
  await B.reload(); await B.waitForSelector('#tabLock');
  assert.equal((await tabState(B)).blocked, true, 'reloaded B is still blocked');
  // reload A: the waiting tab B gets the lock first and loads A's saved data
  await page.reload(); await ownerReady(B); await page.waitForSelector('#tabLock'); await injectRawIdb(page);
  assert.ok(await B.evaluate(() => S.tasks.some(t => t.id === 'tabA')), 'B took over with A\'s change');
  assert.equal((await tabState(page)).blocked, true, 'reloaded A waits');
  await B.evaluate(() => { S.notes.push({ id: 'tabB', title: 'from tab B', body: '', category: 'Personal', tags: [], createdAt: 1, updatedAt: 1 }); scheduleSave(); }); await settle(B);
  await page.evaluate(() => { flushSave(); scheduleSave(); }); await settle(page); // a waiting tab never overwrites
  const saved = await idbState(page);
  assert.ok(saved.tasks.some(t => t.id === 'tabA') && saved.notes.some(n => n.id === 'tabB'), 'both changes saved once');
  // "Use here" in A: B saves and steps down, A loads the latest state
  await B.evaluate(() => { S.notes.push({ id: 'tabB2', title: 'unsaved in B', body: '', category: 'Personal', tags: [], createdAt: 1, updatedAt: 1 }); }); // not yet flushed
  await page.click('#tabTakeover'); await ownerReady(page); await B.waitForSelector('#tabLock');
  assert.ok(await page.evaluate(() => S.notes.some(n => n.id === 'tabB') && S.notes.some(n => n.id === 'tabB2') && S.tasks.some(t => t.id === 'tabA')), 'takeover: B saved first, nothing lost');
  assert.equal((await tabState(B)).active, false, 'B stepped down');
  // close A: B takes over automatically (reloads the latest data)
  await page.evaluate(() => { S.tasks.push({ id: 'tabA2', title: 'last A change', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await settle(page);
  await page.close();
  await B.waitForLoadState(); await ownerReady(B); await injectRawIdb(B);
  assert.ok(await B.evaluate(() => ['tabA', 'tabA2'].every(id => S.tasks.some(t => t.id === id)) && ['tabB', 'tabB2'].every(id => S.notes.some(n => n.id === id))), 'B took over after A closed with every change');
  await B.reload(); await ownerReady(B);
  assert.ok(await B.evaluate(() => S.tasks.some(t => t.id === 'tabA2') && S.notes.some(n => n.id === 'tabB2')), 'persistence after reload');
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

test('R2 tabs: without Web Locks the app boots and saves exactly as before', async ({ page }) => {
  const errs = [];
  const p = await page.context().newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined }); });
  await p.clock.setFixedTime(NOW); await p.goto(URL_); await p.waitForFunction(() => S && S.tasks.length); await injectRawIdb(p);
  assert.deepEqual(await tabState(p), { booted: true, active: true, blocked: false });
  await p.evaluate(() => { S.tasks.push({ id: 'nl', title: 'no locks', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await settle(p);
  assert.ok((await idbState(p)).tasks.some(t => t.id === 'nl'));
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

test('R3 deletes: task, goal, milestone and goal-detail habit ask in an app sheet (what, history, links); cancel keeps, confirm deletes; links stay valid', async ({ page }) => {
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  const sheet = async () => { await page.waitForSelector('.cf-sheet'); return page.locator('.cf-sheet').innerText(); };
  // task (linked from a planner block)
  await go(page, 'tasks'); await page.evaluate(() => { taskFilter = 'All'; render(); });
  await page.evaluate(() => document.querySelector('#tlist .item .delbtn').click());
  let txt = await sheet();
  assert.match(txt, /Smazat úkol\?[\s\S]*trvale smazán[\s\S]*XP a postava zůstávají/);
  assert.equal(await page.locator('#cf_ok.danger').count(), 1, 'red confirm button');
  const tasks0 = await page.evaluate(() => S.tasks.length);
  await page.click('#cf_cancel'); assert.equal(await page.evaluate(() => S.tasks.length), tasks0, 'cancel keeps the task');
  await page.evaluate(() => document.querySelector('#tlist .item .delbtn').click());
  await page.click('#cf_ok'); await settle(page);
  assert.equal(await page.evaluate(() => S.tasks.length), tasks0 - 1, 'confirm deletes it');
  // task t_open is linked from pb_math: delete it through its row and check the planner copes
  await page.evaluate(() => { const t = S.tasks.find(t => t.id === 't_open'); if (t) { taskFilter = 'All'; view = 'tasks'; render(); } });
  if (await page.evaluate(() => S.tasks.some(t => t.id === 't_open'))) {
    const title = await page.evaluate(() => S.tasks.find(t => t.id === 't_open').title);
    await page.locator('.item', { hasText: title }).first().locator('.delbtn').click();
    assert.match(await sheet(), /Bloky v plánovači, které na něj odkazují \(1\), zůstanou/);
    await page.click('#cf_ok');
  }
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.ok(await page.evaluate(() => S.plannerBlocks.some(b => b.id === 'pb_math')), 'the planner block stays');
  // goal-detail habit (history) and milestone
  await page.evaluate(() => { currentGoalId = 'g_fit'; view = 'goalDetail'; render(); });
  const hb = page.locator('#lhList .delbtn').first(); assert.ok(await hb.isVisible(), 'habit delete visible in goal detail');
  await hb.click(); txt = await sheet();
  assert.match(txt, /Smazat rutinu\?[\s\S]*včetně celé historie plnění a série[\s\S]*Projekt „[^“]+“ zůstane/);
  await page.click('#cf_cancel'); assert.ok(await page.evaluate(() => S.habits.some(h => h.id === 'h_water')));
  await hb.click(); await page.click('#cf_ok');
  assert.ok(await page.evaluate(() => !S.habits.some(h => h.id === 'h_water')), 'habit deleted');
  await page.locator('#msList .delbtn').first().click(); txt = await sheet();
  assert.match(txt, /Smazat milník\?[\s\S]*Projekt zůstane/);
  await page.click('#cf_cancel'); assert.equal(await page.evaluate(() => S.milestones.length), 2);
  await page.locator('#msList .delbtn').first().click(); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => S.milestones.length), 1, 'milestone deleted');
  // goal: cascade described and applied (milestones deleted, tasks + habits unlinked)
  await page.evaluate(() => { S.tasks.push({ id: 'tg', title: 'goal task', priority: 'Low', goalId: 'g_fit', done: false, createdAt: 1 }); S.habits.find(h => h.id === 'h_read').goalId = 'g_fit'; view = 'goals'; render(); });
  await page.evaluate(() => document.querySelector('.goal-card .delbtn').click());
  txt = await sheet();
  assert.match(txt, /Smazat projekt\?[\s\S]*Smaže se i jeho 1 milník[\s\S]*Propojený úkol \(1\) zůstane[\s\S]*Propojená rutina \(1\) zůstane/);
  await page.click('#cf_cancel'); assert.equal(await page.evaluate(() => S.goals.length), 2, 'cancel keeps the goal');
  await page.evaluate(() => document.querySelector('.goal-card .delbtn').click()); await page.click('#cf_ok'); await settle(page);
  const s = await stateOf(page);
  assert.ok(!s.goals.some(g => g.id === 'g_fit') && !s.milestones.some(m => m.goalId === 'g_fit'), 'goal + its milestones gone');
  assert.equal(s.tasks.find(t => t.id === 'tg').goalId, '', 'task unlinked'); assert.equal(s.habits.find(h => h.id === 'h_read').goalId, '', 'habit unlinked');
  assert.equal(s.totalXp, (await idbState(page)).totalXp, 'saved');
  for (const v of VIEWS) await page.evaluate(v => { currentHabitId = 'h_read'; currentGoalId = S.goals[0].id; view = v; render(); }, v); // no view breaks on the removed links
  // export/import keeps the result, reload keeps it
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const keep = JSON.stringify(await stateOf(page));
  await page.evaluate(() => { S.tasks = []; S.goals = []; });
  await importFile(page, await dl.path()); await page.waitForFunction(() => S.goals.length > 0);
  assert.equal(JSON.stringify(await stateOf(page)), keep, 'export/import identical');
  await settle(page); await reload(page); assert.equal(JSON.stringify(await stateOf(page)), keep, 'reload identical');
  assert.deepEqual(dialogs, [], 'no native browser dialogs');
}, { state: fixtureState() });

test('R4 deletes: every other delete path and Reset use the app sheet (Czech, danger, cancel keeps), never confirm()', async ({ page }) => {
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.evaluate(() => { exerciseAddPreset('Plank'); exerciseAddPreset('Bench Press'); templateSave({ name: 'QA plan', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 2, repsMin: 5, weight: 50 }] }); S.profile.photo = 'data:image/png;base64,iVBORw0KGgo='; S.profile.avatar = 'photo'; });
  // Reality QA: Car, steps and heart rate have no UI any more (their data stays), so their delete paths are gone
  const cases = [
    ['habits list', "view='habits';render()", '#hlist .delbtn', 'S.habits.length', /Smazat rutinu\?/],
    ['workout', "fitnessTab='workouts';uiWorkoutView=null;view='fitness';render()", '#app .delbtn[aria-label^="Smazat: "]', 'S.workouts.length', /Smazat trénink\?[\s\S]*rekordy se přepočítají/],
    ['meal', "view='nutrition';render()", '#app .meal-item .delbtn, #app .item .delbtn', 'S.meals.length', /Smazat jídlo\?/],
    ['note', "view='notes';render()", '#app .delbtn', 'S.notes.length', /Smazat poznámku\?/],
    ['journal', "view='journal';render()", '#app .delbtn', 'S.journal.length', /Smazat zápis\?/],
    ['subscription', "view='subscriptions';render()", '#app .item .delbtn', 'S.subscriptions.length', /Smazat předplatné\?/],
    ['event', "uiCalMode='month';view='calendar';render()", '#evList .delbtn', 'S.events.length', /Smazat událost\?/],
    ['sleep', "healthTab='sleep';view='health';render()", '#app .item .delbtn', 'S.sleepLog.length', /Záznam spánku z/],
    ['weight', "healthTab='weight';view='health';render()", '#app .item .delbtn', 'S.weightLog.length', /Záznam hmotnosti z/],
    ['active', "healthTab='activecal';view='health';render()", '#app .item .delbtn', 'S.activeCaloriesLog.length', /Záznam aktivních kalorií z/],
    ['planner block', "closeSheets();openPlannerForm(S.plannerBlocks.find(b=>b.id==='pb_call'))", '#pb_delete', 'S.plannerBlocks.length', /Smazat blok\?[\s\S]*se nesmažou/],
    ['exercise', "closeSheets();openExerciseForm(exerciseFind('Plank'))", '#ex_delete', 'S.exerciseLibrary.filter(x=>!x.archived).length', /Smazat cvik\?[\s\S]*jen se archivuje/],
    ['template', "closeSheets();openTemplateForm(S.workoutTemplates[0])", '#tp_delete', 'S.workoutTemplates.length', /Smazat šablonu\?/],
    ['photo', "closeSheets();openAvatarPicker()", '#avRemovePhoto', "(S.profile.photo?1:0)", /Odebrat fotku\?/],
  ];
  const missing = [];
  for (const [name, setup, sel, count, re] of cases) {
    const open = async () => { await page.evaluate(setup => { closeSheets(); eval(setup); }, setup); const b = page.locator(sel).first(); if (!await b.count()) return false; await b.scrollIntoViewIfNeeded(); await b.click(); return true; };
    const n0 = await page.evaluate(c => eval(c), count);
    if (!await open()) { missing.push(name); continue; }
    await page.waitForSelector('.cf-sheet');
    assert.match(await page.locator('.cf-sheet').innerText(), re, name);
    assert.equal(await page.locator('#cf_ok.danger').count(), 1, name + ': danger button');
    await page.click('#cf_cancel');
    assert.equal(await page.evaluate(c => eval(c), count), n0, name + ': cancel keeps');
    await open(); await page.click('#cf_ok');
    assert.equal(await page.evaluate(c => eval(c), count), n0 - 1, name + ': confirm deletes');
  }
  assert.deepEqual(missing, [], 'every delete control was found');
  // Reset: the same two steps; cancelling either keeps everything
  await page.evaluate(() => { closeSheets(); view = 'settings'; render(); });
  await page.click('#st_reset'); assert.match(await page.locator('.cf-sheet').innerText(), /Smazat všechna data\?[\s\S]*zálohu/);
  await page.click('#cf_cancel'); assert.ok(await page.evaluate(() => S.tasks.length > 0));
  await page.click('#st_reset'); await page.click('#cf_ok'); assert.match(await page.locator('.cf-sheet').innerText(), /Opravdu smazat vše\?/);
  await page.click('#cf_cancel'); assert.ok(await page.evaluate(() => S.tasks.length > 0 && S.settings.onboarded !== false), 'second step cancel keeps data');
  await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); await settle(page);
  assert.equal((await idbState(page)).tasks.length, 0, 'reset wiped and saved'); assert.ok(await page.locator('.sheet .ob').count() > 0, 'onboarding again');
  assert.deepEqual(dialogs, [], 'no native browser dialogs');
}, { state: fixtureState() });

test('R5 performance: 1 500 tasks / 25 000 XP entries render fast with results identical to the full history scan; history is kept', async ({ page }) => {
  const r = await page.evaluate(() => {
    for (let i = 0; i < 1500; i++) S.tasks.push({ id: 'bt' + i, title: 'T' + i, priority: 'Medium', dueDate: addDays(todayStr(), -(i % 365)), done: true, createdAt: 1 });
    for (let i = 0; i < 25000; i++) S.xpLog.push({ id: 'x' + i, amount: 10, reason: 'Task: T', ts: Date.now() - i * 60000, key: `task:bt${i % 1500}:${addDays(todayStr(), -(i % 365))}` });
    // reference: the pre-pass formula (linear xpLog scan per task)
    const ref = D => { const due = S.tasks.filter(t => t.dueDate === D); const late = S.tasks.filter(t => t.done && t.dueDate && t.dueDate < D && S.xpLog.some(x => x.key === `task:${t.id}:${D}`));
      const items = [...due, ...late]; const open = S.tasks.filter(t => !t.done && t.dueDate && t.dueDate < D).length; if (!items.length) return { score: null, reason: 'none_planned', openOverdue: open };
      let wA = 0, wD = 0, d = 0; items.forEach(t => { const w = DAILY_SCORE_PRIORITY_WEIGHT[t.priority] || 1; wA += w; if (t.done) { wD += w; d++; } }); return { score: Math.round(wD / wA * 100), done: d, total: items.length, lateDone: late.length, openOverdue: open }; };
    const days = [0, 1, 2, 7, 30, 100, 364].map(k => addDays(todayStr(), -k));
    const same = days.every(D => JSON.stringify(dailyScoreTasks(D)) === JSON.stringify(ref(D)));
    // the index follows appends (grantXp), replacement (import/reset) and stays exact
    grantXp(5, 'late', null, `task:bt3:${todayStr()}`); const afterAppend = JSON.stringify(dailyScoreTasks(todayStr())) === JSON.stringify(ref(todayStr()));
    const dup = grantXp(5, 'late', null, `task:bt3:${todayStr()}`) === false;
    const t0 = performance.now(); for (let i = 0; i < 3; i++) { view = 'home'; render(); } const home = (performance.now() - t0) / 3;
    const t1 = performance.now(); view = 'statistics'; render(); const stats = performance.now() - t1;
    const xs = S.xpLog.length;
    return { same, afterAppend, dup, home, stats, xs };
  });
  assert.ok(r.same && r.afterAppend, 'dailyScoreTasks identical to the full scan'); assert.ok(r.dup, 'grantXp stays idempotent');
  console.log(`      R5: Home ${r.home.toFixed(1)} ms, Statistics ${r.stats.toFixed(1)} ms`);
  assert.ok(r.home < 250, `Home render ${r.home.toFixed(0)} ms (was ~2 400 ms)`); assert.ok(r.stats < 800, `Statistics render ${r.stats.toFixed(0)} ms (was ~4 900 ms)`);
  // export/import keeps the whole XP history; the index is rebuilt for the imported log
  await persist(page); await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.equal(exported.xpLog.length, r.xs, 'export keeps every XP entry');
  await page.evaluate(() => { S.xpLog = []; });
  await importFile(page, await dl.path()); await page.waitForFunction(n => S.xpLog.length === n, r.xs);
  assert.ok(await page.evaluate(() => xpKeyIndex().has(`task:bt3:${todayStr()}`) && xpKeyIndex().size === new Set(S.xpLog.map(x => x.key)).size), 'index follows the imported log');
  await page.evaluate(() => { S = defaultState(); }); assert.equal(await page.evaluate(() => xpKeyIndex().size), 0, 'index follows reset');
}, { state: fixtureState() });

test('R6 minute tick: no full render; search, focus, typing, workout, sheet, scroll survive; clock parts update; a new day re-renders once when idle', async ({ page }) => {
  const mark = () => page.evaluate(() => { window.__root = document.querySelector('#app').firstElementChild; });
  const same = () => page.evaluate(() => document.querySelector('#app').firstElementChild === window.__root);
  const runTick = async ms => { if (ms != null) await page.clock.setFixedTime(NOW + ms); await page.evaluate(() => { uiMinuteTick(); checkBrowserNotifications(); }); };
  // Search: query + results + focus
  await go(page, 'search'); await page.fill('#gs', 'read'); const hits = await page.locator('#gsRes .search-hit').count(); await mark();
  await runTick(60000);
  assert.ok(await same(), 'search: no re-render'); assert.equal(await page.inputValue('#gs'), 'read'); assert.equal(await page.locator('#gsRes .search-hit').count(), hits);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'gs', 'search keeps focus');
  // Settings: typing in the name field keeps focus and the unsaved text
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_name'); await page.keyboard.type('XY'); await mark();
  const typed = await page.inputValue('#st_name'); await runTick(120000);
  assert.ok(await same()); assert.equal(await page.evaluate(() => document.activeElement.id), 'st_name'); assert.equal(await page.inputValue('#st_name'), typed);
  // Workout in progress: a half-typed weight survives
  await page.evaluate(() => { exerciseAddPreset('Bench Press'); const t = templateSave({ name: 'P', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 2, repsMin: 5, weight: 50 }] }).template.id; workoutStart({ templateId: t }); uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  const inp = page.locator('.ws-list .ws-row [data-f="weight"]').first(); await inp.click(); await inp.press('Control+a'); await page.keyboard.type('77.5'); await mark();
  await runTick(180000);
  assert.ok(await same()); assert.equal(await inp.inputValue(), '77.5'); assert.equal(await page.evaluate(() => document.activeElement.dataset.f), 'weight');
  await inp.press('Tab'); assert.equal(await page.evaluate(() => activeWorkout().entries[0].sets[0].weight), 77.5, 'value saved normally on change');
  // Notes form sheet: typing survives
  await page.evaluate(() => { view = 'notes'; render(); openNoteForm(); }); const nf = page.locator('.sheet input, .sheet textarea').first(); await nf.click(); await page.keyboard.type('draft'); await mark();
  await runTick(240000); assert.ok(await same()); assert.equal(await nf.inputValue(), 'draft'); assert.equal(await page.locator('.sheet').count(), 1, 'sheet stays open');
  await page.evaluate(() => closeSheets());
  // Planner: scroll position kept, now-line moves with the clock (10:00 -> 10:30)
  await page.setViewportSize({ width: 390, height: 500 });
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); }); await runTick(0);
  await page.evaluate(() => window.scrollTo(0, 300)); const top0 = await page.evaluate(() => parseInt(document.querySelector('#calDayPanel .cg-now').style.top)); await mark();
  await runTick(30 * 60000);
  assert.ok(await same()); assert.equal(await page.evaluate(() => window.scrollY), 300, 'scroll kept');
  assert.equal(await page.evaluate(() => parseInt(document.querySelector('#calDayPanel .cg-now').style.top)) - top0, Math.round(30 * 1), 'now-line moved 30 min (Reality QA: calendar grid, 1 px / min)');
  // Home: greeting follows the hour, Today's plan card follows the clock; the rest of Home is the same nodes
  await page.evaluate(() => { view = 'home'; render(); }); await runTick(0); await mark();
  const g0 = await page.locator('.hud-greet').innerText();
  await runTick(7 * 3600000); // +7 h: evening (Europe/Prague)
  assert.ok(await same(), 'home: no re-render'); assert.notEqual(await page.locator('.hud-greet').innerText(), g0); assert.match(await page.locator('.hud-greet').innerText(), /Dobrý večer/);
  assert.equal(await page.locator('.plan-card.is-home').count(), 1, 'plan card still there (replaced in place)');
  const planNow = await page.evaluate(() => { const r = [...document.querySelectorAll('.plan-card.is-home .plan-row')].map(n => n.className); return r; });
  assert.ok(Array.isArray(planNow));
  // New day while the user types: deferred; once idle, one full render keeps the scroll position
  await page.evaluate(() => { view = 'search'; render(); }); await page.fill('#gs', 'water'); await mark();
  await runTick(15 * 3600000); // next day 01:00
  assert.ok(await same(), 'day change deferred while a search is typed'); assert.equal(await page.inputValue('#gs'), 'water');
  await page.fill('#gs', ''); await page.evaluate(() => { document.activeElement.blur(); view = 'home'; render(); window.scrollTo(0, 200); }); await mark();
  await runTick(15 * 3600000 + 60000);
  assert.ok(!(await same()), 'day change: one full render when idle'); assert.equal(await page.evaluate(() => window.scrollY), 200, 'scroll kept');
  await mark(); await runTick(15 * 3600000 + 120000); assert.ok(await same(), 'then partial updates again');
  // The real interval body is guarded and calls the partial tick only
  const src = await page.evaluate(() => [...document.scripts].map(s => s.textContent).join('\n'));
  assert.match(src, /setInterval\(\(\)=>\{ if\(!S\|\|!tabActive\) return; uiMinuteTick\(\); checkBrowserNotifications\(\); \}, 60000\);/);
  assert.doesNotMatch(src, /setInterval\(\(\)=>\{ render\(\); checkBrowserNotifications\(\); \}, 60000\)/);
}, { state: classicState() });

test('R7 layout: the "open elsewhere" screen and delete sheets at 320-1440 px, dark + light: no overflow, 44 px buttons, no duplicate ids', async ({ page }) => {
  const bad = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => { S.settings.theme = t; applyTheme(); }, theme);
    for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      for (const f of ["uiTabBlocked(S)", "uiDelConfirm('goal',{name:'Get in shape and stay there for the whole year',n:{milestones:2,tasks:3,habits:1}},()=>{})", "uiDelConfirm('vehicle',{name:'Car',n:{services:1,fuel:2}},()=>{})", 'doReset()']) {
        await page.evaluate(f => { closeSheets(); uiTabUnblocked(); eval(f); }, f);
        const r = await page.evaluate(() => { const vw = document.documentElement.clientWidth; const root = document.getElementById('tabLock') || document.querySelector('.sheet');
          const over = [...root.querySelectorAll('*')].filter(n => { const b = n.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.left < -1); }).length;
          const small = [...root.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 44 && !b.classList.contains('sheet-x')).map(b => b.id || b.className);
          const ids = {}; document.querySelectorAll('[id]').forEach(n => { ids[n.id] = (ids[n.id] || 0) + 1; });
          return { over, small, dup: Object.keys(ids).filter(k => ids[k] > 1), page: document.documentElement.scrollWidth - vw }; });
        if (r.over || r.page > 0) bad.push(`${f.slice(0, 20)}@${width}/${theme}: overflow ${r.over}/${r.page}`);
        if (r.small.length) bad.push(`${f.slice(0, 20)}@${width}/${theme}: small ${r.small}`);
        if (r.dup.length) bad.push(`${f.slice(0, 20)}@${width}/${theme}: dup ${r.dup}`);
      }
    }
  }
  await page.evaluate(() => { closeSheets(); uiTabUnblocked(); });
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Core reliability fix pass (BUG-1 taskDoneOn index, BUG-2 save before tab hand-over) ----------
// Realistic-year synthetic history (deterministic): tasks due over a whole year, XP spread over 365 days with
// task keys on due and other dates, duplicates, habit/quest/workout keys, key-less and null-key entries and
// older "task:<id>" keys without a date. Installed in the page as window.__gen(N, X, seed).
const GEN_YEAR = `window.__gen = function (N, X, seed) {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const T = todayStr(), cats = ['Work', 'Health', 'Learning', 'Personal', 'Finance', ''], pr = ['Low', 'Medium', 'High', 'Urgent'];
  const tasks = [];
  for (let i = 0; i < N; i++) {
    const due = addDays(T, -Math.floor(rnd() * 365)); const done = rnd() < 0.8;
    tasks.push({ id: 'rt' + i + (i % 97 === 0 ? ':x' : ''), title: 'Úkol ' + i, category: cats[i % cats.length], priority: pr[i % 4], dueDate: i % 50 === 0 ? '' : due, done, createdAt: 1 });
  }
  for (let i = 0; i < 30; i++) tasks.push({ id: 'td' + i, title: 'Dnes ' + i, category: cats[i % 5], priority: pr[i % 4], dueDate: T, done: i < 8, createdAt: 1 });
  const log = []; const now = Date.now();
  for (let i = 0; i < X; i++) {
    const ageDays = Math.floor(rnd() * 365); const ts = now - ageDays * 86400000 - Math.floor(rnd() * 80000000); const d = addDays(T, -ageDays);
    const r = rnd(); let key, reason = 'Task: x', amount = 10 + Math.floor(rnd() * 30);
    if (r < 0.55) { const t = tasks[Math.floor(rnd() * N)]; key = \`task:\${t.id}:\${rnd() < 0.7 && t.dueDate ? t.dueDate : d}\`; }
    else if (r < 0.7) { key = \`habit:h\${Math.floor(rnd() * 8)}:\${d}\`; reason = 'Habit'; }
    else if (r < 0.78) { key = \`quest:daily:dq_tasks:\${d}\`; reason = 'Quest'; }
    else if (r < 0.85) { key = undefined; reason = 'Meal logged'; }
    else if (r < 0.9) { key = \`workout:w\${i}\`; reason = 'Workout'; }
    else if (r < 0.93) { key = null; reason = 'Achievement'; }
    else if (r < 0.96) { key = \`task:rt\${Math.floor(rnd() * N)}\`; } // malformed/older: no date part
    else { const t = tasks[Math.floor(rnd() * N)]; key = \`task:\${t.id}:\${d}\`; } // duplicates / other dates
    const e = { id: 'x' + i, amount, reason, ts }; if (key !== undefined) e.key = key; log.push(e);
  }
  // today completions for today tasks + one late completion today of a historic task
  tasks.filter(t => t.id.startsWith('td') && t.done).forEach(t => log.push({ id: 'k' + t.id, amount: 15, reason: 'Task', ts: now - 3600000, key: \`task:\${t.id}:\${T}\` }));
  log.push({ id: 'late', amount: 15, reason: 'Task', ts: now - 1000, key: \`task:rt3:\${T}\` });
  log.sort((a, b) => a.ts - b.ts);
  return { tasks, xpLog: log };
};
`;
const withGen = page => page.addScriptTag({ content: GEN_YEAR });
const REF_TASK_DONE_ON = (t, D) => !!t.done && S.xpLog.some(x => x.key === `task:${t.id}:${D}`); // the pre-index implementation

test('R9 taskDoneOn: the xpLog index gives exactly the full-scan result (year data, duplicates, old/key-less entries, append, import, reset, migration) and quests are unchanged', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(refSrc => {
    const ref = eval(refSrc), T = todayStr(), bad = []; let checks = 0, trues = 0;
    const cmp = name => { const dates = [T, addDays(T, -1), addDays(T, -7), addDays(T, -100), addDays(T, -364), addDays(T, 1), '', undefined];
      const extra = [{ id: 'nd', done: false }, { id: 'rt3', done: true }, { done: true }, { id: 'rt1:x', done: true }, { id: '', done: true }];
      [...S.tasks, ...extra].forEach(t => [...dates, t.dueDate].forEach(D => { const a = taskDoneOn(t, D), b = ref(t, D); checks++; if (b) trues++; if (a !== b) bad.push(`${name}: ${t.id} ${D}`); })); };
    const fresh = () => { S = defaultState(); S.settings.onboarded = true; };
    for (const [N, X, seed] of [[100, 2000, 1], [500, 7000, 2], [1500, 25000, 3]]) { fresh(); Object.assign(S, window.__gen(N, X, seed)); cmp(`year ${N}/${X}`); }
    fresh(); Object.assign(S, window.__gen(200, 3000, 5)); cmp('built'); S.xpLog.push({ id: 'ap', amount: 5, reason: 'x', ts: Date.now(), key: `task:${S.tasks[1].id}:${T}` }); S.tasks[1].done = true; cmp('append');
    grantXp(5, 'r9', null, `task:${S.tasks[2].id}:${T}`); S.tasks[2].done = true; cmp('grantXp');
    const d = JSON.parse(JSON.stringify(S)); d.xpLog.push({ id: 'im', amount: 5, reason: 'x', ts: Date.now(), key: `task:${d.tasks[3].id}:${T}` }); d.tasks[3].done = true; S = migrate(d); cmp('import');
    const keep = S.tasks; S = defaultState(); S.tasks = keep; cmp('reset');
    const g = window.__gen(150, 1500, 8); g.xpLog.forEach((x, i) => { if (i % 3 === 0) delete x.key; }); S = migrate({ tasks: g.tasks, xpLog: g.xpLog, totalXp: 0, schemaVersion: 4 }); cmp('old backup migrated');
    fresh(); Object.assign(S, window.__gen(100, 1000, 9)); cmp('built2'); S.xpLog[S.xpLog.length - 1] = { id: 'rp', amount: 1, reason: 'x', ts: Date.now(), key: `task:${S.tasks[4].id}:${T}` }; S.tasks[4].done = true; cmp('last entry replaced');
    S.xpLog.splice(5, 1); S.xpLog.push({ id: 'sp', amount: 1, reason: 'x', ts: Date.now(), key: `task:${S.tasks[6].id}:${T}` }); S.tasks[6].done = true; cmp('splice + push, same length');
    // quest outputs through the real quest code, with the index and with the reference implementation
    fresh(); Object.assign(S, window.__gen(1500, 25000, 3));
    const quests = () => JSON.stringify(['daily', 'weekly'].map(pp => questCandidates(pp, T).map(x => [x.q.id, x.p, x.q.val ? x.q.val(S, x.p, T) : null, typeof x.q.attr === 'function' ? x.q.attr(S, x.p, T) : x.q.attr])));
    const withIndex = quests(); const cur = window.taskDoneOn; window.taskDoneOn = ref; const withRef = quests(); window.taskDoneOn = cur;
    return { bad: bad.slice(0, 10), nBad: bad.length, checks, trues, questsSame: withIndex === withRef, questsLen: withIndex.length };
  }, REF_TASK_DONE_ON.toString());
  assert.equal(r.nBad, 0, 'mismatches: ' + r.bad.join('; '));
  assert.ok(r.checks > 30000 && r.trues > 1500, `enough coverage (${r.checks} checks, ${r.trues} true)`);
  assert.ok(r.questsSame && r.questsLen > 20, 'quest candidates, progress and attributes identical');
}, { state: fixtureState() });

test('R10 performance, realistic year: 100/2 000, 500/7 000, 1 500/25 000 with XP over 365 days - no tasks x xpLog work in Home, Tasks, Statistics or quests', async ({ page }) => {
  await withGen(page);
  const rows = [];
  for (const [N, X] of [[100, 2000], [500, 7000], [1500, 25000]]) {
    const r = await page.evaluate(([N, X]) => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(N, X, 3));
      const m = (f, n = 3) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t) / n; };
      return { home: m(() => { view = 'home'; render(); }), tasks: m(() => { view = 'tasks'; render(); }), statistics: m(() => { view = 'statistics'; render(); }, 2),
        quests: m(() => { questCandidates('daily', todayStr()); questCandidates('weekly', todayStr()); checkQuests(); }) }; }, [N, X]);
    rows.push([N, X, r]); console.log(`      R10 ${N}/${X}: ` + Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  }
  const big = rows[2][2];
  assert.ok(big.home < 300 && big.tasks < 300 && big.statistics < 800 && big.quests < 60, 'fast at 1 500 / 25 000 (was Home ~2 500 ms, quests ~2 100 ms)');
  assert.ok(big.quests < rows[0][2].quests * 40 + 20, 'quest cost grows ~linearly, not with tasks x xpLog');
  await page.evaluate(() => { view = 'home'; render(); });
}, { state: fixtureState() });

// Two tabs in a fresh context: A owns the data, B waits; A changes, then closes after `delay` ms.
async function closeHandover(browserRef, delay) {
  const ctx = await browserRef.newContext(); const errs = [];
  const open = async () => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(URL_); return p; };
  const A = await open(); await A.waitForFunction(() => S);
  await A.evaluate(async () => { S.settings.onboarded = true; closeSheets(); await idbSet('state', S); });
  const B = await open(); await B.waitForSelector('#tabLock');
  await A.evaluate(() => { S.tasks.push({ id: 'last', title: 'last change', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); render(); });
  if (delay) await A.waitForTimeout(delay);
  await A.close({ runBeforeUnload: true });
  await B.waitForFunction(() => typeof S !== 'undefined' && S && tabActive && !document.getElementById('tabLock'), null, { timeout: 10000 });
  const kept = await B.evaluate(() => S.tasks.some(t => t.id === 'last'));
  await ctx.close(); return { kept, errs };
}

test('R11 tabs: closing the active tab 0-250 ms after a change never loses it - the waiting tab takes over with the change (5 delays x 4 runs)', async ({ page }) => {
  const res = [];
  for (const delay of [0, 50, 100, 200, 240]) for (let i = 0; i < 4; i++) { const r = await closeHandover(page.context().browser(), delay); res.push(`${delay}:${r.kept ? 1 : 0}`); assert.deepEqual(r.errs, []); }
  console.log('      R11 ' + res.join(' '));
  assert.ok(res.every(x => x.endsWith(':1')), 'every close kept the last change: ' + res.join(' '));
}, { state: fixtureState() });

test('R12 tabs: a pending save is written before the lock is handed over - flushSave issues the write in the same event, "Use here" waits for the committed write', async ({ page }) => {
  // flushSave (pagehide/freeze) starts the IndexedDB write synchronously once the connection is open
  const sync = await page.evaluate(() => { let n = 0; const orig = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function () { n++; return orig.apply(this, arguments); };
    S.tasks.push({ id: 'pend', title: 'pending', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); const before = n; flushSave(); const after = n; IDBDatabase.prototype.transaction = orig; return { before, after }; });
  assert.equal(sync.after - sync.before, 1, 'write transaction created synchronously inside flushSave');
  await settle(page); assert.ok((await idbState(page)).tasks.some(t => t.id === 'pend'), 'committed');
  // idbSet resolves only after its transaction is complete: a separate connection reads it right away
  assert.ok(await page.evaluate(async () => { S.notes.push({ id: 'dur', title: 'd', body: '', category: 'Personal', tags: [], createdAt: 1, updatedAt: 1 }); await idbSet('state', S); return (await rawIdbGet()).notes.some(n => n.id === 'dur'); }), 'durable when idbSet resolves');
  // "Use here": the owner's unsaved (debounced) change is in the new owner's data
  const B = await page.context().newPage(); await B.goto(URL_); await B.waitForSelector('#tabLock');
  await page.evaluate(() => { S.tasks.push({ id: 'deb', title: 'debounced', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); });
  await B.click('#tabTakeover'); await B.waitForFunction(() => S && tabActive, null, { timeout: 8000 });
  assert.ok(await B.evaluate(() => S.tasks.some(t => t.id === 'deb') && S.tasks.some(t => t.id === 'pend')), 'takeover after the pending save');
  await page.waitForSelector('#tabLock'); await B.close();
}, { state: fixtureState() });

test('R13 tabs: A1 still works - blocked screen, Use here, close hand-over, reload, single-tab close + reopen, crashed owner', async ({ page }) => {
  const ctx = page.context(), errs = [];
  const open = async () => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(URL_); await injectRawIdb(p); return p; };
  const ready = p => p.waitForFunction(() => typeof S !== 'undefined' && S && tabActive && !document.getElementById('tabLock'), null, { timeout: 10000 });
  const B = await open(); await B.waitForSelector('#tabLock');
  await page.evaluate(() => { S.tasks.push({ id: 'a1', title: 'a1', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); });
  await B.click('#tabTakeover'); await ready(B); await page.waitForSelector('#tabLock');
  assert.ok(await B.evaluate(() => S.tasks.some(t => t.id === 'a1')), 'Use here');
  await B.evaluate(() => { S.tasks.push({ id: 'b1', title: 'b1', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); });
  await B.close(); await ready(page); await injectRawIdb(page);
  assert.ok(await page.evaluate(() => S.tasks.some(t => t.id === 'b1')), 'close hands over');
  await page.reload(); await ready(page); await injectRawIdb(page); assert.ok(await page.evaluate(() => S.tasks.some(t => t.id === 'b1')), 'reload');
  // crashed owner (separate profile): what it saved survives, the waiting tab takes over
  const ctx2 = await ctx.browser().newContext();
  const open2 = async () => { const p = await ctx2.newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(URL_); return p; };
  const X = await open2(); await X.waitForFunction(() => S);
  await X.evaluate(async () => { S.settings.onboarded = true; closeSheets(); S.tasks.push({ id: 'x1', title: 'x1', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); await idbSet('state', S); });
  const Y = await open2(); await Y.waitForSelector('#tabLock');
  const cdp = await ctx2.newCDPSession(X); cdp.send('Page.crash').catch(() => {}); // never answers; the crash event does
  await X.waitForEvent('crash');
  await ready(Y);
  assert.ok(await Y.evaluate(() => S.tasks.some(t => t.id === 'x1')), 'takeover after a crash keeps the saved data');
  // single tab: change, close at once, reopen
  await Y.evaluate(() => { S.tasks.push({ id: 'y1', title: 'y1', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); });
  await Y.close({ runBeforeUnload: true });
  const Z = await open2(); await ready(Z);
  assert.ok(await Z.evaluate(() => S.tasks.some(t => t.id === 'y1')), 'single tab: close right after a change, reopen keeps it');
  await ctx2.close();
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

test('R14 minute tick: B1 still works - no full render, typing/focus/caret/search kept', async ({ page }) => {
  await go(page, 'search'); await page.fill('#gs', 'read'); await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => { window.__root = document.querySelector('#app').firstElementChild; });
  const before = await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.querySelectorAll('#gsRes .search-hit').length]);
  await page.clock.setFixedTime(NOW + 60000); await page.evaluate(() => { uiMinuteTick(); checkBrowserNotifications(); });
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.querySelectorAll('#gsRes .search-hit').length]), before);
  assert.ok(await page.evaluate(() => document.querySelector('#app').firstElementChild === window.__root), 'no re-render');
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_name'); await page.keyboard.type('Z');
  const v = await page.inputValue('#st_name'); await page.clock.setFixedTime(NOW + 120000); await page.evaluate(() => uiMinuteTick());
  assert.equal(await page.inputValue('#st_name'), v); assert.equal(await page.evaluate(() => document.activeElement.id), 'st_name');
}, { state: fixtureState() });

test('R15 deletes: A3 still works - task sheet cancel/confirm, goal cascade text, reset two steps, no native dialog', async ({ page }) => {
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await go(page, 'tasks'); const n0 = await page.evaluate(() => S.tasks.length);
  await page.locator('#tlist .item .delbtn').first().click(); assert.match(await page.locator('.cf-sheet').innerText(), /Smazat úkol\?/);
  await page.click('#cf_cancel'); assert.equal(await page.evaluate(() => S.tasks.length), n0);
  await page.locator('#tlist .item .delbtn').first().click(); await page.click('#cf_ok'); assert.equal(await page.evaluate(() => S.tasks.length), n0 - 1);
  await page.evaluate(() => { view = 'goals'; render(); document.querySelector('.goal-card .delbtn').click(); });
  assert.match(await page.locator('.cf-sheet').innerText(), /Smazat projekt\?[\s\S]*milník/); await page.click('#cf_cancel');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); assert.match(await page.locator('.cf-sheet').innerText(), /Opravdu smazat vše\?/); await page.click('#cf_ok'); await settle(page);
  assert.equal((await idbState(page)).tasks.length, 0); assert.deepEqual(dialogs, []);
}, { state: fixtureState() });

// ---------- Polish pass 3: A XP integrity ----------
const xpOf = page => page.evaluate(() => S.totalXp);
// every toast() message since the last call (toasts on screen are grouped/queued, so read the calls themselves)
const toastsText = page => page.evaluate(() => { const t = (window.__toastLog || []).join(' | '); window.__toastLog = []; return t; });
const spyToasts = page => page.evaluate(() => { window.__toastLog = []; if (!window.__toastSpy) { const t0 = window.toast; window.toast = function (m) { window.__toastLog.push(String(m)); return t0.apply(this, arguments); }; window.__toastSpy = true; } });

test('P3-A1 reset clears the level-up state: a new profile sees its first level-up again; import follows the imported level', async ({ page }) => {
  const lv = await page.evaluate(() => { grantXp(3000, 'boost'); return [levelFromXp(S.totalXp).level, lastLevelSeen]; });
  assert.ok(lv[0] >= 5 && lv[1] === lv[0], 'profile on a higher level: ' + lv);
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [levelFromXp(S.totalXp).level, lastLevelSeen, S.totalXp]), [1, 1, 0], 'level 1, lastLevelSeen 1');
  await page.click('.sheet [data-ob="skip"]');
  await spyToasts(page);
  await page.evaluate(() => grantXp(levelFromXp(0).need + 1, 'first steps'));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => [levelFromXp(S.totalXp).level, lastLevelSeen].join()), '2,2');
  assert.match(await toastsText(page), /úrovni 2|Level 2/, 'the level-up toast shows again after a reset');
  // import: the imported level becomes the seen level (no false level-up), later level-ups still show
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const file = await dl.path(); const data = JSON.parse(readFileSync(file, 'utf8')); data.totalXp = 5000;
  const f2 = file + '.json'; writeFileSync(f2, JSON.stringify(data));
  await spyToasts(page);
  await importFile(page, f2); await page.waitForFunction(() => S.totalXp === 5000);
  assert.equal(await page.evaluate(() => lastLevelSeen === levelFromXp(S.totalXp).level), true);
  await page.waitForTimeout(150); assert.doesNotMatch(await toastsText(page), /úrovni|Level Up/i, 'importing is not a level-up');
  await page.evaluate(() => { const l = levelFromXp(S.totalXp); grantXp(l.need - l.into + 1, 'next'); });
  await page.waitForTimeout(150); assert.match(await toastsText(page), /úrovni|Level/, 'next real level-up shows');
}, { state: fixtureState() });

test('P3-A2 goal and milestone XP are set by the app: stored 0 / negative / decimal / 99 999 all pay exactly 200 / 25, once; no XP input in the forms', async ({ page }) => {
  await quietQuests(page);
  await page.evaluate(() => { closeSheets(); openGoalForm(); });
  assert.equal(await page.locator('#g_xp').count(), 0, 'no goal XP field'); assert.match(await page.locator('#g_xpInfo').innerText(), /\+200 XP/);
  await page.evaluate(() => { closeSheets(); openMilestoneForm(S.goals[0].id); });
  assert.equal(await page.locator('#ms_xp').count(), 0, 'no milestone XP field'); assert.match(await page.locator('#ms_xpInfo').innerText(), /\+25 XP/);
  await page.evaluate(() => closeSheets());
  const r = []; let day = 0;
  for (const v of [0, -50, 2.5, 99999, '1e9', undefined]) { // one case a day (review: at most 2 goal rewards a day)
    await page.clock.setFixedTime(NOW + (day++) * 86400000);
    r.push(await page.evaluate(v => { const i = S.goals.length;
      const g = { id: 'gx' + i, title: 'G ' + v, status: 'Active', mode: 'manual', manualProgress: 0, xpReward: v, createdAt: 1 }; S.goals.push(g);
      const m = { id: 'mx' + i, goalId: g.id, title: 'M', completed: false, completedAt: null, xpReward: v, createdAt: 1 }; S.milestones.push(m);
      const a = S.totalXp; toggleMilestone(m); const mxp = S.totalXp - a;
      const b = S.totalXp; completeGoal(g); const gxp = S.totalXp - b;
      // reopen -> complete again, milestone off/on again: never a second reward
      const c = S.totalXp; g.status = 'Active'; completeGoal(g); toggleMilestone(m); toggleMilestone(m); const again = S.totalXp - c;
      return [String(v), gxp, mxp, again, g.xpReward === v && m.xpReward === v]; }, v));
  }
  await page.clock.setFixedTime(NOW + (day++) * 86400000);
  for (const [v, g, m, again, kept] of r) { assert.deepEqual([g, m, again], [200, 25, 0], `stored ${v}`); assert.ok(kept, `stored value ${v} left untouched`); }
  // reload -> complete again: still once
  await persist(page); await reload(page);
  assert.equal(await page.evaluate(() => { const a = S.totalXp; const g = S.goals.find(x => x.title === 'G 99999'); g.status = 'Active'; completeGoal(g); return S.totalXp - a; }), 0, 'reload does not re-open the reward');
  // new goal through the form + complete in UI = 200 once; edit keeps no XP field
  await page.evaluate(() => { closeSheets(); openGoalForm(); }); await page.fill('#g_title', 'P3 goal'); await page.click('#g_save');
  const g0 = await xpOf(page);
  await page.evaluate(() => { view = 'goals'; goalFilter = 'Active'; render(); });
  await page.locator('.goal-card', { hasText: 'P3 goal' }).locator('.sm-done').click();
  assert.equal(await xpOf(page) - g0, 200);
  assert.ok(await page.evaluate(() => !('xpReward' in S.goals.find(g => g.title === 'P3 goal'))), 'new goals no longer store a typed reward');
}, { state: fixtureState() });

test('P3-A3 an empty workout pays nothing; one finished working set pays the usual 80 XP / 48 points; undone last set, reload, log form', async ({ page }) => {
  await quietQuests(page);
  await page.evaluate(() => { S.achievementsUnlocked.push('first_workout', 'workouts_10'); exerciseAddPreset('Bench Press'); window.__t = templateSave({ name: 'E', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 2, repsMin: 5, weight: 50 }] }).template.id; });
  const run = (f, a) => page.evaluate(f, a);
  const empty = await run(() => { const a = S.totalXp, v = { ...S.attrs }; const w = workoutStart({ templateId: window.__t }).workout; const r = workoutFinish(w.id); return [S.totalXp - a, r.granted, w.status, S.attrs.STR - v.STR]; });
  assert.deepEqual(empty, [0, false, 'done', 0], 'empty workout: saved as done, 0 XP, no attributes');
  const undone = await run(() => { const a = S.totalXp; const w = workoutStart({ templateId: window.__t }).workout; const en = w.entries[0];
    workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true }); workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: false }); en.sets.slice().forEach(st => workoutRemoveSet(w.id, en.id, st.id)); workoutFinish(w.id); return S.totalXp - a; });
  assert.equal(undone, 0, 'finished set undone + sets removed before Finish: no reward');
  const wid = await run(() => { const w = workoutStart({ templateId: window.__t }).workout; const en = w.entries[0]; workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true, reps: 5, weight: 50 }); flushSave(); return w.id; });
  await persist(page); await reload(page);
  const real = await run(wid => { const a = S.totalXp, v = { ...S.attrs }; workoutFinish(wid); const again = S.totalXp; workoutFinish(wid); return [S.totalXp - a, again - a, S.attrs.STR - v.STR, S.attrs.VIT - v.VIT, S.attrs.DEX - v.DEX]; }, wid);
  assert.deepEqual(real, [80, 80, 24, 14, 10], 'after reload: 80 XP + STR 24 / VIT 14 / DEX 10, once');
  // Log Workout form: empty -> 0, with an exercise with sets -> 80
  await page.evaluate(() => { closeSheets(); view = 'fitness'; fitnessTab = 'workouts'; uiWorkoutView = null; render(); });
  let x = await xpOf(page); await page.click('#addW'); await page.fill('#w_name', 'Prázdný'); await page.click('#w_save');
  assert.equal(await xpOf(page) - x, 0, 'form without exercises: 0 XP');
  x = await xpOf(page); await page.click('#addW'); await page.fill('#w_name', 'Bez sérií'); await page.fill('.ex-edit .exn', 'Dřep'); await page.click('#w_save');
  assert.equal(await xpOf(page) - x, 0, 'form exercise without sets: 0 XP');
  x = await xpOf(page); await page.click('#addW'); await page.fill('#w_name', 'Skutečný'); await page.fill('.ex-edit .exn', 'Dřep'); await page.fill('.ex-edit .exs', '3'); await page.click('#w_save');
  assert.equal(await xpOf(page) - x, 80, 'form with sets: 80 XP');
}, { state: fixtureState() });

test('P3-A4 meal spam: 20 meals of one type pay 10 XP once; each of the 4 types once a day (40 XP max); repeat button; next day; history untouched', async ({ page }) => {
  await quietQuests(page);
  const hist0 = await page.evaluate(() => JSON.stringify(S.xpLog.filter(x => x.reason === 'Meal logged')));
  const x0 = await xpOf(page);
  for (let i = 0; i < 20; i++) await page.evaluate(i => { const m = { id: 'sp' + i, name: 'Spam', type: 'Snack', date: todayStr(), calories: 10, createdAt: 1 }; S.meals.push(m); grantXp(10, 'Meal logged', mealAttrProfile(), mealXpKey(m)); }, i);
  assert.equal(await xpOf(page) - x0, 10, '20 snacks: one reward');
  for (const type of ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Breakfast']) {
    await page.evaluate(() => { closeSheets(); openMealForm(); }); await page.fill('#m_name', 'Jídlo'); await page.selectOption('#m_type', type); await page.click('#m_save'); }
  await page.evaluate(() => { view = 'nutrition'; render(); });
  for (let i = 0; i < 5; i++) await page.locator('.meal-item .repeatBtn').first().click();
  assert.equal(await xpOf(page) - x0, 40, 'at most 4 x 10 XP a day');
  assert.ok(await page.evaluate(() => S.meals.filter(m => m.date === todayStr()).length >= 30), 'every meal is still logged');
  await persist(page); await reload(page);
  await page.evaluate(() => { const m = { id: 'after', name: 'X', type: 'Lunch', date: todayStr(), createdAt: 1 }; S.meals.push(m); grantXp(10, 'Meal logged', mealAttrProfile(), mealXpKey(m)); });
  assert.equal(await xpOf(page) - x0, 40, 'reload opens nothing');
  await page.clock.setFixedTime(NOW + 86400000);
  await page.evaluate(() => { closeSheets(); openMealForm(); }); await page.fill('#m_name', 'Zítra'); await page.click('#m_save');
  assert.equal(await xpOf(page) - x0, 50, 'next day pays again');
  assert.equal(await page.evaluate(() => JSON.stringify(S.xpLog.filter(x => x.reason === 'Meal logged' && !x.key))), hist0, 'older meal XP entries unchanged');
}, { state: fixtureState() });

test('P3-A5 sleep: one reward per night - edit, re-save, delete + log the same night again pay nothing; another night pays', async ({ page }) => {
  await quietQuests(page);
  const x0 = await xpOf(page);
  const logSleep = async date => { await page.evaluate(() => { closeSheets(); openSleepForm(); }); await page.fill('#sl_date', date); await page.click('#sl_save'); };
  await logSleep('2026-09-20'); assert.equal(await xpOf(page) - x0, 10, 'new night: 10 XP');
  for (let i = 0; i < 5; i++) { // delete + log the same night again
    await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(s => s.date !== '2026-09-20'); }); await logSleep('2026-09-20'); }
  await page.evaluate(() => { closeSheets(); openSleepForm(S.sleepLog.find(s => s.date === '2026-09-20')); }); await page.fill('#sl_qp', '80'); /* Reality QA: quality in % */ await page.click('#sl_save');
  assert.equal(await xpOf(page) - x0, 10, 'edit / delete+recreate the same night: nothing more');
  await persist(page); await reload(page); await logSleep('2026-09-20');
  assert.equal(await xpOf(page) - x0, 10, 'after reload too');
  await logSleep('2026-09-19'); assert.equal(await xpOf(page) - x0, 10, 'review: another (backfilled) night the same day pays nothing - one sleep reward a day');
  await page.clock.setFixedTime(NOW + 86400000);
  await logSleep('2026-09-21'); assert.equal(await xpOf(page) - x0, 20, 'the next day a new night pays');
  // journal follows the same rule: one reward per day however many entries are written
  const j0 = await xpOf(page);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => { closeSheets(); openJournalForm(); }); await page.click('#j_save'); }
  assert.equal(await xpOf(page) - j0, await page.evaluate(() => S.xpLog.some(x => x.key === `journal:${todayStr()}` && x.amount === 15)) ? 15 : 0, 'journal: at most 15 XP a day');
  assert.ok(await page.evaluate(() => S.xpLog.filter(x => x.key === `journal:${todayStr()}`).length === 1), 'one journal reward today');
}, { state: fixtureState() });

test('P3-A6 a task pays once in its lifetime: reopen/complete same day, next day, after edit and reload pay nothing; completion day still recorded once', async ({ page }) => {
  await quietQuests(page);
  await page.evaluate(() => { S.tasks.push({ id: 'once', title: 'Jednou', priority: 'High', dueDate: todayStr(), done: false, createdAt: 1 }); view = 'tasks'; taskFilter = 'All'; render(); });
  const x0 = await xpOf(page);
  const toggle = () => page.evaluate(() => [...document.querySelectorAll('#tlist .item')].find(n => n.textContent.includes('Jednou')).querySelector('.check').click());
  await page.evaluate(() => { taskFilter = 'All'; render(); }); await toggle(); await page.waitForTimeout(700);
  assert.equal(await xpOf(page) - x0, 30, 'first completion: High = 30 XP');
  await page.evaluate(() => { taskFilter = 'Completed'; render(); }); await toggle(); await page.waitForTimeout(100);
  await page.evaluate(() => { taskFilter = 'All'; render(); }); await toggle(); await page.waitForTimeout(700);
  assert.equal(await xpOf(page) - x0, 30, 'reopen + complete the same day: nothing');
  await page.clock.setFixedTime(NOW + 86400000);
  await page.evaluate(() => { const t = S.tasks.find(t => t.id === 'once'); t.done = false; t.title = 'Jednou upraveno'; taskFilter = 'All'; render(); });
  await persist(page); await reload(page);
  await page.evaluate(() => { view = 'tasks'; taskFilter = 'All'; render(); });
  await page.evaluate(() => [...document.querySelectorAll('#tlist .item')].find(n => n.textContent.includes('Jednou')).querySelector('.check').click()); await page.waitForTimeout(700);
  assert.equal(await xpOf(page) - x0, 30, 'next day after edit + reload: nothing');
  assert.equal(await page.evaluate(() => S.xpLog.filter(x => (x.key || '').startsWith('task:once:')).length), 1, 'one ledger entry for the task');
  // a task rewarded before this pass (key from an earlier day) counts as rewarded; a brand new task pays
  assert.equal(await page.evaluate(() => { S.tasks.push({ id: 'legacy', title: 'L', priority: 'Low', done: false, createdAt: 1 }); S.xpLog.push({ id: 'lx', amount: 10, reason: 'Task: L', ts: 1, key: 'task:legacy:2025-01-01' }); const t = S.tasks.find(t => t.id === 'legacy'); t.done = true; const a = S.totalXp; taskGrantCompletion(t); return S.totalXp - a; }), 0);
  assert.equal(await page.evaluate(() => { S.tasks.push({ id: 'legacy:x', title: 'LX', priority: 'Low', done: true, createdAt: 1 }); const a = S.totalXp; taskGrantCompletion(S.tasks.find(t => t.id === 'legacy:x')); return S.totalXp - a; }), 10, 'ids sharing a prefix are separate tasks');
}, { state: fixtureState() });

test('P3-A7 achievements pay once: repeated checks, reload and export/import never pay again; reset starts clean; achievement XP carries no attribute points', async ({ page }) => {
  await quietQuests(page);
  const r = await page.evaluate(() => { const unlocked0 = S.achievementsUnlocked.length, x = S.totalXp;
    for (let i = 0; i < 12; i++) S.tasks.push({ id: 'ach' + i, title: 'A' + i, priority: 'Low', dueDate: todayStr(), done: true, createdAt: 1 });
    checkAchievements(); const gained = S.totalXp - x; const n1 = S.achievementsUnlocked.length;
    checkAchievements(); checkAchievements(); return { newly: n1 - unlocked0, gained, again: S.totalXp - x - gained, attrs: S.xpLog.filter(e => e.reason === 'Achievement').some(e => e.attrs) }; });
  assert.ok(r.newly >= 1, 'something unlocked'); assert.equal(r.again, 0, 'repeated checks pay nothing'); assert.equal(r.attrs, false, 'no attribute points from achievements');
  const x1 = await xpOf(page); await persist(page); await reload(page); await page.evaluate(() => checkAchievements());
  assert.equal(await xpOf(page), x1, 'reload pays nothing');
  await page.click('#settingsBtn'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  await importFile(page, await dl.path()); await page.waitForTimeout(300); await page.evaluate(() => checkAchievements());
  assert.equal(await xpOf(page), x1, 'export/import pays nothing');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [S.achievementsUnlocked.length, S.totalXp, S.xpLog.length]), [0, 0, 0], 'reset: clean profile');
}, { state: fixtureState() });

// ---------- Polish pass 3: B Today / Daily Score / goals ----------
test('P3-B1 "Dnes" is one definition: Home Today tasks == Tasks -> Dnes == due today + overdue (open); no date, future, completed stay out', async ({ page }) => {
  await page.evaluate(() => { S.tasks = [
    { id: 'td', title: 'Due today', priority: 'Medium', dueDate: todayStr(), done: false, createdAt: 1 },
    { id: 'od', title: 'Overdue', priority: 'Low', dueDate: addDays(todayStr(), -3), done: false, createdAt: 1 },
    { id: 'nd', title: 'No date', priority: 'Low', dueDate: '', done: false, createdAt: 1 },
    { id: 'fu', title: 'Future', priority: 'Low', dueDate: addDays(todayStr(), 2), done: false, createdAt: 1 },
    { id: 'dn', title: 'Done today', priority: 'Low', dueDate: todayStr(), done: true, createdAt: 1 },
    { id: 'do', title: 'Done overdue', priority: 'Low', dueDate: addDays(todayStr(), -2), done: true, createdAt: 1 }]; });
  await go(page, 'home');
  const home = await page.$$eval('#hTasks .item .item-title', n => n.map(x => x.textContent.trim()));
  await page.evaluate(() => { view = 'tasks'; taskFilter = 'Today'; render(); });
  const tasks = await page.$$eval('#tlist .item .item-title', n => n.map(x => x.textContent.trim()));
  assert.deepEqual(home, ['Due today', 'Overdue']); assert.deepEqual(tasks, home, 'Home and Tasks -> Dnes agree');
  assert.match(await page.locator('#tlist .task-group').innerText(), /Po termínu · 1/i);
  assert.match(await page.locator('#tlist .task-nodate').innerText(), /Bez termínu: 1/);
  const open = (await page.evaluate(() => { taskFilter = 'All'; render(); return [...document.querySelectorAll('#tlist .item-title')].map(x => x.textContent.trim()); }));
  assert.ok(open.includes('No date') && open.includes('Future'), 'undated and future tasks are in Otevřené');
  const ds = await page.evaluate(() => dailyScoreTasks(todayStr()));
  assert.deepEqual([ds.total, ds.done, ds.openOverdue], [2, 1, 1], 'Daily Score: due today counts (1 of 2 done), open overdue informational');
  assert.ok(await page.evaluate(() => getActiveReminders().some(r => r.prefType === 'task' && r.id === 'od') && !getActiveReminders().some(r => r.id === 'nd')), 'reminders: overdue only');
}, { state: classicState() });

test('P3-B2 Daily Score never judges the live day early: "Den teprve začíná" -> "Rozpracovaný den" -> positive label; finished days keep their rating; score unchanged', async ({ page }) => {
  await page.evaluate(() => { S.tasks = []; S.meals = []; S.waterLog = []; S.sleepLog = []; S.workouts = []; S.settings.trainingDays = [];
    S.habits = [{ id: 'hA', name: 'A', category: 'Health', completions: [], active: true, frequency: 'daily', createdAt: 1 }, { id: 'hB', name: 'B', category: 'Health', completions: [], active: true, frequency: 'daily', createdAt: 1 }].map(migrateHabit); view = 'home'; render(); });
  const state = () => page.evaluate(() => { const r = dailyScore(todayStr()); return { score: r.score, st: document.querySelector('.ds-card').dataset.state, chip: document.querySelector('.ds-card .chip')?.textContent, tone: document.querySelector('.ds-card .chip')?.className }; });
  let st = await state();
  assert.equal(st.score, 0); assert.equal(st.st, 'early'); assert.equal(st.chip, 'Den teprve začíná'); assert.match(st.tone, /is-muted/);
  await page.evaluate(() => { toggleHabitDay(S.habits[0], todayStr()); render(); });
  st = await state(); assert.equal(st.score, 50); assert.equal(st.chip, 'Rozpracovaný den');
  await page.evaluate(() => { toggleHabitDay(S.habits[1], todayStr()); render(); });
  st = await state(); assert.equal(st.score, 100); assert.equal(st.chip, 'Výborný den');
  await page.evaluate(() => { toggleHabitDay(S.habits[1], todayStr()); toggleHabitDay(S.habits[0], todayStr()); uiOpenDailyScore(todayStr()); });
  const det = await page.locator('.ds-detail').innerText();
  assert.match(det, /Den teprve začíná/); assert.doesNotMatch(det, /Náročný den|Slabší den/); assert.match(det, /hodnocení dne se uloží po jeho konci/);
  // a finished day keeps the evaluative label
  await page.evaluate(() => { closeSheets(); S.dailyScores = S.dailyScores || {}; S.dailyScores[addDays(todayStr(), -1)] = { score: 10, label: 'tough', areas: dailyScore(todayStr()).areas }; uiOpenDailyScore(addDays(todayStr(), -1)); });
  assert.match(await page.locator('.ds-detail').innerText(), /Náročný den/);
}, { state: fixtureState() });

test('P3-B3 a goal at 100 % reads "Dokončeno" with "Uzavřít projekt"; closing pays 200 XP once, keeps linked tasks and history; reopen/close again pays nothing', async ({ page }) => {
  await quietQuests(page);
  await page.evaluate(() => { S.goals.push({ id: 'g100', title: 'Hotový projekt', status: 'Active', mode: 'auto', createdAt: 1 });
    S.tasks.push({ id: 'gt1', title: 'Krok 1', priority: 'Low', goalId: 'g100', done: true, createdAt: 1 }, { id: 'gt2', title: 'Krok 2', priority: 'Low', goalId: 'g100', done: true, createdAt: 1 });
    S.goals.push({ id: 'gman', title: 'Ruční projekt', status: 'Active', mode: 'manual', manualProgress: 100, createdAt: 1 });
    view = 'goals'; goalFilter = 'Active'; render(); });
  const card = page.locator('.goal-card', { hasText: 'Hotový projekt' });
  assert.equal(await card.locator('[data-goal-state="ready"]').innerText(), 'Dokončeno');
  assert.doesNotMatch(await card.innerText(), /Aktivní/, 'never "Aktivní 100 %"');
  assert.match(await card.locator('.sm-done').innerText(), /Uzavřít projekt · \+200 XP/);
  assert.equal(await page.locator('.goal-card', { hasText: 'Ruční projekt' }).locator('[data-goal-state="ready"]').count(), 1, 'manual mode at 100 % too');
  await page.evaluate(() => { view = 'home'; render(); });
  assert.equal(await page.locator('.goal-mini', { hasText: 'Hotový projekt' }).locator('[data-goal-state="ready"]').count(), 1, 'Home goal widget shows Dokončeno too');
  await page.evaluate(() => { currentGoalId = 'g100'; view = 'goalDetail'; render(); });
  assert.equal(await page.locator('[data-goal-ready]').count(), 1);
  const x0 = await xpOf(page);
  await page.click('.doneBtn');
  assert.equal(await xpOf(page) - x0, 200);
  const g = await page.evaluate(() => [S.goals.find(g => g.id === 'g100').status, S.tasks.filter(t => t.goalId === 'g100').length]);
  assert.deepEqual(g, ['Completed', 2], 'closed, linked tasks kept');
  await page.evaluate(() => { S.goals.find(g => g.id === 'g100').status = 'Active'; completeGoal(S.goals.find(g => g.id === 'g100')); });
  await persist(page); await reload(page);
  await page.evaluate(() => { const g = S.goals.find(g => g.id === 'g100'); g.status = 'Active'; completeGoal(g); });
  assert.equal(await xpOf(page) - x0, 200, 'reopen/close and reload never pay again');
  await page.evaluate(() => { view = 'goals'; goalFilter = 'Completed'; render(); });
  assert.match(await page.locator('.goal-card', { hasText: 'Hotový projekt' }).innerText(), /Splněn|Dokončen/);
}, { state: classicState() });

test('P3-B4 goals & milestones: milestone XP once, auto progress from milestones, manual mode, no completion loop; reload/export/import/reset keep the state', async ({ page }) => {
  await quietQuests(page);
  const r = await page.evaluate(() => { const g = { id: 'gm', title: 'Milníky', status: 'Active', mode: 'auto', createdAt: 1 }; S.goals.push(g);
    const ms = [1, 2, 3, 4].map(i => ({ id: 'mm' + i, goalId: 'gm', title: 'M' + i, completed: false, completedAt: null, createdAt: i })); S.milestones.push(...ms);
    const x = S.totalXp; const p = [];
    ms.forEach(m => { toggleMilestone(m); p.push(goalProgress(g)); });
    toggleMilestone(ms[0]); p.push(goalProgress(g)); toggleMilestone(ms[0]); p.push(goalProgress(g));
    return { xp: S.totalXp - x, p, status: g.status }; });
  assert.equal(r.xp, 100, '4 milestones x 25 XP, re-checking pays nothing'); assert.deepEqual(r.p, [25, 50, 75, 100, 75, 100]);
  assert.equal(r.status, 'Active', 'no automatic completion loop - the user closes the goal');
  const snap = () => page.evaluate(() => JSON.stringify([S.goals.find(g => g.id === 'gm'), S.milestones.filter(m => m.goalId === 'gm').map(m => [m.id, m.completed])]));
  const s0 = await snap(); await persist(page); await reload(page); assert.equal(await snap(), s0, 'reload');
  await page.click('#settingsBtn'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  await page.evaluate(() => { S.goals = []; S.milestones = []; }); await importFile(page, await dl.path()); await page.waitForFunction(() => S.goals.length > 0);
  assert.equal(await snap(), s0, 'export/import');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [S.goals.length, S.milestones.length]), [0, 0], 'reset');
}, { state: fixtureState() });

// ---------- Polish pass 3: C Planner / Calendar ----------
const overlapDay = page => page.evaluate(() => { const D = todayStr();
  S.plannerBlocks = [['a', 'Porada týmu kvartální', '09:00', '10:00'], ['b', 'Hovor s klientem', '09:15', '09:45'], ['c', 'Oběd', '09:30', '10:30'], ['d', 'Krátký 1', '11:00', '11:15'], ['e', 'Krátký 2', '11:20', '11:35'], ['f', 'Krátký 3', '11:40', '12:00'], ['g', 'Samostatný', '14:00', '15:00']]
    .map(([id, title, st, en]) => ({ id: 'ov' + id, title, date: D, startTime: st, endTime: en, category: 'Work', completed: false, createdAt: 1 }));
  S.plannerBlocks[0].taskId = 't_open'; uiOpenPlanner(D); });

test('P3-C1 (Reality QA) Planner and Calendar are one Kalendář: the old planner entry opens its day view; Den / Týden / Měsíc switch in place', async ({ page }) => {
  await page.evaluate(() => uiOpenPlanner(todayStr()));
  assert.equal(await page.evaluate(() => [view, uiCalMode, uiCalDay === todayStr()].join()), 'calendar,today,true');
  assert.equal(await page.locator('#calDayPanel').count(), 1);
  await page.click('#calMode [data-m="week"]'); assert.equal(await page.evaluate(() => [view, uiCalMode].join()), 'calendar,week');
  await page.click('#calMode [data-m="month"]'); assert.equal(await page.evaluate(() => [view, uiCalMode].join()), 'calendar,month');
  assert.equal(await page.locator('#calDayPanel').count(), 1, 'the month shows the selected day\'s plan below it');
  await page.click('#calMode [data-m="today"]'); assert.equal(await page.evaluate(() => [view, uiCalMode, uiCalDay === todayStr()].join()), 'calendar,today,true');
}, { state: fixtureState() });

test('P3-C2 "Teď" scrolls the current time into view; the now-line stays; other days offer "Dnes"', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await page.clock.setFixedTime(new Date(`${TODAY}T13:30:00`).getTime());
  await page.evaluate(() => { uiOpenPlanner(todayStr()); window.scrollTo(0, 0); });
  assert.equal(await page.locator('#calDayPanel .cg-now').count(), 1);
  await page.click('#calNow'); await page.waitForTimeout(700);
  const r = await page.evaluate(() => { const b = document.querySelector('#calDayPanel .cg-now').getBoundingClientRect(); return { top: b.top, h: innerHeight, y: scrollY }; });
  assert.ok(r.y > 0 && r.top > 0 && r.top < r.h * 0.6, `now-line in view (${Math.round(r.top)} of ${r.h})`);
  await page.click('#calNextD'); assert.equal(await page.locator('#calNow').count(), 0); assert.equal(await page.locator('#calMode [data-m="today"]').count(), 1);
}, { state: fixtureState() });

test('P3-C3 overlapping and short blocks: each tap opens its own block, titles readable, no overflow at 320-430; linked task/workout blocks still work', async ({ page }) => {
  const bad = [];
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 }); await overlapDay(page);
    const r = await page.evaluate(() => { const out = [];
      document.querySelectorAll('.cg-it[data-kind="block"]').forEach(n => { n.scrollIntoView({ block: 'center' }); const b = n.getBoundingClientRect(); const t = n.querySelector('.cg-t');
        const hit = document.elementFromPoint(b.left + Math.min(b.width / 2, 20), b.top + Math.min(b.height / 2, 20)); const own = hit && hit.closest('.cg-it') === n;
        const tb = t.getBoundingClientRect(); const c = n.querySelector('.cg-chk'), ck = c.getBoundingClientRect(), ckShown = getComputedStyle(c).display !== 'none';
        out.push({ id: n.dataset.id, own, titleH: Math.round(tb.height), titleVisible: tb.height >= 12 && tb.width >= 30, checkIn: !ckShown || ck.bottom <= b.bottom + 1 }); });
      return { out, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
    if (r.over > 0) bad.push(`${width}: overflow ${r.over}`);
    r.out.forEach(x => { if (!x.own) bad.push(`${width}: tap on ${x.id} hits another block`); if (!x.titleVisible) bad.push(`${width}: ${x.id} title hidden`); if (!x.checkIn) bad.push(`${width}: ${x.id} check clipped`); });
  }
  assert.deepEqual(bad, []);
  // clicking opens the right block's form
  await page.setViewportSize({ width: 320, height: 800 }); await overlapDay(page);
  await page.locator('.cg-it[data-kind="block"][data-id="ovb"]').click(); assert.equal(await page.inputValue('#pb_title'), 'Hovor s klientem');
  await page.evaluate(() => closeSheets());
  // the check still completes only the block
  await page.locator('.cg-it[data-kind="block"][data-id="ove"] .cg-chk').click(); assert.deepEqual(await page.evaluate(() => [S.plannerBlocks.find(b => b.id === 'ove').completed, S.tasks.find(t => t.id === 't_open').done]), [true, false]);
  // linked task chip / workout block on a wide screen
  await page.setViewportSize({ width: 1024, height: 800 }); await overlapDay(page);
  assert.match(await page.locator('.cg-it[data-id="ova"]').innerText(), /Porada týmu kvartální/);
  await page.evaluate(() => { exerciseAddPreset('Bench Press'); const t = templateSave({ name: 'Pl', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 1, repsMin: 5, weight: 50 }] }).template.id; S.plannerBlocks.push({ id: 'ovw', title: 'Trénink', date: todayStr(), startTime: '17:00', endTime: '18:00', category: 'Health', workoutTemplateId: t, completed: false, createdAt: 1 }); uiOpenPlanner(todayStr()); });
  await page.locator('.cg-it[data-kind="block"][data-id="ovw"] .cg-wk').click();
  assert.ok(await page.evaluate(() => !!activeWorkout() && activeWorkout().plannerBlockId === 'ovw'), 'linked workout starts from its block');
}, { state: fixtureState() });

// ---------- Polish pass 3: D UI polish ----------
test('P3-D1 no browser-native dialogs in the app code: confirm/alert/prompt are not called anywhere', async () => {
  const src = readFileSync(APP, 'utf8').replace(/\/\/[^\n]*/g, '');
  const calls = [...src.matchAll(/(^|[^.\w])(confirm|alert|prompt)\s*\(/g)].map(m => m[2]);
  assert.deepEqual(calls, [], 'native dialog calls found');
});

test('P3-D2 Settings shows only targets that do something: Rutiny/den is gone (old values kept), Úkoly/den explains its effect', async ({ page }) => {
  await page.evaluate(() => { view = 'settings'; render(); });
  assert.equal(await page.locator('#st_hpd').count(), 0); assert.equal(await page.locator('#st_tpd').count(), 1);
  assert.match(await page.locator('#st_targetsHelp').innerText(), /týdenní quest/);
  await page.fill('#st_tpd', '4'); await settle(page);
  assert.equal(await page.evaluate(() => WEEKLY_QUESTS.find(q => q.id === 'wq_tasks').max(S)), 20, 'Úkoly/den drive the weekly quest');
  const old = await page.evaluate(() => { const st = JSON.parse(JSON.stringify(S)); st.dailyTargets.habitsPerDay = 4; return migrate(st).dailyTargets.habitsPerDay; });
  assert.equal(old, 4, 'an old saved value survives migration untouched');
  await page.evaluate(() => { S.settings.onboarded = false; showOnboarding(5); });
  assert.equal(await page.locator('#ob_hpd').count(), 0, 'onboarding no longer asks for it');
}, { state: fixtureState() });

test('P3-D3 WCAG AA contrast for text in light and dark on the main screens (attributes, rarity, timestamps, secondary text, chips, links)', async ({ page }) => {
  const bad = [];
  for (const theme of ['light', 'dark']) {
    const r = await page.evaluate(theme => { S.settings.theme = theme; applyTheme(); closeSheets();
      const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
      const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const bgOf = el => { const stack = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage) && e.matches('.btn:not(.ghost):not(.danger),.fab')) return null; const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
        let bg = parse(getComputedStyle(document.body).backgroundColor); for (let i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg); return bg; };
      const out = [];
      for (const v of ['home', 'tasks', 'habits', 'goals', 'character', 'finance', 'nutrition', 'quests', 'statistics', 'health', 'settings', 'planner', 'calendar', 'notes', 'subscriptions']) { currentGoalId = 'g_fit'; view = v; render();
        document.querySelectorAll('#app *').forEach(e => { if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
          const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[aria-hidden="true"],[disabled]')) return;
          const fg0 = parse(cs.color); if (!fg0 || fg0.a === 0) return; const bg = bgOf(e); if (!bg) return; const fg = blend(fg0, bg);
          const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05); const size = parseFloat(cs.fontSize);
          const need = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5;
          if (ratio < need) out.push(`${theme}/${v}: "${e.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)} (${size}px)`); }); }
      return out; }, theme);
    bad.push(...r);
  }
  assert.deepEqual([...new Set(bad)], []);
}, { state: fixtureState() });

test('P3-D4 Czech UI: level-up activity, subscription period and food picker are Czech; user data untouched', async ({ page }) => {
  await page.evaluate(() => { S.rpg.activityLog.unshift({ id: 'lv', type: 'levelup', title: 'Level 7', description: 'Reached Level 7', xp: 0, createdAt: 1 }); view = 'character'; render(); });
  const t = await page.locator('#app').innerText(); assert.match(t, /Dosažen level 7/); assert.doesNotMatch(t, /Reached Level/);
  assert.equal(await page.evaluate(() => S.rpg.activityLog[0].description), 'Reached Level 7', 'stored text unchanged');
  await go(page, 'subscriptions'); const st = await page.locator('#app').innerText(); assert.match(st, /\/ (měsíc|rok)/); assert.doesNotMatch(st, /\/ (Monthly|Yearly)/);
  await page.evaluate(() => openMealForm()); assert.doesNotMatch(await page.locator('.sheet').innerText(), /\((food|recipe)\)/);
}, { state: fixtureState() });

test('P3-D5 toasts on a phone sit under the header, are compact, can be tapped away; the level-up toast is shorter (level-up logic unchanged)', async ({ page }) => {
  await go(page, 'home');
  await page.evaluate(() => { const l = levelFromXp(S.totalXp); grantXp(l.need - l.into + 1, 'up'); });
  await page.waitForSelector('#toasts .toast.is-level');
  const r = await page.evaluate(() => { const t = document.querySelector('#toasts .toast.is-level').getBoundingClientRect(); const h = document.querySelector('header.topbar').getBoundingClientRect(); return { tTop: t.top, hBottom: h.bottom, tH: t.height }; });
  assert.ok(r.tTop >= r.hBottom - 1, `toast below the header (${r.tTop} >= ${r.hBottom})`); assert.ok(r.tH <= 56, 'compact');
  const lvEl = await page.$('#toasts .toast.is-level'); const t0 = Date.now();
  await page.waitForFunction(el => !el.isConnected, lvEl, { timeout: 6000 }); assert.ok(Date.now() - t0 < 3800, 'this level toast leaves after ~3 s');
  await page.waitForFunction(() => !document.querySelector('#toasts .toast') && !uiToastQueue.length, null, { timeout: 20000 });
  await page.evaluate(() => toast('Test zprávy')); const el = await page.waitForSelector('#toasts .toast'); await el.click();
  await page.waitForFunction(el => !el.isConnected, el, { timeout: 1000 });
}, { state: fixtureState() });

test('P3-D6/D7 at 320 px every filter option is visible (wraps, no hidden scroll) with 44 px targets; Settings texts are not cut; no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const r = await page.evaluate(() => { const out = [];
    for (const v of ['tasks', 'goals', 'health', 'statistics', 'calendar']) { view = v; render();
      document.querySelectorAll('#app .period-selector').forEach(ps => { const pr = ps.getBoundingClientRect();
        ps.querySelectorAll('button').forEach(b => { const br = b.getBoundingClientRect(); if (br.right > pr.right + 1 || br.left < pr.left - 1) out.push(`${v}: "${b.textContent.trim()}" off-screen`); if (b.classList.contains('pill') && br.height < 44) out.push(`${v}: "${b.textContent.trim()}" ${Math.round(br.height)} px`); }); }); }
    view = 'settings'; render();
    [...document.querySelectorAll('#app *')].forEach(e => { const cs = getComputedStyle(e); if (!e.children.length && e.textContent.trim() && e.scrollWidth > e.clientWidth + 1 && (cs.overflow.includes('hidden') || cs.textOverflow === 'ellipsis')) out.push('settings cut: ' + e.textContent.trim().slice(0, 30)); });
    if (document.documentElement.scrollWidth > innerWidth) out.push('overflow');
    return out; });
  assert.deepEqual(r, []);
}, { state: fixtureState() });

test('P3-D8 avatar photo: upload, crop + zoom, remove (asks), reload, export/import keep it, reset clears it', async ({ page }) => {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 300, height: 300 }); for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 30; png.data[i + 1] = 140; png.data[i + 2] = 200; png.data[i + 3] = 255; }
  await page.evaluate(() => { view = 'character'; render(); }); await page.click('#charAvatar');
  await page.setInputFiles('#avFile', { name: 'a.png', mimeType: 'image/png', buffer: PNG.sync.write(png) }); await page.waitForSelector('#photoCrop');
  const z0 = await page.inputValue('#cropZoom'); await page.click('#cropIn'); assert.ok(+(await page.inputValue('#cropZoom')) > +z0, 'zoom in');
  await page.click('#cropSave');
  const photo = await page.evaluate(() => S.profile.photo); assert.match(photo, /^data:image\/jpeg/); assert.ok(z0);
  await persist(page); await reload(page); assert.equal(await page.evaluate(() => S.profile.photo), photo, 'reload');
  await page.click('#settingsBtn'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  await page.evaluate(() => { delete S.profile.photo; S.profile.avatar = 'svg:mage'; });
  await importFile(page, await dl.path()); await page.waitForFunction(() => !!S.profile.photo);
  assert.equal(await page.evaluate(() => S.profile.photo), photo, 'export/import');
  await page.evaluate(() => { view = 'character'; render(); }); await page.click('#charAvatar'); await page.click('#avRemovePhoto');
  assert.match(await page.locator('.cf-sheet').innerText(), /Odebrat fotku/); await page.click('#cf_cancel'); assert.ok(await page.evaluate(() => !!S.profile.photo), 'cancel keeps it');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [!!S.profile.photo, S.profile.avatar !== 'photo']), [false, true], 'reset clears the photo');
}, { state: fixtureState() });

// ---------- Polish pass 3: E PWA ----------
const swReady = page => page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return !!reg.active; });
const cacheState = page => page.evaluate(async () => { const out = {}; for (const n of await caches.keys()) { const c = await caches.open(n); out[n] = (await c.keys()).map(r => new URL(r.url).pathname).sort(); } return out; });

test('P3-E1 manifest.json is valid and linked, icons exist in the declared sizes, Chrome reports the app installable', async ({ page }) => {
  const m = await page.evaluate(async () => { const r = await fetch('manifest.json'); return { type: r.headers.get('content-type'), json: await r.json(), link: document.getElementById('manifestLink').getAttribute('href') }; });
  assert.equal(m.link, 'manifest.json');
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'icons']) assert.ok(m.json[k], 'manifest.' + k);
  assert.equal(m.json.display, 'standalone'); assert.equal(m.json.start_url, './LifeOS.html');
  const { PNG } = await import('pngjs');
  for (const ic of m.json.icons) { const [w, h] = ic.sizes.split('x').map(Number); const png = PNG.sync.read(readFileSync(path.join(ROOT, ic.src))); assert.deepEqual([png.width, png.height], [w, h], ic.src); }
  assert.ok(m.json.icons.some(i => i.sizes === '192x192') && m.json.icons.some(i => i.sizes === '512x512') && m.json.icons.some(i => i.purpose === 'maskable'));
  assert.ok(await swReady(page)); await reload(page);
  const cdp = await page.context().newCDPSession(page);
  const man = await cdp.send('Page.getAppManifest'); assert.deepEqual(man.errors, [], 'manifest parses without errors');
  const inst = await cdp.send('Page.getInstallabilityErrors'); assert.deepEqual(inst.installabilityErrors.map(e => e.errorId), [], 'installable');
});

const SW_SRC = () => readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const SW_VER = () => SW_SRC().match(/const CACHE_VERSION = '([^']+)'/)[1];

test('P3-E2 service worker: registered from sw.js, controls the page, caches the app shell under its CACHE_VERSION - and never touches IndexedDB', async ({ page }) => {
  assert.ok(await swReady(page));
  const url = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).active.scriptURL);
  assert.match(url, /\/sw\.js$/);
  await reload(page); assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true, 'page is controlled');
  const c = await cacheState(page);
  assert.deepEqual(Object.keys(c), [SW_VER()]);
  for (const f of ['/LifeOS.html', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']) assert.ok(c[SW_VER()].includes(f), 'cached ' + f);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'sw.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /indexedDB|IDB|deleteDatabase|localStorage/, 'sw.js never touches app data');
}, { state: fixtureState() });

test('FP1 service worker release bump: this release is past lifeos-v1; a device with the released lifeos-v1 worker moves to the new cache, the old one is removed, data untouched', async ({ page }) => {
  const cur = SW_VER();
  assert.match(cur, /^lifeos-v\d+$/); assert.ok(Number(cur.slice(8)) >= 2, 'CACHE_VERSION bumped for this release (was lifeos-v1)');
  const src = SW_SRC();
  assert.match(src, /req\.mode === 'navigate'[\s\S]*await fetch\(req\)/, 'pages stay network-first');
  assert.match(src, /const cached = await matchAny\(req\)[\s\S]*event\.waitUntil\(refresh/, 'other files stay stale-while-revalidate');
  assert.ok(await swReady(page)); await reload(page);
  const before = await idbState(page);
  // the previously released worker (same code, lifeos-v1) is what a returning user has installed
  serverOverrides['sw.js'] = src.replace(/const CACHE_VERSION = '[^']+';/, "const CACHE_VERSION = 'lifeos-v1';");
  try {
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
    await page.waitForFunction(async () => { const k = await caches.keys(); return k.length === 1 && k[0] === 'lifeos-v1'; }, null, { timeout: 10000 });
  } finally { delete serverOverrides['sw.js']; }
  await page.waitForTimeout(300);
  // deploy of this release
  await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
  await page.waitForFunction(async cur => { const k = await caches.keys(); return k.includes(cur); }, cur, { timeout: 10000 });
  await page.waitForTimeout(500); await page.evaluate(() => fetch('manifest.json').then(r => r.text()));
  await page.waitForFunction(async () => !(await caches.keys()).includes('lifeos-v1'), null, { timeout: 10000 });
  const c = await cacheState(page);
  assert.deepEqual(Object.keys(c), [cur], 'only the new cache');
  for (const f of ['/LifeOS.html', '/index.html', '/manifest.json']) assert.ok(c[cur].includes(f), 'new cache holds ' + f);
  assert.deepEqual(await idbState(page), before, 'IndexedDB untouched');
  await reload(page); assert.deepEqual(await idbState(page), before);
  assert.equal(await page.evaluate(() => S.schemaVersion), 8);
  assert.equal(await page.evaluate(() => (navigator.serviceWorker.controller || {}).scriptURL || ''), URL_ + 'sw.js');
}, { state: fixtureState() });

test('P3-E3 offline: reload, a fresh start and index.html open from the cache with all data; back online everything saves as before', async ({ page }) => {
  const ctx = page.context();
  assert.ok(await swReady(page)); await reload(page);
  await page.evaluate(() => { S.tasks.push({ id: 'off1', title: 'Před výpadkem', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await settle(page);
  await ctx.setOffline(true);
  await reload(page);
  assert.ok(await page.evaluate(() => S.tasks.some(t => t.id === 'off1')), 'offline reload keeps data');
  await page.evaluate(() => { S.tasks.push({ id: 'off2', title: 'Offline změna', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await settle(page);
  await page.close();
  const p2 = await ctx.newPage(); await p2.clock.setFixedTime(NOW); await p2.goto(URL_ + 'index.html');
  await p2.waitForFunction(() => location.pathname.endsWith('/LifeOS.html') && typeof S !== 'undefined' && S && tabActive, null, { timeout: 10000 });
  assert.ok(await p2.evaluate(() => ['off1', 'off2'].every(id => S.tasks.some(t => t.id === id))), 'fresh offline start via index.html has all data');
  await ctx.setOffline(false);
  await p2.reload(); await p2.waitForFunction(() => typeof S !== 'undefined' && S && tabActive);
  await p2.evaluate(() => { S.tasks.push({ id: 'on1', title: 'Znovu online', priority: 'Low', dueDate: todayStr(), done: false, createdAt: 1 }); scheduleSave(); }); await p2.waitForTimeout(450);
  await p2.reload(); await p2.waitForFunction(() => typeof S !== 'undefined' && S && tabActive);
  assert.ok(await p2.evaluate(() => ['off1', 'off2', 'on1'].every(id => S.tasks.some(t => t.id === id))), 'online again: saved + reloaded');
  await p2.close();
}, { state: fixtureState() });

test('P3-E4 update: a new sw.js version installs, removes the old lifeos cache (other caches stay), tells the user, and IndexedDB data is untouched', async ({ page }) => {
  assert.ok(await swReady(page)); await reload(page);
  await page.evaluate(async () => { const c = await caches.open('other-app'); await c.put('/other.txt', new Response('x')); });
  const before = await idbState(page);
  const cur = SW_VER(), next = 'lifeos-v' + (Number(cur.replace('lifeos-v', '')) + 1);
  serverOverrides['sw.js'] = SW_SRC().replace(`const CACHE_VERSION = '${cur}';`, `const CACHE_VERSION = '${next}';`);
  assert.notEqual(serverOverrides['sw.js'], SW_SRC(), 'test version published');
  try {
    await page.evaluate(() => { window.__toastLog = []; const t0 = window.toast; window.toast = function (m) { window.__toastLog.push(String(m)); return t0.apply(this, arguments); }; });
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
    await page.waitForFunction(async ([cur, next]) => { const k = await caches.keys(); return k.includes(next) && !k.includes(cur); }, [cur, next], { timeout: 10000 });
    await page.waitForTimeout(500); await page.evaluate(() => fetch('manifest.json').then(r => r.text())); // a request through the new worker
    await page.waitForFunction(async cur => !(await caches.keys()).includes(cur), cur, { timeout: 10000 });
    const c = await cacheState(page);
    assert.deepEqual(Object.keys(c).sort(), [next, 'other-app'], 'old app cache removed, foreign cache kept');
    assert.ok(c[next].includes('/LifeOS.html'));
    await page.waitForFunction(() => (window.__toastLog || []).some(m => /nová verze/i.test(m)), null, { timeout: 5000 });
    assert.deepEqual(await idbState(page), before, 'IndexedDB unchanged by the update');
    await reload(page); assert.deepEqual(await idbState(page), before, 'and after reloading into the new version');
  } finally { delete serverOverrides['sw.js']; }
}, { state: fixtureState() });

test('P3-E5 opened as a local file the app works as before: no service worker, no manifest request, no console errors', async ({ page }) => {
  const errs = []; const p = await page.context().newPage();
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + APP); await p.waitForFunction(() => typeof S !== 'undefined' && S);
  assert.deepEqual(await p.evaluate(() => [location.protocol, document.getElementById('manifestLink').getAttribute('href'), !!(navigator.serviceWorker && navigator.serviceWorker.controller)]), ['file:', null, false]);
  assert.ok(await p.evaluate(() => !!S && tabActive), 'app runs');
  await p.waitForTimeout(300); assert.deepEqual(errs, []); await p.close();
});

// ---------- Polish pass 3: F data safety ----------
test('P3-F1 every destructive action asks first: deletes, reset, restore from backup (cancel keeps everything)', async ({ page }) => {
  const snap = () => page.evaluate(() => JSON.stringify(S));
  const s0 = await snap();
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  await page.evaluate(() => { S.tasks.push({ id: 'new', title: 'po exportu', priority: 'Low', done: false, createdAt: 1 }); render(); });
  const s1 = await snap();
  await page.setInputFiles('#st_impFile', await dl.path()); await page.waitForSelector('.cf-sheet');
  assert.match(await page.locator('.cf-sheet').innerText(), /Obnovit ze zálohy\?[\s\S]*nahradí[\s\S]*úkoly \d+/);
  await page.click('#cf_cancel'); assert.equal(await snap(), s1, 'cancel: nothing replaced');
  await page.setInputFiles('#st_impFile', await dl.path()); await page.click('#cf_ok'); await page.waitForTimeout(200);
  assert.equal(await snap(), s0, 'confirm: restored');
  await page.click('#st_reset'); await page.click('#cf_cancel'); assert.equal(await snap(), s0, 'reset cancel');
  await go(page, 'tasks'); await page.locator('#tlist .delbtn').first().click(); await page.click('#cf_cancel'); assert.equal(await snap(), s0, 'delete cancel');
}, { state: fixtureState() });

test('P3-F2 deletes leave no broken reference: task/goal/habit/workout/template/subscription/vehicle/meal/sleep removed -> every screen and form renders cleanly', async ({ page }) => {
  await page.evaluate(() => { exerciseAddPreset('Bench Press'); const t = templateSave({ name: 'Ref', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 1, repsMin: 5, weight: 50 }] }).template.id;
    S.plannerBlocks.push({ id: 'refb', title: 'Propojený blok', date: todayStr(), startTime: '19:00', endTime: '20:00', category: 'Work', taskId: 't_open', goalId: 'g_fit', workoutId: 'w1', workoutTemplateId: t, completed: false, createdAt: 1 });
    S.habits.find(h => h.id === 'h_read').goalId = 'g_fit'; window.__tpl = t; });
  const del = async (setup, sel) => { await page.evaluate(setup => { closeSheets(); eval(setup); }, setup); await page.locator(sel).first().click(); await page.click('#cf_ok'); };
  await del("view='tasks';taskFilter='All';render()", '#tlist .item:has-text("Write report") .delbtn');
  await del("view='goals';goalFilter='All';render()", '.goal-card:has-text("Get in shape") .delbtn');
  await del("fitnessTab='workouts';uiWorkoutView=null;view='fitness';render()", '#app .delbtn[aria-label^="Smazat: "]');
  await del("openTemplateForm(S.workoutTemplates.find(t=>t.id===window.__tpl))", '#tp_delete');
  await del("view='subscriptions';render()", '#app .item .delbtn');
  // Reality QA: no Car UI any more (its data stays), so no vehicle delete path
  await del("view='nutrition';render()", '#app .meal-item .delbtn, #app .item .delbtn');
  await del("healthTab='sleep';view='health';render()", '#app .item .delbtn');
  const st = await stateOf(page);
  assert.ok(!st.tasks.some(t => t.goalId === 'g_fit') && !st.habits.some(h => h.goalId === 'g_fit') && !st.milestones.some(m => m.goalId === 'g_fit'), 'goal links cleared');
  assert.ok(!st.carServices.some(x => !st.vehicles.some(v => v.id === x.vehicleId)) && !st.fuelEntries.some(x => !st.vehicles.some(v => v.id === x.vehicleId)), 'no orphan services/fuel');
  const bad = await page.evaluate(() => { const out = []; const check = (label, root) => { const t = root.innerText; for (const w of ['undefined', 'NaN', '[object', 'null']) if (new RegExp('(^|[^a-z])' + w.replace('[', '\\[') + '($|[^a-z])').test(t)) out.push(label + ': ' + w); };
    for (const v of ['home', 'tasks', 'habits', 'goals', 'character', 'finance', 'fitness', 'nutrition', 'notes', 'journal', 'car', 'subscriptions', 'calendar', 'quests', 'statistics', 'search', 'health', 'goalDetail', 'habitDetail', 'settings', 'planner']) {
      currentGoalId = 'g_fit'; currentHabitId = 'h_read'; uiPlannerDay = todayStr(); view = v; render(); check(v, document.getElementById('app')); }
    closeSheets(); openPlannerForm(S.plannerBlocks.find(b => b.id === 'refb')); check('planner form', document.querySelector('.sheet'));
    closeSheets(); openDayOverview(todayStr()); check('day overview', document.querySelector('.sheet')); closeSheets();
    ['week', 'month', 'year', 'all'].forEach(p => { try { computeStats(p); } catch (e) { out.push('stats ' + p + ': ' + e.message); } });
    getActiveReminders().forEach(r => { if (r.navType !== 'quest' && !resolveReminderEntity(r.navType, r.id)) out.push('reminder to a missing ' + r.navType); }); // quest reminders open the board, not a record
    return out; });
  assert.deepEqual(bad, []);
  assert.equal(await page.evaluate(() => { currentGoalId = 'g_fit'; view = 'goalDetail'; render(); return view; }), 'goals', 'a stale goal detail falls back to the goal list');
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.match(await page.locator('.cg-it[data-id="refb"]').innerText(), /smazáno|missing/i, 'the block says its task is gone instead of linking to it');
}, { state: fixtureState() });

// ---------- Polish pass 3: G performance (realistic year) ----------
test('P3-G1 realistic year (1 500 tasks / 25 000 XP): Home, Tasks, Statistics, Search, Quests stay fast; Dnes shows 10 oldest overdue + a link, Search draws 30 hits per group with the full count', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3));
    const m = (f, n = 3) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t) / n; };
    const search = () => { view = 'search'; render(); const g = document.getElementById('gs'); g.value = 'úkol'; g.dispatchEvent(new Event('input')); };
    return { home: m(() => { view = 'home'; render(); }), tasks: m(() => { view = 'tasks'; taskFilter = 'Today'; render(); }), statistics: m(() => { view = 'statistics'; render(); }, 2), search: m(search), quests: m(() => { view = 'quests'; render(); }) }; });
  console.log('      P3-G1 ' + Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  assert.ok(r.home < 300 && r.tasks < 150 && r.statistics < 800 && r.search < 150 && r.quests < 150, JSON.stringify(r));
  await page.evaluate(() => { view = 'tasks'; taskFilter = 'Today'; render(); });
  const t = await page.evaluate(() => { const tt = tasksToday(); return { shown: document.querySelectorAll('#tlist .item').length, due: tt.due.length, overdue: tt.overdue.length }; });
  assert.equal(t.shown, t.due + Math.min(10, t.overdue)); assert.ok(t.overdue > 10);
  await page.click('[data-more="overdue"]'); assert.equal(await page.evaluate(() => taskFilter), 'Overdue');
  await page.evaluate(() => { view = 'search'; render(); const g = document.getElementById('gs'); g.value = 'úkol'; g.dispatchEvent(new Event('input')); });
  const sr = await page.evaluate(() => ({ hits: document.querySelectorAll('#gsRes .search-hit').length, head: document.querySelector('#gsRes .section-header h3').textContent, more: document.querySelector('#gsRes .search-more')?.textContent }));
  assert.ok(sr.hits <= 30 * 12 && /· \d{3,}/.test(sr.head) && /dalších \d+/.test(sr.more), JSON.stringify(sr));
});

// ---------- Final review before merge ----------
test('RV1 an older sleep record (keyed sleep:<id>) cannot be farmed: delete + log the same night again, a duplicate entry or an edit pay nothing; a new night still pays', async ({ page }) => {
  await quietQuests(page);
  await page.evaluate(() => { const D = addDays(todayStr(), -5); S.sleepLog.push({ id: 'legacy1', date: D, bedtime: '23:00', wake: '07:00', quality: 3, createdAt: 1 });
    S.xpLog.push({ id: 'lgx', amount: 10, reason: 'Sleep logged', ts: new Date(D + 'T08:00').getTime(), key: 'sleep:legacy1' }); scheduleSave(); });
  const hist = await page.evaluate(() => JSON.stringify(S.xpLog.filter(x => /^sleep:/.test(x.key || ''))));
  const x0 = await xpOf(page);
  const logNight = async d => { await page.evaluate(() => { closeSheets(); openSleepForm(); }); await page.fill('#sl_date', d); await page.click('#sl_save'); };
  const D = await page.evaluate(() => addDays(todayStr(), -5));
  await logNight(D); assert.equal(await xpOf(page) - x0, 0, 'a second entry for a night the old record paid');
  await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(r => r.id !== 'legacy1'); }); await logNight(D);
  assert.equal(await xpOf(page) - x0, 0, 'delete the old record + log the same night again');
  await persist(page); await reload(page); await logNight(D); assert.equal(await xpOf(page) - x0, 0, 'after reload too');
  await logNight(await page.evaluate(() => todayStr())); assert.equal(await xpOf(page) - x0, 10, 'a genuinely new night pays');
  assert.equal(await page.evaluate(() => JSON.stringify(S.xpLog.filter(x => /^sleep:(?!day:)/.test(x.key || '')))), JSON.stringify(JSON.parse(hist).filter(x => /^sleep:(?!day:)/.test(x.key))), 'older XP entries untouched');
}, { state: fixtureState() });

test('RV2 backups and achievements: an exported backup never pays achievements again; an old backup without an achievement list (and so without achievement XP) pays each unlocked achievement exactly once', async ({ page }) => {
  await quietQuests(page);
  await page.click('#settingsBtn'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const x0 = await xpOf(page); await importFile(page, await dl.path()); await page.waitForTimeout(200); await page.evaluate(() => checkAchievements());
  assert.equal(await xpOf(page), x0, 'own export: nothing paid again');
  const legacy = { tasks: Array.from({ length: 12 }, (_, i) => ({ id: 'lt' + i, title: 'Old ' + i, done: true, createdAt: 1 })), habits: [], totalXp: 800, xpLog: [], schemaVersion: 4 };
  const f = path.join(here, 'out', 'legacy-no-achievements.json'); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(legacy));
  await importFile(page, f); await page.waitForFunction(() => S.tasks.some(t => t.id === 'lt0'));
  await page.evaluate(() => checkAchievements());
  const a = await page.evaluate(() => ({ n: S.achievementsUnlocked.length, paid: S.xpLog.filter(x => x.reason === 'Achievement').length, xp: S.totalXp }));
  assert.ok(a.n >= 1, 'achievements unlock from the old data');
  await page.evaluate(() => checkAchievements()); await persist(page); await reload(page); await page.evaluate(() => checkAchievements());
  assert.deepEqual(await page.evaluate(() => [S.achievementsUnlocked.length, S.xpLog.filter(x => x.reason === 'Achievement').length, S.totalXp]), [a.n, a.paid, a.xp], 'paid once: repeated checks and reload add nothing');
}, { state: fixtureState() });

test('RV3 XP matrix: every source against repeat / reopen / delete+re-add / alternative path / backdating / double click pays within its rule', async ({ page }) => {
  const r = await page.evaluate(() => { const rq = window.checkQuests; window.checkQuests = () => false; S.achievementsUnlocked = ACHV.map(a => a.id);
    const out = {}; const d = (k, f) => { const a = S.totalXp; f(); out[k] = S.totalXp - a; };
    const click = sel => document.querySelector(sel).click();
    d('task: 5 distinct', () => { for (let i = 0; i < 5; i++) { const t = { id: 'tt' + i, title: 'T' + i, priority: 'Urgent', dueDate: todayStr(), done: true, createdAt: 1 }; S.tasks.push(t); taskGrantCompletion(t); } });
    d('task: delete + re-add same x5', () => { for (let i = 0; i < 5; i++) { S.tasks = S.tasks.filter(t => t.title !== 'Same'); const t = { id: uid(), title: 'Same', priority: 'Urgent', dueDate: todayStr(), done: true, createdAt: 1 }; S.tasks.push(t); taskGrantCompletion(t); } });
    d('task: reopen/complete x5', () => { const t = S.tasks.find(t => t.id === 'tt0'); for (let i = 0; i < 5; i++) taskGrantCompletion(t); });
    d('habit: toggle x5', () => { const h = S.habits.find(h => h.id === 'h_read'); for (let i = 0; i < 5; i++) toggleHabitDay(h); });
    d('habit: delete + re-add same x5', () => { for (let i = 0; i < 5; i++) { S.habits = S.habits.filter(h => h.name !== 'Loop'); const h = migrateHabit({ id: uid(), name: 'Loop', category: 'Health', completions: [], active: true, createdAt: 1 }); S.habits.push(h); toggleHabitDay(h); } });
    d('goal: saved as Completed', () => { openGoalForm(); document.getElementById('g_title').value = 'Hned'; document.getElementById('g_status').value = 'Completed'; click('#g_save'); });
    d('goal: 5 distinct', () => { for (let i = 0; i < 5; i++) { const g = { id: 'gg' + i, title: 'G' + i, status: 'Active', mode: 'manual', createdAt: 1 }; S.goals.push(g); completeGoal(g); } });
    d('goal: reopen + complete', () => { const g = S.goals.find(g => g.id === 'gg0'); g.status = 'Active'; completeGoal(g); });
    d('milestone: 12 distinct', () => { for (let i = 0; i < 12; i++) { const m = { id: 'mm' + i, goalId: 'g_fit', title: 'M' + i, completed: false, createdAt: 1 }; S.milestones.push(m); toggleMilestone(m); } });
    d('milestone: toggle x5', () => { const m = S.milestones.find(m => m.id === 'mm0'); for (let i = 0; i < 5; i++) { toggleMilestone(m); toggleMilestone(m); } });
    exerciseAddPreset('Bench Press'); const tpl = templateSave({ name: 'A', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 1, repsMin: 5, weight: 50 }] }).template.id;
    d('workout: 5 finished', () => { for (let i = 0; i < 5; i++) { const w = workoutStart({ templateId: tpl }).workout; const en = w.entries[0]; workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true }); workoutFinish(w.id); } });
    d('workout: log form backdated x3', () => { for (let i = 0; i < 3; i++) { closeSheets(); openWorkoutForm(); document.getElementById('w_name').value = 'L' + i; document.getElementById('w_date').value = addDays(todayStr(), -10 - i); const row = document.querySelector('.ex-edit'); row.querySelector('.exn').value = 'Dřep'; row.querySelector('.exs').value = '3'; click('#w_save'); } });
    d('workout: second Finish', () => workoutFinish(completedWorkouts(S).slice(-1)[0].id));
    d('meal: 10 of all types', () => { for (let i = 0; i < 10; i++) { const m = { id: uid(), name: 'F', type: ['Breakfast', 'Lunch', 'Dinner', 'Snack'][i % 4], date: todayStr(), createdAt: 1 }; S.meals.push(m); grantXp(10, 'Meal logged', mealAttrProfile(), mealXpKey(m)); } });
    d('sleep: 10 backfilled nights', () => { for (let i = 0; i < 10; i++) { closeSheets(); openSleepForm(); document.getElementById('sl_date').value = addDays(todayStr(), -30 - i); click('#sl_save'); } });
    d('journal: 5 entries', () => { for (let i = 0; i < 5; i++) { closeSheets(); openJournalForm(); click('#j_save'); } });
    d('finance: 5 transactions', () => { for (let i = 0; i < 5; i++) { financeSaveTransaction('expense', { amount: 10, categoryId: S.financeCategories[0].id, date: todayStr(), description: 'x' }); financeGrantXp(); } });
    d('achievements: 3 checks', () => { checkAchievements(); checkAchievements(); checkAchievements(); });
    closeSheets(); rq(); d('quests: repeated checks', () => { rq(); rq(); }); window.checkQuests = rq; return out; });
  assert.deepEqual(r, { 'task: 5 distinct': 200, 'task: delete + re-add same x5': 40, 'task: reopen/complete x5': 0, 'habit: toggle x5': 0, 'habit: delete + re-add same x5': 15,
    'goal: saved as Completed': 0, 'goal: 5 distinct': 400, 'goal: reopen + complete': 0, 'milestone: 12 distinct': 250, 'milestone: toggle x5': 0,
    'workout: 5 finished': 160, 'workout: log form backdated x3': 0, 'workout: second Finish': 0, 'meal: 10 of all types': 40, 'sleep: 10 backfilled nights': 10,
    'journal: 5 entries': 15, 'finance: 5 transactions': 5, 'achievements: 3 checks': 0, 'quests: repeated checks': 0 });
}, { state: fixtureState() });

test('RV4 a daily XP limit never blocks the record itself and says why: workout, goal, milestone and sleep are saved; the next day pays again; per-item amounts unchanged', async ({ page }) => {
  await quietQuests(page); await spyToasts(page);
  await page.evaluate(() => { S.achievementsUnlocked = ACHV.map(a => a.id); exerciseAddPreset('Bench Press'); window.__t = templateSave({ name: 'B', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 1, repsMin: 5, weight: 50 }] }).template.id; });
  const fin = () => page.evaluate(() => { const w = workoutStart({ templateId: window.__t }).workout; const en = w.entries[0]; workoutUpdateSet(w.id, en.id, en.sets[0].id, { done: true }); const a = S.totalXp, v = S.attrs.STR; const r = workoutFinish(w.id); return [S.totalXp - a, S.attrs.STR - v, w.status]; });
  assert.deepEqual(await fin(), [80, 24, 'done']); assert.deepEqual(await fin(), [80, 24, 'done']);
  assert.deepEqual(await fin(), [0, 0, 'done'], 'third workout of the day: saved, no XP');
  assert.match(await toastsText(page), /limit XP/);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) { const g = { id: 'gl' + i, title: 'GL' + i, status: 'Active', mode: 'manual', createdAt: 1 }; S.goals.push(g); completeGoal(g); } });
  assert.deepEqual(await page.evaluate(() => S.goals.filter(g => /^gl/.test(g.id)).map(g => g.status)), ['Completed', 'Completed', 'Completed'], 'the third goal is closed too');
  await page.clock.setFixedTime(NOW + 86400000);
  assert.deepEqual(await fin(), [80, 24, 'done'], 'next day pays again');
  assert.equal(await page.evaluate(() => { const g = S.goals.find(g => g.id === 'gl2'); g.status = 'Active'; const a = S.totalXp; completeGoal(g); return S.totalXp - a; }), 200, 'a goal blocked by yesterday\'s limit can still be rewarded once later');
}, { state: fixtureState() });

test('RV5 Planner: blocks with link chips are tall enough - nothing clipped at the block bottom at 320-1440 px, taps open the right block', async ({ page }) => {
  const bad = [];
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => { S.plannerBlocks.push({ id: 'lk2', title: 'Druhý s odkazem', date: todayStr(), startTime: '15:10', endTime: '15:50', category: 'Work', taskId: 't_med', goalId: 'g_fit', completed: false, createdAt: 1 }); uiOpenPlanner(todayStr()); });
    const r = await page.evaluate(() => [...document.querySelectorAll('.cg-it[data-kind="block"]')].flatMap(n => { n.scrollIntoView({ block: 'center' }); const nb = n.getBoundingClientRect();
      const cut = [...n.querySelectorAll('.cg-t,.cg-m,.cg-lk,.cg-chk,.cg-wk')].filter(e => { const b = e.getBoundingClientRect(); return b.height && getComputedStyle(e).display !== 'none' && b.bottom > nb.bottom + 0.5; }).map(e => n.dataset.id + ' cut ' + e.className.split(' ')[0]);
      const hit = document.elementFromPoint(nb.left + nb.width / 2, nb.top + Math.min(20, nb.height / 2)); if (!hit || hit.closest('.cg-it') !== n) cut.push(n.dataset.id + ' tap hits another block');
      return cut; }));
    r.forEach(x => bad.push(width + ': ' + x));
    await page.evaluate(() => { S.plannerBlocks = S.plannerBlocks.filter(b => b.id !== 'lk2'); });
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('RV6 data safety sweep: archive (goal, habit, category, exercise), deletes, import and reset leave no undefined/NaN, no duplicate ids, and XP totals match the ledger', async ({ page }) => {
  const sweep = () => page.evaluate(() => { const out = [];
    for (const v of ['home', 'tasks', 'habits', 'goals', 'character', 'finance', 'fitness', 'nutrition', 'notes', 'journal', 'car', 'subscriptions', 'calendar', 'quests', 'statistics', 'search', 'health', 'goalDetail', 'habitDetail', 'settings', 'planner']) {
      currentGoalId = S.goals[0] ? S.goals[0].id : 'x'; currentHabitId = S.habits[0] ? S.habits[0].id : 'x'; uiPlannerDay = todayStr(); view = v; render();
      const t = document.getElementById('app').innerText; for (const w of ['undefined', 'NaN', '[object']) if (t.includes(w)) out.push(v + ': ' + w);
      const ids = {}; document.querySelectorAll('[id]').forEach(e => ids[e.id] = (ids[e.id] || 0) + 1); const dup = Object.keys(ids).filter(k => ids[k] > 1); if (dup.length) out.push(v + ' dup ' + dup); }
    const ids = [...S.tasks, ...S.habits, ...S.goals, ...S.milestones, ...S.notes, ...S.meals, ...S.workouts, ...S.plannerBlocks, ...S.xpLog].map(x => x.id); if (new Set(ids).size !== ids.length) out.push('duplicate record ids');
    return out; });
  const x0 = await page.evaluate(() => [S.totalXp, S.xpLog.reduce((a, x) => a + x.amount, 0)]);
  await page.evaluate(() => { const g = S.goals.find(g => g.id === 'g_done') || S.goals[0]; g.status = 'Archived'; const h = S.habits.find(h => h.id === 'h_smoke') || S.habits[0]; h.active = false;
    const c = catList('life')[0]; catSetArchived(c.key, 'life', true); exerciseAddPreset('Plank'); exerciseDelete(exerciseFind('Plank').id); scheduleSave(); });
  assert.deepEqual(await sweep(), [], 'after archiving');
  await page.evaluate(() => { closeSheets(); view = 'tasks'; taskFilter = 'All'; render(); }); await page.locator('#tlist .delbtn').first().click(); await page.click('#cf_ok');
  await page.evaluate(() => { closeSheets(); view = 'notes'; render(); }); await page.locator('#app .delbtn').first().click(); await page.click('#cf_ok');
  assert.deepEqual(await sweep(), [], 'after deletes');
  const x1 = await page.evaluate(() => [S.totalXp, S.xpLog.reduce((a, x) => a + x.amount, 0)]);
  assert.equal(x1[0] - x0[0], x1[1] - x0[1], 'every XP change is in the ledger (no phantom XP)');
  await page.click('#settingsBtn'); const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const before = await stateOf(page); await importFile(page, await dl.path()); await page.waitForTimeout(200);
  assert.deepEqual(await stateOf(page), before, 'export -> import is lossless'); assert.deepEqual(await sweep(), [], 'after import');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); await page.click('.sheet [data-ob="skip"]');
  assert.deepEqual(await sweep(), [], 'after reset');
}, { state: fixtureState() });

test('golden: model, rules and computed numbers match the recorded baseline', async ({ page }) => {
  const g = await golden(page);
  if (args.includes('--write-golden') || !existsSync(GOLDEN)) { writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n'); notes.push('golden.json written'); return; }
  const base = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  for (const k of Object.keys(base)) assert.deepEqual(g[k], base[k], `golden.${k}`);
  assert.deepEqual(Object.keys(g).sort(), Object.keys(base).sort());
}, { state: fixtureState() });

// Pure, deterministic outputs of the app's rule tables and calculators on the fixture.
async function golden(page) {
  return page.evaluate(TODAY_ => {
    // Normalise the only non-deterministic bits: timestamps and freshly generated uid()s.
    const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (['createdAt', 'updatedAt', 'ts'].includes(k) && typeof v === 'number') ? '<time>'
      : (k === 'id' && typeof v === 'string' && /^[0-9a-z]{12,}$/.test(v)) ? '<uid>' : v));
    const fnMap = arr => Object.fromEntries(arr.map(x => [x.id, JSON.parse(JSON.stringify(x))]));
    const legacy = { tasks: [{ id: 'lt', title: 'Legacy', done: true, createdAt: 1 }],
      habits: [{ id: 'lh', name: 'Legacy habit', category: 'Health', icon: '💧', completions: ['2026-09-20'], active: true, createdAt: 1 }],
      sleepLog: [{ id: 'ls', date: '2026-09-20', bedtime: '23:00', wake: '07:00', quality: 4, createdAt: 1 }],
      workouts: [{ id: 'lw', name: 'Old', date: '2026-09-19', exercises: [{ id: 'le', name: 'Squat', sets: 3, reps: 5, weight: 100 }] }],
      totalXp: 800, xpLog: [], rpg: undefined, schemaVersion: 4 };
    const periods = ['week', 'month', 'year', 'all'];
    return {
      xpForLevel: Array.from({ length: 60 }, (_, i) => xpForLevel(i + 1)),
      levelFromXp: [0, 99, 100, 355, 356, 1234, 1448, 5000, 100000].map(levelFromXp),
      achievements: fnMap(ACHV), // polish pass: the Skill Tree (SKILLS / branches / ATTRIBUTE_POINT_VALUE) was removed
      attrProfiles: ATTR_PROFILES, taskXp: TASK_XP, habitXp: HABIT_XP, lifeCategories: strip(catList('life')), noteCategories: strip(catList('notes')),
      attrGains: ['fitness', 'work', 'STR', 'learning', 'sleep'].map(p => [p, rpgAttrGains(48, p), rpgAttrGains(9, p)]),
      attrRates: [ATTR_RATE, QUEST_ATTR_RATE], questAttrs: [...DAILY_QUESTS, ...WEEKLY_QUESTS].map(q => [q.id, questAttrOf(q, q.id === 'dq_category' ? { cat: 'Learning' } : {})]),
      questBoard: { daily: questCandidates('daily', TODAY_).map(x => [x.q.id, x.p]), weekly: questCandidates('weekly', TODAY_).map(x => [x.q.id, x.p]) },
      dailyQuests: fnMap(DAILY_QUESTS), weeklyQuests: fnMap(WEEKLY_QUESTS),
      cats: CATS, attrs: Object.keys(ATTRS), widgets: WIDGET_DEFS, avatars: AVATAR_CHOICES, onboardingPresets: ONBOARDING_HABIT_PRESETS,
      i18nKeys: Object.fromEntries(Object.entries(I18N).map(([l, t]) => [l, Object.keys(t).sort()])),
      defaultState: strip(defaultState()),
      migrateLegacy: strip(migrate(JSON.parse(JSON.stringify(legacy)))),
      stats: Object.fromEntries(periods.map(p => { try { return [p, strip(computeStats(p))]; } catch (e) { return [p, 'ERR ' + e.message]; } })),
      sleepStats: strip(sleepStats('week')), healthDashboard: Object.fromEntries(periods.map(p => [p, strip(healthDashboardData(p))])),
      streaks: Object.fromEntries(S.habits.map(h => [h.id, [currentStreak(h), bestStreak(h), habitProgressLabel(h), habitProgressPct(h)]])),
      goals: Object.fromEntries(S.goals.map(g => [g.id, goalProgress(g)])),
      level: levelFromXp(S.totalXp), xpToday: xpToday(),
      finance: monthBalance(S), fuel: fuelConsumptionStats('v1'), prs: exercisePRs(), workouts: S.workouts.map(w => [workoutVolume(w), workoutTotalSets(w), workoutTotalReps(w)]),
      nutrition: nutriTotals(TODAY_), water: waterToday(),
      subs: S.subscriptions.map(s => nextPaymentDate(s)), carReminders: strip(S.vehicles.map(carReminders)),
      reminders: strip(getActiveReminders()), search: strip(searchGroups('a')),
      quests: [DAILY_QUESTS, WEEKLY_QUESTS].flat().map(q => [q.id, q.check(S), q.val(S)]),
      achievementsNow: ACHV.map(a => [a.id, a.cond(S), a.progress ? a.progress(S) : null]),
    };
  }, TODAY).catch(e => { throw new Error('golden evaluation failed: ' + e.message); });
}

// ---------- Smart Daily Command Center 2.0 ----------
// Home as the day's control centre. Everything is read from the existing state through the cc* helpers; the tests check
// the scenarios, the priority rules (deterministic, explainable), that the Daily Score and XP stay exactly the existing
// ones, that habits/tasks are completed only through the existing handlers, and persistence, performance, layout, a11y.
const at = hm => new Date(`${TODAY}T${hm}:00+02:00`).getTime(); // Prague wall-clock time on the fixture day
const ccHome = page => page.evaluate(() => { closeSheets(); view = 'home'; render(); });
const ccNowOf = page => page.evaluate(() => { const c = ccContext(), r = ccRank(ccCandidates(c)), n = ccNow(c, r);
  return { mode: n.mode, title: n.item ? n.item.title : null, kind: n.item ? n.item.kind : null, reasons: n.item ? n.item.reasons.map(x => x.r) : [], dom: (document.querySelector('#ccNow') || {dataset: {}}).dataset.ccMode }; });
const ccBad = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
const ccData = page => page.evaluate(() => JSON.stringify(['tasks', 'goals', 'habits', 'plannerBlocks', 'milestones', 'workouts', 'meals', 'expenses', 'income', 'events', 'totalXp', 'attrs'].map(k => S[k])) + '|' + S.xpLog.length);

test('CC1 Home is the Command Center by default: Co teď? with reasons, quick actions, attention, Dnešek, Top 3, progress, habits, goals, quests, status', async ({ page }) => {
  await ccHome(page);
  assert.equal(await page.locator('.cc-home[data-home="smart"]').count(), 1, 'Smart Home is the default Home');
  assert.equal(await page.locator('.cc-home .hud .level-badge').count(), 1, 'header keeps greeting, date, level and XP');
  assert.match(await page.locator('.hud-date').innerText(), /12:00/, 'header shows the time');
  const n = await ccNowOf(page);
  assert.deepEqual([n.mode, n.title, n.dom], ['next', 'Matematika', 'next'], 'the block linked to the High task due today comes next');
  assert.ok(n.reasons.includes('linked_task') && n.reasons.includes('in_plan'), 'explained by its link and the plan');
  await page.click('#ccNow .cc-why summary');
  const why = await page.locator('#ccNow .cc-why').innerText();
  assert.match(why, /Propojený úkol s prioritou vysoká, termín dnes/); assert.match(why, /Je v dnešním plánu/);
  assert.doesNotMatch(await appText(page), /\bAI\b|umělá inteligence/i, 'no AI wording');
  assert.deepEqual(await page.$$eval('#ccTop .cc-top-t', ns => ns.map(n => n.textContent)), ['Buy groceries', 'Drink water', 'Konzultace'], 'Top 3 without the Co teď item, quests excluded');
  assert.deepEqual(await page.$$eval('.cc-q', ns => ns.map(n => n.dataset.q)), ['task', 'habit', 'food', 'workout']);
  const attn = await page.$$eval('#ccAttn .cc-attn-row', ns => ns.map(n => n.innerText));
  assert.ok(attn.length >= 1 && attn.length <= 3, 'attention: 1-3 items'); assert.match(attn.join('|'), /Team meeting v 14:00/);
  // timeline from the Planner data: states ✓ ● → ! with nothing invented
  const tl = await page.$$eval('#ccTimeline .cc-tl-row', ns => ns.map(n => [n.querySelector('.cc-tl-time').firstChild.textContent, n.className.match(/is-(\w+)/)[1], n.querySelector('.cc-tl-mark').textContent]));
  assert.deepEqual(tl, [['08:00', 'done', '✓'], ['14:00', 'next', '→'], ['15:00', 'later', ''], ['15:30', 'later', ''], ['17:00', 'later', '']], 'Škola done, next marked, no fake gaps');
  for (const s of ['#ccDay [data-ds="card"]', '#ccDay .cc-prog', '#ccHabits #hHabits .habit-item', '#ccGoals .cc-goal', '#ccQuests .quest-row', '#ccMini .cc-tile']) assert.ok(await page.locator(s).count() > 0, s);
  assert.match(await page.locator('#ccMini [data-mini="finance"]').innerText(), /1\s620[\s\S]*rozpočet 420 \/ 6\s000/, 'finance: real month spending and budget');
  assert.match(await page.locator('#ccMini [data-mini="fitness"]').innerText(), /2\s*\/3/);
  assert.match(await page.locator('#ccMini [data-mini="health"]').innerText(), /7,3\s*h/);
  assert.deepEqual(await ccBad(page), { bad: false, dup: [], overflow: 0 });
  // clicks go to the existing screens
  await page.click('#ccTop .cc-top-row:first-child .cc-top-main'); assert.equal(await page.evaluate(() => view), 'tasks'); assert.ok(await page.locator('.sheet #f_title').isVisible(), 'task editor');
  await ccHome(page); await page.click('#ccGoals .cc-goal'); assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'g_fit']);
  await ccHome(page); await page.click('#ccDay .cc-chip[data-cc-nav="tasks"]'); assert.equal(await page.evaluate(() => view), 'tasks');
  await ccHome(page); await page.click('#ccQuests [data-nav="quests"]'); assert.equal(await page.evaluate(() => view), 'quests');
}, { state: fixtureState() });

test('CC2 scenarios by the clock: running block = Teď, within 30 min = Další, missed blocks, a running workout wins, evening, day done, empty day', async ({ page }) => {
  const xp0 = await xpOf(page), xpLen0 = await page.evaluate(() => S.xpLog.length);
  await page.clock.setFixedTime(at('15:10')); await ccHome(page);
  let n = await ccNowOf(page); assert.deepEqual([n.mode, n.title, n.reasons[0]], ['now', 'Matematika', 'running']);
  assert.match(await page.locator('#ccNow .cc-kick').innerText(), /Teď/);
  assert.deepEqual(await page.$$eval('#ccTimeline .cc-tl-row.is-now .cc-tl-title', ns => ns.map(n => n.textContent)), ['Matematika']);
  await page.clock.setFixedTime(at('14:45')); await ccHome(page);
  n = await ccNowOf(page); assert.deepEqual([n.mode, n.title, n.reasons[0]], ['next', 'Matematika', 'starts_in']);
  assert.match(await page.locator('#ccNow .cc-why').textContent(), /Začíná za 15 min/);
  // 16:40: Matematika and Konzultace passed undone -> "!"; the workout block starts in 20 min
  await page.evaluate(() => { const bench = exerciseFind('Bench press'); // test setup: give PUSH A a workout template (the existing template API)
    S.plannerBlocks.find(b => b.id === 'pb_push').workoutTemplateId = templateSave({ name: 'Push A', exercises: [{ exerciseId: bench.id, sets: 3, repsMin: 8, repsMax: 10, weight: 80 }] }).template.id; });
  await page.clock.setFixedTime(at('16:40')); await ccHome(page);
  assert.equal(await page.locator('#ccTimeline .cc-tl-row.is-missed').count(), 2);
  assert.deepEqual(await page.$$eval('#ccTimeline .cc-tl-row.is-missed .cc-tl-mark', ns => ns.map(n => n.textContent)), ['!', '!']);
  n = await ccNowOf(page); assert.deepEqual([n.mode, n.title], ['next', 'PUSH A']); assert.ok(n.reasons.includes('workout_block'));
  assert.match(await page.locator('#ccNow [data-cc-act="startwk"]').innerText(), /Spustit trénink/);
  await page.evaluate(() => { plannerStartWorkout('pb_push'); }); await ccHome(page);
  n = await ccNowOf(page); assert.deepEqual([n.mode, n.kind, n.reasons[0]], ['now', 'workout', 'active_workout'], 'a running workout wins');
  assert.match(await page.locator('#ccNow [data-cc-act="go"]').innerText(), /Pokračovat/);
  assert.equal(await xpOf(page), xp0, 'nothing on Home paid XP');
  await page.evaluate(() => { S.workouts = S.workouts.filter(w => w.status !== 'active'); }); // test setup only: drop the started workout again
  // evening: everything important done, the journal is still open -> "Den je téměř hotový"
  await page.clock.setFixedTime(at('21:00'));
  await page.evaluate(() => { const T = todayStr(); S.tasks.forEach(t => { if (t.dueDate <= T) t.done = true; }); S.habits = S.habits.filter(h => h.id !== 'h_gym');
    const w = S.habits.find(h => h.id === 'h_water'); while (w.completions.filter(d => d === T).length < 8) w.completions.push(T);
    S.plannerBlocks.forEach(b => { if (b.date === T) b.completed = true; }); });
  await ccHome(page);
  n = await ccNowOf(page); assert.equal(n.mode, 'evening');
  assert.match(await page.locator('#ccNow').innerText(), /Den je téměř hotový[\s\S]*napsat deník/);
  await page.evaluate(() => S.journal.push({ id: 'jcc', date: todayStr(), mood: '🙂', rating: '4', text: 'x', tags: [], createdAt: Date.now() }));
  await ccHome(page);
  n = await ccNowOf(page); assert.equal(n.mode, 'done');
  assert.match(await page.locator('#ccNow').innerText(), /Den dokončen[\s\S]*Daily Score/);
  // the test setup completed tasks/blocks, so the existing quest logic may pay its quests on render -- nothing else may pay
  assert.deepEqual((await page.evaluate(n => [...new Set(S.xpLog.slice(n).map(x => x.key ? String(x.key).split(':')[0] : /^Quest:/.test(x.reason) ? 'quest' : x.reason))], xpLen0)).filter(k => k !== 'quest'), [], 'only the existing quests paid');
  const xpDone = await xpOf(page); await ccHome(page); await ccHome(page); await page.evaluate(() => uiMinuteTick());
  assert.equal(await xpOf(page), xpDone, 'the end-of-day state pays nothing');
  // an empty day on a fresh install -> CTAs to the existing forms
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; }); await ccHome(page);
  n = await ccNowOf(page); assert.equal(n.mode, 'empty');
  assert.equal(await page.locator('#ccNow [data-cc-empty]').count(), 3);
  await page.click('#ccNow [data-cc-empty="task"]'); assert.ok(await page.locator('.sheet #f_title').isVisible());
  await page.evaluate(() => closeSheets()); await page.click('#ccNow [data-cc-empty="block"]'); assert.ok(await page.locator('.sheet').isVisible(), 'planner form');
}, { state: fixtureState() });

test('CC3 priority engine: overdue > due today, priority order, running block first, goals/habits by deadline and time, completed never win, deterministic', async ({ page }) => {
  const r = await page.evaluate(() => {
    const T = todayStr(), D = n => addDays(T, n);
    const setup = () => { S = defaultState(); S.settings.onboarded = true;
      S.tasks = [{ id: 'a', title: 'A low today', priority: 'Low', dueDate: T, done: false }, { id: 'b', title: 'B low overdue', priority: 'Low', dueDate: D(-2), done: false },
        { id: 'c', title: 'C urgent today', priority: 'Urgent', dueDate: T, done: false }, { id: 'd', title: 'D done urgent', priority: 'Urgent', dueDate: T, done: true },
        { id: 'e', title: 'E future', priority: 'Urgent', dueDate: D(3), done: false }, { id: 'f', title: 'F medium no date', priority: 'Medium', dueDate: '', done: false },
        { id: 'g', title: 'Alfa', priority: 'Medium', dueDate: '', done: false }].map(t => ({ category: '', createdAt: 1, ...t }));
      S.goals = [{ id: 'g1', title: 'Goal today', status: 'Active', targetDate: T, mode: 'manual', manualProgress: 10, createdAt: Date.now() },
        { id: 'g2', title: 'Goal idle', status: 'Active', targetDate: '', mode: 'manual', manualProgress: 10, createdAt: Date.now() - 30 * 86400000 },
        { id: 'g3', title: 'Goal fresh', status: 'Active', targetDate: '', mode: 'manual', manualProgress: 10, createdAt: Date.now() },
        { id: 'g4', title: 'Goal completed', status: 'Completed', targetDate: T, mode: 'manual', manualProgress: 100, createdAt: 1 }];
      S.habits = [{ id: 'h1', name: 'Habit timed', type: 'good', frequency: 'daily', target: 1, reminder: '11:30', completions: [], active: true, createdAt: 1 },
        { id: 'h2', name: 'Habit plain', type: 'good', frequency: 'daily', target: 1, completions: [], active: true, createdAt: 1 },
        { id: 'h3', name: 'Habit done', type: 'good', frequency: 'daily', target: 1, completions: [T], active: true, createdAt: 1 },
        { id: 'h4', name: 'Habit bad', type: 'bad', frequency: 'daily', target: 1, completions: [], brokenDates: [], active: true, createdAt: 1 }];
      S.plannerBlocks = []; };
    const rank = () => ccRank(ccCandidates(ccContext())).filter(c => c.kind !== 'quest').map(c => `${c.kind}:${c.id}:${c.score}`);
    setup(); const base = rank();
    const before = JSON.stringify(S); rank(); const pure = JSON.stringify(S) === before;
    S.tasks.reverse(); S.goals.reverse(); S.habits.reverse(); const reversed = rank();
    const blk = (id, s, e, extra) => ({ id, date: T, startTime: s, endTime: e, title: id, category: '', taskId: '', goalId: '', completed: false, ...extra });
    setup(); S.plannerBlocks = [blk('now', '11:30', '12:30'), blk('soon', '12:20', '13:00'), blk('twoh', '13:30', '14:00'), blk('late', '18:00', '19:00'), blk('donep', '11:00', '13:00', { completed: true }), blk('past', '08:00', '09:00')];
    const blocks = ccRank(ccCandidates(ccContext())).filter(c => c.kind === 'planner').map(c => `${c.id}:${c.score}`);
    const nowMode = ccNow().mode, top = ccRank(ccCandidates(ccContext()))[0].id;
    // a later block linked to an overdue urgent task carries that task's weight; the task is not listed twice
    setup(); S.plannerBlocks = [blk('lk', '18:00', '19:00', { taskId: 'c' })];
    const linked = ccRank(ccCandidates(ccContext())).filter(c => c.kind !== 'quest').map(c => `${c.kind}:${c.id}:${c.score}`);
    return { base, pure, reversed, blocks, nowMode, top, linked, again: (setup(), rank()) };
  });
  assert.deepEqual(r.base, ['task:c:600', 'task:b:350', 'goal:g1:350', 'task:a:300', 'habit:h1:300', 'task:g:200', 'task:f:200', 'habit:h2:150', 'goal:g2:100'],
    'Urgent today 400+200; overdue Low 100+250 beats Low today 100+200; goal due today 350; habit at its usual time 150+150; equal scores: task > goal > habit, then title; done/future/completed/bad/fresh goal absent');
  assert.ok(r.pure, 'scoring never changes the state');
  assert.deepEqual(r.reversed, r.base, 'order of the stored lists does not matter');
  assert.deepEqual(r.again, r.base, 'same state + same clock = same result');
  assert.deepEqual(r.blocks, ['now:1000', 'soon:800', 'twoh:600', 'late:200'], 'running 1000, within 30 min 800, within 2 h 600, later 200; completed and past blocks never win');
  assert.deepEqual([r.nowMode, r.top], ['now', 'now']);
  assert.deepEqual(r.linked.slice(0, 2), ['planner:lk:600', 'task:b:350'], 'the linked block takes the task score (600) and the task itself is not listed');
  assert.ok(!r.linked.some(x => x.startsWith('task:c:')));
}, { state: fixtureState() });

test('CC4 Daily Score is exactly the existing one: same numbers and the same card in the Command Center and the classic Home; progress is only a visual summary', async ({ page }) => {
  const r = await page.evaluate(() => {
    const T = todayStr(), ds = () => JSON.stringify(dailyScore(T));
    const a = ds(); view = 'home'; render(); const smartCard = document.querySelector('#ccDay [data-ds="card"]').outerHTML; const b = ds();
    S.settings.widgets.smart = false; render(); const classicCard = document.querySelector('[data-ds="card"]').outerHTML; const c = ds();
    S.settings.widgets.smart = true; render();
    return { same: a === b && b === c, cards: smartCard === classicCard, score: dailyScore(T).score, shown: document.querySelector('#ccDay .ring span').textContent.trim(), prog: ccProgress(ccContext()) };
  });
  assert.ok(r.same, 'dailyScore() identical before/after both Homes');
  assert.ok(r.cards, 'the Daily Score card is the same markup in both Homes');
  assert.equal(r.shown, String(r.score));
  assert.deepEqual([r.prog.done, r.prog.total], [6, 12], 'progress: plain counts of today (tasks, habits, plan, food, sleep, workout)');
}, { state: fixtureState() });

test('CC5 habits, tasks and blocks are completed only through the existing handlers: same XP keys and amounts, counters, no double pay, no XP for blocks', async ({ page }) => {
  await ccHome(page);
  const T = TODAY;
  // counter habit: 7 of 8 -> the 8th tap pays once under habit:<id>:<date>, then taps are no-ops
  await page.evaluate(() => { const w = S.habits.find(h => h.id === 'h_water'), T = todayStr(); w.completions = w.completions.filter(d => d !== T); for (let i = 0; i < 7; i++) w.completions.push(T); render(); });
  let xp = await xpOf(page);
  const water = page.locator('#ccHabits .habit-item', { hasText: 'Drink water' });
  await water.locator('.check').click();
  const r1 = await page.evaluate(T => ({ n: S.habits.find(h => h.id === 'h_water').completions.filter(d => d === T).length, keys: S.xpLog.filter(x => x.key === `habit:h_water:${T}`).length, xp: habitXp(S.habits.find(h => h.id === 'h_water')) }), T);
  assert.deepEqual([r1.n, r1.keys], [8, 1]); assert.equal(await xpOf(page), xp + r1.xp, 'habit XP from habitXp(), once');
  xp = await xpOf(page);
  await page.locator('#ccHabits .habit-item', { hasText: 'Drink water' }).locator('.check').click();
  assert.equal(await xpOf(page), xp, 'an extra tap at the target pays nothing');
  // Read (already done today): untick keeps XP, tick again pays nothing (existing idempotent key)
  xp = await xpOf(page);
  await page.locator('#ccHabits .habit-item', { hasText: 'Read' }).locator('.check').click();
  await page.locator('#ccHabits .habit-item', { hasText: 'Read' }).locator('.check').click();
  assert.equal(await xpOf(page), xp);
  // Top 3 task check = the task row's check: taskGrantCompletion under task:<id>:<date>
  xp = await xpOf(page);
  await page.locator('#ccTop .cc-top-row', { hasText: 'Buy groceries' }).locator('.check').click();
  const r2 = await page.evaluate(T => ({ done: S.tasks.find(t => t.id === 't_med').done, keys: S.xpLog.filter(x => x.key === `task:t_med:${T}`).length, xp: taskXp(S.tasks.find(t => t.id === 't_med')) }), T);
  assert.deepEqual([r2.done, r2.keys], [true, 1]); assert.equal(await xpOf(page), xp + r2.xp);
  // Co teď "Hotovo" on a block: plannerToggleCompleted (no XP)
  xp = await xpOf(page);
  await page.click('#ccNow [data-cc-act="done"]');
  assert.equal(await page.evaluate(() => S.plannerBlocks.find(b => b.id === 'pb_math').completed), true);
  assert.equal(await xpOf(page), xp, 'completing a block pays no XP (as in the Planner)');
  await settle(page);
  assert.equal((await idbState(page)).plannerBlocks.find(b => b.id === 'pb_math').completed, true, 'saved');
}, { state: fixtureState() });

test('CC6 goals on Home: percent, this week, the next real step or "Další krok není naplánován."; never creates a task', async ({ page }) => {
  await page.evaluate(() => { S.goals.push({ id: 'g_new', title: 'Nový projekt', description: '', targetDate: '', status: 'Active', mode: 'manual', manualProgress: 40, createdAt: Date.now(), category: '' }); });
  const before = await ccData(page);
  await ccHome(page);
  const fit = await page.locator('#ccGoals .cc-goal[data-goal="g_fit"]').innerText();
  assert.match(fit, /Tento týden: 2\/3 tréninky/); assert.match(fit, /Úkol: Write report · Dnes/, 'the Goal system\'s next step: the nearest open linked task first');
  assert.match(await page.locator('#ccGoals .cc-goal[data-goal="g_new"]').innerText(), /40\s*%[\s\S]*Další krok není naplánován\./);
  assert.equal(await ccData(page), before, 'rendering goals creates nothing');
  await page.evaluate(() => { S.milestones.push({ id: 'ms_cc', goalId: 'g_new', title: 'První krok', completed: false, createdAt: Date.now() }); }); await ccHome(page);
  assert.match(await page.locator('#ccGoals .cc-goal[data-goal="g_new"]').innerText(), /Milník: První krok/);
  const r = await page.evaluate(() => ccGoalNextSteps(S.goals.find(g => g.id === 'g_fit'), ccContext()));
  assert.equal(r.pct, await page.evaluate(() => goalProgress(S.goals.find(g => g.id === 'g_fit'))), 'the one goalProgress()');
}, { state: fixtureState() });

test('CC7 persistence: old states get the Smart Home keys (no schema change), saved choices are kept, Settings toggles persist, Home never writes data', async ({ page }) => {
  const r = await page.evaluate(() => {
    const old = JSON.parse(JSON.stringify(S)); delete old.settings.widgets;
    const a = migrate(JSON.parse(JSON.stringify(old)));
    const partial = JSON.parse(JSON.stringify(old)); partial.settings.widgets = { tasks: false, top3: false }; const b = migrate(partial);
    return { schema: a.schemaVersion, keys: ['smart', 'command', 'top3'].map(k => a.settings.widgets[k]), kept: [b.settings.widgets.tasks, b.settings.widgets.top3, b.settings.widgets.smart],
      idem: JSON.stringify(migrate(JSON.parse(JSON.stringify(a)))) === JSON.stringify(a), order: a.settings.widgetOrder.includes('smart') };
  });
  assert.deepEqual(r, { schema: 8, keys: [true, true, true], kept: [false, false, true], idem: true, order: false });
  const before = await ccData(page);
  await ccHome(page); await ccHome(page); await page.evaluate(() => uiMinuteTick()); await settle(page);
  assert.equal(await ccData(page), before, 'rendering Home and the minute tick change no data');
  // Settings -> Chytrý Home
  await page.click('#settingsBtn');
  assert.match(await page.locator('#st_smart').innerText(), /Chytrý Home[\s\S]*Co teď\?[\s\S]*Dnešek[\s\S]*Dnes nejdůležitější[\s\S]*Projekty[\s\S]*Rutiny[\s\S]*Finance[\s\S]*Fitness[\s\S]*Spánek/);
  await page.click('#st_smart [data-smart="command"]'); await page.click('#st_smart [data-smart="top3"]');
  await ccHome(page);
  assert.deepEqual([await page.locator('#ccNow').count(), await page.locator('#ccTop').count(), await page.locator('#ccTimeline').count()], [0, 0, 1]);
  await page.click('#settingsBtn'); await page.click('#st_smart [data-smart="smart"]'); await settle(page);
  assert.equal((await idbState(page)).settings.widgets.smart, false);
  await reload(page); await ccHome(page);
  assert.deepEqual([await page.locator('.cc-home').count(), await page.locator('.home .hud-wrap').count()], [0, 1], 'off -> the classic Home, after a reload too');
  assert.equal(await page.locator('#st_smart [data-smart="command"][disabled]').count(), 0, 'not in Settings view now');
}, { state: fixtureState() });

test('CC8 performance: Command Center at 1 500 tasks / 25 000 XP entries (a year) with habits, goals and planner blocks', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3));
    const T = todayStr();
    for (let i = 0; i < 40; i++) S.habits.push({ id: 'ph' + i, name: 'Rutina ' + i, type: i % 9 ? 'good' : 'bad', frequency: 'daily', target: 1, completions: Array.from({ length: 200 }, (_, k) => addDays(T, -k * (1 + i % 2))), brokenDates: [], active: true, createdAt: 1 });
    for (let i = 0; i < 25; i++) S.goals.push({ id: 'pg' + i, title: 'Projekt ' + i, status: i % 5 ? 'Active' : 'Completed', targetDate: addDays(T, i - 5), mode: 'auto', createdAt: 1 });
    S.tasks.forEach((t, i) => { if (i % 7 === 0) t.goalId = 'pg' + (i % 25); });
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, (i % 60) - 30), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':00', title: 'Blok ' + i, category: '', taskId: i % 3 ? '' : 'rt' + i, goalId: i % 4 ? '' : 'pg' + (i % 25), completed: i % 2 === 0 });
    const m = (f, n = 5) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    return { home: m(() => { view = 'home'; render(); }), engine: m(() => ccRank(ccCandidates(ccContext()))), tick: m(() => uiMinuteTick()), bad: /undefined|NaN/.test(document.getElementById('app').innerText) };
  });
  console.log(`      CC8 1500/25000: Home render ${r.home.toFixed(1)} ms (median), engine ${r.engine.toFixed(1)} ms, minute tick ${r.tick.toFixed(1)} ms`);
  assert.ok(!r.bad);
  assert.ok(r.home < 60 && r.engine < 15 && r.tick < 20, 'fast (target Home < 30 ms; CI margin)');
}, { state: fixtureState() });

test('CC9 layout 320-1440 px, dark + light: no overflow, no duplicate ids, no undefined/NaN, every Command Center control is at least 44 px', async ({ page }) => {
  const bad = [];
  for (const theme of ['dark', 'light']) for (const w of [320, 360, 390, 430, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(t => { S.settings.theme = t; applyTheme(); }, theme); await ccHome(page);
    const b = await ccBad(page); if (b.bad || b.dup.length || b.overflow > 0) bad.push(`${theme}/${w}: ${JSON.stringify(b)}`);
    const small = await page.$$eval('.cc-q, .cc-act .btn, .cc-why summary, .cc-tl-row, .cc-chip, .cc-top-main, .cc-attn-row, .cc-tile, .cc-goal, .cc-now-main, #ccTimeline [data-cc-planner]', ns => ns.filter(n => n.offsetParent).map(n => n.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).map(r => `${Math.round(r.width)}x${Math.round(r.height)}`));
    const clipped = await page.$$eval('.cc-home .cc-now-t, .cc-home .cc-top-t, .cc-home .cc-tl-title, .cc-home .cc-tile-v', ns => ns.filter(n => n.scrollWidth > n.clientWidth + 1).length);
    if (small.length) bad.push(`${theme}/${w} small targets: ${small.join(',')}`);
    if (clipped) bad.push(`${theme}/${w}: ${clipped} clipped texts`);
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('CC10 minute tick: Co teď? and Dnešek update in place (no full render), "Proč teď?" stays open, the clock moves', async ({ page }) => {
  await page.clock.setFixedTime(at('14:44')); await ccHome(page);
  await page.click('#ccNow .cc-why summary');
  await page.evaluate(() => { document.querySelector('.cc-home').dataset.sentinel = '1'; window.scrollTo(0, 300); });
  assert.equal((await ccNowOf(page)).mode, 'next');
  await page.clock.setFixedTime(at('15:01')); await page.evaluate(() => uiMinuteTick());
  const r = await page.evaluate(() => ({ sentinel: document.querySelector('.cc-home').dataset.sentinel, mode: document.querySelector('#ccNow').dataset.ccMode, open: document.querySelector('#ccNow .cc-why').open,
    clock: document.querySelector('.cc-clock').textContent, now: [...document.querySelectorAll('#ccTimeline .cc-tl-row.is-now .cc-tl-title')].map(n => n.textContent), y: window.scrollY }));
  assert.deepEqual(r, { sentinel: '1', mode: 'now', open: true, clock: '15:01', now: ['Matematika'], y: 300 });
  assert.match(await page.locator('#ccNow .cc-why').innerText(), /Probíhá teď \(do 16:00\)/);
  assert.equal(await page.evaluate(() => document.activeElement.matches('#ccNow .cc-why summary')), true, 'focus stays on "Proč teď?"');
}, { state: fixtureState() });

test('CC11 accessibility: named regions and controls, progress values, keyboard "Proč teď?", reduced motion stops the animations', async ({ page }) => {
  await ccHome(page);
  const r = await page.evaluate(() => {
    const h = document.querySelector('.cc-home');
    const unnamed = [...h.querySelectorAll('button, summary, [role="button"]')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).map(n => n.className);
    const bars = [...h.querySelectorAll('[role="progressbar"]')].filter(n => { const v = +n.getAttribute('aria-valuenow'); return !(v >= 0 && v <= 100) || !n.getAttribute('aria-label'); }).length;
    const lab = document.getElementById(document.querySelector('#ccNow').getAttribute('aria-labelledby'));
    return { unnamed, bars, label: lab && lab.textContent.trim(), anim: getComputedStyle(document.querySelector('#ccNow')).animationDuration, pulse: getComputedStyle(document.querySelector('.cc-tl-mark')).animationDuration };
  });
  assert.deepEqual(r.unnamed, []); assert.equal(r.bars, 0); assert.match(r.label, /Co teď\?/);
  assert.ok(parseFloat(r.anim) < 0.01, 'reduced motion: ' + r.anim);
  await page.focus('#ccNow .cc-why summary'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.querySelector('#ccNow .cc-why').open), true);
  assert.ok(await page.locator('#ccTimeline .cc-tl-row').first().getAttribute('aria-label').then(s => /08:00–09:00 Škola, hotovo/.test(s)), 'timeline rows say time, title and state');
}, { state: fixtureState() });

test('CC12 quick actions open the existing forms; attention follows the notification switches (max 3); no data = "Žádná data", never a fake zero', async ({ page }) => {
  const before = await ccData(page);
  for (const [q, sel] of [['task', '#f_title'], ['habit', '#h_name'], ['food', '#m_name'], ['workout', '#w_name']]) {
    await ccHome(page); await page.click(`.cc-q[data-q="${q}"]`); assert.ok(await page.locator(`.sheet ${sel}`).isVisible(), q);
    await page.evaluate(() => closeSheets());
  }
  assert.equal(await ccData(page), before, 'opening forms creates nothing');
  await page.evaluate(() => { const T = todayStr(); for (let i = 0; i < 5; i++) S.tasks.push({ id: 'od' + i, title: 'Staré ' + i, priority: 'Low', dueDate: addDays(T, -3), done: false, category: '', createdAt: 1 });
    S.subscriptions.push({ id: 'sub_cc', name: 'Netflix', amount: 199, period: 'monthly', nextPayment: T, active: true, createdAt: 1 }); });
  await ccHome(page);
  let attn = await page.$$eval('#ccAttn .cc-attn-row', ns => ns.map(n => n.innerText));
  assert.equal(attn.length, 3); assert.match(attn[0], /5 úkolů po termínu/);
  await page.evaluate(() => { S.settings.notifications = Object.assign({}, S.settings.notifications, { task: false, event: false }); }); await ccHome(page);
  attn = await page.$$eval('#ccAttn .cc-attn-row', ns => ns.map(n => n.innerText));
  assert.ok(!attn.some(t => /po termínu|Team meeting/.test(t)), 'switched-off kinds are not shown');
  // Reality QA: no Car attention any more (Car is out of the UI); the subscription row opens it in Finance
  assert.equal(await page.locator('#ccAttn .cc-attn-row[data-attn="car"]').count(), 0);
  await page.click('#ccAttn .cc-attn-row[data-attn="sub"]'); assert.equal(await page.evaluate(() => [view, finView].join()), 'finance,subs');
  assert.ok(await page.locator('.sheet #su_name').isVisible(), 'the subscription opens for editing');
  await page.evaluate(() => closeSheets());
  // a user with only a task: status tiles say "Žádná data"
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; S.tasks.push({ id: 'x1', title: 'Jediný úkol', priority: 'Medium', dueDate: todayStr(), done: false, category: '', createdAt: 1 }); });
  await ccHome(page);
  const tiles = await page.$$eval('#ccMini .cc-tile', ns => ns.map(n => [n.dataset.mini, n.querySelector('.cc-tile-v').textContent]));
  assert.deepEqual(tiles, [['finance', 'Žádná data'], ['fitness', 'Žádná data'], ['health', 'Žádná data'], ['nutrition', 'Žádná data']]);
  assert.equal((await ccNowOf(page)).title, 'Jediný úkol');
  assert.match(await page.locator('#ccTimeline').innerText(), /Na dnešek nemáš nic naplánováno/);
  assert.match(await page.locator('#ccGoals').innerText(), /Zatím žádný aktivní projekt/);
  assert.equal(await page.locator('#ccAttn').count(), 0);
  assert.deepEqual(await ccBad(page), { bad: false, dup: [], overflow: 0 });
}, { state: fixtureState() });

// ---------- Pre-merge finishing pass: full minute tick, regression, data safety ----------
const ccSections = page => page.evaluate(() => Object.fromEntries(['#ccNow', '#ccAttn', '#ccTimeline', '#ccTop', '#ccDay', '#ccGoals', '#ccHabits', '#ccQuests', '#ccMini'].map(k => {
  const n = document.querySelector('.cc-home > ' + k); if (!n) return [k, null];
  const c = n.cloneNode(true); c.querySelectorAll('details').forEach(d => d.removeAttribute('open')); return [k, c.outerHTML]; })));
const ccTickTo = (page, hm) => page.clock.setFixedTime(at(hm)).then(() => page.evaluate(() => uiMinuteTick()));

test('FP2 minute tick 14:59 -> 15:00: Co teď?, Dnešek and Top 3 follow the clock in place; focus, open "Proč teď?", scroll kept; result = a fresh render; nothing written', async ({ page }) => {
  await page.clock.setFixedTime(at('14:59')); await ccHome(page);
  const before = await ccData(page), xp0 = await xpOf(page);
  let n = await ccNowOf(page); assert.deepEqual([n.mode, n.title], ['next', 'Matematika']);
  assert.match(await page.locator('#ccNow .cc-why').textContent(), /Začíná za 1 min/);
  assert.deepEqual(await page.$$eval('#ccTop .cc-top-t', ns => ns.map(n => n.textContent)), ['Konzultace', 'Buy groceries', 'Drink water']);
  assert.deepEqual(await page.$$eval('#ccTimeline .cc-tl-row', ns => ns.map(n => n.className.match(/is-(\w+)/)[1])), ['done', 'now', 'next', 'later', 'later']);
  await page.click('#ccNow .cc-why summary');
  await page.evaluate(() => { document.querySelector('.cc-home').dataset.sentinel = '1'; });
  await page.focus('#ccTop [data-ck="top:task:t_med"] .cc-top-main');
  const y0 = await page.evaluate(() => window.scrollY);
  await ccTickTo(page, '15:00');
  n = await ccNowOf(page); assert.deepEqual([n.mode, n.title, n.reasons[0]], ['now', 'Matematika', 'running']);
  const r = await page.evaluate(() => ({ sentinel: document.querySelector('.cc-home').dataset.sentinel, dom: document.querySelector('#ccNow').dataset.ccMode, open: document.querySelector('#ccNow .cc-why').open,
    focus: document.activeElement.closest('[data-ck]') && document.activeElement.closest('[data-ck]').dataset.ck, focusCls: document.activeElement.className, y: window.scrollY, clock: document.querySelector('.cc-clock').textContent }));
  assert.deepEqual(r, { sentinel: '1', dom: 'now', open: true, focus: 'top:task:t_med', focusCls: 'cc-top-main', y: y0, clock: '15:00' }, 'no full render; focus stays on the same item; "Proč teď?" stays open');
  assert.match(await page.locator('#ccNow .cc-why').textContent(), /Probíhá teď \(do 16:00\)/);
  assert.deepEqual(await page.$$eval('#ccTop .cc-top-t', ns => ns.map(n => n.textContent)), ['Konzultace', 'PUSH A', 'Buy groceries'], 'PUSH A enters Top 3 at 2 h before its start');
  assert.match(await page.locator('#ccTop [data-ck="top:planner:pb_push"]').innerText(), /Začíná za 120 min/);
  assert.deepEqual(await page.$$eval('#ccTimeline .cc-tl-row', ns => ns.map(n => n.className.match(/is-(\w+)/)[1])), ['done', 'past', 'now', 'next', 'later'], 'Team meeting over, Matematika running, Konzultace next');
  // the ticked page is exactly what a full render at 15:00 shows
  const ticked = await ccSections(page); await ccHome(page); assert.deepEqual(await ccSections(page), ticked, 'tick result = fresh render');
  // a tick in the same minute changes no element
  await page.evaluate(() => { window.__top = document.querySelector('#ccTop'); window.__day = document.querySelector('#ccDay'); uiMinuteTick(); });
  assert.deepEqual(await page.evaluate(() => [window.__top === document.querySelector('#ccTop'), window.__day === document.querySelector('#ccDay')]), [true, true], 'unchanged sections are not replaced');
  await settle(page);
  assert.equal(await ccData(page), before, 'ticks write no data'); assert.equal(await xpOf(page), xp0, 'ticks pay no XP');
}, { state: fixtureState() });

test('FP3 minute tick 15:59 -> 16:00: progress context ("Ještě můžeš"), goal next step and missed blocks update under an open form without touching the typed text', async ({ page }) => {
  await page.clock.setFixedTime(at('15:59')); await ccHome(page);
  assert.match(await page.locator('#ccDay .cc-miss').innerText(), /3 bloky v plánu/);
  assert.match(await page.locator('#ccGoals [data-goal="g_fit"]').innerText(), /Úkol: Write report · Dnes/);
  const before = await ccData(page);
  await page.click('.cc-q[data-q="task"]'); await page.fill('.sheet #f_title', 'Rozepsaný úkol'); await page.focus('.sheet #f_title');
  await page.evaluate(() => { const i = document.querySelector('.sheet #f_title'); i.setSelectionRange(3, 3); });
  await ccTickTo(page, '16:00');
  assert.deepEqual(await page.evaluate(() => { const i = document.querySelector('.sheet #f_title'); return [!!i, i && i.value, document.activeElement === i, i && i.selectionStart]; }), [true, 'Rozepsaný úkol', true, 3], 'form, text, focus and caret survive');
  assert.match(await page.locator('#ccDay .cc-miss').innerText(), /2 bloky v plánu/, 'Matematika ended: the day context follows');
  assert.match(await page.locator('#ccGoals [data-goal="g_fit"]').innerText(), /Úkol: Write report · Dnes/, 'goal next step (task first) is unchanged by the tick; missed blocks are covered in GP3');
  assert.equal(await page.locator('#ccTimeline [data-ck="tl:block:pb_math"].is-missed').count(), 1);
  const n = await ccNowOf(page); assert.deepEqual([n.mode, n.title], ['now', 'Konzultace']);
  await page.evaluate(() => closeSheets()); await settle(page);
  assert.equal(await ccData(page), before, 'nothing saved from the open form or the tick');
  // widgets switched off stay off through the tick
  await page.evaluate(() => { S.settings.widgets.top3 = false; S.settings.widgets.goals = false; render(); });
  await ccTickTo(page, '16:30');
  assert.deepEqual([await page.locator('#ccTop').count(), await page.locator('#ccGoals').count()], [0, 0]);
}, { state: fixtureState() });

test('FP4 regression: nothing is created or paid by the Command Center itself; handlers stay the source of truth; no double reward; engine deterministic over renders and ticks', async ({ page }) => {
  await ccHome(page);
  const d0 = await ccData(page), xp0 = await xpOf(page);
  for (let i = 0; i < 10; i++) await page.evaluate(i => { view = 'home'; render(); uiMinuteTick(); }, i);
  const rk = await page.evaluate(() => { const a = []; for (let i = 0; i < 5; i++) a.push(JSON.stringify(ccRank(ccCandidates(ccContext())).map(c => [c.kind, c.id, c.score, c.reasons]))); return new Set(a).size; });
  assert.equal(rk, 1, 'same ranking every time');
  await settle(page); assert.equal(await ccData(page), d0, '10 renders + ticks: no records, no XP'); assert.equal(await xpOf(page), xp0);
  // a double click on a Top 3 check pays once (the task handler's idempotent key)
  await page.locator('#ccTop [data-ck="top:task:t_med"] .check').dblclick();
  const r = await page.evaluate(T => ({ keys: S.xpLog.filter(x => x.key === `task:t_med:${T}`).length, xp: S.totalXp }), TODAY);
  assert.equal(r.keys, 1);
  const xp1 = r.xp;
  // reopening and completing again the same day pays nothing (existing task rule), from the Tasks screen or from Home
  await page.evaluate(() => { const t = S.tasks.find(t => t.id === 't_med'); t.done = false; render(); });
  await ccHome(page);
  const row = page.locator('#ccTop [data-ck="top:task:t_med"] .check'); if (await row.count()) await row.click(); else await page.evaluate(() => uiCcComplete({ kind: 'task', obj: S.tasks.find(t => t.id === 't_med') }));
  assert.equal(await xpOf(page), xp1, 'no second reward for the same task on the same day');
  // habit "Hotovo" from Co teď? = the existing habit handler; a second tap only unticks (no XP taken or paid twice)
  await page.evaluate(() => { S.plannerBlocks = S.plannerBlocks.filter(b => b.date !== todayStr()); S.tasks.forEach(t => { t.done = true; }); const h = S.habits.find(h => h.id === 'h_read'); h.completions = h.completions.filter(d => d !== todayStr()); h.reminder = '11:00';
    const w = S.habits.find(h => h.id === 'h_water'); while (w.completions.filter(d => d === todayStr()).length < 8) w.completions.push(todayStr()); render(); });
  await ccHome(page);
  const n = await ccNowOf(page);
  if (n.title === 'Read') {
    const xp2 = await xpOf(page), hasKey = await page.evaluate(T => S.xpLog.some(x => x.key === `habit:h_read:${T}`), TODAY);
    await page.click('#ccNow [data-cc-act="done"]');
    assert.equal(await page.evaluate(T => S.habits.find(h => h.id === 'h_read').completions.includes(T), TODAY), true);
    assert.equal(await page.evaluate(T => S.xpLog.filter(x => x.key === `habit:h_read:${T}`).length, TODAY), 1, 'one XP entry for the day');
    if (hasKey) assert.equal(await xpOf(page), xp2, 'already paid today -> nothing more');
  } else assert.fail('expected the timed habit in Co teď?, got ' + JSON.stringify(n));
  // the classic Home still works as the fallback, with the same data
  await page.evaluate(() => { S.settings.widgets.smart = false; view = 'home'; render(); });
  assert.deepEqual([await page.locator('.cc-home').count(), await page.locator('#hTasks').count(), await page.locator('.hud-wrap [data-ds="card"]').count()], [0, 1, 1]);
}, { state: fixtureState() });

test('FP5 data safety: existing IndexedDB data, schemaVersion 8, export/import, reset, an older state without the new widget keys, Smart Home ON/OFF', async ({ page }) => {
  const fx = fixtureState();
  const same = (a, b, msg) => { for (const k of ['tasks', 'habits', 'goals', 'milestones', 'plannerBlocks', 'workouts', 'meals', 'expenses', 'income', 'events', 'sleepLog', 'journal', 'subscriptions', 'vehicles']) assert.deepEqual(a[k], b[k], `${msg}: ${k}`); };
  // existing data (loaded from IndexedDB by openApp) boots into the Command Center unchanged; the first save stores the filled-in keys
  await persist(page);
  let idb = await idbState(page);
  assert.equal(idb.schemaVersion, 8); same(idb, fx, 'boot');
  assert.deepEqual(['smart', 'command', 'top3'].map(k => (idb.settings.widgets || {})[k]), [true, true, true], 'defaults filled by the existing migrate()');
  await ccHome(page); assert.equal(await page.locator('.cc-home').count(), 1);
  // an older state whose widgets map predates the Command Center (own choices kept, schema unchanged)
  await page.evaluate(async st => { st.settings.widgets = { tasks: false, finance: false }; st.settings.widgetOrder = ['tasks', 'progress', 'habits']; S = st; await rawIdbPut(st); }, JSON.parse(JSON.stringify(idb)));
  await reload(page); await persist(page);
  idb = await idbState(page);
  assert.deepEqual([idb.settings.widgets.tasks, idb.settings.widgets.finance, idb.settings.widgets.smart, idb.settings.widgets.command, idb.settings.widgets.top3, idb.schemaVersion], [false, false, true, true, true, 8]);
  same(idb, fx, 'older state');
  await ccHome(page); assert.equal(await page.locator('#ccMini [data-mini="finance"]').count(), 0, 'its Finance switch is respected');
  // Smart Home OFF/ON through Settings changes only that one key
  const s0 = await stateOf(page);
  await page.click('#settingsBtn'); await page.click('#st_smart [data-smart="smart"]'); await settle(page);
  let s1 = await idbState(page); assert.equal(s1.settings.widgets.smart, false);
  s1.settings.widgets.smart = true; s1.settings = { ...s1.settings }; const strip = s => { const c = JSON.parse(JSON.stringify(s)); delete c.meta; return c; };
  assert.deepEqual(strip(s1), strip(s0), 'OFF changes nothing else');
  // export with Smart Home off -> reset -> import: everything back, including the switch
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.equal(exported.settings.widgets.smart, false); assert.equal(exported.schemaVersion, 8);
  await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); await settle(page);
  const afterReset = await stateOf(page);
  assert.deepEqual([afterReset.tasks.length, afterReset.settings.widgets.smart, afterReset.settings.widgets.command, afterReset.schemaVersion], [0, true, true, 8], 'reset = defaults, Smart Home on');
  await page.evaluate(() => closeSheets()); await page.click('#settingsBtn');
  await importFile(page, await dl.path()); await settle(page);
  const imported = await idbState(page);
  same(imported, exported, 'import'); assert.equal(imported.settings.widgets.smart, false, 'the switch comes back with the backup');
  assert.deepEqual(imported.xpLog, exported.xpLog, 'XP history identical'); assert.equal(imported.totalXp, exported.totalXp);
  await go(page, 'home'); assert.equal(await page.locator('.cc-home').count(), 0, 'classic Home after importing a backup with Smart Home off');
  // switching back ON restores the Command Center with the same data
  await page.click('#settingsBtn'); await page.click('#st_smart [data-smart="smart"]'); await settle(page);
  await go(page, 'home'); assert.equal(await page.locator('.cc-home').count(), 1);
  same(await idbState(page), exported, 'after ON');
}, { state: fixtureState() });

// ---------- Deep Analytics & Insights 2.0 ----------
// Statistics is the Analytics centre: a read-only layer over the existing calculators. The tests pin the ranges and the
// previous-period comparison, every domain against the app's own helpers, "Žádná data" instead of fake zeros, the
// deterministic observations, no writes, performance on a year of data, layout, themes, accessibility and data safety.
const anGo = (page, per) => page.evaluate(p => { closeSheets(); statsPeriod = p; view = 'statistics'; render(); }, per);
const anState = page => page.evaluate(() => JSON.stringify(S));
const anClean = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|Infinity|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
const anPeriods = ['today', 'week', 'month', 'quarter', 'year'];
// a controlled data set on the fixture day (2026-09-23): the current 7-day range is 09-17..09-23, the previous 09-10..09-16
const anSeed = page => page.evaluate(() => {
  const T = todayStr(), D = n => addDays(T, n), ts = (d, h) => new Date(d + 'T' + String(h || 12).padStart(2, '0') + ':00').getTime();
  S = defaultState(); S.settings.onboarded = true;
  S.tasks = [
    { id: 'a1', title: 'A1', priority: 'High', category: 'Work', dueDate: D(-1), done: true, createdAt: ts(D(-4)) },
    { id: 'a2', title: 'A2', priority: 'Low', category: 'Work', dueDate: D(-2), done: false, createdAt: ts(D(-3)) },
    { id: 'a3', title: 'A3', priority: 'Urgent', category: 'Health', dueDate: D(0), done: true, createdAt: ts(D(-2)) },
    { id: 'b1', title: 'B1', priority: 'Medium', category: 'Work', dueDate: D(-9), done: true, createdAt: ts(D(-12)) },
    { id: 'b2', title: 'B2', priority: 'Medium', category: '', dueDate: D(-10), done: false, createdAt: ts(D(-12)) }];
  S.xpLog = [
    { id: 'x1', amount: 30, reason: 'Task: A1', ts: ts(D(-1)), key: `task:a1:${D(-1)}`, attrs: { INT: 18 } },
    { id: 'x2', amount: 45, reason: 'Task: A3', ts: ts(D(0), 9), key: `task:a3:${D(0)}`, attrs: { VIT: 27 } },
    { id: 'x3', amount: 25, reason: 'Task: B1', ts: ts(D(-9)), key: `task:b1:${D(-9)}`, attrs: { INT: 15 } },
    { id: 'x4', amount: 80, reason: 'Workout: Push', ts: ts(D(-3)), key: `workout:w1:${D(-3)}`, attrs: { STR: 24, VIT: 14, DEX: 10 } },
    { id: 'x5', amount: 40, reason: 'Quest: Den', ts: ts(D(-2)) },
    { id: 'x6', amount: 10, reason: 'Meal logged', ts: ts(D(-9)), key: `meal:${D(-9)}:Lunch` },
    { id: 'x7', amount: 50, reason: 'Achievement', ts: ts(D(-20)) }];
  S.totalXp = S.xpLog.reduce((a, x) => a + x.amount, 0);
  S.attrs = { STR: 24, INT: 33, DEX: 10, VIT: 41, WIS: 0, FOC: 0, SOC: 0 };
  S.habits = [
    { id: 'hd', name: 'Denní', type: 'good', frequency: 'daily', target: 1, completions: [D(0), D(-1), D(-2), D(-8), D(-9)], active: true, startDate: D(-13), createdAt: ts(D(-13)) },
    { id: 'hn', name: 'Nový', type: 'good', frequency: 'daily', target: 1, completions: [D(0)], active: true, createdAt: ts(D(-1)) },
    { id: 'hw', name: 'Týdenní', type: 'good', frequency: 'weekly', target: 2, completions: [D(-1), D(-4)], active: true, startDate: D(-30), createdAt: ts(D(-30)) },
    { id: 'hb', name: 'Zlozvyk', type: 'bad', frequency: 'daily', target: 1, completions: [D(0), D(-1)], brokenDates: [], active: true, startDate: D(-30), createdAt: ts(D(-30)) }];
  S.goals = [
    { id: 'g1', title: 'Hotový', status: 'Completed', targetDate: D(-2), mode: 'manual', manualProgress: 100, category: 'Learning', createdAt: ts(D(-40)) },
    { id: 'g2', title: 'Spící', status: 'Active', targetDate: D(20), mode: 'manual', manualProgress: 30, category: 'Work', createdAt: ts(D(-40)) },
    { id: 'g3', title: 'Živý', status: 'Active', targetDate: '', mode: 'manual', manualProgress: 60, category: 'Fitness', createdAt: ts(D(-40)) }];
  S.xpLog.push({ id: 'x8', amount: 200, reason: 'Goal: Hotový', ts: ts(D(-2)), key: 'goal:g1:complete' }); S.totalXp += 200;
  S.tasks.push({ id: 'g3t', title: 'Krok', priority: 'Low', category: 'Fitness', goalId: 'g3', dueDate: '', done: true, createdAt: ts(D(-5)) });
  S.xpLog.push({ id: 'x9', amount: 15, reason: 'Task: Krok', ts: ts(D(-3)), key: `task:g3t:${D(-3)}` }); S.totalXp += 15;
  S.plannerBlocks = [
    { id: 'p1', date: D(-1), startTime: '08:00', endTime: '09:30', title: 'Učení', category: 'Learning', completed: true },
    { id: 'p2', date: D(-2), startTime: '10:00', endTime: '11:00', title: 'Práce', category: 'Work', completed: false },
    { id: 'p3', date: D(-9), startTime: '10:00', endTime: '10:30', title: 'Starší', category: 'Work', completed: true }].map(b => ({ description: '', taskId: '', goalId: '', workoutId: '', notes: '', workoutTemplateId: '', createdAt: 1, updatedAt: 1, ...b }));
  S.workouts = [{ id: 'w1', name: 'Push', date: D(-3), duration: 50, exercises: [{ id: 'e1', name: 'Bench', sets: 3, reps: 10, weight: 60 }] },
    { id: 'w2', name: 'Pull', date: D(-1), exercises: [{ id: 'e2', name: 'Row', sets: 3, reps: 10, weight: 50 }] },
    { id: 'w3', name: 'Push', date: D(-10), duration: 40, exercises: [{ id: 'e3', name: 'Bench', sets: 2, reps: 5, weight: 70 }] },
    { id: 'w4', name: 'Běží', date: D(0), status: 'active', entries: [] }];
  S.meals = [{ id: 'm1', name: 'Oběd', date: D(-1), type: 'Lunch', calories: 600, servings: 1 }, { id: 'm2', name: 'Večeře', date: D(-1), type: 'Dinner', calories: 400, servings: 2 },
    { id: 'm3', name: 'Snídaně', date: D(-9), type: 'Breakfast', calories: 500, protein: 30, servings: 1 }];
  S.sleepLog = [{ id: 's1', date: D(-1), bedtime: '23:00', wake: '07:00', quality: 4 }, { id: 's2', date: D(-2), bedtime: '00:30', wake: '06:00', quality: 2 }, { id: 's3', date: D(-9), bedtime: '22:00', wake: '07:00' }];
  S.expenses = [{ id: 'e1', date: D(-1), amount: 300, category: 'Food', description: 'x' }, { id: 'e2', date: D(-9), amount: 1000, category: 'Housing', description: 'y' }];
  S.income = [{ id: 'i1', date: D(-2), amount: 5000, category: 'Salary', description: 'z' }];
  S.journal = [{ id: 'j1', date: D(-1), mood: '4', rating: '8', text: 'x', tags: [] }];
  S.dailyScores = { [D(-1)]: { score: 70, label: 'solid', algo: 1, areas: {}, finalizedAt: 1 }, [D(-3)]: { score: 50, label: 'weaker', algo: 1, areas: {}, finalizedAt: 1 }, [D(-9)]: { score: 90, label: 'excellent', algo: 1, areas: {}, finalizedAt: 1 } };
  S.dailyScoresSince = T; // nothing left for finalizeDailyScores() to snapshot: the Daily Score history is exactly the one above
  S.achievementsUnlocked = ACHV.map(a => a.id); // achievements and today's quests settled, so a render pays nothing into the seeded ledger
  S = migrate(JSON.parse(JSON.stringify(S))); // stored the way the app stores it (as after an import)
  ['daily', 'weekly'].forEach(p => questBoardFor(p).forEach(({ q }) => { const k = questKey(q.id, p); if (!S.quests.some(x => x.key === k)) S.quests.push({ key: k, questId: q.id, date: todayStr(), period: p }); }));
});
const anWeek = page => page.evaluate(() => { const a = anAnalyze(getAnalyticsRange('week')); return JSON.parse(JSON.stringify(a, (k, v) => v instanceof Map || v instanceof Set ? [...v] : k === 'byId' || k === 'dueList' || (k === 'blocks' && Array.isArray(v)) ? undefined : v)); });

test('AN1 empty state: no data -> "Zatím tu nic není", no metric shows a fake 0, nothing is written', async ({ page }) => {
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; view = 'home'; render(); });
  const before = await anState(page);
  await anGo(page, 'month');
  assert.equal(await page.locator('#anEmpty').count(), 1);
  assert.match(await page.locator('#anEmpty').innerText(), /Zatím tu nic není/);
  assert.equal(await page.locator('#anSummary').count(), 0);
  const m = await page.evaluate(() => { const a = anAnalyze(getAnalyticsRange('month')); return Object.fromEntries(['xp', 'tasks', 'habits', 'fitness', 'nutrition', 'sleep', 'finance', 'planner'].map(d => [d, Object.values(a[d].metrics).map(x => x.current)])); });
  for (const [d, xs] of Object.entries(m)) assert.ok(xs.every(v => v == null), `${d}: no data -> null, not 0 (${xs})`);
  assert.deepEqual(await page.evaluate(() => anObservations(anAnalyze(getAnalyticsRange('month')))), []);
  assert.equal(await anState(page), before);
});

test('AN2 date ranges: Dnes / 7 / 30 / 90 / Rok / Vlastní - inclusive days ending today, previous range adjacent and equally long', async ({ page }) => {
  const r = await page.evaluate(() => { const T = todayStr(); return { T, ranges: ['today', 'week', 'month', 'quarter', 'year'].map(k => { const a = getAnalyticsRange(k), p = getPreviousAnalyticsRange(a); return [k, a.from, a.to, a.days, p.from, p.to, p.days, addDays(p.to, 1) === a.from]; }),
    custom: getAnalyticsRange('custom', T, { from: addDays(T, 5), to: addDays(T, -9) }), bad: getAnalyticsRange('nonsense').key }; });
  assert.deepEqual(r.ranges, [['today', TODAY, TODAY, 1, '2026-09-22', '2026-09-22', 1, true], ['week', '2026-09-17', TODAY, 7, '2026-09-10', '2026-09-16', 7, true],
    ['month', '2026-08-25', TODAY, 30, '2026-07-26', '2026-08-24', 30, true], ['quarter', '2026-06-26', TODAY, 90, '2026-03-28', '2026-06-25', 90, true],
    ['year', '2025-09-24', TODAY, 365, '2024-09-24', '2025-09-23', 365, true]]);
  assert.deepEqual([r.custom.from, r.custom.to, r.custom.days], ['2026-09-14', TODAY, 10], 'custom: swapped ends put in order, never past today');
  assert.equal(r.bad, 'week', 'unknown key -> 7 days');
  await anGo(page, 'week');
  for (const k of ['today', 'week', 'month', 'quarter', 'year', 'custom']) {
    await page.click(`#spTabs [data-p="${k}"]`);
    assert.equal(await page.locator(`#spTabs [data-p="${k}"]`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.p), k, 'focus stays on the tab');
  }
  await page.fill('#anFrom', '2026-09-01');
  assert.deepEqual(await page.evaluate(() => { const e = document.querySelector('.an-range'); return [e.dataset.from, e.dataset.to, document.activeElement.id]; }), ['2026-09-01', TODAY, 'anFrom']);
  await page.fill('#anTo', '2026-09-10');
  assert.match(await page.locator('.an-range').innerText(), /01\.09\.2026 – 10\.09\.2026[\s\S]*22\.08\.2026 – 31\.08\.2026/);
}, { state: fixtureState() });

test('AN3 previous-period comparison: up / down / flat / unavailable, % change only for a non-zero previous value, no fake 0 before data existed', async ({ page }) => {
  const c = await page.evaluate(() => [comparePeriods(76, 71, 0), comparePeriods(2, 5, 0), comparePeriods(3, 3, 0), comparePeriods(4, null), comparePeriods(null, 4), comparePeriods(4, 0, 0), comparePeriods(7.26, 7.24, 1)]);
  assert.deepEqual(c, [{ current: 76, previous: 71, delta: 5, percentDelta: 7, direction: 'up' }, { current: 2, previous: 5, delta: -3, percentDelta: -60, direction: 'down' },
    { current: 3, previous: 3, delta: 0, percentDelta: 0, direction: 'flat' }, { current: 4, previous: null, delta: null, percentDelta: null, direction: 'unavailable' },
    { current: null, previous: 4, delta: null, percentDelta: null, direction: 'unavailable' }, { current: 4, previous: 0, delta: 4, percentDelta: null, direction: 'up' },
    { current: 7.3, previous: 7.2, delta: 0.1, percentDelta: 1, direction: 'up' }]);
  await anSeed(page);
  // tasks existed in both weeks; the habit "Nový" did not exist in the previous week and is not counted there
  const a = await anWeek(page);
  assert.deepEqual([a.tasks.metrics.done.current, a.tasks.metrics.done.previous, a.tasks.metrics.done.direction], [3, 1, 'up']);
  const prevOnly = await page.evaluate(() => { const r = getAnalyticsRange('week'), p = getPreviousAnalyticsRange(r); return anHabitsIn(p).per.map(x => x.h.id); });
  assert.deepEqual(prevOnly, ['hd', 'hw'], 'a habit created later is not "missed" in the previous period');
  // a domain that only starts in the current period: previous = no data (not 0)
  await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(s => s.date >= addDays(todayStr(), -6)); });
  const s = await page.evaluate(() => getSleepTrend(getAnalyticsRange('week')).metrics.nights);
  assert.deepEqual([s.current, s.previous, s.direction], [2, null, 'unavailable']);
  await anGo(page, 'week');
  assert.match(await page.locator('#anSleep').innerText(), /předchozí období: žádná data/);
}, { state: fixtureState() });

test('AN4 Daily Score: stored snapshots for past days + the live score today (the existing dailyScore), average/min/max, empty days stay empty, a point opens the day', async ({ page }) => {
  await anSeed(page);
  const r = await page.evaluate(() => { const t = getDailyScoreTrend(getAnalyticsRange('week')); return { t: JSON.parse(JSON.stringify(t)), live: dailyScore(todayStr()).score }; });
  const scores = r.t.series.map(x => x.score);
  assert.deepEqual(scores.slice(0, 6), [null, null, null, 50, null, 70], 'past days = stored snapshots only');
  assert.equal(scores[6], r.live, 'today = live dailyScore()');
  const xs = [50, 70, ...(r.live != null ? [r.live] : [])];
  assert.equal(r.t.metrics.avg.current, Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
  assert.equal(r.t.metrics.avg.previous, 90); assert.equal(r.t.max.score, Math.max(...xs)); assert.equal(r.t.min.score, Math.min(...xs));
  await anGo(page, 'week');
  const fig = page.locator('#anDs .an-chart');
  await fig.focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft');
  assert.match(await fig.locator('.an-readout').innerText(), /22\. ?9\.: 70/);
  await fig.locator('.an-ro-open').click();
  assert.equal((await page.locator('[data-ds="detail"] .ring > span').innerText()).trim(), '70', 'the existing detail sheet with the stored snapshot');
  await page.evaluate(() => closeSheets());
  assert.equal(await page.locator('#anDs [data-ds="stats"]').count(), 1, 'the existing Daily Score card stays in the section');
}, { state: fixtureState() });

test('AN5 XP: earned, per day, by source from the real key/reason, level at start/end; the XP history is never changed', async ({ page }) => {
  await anSeed(page);
  const before = await page.evaluate(() => JSON.stringify(S.xpLog));
  const a = await anWeek(page);
  assert.deepEqual([a.xp.metrics.total.current, a.xp.metrics.total.previous], [30 + 45 + 80 + 40 + 200 + 15, 25 + 10]);
  assert.equal(a.xp.metrics.perDay.current, Math.round((410 / 7) * 10) / 10);
  assert.deepEqual(a.xp.sources.filter(s => s.xp).map(s => [s.k, s.xp]), [['goals', 200], ['tasks', 90], ['fitness', 80], ['quests', 40]]);
  assert.deepEqual(await page.evaluate(() => [{ reason: 'Habit: X' }, { key: 'sleep:day:2026-09-01', reason: 'Sleep logged' }, { reason: 'Finance logged' }, { reason: 'Journal entry', key: 'journal:2026-09-01' }, { reason: 'Something old' }, { key: 'milestone:m1', reason: 'Milestone: x' }].map(anXpSource)),
    ['habits', 'sleep', 'finance', 'journal', 'other', 'milestones']);
  const lv = await page.evaluate(() => { const t = getXpTrend(getAnalyticsRange('week')); return [t.level.end.level, levelFromXp(S.totalXp).level, t.level.start.level, levelFromXp(S.totalXp - 410).level]; });
  assert.equal(lv[0], lv[1]); assert.equal(lv[2], lv[3]);
  await anGo(page, 'week');
  assert.match(await page.locator('#anXp').innerText(), /Projekty[\s\S]*200 XP · 49 %/);
  assert.equal(await page.evaluate(() => JSON.stringify(S.xpLog)), before);
}, { state: fixtureState() });

test('AN6 tasks: completed by their completion record, created, completion rate of tasks due in the period, overdue, lead time, by priority and category', async ({ page }) => {
  await anSeed(page);
  const t = (await anWeek(page)).tasks;
  assert.deepEqual([t.metrics.done.current, t.metrics.created.current, t.metrics.due.current, t.metrics.rate.current], [3, 4, 3, 67], 'done a1, a3, g3t; created a1-a3 + g3t; due a1-a3 of which 2 done');
  assert.deepEqual([t.metrics.done.previous, t.metrics.created.previous, t.metrics.rate.previous], [1, 2, 50]);
  assert.equal(t.overdue, 2, 'a2 and b2 are open and overdue now');
  assert.equal(t.metrics.lead.current, Math.round(((3 + 2 + 2) / 3) * 10) / 10, 'days from creation to the completion record');
  assert.deepEqual(t.byPriority.map(p => [p.p, p.done, p.due]), [['Low', 0, 1], ['High', 1, 1], ['Urgent', 1, 1]]);
  assert.deepEqual(t.byCategory, [{ c: 'Fitness', n: 1 }, { c: 'Health', n: 1 }, { c: 'Work', n: 1 }]);
  await anGo(page, 'week');
  assert.match(await page.locator('#anTasks').innerText(), /Plnění podle priority[\s\S]*Nízká[\s\S]*0 % · 0\/1[\s\S]*Vysoká[\s\S]*100 % · 1\/1/i);
}, { state: fixtureState() });

test('AN7 habits: completion from isScheduledDate/isDayComplete, weekly habits against their target, streaks from the existing functions, check-ins per day and heatmap', async ({ page }) => {
  await anSeed(page);
  const h = (await anWeek(page)).habits;
  const by = Object.fromEntries(h.list.map(x => [x.id, [x.done, x.expected]]));
  assert.deepEqual(by, { hd: [3, 7], hn: [1, 2], hw: [2, 2] }, 'daily: 3 of 7; created yesterday: 1 of 2; weekly 2x: 2 of 2');
  assert.equal(h.metrics.rate.current, Math.round(6 / 11 * 100));
  assert.deepEqual(h.series.map(x => x.n), [0, 0, 1, 0, 1, 3, 3], 'check-ins per day (bad habit: days logged clean)');
  const streaks = await page.evaluate(() => Object.fromEntries(S.habits.map(h => [h.id, [currentStreak(h), bestStreak(h)]])));
  for (const x of h.list) assert.deepEqual([x.current, x.best], streaks[x.id], 'streaks of ' + x.id + ' = currentStreak/bestStreak');
  const heat = await page.evaluate(() => { const x = anHeatmap('habits', 90); return [x.cells.length, x.cells.slice(-3).map(c => c.v), x.max, x.active]; });
  assert.deepEqual(heat, [90, [1, 3, 3], 3, 6], 'days with a completed habit: -9, -8, -4, -2, -1, 0');
  await anGo(page, 'week');
  await page.click('#anHeatBox [data-heat="tasks"]');
  assert.equal(await page.locator('#anHeatBox [data-heat="tasks"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.heat), 'tasks', 'focus kept on the switch');
  assert.match(await page.locator('#anHeatBox .an-heat-what').innerText(), /Počet dokončených úkolů za den/);
  await page.click('#anHeatBox [data-span="365"]');
  assert.equal(await page.locator('#anHeatBox .an-hc[data-i]').count(), 365);
}, { state: fixtureState() });

test('AN8 goals: active, completed in the period (goal completion record), average progress (goalProgress), deadlines, goals without movement - nothing created', async ({ page }) => {
  await anSeed(page);
  const g = (await anWeek(page)).goals;
  assert.deepEqual([g.active, g.completedAll, g.metrics.completed.current, g.metrics.completed.previous], [2, 1, 1, 0]);
  assert.equal(g.avgProgress, await page.evaluate(() => Math.round((goalProgress(S.goals[1]) + goalProgress(S.goals[2])) / 2)));
  assert.deepEqual(g.deadline, { overdue: 0, week: 0, month: 1, later: 0, none: 1 });
  assert.deepEqual(g.stale.map(x => [x.id, x.last, x.days]), [['g2', null, 40]], '"Živý" has a recent linked task; "Spící" none since creation');
  const n = await page.evaluate(() => [S.tasks.length, S.goals.length, S.habits.length]);
  await anGo(page, 'week');
  assert.match(await page.locator('#anStale').innerText(), /Spící[\s\S]*30 %[\s\S]*zatím bez aktivity · 40 dní/);
  await page.click('#anStale .an-stale[data-goal="g2"]');
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId, S.tasks.length, S.goals.length, S.habits.length]), ['goalDetail', 'g2', ...n]);
}, { state: fixtureState() });

test('AN9 planner: blocks and planned time (plannerDuration), past blocks marked done vs not, by category and weekday - no invented "actual time"', async ({ page }) => {
  await anSeed(page);
  const p = (await anWeek(page)).planner;
  assert.deepEqual([p.count, p.planned, p.past, p.done, p.doneMin, p.pastMin], [2, 150, 2, 1, 90, 150]);
  assert.deepEqual(p.byCategory, [{ c: 'Learning', min: 90 }, { c: 'Work', min: 60 }]);
  assert.deepEqual([p.metrics.hours.current, p.metrics.hours.previous, p.metrics.blocks.previous], [2.5, 0.5, 1]);
  assert.equal(p.byWeekday.reduce((a, b) => a + b, 0), 150);
  await anGo(page, 'week');
  assert.match(await page.locator('#anPlanner').innerText(), /aplikace neměří/);
}, { state: fixtureState() });

test('AN10 finance: income, expenses, net and count from the Finance 2.0 helpers, expenses and income by category, savings/investments as before', async ({ page }) => {
  await anSeed(page);
  const f = (await anWeek(page)).finance;
  const ref = await page.evaluate(() => { const r = getAnalyticsRange('week'), p = getPreviousAnalyticsRange(r); return [financeTotalsBetween(r.from, r.to), financeTotalsBetween(p.from, p.to)]; });
  assert.deepEqual([f.metrics.income.current, f.metrics.expenses.current, f.metrics.net.current, f.metrics.count.current], [ref[0].income, ref[0].expenses, ref[0].net, ref[0].count]);
  assert.deepEqual([f.metrics.expenses.previous, f.metrics.expenses.direction], [ref[1].expenses, 'down']);
  assert.deepEqual([f.expByCategory.length, f.incByCategory.length], [1, 1]);
  await anGo(page, 'week');
  const t = await page.locator('#anFinance').innerText();
  assert.match(t, /Úspory[\s\S]*Investice/); assert.doesNotMatch(t, /měl bys|špatn|problém|should|bad/i);
}, { state: fixtureState() });

test('AN11 fitness: completed workouts only (a running one is left out), minutes only where stored, volume from workoutVolume, names, weeks with a workout', async ({ page }) => {
  await anSeed(page);
  const f = (await anWeek(page)).fitness;
  assert.deepEqual([f.metrics.count.current, f.metrics.count.previous, f.metrics.minutes.current, f.metrics.minutes.previous], [2, 1, 50, 40], 'Pull has no duration: not counted as 0 minutes');
  assert.equal(f.metrics.volume.current, await page.evaluate(() => workoutVolume(S.workouts[0]) + workoutVolume(S.workouts[1])));
  assert.deepEqual(f.types, [{ k: 'Pull', n: 1 }, { k: 'Push', n: 1 }]);
  assert.deepEqual([f.last.name, f.activeWeeks, f.weeks], ['Pull', 2, 2]);
}, { state: fixtureState() });

test('AN12 nutrition: meals, logged days, kcal per logged day from nutriTotals (servings count), macros only when stored', async ({ page }) => {
  await anSeed(page);
  const n = (await anWeek(page)).nutrition;
  assert.deepEqual([n.metrics.meals.current, n.daysLogged, n.metrics.kcal.current, n.metrics.kcal.previous], [2, 1, 1400, 500]);
  assert.deepEqual([n.protein, n.carbs, n.fat], [null, null, null], 'no macro stored in the current period -> nothing computed');
  assert.equal(n.series.filter(x => x.kcal != null).length, 1, 'days without a meal stay empty');
}, { state: fixtureState() });

test('AN13 sleep: average/min/max from sleepDuration (overnight-safe), nights, quality, length distribution - no advice', async ({ page }) => {
  await anSeed(page);
  const s = (await anWeek(page)).sleep;
  assert.deepEqual([s.nights, s.min, s.max, s.metrics.avg.current, s.metrics.avg.previous, s.quality], [2, 5.5, 8, 6.8, 9, 3]);
  assert.deepEqual(s.buckets.map(b => b.n), [1, 0, 0, 1, 0]);
  await anGo(page, 'week');
  assert.doesNotMatch(await page.locator('#anSleep').innerText(), /doporuč|měl bys|nedostatek|should|too little/i);
}, { state: fixtureState() });

test('AN14 attributes: current value and the gains of the period from the XP entries; no way to edit them', async ({ page }) => {
  await anSeed(page);
  const a = (await anWeek(page)).attrs;
  const by = Object.fromEntries(a.attrs.map(x => [x.k, [x.value, x.change.current, x.change.previous]]));
  assert.deepEqual(by, { STR: [24, 24, 0], INT: [33, 18, 15], DEX: [10, 10, 0], VIT: [41, 41, 0], WIS: [0, 0, 0], FOC: [0, 0, 0], SOC: [0, 0, 0] });
  await anGo(page, 'week');
  assert.equal(await page.locator('#anAttrs input, #anAttrs button, #anAttrs select').count(), 0);
}, { state: fixtureState() });

test('AN15 observations and biggest changes are deterministic, factual and only shown with data', async ({ page }) => {
  await anSeed(page);
  const r = await page.evaluate(() => { const run = () => { const a = anAnalyze(getAnalyticsRange('week')); return JSON.stringify([anObservations(a), anTopChanges(a), anChanges(a)]); }; return [run(), run(), run()]; });
  assert.equal(new Set(r).size, 1, 'same data -> same output');
  const [obs, top] = JSON.parse(r[0]);
  assert.deepEqual(obs.map(o => o.k), ['workouts', 'task_rate', 'xp_source', 'ds', 'habit_top', 'expenses', 'goals_stale', 'planner']);
  const pd = top.map(t => Math.abs(t.percentDelta));
  assert.deepEqual(pd, [...pd].sort((a, b) => b - a), 'sorted by the size of the relative change'); assert.ok(top.length <= 5);
  await anGo(page, 'week');
  const text = await page.locator('#anObs').innerText() + await page.locator('#anChanges').innerText();
  assert.match(text, /Podíl splněných úkolů s termínem: 50 % → 67 %/);
  assert.match(text, /Průměrný Daily Score: 90 → \d+/);
  assert.doesNotMatch(text, /zlepšil|zhoršil|lepší|horší|dobr[ýá]|špatn|výborn|líný|měl bys|should|good|bad|excellent|lazy|poor|\bAI\b/i, 'no judgement, no advice');
}, { state: fixtureState() });

test('AN16 no write side effects: opening Analytics in every period, charts, heatmap, tables and copy change no data and pay no XP', async ({ page }) => {
  await page.evaluate(() => { view = 'home'; render(); }); await persist(page);
  const before = await anState(page), idb0 = await idbState(page);
  await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }, configurable: true }); });
  for (const p of [...anPeriods, 'custom']) {
    await anGo(page, p);
    for (const fig of await page.locator('.an-chart').all()) { await fig.focus(); await page.keyboard.press('ArrowRight'); }
    await page.locator('.an-table summary').first().click();
  }
  for (const m of ['tasks', 'habits', 'fitness', 'xp', 'ds']) await page.click(`#anHeatBox [data-heat="${m}"]`);
  await page.click('#anCopy');
  await page.waitForFunction(() => window.__copied);
  assert.match(await page.evaluate(() => window.__copied), /Souhrn analytiky[\s\S]*Co se změnilo/);
  await settle(page);
  assert.equal(await anState(page), before, 'state unchanged');
  assert.deepEqual(await idbState(page), idb0, 'nothing saved');
}, { state: fixtureState() });

test('AN17 performance: a year of data (1 500 tasks, 25 000 XP, 40 habits, 25 goals, 400 planner blocks) - Analytics render and engine', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3));
    const T = todayStr();
    for (let i = 0; i < 40; i++) S.habits.push({ id: 'ph' + i, name: 'Rutina ' + i, type: i % 9 ? 'good' : 'bad', frequency: i % 7 ? 'daily' : 'weekly', target: i % 5 ? 1 : 3, completions: Array.from({ length: 200 }, (_, k) => addDays(T, -k * (1 + i % 2))), brokenDates: [], active: true, createdAt: 1 });
    for (let i = 0; i < 25; i++) S.goals.push({ id: 'pg' + i, title: 'Projekt ' + i, status: i % 5 ? 'Active' : 'Completed', targetDate: addDays(T, i - 5), mode: 'auto', createdAt: 1 });
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, -(i % 365)), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':00', title: 'Blok ' + i, category: ['Work', 'Learning', ''][i % 3], taskId: '', goalId: '', completed: i % 2 === 0 });
    for (let i = 0; i < 300; i++) { const d = addDays(T, -i); S.meals.push({ id: 'pm' + i, name: 'Jídlo', date: d, type: 'Lunch', calories: 500 + i % 300, servings: 1 }); S.sleepLog.push({ id: 'ps' + i, date: d, bedtime: '23:00', wake: '07:00', quality: 3 }); if (i % 3 === 0) S.expenses.push({ id: 'pe' + i, date: d, amount: 100 + i, category: 'Food' }); }
    for (let i = 0; i < 150; i++) S.workouts.push({ id: 'pw' + i, name: i % 2 ? 'Push' : 'Pull', date: addDays(T, -i * 2), duration: 45, exercises: [{ id: 'x', name: 'Bench', sets: 3, reps: 8, weight: 60 }] });
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    const out = {};
    for (const p of ['week', 'month', 'quarter', 'year']) { out[p] = m(() => { statsPeriod = p; view = 'statistics'; render(); }, 3); out[p + 'Engine'] = m(() => anAnalyze(getAnalyticsRange(p)), 3); }
    out.first = (() => { anXpCache = { log: null, len: -1, last: null, map: null }; anTaskCache = { set: null, size: -1, map: null }; const t = performance.now(); statsPeriod = 'month'; view = 'statistics'; render(); return performance.now() - t; })();
    out.bad = /undefined|NaN/.test(document.getElementById('app').innerText);
    return out; });
  console.log('      AN17 ' + Object.entries(r).filter(([k]) => k !== 'bad').map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  assert.ok(!r.bad);
  assert.ok(r.month < 250 && r.year < 400 && r.monthEngine < 150 && r.first < 400, 'fast enough (target: month < 100 ms)');
}, { state: fixtureState() });

test('AN18 320-1440 px: no page overflow, cards stack, every control is a 44 px target, no clipped text', async ({ page }) => {
  const bad = [];
  for (const w of [320, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const p of ['month', 'year']) {
      await anGo(page, p);
      const c = await anClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/${p}: ${JSON.stringify(c)}`);
      const small = await page.$$eval('.an button, .an summary, .an a, .an input, .an .an-chart, .an .an-heat', ns => ns.filter(n => n.offsetParent && !n.closest('[data-ds="stats"]')).map(n => [n.className || n.tagName, n.getBoundingClientRect()]).filter(([, r]) => r.height < 44 || r.width < 44).map(([c, r]) => `${c} ${Math.round(r.width)}x${Math.round(r.height)}`));
      if (small.length) bad.push(`${w}/${p} small: ${small.slice(0, 5).join(', ')}`);
      const clipped = await page.$$eval('.an .stat-value, .an .an-ch-l, .an .an-ch-v, .an .kicker', ns => ns.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent.trim().slice(0, 20)));
      if (clipped.length) bad.push(`${w}/${p} clipped: ${clipped.join(', ')}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('AN19 light + dark: WCAG AA text contrast in every Analytics period; no emoji as UI icons', async ({ page }) => {
  const bad = [];
  for (const theme of ['light', 'dark']) for (const p of [...anPeriods, 'custom']) {
    const r = await page.evaluate(([theme, p]) => { S.settings.theme = theme; applyTheme(); closeSheets(); statsPeriod = p; view = 'statistics'; render();
      const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
      const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { st.push(c); if (c.a >= 1) break; } } let bg = parse(getComputedStyle(document.body).backgroundColor); for (let i = st.length - 1; i >= 0; i--) bg = blend(st[i], bg); return bg; };
      const out = [];
      document.querySelectorAll('.an *').forEach(e => { if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return; const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[aria-hidden="true"],.hide,details:not([open]) table')) return;
        const fg0 = parse(cs.color); if (!fg0) return; const bg = bgOf(e), fg = blend(fg0, bg); const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
        const size = parseFloat(cs.fontSize), need = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5; if (ratio < need) out.push(`${theme}/${p}: "${e.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`); });
      const emoji = [...document.querySelectorAll('.an button, .an h3, .an .kicker, .an .stat-label')].map(n => n.textContent).filter(t => /\p{Extended_Pictographic}/u.test(t));
      return out.concat(emoji.map(t => `${theme}/${p} emoji: ${t.trim().slice(0, 20)}`)); }, [theme, p]);
    bad.push(...r);
  }
  assert.deepEqual([...new Set(bad)], []);
}, { state: fixtureState() });

test('AN20 accessibility: tabs, named sections and controls, charts with text summaries + tables + keyboard readout, heatmap by keyboard, reduced motion', async ({ page }) => {
  await anGo(page, 'month');
  const r = await page.evaluate(() => {
    const an = document.querySelector('.an');
    const unnamed = [...an.querySelectorAll('button, summary, a, input, [tabindex="0"]')].filter(n => !((n.getAttribute('aria-label') || n.textContent || (n.labels && n.labels[0] && n.labels[0].textContent) || '').trim())).map(n => n.className);
    const tabs = [...document.querySelectorAll('#spTabs [role="tab"]')].map(t => t.getAttribute('aria-selected'));
    const figs = [...an.querySelectorAll('.an-chart')].map(f => [f.getAttribute('role'), (f.getAttribute('aria-label') || '').length > 20, !!f.querySelector('.an-readout[aria-live]'), !!f.querySelector('details.an-table table')]);
    const secs = [...an.querySelectorAll('.an-sec')].filter(s => !document.getElementById(s.getAttribute('aria-labelledby'))).length;
    const bars = [...an.querySelectorAll('[role="progressbar"]')].filter(b => !b.hasAttribute('aria-valuenow')).length;
    return { unnamed, tabs, figs, secs, bars, heat: document.querySelector('.an-heat').getAttribute('aria-label') };
  });
  assert.deepEqual(r.unnamed, []); assert.equal(r.secs, 0); assert.equal(r.bars, 0);
  assert.deepEqual(r.tabs, ['false', 'false', 'true', 'false', 'false', 'false']);
  assert.ok(r.figs.length >= 5 && r.figs.every(f => f[0] === 'group' && f[1] && f[2] && f[3]), 'charts: group + summary + live readout + table');
  assert.match(r.heat, /Dní s hodnotou: \d+/);
  const fig = page.locator('#anXp .an-chart'); await fig.focus(); await page.keyboard.press('Home');
  assert.match(await fig.locator('.an-readout').innerText(), /25\. ?8\.: \d/);
  const heat = page.locator('.an-heat'); await heat.focus(); await page.keyboard.press('ArrowLeft');
  assert.match(await page.locator('#anHeatBox .an-readout').innerText(), /\d{2}\.\d{2}\.2026: /);
  await page.click('.an-jump [data-jump="anSleep"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'anSleepH', 'section jump moves focus to the section heading');
  const moving = await page.evaluate(() => [...document.querySelectorAll('.an, .an *')].filter(n => { const cs = getComputedStyle(n); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 || parseFloat(cs.transitionDuration) > 0.01; }).map(n => n.className));
  assert.deepEqual(moving, [], 'reduced motion: nothing in Analytics animates');
}, { state: fixtureState() });

test('AN21 export/import unchanged: the backup is still exactly the state (no Analytics data inside); a round trip gives the same Analytics', async ({ page }) => {
  await anSeed(page); await persist(page);
  const keys0 = await page.evaluate(() => Object.keys(defaultState()).sort());
  await anGo(page, 'month');
  const html0 = await page.evaluate(() => document.querySelector('.an-body').innerHTML);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(exported, await stateOf(page), 'export equals state');
  assert.ok(Object.keys(exported).every(k => keys0.includes(k) || ['dailyScores', 'dailyScoresSince'].includes(k)), 'no new top-level key');
  assert.ok(!JSON.stringify(exported).includes('anAnalyze') && !('analytics' in exported));
  await page.evaluate(() => { S.tasks = []; S.xpLog = []; }); await importFile(page, await dl.path()); await settle(page);
  assert.deepEqual(await stateOf(page), exported, 'import restores it exactly');
  await anGo(page, 'month');
  assert.equal(await page.evaluate(() => document.querySelector('.an-body').innerHTML), html0, 'same Analytics after the round trip');
}, { state: fixtureState() });

test('AN22 legacy state: an old backup (schemaVersion 4, XP without keys or attribute gains) migrates as before and Analytics reads it cleanly', async ({ page }) => {
  await page.evaluate(() => { const legacy = { tasks: [{ id: 'lt', title: 'Legacy', priority: 'High', dueDate: '2026-09-20', done: true, createdAt: 1 }], habits: [{ id: 'lh', name: 'Legacy habit', category: 'Health', completions: ['2026-09-20', '2026-09-21'], active: true, createdAt: 1 }],
      goals: [{ id: 'lg', title: 'Starý projekt', status: 'Active', createdAt: 1 }], sleepLog: [{ id: 'ls', date: '2026-09-20', bedtime: '23:00', wake: '07:00', quality: 4, createdAt: 1 }],
      workouts: [{ id: 'lw', name: 'Old', date: '2026-09-19', exercises: [{ id: 'le', name: 'Squat', sets: 3, reps: 5, weight: 100 }] }], totalXp: 800,
      xpLog: [{ id: 'l1', amount: 50, reason: 'Task completed', ts: new Date('2026-09-20T10:00').getTime() }, { id: 'l2', amount: 20, reason: 'Workout', ts: new Date('2026-09-19T10:00').getTime() }], schemaVersion: 4 };
    S = migrate(legacy); S.settings.onboarded = true; });
  assert.equal(await page.evaluate(() => S.schemaVersion), 8);
  await page.evaluate(() => { view = 'home'; render(); }); // the app's own first-render work (daily-score snapshots, achievements) happens before we measure
  const before = await anState(page);
  for (const p of anPeriods) { await anGo(page, p); assert.deepEqual(await anClean(page), { bad: false, dup: [], overflow: 0 }, p); }
  await anGo(page, 'week');
  const a = await anWeek(page);
  assert.deepEqual(a.xp.sources.filter(s => s.xp).map(s => s.k), ['tasks', 'fitness'], 'old reasons without keys still classified');
  assert.equal(a.attrs.tracked, false); assert.match(await page.locator('#anAttrs').innerText(), /Historie XP zatím neobsahuje přírůstky atributů/);
  assert.equal(a.tasks.metrics.done.current, 0, 'a legacy "done" without a completion record is not dated into a period');
  assert.equal(await anState(page), before, 'reading a migrated state writes nothing');
}, { state: fixtureState() });

test('AN23 repeated render gives an identical result (every period); switching periods back and forth too', async ({ page }) => {
  await anSeed(page);
  for (const p of [...anPeriods, 'custom']) {
    const h = await page.evaluate(p => { const html = () => { statsPeriod = p; view = 'statistics'; render(); return document.getElementById('app').innerHTML; }; const a = html(); statsPeriod = 'year'; render(); return [a, html(), html()]; }, p);
    assert.ok(h[0] === h[1] && h[1] === h[2], p);
  }
}, { state: fixtureState() });

test('AN24 + AN25 no duplicate ids, no NaN / undefined / Infinity in any period, on the fixture, the seeded data, an empty state and a year of data', async ({ page }) => {
  const bad = [];
  const sweep = async name => { for (const p of [...anPeriods, 'custom']) { await anGo(page, p); const c = await anClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${name}/${p}: ${JSON.stringify(c)}`); } };
  await sweep('fixture');
  await anSeed(page); await sweep('seed');
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; }); await sweep('empty');
  await withGen(page); await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; Object.assign(S, window.__gen(300, 4000, 7)); }); await sweep('year');
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

// ---------- Advanced Goals & Planning 2.0 ----------
// Goals + Tasks + Planner + Habits as one linked system. A read-only organisation layer (gp* helpers) over the existing
// links, plus two optional fields entered in the existing forms (milestone.targetDate, task.milestoneId). The tests pin
// the facts shown (status, next step, roadmap, pace, week, timeline, capacity, conflicts, review), the entry points to the
// existing forms, the integrations, XP anti-farming, legacy data, export/import, no writes, performance, layout and a11y.
const gpGo = (page, v, extra) => page.evaluate(([v, extra]) => { closeSheets(); Object.assign(window, extra || {}); if (extra && extra.goalFilter) goalFilter = extra.goalFilter; if (extra && extra.currentGoalId) currentGoalId = extra.currentGoalId; view = v; render(); }, [v, extra || null]);
const gpClean = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|Infinity|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
// fixture day 2026-09-23 (Wednesday), 12:00; this week 2026-09-21..27
const gpSeed = page => page.evaluate(() => {
  const T = todayStr(), D = n => addDays(T, n), ts = (d, h) => new Date(d + 'T' + String(h || 12).padStart(2, '0') + ':00').getTime();
  S = defaultState(); S.settings.onboarded = true;
  S.goals = [
    { id: 'gA', title: 'Maraton', description: 'Doběhnout 42 km', category: 'Fitness', targetDate: D(30), status: 'Active', mode: 'auto', manualProgress: 0, createdAt: ts(D(-30)) },
    { id: 'gB', title: 'Kniha', description: '', category: 'Learning', targetDate: '', status: 'Active', mode: 'manual', manualProgress: 40, createdAt: ts(D(-40)) },
    { id: 'gC', title: 'Stará', description: '', category: '', targetDate: D(-3), status: 'Active', mode: 'manual', manualProgress: 0, createdAt: ts(D(-60)) },
    { id: 'gD', title: 'Hotová', description: '', category: 'Work', targetDate: D(-5), status: 'Completed', mode: 'manual', manualProgress: 100, createdAt: ts(D(-90)) },
    { id: 'gE', title: 'Pauza', description: '', category: '', targetDate: '', status: 'Paused', mode: 'manual', manualProgress: 10, createdAt: ts(D(-10)) }];
  S.milestones = [
    { id: 'mA1', goalId: 'gA', title: 'Půlmaraton', description: '', targetDate: D(-2), completed: false, completedAt: null, createdAt: ts(D(-20)) },
    { id: 'mA2', goalId: 'gA', title: '30 km', description: '', targetDate: D(10), completed: false, completedAt: null, createdAt: ts(D(-10)) },
    { id: 'mA3', goalId: 'gA', title: '10 km', description: '', completed: true, completedAt: ts(D(-5)), createdAt: ts(D(-15)) }];
  S.tasks = [
    { id: 'tA1', title: 'Běh 10 km', priority: 'High', category: 'Fitness', goalId: 'gA', milestoneId: 'mA1', dueDate: D(1), done: false, createdAt: ts(D(-6)) },
    { id: 'tA2', title: 'Běh 15 km', priority: 'Medium', category: 'Fitness', goalId: 'gA', milestoneId: 'mA1', dueDate: D(-1), done: true, createdAt: ts(D(-6)) },
    { id: 'tA3', title: 'Boty', priority: 'Low', category: 'Personal', goalId: 'gA', dueDate: D(3), done: false, createdAt: ts(D(-4)) },
    { id: 'tA4', title: 'Strečink', priority: 'Low', category: 'Fitness', goalId: 'gA', dueDate: '', done: false, createdAt: ts(D(-4)) },
    { id: 'tX', title: 'Bez projektu', priority: 'Medium', category: '', goalId: '', dueDate: D(0), done: false, createdAt: ts(D(-1)) }];
  S.xpLog = [{ id: 'x1', amount: 20, reason: 'Task: Běh 15 km', ts: ts(D(-1)), key: `task:tA2:${D(-1)}` }, { id: 'x2', amount: 200, reason: 'Goal: Hotová', ts: ts(D(-2)), key: 'goal:gD:complete' },
    { id: 'x3', amount: 25, reason: 'Milestone: 10 km', ts: ts(D(-5)), key: 'milestone:mA3' }];
  S.totalXp = 245;
  const B = (id, date, s, e, extra) => ({ id, date, startTime: s, endTime: e, title: id, description: '', category: '', taskId: '', goalId: '', workoutId: '', notes: '', workoutTemplateId: '', completed: false, createdAt: 1, updatedAt: 1, ...extra });
  S.plannerBlocks = [B('pA1', D(0), '06:00', '07:00', { goalId: 'gA', title: 'Ranní běh', category: 'Fitness', completed: true }), B('pA2', D(1), '06:00', '07:30', { taskId: 'tA1', title: 'Běh 10 km', category: 'Fitness' }),
    B('pA3', D(2), '18:00', '19:00', { goalId: 'gA', title: 'Intervaly', category: 'Fitness' }), B('pX', D(2), '18:30', '19:30', { title: 'Schůzka', category: 'Work' }),
    B('pB1', D(5), '20:00', '21:00', { goalId: 'gB', title: 'Čtení', category: 'Learning' })];
  S.habits = [{ id: 'hA', name: 'Běhání', type: 'good', frequency: 'daily', target: 1, goalId: 'gA', completions: [D(0), D(-1), D(-3)], active: true, createdAt: ts(D(-30)) },
    { id: 'hN', name: 'Nepropojený', type: 'good', frequency: 'daily', target: 1, goalId: '', completions: [D(0)], active: true, createdAt: ts(D(-30)) }];
  S.dailyScoresSince = T; S.achievementsUnlocked = ACHV.map(a => a.id);
  S = migrate(JSON.parse(JSON.stringify(S)));
  ['daily', 'weekly'].forEach(p => questBoardFor(p).forEach(({ q }) => { const k = questKey(q.id, p); if (!S.quests.some(x => x.key === k)) S.quests.push({ key: k, questId: q.id, date: todayStr(), period: p }); }));
  view = 'home'; render();
});
const gpState = page => page.evaluate(() => JSON.stringify(S));

test('GP1 Goals overview: filters, active cards by deadline with next step / milestones / open tasks, completed apart, weekly review, capacity, conflicts, nearest deadlines, goals without a next step', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goals', { goalFilter: 'Active' });
  assert.deepEqual(await page.$$eval('#gf [data-f]', ns => ns.map(n => [n.dataset.f, n.getAttribute('aria-selected')])), [['All', 'false'], ['Active', 'true'], ['Completed', 'false'], ['Overdue', 'false'], ['NoNext', 'false']]);
  assert.deepEqual(await page.$$eval('.goal-card', ns => ns.map(n => n.dataset.goal)), ['gC', 'gA', 'gB'], 'sorted by deadline, undated last');
  const a = await page.locator('.goal-card[data-goal="gA"]').innerText();
  assert.match(a, /Maraton[\s\S]*25%[\s\S]*Aktivní[\s\S]*23\.10\.2026[\s\S]*1\/3[\s\S]*3 otevřené úkoly[\s\S]*Úkol: Běh 10 km · 24\.09\.2026/);
  assert.match(await page.locator('.goal-card[data-goal="gB"]').innerText(), /Bez termínu[\s\S]*Blok: Čtení · 28\.09\.2026 20:00–21:00/);
  assert.match(await page.locator('.goal-card[data-goal="gC"]').innerText(), /Po termínu[\s\S]*Další krok není naplánován\./);
  for (const id of ['gpReview', 'gpCapacity', 'gpConflicts', 'gpDeadlines', 'gpNoNext']) assert.equal(await page.locator('#' + id).count(), 1, id);
  assert.deepEqual(await page.$$eval('#gpDeadlines .gp-row', ns => ns.map(n => n.dataset.goal)), ['gC', 'gA']);
  assert.deepEqual(await page.$$eval('#gpNoNext .gp-row', ns => ns.map(n => n.dataset.goal)), ['gC']);
  await gpGo(page, 'goals', { goalFilter: 'All' });
  assert.deepEqual(await page.$$eval('.gp-group h3', ns => ns.map(n => n.textContent)), ['Aktivní · 3', 'Dokončené · 1', 'Pozastavené a archivované · 1']);
  await page.locator('.goal-card[data-goal="gA"] .goal-top').click();
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gA']);
}, { state: fixtureState() });

test('GP2 Goal detail: header (category, title, progress, status, deadline, XP) and all sections', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  const h = await page.locator('.gp-head').innerText();
  assert.match(h, /Fitness[\s\S]*Maraton[\s\S]*Doběhnout 42 km[\s\S]*25%[\s\S]*Aktivní[\s\S]*do 23\.10\.2026[\s\S]*\+200 XP/i);
  assert.equal(await page.locator('.gp-head [role="progressbar"]').getAttribute('aria-valuenow'), String(await page.evaluate(() => goalProgress(S.goals[0]))));
  for (const id of ['gpNext', 'gpPace', 'gpWeek', 'gpRoadmap', 'gpHabits', 'gpTimeline', 'msList', 'ltList', 'lhList']) assert.equal(await page.locator('#' + id).count(), 1, id);
  const st = await page.evaluate(() => S.goals.map(g => [g.id, gpStatus(g)]));
  assert.deepEqual(st, [['gA', 'active'], ['gB', 'nodeadline'], ['gC', 'overdue'], ['gD', 'completed'], ['gE', 'paused']]);
  assert.doesNotMatch(await page.locator('#app').innerText(), /good|bad|healthy|failing|poor|dobrý|špatný|nestíháš/i, 'factual statuses only');
}, { state: fixtureState() });

test('GP3 next step: task -> milestone -> upcoming block (done or ended blocks skipped) -> "Další krok není naplánován." with "+ Naplánovat další krok" opening the existing form; nothing created', async ({ page }) => {
  await gpSeed(page);
  const r = await page.evaluate(() => { const ix = gpIndex(); const n = id => { const x = gpNextStep(S.goals.find(g => g.id === id), ix); return x ? [x.k, x.id] : null; };
    const out = { A: n('gA'), B: n('gB'), C: n('gC'), D: n('gD') };
    S.tasks.filter(t => t.goalId === 'gA').forEach(t => { t.done = true; }); out.A2 = gpNextStep(S.goals[0]).id; // no open task -> nearest open milestone
    S.milestones.filter(m => m.goalId === 'gA').forEach(m => { m.completed = true; }); out.A3 = gpNextStep(S.goals[0]).id; // -> nearest upcoming block (pA1 done, pA2 tomorrow)
    S.plannerBlocks.find(b => b.id === 'pA2').completed = true; S.plannerBlocks.push({ id: 'pEnded', date: todayStr(), startTime: '08:00', endTime: '09:00', title: 'Ended', goalId: 'gA', completed: false });
    out.A4 = gpNextStep(S.goals[0]).id; // pA2 done, pEnded ended at 09:00 -> pA3
    return out; });
  assert.deepEqual([r.A, r.B, r.C, r.D], [['task', 'tA1'], ['block', 'pB1'], null, null]);
  assert.deepEqual([r.A2, r.A3, r.A4], ['mA1', 'pA2', 'pA3']);
  await gpSeed(page); const before = await gpState(page);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gC' });
  assert.match(await page.locator('#gpNext').innerText(), /Další krok není naplánován\./);
  await page.click('#gpPlanNext');
  assert.ok(await page.locator('.sheet .pl-form').isVisible(), 'the existing Planner form');
  assert.match(await page.locator('.sheet #pb_link').innerText(), /Stará/, 'the goal is preselected');
  await page.evaluate(() => closeSheets());
  assert.equal(await gpState(page), before, 'opening the form creates nothing');
}, { state: fixtureState() });

test('GP4 roadmap and milestones 2.0: goal -> milestones (status, deadline, linked tasks, next task) -> tasks without a milestone -> planner blocks; the optional fields come from the existing forms', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.deepEqual(await page.$$eval('#msList .gp-ms', ns => ns.map(n => n.dataset.ms)), ['mA1', 'mA2', 'mA3'], 'milestones by deadline, undated last');
  const m1 = await page.locator('.gp-ms[data-ms="mA1"]').innerText();
  assert.match(m1, /Půlmaraton[\s\S]*Po termínu[\s\S]*21\.09\.2026[\s\S]*1\/2 úkolů[\s\S]*Další úkol: Běh 10 km/);
  assert.deepEqual(await page.$$eval('.gp-ms[data-ms="mA1"] .task-item .item-title', ns => ns.map(n => n.textContent.trim())), ['Běh 10 km', 'Běh 15 km']);
  assert.equal(await page.locator('.gp-ms[data-ms="mA1"] [role="progressbar"]').getAttribute('aria-valuenow'), '50');
  assert.match(await page.locator('.gp-ms[data-ms="mA3"]').innerText(), /Dokončeno/);
  assert.deepEqual(await page.$$eval('#ltList .task-item .item-title', ns => ns.map(n => n.textContent.trim())), ['Boty', 'Strečink']);
  assert.match(await page.locator('#gpBlocks').innerText(), /Intervaly[\s\S]*Běh 10 km[\s\S]*Ranní běh/);
  const mi = await page.evaluate(() => { const x = gpMilestone(S.milestones[0]); return [x.done, x.remaining, x.progress, x.status, x.next.id]; });
  assert.deepEqual(mi, [1, 1, 50, 'overdue', 'tA1']);
  // milestone form: optional deadline
  await page.locator('.gp-ms[data-ms="mA2"] .editMs').click();
  await page.fill('#ms_due', '2026-10-15'); await page.click('#ms_save');
  assert.equal(await page.evaluate(() => S.milestones.find(m => m.id === 'mA2').targetDate), '2026-10-15');
  // task form: milestone select offers only this goal's milestones and stores task.milestoneId
  await page.evaluate(() => openTaskEditForm(S.tasks.find(t => t.id === 'tA3')));
  assert.deepEqual(await page.$$eval('#f_ms option', ns => ns.map(o => o.value)), ['', 'mA1', 'mA2', 'mA3']);
  await page.selectOption('#f_ms', 'mA2'); await page.click('#f_save');
  assert.equal(await page.evaluate(() => S.tasks.find(t => t.id === 'tA3').milestoneId), 'mA2');
  await page.evaluate(() => openTaskEditForm(S.tasks.find(t => t.id === 'tX')));
  assert.equal(await page.locator('#f_msWrap').isHidden(), true, 'no goal -> no milestone field');
  await page.selectOption('#f_goal', 'gA'); assert.equal(await page.locator('#f_msWrap').isVisible(), true);
  await page.evaluate(() => closeSheets());
  assert.equal(await page.evaluate(() => 'milestoneId' in S.tasks.find(t => t.id === 'tX')), false, 'untouched until saved');
}, { state: fixtureState() });

test('GP5 pace: progress, time share, days left and the required pace from the creation day, deadline and goalProgress; otherwise "Tempo nelze vypočítat."', async ({ page }) => {
  await gpSeed(page);
  const p = await page.evaluate(() => ['gA', 'gB', 'gC', 'gD'].map(id => { const x = gpPace(S.goals.find(g => g.id === id)); return x.ok ? [x.total, x.elapsed, x.remaining, x.timePct, x.progress, x.perDay, x.past] : false; }));
  assert.deepEqual(p, [[60, 30, 30, 50, 25, 2.5, false], false, [57, 57, 0, 100, 0, null, true], false]);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.match(await page.locator('#gpPace').innerText(), /Progress\s*25 %[\s\S]*Podle času\s*50 %[\s\S]*Čas do termínu\s*30 dní[\s\S]*Potřebné tempo\s*\+2,5 % \/ den/);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gB' });
  assert.match(await page.locator('#gpPace').innerText(), /Tempo nelze vypočítat\./);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gC' });
  assert.match(await page.locator('#gpPace').innerText(), /Termín už uplynul/);
  assert.doesNotMatch(await page.locator('#gpPace').innerText(), /nestíháš|stíháš|pozadu|skvěl|should/i);
}, { state: fixtureState() });

test('GP6 ahead / behind: progress vs elapsed time share in percentage points, only when both are known', async ({ page }) => {
  await gpSeed(page);
  const r = await page.evaluate(() => { const T = todayStr(), mk = (p, c, d) => ({ id: 'x', title: 'x', status: 'Active', mode: 'manual', manualProgress: p, createdAt: new Date(addDays(T, c) + 'T12:00').getTime(), targetDate: addDays(T, d) });
    return [gpPace(mk(80, -10, 10)).diff, gpPace(mk(30, -10, 10)).diff, gpPace(mk(50, -10, 10)).diff, gpPace(mk(50, 0, 10)).diff]; });
  assert.deepEqual(r, [30, -20, 0, null], 'ahead 30, behind 20, even, not shown on the first day');
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.match(await page.locator('#gpPace [data-pace]').innerText(), /Progress je o 25 procentních bodů za časovým podílem\./);
  await page.evaluate(() => { S.goals.push({ id: 'gAh', title: 'Náskok', status: 'Active', mode: 'manual', manualProgress: 80, createdAt: new Date(addDays(todayStr(), -10) + 'T12:00').getTime(), targetDate: addDays(todayStr(), 10) }); currentGoalId = 'gAh'; render(); });
  assert.match(await page.locator('#gpPace [data-pace="ahead"]').innerText(), /o 30 procentních bodů před časovým podílem\./);
}, { state: fixtureState() });

test('GP7 weekly goal plan: tasks, milestones, blocks and linked habits this week - planned / done / left from the real records', async ({ page }) => {
  await gpSeed(page);
  const w = await page.evaluate(() => { const x = gpWeek(S.goals[0]); return { t: [x.tasks.planned, x.tasks.done, x.tasks.remaining], m: [x.milestones.planned, x.milestones.done, x.milestones.remaining], b: [x.blocks.planned, x.blocks.done, x.blocks.remaining, x.blocks.min], h: x.habits }; });
  assert.deepEqual(w, { t: [3, 1, 2], m: [1, 0, 1], b: [3, 1, 2, 210], h: [{ id: 'hA', name: 'Běhání', done: 2, expected: 3 }] });
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.deepEqual(await page.$$eval('#gpWeek tbody tr', rs => rs.map(r => [...r.children].map(c => c.textContent.trim()))),
    [['Úkoly', '3', '1', '2'], ['Milníky', '1', '0', '1'], ['Bloky', '3 3 h 30 min', '1 1 h', '2'], ['Běhání', '3', '2', '1']]);
}, { state: fixtureState() });

test('GP8 Goal -> Planner: "Naplánovat čas" opens the existing Planner form with the goal preselected; the saved block is a normal block linked to the goal and shows on the goal at once', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  const n0 = await page.evaluate(() => S.plannerBlocks.length);
  await page.click('#gpPlan');
  assert.match(await page.locator('.sheet #pb_link').innerText(), /Maraton/);
  await page.fill('#pb_title', 'Tempo běh'); await page.fill('#pb_date', '2026-09-25'); await page.fill('#pb_start', '07:00'); await page.fill('#pb_end', '08:00');
  await page.click('#pb_save'); await settle(page);
  const b = await page.evaluate(() => S.plannerBlocks[S.plannerBlocks.length - 1]);
  assert.equal(await page.evaluate(() => S.plannerBlocks.length), n0 + 1);
  assert.deepEqual([b.title, b.goalId, b.taskId, b.date, b.startTime, b.endTime, b.category], ['Tempo běh', 'gA', '', '2026-09-25', '07:00', '08:00', 'Fitness']);
  assert.deepEqual(Object.keys(b).sort(), Object.keys((await page.evaluate(() => S.plannerBlocks.find(x => x.id === 'pA1')))).sort().filter(k => k !== 'nothing'), 'the same planner model');
  assert.equal(await page.evaluate(() => view), 'goalDetail', 'stays on the goal');
  assert.match(await page.locator('#gpBlocks').innerText(), /Tempo běh[\s\S]*25\.09\.2026 · 07:00–08:00/);
  assert.equal((await idbState(page)).plannerBlocks.some(x => x.title === 'Tempo běh'), true, 'saved');
}, { state: fixtureState() });

test('GP9 Goal -> Task: "+ Úkol" opens the existing task form with the goal linked and its category prefilled; the user saves; XP untouched', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  const xp0 = await xpOf(page), n0 = await page.evaluate(() => S.tasks.length);
  await page.click('#gpAddTask');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#f_goal').value, document.querySelector('#f_cat').value, [...document.querySelectorAll('#f_ms option')].map(o => o.value)]), ['gA', 'Fitness', ['', 'mA1', 'mA2', 'mA3']]);
  assert.equal(await page.evaluate(() => S.tasks.length), n0, 'nothing created before saving');
  await page.fill('#f_title', 'Nový úkol cíle'); await page.selectOption('#f_ms', 'mA2'); await page.click('#f_save'); await settle(page);
  const t = await page.evaluate(() => S.tasks[S.tasks.length - 1]);
  assert.deepEqual([t.title, t.goalId, t.category, t.milestoneId, t.done], ['Nový úkol cíle', 'gA', 'Fitness', 'mA2', false]);
  assert.equal(await page.evaluate(() => view), 'goalDetail');
  assert.match(await page.locator('.gp-ms[data-ms="mA2"]').innerText(), /Nový úkol cíle/);
  assert.equal(await xpOf(page), xp0);
  // from a milestone: "+ Úkol" preselects the milestone too
  await page.evaluate(() => { S.tasks = S.tasks.filter(t => t.milestoneId !== 'mA2'); render(); });
  await page.locator('.gp-ms[data-ms="mA2"] .gpMsTask').click();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#f_goal').value, document.querySelector('#f_ms').value]), ['gA', 'mA2']);
}, { state: fixtureState() });

test('GP10 Task <-> Goal both ways: the task row links its goal, the goal lists and opens its task', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'tasks', { taskFilter: 'All' });
  await page.evaluate(() => { taskFilter = 'All'; render(); });
  await page.locator('.task-item', { hasText: 'Boty' }).locator('.linkGoal').click();
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gA']);
  await page.locator('#ltList .task-item', { hasText: 'Boty' }).locator('.editBtn').click();
  assert.equal(await page.locator('.sheet #f_goal').inputValue(), 'gA');
  assert.equal(await page.locator('.sheet #f_title').inputValue(), 'Boty');
}, { state: fixtureState() });

test('GP11 Habit -> Goal: only habits really linked to the goal are shown (today state, streak) and counted in the week', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.deepEqual(await page.$$eval('#lhList .habit-item .item-title', ns => ns.map(n => n.textContent.trim())), ['Běhání']);
  assert.match(await page.locator('#lhList').innerText(), /2 dní v řadě|dní v řadě/);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gB' });
  assert.equal(await page.locator('#gpHabits').count(), 0, 'no linked habit -> no section, nothing invented');
}, { state: fixtureState() });

test('GP12 planning conflicts: overlapping blocks listed with both titles, times and date; nothing is moved', async ({ page }) => {
  await gpSeed(page);
  const before = await page.evaluate(() => JSON.stringify(S.plannerBlocks));
  const c = await page.evaluate(() => gpConflicts(todayStr(), addDays(todayStr(), 30)).map(x => [x.date, x.a.id, x.b.id]));
  assert.deepEqual(c, [['2026-09-25', 'pA3', 'pX']]);
  const touching = await page.evaluate(() => { S.plannerBlocks.push({ id: 'pTouch', date: addDays(todayStr(), 2), startTime: '19:30', endTime: '20:00', title: 't' }); const n = gpConflicts(todayStr(), addDays(todayStr(), 30)).length; S.plannerBlocks = S.plannerBlocks.filter(b => b.id !== 'pTouch'); return n; });
  assert.equal(touching, 1, 'a block starting when another ends is not a conflict');
  await gpGo(page, 'goals', { goalFilter: 'Active' });
  assert.match(await page.locator('#gpConflicts').innerText(), /25\.09\.2026[\s\S]*Intervaly\s*18:00–19:00[\s\S]*Schůzka\s*18:30–19:30/);
  assert.equal(await page.evaluate(() => JSON.stringify(S.plannerBlocks)), before);
  await page.locator('#gpConflicts .gp-conf-b[data-block="pX"]').click();
  assert.equal(await page.locator('.sheet #pb_title').inputValue(), 'Schůzka', 'opens the existing block');
}, { state: fixtureState() });

test('GP13 goal filters: Vše / Aktivní / Dokončené / Po termínu / Bez dalšího kroku', async ({ page }) => {
  await gpSeed(page);
  const r = {};
  for (const f of ['All', 'Active', 'Completed', 'Overdue', 'NoNext']) { await gpGo(page, 'goals', { goalFilter: 'Active' }); await page.click(`#gf [data-f="${f}"]`);
    r[f] = await page.$$eval('.goal-card', ns => ns.map(n => n.dataset.goal)); assert.equal(await page.evaluate(() => document.activeElement.dataset.f), f, 'focus stays on the filter'); }
  assert.deepEqual(r, { All: ['gC', 'gA', 'gB', 'gD', 'gE'], Active: ['gC', 'gA', 'gB'], Completed: ['gD'], Overdue: ['gC'], NoNext: ['gC'] });
  await page.evaluate(() => { goalFilter = 'Paused'; view = 'goals'; render(); });
  assert.equal(await page.evaluate(() => goalFilter), 'All', 'an old filter value falls back safely');
}, { state: fixtureState() });

test('GP14 search finds goal, milestone, task and planner block and opens the right place', async ({ page }) => {
  await gpSeed(page);
  const g = await page.evaluate(() => Object.fromEntries(['Maraton', 'Půlmaraton', 'Strečink', 'Intervaly'].map(q => [q, searchGroups(q.toLowerCase()).filter(x => x[3].length).map(x => x[2])])));
  assert.deepEqual(g, { Maraton: ['goal', 'milestone'], 'Půlmaraton': ['milestone'], 'Strečink': ['task'], Intervaly: ['plannerBlock'] });
  await page.evaluate(() => searchNavigate('milestone', S.milestones.find(m => m.id === 'mA1')));
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId, document.querySelector('.sheet #ms_title').value]), ['goalDetail', 'gA', 'Půlmaraton']);
}, { state: fixtureState() });

test('GP15 Command Center integration: its goal cards show the Goal system next step; its own priority engine and reasons are reused, not duplicated', async ({ page }) => {
  await gpSeed(page);
  const r = await page.evaluate(() => { const ctx = ccContext(); return S.goals.filter(g => g.status === 'Active').map(g => { const a = ccGoalNextSteps(g, ctx).next, b = gpNextStep(g); return [g.id, a && a.k, a && a.title, b && b.k, b && b.title]; }); });
  for (const [id, ak, at, bk, bt] of r) assert.deepEqual([ak, at], [bk, bt], id);
  await gpGo(page, 'home');
  assert.match(await page.locator('#ccGoals .cc-goal[data-goal="gA"]').innerText(), /Úkol: Běh 10 km/);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gC' });
  assert.match(await page.locator('#gpNext .gp-why').innerText(), /Proč je tento projekt dnes relevantní[\s\S]*Termín projektu minul před 3 d/i, 'the Command Center reason for the goal');
  const same = await page.evaluate(() => { const c = ccCandidates(ccContext()).find(x => x.kind === 'goal' && x.id === 'gC'); return JSON.stringify(c.reasons) === JSON.stringify(gpRelevance(S.goals.find(g => g.id === 'gC')).filter(x => x.src === 'cc').map(({ src, ...x }) => x)); });
  assert.ok(same);
}, { state: fixtureState() });

test('GP16 Analytics integration: goal tasks completed in the period, milestones and deadlines - read-only, from the existing records', async ({ page }) => {
  await gpSeed(page);
  const m = await page.evaluate(() => { const t = getGoalTrend(getAnalyticsRange('week')); return [t.metrics.tasks.current, t.metrics.milestones.current, t.deadline.overdue, t.active]; });
  assert.deepEqual(m, [1, 1, 1, 3]);
  const before = await gpState(page);
  await page.evaluate(() => { statsPeriod = 'week'; view = 'statistics'; render(); });
  assert.match(await page.locator('#anGoals').innerText(), /Úkoly projektů dokončené v období\s*1/i);
  assert.equal(await gpState(page), before);
}, { state: fixtureState() });

test('GP17 goal timeline: creation, milestones, task completion records, done blocks and closing - chronological, only recorded events', async ({ page }) => {
  await gpSeed(page);
  const t = await page.evaluate(() => gpTimeline(S.goals[0]).map(e => [e.d, e.k, e.title]));
  assert.deepEqual(t, [['2026-08-24', 'goal_created', 'Maraton'], ['2026-09-03', 'ms_created', 'Půlmaraton'], ['2026-09-08', 'ms_created', '10 km'], ['2026-09-13', 'ms_created', '30 km'],
    ['2026-09-18', 'ms_done', '10 km'], ['2026-09-22', 'task_done', 'Běh 15 km'], ['2026-09-23', 'block_done', 'Ranní běh']]);
  assert.deepEqual(await page.evaluate(() => gpTimeline(S.goals.find(g => g.id === 'gD')).map(e => e.k)), ['goal_created', 'goal_done']);
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.deepEqual(await page.$$eval('#gpTimeline time', ns => ns.map(n => n.getAttribute('datetime'))), t.map(x => x[0]));
  assert.match(await page.locator('#gpTimeline').innerText(), /Změny progressu v čase se neukládají/);
}, { state: fixtureState() });

test('GP18 weekly review: tasks done, planned time, milestones, goals with and without activity - facts only', async ({ page }) => {
  await gpSeed(page);
  const r = await page.evaluate(() => { const x = gpWeekReview(); return [x.tasksDone, x.goalTasksDone, x.planned, x.blocks, x.msDone, x.active, x.idle]; });
  assert.deepEqual(r, [1, 1, 270, 4, 0, ['gA'], ['gB', 'gC']]);
  const c = await page.evaluate(() => { const x = gpCapacity(); return [x.count, x.min, x.byGoal, x.byCat]; });
  assert.deepEqual(c, [4, 270, [{ k: 'gA', min: 210 }, { k: '', min: 60 }], [{ k: 'Fitness', min: 210 }, { k: 'Work', min: 60 }]]);
  await gpGo(page, 'goals', { goalFilter: 'Active' });
  const t = await page.locator('#gpReview').innerText();
  assert.match(t, /Dokončené úkoly\s*1 \(z toho u projektů 1\)[\s\S]*Naplánovaný čas\s*4 h 30 min · 4 bloky[\s\S]*Projekty s aktivitou\s*1[\s\S]*Maraton[\s\S]*Projekty bez aktivity\s*2[\s\S]*Kniha, Stará/);
  assert.match(await page.locator('#gpCapacity').innerText(), /volný čas aplikace nezná/);
}, { state: fixtureState() });

test('GP19 a goal at 100 %: "Dokončeno" + close through the existing completeGoal (200 XP once), status Completed, kept in history', async ({ page }) => {
  await gpSeed(page);
  await page.evaluate(() => { S.tasks.filter(t => t.goalId === 'gA').forEach(t => { t.done = true; }); });
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' });
  assert.equal(await page.locator('.gp-head [data-goal-state="ready"]').count(), 1);
  assert.equal(await page.locator('[data-goal-ready]').count(), 1);
  const x0 = await xpOf(page);
  await page.click('.doneBtn');
  assert.equal(await xpOf(page) - x0, 200);
  assert.equal(await page.evaluate(() => S.goals[0].status), 'Completed');
  assert.match(await page.locator('.gp-head').innerText(), /Dokončeno/);
  assert.equal(await page.locator('#gpNext').count(), 0, 'no next step on a closed goal');
  assert.deepEqual(await page.evaluate(() => gpTimeline(S.goals[0]).slice(-1)[0].k), 'goal_done');
}, { state: fixtureState() });

test('GP20 XP anti-farming unchanged: completed-on-create, twice, reopen, delete + recreate, milestone toggles, many completions a day', async ({ page }) => {
  await gpSeed(page);
  const r = await page.evaluate(() => { const x0 = S.totalXp, out = {};
    // entered as already Completed through the goal form -> a record of the past, no reward
    openGoalForm(); document.querySelector('#g_title').value = 'Hotovo předem'; document.querySelector('#g_status').value = 'Completed'; document.querySelector('#g_save').click();
    out.created = S.totalXp - x0;
    const g = S.goals.find(x => x.id === 'gB'); completeGoal(g); const a = S.totalXp; completeGoal(g); g.status = 'Active'; completeGoal(g); out.twice = [a - x0, S.totalXp - a];
    // delete + recreate with the same title: a new id; the daily goal limit still holds
    const t0 = S.totalXp; S.goals = S.goals.filter(x => x.id !== 'gB'); const ng = { id: 'gB2', title: 'Kniha', status: 'Active', mode: 'manual', manualProgress: 100, createdAt: Date.now() }; S.goals.push(ng); completeGoal(ng); out.recreate = S.totalXp - t0;
    const t1 = S.totalXp; const more = ['m1', 'm2'].map(id => ({ id, title: id, status: 'Active', mode: 'manual', manualProgress: 100, createdAt: Date.now() })); S.goals.push(...more); more.forEach(completeGoal); out.limit = S.totalXp - t1;
    // milestone XP once
    const m = S.milestones.find(x => x.id === 'mA2'), t2 = S.totalXp; toggleMilestone(m); toggleMilestone(m); toggleMilestone(m); out.ms = S.totalXp - t2;
    const done3 = S.milestones.find(x => x.id === 'mA3'), t3 = S.totalXp; toggleMilestone(done3); toggleMilestone(done3); out.msOld = S.totalXp - t3;
    return out; });
  assert.equal(r.created, 0, 'a goal created as Completed pays nothing');
  assert.deepEqual(r.twice, [200, 0], 'completing twice / reopen + complete pays once');
  assert.equal(r.recreate + r.limit, 200, 'at most XP_DAILY_LIMIT.goal (2) goal rewards a day, also for recreated goals');
  assert.equal(r.ms, 25, 'milestone XP once'); assert.equal(r.msOld, 0, 'an already rewarded milestone never pays again');
}, { state: fixtureState() });

test('GP21 legacy goals (no createdAt / targetDate / milestone deadlines / task.milestoneId) read cleanly, pace "not computable", nothing written', async ({ page }) => {
  await page.evaluate(() => { const legacy = { goals: [{ id: 'lg1', title: 'Starý projekt', status: 'Active', manualProgress: 20 }, { id: 'lg2', title: 'Hotový starý', status: 'Completed' }],
      milestones: [{ id: 'lm', goalId: 'lg1', title: 'Starý milník', completed: false }], tasks: [{ id: 'lt', title: 'Starý úkol', goalId: 'lg1', done: false, createdAt: 1, milestoneId: 'deleted-ms' }],
      xpLog: [], totalXp: 0, schemaVersion: 4 }; S = migrate(legacy); S.settings.onboarded = true; view = 'home'; render(); });
  assert.equal(await page.evaluate(() => S.schemaVersion), 8);
  const before = await gpState(page);
  for (const f of GP_FILTERS_T) { await gpGo(page, 'goals', { goalFilter: f }); assert.deepEqual(await gpClean(page), { bad: false, dup: [], overflow: 0 }, f); }
  await gpGo(page, 'goalDetail', { currentGoalId: 'lg1' });
  assert.deepEqual(await gpClean(page), { bad: false, dup: [], overflow: 0 });
  assert.match(await page.locator('#gpPace').innerText(), /Tempo nelze vypočítat/);
  assert.match(await page.locator('#ltList').innerText(), /Starý úkol/, 'a task pointing to a missing milestone is listed without one');
  assert.match(await page.locator('#gpNext').innerText(), /Úkol: Starý úkol/);
  await gpGo(page, 'goalDetail', { currentGoalId: 'lg2' });
  assert.equal(await gpState(page), before, 'reading legacy goals writes nothing');
}, { state: fixtureState() });

test('GP22 export / import: the new optional fields travel inside the same backup format; an old backup without them imports unchanged', async ({ page }) => {
  await gpSeed(page); await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(exported, await stateOf(page), 'export equals state');
  assert.equal(exported.milestones.find(m => m.id === 'mA1').targetDate, '2026-09-21'); assert.equal(exported.tasks.find(t => t.id === 'tA1').milestoneId, 'mA1');
  await page.evaluate(() => { S.goals = []; S.milestones = []; S.tasks = []; }); await importFile(page, await dl.path()); await settle(page);
  assert.deepEqual(await stateOf(page), exported, 'import restores everything, the optional fields included');
  const old = JSON.parse(JSON.stringify(exported)); old.milestones.forEach(m => delete m.targetDate); old.tasks.forEach(t => delete t.milestoneId);
  const f = path.join(path.dirname(await dl.path()), 'old-backup.json'); writeFileSync(f, JSON.stringify(old));
  await page.click('#settingsBtn'); await importFile(page, f); await settle(page);
  const s = await stateOf(page);
  assert.ok(s.milestones.every(m => !('targetDate' in m)) && s.tasks.every(t => !('milestoneId' in t)), 'no field is added to old data');
  await gpGo(page, 'goalDetail', { currentGoalId: 'gA' }); assert.deepEqual(await gpClean(page), { bad: false, dup: [], overflow: 0 });
}, { state: fixtureState() });

test('GP23 no write side effects: opening Goals (every filter), a goal detail, roadmap, timeline, pace and week changes no data and pays no XP', async ({ page }) => {
  await page.evaluate(() => { view = 'home'; render(); }); await persist(page);
  const before = await gpState(page), idb0 = await idbState(page), xp0 = await xpOf(page);
  for (const f of GP_FILTERS_T) await gpGo(page, 'goals', { goalFilter: f });
  for (const id of await page.evaluate(() => S.goals.map(g => g.id))) { await gpGo(page, 'goalDetail', { currentGoalId: id }); await page.evaluate(() => { gpTimeline(S.goals[0]); gpWeek(S.goals[0]); gpPace(S.goals[0]); gpWeekReview(); gpConflicts(todayStr(), addDays(todayStr(), 30)); }); }
  await settle(page);
  assert.equal(await gpState(page), before, 'fixture: state unchanged'); assert.deepEqual(await idbState(page), idb0); assert.equal(await xpOf(page), xp0);
  await gpSeed(page); await persist(page);
  const b2 = await gpState(page), idb2 = await idbState(page);
  for (const id of ['gA', 'gB', 'gC', 'gD', 'gE']) { await gpGo(page, 'goalDetail', { currentGoalId: id }); if (await page.locator('.an-table summary, details summary').count()) await page.locator('details summary').first().click(); }
  for (const f of GP_FILTERS_T) await gpGo(page, 'goals', { goalFilter: f });
  await settle(page);
  assert.equal(await gpState(page), b2, 'seeded: state unchanged'); assert.deepEqual(await idbState(page), idb2, 'nothing saved');
}, { state: fixtureState() });

test('GP24 performance: 1 500 tasks, 25 000 XP, 40 habits, 25 goals with milestones, 400 planner blocks - overview and detail', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3)); const T = todayStr();
    for (let i = 0; i < 25; i++) S.goals.push({ id: 'pg' + i, title: 'Projekt ' + i, category: ['Work', 'Fitness', ''][i % 3], status: i % 5 ? 'Active' : 'Completed', targetDate: i % 4 ? addDays(T, i * 7 - 30) : '', mode: 'auto', createdAt: new Date(addDays(T, -200) + 'T10:00').getTime() });
    for (let i = 0; i < 100; i++) S.milestones.push({ id: 'pm' + i, goalId: 'pg' + (i % 25), title: 'M' + i, targetDate: i % 2 ? addDays(T, i - 50) : undefined, completed: i % 3 === 0, completedAt: i % 3 === 0 ? Date.now() - i * 86400000 : null, createdAt: Date.now() - 200 * 86400000 });
    S.tasks.forEach((t, i) => { if (i % 5 === 0) { t.goalId = 'pg' + (i % 25); if (i % 10 === 0) t.milestoneId = 'pm' + (i % 100); } });
    for (let i = 0; i < 40; i++) S.habits.push({ id: 'ph' + i, name: 'Rutina ' + i, type: 'good', frequency: 'daily', target: 1, goalId: i % 3 ? '' : 'pg' + (i % 25), completions: Array.from({ length: 200 }, (_, k) => addDays(T, -k)), active: true, createdAt: 1 });
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, (i % 60) - 30), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':30', title: 'Blok ' + i, category: '', taskId: i % 3 ? '' : 'rt' + (i * 5), goalId: i % 4 ? '' : 'pg' + (i % 25), completed: i % 2 === 0 });
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    const out = { overview: m(() => { goalFilter = 'All'; view = 'goals'; render(); }, 5), overviewActive: m(() => { goalFilter = 'Active'; view = 'goals'; render(); }, 5), detail: m(() => { currentGoalId = 'pg1'; view = 'goalDetail'; render(); }, 5),
      helpers: m(() => { const ix = gpIndex(); S.goals.forEach(g => { gpNextStep(g, ix); gpPace(g); }); gpWeekReview(ix); gpConflicts(T, addDays(T, 30)); }, 5), bad: /undefined|NaN/.test(document.getElementById('app').innerText) };
    return out; });
  console.log('      GP24 ' + Object.entries(r).filter(([k]) => k !== 'bad').map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  assert.ok(!r.bad);
  assert.ok(r.overview < 80 && r.overviewActive < 80 && r.detail < 80, 'fast (target < 50 ms each)');
}, { state: fixtureState() });

test('GP25 320-1440 px: overview and detail - no overflow, full-width cards, vertical roadmap and timeline on phones, 44 px targets', async ({ page }) => {
  await gpSeed(page);
  const bad = [];
  for (const w of [320, 390, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [v, extra] of [['goals', { goalFilter: 'All' }], ['goals', { goalFilter: 'Active' }], ['goalDetail', { currentGoalId: 'gA' }], ['goalDetail', { currentGoalId: 'gC' }]]) {
      await gpGo(page, v, extra);
      const c = await gpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/${v}: ${JSON.stringify(c)}`);
      const small = await page.$$eval('.gp button, .gp-detail button:not(.check):not(.delbtn):not(.iconbtn), .gp-detail summary', ns => ns.filter(n => n.offsetParent && !n.closest('.task-item,.habit-item')).map(n => [n.className || n.id, n.getBoundingClientRect()]).filter(([, r]) => r.height < 44).map(([c, r]) => `${c} ${Math.round(r.width)}x${Math.round(r.height)}`));
      if (small.length) bad.push(`${w}/${v} small: ${small.slice(0, 4).join(', ')}`);
      if (w <= 390 && v === 'goalDetail') { const col = await page.evaluate(() => { const ns = [...document.querySelectorAll('.gp-road > li')].map(n => n.getBoundingClientRect().left); return new Set(ns.map(Math.round)).size; }); if (col !== 1) bad.push(`${w}: roadmap not vertical`); }
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('GP26 light + dark: WCAG AA text contrast on Goals and a goal detail; SVG icons, no emoji as UI icons', async ({ page }) => {
  await gpSeed(page);
  const bad = [];
  for (const theme of ['light', 'dark']) for (const [v, extra] of [['goals', { goalFilter: 'All' }], ['goals', { goalFilter: 'Active' }], ['goalDetail', { currentGoalId: 'gA' }], ['goalDetail', { currentGoalId: 'gC' }]]) {
    await gpGo(page, v, extra);
    const r = await page.evaluate(theme => { S.settings.theme = theme; applyTheme(); render();
      const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
      const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (/gradient/.test(cs.backgroundImage) && e.matches('.btn:not(.ghost):not(.danger)')) return { r: 110, g: 80, b: 240, a: 1 }; const c = parse(cs.backgroundColor); if (c && c.a > 0) { st.push(c); if (c.a >= 1) break; } } let bg = parse(getComputedStyle(document.body).backgroundColor); for (let i = st.length - 1; i >= 0; i--) bg = blend(st[i], bg); return bg; };
      const out = [];
      document.querySelectorAll('.gp *, .gp-detail *').forEach(e => { if (e.closest('.task-item,.habit-item,.hud')) return; if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return; const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[aria-hidden="true"],.hide,[hidden]')) return; const fg0 = parse(cs.color); if (!fg0) return; const bg = bgOf(e), fg = blend(fg0, bg);
        const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05), size = parseFloat(cs.fontSize), need = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5;
        if (ratio < need) out.push(`${theme}: "${e.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`); });
      [...document.querySelectorAll('.gp h3, .gp-detail h3, .gp .kicker, .gp-detail .kicker, .gp-actions button, #gf button')].forEach(n => { if (/\p{Extended_Pictographic}/u.test(n.textContent)) out.push(`${theme} emoji: ${n.textContent.trim().slice(0, 20)}`); });
      return out; }, theme);
    bad.push(...r.map(x => `${v}/${JSON.stringify(extra)}: ${x}`));
  }
  assert.deepEqual([...new Set(bad)], []);
}, { state: fixtureState() });

test('GP27 accessibility: tabs, named sections, progress values, timeline as a list with dates, named controls, keyboard to the detail, focus kept', async ({ page }) => {
  await gpSeed(page); await gpGo(page, 'goals', { goalFilter: 'Active' });
  const o = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('#gf [role="tab"]')].length, secs: [...document.querySelectorAll('.gp section[aria-labelledby]')].filter(s => !document.getElementById(s.getAttribute('aria-labelledby'))).length,
    bars: [...document.querySelectorAll('.gp [role="progressbar"]')].filter(b => !(+b.getAttribute('aria-valuenow') >= 0 && b.getAttribute('aria-label'))).length,
    unnamed: [...document.querySelectorAll('.gp button, .gp [role="button"]')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).length }));
  assert.deepEqual(o, { tabs: 5, secs: 0, bars: 0, unnamed: 0 });
  await page.focus('.goal-card[data-goal="gA"] .goal-top'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gA']);
  const d = await page.evaluate(() => ({ secs: [...document.querySelectorAll('.gp-detail section[aria-labelledby]')].filter(s => !document.getElementById(s.getAttribute('aria-labelledby'))).length, n: document.querySelectorAll('.gp-detail section[aria-labelledby]').length,
    tl: document.querySelector('#gpTimeline ol.gp-tl') && [...document.querySelectorAll('#gpTimeline li time[datetime]')].length, road: document.querySelector('#gpRoadmap ol.gp-road') ? 1 : 0,
    bars: [...document.querySelectorAll('.gp-detail [role="progressbar"]')].filter(b => !(+b.getAttribute('aria-valuenow') >= 0 && b.getAttribute('aria-label'))).length,
    unnamed: [...document.querySelectorAll('.gp-detail button')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).length }));
  assert.equal(d.secs, 0); assert.ok(d.n >= 5); assert.ok(d.tl >= 5); assert.equal(d.road, 1); assert.equal(d.bars, 0); assert.equal(d.unnamed, 0);
}, { state: fixtureState() });

test('GP28 reduced motion: nothing in Goals or a goal detail animates', async ({ page }) => {
  await gpSeed(page);
  for (const [v, extra] of [['goals', { goalFilter: 'All' }], ['goalDetail', { currentGoalId: 'gA' }]]) {
    await gpGo(page, v, extra);
    const moving = await page.evaluate(() => [...document.querySelectorAll('.gp, .gp *, .gp-detail, .gp-detail *')].filter(n => { const cs = getComputedStyle(n); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 || parseFloat(cs.transitionDuration) > 0.01; }).map(n => n.className));
    assert.deepEqual(moving, [], v);
  }
}, { state: fixtureState() });

test('GP29 + GP30 no duplicate ids, no NaN / undefined in every filter and every goal detail - fixture, seeded, empty and a year of data', async ({ page }) => {
  const bad = [];
  const sweep = async name => { for (const f of GP_FILTERS_T) { await gpGo(page, 'goals', { goalFilter: f }); const c = await gpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${name}/${f}: ${JSON.stringify(c)}`); }
    for (const id of await page.evaluate(() => S.goals.map(g => g.id))) { await gpGo(page, 'goalDetail', { currentGoalId: id }); const c = await gpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${name}/${id}: ${JSON.stringify(c)}`); } };
  await sweep('fixture');
  await gpSeed(page); await sweep('seed');
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; }); await sweep('empty');
  await withGen(page); await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; Object.assign(S, window.__gen(300, 4000, 7)); S.goals = [{ id: 'y1', title: 'Rok', status: 'Active', targetDate: addDays(todayStr(), 20), mode: 'auto', createdAt: Date.now() - 100 * 86400000 }]; S.tasks.forEach((t, i) => { if (i % 7 === 0) t.goalId = 'y1'; }); });
  await sweep('year');
  assert.deepEqual(bad, []);
}, { state: fixtureState() });
const GP_FILTERS_T = ['All', 'Active', 'Completed', 'Overdue', 'NoNext'];

// ---------- Weekly Life Planner 3.0 ----------
// One read-only view of a week over the existing records (planner blocks, task due dates + completion records, events
// with their recurring occurrences, workouts, habits, goals, milestones). Changes happen only through the existing
// planner/task forms, "Přesunout" (plannerSaveBlock) and the explicit "Priorita týdne" toggle (S.weeklyPriorities).
const wpGo = (page, offset, extra) => page.evaluate(([o, extra]) => { closeSheets(); wpOffset = o || 0; wpFocusGoal = null; Object.assign(window, extra || {}); view = 'week'; render(); }, [offset || 0, extra || null]);
const wpClean = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|Infinity|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
const wpState = page => page.evaluate(() => JSON.stringify(S));
// fixture day 2026-09-23 (Wednesday) 12:00; this week 21..27, previous 14..20, next 28..4.10
const wpSeed = page => page.evaluate(() => {
  const T = todayStr(), D = n => addDays(T, n), ts = (d, h, m) => new Date(d + 'T' + String(h == null ? 12 : h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0')).getTime();
  S = defaultState(); S.settings.onboarded = true; S.settings.trainingDays = [1, 3, 5];
  S.goals = [
    { id: 'gW1', title: 'Web', category: 'Work', targetDate: D(10), status: 'Active', mode: 'auto', createdAt: ts(D(-20)) },
    { id: 'gW2', title: 'Běh', category: 'Fitness', targetDate: D(40), status: 'Active', mode: 'manual', manualProgress: 30, createdAt: ts(D(-20)) },
    { id: 'gW3', title: 'Jazyk', category: 'Learning', targetDate: '', status: 'Active', mode: 'manual', manualProgress: 10, createdAt: ts(D(-20)) },
    { id: 'gW4', title: 'Kniha', category: '', targetDate: D(3), status: 'Active', mode: 'manual', manualProgress: 80, createdAt: ts(D(-20)) },
    { id: 'gDone', title: 'Hotovo', category: '', targetDate: D(-1), status: 'Completed', mode: 'manual', manualProgress: 100, createdAt: ts(D(-60)) }];
  S.milestones = [{ id: 'mW1', goalId: 'gW1', title: 'Beta', targetDate: D(2), completed: false, completedAt: null, createdAt: ts(D(-10)) },
    { id: 'mW2', goalId: 'gW1', title: 'Alfa', completed: true, completedAt: ts(D(-1)), createdAt: ts(D(-15)) }];
  S.tasks = [
    { id: 'tW1', title: 'Návrh', priority: 'High', category: 'Work', goalId: 'gW1', dueDate: D(1), done: false, createdAt: ts(D(-5)) },
    { id: 'tW2', title: 'Kód', priority: 'Medium', category: 'Work', goalId: 'gW1', dueDate: D(-1), done: true, createdAt: ts(D(-5)) },
    { id: 'tW3', title: 'Test', priority: 'Low', category: 'Work', goalId: 'gW1', dueDate: D(2), done: false, createdAt: ts(D(-5)) },
    { id: 'tW4', title: 'Nákup', priority: 'Medium', category: 'Personal', goalId: '', dueDate: D(0), done: false, createdAt: ts(D(-2)) },
    { id: 'tW5', title: 'Starý', priority: 'Urgent', category: 'Work', goalId: '', dueDate: D(-5), done: false, createdAt: ts(D(-9)) },
    { id: 'tW6', title: 'Budoucí', priority: 'Low', category: '', goalId: '', dueDate: D(10), done: false, createdAt: ts(D(-2)) },
    { id: 'tW7', title: 'Bez data', priority: 'Low', category: '', goalId: 'gW3', dueDate: '', done: false, createdAt: ts(D(-2)) },
    { id: 'tW8', title: 'Minule', priority: 'Low', category: '', goalId: '', dueDate: D(-8), done: true, createdAt: ts(D(-12)) }];
  const B = (id, date, s, e, extra) => ({ id, date, startTime: s, endTime: e, title: id, description: '', category: '', taskId: '', goalId: '', workoutId: '', notes: '', workoutTemplateId: '', completed: false, createdAt: 1, updatedAt: 1, ...extra });
  S.plannerBlocks = [B('pW1', D(1), '09:00', '11:00', { title: 'Návrh', taskId: 'tW1', category: 'Work' }), B('pW2', D(0), '06:00', '07:00', { title: 'Ranní běh', goalId: 'gW2', category: 'Fitness', completed: true }),
    B('pW3', D(0), '18:00', '19:30', { title: 'Intervaly', goalId: 'gW2', category: 'Fitness' }), B('pW4', D(2), '10:00', '11:00', { title: 'Zubař', category: 'Personal' }),
    B('pW5', D(2), '10:30', '12:00', { title: 'Sprint', goalId: 'gW1', category: 'Work' }), B('pW6', D(-2), '08:00', '09:00', { title: 'Pondělní', category: 'Work' }),
    B('pW7', D(-1), '17:30', '18:30', { title: 'Běh venku', goalId: 'gW2', category: 'Fitness', completed: true }),
    B('pPrev', D(-7), '08:00', '10:00', { title: 'Minulý týden', category: 'Work' }), B('pNext', D(7), '08:00', '09:00', { title: 'Příští týden', category: 'Work' })];
  S.events = [{ id: 'eW1', title: 'Porada', date: D(2), start: '11:30', end: '12:30', recurring: 'none' }, { id: 'eW2', title: 'Trénink tým', date: D(-14), start: '18:00', end: '19:00', recurring: 'weekly' },
    { id: 'eAll', title: 'Svátek', date: D(3), start: '', end: '', recurring: 'none' }];
  S.workouts = [{ id: 'wW1', name: 'Push', date: D(-1), status: 'done', startedAt: ts(D(-1), 17), finishedAt: ts(D(-1), 18), duration: '60', entries: [] },
    { id: 'wOld', name: 'Staré', date: D(-9), exercises: [{ id: 'x', name: 'Dřep', sets: 3, reps: 5, weight: 80 }] }];
  S.habits = [{ id: 'hW', name: 'Voda', type: 'good', frequency: 'daily', target: 1, completions: [D(0), D(-1), D(-2)], active: true, startDate: D(-30), createdAt: ts(D(-30)) },
    { id: 'hWk', name: 'Plavání', type: 'good', frequency: 'weekly', target: 2, completions: [D(-1)], active: true, startDate: D(-30), createdAt: ts(D(-30)) },
    { id: 'hDay', name: 'Čtení', type: 'good', frequency: 'weekdays', weekdays: [1, 3, 5], target: 1, completions: [D(0)], active: true, startDate: D(-30), createdAt: ts(D(-30)) },
    { id: 'hBad', name: 'Kouření', type: 'bad', frequency: 'daily', target: 1, completions: [D(0)], brokenDates: [], active: true, startDate: D(-30), createdAt: ts(D(-30)) }];
  S.xpLog = [{ id: 'x1', amount: 30, reason: 'Task: Kód', ts: ts(D(-1)), key: `task:tW2:${D(-1)}` }, { id: 'x2', amount: 20, reason: 'Task: Minule', ts: ts(D(-8)), key: `task:tW8:${D(-8)}` },
    { id: 'x3', amount: 200, reason: 'Goal: Hotovo', ts: ts(D(-1)), key: 'goal:gDone:complete' }, { id: 'x4', amount: 80, reason: 'Workout: Push', ts: ts(D(-1), 18), key: `workout:wW1:${D(-1)}` }];
  S.totalXp = 330; S.dailyScoresSince = T; S.achievementsUnlocked = ACHV.map(a => a.id);
  S = migrate(JSON.parse(JSON.stringify(S)));
  ['daily', 'weekly'].forEach(p => questBoardFor(p).forEach(({ q }) => { const k = questKey(q.id, p); if (!S.quests.some(x => x.key === k)) S.quests.push({ key: k, questId: q.id, date: todayStr(), period: p }); }));
  view = 'home'; render();
});
const wpDays = page => page.$$eval('#wpDays .wp-day', ns => ns.map(n => n.dataset.day));

test('WP1 Week Overview: 7 days Po..Ne, each with planned time, blocks, tasks, events, workouts and habits; reachable from More', async ({ page }) => {
  await wpSeed(page);
  await page.evaluate(() => { view = 'more'; render(); }); await page.click('#moreGrid [data-v="week"]');
  assert.equal(await page.evaluate(() => view), 'week');
  assert.deepEqual(await wpDays(page), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
  assert.match(await page.locator('#wpDays .wp-day').first().innerText(), /^Pondělí 21\. 9\./);
  assert.match(await page.locator('#wpDays .wp-day').last().innerText(), /^Neděle 27\. 9\./);
  const wed = await page.locator('.wp-day[data-day="2026-09-23"]').innerText();
  assert.match(wed, /Středa 23\. 9\.[\s\S]*Dnes[\s\S]*Naplánováno: 2 h 30 min[\s\S]*06:00–07:00[\s\S]*Ranní běh[\s\S]*18:00–19:00[\s\S]*Trénink tým[\s\S]*18:00–19:30[\s\S]*Intervaly[\s\S]*Nákup[\s\S]*Čtení[\s\S]*Voda/);
  assert.equal(await page.locator('.wp-day[data-day="2026-09-23"] article[aria-labelledby="wpd-2026-09-23"] h3#wpd-2026-09-23').count(), 1);
  assert.deepEqual(await wpClean(page), { bad: false, dup: [], overflow: 0 });
}, { state: fixtureState() });

test('WP2 current week is the default: Monday..Sunday around today, "Tento týden"', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  assert.equal(await page.locator('.wp').getAttribute('data-week'), '2026-09-21');
  assert.match(await page.locator('.page-head').innerText(), /Tento týden[\s\S]*21\.09\.2026 – 27\.09\.2026/);
  assert.equal(await page.locator('#wpToday').getAttribute('aria-current'), 'true');
  assert.deepEqual(await page.evaluate(() => { const r = wpRange(0); return [r.from, r.to, r.days.length, wpOffsetOf('2026-09-30'), wpOffsetOf('2026-09-13')]; }), ['2026-09-21', '2026-09-27', 7, 1, -2]);
}, { state: fixtureState() });

test('WP3 previous week: 14..20 with its own blocks, tasks, events and workouts', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0); await page.click('#wpPrev');
  assert.equal(await page.locator('.wp').getAttribute('data-week'), '2026-09-14');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wpPrev', 'focus kept');
  assert.match(await page.locator('.page-head').innerText(), /Týden Po 14\. 9\. – Ne 20\. 9\./);
  assert.match(await page.locator('.wp-day[data-day="2026-09-16"]').innerText(), /Naplánováno: 2 h[\s\S]*Minulý týden[\s\S]*Trénink tým/);
  assert.match(await page.locator('.wp-day[data-day="2026-09-15"]').innerText(), /Minule/);
  assert.match(await page.locator('.wp-day[data-day="2026-09-14"]').innerText(), /Staré[\s\S]*splněno/);
}, { state: fixtureState() });

test('WP4 next week: 28..4.10, the recurring event continues, only its own blocks', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0); await page.click('#wpNext');
  assert.equal(await page.locator('.wp').getAttribute('data-week'), '2026-09-28');
  assert.match(await page.locator('.wp-day[data-day="2026-09-30"]').innerText(), /Příští týden[\s\S]*Trénink tým/);
  assert.equal(await page.locator('.wp-block[data-block="pW1"]').count(), 0);
}, { state: fixtureState() });

test('WP5 "Dnes" returns to the current week', async ({ page }) => {
  await wpSeed(page); await wpGo(page, -3);
  assert.equal(await page.locator('.wp').getAttribute('data-week'), '2026-08-31');
  await page.click('#wpToday');
  assert.equal(await page.locator('.wp').getAttribute('data-week'), '2026-09-21');
  assert.equal(await page.locator('.wp-day.is-today').getAttribute('data-day'), '2026-09-23');
}, { state: fixtureState() });

test('WP6 week summary: blocks, planned time, tasks, completed tasks, goals, milestones, workouts, habits, events - facts', async ({ page }) => {
  await wpSeed(page);
  const s = await page.evaluate(() => { const x = wpSummary(wpWeek(0)); return [x.blocks, x.minutes, x.tasksDue, x.tasksDueDone, x.tasksDone, x.activeGoals, x.msDue, x.msDone, x.workouts, x.habitsDone, x.habitsExpected, x.events, x.conflicts, x.goalsDone, x.xp]; });
  assert.deepEqual(s, [7, 540, 4, 1, 1, 4, 1, 1, 1, 5, 6, 3, 4, 1, 310]);
  await wpGo(page, 0);
  assert.match(await page.locator('#wpSummary').innerText(), /Naplánováno\s*9 h[\s\S]*Bloky v plánovači\s*7[\s\S]*Úkoly s termínem\s*1\/4[\s\S]*Dokončené úkoly\s*1[\s\S]*Aktivní projekty\s*4[\s\S]*Tréninky\s*1[\s\S]*Rutiny\s*5 \/ 6[\s\S]*Události\s*3/);
  assert.doesNotMatch(await page.locator('#app').innerText(), /volný čas:|free time:|přetížen|overloaded|unhealthy|failed|špatn/i);
}, { state: fixtureState() });

test('WP7 daily capacity: planned time per day, by existing category and goal share; overlaps as a fact; no free time', async ({ page }) => {
  await wpSeed(page);
  const d = await page.evaluate(() => wpWeek(0).days.map(x => [x.date.slice(8), x.minutes, x.goalMinutes, x.byCategory.map(c => c.c + ':' + c.min).join(','), x.conflicts.length]));
  assert.deepEqual(d, [['21', 60, 0, 'Work:60', 0], ['22', 60, 60, 'Fitness:60', 1], ['23', 150, 150, 'Fitness:150', 1], ['24', 120, 120, 'Work:120', 0], ['25', 150, 90, 'Work:90,Personal:60', 2], ['26', 0, 0, '', 0], ['27', 0, 0, '', 0]]);
  await wpGo(page, 0);
  const fri = await page.locator('.wp-day[data-day="2026-09-25"]').innerText();
  assert.match(fri, /Naplánováno: 2 h 30 min · z toho u projektů 1 h 30 min[\s\S]*2 překryvy v plánu[\s\S]*Práce 1 h 30 min[\s\S]*Osobní 1 h/);
}, { state: fixtureState() });

test('WP8 goal capacity + goals of the week: progress, deadline, blocks, planned time, open / done tasks, next step, sorted by deadline', async ({ page }) => {
  await wpSeed(page);
  const g = await page.evaluate(() => wpGoals(wpWeek(0)).map(x => [x.g.id, x.blocks, x.minutes, x.openTasks, x.doneTasks, x.next && x.next.id]));
  assert.deepEqual(g, [['gW4', 0, 0, 0, 0, null], ['gW1', 2, 210, 2, 1, 'tW1'], ['gW2', 3, 210, 0, 0, 'pW3'], ['gW3', 0, 0, 1, 0, 'tW7']]);
  await wpGo(page, 0);
  assert.match(await page.locator('#wpGoals [data-goal="gW1"]').innerText(), /Web[\s\S]*03\.10\.2026[\s\S]*Naplánováno: 3 h 30 min[\s\S]*Bloky: 2[\s\S]*Otevřené úkoly: 2[\s\S]*Dokončeno tento týden: 1[\s\S]*Úkol: Návrh/);
}, { state: fixtureState() });

test('WP9 unplanned tasks: open, no block from today on, overdue / due this week / undated; with priority, deadline, goal, category', async ({ page }) => {
  await wpSeed(page);
  assert.deepEqual(await page.evaluate(() => wpUnplanned(wpWeek(0)).list.map(t => t.id)), ['tW5', 'tW4', 'tW3', 'tW7']);
  await wpGo(page, 0);
  assert.match(await page.locator('#wpUnplanned').innerText(), /Úkoly bez plánu · 4[\s\S]*Starý[\s\S]*Urgentní[\s\S]*18\.09\.2026[\s\S]*Práce[\s\S]*Test[\s\S]*Web/);
}, { state: fixtureState() });

test('WP10 task -> planner: "Naplánovat" opens the existing planner form prefilled (task, goal, category, title); nothing saved before the user saves; then the task is in the week', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  const before = await wpState(page);
  await page.click('#wpUnplanned [data-plan-task="tW3"]');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#pb_title').value, document.querySelector('#pb_date').value, document.querySelector('#pb_cat').value]), ['Test', '2026-09-25', 'Work']);
  assert.match(await page.locator('.sheet #pb_link').innerText(), /Test/);
  assert.equal(await wpState(page), before, 'nothing created yet');
  await page.fill('#pb_start', '14:00'); await page.fill('#pb_end', '15:00'); await page.click('#pb_save'); await settle(page);
  const b = await page.evaluate(() => S.plannerBlocks[S.plannerBlocks.length - 1]);
  assert.deepEqual([b.taskId, b.goalId, b.category, b.date, b.startTime], ['tW3', 'gW1', 'Work', '2026-09-25', '14:00']);
  assert.equal(await page.evaluate(() => view), 'week', 'stays on the week');
  assert.equal(await page.locator(`.wp-day[data-day="2026-09-25"] .wp-block[data-block="${b.id}"]`).count(), 1);
  assert.equal(await page.locator('#wpUnplanned [data-plan-task="tW3"]').count(), 0, 'no longer unplanned');
}, { state: fixtureState() });

test('WP11 planner -> task: a block linked to a task shows "Úkol" and opens the existing task editor', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  await page.locator('.wp-block[data-block="pW1"] [data-open-task="tW1"]').click();
  assert.equal(await page.locator('.sheet #f_title').inputValue(), 'Návrh');
  assert.equal(await page.locator('.sheet #f_goal').inputValue(), 'gW1');
}, { state: fixtureState() });

test('WP12 goal -> week: the goal detail has "Zobrazit v týdnu", opening this week with the goal marked', async ({ page }) => {
  await wpSeed(page); await page.evaluate(() => { currentGoalId = 'gW1'; view = 'goalDetail'; render(); });
  await page.click('#gpInWeek');
  assert.deepEqual(await page.evaluate(() => [view, wpOffset, document.querySelector('.wp').dataset.week]), ['week', 0, '2026-09-21']);
  assert.equal(await page.locator('#wpGoals .wp-goal.is-focus').getAttribute('data-goal'), 'gW1');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-goal]').dataset.goal), 'gW1');
}, { state: fixtureState() });

test('WP13 week -> goal: a goal (card or block chip) opens the goal detail', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  await page.locator('#wpGoals [data-goal="gW2"] .wp-goal-t').click();
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gW2']);
  await wpGo(page, 0); await page.locator('.wp-block[data-block="pW5"] [data-open-goal="gW1"]').click();
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gW1']);
}, { state: fixtureState() });

test('WP14 habits: only real occurrences (scheduled day, done or not; weekly ones on the days done); nothing written', async ({ page }) => {
  await wpSeed(page); const before = await wpState(page);
  const h = await page.evaluate(() => Object.fromEntries(wpWeek(0).days.map(d => [d.date.slice(8), d.habits.map(x => (x.done ? '✓' : '○') + x.h.name).join(' ')])));
  assert.deepEqual(h, { '21': '✓Voda ○Čtení', '22': '✓Plavání ✓Voda', '23': '✓Čtení ✓Voda', '24': '○Voda', '25': '○Čtení ○Voda', '26': '○Voda', '27': '○Voda' });
  await wpGo(page, 0);
  assert.match(await page.locator('.wp-day[data-day="2026-09-23"] .wp-habits').innerText(), /✓ Čtení[\s\S]*✓ Voda/);
  assert.doesNotMatch(await page.locator('#wpDays').innerText(), /Kouření/, 'bad habits are not listed as occurrences');
  assert.equal(await wpState(page), before);
}, { state: fixtureState() });

test('WP15 fitness: done workouts with their clock time, planned workout blocks, training days; click opens Fitness', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  assert.match(await page.locator('.wp-day[data-day="2026-09-22"]').innerText(), /17:00–18:00[\s\S]*Push[\s\S]*splněno/);
  assert.match(await page.locator('.wp-day[data-day="2026-09-25"]').innerText(), /Tréninkový den/);
  await page.locator('.wp-day[data-day="2026-09-22"] [data-open-fitness="wW1"]').click();
  assert.equal(await page.evaluate(() => view), 'fitness');
}, { state: fixtureState() });

test('WP16 events: time, title and length; all-day ones; recurring occurrences in the week; never turned into tasks', async ({ page }) => {
  await wpSeed(page); const n0 = await page.evaluate(() => S.tasks.length);
  assert.deepEqual(await page.evaluate(() => wpEventsIn('2026-09-21', '2026-09-27').map(x => [x.e.id, x.date])), [['eW1', '2026-09-25'], ['eW2', '2026-09-23'], ['eAll', '2026-09-26']]);
  await wpGo(page, 0);
  assert.match(await page.locator('.wp-day[data-day="2026-09-25"]').innerText(), /11:30–12:30[\s\S]*Porada[\s\S]*1 h/);
  assert.match(await page.locator('.wp-day[data-day="2026-09-26"]').innerText(), /celý den[\s\S]*Svátek/);
  await page.locator('[data-open-event="eW1"]').click(); assert.equal(await page.locator('.sheet #e_title, .sheet input').first().count(), 1);
  await page.evaluate(() => closeSheets());
  assert.equal(await page.evaluate(() => S.tasks.length), n0);
}, { state: fixtureState() });

test('WP17 planner conflicts: overlapping blocks with date, time and both items; touching blocks are not a conflict; nothing moved', async ({ page }) => {
  await wpSeed(page); const before = await page.evaluate(() => JSON.stringify(S.plannerBlocks));
  const c = await page.evaluate(() => wpWeek(0).days.flatMap(d => d.conflicts).map(x => [x.date.slice(8), x.a.k + ':' + x.a.id, x.b.k + ':' + x.b.id, x.from, x.to]));
  assert.deepEqual(c, [['22', 'workout:wW1', 'block:pW7', '17:30', '18:00'], ['23', 'event:eW2', 'block:pW3', '18:00', '19:00'], ['25', 'block:pW4', 'block:pW5', '10:30', '11:00'], ['25', 'block:pW5', 'event:eW1', '11:30', '12:00']]);
  await page.evaluate(() => { S.plannerBlocks.push({ id: 'pT', date: '2026-09-25', startTime: '12:30', endTime: '13:00', title: 'Navazuje' }); });
  assert.equal(await page.evaluate(() => wpWeek(0).days[4].conflicts.length), 2, '12:30 right after an event ending 12:30 is not a conflict');
  await page.evaluate(() => { S.plannerBlocks = S.plannerBlocks.filter(b => b.id !== 'pT'); });
  await wpGo(page, 0);
  assert.match(await page.locator('#wpConflicts').innerText(), /Pá 25\. 9\.[\s\S]*10:30–11:00[\s\S]*Blok: Zubař 10:00–11:00[\s\S]*Blok: Sprint 10:30–12:00/);
  assert.equal(await page.evaluate(() => JSON.stringify(S.plannerBlocks)), before);
}, { state: fixtureState() });

test('WP18 event and workout conflicts: planner vs event and planner vs a timed workout are listed', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  const t = await page.locator('#wpConflicts').innerText();
  assert.match(t, /Út 22\. 9\.[\s\S]*Trénink: Push 17:00–18:00[\s\S]*Blok: Běh venku 17:30–18:30/);
  assert.match(t, /St 23\. 9\.[\s\S]*Událost: Trénink tým 18:00–19:00[\s\S]*Blok: Intervaly 18:00–19:30/);
  assert.match(t, /Blok: Sprint 10:30–12:00[\s\S]*Událost: Porada 11:30–12:30/);
}, { state: fixtureState() });

test('WP19 reschedule: "Přesunout" changes day / start / end through the existing validation; the week is recomputed', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  await page.locator('.wp-block[data-block="pW4"] .wp-move').click();
  await page.fill('#mv_date', '2026-09-26'); await page.fill('#mv_start', '09:00'); await page.fill('#mv_end', '08:00'); await page.click('#mv_save');
  assert.equal(await page.locator('#mv_end').getAttribute('aria-invalid'), 'true', 'end before start is refused'); assert.equal(await page.evaluate(() => S.plannerBlocks.find(b => b.id === 'pW4').date), '2026-09-25');
  await page.fill('#mv_end', '10:30'); await page.click('#mv_save'); await settle(page);
  const b = await page.evaluate(() => S.plannerBlocks.find(b => b.id === 'pW4'));
  assert.deepEqual([b.date, b.startTime, b.endTime, b.title, b.category, b.completed], ['2026-09-26', '09:00', '10:30', 'Zubař', 'Personal', false]);
  assert.equal(await page.locator('.wp-day[data-day="2026-09-26"] .wp-block[data-block="pW4"]').count(), 1);
  assert.match(await page.locator('.wp-day[data-day="2026-09-25"]').innerText(), /Naplánováno: 1 h 30 min/);
  assert.equal((await idbState(page)).plannerBlocks.find(x => x.id === 'pW4').date, '2026-09-26', 'saved');
  // drag & drop onto another day keeps the times (the same save)
  // (HTML5 drag events dispatched directly: a real mouse drag across a scrolled page is not reliable in headless runs)
  await page.evaluate(() => { const dt = new DataTransfer(), src = document.querySelector('.wp-block[data-block="pW6"]'), dst = document.querySelector('.wp-day[data-day="2026-09-24"] .wp-day-c');
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); });
  assert.deepEqual(await page.evaluate(() => { const x = S.plannerBlocks.find(b => b.id === 'pW6'); return [x.date, x.startTime, x.endTime]; }), ['2026-09-24', '08:00', '09:00']);
}, { state: fixtureState() });

test('WP20 + WP21 moving a block keeps its goal link, task link, category and workout template', async ({ page }) => {
  await wpSeed(page);
  await page.evaluate(() => { S.plannerBlocks.find(b => b.id === 'pW1').workoutTemplateId = ''; S.plannerBlocks.find(b => b.id === 'pW5').notes = 'poznámka'; });
  const keep = await page.evaluate(() => ['pW1', 'pW5'].map(id => { const b = S.plannerBlocks.find(x => x.id === id); return JSON.stringify([b.id, b.taskId, b.goalId, b.category, b.title, b.notes, b.workoutTemplateId, b.completed, b.createdAt]); }));
  await wpGo(page, 0);
  for (const [id, d] of [['pW1', '2026-09-27'], ['pW5', '2026-09-24']]) { await page.locator(`.wp-block[data-block="${id}"] .wp-move`).click(); await page.fill('#mv_date', d); await page.click('#mv_save'); }
  const after = await page.evaluate(() => ['pW1', 'pW5'].map(id => { const b = S.plannerBlocks.find(x => x.id === id); return JSON.stringify([b.id, b.taskId, b.goalId, b.category, b.title, b.notes, b.workoutTemplateId, b.completed, b.createdAt]); }));
  assert.deepEqual(after, keep);
  assert.equal(await page.locator('.wp-day[data-day="2026-09-27"] .wp-block[data-block="pW1"] [data-open-task="tW1"]').count(), 1, 'task link');
  assert.equal(await page.locator('.wp-day[data-day="2026-09-24"] .wp-block[data-block="pW5"] [data-open-goal="gW1"]').count(), 1, 'goal link');
}, { state: fixtureState() });

test('WP22 + WP23 weekly priorities: an explicit toggle per week, at most 3, stored in S.weeklyPriorities, no XP; the chosen goals show their tasks, blocks, milestones and habit support', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0); const xp0 = await xpOf(page);
  assert.match(await page.locator('#wpPriorities').innerText(), /Zatím žádná priorita/);
  for (const id of ['gW1', 'gW2', 'gW3']) { await page.locator(`#wpGoals [data-goal="${id}"] .wp-pri-toggle`).click(); assert.equal(await page.evaluate(() => document.activeElement.dataset.pri), id, 'focus stays on the toggle'); }
  assert.deepEqual(await page.evaluate(() => S.weeklyPriorities), { '2026-09-21': ['gW1', 'gW2', 'gW3'] });
  await page.evaluate(() => { window.__t = []; const t0 = window.toast; window.toast = m => { window.__t.push(String(m)); return t0(m); }; });
  await page.locator('#wpGoals [data-goal="gW4"] .wp-pri-toggle').click();
  assert.deepEqual(await page.evaluate(() => [S.weeklyPriorities['2026-09-21'].length, window.__t.join('|')]), [3, 'Priorit týdne může být nejvýš 3.'], 'max 3');
  const pri = await page.locator('#wpPriorities').innerText();
  assert.match(pri, /Priority týdne · 3\/3[\s\S]*Web[\s\S]*Otevřené úkoly[\s\S]*Návrh[\s\S]*Bloky tento týden[\s\S]*Sprint[\s\S]*Otevřené milníky[\s\S]*Beta/i);
  assert.equal(await page.locator('#wpGoals [data-goal="gW1"]').getAttribute('class').then(c => c.includes('is-pri')), true);
  await page.locator('#wpPriorities [data-goal="gW2"] .wp-pri-toggle').click();
  assert.deepEqual(await page.evaluate(() => S.weeklyPriorities['2026-09-21']), ['gW1', 'gW3']);
  await wpGo(page, 1); assert.match(await page.locator('#wpPriorities').innerText(), /0\/3/, 'per week');
  await settle(page); assert.deepEqual((await idbState(page)).weeklyPriorities, { '2026-09-21': ['gW1', 'gW3'] });
  assert.equal(await xpOf(page), xp0, 'no XP for planning');
  assert.deepEqual(await page.evaluate(() => wpTogglePriority('2026-09-21', 'gDone')), { ok: false, reason: 'goal' }, 'only active goals');
}, { state: fixtureState() });

test('WP24 + WP25 weekly review / plan vs actual: tasks, blocks (past, marked done), milestones, goals, workouts, habits, events, XP - no measured working time', async ({ page }) => {
  await wpSeed(page);
  const r = await page.evaluate(() => { const x = wpSummary(wpWeek(0)); return [x.pastBlocks, x.doneBlocks, x.pastMin, x.doneMin, x.current, x.complete]; });
  assert.deepEqual(r, [3, 2, 180, 120, true, false]);
  await wpGo(page, 0);
  const rows = await page.$$eval('#wpReview tbody tr', rs => rs.map(r => [...r.children].map(c => c.textContent.trim())));
  assert.deepEqual(rows, [['Úkoly s termínem v týdnu', '4', '1'], ['Dokončené úkoly celkem', '—', '1'], ['Bloky (proběhlé)', '3', '2'], ['Čas bloků (proběhlé)', '3 h', '2 h'], ['Milníky s termínem', '1', '1'], ['Uzavřené projekty', '—', '1'],
    ['Tréninky', '3', '1'], ['Rutiny (splnění)', '6', '5'], ['Události', '3', '—'], ['XP získané v týdnu', '—', '310']]);
  assert.match(await page.locator('#wpReview').innerText(), /Týden ještě běží[\s\S]*skutečně odpracovaný čas aplikace neměří/);
  await wpGo(page, -1); assert.doesNotMatch(await page.locator('#wpReview').innerText(), /Týden ještě běží/, 'a finished week');
}, { state: fixtureState() });

test('WP26 Analytics stays read-only and agrees with the week (planned blocks and time, completed tasks, goal activity)', async ({ page }) => {
  await wpSeed(page); const before = await wpState(page);
  const r = await page.evaluate(() => { const r = getAnalyticsRange('custom', todayStr(), { from: '2026-09-21', to: '2026-09-27' }), a = anAnalyze(r), w = wpSummary(wpWeek(0));
    // Analytics' custom range ends today, so compare with the week's days up to today
    const upTo = wpWeek(0).days.filter(d => d.date <= todayStr()), n = upTo.reduce((s, d) => s + d.blocks.length, 0), m = upTo.reduce((s, d) => s + d.minutes, 0);
    return [a.planner.count === n && n === 4, a.planner.planned === m && m === 270, a.tasks.metrics.done.current === w.tasksDone, a.goals.metrics.tasks.current]; });
  assert.deepEqual(r, [true, true, true, 1]);
  await page.evaluate(() => { statsPeriod = 'week'; view = 'statistics'; render(); });
  assert.equal(await wpState(page), before);
}, { state: fixtureState() });

test('WP27 Command Center keeps its own engine: "Co teď?" and its ranking are identical with and without the week view', async ({ page }) => {
  await wpSeed(page);
  const a = await page.evaluate(() => JSON.stringify(ccRank(ccCandidates(ccContext())).map(c => [c.kind, c.id, c.score])) + JSON.stringify(ccNow().mode));
  await wpGo(page, 0); await wpGo(page, 1);
  const b = await page.evaluate(() => JSON.stringify(ccRank(ccCandidates(ccContext())).map(c => [c.kind, c.id, c.score])) + JSON.stringify(ccNow().mode));
  assert.equal(a, b);
  assert.equal(await page.evaluate(() => typeof wpPriorityIds === 'function' && !ccCandidates.toString().includes('weeklyPriorities')), true, 'weekly priorities are not a Command Center input');
}, { state: fixtureState() });

test('WP28 Home widget "Tento týden": planned time, tasks, active goals; "Zobrazit týden" opens the week', async ({ page }) => {
  await wpSeed(page); await page.evaluate(() => { view = 'home'; render(); });
  assert.match(await page.locator('#ccWeek').innerText(), /Tento týden[\s\S]*9 h naplánováno[\s\S]*1\/4 úkolů[\s\S]*4 aktivní projekty/i);
  await page.click('#ccWeek [data-cc-week]');
  assert.deepEqual(await page.evaluate(() => [view, wpOffset]), ['week', 0]);
  await page.evaluate(() => { S.settings.widgets.planner = false; view = 'home'; render(); });
  assert.equal(await page.locator('#ccWeek').count(), 0, 'follows the Dnešek switch');
}, { state: fixtureState() });

test('WP29 Calendar coexists unchanged: same events on its dates; the week lists every recurring occurrence without touching events', async ({ page }) => {
  await wpSeed(page); const ev0 = await page.evaluate(() => JSON.stringify(S.events));
  await page.evaluate(() => { view = 'calendar'; render(); }); assert.equal(await page.evaluate(() => view), 'calendar');
  assert.deepEqual(await page.evaluate(() => uiEventsOn('2026-09-25').map(e => e.id)), ['eW1']);
  await wpGo(page, 0); assert.equal(await page.evaluate(() => JSON.stringify(S.events)), ev0);
  await page.evaluate(() => { view = 'more'; render(); });
  assert.deepEqual(await page.$$eval('.more-section:first-of-type [data-v]', ns => ns.map(n => n.dataset.v).slice(0, 4)), ['calendar', 'goals', 'week', 'intel'], 'Reality QA: Kalendář (with the planner) and Projekty lead the productivity group');
}, { state: fixtureState() });

test('WP30 Quick Add "Naplánovat týden" opens the current week; the other entries still open their forms', async ({ page }) => {
  await wpSeed(page); await page.evaluate(() => { wpOffset = 2; view = 'home'; render(); });
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="week"]');
  assert.deepEqual(await page.evaluate(() => [view, wpOffset, !!document.querySelector('.sheet')]), ['week', 0, false]);
  await page.click('#fabBtn'); await page.click('.sheet .qopt[data-t="task"]'); assert.ok(await page.locator('.sheet #f_title').isVisible());
}, { state: fixtureState() });

const WP_WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440];
test('WP31 + WP32 + WP33 320-1440 px: days stacked on phones (no horizontal scroll), 7-day strip + two columns on wide screens, full-width cards, 44 px targets; other screens too', async ({ page }) => {
  await wpSeed(page); const bad = [];
  for (const w of WP_WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const off of [0, -1]) { await wpGo(page, off);
      const c = await wpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/week${off}: ${JSON.stringify(c)}`);
      const small = await page.$$eval('.wp button, .wp a, .wp summary', ns => ns.filter(n => n.offsetParent && !n.closest('.wp-mini')).map(n => [n.className || n.id, n.getBoundingClientRect()]).filter(([, r]) => r.height < 44 || r.width < 44).map(([k, r]) => `${k} ${Math.round(r.width)}x${Math.round(r.height)}`));
      if (small.length) bad.push(`${w} small: ${small.slice(0, 4).join(', ')}`);
      const cols = await page.evaluate(() => new Set([...document.querySelectorAll('#wpDays .wp-day')].map(n => Math.round(n.getBoundingClientRect().left))).size);
      if ((w < 700 && cols !== 1) || (w >= 700 && cols !== 2)) bad.push(`${w}: ${cols} day columns`);
      if (w < 600 && await page.locator('.wp-strip').isVisible()) bad.push(`${w}: strip visible`);
    }
    for (const v of ['home', 'goals', 'goalDetail', 'planner', 'calendar', 'tasks', 'statistics', 'settings']) { await page.evaluate(v => { currentGoalId = 'gW1'; closeSheets(); view = v; render(); }, v); const c = await wpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/${v}: ${JSON.stringify(c)}`); }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('WP34 light + dark: WCAG AA text contrast in the week; SVG icons, no emoji as UI icons', async ({ page }) => {
  await wpSeed(page); const bad = [];
  for (const theme of ['light', 'dark']) for (const off of [0, -1]) {
    await wpGo(page, off);
    const r = await page.evaluate(theme => { S.settings.theme = theme; applyTheme(); render();
      const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
      const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (/gradient/.test(cs.backgroundImage) && e.matches('.btn:not(.ghost):not(.danger)')) return { r: 110, g: 80, b: 240, a: 1 }; const c = parse(cs.backgroundColor); if (c && c.a > 0) { st.push(c); if (c.a >= 1) break; } } let bg = parse(getComputedStyle(document.body).backgroundColor); for (let i = st.length - 1; i >= 0; i--) bg = blend(st[i], bg); return bg; };
      const out = [];
      document.querySelectorAll('.wp *').forEach(e => { if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return; const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[aria-hidden="true"],.hide,[hidden]')) return; const fg0 = parse(cs.color); if (!fg0) return; const bg = bgOf(e), fg = blend(fg0, bg);
        const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05), size = parseFloat(cs.fontSize), need = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5;
        if (ratio < need) out.push(`${theme}: "${e.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}`); });
      [...document.querySelectorAll('.wp h3, .wp .kicker, .wp button, .wp dt')].forEach(n => { if (/\p{Extended_Pictographic}/u.test(n.textContent)) out.push(`${theme} emoji: ${n.textContent.trim().slice(0, 20)}`); });
      return out; }, theme);
    bad.push(...r);
  }
  assert.deepEqual([...new Set(bad)], []);
}, { state: fixtureState() });

test('WP35 accessibility: named week/day structure, list of days, summary as a description list, screen-reader day summaries, named controls, keyboard + focus', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  const r = await page.evaluate(() => ({ days: document.querySelectorAll('ol.wp-days > li > article[aria-labelledby]').length,
    heads: [...document.querySelectorAll('ol.wp-days article')].every(a => document.getElementById(a.getAttribute('aria-labelledby'))),
    secs: [...document.querySelectorAll('.wp section[aria-labelledby]')].filter(s => !document.getElementById(s.getAttribute('aria-labelledby'))).length,
    dl: document.querySelectorAll('#wpSummary dl dt').length, sr: document.querySelector('.wp-day[data-day="2026-09-25"] .hide').textContent,
    unnamed: [...document.querySelectorAll('.wp button, .wp a')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).length,
    bars: [...document.querySelectorAll('.wp [role="progressbar"]')].filter(b => !(+b.getAttribute('aria-valuenow') >= 0 && b.getAttribute('aria-label'))).length,
    nav: document.querySelector('nav.wp-nav').getAttribute('aria-label') }));
  assert.deepEqual([r.days, r.heads, r.secs, r.dl, r.unnamed, r.bars], [7, true, 0, 10, 0, 0]);
  assert.match(r.sr, /Pátek 25\. 9\.: naplánováno 2 h 30 min, bloků 2, úkolů 1, událostí 1/);
  assert.ok(r.nav);
  await page.focus('#wpNext'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('.wp').dataset.week, document.activeElement.id]), ['2026-09-28', 'wpNext']);
  await page.setViewportSize({ width: 1024, height: 900 }); await wpGo(page, 0);
  await page.click('.wp-strip [data-jump-day="2026-09-25"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'wpd-2026-09-25');
}, { state: fixtureState() });

test('WP36 reduced motion: nothing in the week animates', async ({ page }) => {
  await wpSeed(page); await wpGo(page, 0);
  const moving = await page.evaluate(() => [...document.querySelectorAll('.wp, .wp *')].filter(n => { const cs = getComputedStyle(n); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 || parseFloat(cs.transitionDuration) > 0.01; }).map(n => n.className));
  assert.deepEqual(moving, []);
}, { state: fixtureState() });

test('WP37 export / import: weeklyPriorities travels in the same backup; an old backup without it imports and gets an empty map', async ({ page }) => {
  await wpSeed(page); await page.evaluate(() => { wpTogglePriority('2026-09-21', 'gW1'); }); await persist(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(exported, await stateOf(page)); assert.deepEqual(exported.weeklyPriorities, { '2026-09-21': ['gW1'] }); assert.equal(exported.schemaVersion, 8);
  await page.evaluate(() => { S.weeklyPriorities = {}; S.plannerBlocks = []; }); await importFile(page, await dl.path()); await settle(page);
  assert.deepEqual(await stateOf(page), exported, 'restored exactly');
  const old = JSON.parse(JSON.stringify(exported)); delete old.weeklyPriorities;
  const f = path.join(path.dirname(await dl.path()), 'old-week.json'); writeFileSync(f, JSON.stringify(old));
  await page.click('#settingsBtn'); await importFile(page, f); await settle(page);
  assert.deepEqual(await page.evaluate(() => S.weeklyPriorities), {});
  await wpGo(page, 0); assert.deepEqual(await wpClean(page), { bad: false, dup: [], overflow: 0 });
}, { state: fixtureState() });

test('WP38 legacy data: a schemaVersion-4 state (no weeklyPriorities, old events and workouts) migrates idempotently and the week reads cleanly', async ({ page }) => {
  const r = await page.evaluate(() => { const legacy = { tasks: [{ id: 'lt', title: 'Starý', dueDate: '2026-09-22', done: false, createdAt: 1 }], events: [{ id: 'le', title: 'Stará událost', date: '2026-09-24', time: '10:00' }],
      workouts: [{ id: 'lw', name: 'Old', date: '2026-09-21', exercises: [] }], habits: [{ id: 'lh', name: 'Old habit', completions: ['2026-09-21'], active: true }], xpLog: [], totalXp: 0, schemaVersion: 4 };
    const a = migrate(JSON.parse(JSON.stringify(legacy))); const b = migrate(JSON.parse(JSON.stringify(a)));
    // key order of nested objects is not significant (migrate() merges defaults), so compare with sorted keys
    const srt = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
    const same = srt(a) === srt(b); S = a; S.settings.onboarded = true; return [a.schemaVersion, JSON.stringify(a.weeklyPriorities), same, a.events[0].start]; });
  assert.deepEqual(r, [8, '{}', true, '10:00']);
  await page.evaluate(() => { view = 'home'; render(); });
  const before = await wpState(page);
  for (const o of [-1, 0, 1]) { await wpGo(page, o); assert.deepEqual(await wpClean(page), { bad: false, dup: [], overflow: 0 }, String(o)); }
  await wpGo(page, 0);
  assert.match(await page.locator('.wp-day[data-day="2026-09-24"]').innerText(), /10:00[\s\S]*Stará událost/);
  assert.equal(await wpState(page), before);
}, { state: fixtureState() });

test('WP39 + WP40 opening the week never writes: no state, IndexedDB, XP, Daily Score or attribute change; no task or block created', async ({ page }) => {
  await page.evaluate(() => { view = 'home'; render(); }); await persist(page);
  const snap = () => page.evaluate(() => JSON.stringify([S, dailyScore(todayStr()), S.attrs, S.totalXp]));
  const a0 = await snap(), idb0 = await idbState(page);
  for (const o of [-2, -1, 0, 1, 2]) { await wpGo(page, o); await page.evaluate(() => { const w = wpWeek(wpOffset); wpSummary(w); wpGoals(w); wpUnplanned(w); }); }
  await wpGo(page, 0); for (const id of await page.$$eval('.wp-strip [data-jump-day]', ns => ns.map(n => n.dataset.jumpDay))) await page.evaluate(id => document.getElementById('wpd-' + id), id);
  await settle(page);
  assert.equal(await snap(), a0); assert.deepEqual(await idbState(page), idb0);
  await wpSeed(page); await persist(page); const b0 = await snap(), idb1 = await idbState(page);
  for (const o of [-1, 0, 1]) await wpGo(page, o);
  await page.evaluate(() => { view = 'home'; render(); }); await page.evaluate(() => { view = 'goalDetail'; currentGoalId = 'gW1'; render(); });
  await settle(page);
  assert.equal(await snap(), b0, 'seeded: nothing changed'); assert.deepEqual(await idbState(page), idb1);
}, { state: fixtureState() });

test('WP41 + WP42 no duplicate ids, no NaN / undefined in any week - fixture, seeded, empty, legacy', async ({ page }) => {
  const bad = [];
  const sweep = async name => { for (const o of [-2, -1, 0, 1, 2]) { await wpGo(page, o); const c = await wpClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${name}/${o}: ${JSON.stringify(c)}`); } };
  await sweep('fixture'); await wpSeed(page); await sweep('seed');
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; }); await sweep('empty');
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; S.weeklyPriorities = { '2026-09-21': ['missing-goal', 'x', 'y', 'z'] }; S.plannerBlocks = [{ id: 'bad', date: '2026-09-22', startTime: '', endTime: 'xx', title: 'Neplatný' }]; S.events = [{ id: 'e', title: 'x', date: '2026-09-22', recurring: 'daily' }]; }); await sweep('odd');
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('WP43 performance: 1 500 tasks, 25 000 XP, 40 habits, 25 goals, 100 milestones, 400 blocks, 300 meals, 300 sleep records, 150 workouts, 200 events', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3)); const T = todayStr();
    for (let i = 0; i < 25; i++) S.goals.push({ id: 'pg' + i, title: 'Projekt ' + i, category: ['Work', 'Fitness', ''][i % 3], status: i % 5 ? 'Active' : 'Completed', targetDate: i % 4 ? addDays(T, i * 7 - 30) : '', mode: 'auto', createdAt: Date.now() - 200 * 86400000 });
    for (let i = 0; i < 100; i++) S.milestones.push({ id: 'pm' + i, goalId: 'pg' + (i % 25), title: 'M' + i, targetDate: addDays(T, i - 50), completed: i % 3 === 0, completedAt: i % 3 === 0 ? Date.now() - i * 86400000 : null, createdAt: 1 });
    S.tasks.forEach((t, i) => { if (i % 5 === 0) t.goalId = 'pg' + (i % 25); });
    for (let i = 0; i < 40; i++) S.habits.push({ id: 'ph' + i, name: 'Rutina ' + i, type: i % 9 ? 'good' : 'bad', frequency: ['daily', 'weekdays', 'weekly'][i % 3], weekdays: [1, 3, 5], target: i % 3 === 2 ? 3 : 1, goalId: i % 4 ? '' : 'pg' + (i % 25), completions: Array.from({ length: 200 }, (_, k) => addDays(T, -k)), active: true, createdAt: 1 });
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, (i % 60) - 30), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':30', title: 'Blok ' + i, category: ['Work', 'Fitness', ''][i % 3], taskId: i % 3 ? '' : 'rt' + (i * 5), goalId: i % 4 ? '' : 'pg' + (i % 25), completed: i % 2 === 0 });
    for (let i = 0; i < 300; i++) { const d = addDays(T, -i); S.meals.push({ id: 'pm' + i, name: 'J', date: d, type: 'Lunch', calories: 500, servings: 1 }); S.sleepLog.push({ id: 'ps' + i, date: d, bedtime: '23:00', wake: '07:00' }); }
    for (let i = 0; i < 150; i++) S.workouts.push({ id: 'pw' + i, name: 'Push', date: addDays(T, -i * 2), status: 'done', startedAt: new Date(addDays(T, -i * 2) + 'T17:00').getTime(), finishedAt: new Date(addDays(T, -i * 2) + 'T18:00').getTime(), entries: [] });
    for (let i = 0; i < 200; i++) S.events.push({ id: 'pe' + i, title: 'Událost ' + i, date: addDays(T, (i % 120) - 90), start: String(8 + i % 10).padStart(2, '0') + ':00', end: String(9 + i % 10).padStart(2, '0') + ':00', recurring: ['none', 'weekly', 'daily', 'monthly'][i % 4] });
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    return { week: m(() => { wpOffset = 0; view = 'week'; render(); }, 5), prev: m(() => { wpOffset = -1; view = 'week'; render(); }, 5), engine: m(() => { const w = wpWeek(0); wpSummary(w); wpGoals(w); wpUnplanned(w); }, 5), home: m(() => { view = 'home'; render(); }, 5),
      bad: (wpOffset = 0, view = 'week', render(), /undefined|NaN/.test(document.getElementById('app').innerText)) }; });
  console.log('      WP43 ' + Object.entries(r).filter(([k]) => k !== 'bad').map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  assert.ok(!r.bad);
  assert.ok(r.week < 80 && r.prev < 80 && r.engine < 50, 'fast (target week < 50 ms)');
}, { state: fixtureState() });

test('WP44 + WP45 Web Locks / multi-tab: a second tab stays blocked (never loads or saves the week), a priority set in the owner tab is saved and reaches the next owner', async ({ page }) => {
  const errs = [];
  await wpSeed(page); await persist(page);
  const B = await extraTab(page, errs);
  await B.waitForSelector('#tabLock');
  assert.deepEqual(await tabState(B), { booted: false, active: false, blocked: true });
  assert.equal(await B.evaluate(() => typeof S === 'undefined' || S === null), true, 'the blocked tab has no data to show a week from');
  await B.evaluate(() => { try { flushSave(); scheduleSave(); } catch (e) {} });
  await page.evaluate(() => { wpOffset = 0; view = 'week'; render(); wpTogglePriority('2026-09-21', 'gW2'); }); await settle(page);
  assert.deepEqual((await idbState(page)).weeklyPriorities, { '2026-09-21': ['gW2'] }, 'owner saved');
  await page.reload(); await ownerReady(B); await injectRawIdb(B);
  assert.deepEqual(await B.evaluate(() => { wpOffset = 0; view = 'week'; render(); return [S.weeklyPriorities, document.querySelector('#wpPriorities').innerText.includes('1/3')]; }), [{ '2026-09-21': ['gW2'] }, true], 'the next owner reads the saved priority');
  await B.close();
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

// ---------- LifeOS Intelligence 1.0 (IN) ----------
// fixture day 2026-09-23 (Wednesday); engine tests pass an explicit now (12:00 that day), UI tests use the app clock
const IN_NOW = 'new Date("2026-09-23T12:00:00")';
const inRun = (page, now) => page.evaluate(n => { const r = intelCompute(new Date(n)); return JSON.parse(JSON.stringify(r)); }, now || '2026-09-23T12:00:00');
const inState = page => page.evaluate(() => JSON.stringify(S));
const inClean = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|Infinity|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
const inGo = (page, v) => page.evaluate(v => { closeSheets(); uiInAll = false; view = v || 'intel'; render(); window.scrollTo(0, 0); }, v);
// one state with every suggestion type (dates relative to today 2026-09-23)
const inSeed = page => page.evaluate(() => {
  const T = todayStr(), D = n => addDays(T, n), ts = d => new Date(d + 'T09:00').getTime();
  S = defaultState(); S.settings.onboarded = true;
  S.goals = [
    { id: 'gA', title: 'Web', category: 'Work', status: 'Active', targetDate: D(3), mode: 'auto', createdAt: ts(D(-2)) },
    { id: 'gB', title: 'Kniha', category: 'Learning', status: 'Active', targetDate: '', mode: 'auto', createdAt: ts(D(-30)) },
    { id: 'gC', title: 'Jazyk', category: 'Learning', status: 'Active', targetDate: '', mode: 'auto', createdAt: ts(D(-40)) },
    { id: 'gD', title: 'Běh', category: 'Fitness', status: 'Active', targetDate: '', mode: 'auto', createdAt: ts(D(-2)) },
    { id: 'gE', title: 'Hotovo', category: 'Work', status: 'Completed', targetDate: D(1), mode: 'auto', createdAt: ts(D(-50)) },
    { id: 'gO', title: 'Starý projekt', category: 'Work', status: 'Active', targetDate: D(-2), mode: 'auto', createdAt: ts(D(-5)) }];
  S.milestones = [{ id: 'mD1', goalId: 'gD', title: 'Půlmaraton', targetDate: '', completed: false, completedAt: null, createdAt: ts(D(-2)) }];
  const tk = (id, title, o) => Object.assign({ id, title, description: '', category: 'Work', priority: 'Medium', dueDate: '', done: false, goalId: '', createdAt: ts(D(-3)) }, o);
  S.tasks = [tk('tA0', 'Rešerše', { goalId: 'gA', done: true }), tk('tA1', 'Návrh', { goalId: 'gA', dueDate: D(1) }), tk('tOver', 'Faktura', { dueDate: D(-3), priority: 'High' }),
    tk('tPast', 'Report', { dueDate: D(5) }), tk('tPlanned', 'Plánovaný', { dueDate: D(2), priority: 'High' }), tk('tLow', 'Nedůležitý', { priority: 'Low' }),
    tk('tFar', 'Daleko', { dueDate: D(20) }), tk('tUrg', 'Hoří', { priority: 'Urgent' }), tk('tO1', 'Dokončit', { goalId: 'gO' }),
    tk('tC0', 'Lekce 1', { goalId: 'gC', done: true, category: 'Learning' }), tk('tC1', 'Lekce 2', { goalId: 'gC', priority: 'Low', category: 'Learning' })];
  const B = (id, d, s, e, o) => Object.assign({ id, date: d, startTime: s, endTime: e, title: id, category: 'Work', taskId: '', goalId: '', notes: '', completed: false, createdAt: 1 }, o);
  S.plannerBlocks = [B('pPast', D(-1), '09:00', '10:00', { title: 'Report', taskId: 'tPast' }), B('pPl', D(1), '14:00', '15:00', { title: 'Plánovaný', taskId: 'tPlanned' }),
    B('pX1', D(2), '10:00', '11:00', { title: 'Porada blok' }), B('pX2', D(2), '10:30', '11:30', { title: 'Sprint' }), B('pX3', D(2), '11:30', '12:00', { title: 'Navazuje' }),
    B('pX4', D(3), '18:30', '19:00', { title: 'Běh venku', category: 'Fitness' }),
    ...Array.from({ length: 8 }, (_, i) => B('pO' + i, D(4), String(6 + i).padStart(2, '0') + ':00', String(7 + i).padStart(2, '0') + ':00', { title: 'Blok ' + (i + 1) }))];
  S.events = [{ id: 'eX', title: 'Trénink tým', date: D(3), start: '18:00', end: '19:00', recurring: 'none' }];
  S.xpLog = [{ id: 'x1', amount: 20, reason: 'Task: Lekce 1', ts: ts(D(-20)), key: `task:tC0:${D(-20)}` }, { id: 'x2', amount: 20, reason: 'Task: Rešerše', ts: ts(D(-1)), key: `task:tA0:${D(-1)}` }];
  S.totalXp = 40; S.weeklyPriorities = { '2026-09-21': ['gD'] }; S.dailyScoresSince = T; S.achievementsUnlocked = ACHV.map(a => a.id);
  S = migrate(JSON.parse(JSON.stringify(S)));
  ['daily', 'weekly'].forEach(p => questBoardFor(p).forEach(({ q }) => { const k = questKey(q.id, p); if (!S.quests.some(x => x.key === k)) S.quests.push({ key: k, questId: q.id, date: todayStr(), period: p, rewarded: true }); }));
  try { sessionStorage.removeItem('lifeos.intel.hidden'); } catch (e) {} uiInHidden = null;
  closeSheets(); view = 'home'; render();
});
const IN_ORDER = ['task_plan:tOver', 'deadline:gO', 'conflict:2026-09-25:pX2', 'conflict:2026-09-26:pX4', 'task_plan:tA1', 'deadline:gA', 'priority_plan:gD', 'goal_next:gB',
  'reschedule:tPast', 'task_plan:tUrg', 'goal_idle:gC', 'overload:2026-09-27', 'window:2026-09-28'];

test('IN1 unplanned important task: overdue / due within 7 days / High-Urgent without an upcoming block -> "Naplánovat"; unimportant or planned tasks are left out; nothing is created', async ({ page }) => {
  await inSeed(page); const before = await inState(page);
  const r = await inRun(page), by = id => r.suggestions.find(s => s.id === id);
  assert.deepEqual(['tOver', 'tA1', 'tUrg'].map(id => by('task_plan:' + id).reasons.map(x => x.r)), [['overdue', 'prio', 'no_block'], ['due_in', 'goal', 'no_block'], ['prio', 'no_block']]);
  assert.deepEqual([by('task_plan:tOver').rank, by('task_plan:tA1').rank, by('task_plan:tUrg').rank, by('task_plan:tOver').reasons[0].days], [1, 2, 5, 3]);
  assert.ok(!r.suggestions.some(s => ['tPlanned', 'tLow', 'tFar', 'tO1', 'tC1', 'tA0'].includes(s.taskId) && s.type !== 'window'), 'planned / low / far / done tasks are not suggested');
  await inGo(page, 'intel');
  const card = page.locator('[data-intel="task_plan:tOver"]');
  assert.match(await card.innerText(), /Naplánovat úkol po termínu „Faktura“[\s\S]*Po termínu 3 dny · Priorita: Vysoká · Zatím bez plánovaného bloku[\s\S]*Proč:[\s\S]*Termín úkolu byl Ne 20\. 9\. – po termínu 3 dny\./);
  await card.locator('[data-in-act="plan"]').click();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#pb_title').value, !!document.querySelector('.sheet'), S.plannerBlocks.length]), ['Faktura', true, 14], 'the existing planner form, prefilled; nothing saved yet');
  await page.evaluate(() => closeSheets()); assert.equal(await inState(page), before);
}, { state: fixtureState() });

test('IN2 deadline risk: facts only (deadline in X days, open tasks / milestones, planned blocks) for active goals below 100 % within 14 days or past; no prediction', async ({ page }) => {
  await inSeed(page);
  const r = await inRun(page), gO = r.suggestions.find(s => s.id === 'deadline:gO'), gA = r.suggestions.find(s => s.id === 'deadline:gA');
  assert.deepEqual([gO.rank, gO.group, gO.reasons[0]], [1, 'attention', { r: 'g_overdue', days: 2, date: '2026-09-21' }]);
  assert.deepEqual([gA.rank, gA.reasons], [2, [{ r: 'g_due', days: 3, date: '2026-09-26' }, { r: 'g_pct', pct: 50 }, { r: 'g_open', tasks: 1, ms: 0 }, { r: 'g_planned', n: 0, min: 0 }]]);
  assert.ok(!r.suggestions.some(s => s.goalId === 'gE'), 'completed goals are left out');
  await inGo(page, 'intel'); const t = await page.locator('[data-intel="deadline:gA"]').innerText();
  assert.match(t, /Blíží se termín projektu „Web“[\s\S]*Termín projektu je So 26\. 9\. \(za 3 dny\)\.[\s\S]*Postup projektu: 50 %\.[\s\S]*Zbývá otevřených úkolů: 1, otevřených milníků: 0\.[\s\S]*V příštích 7 dnech k projektu není naplánovaný žádný blok\./);
  assert.doesNotMatch(await page.locator('#app').innerText(), /nestihneš|nestihnete|riziko selhání|špatně/i);
  await page.evaluate(() => { S.tasks.find(t => t.id === 'tA1').done = true; });
  assert.ok(!(await inRun(page)).suggestions.some(s => s.id === 'deadline:gA'), 'at 100 % there is nothing left to point at');
}, { state: fixtureState() });

test('IN3 goal without a next step: "Určit další krok" opens the existing task form with the goal chosen; nothing is saved until the user saves', async ({ page }) => {
  await inSeed(page); const before = await inState(page);
  const s = (await inRun(page)).suggestions.find(x => x.id === 'goal_next:gB');
  assert.deepEqual([s.rank, s.group, s.reasons.map(r => r.r), s.actions], [4, 'goals', ['g_nonext', 'g_open', 'g_planned'], ['addtask', 'goal', 'dismiss']]);
  await inGo(page, 'intel'); await page.locator('[data-intel="goal_next:gB"] [data-in-act="addtask"]').click();
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector('.sheet #f_title'), document.querySelector('.sheet #f_goal').value]), [true, 'gB']);
  await page.evaluate(() => closeSheets()); assert.equal(await inState(page), before);
  await page.locator('[data-intel="goal_next:gB"] [data-in-act="goal"]').click();
  assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gB']);
  await page.evaluate(() => S.tasks.push({ id: 'tB1', title: 'Osnova', goalId: 'gB', done: false, priority: 'Low', dueDate: '', category: 'Learning', createdAt: 1 }));
  assert.ok(!(await inRun(page)).suggestions.some(x => x.type === 'goal_next' && x.goalId === 'gB'), 'an open task is a next step');
}, { state: fixtureState() });

test('IN4 inactive goal: no recorded activity for 14 days (documented threshold) -> "dlouho neměl aktivitu"; 13 days is not enough', async ({ page }) => {
  await inSeed(page);
  const s = (await inRun(page)).suggestions.find(x => x.id === 'goal_idle:gC');
  assert.deepEqual([s.rank, s.reasons], [6, [{ r: 'g_idle', days: 20, date: '2026-09-03' }, { r: 'g_threshold', days: 14 }]]);
  assert.equal(await page.evaluate(() => INTEL.IDLE_DAYS), 14);
  for (const [d, on] of [[-13, false], [-14, true]]) {
    await page.evaluate(d => { S.xpLog[0].key = `task:tC0:${addDays(todayStr(), d)}`; S.xpLog = S.xpLog.slice(); }, d);
    assert.equal((await inRun(page)).suggestions.some(x => x.id === 'goal_idle:gC'), on, String(d));
  }
  await inGo(page, 'intel');
  assert.match(await page.locator('[data-intel="goal_idle:gC"]').innerText(), /Projekt „Jazyk“ dlouho neměl aktivitu[\s\S]*Poslední zaznamenaná aktivita u projektu: Čt 9\. 9\.|Projekt „Jazyk“ dlouho neměl aktivitu[\s\S]*po 14 dnech bez ní/);
}, { state: fixtureState() });

test('IN5 planner conflicts: block x block and block x event from the Weekly Planner detection (no second engine), touching blocks are not a conflict; nothing moves', async ({ page }) => {
  await inSeed(page); const before = await inState(page);
  const r = await inRun(page), c = r.suggestions.filter(s => s.type === 'conflict');
  assert.deepEqual(c.map(s => [s.id, s.blockId, s.reasons.filter(x => x.r === 'overlap').map(x => `${x.a.k}:${x.a.title}|${x.b.k}:${x.b.title}|${x.from}-${x.to}`)]),
    [['conflict:2026-09-25:pX2', 'pX2', ['block:Porada blok|block:Sprint|10:30-11:00']], ['conflict:2026-09-26:pX4', 'pX4', ['event:Trénink tým|block:Běh venku|18:30-19:00']]]);
  const wpCount = await page.evaluate(() => { const T = todayStr(); return wpBuild({ from: T, to: addDays(T, 6), days: Array.from({ length: 7 }, (_, i) => addDays(T, i)) }, T).days.reduce((a, d) => a + d.conflicts.length, 0); });
  assert.equal(wpCount, 2, 'the same pairs as the Weekly Planner');
  assert.ok(await page.evaluate(() => intelCompute.toString().includes('d.conflicts') && !/function\s+intel\w*Overlap/.test(document.documentElement.innerHTML)), 'reuses wpBuild/wpDayConflicts');
  assert.equal(c[0].proposal.startTime + '-' + c[0].proposal.endTime, '10:30-11:30');
  assert.equal(await inState(page), before, 'nothing moved');
}, { state: fixtureState() });

test('IN6 heavily planned day: >= 10 h / >= 8 blocks, or >= 6 h / >= 5 blocks at twice the other days (tested thresholds); facts: planned time, blocks, average, overlaps', async ({ page }) => {
  await inSeed(page);
  const s = (await inRun(page)).suggestions.find(x => x.type === 'overload');
  assert.deepEqual([s.id, s.rank, s.group, s.reasons], ['overload:2026-09-27', 7, 'planning', [{ r: 'd_planned', min: 480, blocks: 8 }, { r: 'd_avg', min: 40 }]]);
  assert.deepEqual(await page.evaluate(() => [INTEL.DAY_MIN, INTEL.DAY_BLOCKS, INTEL.DAY_MIN_REL, INTEL.DAY_BLOCKS_REL, INTEL.DAY_FACTOR]), [600, 8, 360, 5, 2]);
  const heavy = async n => { await page.evaluate(n => { S.plannerBlocks = S.plannerBlocks.filter(b => !/^pO/.test(b.id) || +b.id.slice(2) < n); }, n); return (await inRun(page)).suggestions.some(x => x.type === 'overload'); };
  assert.equal(await heavy(5), true, '5 blocks, more than twice the others'); assert.equal(await heavy(4), false, '4 h / 4 blocks');
  await inSeed(page); await inGo(page, 'intel');
  const t = await page.locator('[data-intel="overload:2026-09-27"]').innerText();
  assert.match(t, /Ne 27\. 9\.: výrazně vytížený den[\s\S]*V plánovači je na tento den 8 h v 8 blocích\.[\s\S]*Ostatní dny v příštích 7 dnech mají průměrně 40 min\./);
  assert.doesNotMatch(t, /špatně|přetížen|nezdrav|selh/i);
}, { state: fixtureState() });

test('IN7 empty planning window: the first day after today without planner blocks, offered for the most relevant unplanned task; never called free time', async ({ page }) => {
  await inSeed(page);
  const s = (await inRun(page)).suggestions.find(x => x.type === 'window');
  assert.deepEqual([s.id, s.taskId, s.reasons], ['window:2026-09-28', 'tOver', [{ r: 'w_empty', date: '2026-09-28', events: 0 }, { r: 'w_task', title: 'Faktura', n: 3 }]]);
  await inGo(page, 'intel'); const card = page.locator('[data-intel="window:2026-09-28"]'), t = await card.innerText();
  assert.match(t, /Po 28\. 9\. nemá žádné bloky v plánovači[\s\S]*nejsou evidované žádné bloky v plánovači\. Jestli je čas opravdu volný, aplikace neví\./);
  assert.doesNotMatch(await page.locator('#app').innerText(), /máš (volno|volný čas|čas)|volný čas je/i);
  await card.locator('[data-in-act="plan"]').click();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#pb_title').value, document.querySelector('#pb_date').value]), ['Faktura', '2026-09-28']);
  await page.evaluate(() => { closeSheets(); S.tasks.forEach(t => { if (!t.done) t.priority = 'Low'; t.dueDate = ''; }); });
  assert.ok(!(await inRun(page)).suggestions.some(x => x.type === 'window'), 'no important unplanned task = no window');
}, { state: fixtureState() });

test('IN8 weekly priority without a plan: a priority goal with no block and no task activity this week; a block in the week clears it; no XP', async ({ page }) => {
  await inSeed(page); const xp0 = await xpOf(page);
  const s = (await inRun(page)).suggestions.find(x => x.id === 'priority_plan:gD');
  assert.deepEqual([s.rank, s.group, s.reasons.map(r => r.r), s.actions], [3, 'goals', ['p_week', 'p_noblock', 'p_notask'], ['plantime', 'week', 'dismiss']]);
  await inGo(page, 'intel'); await page.locator('[data-intel="priority_plan:gD"] [data-in-act="plantime"]').click();
  await page.fill('#pb_start', '07:00'); await page.fill('#pb_end', '08:00'); await page.click('#pb_save'); await settle(page);
  assert.equal(await page.evaluate(() => view), 'intel', 'stays on Intelligence after saving');
  assert.ok(!(await inRun(page)).suggestions.some(x => x.id === 'priority_plan:gD'));
  assert.equal(await xpOf(page), xp0, 'no XP for planning');
  assert.deepEqual(await page.evaluate(() => S.weeklyPriorities), { '2026-09-21': ['gD'] }, 'priorities untouched');
}, { state: fixtureState() });

test('IN9 weekly priorities at / over the limit: facts only ("3/3", "4 uloženo, používá se 3"); the Weekly Planner limit stays the only rule', async ({ page }) => {
  await inSeed(page);
  const pl = async ids => { await page.evaluate(ids => { S.weeklyPriorities = { '2026-09-21': ids }; }, ids); const s = (await inRun(page)).suggestions.find(x => x.type === 'priority_limit'); return s ? [s.id, s.rank, s.reasons[0]] : null; };
  assert.equal(await pl(['gA', 'gD']), null);
  assert.deepEqual(await pl(['gA', 'gD', 'gB']), ['priority_limit:2026-09-21', 8, { r: 'p_full', n: 3, max: 3 }]);
  assert.deepEqual(await pl(['gA', 'gD', 'gB', 'gC']), ['priority_limit:2026-09-21', 8, { r: 'p_over', n: 4, max: 3 }]);
  assert.deepEqual(await page.evaluate(() => [wpPriorityIds('2026-09-21'), wpTogglePriority('2026-09-21', 'gO').reason]), [['gA', 'gD', 'gB'], 'max']);
  await inGo(page, 'intel');
  assert.match(await page.locator('[data-intel="priority_limit:2026-09-21"]').innerText(), /Priorit týdne je uloženo víc, než se používá[\s\S]*V datech je pro tento týden uloženo 4 priorit; týdenní plánovač používá první 3\./);
}, { state: fixtureState() });

test('IN10 reschedule: a task whose block passed unfinished gets a proposed day / time with nothing recorded; "Přesunout" opens the existing move form prefilled; saved only on confirm, links kept', async ({ page }) => {
  await inSeed(page);
  const s = (await inRun(page)).suggestions.find(x => x.id === 'reschedule:tPast');
  assert.deepEqual([s.entityType, s.blockId, s.rank, s.proposal, s.reasons.map(r => r.r)], ['block', 'pPast', 5, { date: '2026-09-24', startTime: '09:00', endTime: '10:00' }, ['due_in', 'past_block', 'slot']]);
  await inGo(page, 'intel'); const before = await inState(page);
  await page.locator('[data-intel="reschedule:tPast"] [data-in-act="move"]').click();
  const prop = await page.evaluate(() => { const s = intelCompute(new Date()).suggestions.find(x => x.id === 'reschedule:tPast'); return s.proposal; });
  assert.deepEqual(await page.evaluate(() => ['#mv_date', '#mv_start', '#mv_end'].map(q => document.querySelector(q).value).concat(!!document.querySelector('#mv_prop'))), [prop.date, prop.startTime, prop.endTime, true]);
  assert.equal(await inState(page), before, 'nothing moved before confirming');
  await page.click('#mv_save'); await settle(page);
  const b = await page.evaluate(() => S.plannerBlocks.find(x => x.id === 'pPast'));
  assert.deepEqual([b.date, b.startTime, b.endTime, b.taskId, b.title, b.completed], [prop.date, '09:00', '10:00', 'tPast', 'Report', false]);
  assert.ok(!(await inRun(page)).suggestions.some(x => x.taskId === 'tPast'), 'planned again');
  assert.equal((await idbState(page)).plannerBlocks.find(x => x.id === 'pPast').date, prop.date, 'saved through the existing persistence');
}, { state: fixtureState() });

test('IN11 duplicate suppression: one card per task / goal / block-day; the other facts join it (overdue + High + unplanned = one card; deadline + no next step + idle = one card)', async ({ page }) => {
  await inSeed(page);
  await page.evaluate(() => { S.goals.find(g => g.id === 'gB').targetDate = addDays(todayStr(), 5); S.plannerBlocks.push({ id: 'pX5', date: addDays(todayStr(), 2), startTime: '11:00', endTime: '11:45', title: 'Hovor', category: 'Work', completed: false, createdAt: 1 }); });
  const r = await inRun(page), gB = r.suggestions.filter(s => s.goalId === 'gB'), tOver = r.suggestions.filter(s => s.taskId === 'tOver' && s.type !== 'window');
  assert.deepEqual(gB.map(s => [s.type, s.also.map(a => a.type)]), [['deadline', ['goal_next', 'goal_idle']]]);
  assert.equal(tOver.length, 1);
  const pX2 = r.suggestions.filter(s => s.blockId === 'pX2');
  assert.deepEqual(pX2.map(s => s.reasons.filter(x => x.r === 'overlap').length), [1]);
  const keys = r.suggestions.map(s => s.key); assert.equal(new Set(keys).size, keys.length);
  await inGo(page, 'intel');
  assert.match(await page.locator('[data-intel="deadline:gB"]').innerText(), /Termín projektu je Po 28\. 9\.[\s\S]*Projekt nemá otevřený úkol, otevřený milník ani nadcházející blok[\s\S]*Od založení projektu/);
}, { state: fixtureState() });

test('IN12 + IN13 deterministic ids and order: type:entity[:date]; the same order whatever the input order', async ({ page }) => {
  await inSeed(page);
  const ids = (await inRun(page)).suggestions.map(s => s.id);
  assert.deepEqual(ids, IN_ORDER);
  await page.evaluate(() => { S.tasks.reverse(); S.goals.reverse(); S.plannerBlocks.reverse(); S.events.reverse(); });
  assert.deepEqual((await inRun(page)).suggestions.map(s => s.id), IN_ORDER, 'input order does not matter');
  assert.deepEqual(await page.evaluate(() => INTEL_RANK), { conflict: 1, deadline: 2, priority_plan: 3, goal_next: 4, task_plan: 5, reschedule: 5, goal_idle: 6, overload: 7, window: 8, priority_limit: 8 });
}, { state: fixtureState() });

test('IN14 Home "Doporučení": at most 3 cards below "Co teď?", group in words, "Vše (n)" opens Intelligence; hiding a card shows the next one', async ({ page }) => {
  await inSeed(page); await page.evaluate(() => { view = 'home'; render(); });
  const r = await page.evaluate(() => ({ n: document.querySelectorAll('#ccIntel [data-intel]').length, order: [...document.querySelectorAll('.cc-home > *')].map(n => n.id || n.className).join(','),
    all: document.querySelector('#ccIntel [data-nav="intel"]').textContent, first: document.querySelector('#ccIntel [data-intel]').innerText }));
  assert.equal(r.n, 3); assert.match(r.all, /Vše \(13\)/); assert.ok(r.order.indexOf('ccNow') < r.order.indexOf('ccIntel') && r.order.indexOf('ccIntel') < r.order.indexOf('ccTimeline'), r.order);
  assert.match(r.first, /Vyžaduje pozornost[\s\S]*Naplánovat úkol po termínu „Faktura“[\s\S]*Naplánovat[\s\S]*Zobrazit úkol[\s\S]*Skrýt/);
  const before = await inState(page);
  await page.click('#ccIntel [data-intel="task_plan:tOver"] [data-in-dismiss]');
  assert.deepEqual(await page.$$eval('#ccIntel [data-intel]', ns => ns.map(n => n.dataset.intel)), ['deadline:gO', 'conflict:2026-09-25:pX2', 'conflict:2026-09-26:pX4']);
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-intel]') && document.activeElement.closest('[data-intel]').dataset.intel), 'deadline:gO', 'focus moves to the next card');
  assert.equal(await inState(page), before, 'hiding writes nothing to S');
  await page.click('#ccIntel [data-nav="intel"]'); assert.equal(await page.evaluate(() => view), 'intel');
}, { state: fixtureState() });

test('IN15 Intelligence screen: groups Vyžaduje pozornost / Plánování / Projekty, at most 20 cards + "+ N dalších"; the engine caps 40 per type and 100 in total', async ({ page }) => {
  await inSeed(page); await inGo(page, 'intel');
  assert.deepEqual(await page.$$eval('.in-group h3', hs => hs.map(h => h.textContent.trim())), ['Vyžaduje pozornost · 6', 'Plánování · 4', 'Projekty · 3']);
  await page.evaluate(() => { for (let i = 0; i < 150; i++) S.tasks.push({ id: 'tz' + String(i).padStart(3, '0'), title: 'Úkol ' + i, priority: 'Urgent', dueDate: addDays(todayStr(), -1 - (i % 9)), done: false, category: 'Work', createdAt: 1 }); });
  const r = await inRun(page);
  assert.deepEqual([r.counts.task_plan > 40, r.suggestions.filter(s => s.type === 'task_plan').length, r.suggestions.length <= 100], [true, 40, true]);
  await inGo(page, 'intel');
  assert.equal(await page.locator('#app [data-intel]').count(), 20);
  assert.match(await page.locator('#inMore').innerText(), new RegExp(`\\+ ${r.suggestions.length - 20} dalších`));
  await page.click('#inMore'); assert.equal(await page.locator('#app [data-intel]').count(), r.suggestions.length);
}, { state: fixtureState() });

test('IN16 no mutation: computing, opening Intelligence / Home, the minute tick, hiding and a reload change nothing in S or IndexedDB', async ({ page }) => {
  await inSeed(page); await persist(page);
  const a0 = await inState(page), idb0 = await idbState(page);
  for (let i = 0; i < 3; i++) await inRun(page);
  await inGo(page, 'intel'); await inGo(page, 'home'); await page.evaluate(() => { uiMinuteTick(); uiCcTick(document.getElementById('app')); });
  await page.click('#ccIntel [data-in-dismiss]'); await inGo(page, 'intel'); await settle(page);
  assert.equal(await inState(page), a0); assert.deepEqual(await idbState(page), idb0);
  await page.reload(); await ownerReady(page); await page.evaluate(() => { closeSheets(); view = 'intel'; render(); }); await settle(page);
  await injectRawIdb(page); assert.deepEqual(await idbState(page), idb0, 'after a reload IndexedDB is the same');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#app [data-intel]').length), IN_ORDER.length - 1, 'the hidden card stays hidden in this tab after a reload');
  // the hide list lives only in this tab's sessionStorage: not in localStorage, not in the stored state, not in a new tab (a new session)
  assert.deepEqual(await page.evaluate(() => [JSON.parse(sessionStorage.getItem('lifeos.intel.hidden')).length, localStorage.length, /intel/i.test(Object.keys(S).join())]), [1, 0, false]);
  const errs = [], B = await extraTab(page, errs);
  assert.equal(await B.evaluate(() => sessionStorage.getItem('lifeos.intel.hidden')), null, 'a new session starts with nothing hidden');
  await B.close();
}, { state: fixtureState() });

test('IN17-IN20 XP, level, attributes, Daily Score and quests stay the same when suggestions are computed, hidden, opened and accepted', async ({ page }) => {
  await inSeed(page); await persist(page);
  const snap = () => page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.quests, S.achievementsUnlocked, S.dailyScores, dailyScore(todayStr()), document.querySelector('.hud-lvl, .lvl') ? 1 : 0]));
  const s0 = await snap();
  await inGo(page, 'intel'); await page.click('[data-intel="window:2026-09-28"] [data-in-dismiss]');
  await page.click('[data-intel="task_plan:tOver"] [data-in-act="plan"]'); await page.fill('#pb_start', '08:00'); await page.fill('#pb_end', '09:00'); await page.click('#pb_save'); await settle(page);
  await page.click('[data-intel="goal_idle:gC"] [data-in-act="goal"]'); await inGo(page, 'home'); await page.evaluate(() => uiCcTick(document.getElementById('app'))); await settle(page);
  assert.equal(await snap(), s0);
  assert.equal(await page.evaluate(() => S.plannerBlocks.filter(b => b.taskId === 'tOver').length), 1, 'the only change: the block the user saved');
}, { state: fixtureState() });

test('IN21 export / import unchanged: no new key, hidden suggestions are not in the backup, a round trip restores exactly and the suggestions are the same', async ({ page }) => {
  await inSeed(page); await persist(page); await inGo(page, 'intel'); await page.click('[data-intel="goal_idle:gC"] [data-in-dismiss]');
  const ids0 = (await inRun(page)).suggestions.map(s => s.id);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(exported, await stateOf(page)); assert.equal(exported.schemaVersion, 8);
  assert.deepEqual(Object.keys(exported).filter(k => /intel|suggest|dismiss|hidden/i.test(k)), []);
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(await page.evaluate(() => defaultState())).sort(), 'the same top-level keys as before');
  await page.evaluate(() => { S.tasks = []; }); await importFile(page, await dl.path()); await settle(page);
  assert.deepEqual(await stateOf(page), exported);
  assert.deepEqual((await inRun(page)).suggestions.map(s => s.id), ids0);
}, { state: fixtureState() });

test('IN22 old state compatibility: a schemaVersion-4 state (no plannerBlocks, weeklyPriorities, goal fields) computes cleanly; broken references are ignored', async ({ page }) => {
  const r = await page.evaluate(() => { S = migrate({ tasks: [{ id: 'lt', title: 'Starý', dueDate: '2026-09-20', done: false, priority: 'High', goalId: 'nope' }, { id: 'lt2', title: 'Bez data' }],
    goals: [{ id: 'lg', title: 'Starý projekt', status: 'Active', targetDate: '2026-09-30' }], habits: [], xpLog: [], totalXp: 0, schemaVersion: 4 }); S.settings.onboarded = true;
    S.plannerBlocks.push({ id: 'lb', date: '2026-09-24', startTime: 'xx', endTime: '', title: 'Rozbitý', taskId: 'missing' });
    const res = intelCompute(new Date('2026-09-23T12:00')); return [S.schemaVersion, res.suggestions.map(s => s.id), JSON.stringify(res).includes('NaN')]; });
  assert.equal(r[0], 8); assert.equal(r[2], false); assert.ok(r[1].includes('task_plan:lt') && r[1].includes('deadline:lg'), r[1].join());
  await page.evaluate(() => { view = 'intel'; render(); }); assert.deepEqual(await inClean(page), { bad: false, dup: [], overflow: 0 });
}, { state: fixtureState() });

test('IN23 no duplicate suggestions and no duplicate DOM ids: fixture, seed, empty state and a large state', async ({ page }) => {
  const check = async label => { const r = await inRun(page), ids = r.suggestions.map(s => s.id); assert.equal(new Set(ids).size, ids.length, label);
    for (const v of ['intel', 'home']) { await inGo(page, v); assert.deepEqual(await inClean(page), { bad: false, dup: [], overflow: 0 }, label + '/' + v); } };
  await check('fixture'); await inSeed(page); await check('seed');
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; }); await check('empty');
  await inGo(page, 'intel'); assert.match(await page.locator('#app').innerText(), /Momentálně nejsou žádná doporučení\./);
  await withGen(page); await page.evaluate(() => { Object.assign(S, window.__gen(1500, 25000, 3)); }); await check('large');
}, { state: fixtureState() });

test('IN24 exact dates: due today / in 7 days counts, in 8 days not; a goal deadline in 14 days counts, 15 not; a block ending exactly now has passed; month boundary', async ({ page }) => {
  await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; const T = '2026-09-23', D = n => addDays(T, n);
    S.tasks = [{ id: 'd0', title: 'Dnes', dueDate: T, done: false, priority: 'Low' }, { id: 'd7', title: 'Za 7', dueDate: D(7), done: false, priority: 'Low' }, { id: 'd8', title: 'Za 8', dueDate: D(8), done: false, priority: 'Low' },
      { id: 'dn', title: 'Blok končí teď', dueDate: D(1), done: false, priority: 'Low' }];
    S.goals = [{ id: 'g14', title: 'G14', status: 'Active', targetDate: D(14), mode: 'manual', manualProgress: 10, createdAt: new Date(T + 'T08:00').getTime() }, { id: 'g15', title: 'G15', status: 'Active', targetDate: D(15), mode: 'manual', manualProgress: 10, createdAt: new Date(T + 'T08:00').getTime() }];
    S.plannerBlocks = [{ id: 'bn', date: T, startTime: '11:00', endTime: '12:00', title: 'Blok končí teď', taskId: 'dn', completed: false }]; });
  const r = await inRun(page), has = id => r.suggestions.some(s => s.id === id);
  assert.deepEqual(['task_plan:d0', 'task_plan:d7', 'task_plan:d8', 'deadline:g14', 'deadline:g15', 'reschedule:dn'].map(has), [true, true, false, true, false, true]);
  assert.deepEqual(r.suggestions.find(s => s.id === 'task_plan:d0').reasons[0], { r: 'due_today', date: '2026-09-23' });
  const at1159 = await inRun(page, '2026-09-23T11:59:00'); assert.ok(!at1159.suggestions.some(s => s.taskId === 'dn'), 'at 11:59 the block is still upcoming');
  const m = await inRun(page, '2026-09-30T08:00:00'); assert.deepEqual([m.T, m.horizon], ['2026-09-30', { from: '2026-09-30', to: '2026-10-06' }]);
}, { state: fixtureState() });

test('IN25 fixed now: the same state + the same now give identical results; the engine reads no clock of its own', async ({ page }) => {
  await inSeed(page);
  const a = JSON.stringify(await inRun(page)), b = JSON.stringify(await inRun(page));
  assert.equal(a, b);
  assert.notEqual(JSON.stringify(await inRun(page, '2026-09-24T12:00:00')), a, 'another day, other facts');
  const src = await page.evaluate(() => [intelCompute, intelSlot, intelDay, intelOrder, intelGroup].map(f => f.toString()).join('\n'));
  assert.doesNotMatch(src, /todayStr\(|Date\.now|new Date\(\s*\)|Math\.random|performance\.now/);
}, { state: fixtureState() });

test('IN26 performance: 1 500 tasks, 25 000 XP, 40 habits, 25 goals, 100 milestones, 400 blocks, 300 meals, 300 sleep records, 150 workouts, 200 events', async ({ page }) => {
  const small = await page.evaluate(() => { const m = []; for (let i = 0; i < 7; i++) { const t = performance.now(); intelCompute(new Date()); m.push(performance.now() - t); } return m.sort((a, b) => a - b)[3]; });
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3)); const T = todayStr();
    for (let i = 0; i < 25; i++) S.goals.push({ id: 'pg' + i, title: 'Projekt ' + i, category: ['Work', 'Fitness', ''][i % 3], status: i % 5 ? 'Active' : 'Completed', targetDate: i % 4 ? addDays(T, i * 7 - 30) : '', mode: 'auto', createdAt: Date.now() - 200 * 86400000 });
    for (let i = 0; i < 100; i++) S.milestones.push({ id: 'pm' + i, goalId: 'pg' + (i % 25), title: 'M' + i, targetDate: addDays(T, i - 50), completed: i % 3 === 0, completedAt: i % 3 === 0 ? Date.now() - i * 86400000 : null, createdAt: 1 });
    S.tasks.forEach((t, i) => { if (i % 5 === 0) t.goalId = 'pg' + (i % 25); if (i % 7 === 0) { t.done = false; t.dueDate = addDays(T, (i % 20) - 10); } });
    for (let i = 0; i < 40; i++) S.habits.push({ id: 'ph' + i, name: 'Rutina ' + i, type: i % 9 ? 'good' : 'bad', frequency: ['daily', 'weekdays', 'weekly'][i % 3], weekdays: [1, 3, 5], target: 1, goalId: i % 4 ? '' : 'pg' + (i % 25), completions: [], brokenDates: [], active: true, startDate: addDays(T, -300) });
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, (i % 60) - 30), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':30', title: 'Blok ' + i, category: 'Work', taskId: i % 3 ? '' : S.tasks[i * 3].id, goalId: i % 4 ? '' : 'pg' + (i % 25), completed: i % 2 === 0 });
    for (let i = 0; i < 300; i++) { const d = addDays(T, -i); S.meals.push({ id: 'pm' + i, name: 'J', date: d, type: 'Lunch', calories: 500, servings: 1 }); S.sleepLog.push({ id: 'ps' + i, date: d, bedtime: '23:00', wake: '07:00' }); }
    for (let i = 0; i < 150; i++) S.workouts.push({ id: 'pw' + i, name: 'Push', date: addDays(T, -i * 2), status: 'done', startedAt: new Date(addDays(T, -i * 2) + 'T17:00').getTime(), finishedAt: new Date(addDays(T, -i * 2) + 'T18:00').getTime(), entries: [] });
    for (let i = 0; i < 200; i++) S.events.push({ id: 'pe' + i, title: 'Událost ' + i, date: addDays(T, (i % 120) - 90), start: String(8 + i % 10).padStart(2, '0') + ':00', end: String(9 + i % 10).padStart(2, '0') + ':00', recurring: ['none', 'weekly', 'none', 'monthly'][i % 4] });
    S.weeklyPriorities = { [weekStartOf(T)]: ['pg1', 'pg2'] };
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    const res = intelCompute(new Date());
    const out = { intel: m(() => intelCompute(new Date()), 7), homeIntel: m(() => { S.settings.widgets.intel = true; view = 'home'; render(); }, 5), homeNoIntel: m(() => { S.settings.widgets.intel = false; view = 'home'; render(); }, 5),
      screen: m(() => { view = 'intel'; render(); }, 5), week: m(() => { wpOffset = 0; view = 'week'; render(); }, 5), analytics: m(() => { statsPeriod = 'month'; view = 'statistics'; render(); }, 3) };
    S.settings.widgets.intel = true; out.n = res.suggestions.length; out.bad = (view = 'intel', render(), /undefined|NaN/.test(document.getElementById('app').innerText)); return out; });
  console.log(`      IN26 intel small ${small.toFixed(1)} ms, ` + Object.entries(r).filter(([k]) => !['bad', 'n'].includes(k)).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ') + `, suggestions ${r.n}`);
  assert.ok(!r.bad); assert.ok(r.n > 0 && r.n <= 100);
  assert.ok(small < 20 && r.intel < 30, 'intelligence well under 50 ms');
  assert.ok(r.homeIntel - r.homeNoIntel < 30 && r.screen < 80 && r.week < 80, 'Home / screen / week stay fast');
}, { state: fixtureState() });

test('IN27 Command Center stays the source of "Co teď?": its ranking and card are identical with Intelligence on and off; no weeklyPriorities / intel input in it', async ({ page }) => {
  await inSeed(page);
  const cc = on => page.evaluate(on => { S.settings.widgets.intel = on; view = 'home'; render(); return JSON.stringify(ccRank(ccCandidates(ccContext())).map(c => [c.kind, c.id, c.score])) + document.querySelector('#ccNow').outerHTML; }, on);
  const a = await cc(true), b = await cc(false);
  assert.equal(a, b);
  assert.equal(await page.evaluate(() => /intel/i.test(ccCandidates.toString() + ccRank.toString() + ccNow.toString())), false);
  assert.equal(await page.locator('#ccIntel').count(), 0, 'Settings -> Doporučení off hides the section');
  await page.click('#settingsBtn');
  const row = page.locator('[data-smart="intel"]'); assert.equal(await row.count(), 1);
  await row.click(); assert.equal(await page.evaluate(() => S.settings.widgets.intel), true);
}, { state: fixtureState() });

test('IN28 320-1440 px, light + dark: no horizontal scroll, full-width cards, 44 px targets, WCAG AA text, SVG icons (no emoji); Home, Intelligence and the move sheet', async ({ page }) => {
  await inSeed(page); const bad = [];
  for (const w of [320, 360, 375, 390, 430, 768, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const v of ['intel', 'home']) {
      await page.evaluate(([v, theme]) => { closeSheets(); S.settings.theme = theme; applyTheme(); uiInAll = false; view = v; render(); }, [v, theme]);
      const c = await inClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/${theme}/${v}: ${JSON.stringify(c)}`);
      const r = await page.evaluate(() => { const out = [];
        const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
        const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
        const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
        const bgOf = el => { const st = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (/gradient/.test(cs.backgroundImage) && e.matches('.btn:not(.ghost):not(.danger)')) return { r: 110, g: 80, b: 240, a: 1 }; const c = parse(cs.backgroundColor); if (c && c.a > 0) { st.push(c); if (c.a >= 1) break; } } let bg = parse(getComputedStyle(document.body).backgroundColor); for (let i = st.length - 1; i >= 0; i--) bg = blend(st[i], bg); return bg; };
        const root = document.querySelector('.in') || document.querySelector('#ccIntel');
        root.querySelectorAll('*').forEach(e => { if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return; const cs = getComputedStyle(e); if (cs.display === 'none' || e.closest('[aria-hidden="true"],.hide,[hidden]')) return;
          const fg0 = parse(cs.color); if (!fg0) return; const bg = bgOf(e), fg = blend(fg0, bg), L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05), size = parseFloat(cs.fontSize), need = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700) ? 3 : 4.5;
          if (ratio < need) out.push(`contrast "${e.textContent.trim().slice(0, 20)}" ${ratio.toFixed(2)}`); });
        root.querySelectorAll('button, a').forEach(n => { const b = n.getBoundingClientRect(); if (n.offsetParent && (b.height < 44 || b.width < 44)) out.push(`small ${n.className} ${Math.round(b.width)}x${Math.round(b.height)}`); });
        root.querySelectorAll('h3, h4, button, .in-k').forEach(n => { if (/\p{Extended_Pictographic}/u.test(n.textContent)) out.push('emoji ' + n.textContent.trim().slice(0, 20)); });
        const cards = [...root.querySelectorAll('.in-card')]; const wr = root.getBoundingClientRect(); if (cards.some(c => c.getBoundingClientRect().width < wr.width - 2)) out.push('card not full width');
        return out; });
      r.slice(0, 3).forEach(x => bad.push(`${w}/${theme}/${v}: ${x}`));
    }
    if (w === 320 || w === 1440) { await page.evaluate(() => { view = 'intel'; render(); }); await page.click('[data-intel="reschedule:tPast"] [data-in-act="move"]');
      const o = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (o > 0) bad.push(`${w}/${theme} move sheet overflow ${o}`); await page.evaluate(() => closeSheets()); }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('IN29 accessibility: named sections and lists, semantic buttons with names, "Skrýt" names its card, keyboard use, visible focus, no hover-only actions, reduced motion', async ({ page }) => {
  await inSeed(page); await inGo(page, 'intel');
  const r = await page.evaluate(() => ({ secs: [...document.querySelectorAll('.in section[aria-labelledby]')].filter(s => !document.getElementById(s.getAttribute('aria-labelledby'))).length,
    groups: document.querySelectorAll('.in-group > ul.in-list > li.in-card').length, unnamed: [...document.querySelectorAll('.in button')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).length,
    skip: document.querySelector('[data-intel="goal_idle:gC"] [data-in-dismiss]').getAttribute('aria-label'), divBtn: document.querySelectorAll('.in [onclick]:not(button)').length,
    hover: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } }).filter(r => /\.in[-\w]*:hover[^{]*\{[^}]*(display|visibility|opacity)/.test(r.cssText)).length,
    moving: [...document.querySelectorAll('.in, .in *')].filter(n => { const cs = getComputedStyle(n); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 || parseFloat(cs.transitionDuration) > 0.01; }).length }));
  assert.deepEqual([r.secs, r.groups, r.unnamed, r.divBtn, r.hover, r.moving], [0, 13, 0, 0, 0, 0]);
  assert.equal(r.skip, 'Skrýt doporučení: Projekt „Jazyk“ dlouho neměl aktivitu');
  await page.focus('[data-intel="goal_idle:gC"] [data-in-act="goal"]');
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== 'none'; });
  assert.ok(ring, 'visible focus');
  await page.keyboard.press('Enter'); assert.deepEqual(await page.evaluate(() => [view, currentGoalId]), ['goalDetail', 'gC']);
  await inGo(page, 'intel'); await page.focus('[data-intel="goal_idle:gC"] [data-in-dismiss]'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-intel]') ? document.activeElement.closest('[data-intel]').dataset.intel : document.activeElement.id), 'goal_next:gB', 'the hidden card was the last one: focus goes to the card now in its place (the last)');
  await page.click('#inRestore'); assert.equal(await page.locator('[data-intel="goal_idle:gC"]').count(), 1, 'hidden cards can be shown again');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'inTitle');
}, { state: fixtureState() });

test('IN30 navigation + existing views untouched: More -> Intelligence; Weekly Planner, Goals, Planner and Analytics read the same; the planner form still opens the Planner from elsewhere', async ({ page }) => {
  await inSeed(page);
  const snap = () => page.evaluate(() => { const w = wpWeek(0); return JSON.stringify([wpSummary(w), wpGoals(w).map(x => [x.g.id, x.blocks, x.minutes]), wpUnplanned(w).list.map(t => t.id), gpOverview('All').cards.map(c => [c.g.id, c.next && c.next.id]),
    anAnalyze(getAnalyticsRange('week', todayStr())).planner]); });
  const a = await snap(); await inGo(page, 'intel'); await inGo(page, 'home'); assert.equal(await snap(), a);
  await page.evaluate(() => { view = 'more'; render(); });
  assert.deepEqual(await page.$$eval('.more-section:first-of-type [data-v]', ns => ns.map(n => n.dataset.v).slice(0, 4)), ['calendar', 'goals', 'week', 'intel'], 'Reality QA: Kalendář (with the planner) and Projekty lead the group');
  await page.click('.more-section [data-v="intel"]'); assert.equal(await page.evaluate(() => view), 'intel');
  await page.evaluate(() => { view = 'tasks'; render(); openPlannerForm(null, { date: todayStr(), title: 'Z úkolů' }); }); await page.fill('#pb_start', '20:00'); await page.fill('#pb_end', '21:00'); await page.click('#pb_save');
  assert.equal(await page.evaluate(() => [view, uiCalMode].join()), 'calendar,today', 'outside Intelligence the existing behaviour is kept (Reality QA: the planner is the Calendar day)');
}, { state: fixtureState() });


// ---------- Reality QA pass (RQ) ----------
// fixture day 2026-09-23 (Wednesday); the calendar helpers are checked with fixed dates
const rqState = page => page.evaluate(() => JSON.stringify(S));
const rqClean = page => page.evaluate(() => { const t = document.getElementById('app').innerText, ids = {}; document.querySelectorAll('[id]').forEach(n => ids[n.id] = (ids[n.id] || 0) + 1);
  return { bad: /undefined|NaN|Infinity|\[object/.test(t), dup: Object.keys(ids).filter(k => ids[k] > 1), overflow: document.documentElement.scrollWidth - innerWidth }; });
const rqCal = (page, mode, day) => page.evaluate(([m, d]) => { closeSheets(); uiCalMode = m; uiCalDay = d || todayStr(); calOffset = 0; view = 'calendar'; render(); window.scrollTo(0, 0); }, [mode, day || null]);
const rqBlocks = page => page.evaluate(() => {
  const B = (id, o) => Object.assign({ id, date: '2026-09-23', startTime: '09:00', endTime: '10:00', title: id, category: 'Work', taskId: '', goalId: '', notes: '', completed: false, createdAt: 1 }, o);
  S.plannerBlocks = [B('b1', { title: 'Workout', category: 'Fitness' }), B('b2', { title: 'Doktor', startTime: '09:00', endTime: '09:30', category: 'Health' }), B('b3', { title: 'Projekt', startTime: '09:15', endTime: '10:15', goalId: 'g1' }),
    B('trip', { title: 'Výlet', date: '2026-09-25', endDate: '2026-09-27', startTime: '18:00', endTime: '10:00', category: 'Personal' })];
});

test('RQ1 multi-day block: one record from start to end, a part on every day it covers; duration over days; month and week show it', async ({ page }) => {
  const r = await page.evaluate(() => { S.plannerBlocks = [];
    const res = plannerSaveBlock({ title: 'Výlet', date: '2026-09-25', endDate: '2026-09-27', startTime: '18:00', endTime: '10:00', category: 'Personal' });
    return { ok: res.ok, n: S.plannerBlocks.length, rec: [res.block.date, res.block.endDate, res.block.startTime, res.block.endTime], dur: plannerDuration(res.block),
      days: ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map(D => plannerBlocksOn(D).map(b => `${b.startTime}-${b.endTime}${b._occ && !b._occ.first ? '<' : ''}${b._occ && !b._occ.last ? '>' : ''}`).join()) }; });
  assert.deepEqual(r, { ok: true, n: 1, rec: ['2026-09-25', '2026-09-27', '18:00', '10:00'], dur: 40 * 60, days: ['', '18:00-24:00>', '00:00-24:00<>', '00:00-10:00<', ''] });
  await rqCal(page, 'month', '2026-09-26');
  assert.equal(await page.locator('.mc-day[data-day="2026-09-26"] .mc.is-cont').count(), 1, 'the month shows the continuing day');
  await page.setViewportSize({ width: 1280, height: 900 }); await rqCal(page, 'week', '2026-09-25');
  assert.equal(await page.locator('.cg-it[data-id="' + (await page.evaluate(() => S.plannerBlocks[0].id)) + '"]').count(), 3, 'three parts in the week grid');
}, { state: fixtureState() });

test('RQ2 across midnight + validation: 22:00 -> 06:00 next day is valid; same-day end before start and an end date before the start are refused', async ({ page }) => {
  const r = await page.evaluate(() => { S.plannerBlocks = [];
    const ok = plannerSaveBlock({ title: 'Noc', date: '2026-09-23', endDate: '2026-09-24', startTime: '22:00', endTime: '06:00' });
    const bad1 = plannerSaveBlock({ title: 'X', date: '2026-09-23', startTime: '10:00', endTime: '09:00' });
    const bad2 = plannerSaveBlock({ title: 'X', date: '2026-09-23', endDate: '2026-09-22', startTime: '10:00', endTime: '11:00' });
    const bad3 = plannerSaveBlock({ title: 'X', date: '2026-09-23', startTime: '24:00', endTime: '24:00' });
    return [ok.ok, plannerDuration(ok.block), plannerBlocksOn('2026-09-24').map(b => b.startTime + '-' + b.endTime).join(), bad1.errors, bad2.errors, !!bad3.errors.startTime, S.plannerBlocks.length]; });
  assert.deepEqual(r, [true, 480, '00:00-06:00', { endTime: 'end_before_start' }, { endDate: 'end_before_start' }, true, 1]);
  await page.evaluate(() => { view = 'calendar'; render(); openPlannerForm(null, { date: '2026-09-23' }); });
  await page.fill('#pb_title', 'Směna'); await page.fill('#pb_start', '22:00'); await page.fill('#pb_enddate', '2026-09-24'); await page.fill('#pb_end', '06:00'); await page.click('#pb_save');
  assert.deepEqual(await page.evaluate(() => { const b = S.plannerBlocks.find(x => x.title === 'Směna'); return [b.date, b.endDate, b.startTime, b.endTime]; }), ['2026-09-23', '2026-09-24', '22:00', '06:00']);
}, { state: fixtureState() });

test('RQ3 + RQ4 drag & drop: move by time and to another day, resize the end (5-min snap); links and category stay; saved once on release', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 }); await rqBlocks(page);
  await page.evaluate(() => { S.plannerBlocks.find(b => b.id === 'b3').taskId = 't1'; }); await persist(page);
  await rqCal(page, 'today', '2026-09-23');
  const it = page.locator('.cg-it[data-id="b3"]'), bb = await it.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 12); await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 12 + 20, { steps: 3 });
  assert.equal(await page.evaluate(() => S.plannerBlocks.find(b => b.id === 'b3').startTime), '09:15', 'nothing is written while dragging');
  await page.mouse.move(bb.x + bb.width / 2, bb.y + 12 + 45, { steps: 3 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => { const b = S.plannerBlocks.find(x => x.id === 'b3'); return [b.startTime, b.endTime, b.taskId, b.goalId, b.category]; }), ['10:00', '11:00', 't1', 'g1', 'Work']);
  const rs = page.locator('.cg-it[data-id="b3"] .cg-rs'), rb = await rs.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2); await page.mouse.down(); await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 + 30, { steps: 4 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => { const b = S.plannerBlocks.find(x => x.id === 'b3'); return [b.startTime, b.endTime]; }), ['10:00', '11:30']);
  await rqCal(page, 'week', '2026-09-23');
  await page.locator('.cg-it[data-id="b3"]').scrollIntoViewIfNeeded();
  const w = page.locator('.cg-it[data-id="b3"]'), wb = await w.boundingBox(), col = await page.locator('.cg-col[data-day="2026-09-24"]').boundingBox();
  await page.mouse.move(wb.x + wb.width / 2, wb.y + 10); await page.mouse.down(); await page.mouse.move(col.x + col.width / 2, wb.y + 10, { steps: 8 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => { const b = S.plannerBlocks.find(x => x.id === 'b3'); return [b.date, b.startTime, b.endTime]; }), ['2026-09-24', '10:00', '11:30']);
  await settle(page); assert.equal((await idbState(page)).plannerBlocks.find(b => b.id === 'b3').date, '2026-09-24', 'saved');
  // the whole multi-day block moves by the same shift when a middle part is dragged
  const t = page.locator('.cg-it[data-id="trip"][data-day="2026-09-26"]'), tb = await t.boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 200); await page.mouse.down(); await page.mouse.move(tb.x + tb.width / 2, tb.y + 260, { steps: 6 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => { const b = S.plannerBlocks.find(x => x.id === 'trip'); return [b.date, b.startTime, b.endDate, b.endTime]; }), ['2026-09-25', '19:00', '2026-09-27', '11:00']);
}, { state: fixtureState() });

test('RQ5 overlapping items: several at the same time are allowed, shown side by side and listed as overlaps; nothing refuses the save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await rqBlocks(page); await rqCal(page, 'today', '2026-09-23');
  const lefts = await page.$$eval('.cg-col .cg-it[data-kind="block"]', ns => ns.filter(n => ['b1', 'b2', 'b3'].includes(n.dataset.id)).map(n => Math.round(n.getBoundingClientRect().left)));
  assert.equal(new Set(lefts).size, 3, 'three columns');
  assert.equal(await page.evaluate(() => wpWeek(0).days.find(d => d.date === '2026-09-23').conflicts.length), 3);
  assert.equal(await page.evaluate(() => plannerSaveBlock({ title: 'Další', date: '2026-09-23', startTime: '09:00', endTime: '10:00' }).ok), true);
}, { state: fixtureState() });

test('RQ6 repeating blocks: daily / weekdays / weekly / chosen days / monthly / until; each occurrence completed on its own', async ({ page }) => {
  const r = await page.evaluate(() => { S.plannerBlocks = [];
    const mk = (title, repeat) => plannerSaveBlock({ title, date: '2026-09-21', startTime: '07:00', endTime: '07:30', repeat }).block.id;
    const ids = { d: mk('D', { freq: 'daily', until: '2026-09-24' }), wd: mk('WD', { freq: 'weekdays' }), w: mk('W', { freq: 'weekly' }), days: mk('DAYS', { freq: 'days', days: [2, 4] }), m: mk('M', { freq: 'monthly' }) };
    const on = D => plannerBlocksOn(D).map(b => b.title).sort().join('');
    const bad = plannerSaveBlock({ title: 'X', date: '2026-09-21', startTime: '07:00', endTime: '07:30', repeat: { freq: 'days', days: [] } }).errors;
    plannerToggleCompleted(ids.d, '2026-09-22');
    return { mon: on('2026-09-21'), tue: on('2026-09-22'), thu: on('2026-09-24'), fri: on('2026-09-25'), sat: on('2026-09-26'), next: on('2026-09-28'), month: on('2026-10-21'), bad,
      done: ['2026-09-21', '2026-09-22'].map(D => plannerBlocksOn(D).find(b => b.title === 'D').completed), rec: S.plannerBlocks.find(b => b.title === 'D').doneDates }; });
  assert.deepEqual(r, { mon: 'DMWWD', tue: 'DDAYSWD', thu: 'DDAYSWD', fri: 'WD', sat: '', next: 'WWD', month: 'MWD', bad: { repeat: 'required' }, done: [false, true], rec: ['2026-09-22'] });
}, { state: fixtureState() });

test('RQ7 routine into the calendar: + -> Rutina plans an occurrence (block with habitId); the routine itself is not copied or checked', async ({ page }) => {
  const h0 = await page.evaluate(() => JSON.stringify(S.habits));
  await rqCal(page, 'today', '2026-09-23'); await page.click('#calAdd'); await page.click('[data-add="routine"]');
  const h = await page.evaluate(() => S.habits.find(x => x.active !== false && x.type !== 'bad'));
  await page.click(`.cal-pick[data-h="${h.id}"]`);
  assert.equal(await page.inputValue('#pb_title'), h.name);
  await page.fill('#pb_start', '07:00'); await page.fill('#pb_end', '07:30'); await page.click('#pb_save');
  const b = await page.evaluate(id => S.plannerBlocks.find(x => x.habitId === id), h.id);
  assert.deepEqual([b.date, b.startTime, b.endTime, b.title], ['2026-09-23', '07:00', '07:30', h.name]);
  assert.equal(await page.evaluate(() => JSON.stringify(S.habits)), h0, 'the routine definition and its check-ins are unchanged');
  assert.match(await page.locator('#calDayPanel .cal-rout').innerText(), new RegExp(`${h.name}[\\s\\S]*naplánováno 07:00`));
}, { state: fixtureState() });

test('RQ8 task into the calendar: + -> Úkol opens the task form with that day; a block can link a task (planner form)', async ({ page }) => {
  await rqCal(page, 'today', '2026-09-25'); await page.click('#calAdd'); await page.click('[data-add="task"]');
  assert.equal(await page.inputValue('.sheet #f_due'), '2026-09-25');
  await page.fill('.sheet #f_title', 'Z kalendáře'); await page.click('.sheet .btn:not(.ghost):not(.danger)');
  assert.equal(await page.evaluate(() => S.tasks.find(t => t.title === 'Z kalendáře').dueDate), '2026-09-25');
  const t = await page.evaluate(() => S.tasks.find(t => !t.done).id);
  await page.evaluate(id => { openPlannerForm(null, { date: '2026-09-25', taskId: id }); }, t);
  await page.fill('#pb_title', 'Práce na úkolu'); await page.click('#pb_save');
  assert.equal(await page.evaluate(() => S.plannerBlocks.find(b => b.title === 'Práce na úkolu').taskId), t);
}, { state: fixtureState() });

test('RQ9 events: old recurring events keep their dates; new weekdays / chosen days / until; every occurrence in the month; a dragged event moves its series', async ({ page }) => {
  const r = await page.evaluate(() => { S.events = [migrateEvent({ id: 'old', title: 'Old weekly', date: '2026-09-02', start: '08:00', end: '09:00', recurring: 'weekly' }),
      migrateEvent({ id: 'wd', title: 'Weekdays', date: '2026-09-21', start: '12:00', end: '12:30', recurring: 'weekdays', recurUntil: '2026-09-24' }),
      migrateEvent({ id: 'ds', title: 'Days', date: '2026-09-21', start: '18:00', recurring: 'days', recurDays: [1, 3] })];
    const on = D => calEventsOn(D).map(e => e.id).sort().join();
    return [on('2026-09-23'), on('2026-09-24'), on('2026-09-25'), on('2026-09-28'), eventUpcomingDate(S.events[0]), eventUpcomingDate(S.events[2])]; });
  assert.deepEqual(r, ['ds,old,wd', 'wd', '', 'ds', '2026-09-23', '2026-09-23']);
  await page.setViewportSize({ width: 1280, height: 900 }); await rqCal(page, 'month', '2026-09-23');
  assert.equal(await page.locator('.mc-grid .mc.is-event', { hasText: 'Old weekly' }).count(), 5, 'every Wednesday of September');
  await rqCal(page, 'today', '2026-09-23');
  await page.focus('.cg-it[data-id="old"]'); await page.keyboard.press('Alt+ArrowDown');
  assert.deepEqual(await page.evaluate(() => { const e = S.events.find(x => x.id === 'old'); return [e.date, e.start, e.end, e.recurring]; }), ['2026-09-02', '08:15', '09:15', 'weekly']);
}, { state: fixtureState() });

test('RQ10 one Calendar: Dnes / Týden / Měsíc; a day picked in the month shows its whole plan below; the Planner route opens the day view', async ({ page }) => {
  await rqCal(page, 'month');
  await page.click('.mc-day[data-day="2026-09-24"]');
  assert.match(await page.locator('#calDayPanel').innerText(), /Čtvrtek 24\. 9\./);
  await page.evaluate(() => uiOpenPlanner('2026-09-22'));
  assert.deepEqual(await page.evaluate(() => [view, uiCalMode, uiCalDay, !!document.querySelector('#calDayPanel .cg, #calDayPanel .card')]), ['calendar', 'today', '2026-09-22', true]);
  await page.evaluate(() => { view = 'planner'; render(); }); assert.equal(await page.evaluate(() => view), 'calendar');
  await page.click('#calAdd'); assert.deepEqual(await page.$$eval('.cal-add [data-add]', ns => ns.map(n => n.dataset.add)), ['event', 'block', 'task', 'routine', 'workout']);
}, { state: fixtureState() });

test('RQ11 Projects: goals shown as Projekty everywhere; the data stays S.goals (deadline, progress, milestones, task and block links); a task picks its Projekt', async ({ page }) => {
  const g0 = await page.evaluate(() => JSON.stringify([S.goals, S.milestones, S.tasks.map(t => [t.id, t.goalId]), (S.plannerBlocks || []).map(b => [b.id, b.goalId])]));
  await page.evaluate(() => { view = 'goals'; render(); });
  assert.match(await page.locator('#app h2').first().innerText(), /Projekty/);
  assert.doesNotMatch(await page.locator('#app').innerText(), /\bCíle\b|\bcíl\b/);
  await page.evaluate(() => { openForm('task'); });
  assert.match(await page.locator('.sheet').innerText(), /Projekt/);
  assert.equal(await page.evaluate(() => JSON.stringify([S.goals, S.milestones, S.tasks.map(t => [t.id, t.goalId]), (S.plannerBlocks || []).map(b => [b.id, b.goalId])])), g0);
}, { state: fixtureState() });

test('RQ12 Routines: habits are "Rutiny" in the nav, screens and quests; check-ins and streaks are the same records', async ({ page }) => {
  const h0 = await page.evaluate(() => JSON.stringify(S.habits.map(h => [h.id, h.completions, currentStreak(h)])));
  await page.setViewportSize({ width: 390, height: 900 });
  assert.deepEqual(await page.$$eval('nav.bottom button', ns => ns.filter(n => n.offsetParent).map(n => n.innerText.trim())), ['Domů', 'Kalendář', 'Úkoly', 'Rutiny', 'Více']);
  for (const v of ['habits', 'quests', 'home', 'statistics']) { await page.evaluate(v => { view = v; render(); }, v); assert.doesNotMatch(await page.locator('#app').innerText(), /[Nn]ávyk|[Vv]ýprav/, v); }
  assert.equal(await page.evaluate(() => JSON.stringify(S.habits.map(h => [h.id, h.completions, currentStreak(h)]))), h0);
}, { state: fixtureState() });

test('RQ13 Nutrition history: ‹ / Dnes / › days; a meal and water logged for yesterday keep their date; only a meal dated today pays XP', async ({ page }) => {
  const xp0 = await xpOf(page);
  await page.evaluate(() => { nutriDay = null; view = 'nutrition'; render(); });
  await page.click('#nuPrev'); assert.match(await page.locator('.nu-day').innerText(), /Úterý 22\. září[\s\S]*zpětný zápis/);
  await page.click('#addMeal'); assert.equal(await page.inputValue('#m_date'), '2026-09-22');
  await page.fill('#m_name', 'Včerejší oběd'); await page.fill('#m_cal', '700'); await page.click('#m_save');
  await page.click('#addWater');
  assert.deepEqual(await page.evaluate(() => [S.meals.find(m => m.name === 'Včerejší oběd').date, waterOnDate('2026-09-22')]), ['2026-09-22', 250]);
  assert.equal(await xpOf(page), xp0, 'no XP for a back-dated meal');
  await page.click('#nuToday'); await page.click('#nuNext'); assert.match(await page.locator('.nu-day').innerText(), /budoucí den/);
  await page.click('#nuToday'); await page.click('#addMeal'); await page.fill('#m_name', 'Dnešní svačina'); await page.selectOption('#m_type', 'Snack'); await page.fill('#m_cal', '200'); await page.click('#m_save');
  assert.ok((await xpOf(page)) >= xp0, 'today still pays as before');
}, { state: fixtureState() });

test('RQ14 favourite foods: create, edit, delete and use one for the shown day; existing saved foods are kept', async ({ page }) => {
  await page.evaluate(() => { S.customFoods = [{ id: 'cf_old', name: 'Starý shake', calories: 200, protein: 30, carbs: 8, fat: 3, favorite: true, createdAt: 1 }]; nutriDay = null; view = 'nutrition'; render(); });
  assert.equal(await page.locator('.food-item').count(), 1);
  await page.click('#addFood'); await page.fill('#fd_name', 'Ovesná kaše'); await page.fill('#fd_cal', '350'); await page.fill('#fd_p', '12'); await page.click('#fd_save');
  await page.locator('.food-item', { hasText: 'Ovesná kaše' }).locator('.editBtn').click(); await page.fill('#fd_cal', '380'); await page.click('#fd_save');
  assert.equal(await page.evaluate(() => S.customFoods.find(f => f.name === 'Ovesná kaše').calories), 380);
  await page.click('#nuPrev'); await page.locator('.food-item', { hasText: 'Ovesná kaše' }).locator('.useFood').click();
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#m_name').value, document.querySelector('#m_cal').value, document.querySelector('#m_date').value]), ['Ovesná kaše', '380', '2026-09-22']);
  await page.click('#m_save'); assert.equal(await page.evaluate(() => S.meals.filter(m => m.name === 'Ovesná kaše' && m.date === '2026-09-22').length), 1);
  await page.locator('.food-item', { hasText: 'Starý shake' }).locator('.delbtn').click(); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => S.customFoods.map(f => f.name)), ['Ovesná kaše']);
}, { state: fixtureState() });

test('RQ15 sleep quality 0-100 %: 0 / 50 / 100 save, invalid values are refused, Daily Score uses it (70 % duration + 30 % quality), old 1-5 ratings are untouched', async ({ page }) => {
  const save = async v => { await page.evaluate(() => { closeSheets(); view = 'health'; render(); openSleepForm(); }); await page.fill('#sl_date', '2026-09-23'); await page.fill('#sl_bed', '23:00'); await page.fill('#sl_wake', '06:00');
    await page.fill('#sl_qp', String(v)); await page.click('#sl_save'); return page.evaluate(() => { const e = document.querySelector('#sl_qp_err'); return [!!document.querySelector('.sheet'), !!(e && !e.hidden)]; }); };
  await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(x => x.date !== '2026-09-23'); });
  for (const v of ['150', '-1', '50.5', '101']) assert.deepEqual(await save(v), [true, true], v);
  for (const v of [0, 50, 100]) {
    await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(x => x.date !== '2026-09-23'); });
    assert.deepEqual(await save(v), [false, false]);
    const r = await page.evaluate(() => { const a = dailyScoreSleep('2026-09-23'); return [S.sleepLog.find(x => x.date === '2026-09-23').qualityPct, a.band, a.qualityPct, a.score]; });
    assert.deepEqual(r, [v, 100, v, Math.round(0.7 * 100 + 0.3 * v)], String(v)); // 23:00-06:00 = 7 h (duration band 100)
  }
  const legacy = await page.evaluate(() => { S.sleepLog.push(migrateSleepEntry({ id: 'old', date: '2026-09-10', bedtime: '23:00', wake: '07:00', quality: 4 })); const a = dailyScoreSleep('2026-09-10'); return [a.score, a.qualityPct, S.sleepLog.find(x => x.id === 'old').quality, sleepQualityText(S.sleepLog.find(x => x.id === 'old'))]; });
  assert.deepEqual(legacy, [100, null, 4, '4/5']);
  assert.equal(await page.evaluate(() => DAILY_SCORE_ALGO), 3);
}, { state: fixtureState() });

test('RQ16 investments: edit the name and the initial amount, delete one entry, delete the investment; deactivate still works', async ({ page }) => {
  await page.evaluate(() => { S.investments = [migrateInvestment({ id: 'inv1', name: 'ETF', contributions: [{ id: 'c1', amount: 10000, date: '2026-01-10' }], valuations: [{ id: 'v1', value: 12000, date: '2026-09-01' }] })]; finView = 'invest'; finKeepView = true; view = 'finance'; render(); });
  await page.click('[data-investment="inv1"]'); await page.click('#i_edit'); await page.fill('#i_name', 'ETF World'); await page.click('#i_save');
  await page.click('[data-investment="inv1"]'); await page.click('[data-inv-edit="c:c1"]'); await page.fill('#ie_amt', '9000'); await page.click('#ie_save');
  assert.deepEqual(await page.evaluate(() => { const i = S.investments[0]; return [i.name, i.contributions[0].amount, financeInvestmentPerformance(i).invested]; }), ['ETF World', 9000, 9000]);
  await page.click('[data-inv-edit="v:v1"]'); await page.click('#ie_del'); assert.equal(await page.evaluate(() => S.investments[0].valuations.length), 0);
  await page.click('#i_act'); assert.equal(await page.evaluate(() => S.investments[0].active), false);
  await page.click('[data-investment="inv1"]'); await page.click('#i_del'); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => S.investments.length), 0);
}, { state: fixtureState() });

test('RQ17 subscriptions in Finance: weekly / every 14 days / monthly / yearly, the paying account, next payment, monthly total and expected payments', async ({ page }) => {
  const r = await page.evaluate(() => {
    S.accounts = [migrateAccount({ id: 'a1', name: 'ČSOB', type: 'bank', openingBalance: 25000, openingDate: '2026-01-01' })];
    S.subscriptions = [migrateSub({ id: 'w', name: 'W', price: 70, period: 'Weekly', nextPayment: '2026-09-01', accountId: 'a1' }), migrateSub({ id: 'b', name: 'B', price: 260, period: 'Biweekly', nextPayment: '2026-09-01' }),
      migrateSub({ id: 'm', name: 'M', price: 200, period: 'Monthly', nextPayment: '2026-09-01' }), migrateSub({ id: 'y', name: 'Y', price: 1200, period: 'Yearly', nextPayment: '2026-09-01' })];
    const nx = S.subscriptions.map(nextPaymentDate), mo = Math.round(S.subscriptions.reduce((a, s) => a + subMonthly(s), 0));
    const ex = financeExpectedInRange('2026-10-01', '2026-10-31').filter(x => x.source === 'subscription').map(x => x.id + x.date.slice(8)).join();
    return { nx, mo, ex }; });
  assert.deepEqual(r, { nx: ['2026-09-29', '2026-09-29', '2026-10-01', '2027-09-01'], mo: 1167, ex: 'm01,w06,b13,w13,w20,b27,w27' }); // mo = 70*52/12 + 260*26/12 + 200 + 1200/12
  await page.evaluate(() => { view = 'subscriptions'; render(); });
  assert.deepEqual(await page.evaluate(() => [view, finView]), ['finance', 'subs']);
  await page.click('#addSub'); await page.fill('#su_name', 'Spotify'); await page.fill('#su_price', '169'); await page.selectOption('#su_period', 'Biweekly'); await page.selectOption('#su_acc', 'a1'); await page.click('#su_save');
  assert.deepEqual(await page.evaluate(() => { const s = S.subscriptions.find(x => x.name === 'Spotify'); return [s.period, s.accountId]; }), ['Biweekly', 'a1']);
  assert.match(await page.locator('#app').innerText(), /Spotify[\s\S]*169[\s\S]*14 dní[\s\S]*ČSOB/);
}, { state: fixtureState() });

test('RQ18 total balance: every account now (latest real balance or calculated), separate from the month cash flow and investments; old finance data unchanged', async ({ page }) => {
  const before = await page.evaluate(() => JSON.stringify([S.expenses, S.income, S.budgets, S.subscriptions, S.investments, S.recurringFinance]));
  await page.evaluate(() => { S.accounts = [migrateAccount({ id: 'a1', name: 'ČSOB', openingBalance: 25000, openingDate: '2026-01-01' }), migrateAccount({ id: 'a2', name: 'Revolut', openingBalance: 5000, openingDate: '2026-01-01' }),
    migrateAccount({ id: 'a3', name: 'Hotovost', openingBalance: 2000, openingDate: '2026-01-01' })]; finView = 'dashboard'; view = 'finance'; render(); });
  assert.match(await page.locator('#finBalance').innerText(), /Celkový zůstatek[\s\S]*32\s000[\s\S]*ČSOB[\s\S]*25\s000[\s\S]*Revolut[\s\S]*5\s000[\s\S]*Hotovost[\s\S]*2\s000/iu);
  assert.equal(await page.evaluate(() => JSON.stringify([S.expenses, S.income, S.budgets, S.subscriptions, S.investments, S.recurringFinance])), before);
}, { state: fixtureState() });

test('RQ19 migration of an old state: every existing record survives unchanged (tasks, goals, habits, events, blocks, meals, water, foods, sleep, finance, notes, car); idempotent; schemaVersion 8', async ({ page }) => {
  const r = await page.evaluate(() => {
    const legacy = { schemaVersion: 6, totalXp: 1234, xpLog: [{ id: 'x1', amount: 30, reason: 'Task: A', ts: 1, key: 'task:t1:2026-09-01' }], attrs: { STR: 5, INT: 3, DEX: 2, VIT: 1, WIS: 0, FOC: 4, SOC: 0 },
      tasks: [{ id: 't1', title: 'A', done: true, goalId: 'g1', dueDate: '2026-09-01', priority: 'High', category: 'Work', createdAt: 1 }],
      goals: [{ id: 'g1', title: 'Web', status: 'Active', targetDate: '2026-12-01', mode: 'manual', manualProgress: 40, createdAt: 1 }],
      milestones: [{ id: 'm1', goalId: 'g1', title: 'Logo', completed: false, createdAt: 1 }],
      habits: [{ id: 'h1', name: 'Vitamíny', completions: ['2026-09-20', '2026-09-21', '2026-09-22'], active: true, createdAt: 1 }],
      events: [{ id: 'e1', title: 'Porada', date: '2026-09-02', time: '10:00', recurring: 'weekly' }],
      plannerBlocks: [{ id: 'b1', date: '2026-09-23', startTime: '09:00', endTime: '10:00', title: 'Web', goalId: 'g1', taskId: 't1', category: 'Work', completed: false, createdAt: 1 }],
      meals: [{ id: 'ml1', name: 'Oběd', date: '2026-09-20', calories: 600 }], waterLog: [{ id: 'w1', date: '2026-09-20', amount: 500 }],
      customFoods: [{ id: 'cf1', name: 'Shake', calories: 200, favorite: true }], sleepLog: [{ id: 's1', date: '2026-09-20', bedtime: '23:00', wake: '07:00', quality: 3 }],
      expenses: [{ id: 'ex1', amount: 100, category: 'Food', date: '2026-09-01' }], income: [{ id: 'in1', amount: 1000, category: 'Salary', date: '2026-09-01' }],
      subscriptions: [{ id: 'su1', name: 'Netflix', price: 299, period: 'Monthly', nextPayment: '2026-09-15' }], investments: [{ id: 'iv1', name: 'ETF', contributions: [{ id: 'c1', amount: 100, date: '2026-01-01' }] }],
      notes: [{ id: 'n1', title: 'Pozn', body: 'x', category: 'Ideas', pinned: true, favorite: true, tags: ['a'] }],
      vehicles: [{ id: 'v1', name: 'Octavia' }], fuelEntries: [{ id: 'f1', vehicleId: 'v1', liters: 40, date: '2026-09-01' }], stepsLog: [{ id: 'st1', date: '2026-09-01', steps: 8000 }], heartRateLog: [{ id: 'hr1', date: '2026-09-01', value: 60 }] };
    const a = migrate(JSON.parse(JSON.stringify(legacy))), b = migrate(JSON.parse(JSON.stringify(a)));
    const srt = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
    const kept = Object.keys(legacy).filter(k => Array.isArray(legacy[k])).every(k => legacy[k].every(rec => { const m = a[k].find(x => x.id === rec.id); return m && Object.keys(rec).every(f => JSON.stringify(m[f]) === JSON.stringify(rec[f])); }));
    return [a.schemaVersion, kept, srt(a) === srt(b), a.totalXp, a.xpLog.length, JSON.stringify(a.attrs) === JSON.stringify(legacy.attrs)]; });
  assert.deepEqual(r, [8, true, true, 1234, 1, true]);
}, { state: fixtureState() });

test('RQ20 export -> import: the backup round-trips exactly (new optional fields included, car / steps / heart-rate / favourite flags kept)', async ({ page }) => {
  await page.evaluate(() => { S.plannerBlocks.push({ id: 'mb', date: '2026-09-25', endDate: '2026-09-26', startTime: '18:00', endTime: '08:00', title: 'Výlet', repeat: null, completed: false, createdAt: 1 });
    S.sleepLog.push({ id: 'sq', date: '2026-09-21', bedtime: '23:00', wake: '07:00', qualityPct: 87, quality: null });
    S.vehicles = [{ id: 'v1', name: 'Octavia' }]; S.stepsLog = [{ id: 's1', date: '2026-09-01', steps: 9000 }]; S.notes.push({ id: 'nf', title: 'Fav', body: '', favorite: true, pinned: false, tags: [], createdAt: 1, updatedAt: 1 }); });
  await page.evaluate(() => { S = migrate(JSON.parse(JSON.stringify(S))); }); // records as the app stores them (defaults filled like any import)
  await persist(page); await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(exported, await stateOf(page)); assert.equal(exported.schemaVersion, 8);
  await page.evaluate(() => { S.plannerBlocks = []; S.vehicles = []; }); await importFile(page, await dl.path()); await settle(page);
  assert.deepEqual(await stateOf(page), exported);
  assert.deepEqual(await page.evaluate(() => [S.plannerBlocks.find(b => b.id === 'mb').endDate, S.sleepLog.find(x => x.id === 'sq').qualityPct, S.vehicles.length, S.stepsLog.length, S.notes.find(n => n.id === 'nf').favorite]), ['2026-09-26', 87, 1, 1, true]);
}, { state: fixtureState() });

test('RQ21 XP: opening every screen, planning, dragging, favourites and categories change no XP; built-in category mapping unchanged; a custom attribute mix splits evenly', async ({ page }) => {
  await page.evaluate(() => { view = 'home'; render(); }); await persist(page);
  const x0 = await page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.quests.length]));
  const prof = await page.evaluate(() => CAT_LIST.map(k => catProfile(k)));
  assert.deepEqual(prof, ['fitness', 'health', 'learning', 'discipline', 'finance', 'work', 'social', 'personal']);
  for (const v of ['calendar', 'goals', 'habits', 'quests', 'nutrition', 'health', 'finance', 'notes', 'settings', 'more']) await page.evaluate(v => { view = v; render(); }, v);
  await page.evaluate(() => { plannerSaveBlock({ title: 'Plán', date: todayStr(), startTime: '20:00', endTime: '21:00' }); calShiftBlock(S.plannerBlocks[S.plannerBlocks.length - 1].id, 1, 30, 30);
    S.customFoods.push({ id: 'ff', name: 'F', calories: 1 }); catSave({ name: 'Coding', icon: 'code', profile: 'personal', attrMix: { INT: 1, FOC: 1 } }, 'life'); });
  assert.equal(await page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.quests.length])), x0);
  const k = await page.evaluate(() => S.lifeCategories.find(c => c.name === 'Coding').key);
  assert.deepEqual(await page.evaluate(k => [catProfile(k), rpgAttrGains(12, catProfile(k))], k), [{ INT: 1, FOC: 1 }, { INT: 6, FOC: 6 }]);
}, { state: fixtureState() });

test('RQ22 quests: the day plan needs every block (repeating occurrences too); all routines; calories 90-110 % (boundaries); water; routine all week; sleep 7-9 h all week', async ({ page }) => {
  const r = await page.evaluate(() => {
    const q = id => [...DAILY_QUESTS, ...WEEKLY_QUESTS].find(x => x.id === id), T = todayStr();
    S.plannerBlocks = [{ id: 'p1', date: T, startTime: '08:00', endTime: '09:00', title: 'A', completed: true }, { id: 'p2', date: '2026-09-21', startTime: '18:00', endTime: '18:30', title: 'R', repeat: { freq: 'daily', days: [], until: '' }, doneDates: [] }];
    const plan = [questVal(q('dq_plan_all'), {}), questMax(q('dq_plan_all'), {})]; plannerToggleCompleted('p2', T); const plan2 = q('dq_plan_all').check(S, {});
    S.nutritionTargets.calories = 2000; const Y = addDays(T, -1); // dq_calories scores the finished day (yesterday)
    const cal = [1799, 1800, 2200, 2201].map(c => { S.meals = S.meals.filter(m => m.date !== Y); S.meals.push({ id: 'mm', name: 'x', date: Y, calories: c, servings: 1 }); return questVal(q('dq_calories'), {}); });
    S.nutritionTargets.water = 2000; S.waterLog = S.waterLog.filter(w => w.date !== T); S.waterLog.push({ id: 'w1', date: T, amount: 1500 }); const water = [questVal(q('dq_water'), {}), questMax(q('dq_water'), {})];
    S.sleepLog = ['2026-09-21', '2026-09-22', '2026-09-23'].map((d, i) => ({ id: 's' + i, date: d, bedtime: '23:00', wake: i === 1 ? '05:00' : '07:00' }));
    const sleep = [questVal(q('wq_sleep_week'), {}), questMax(q('wq_sleep_week'), {})];
    S.habits = [migrateHabit({ id: 'hA', name: 'A ranní hygiena', frequency: 'daily', completions: ['2026-09-21', '2026-09-22'], startDate: '2026-01-01' })];
    const p = q('wq_routine_week').params(S); const rw = [p.habit, questVal(q('wq_routine_week'), p), questMax(q('wq_routine_week'), p)];
    return { plan, plan2, cal, water, sleep, rw, tol: QUEST_TOLERANCE.calories, habitsAll: q('dq_habits').check.toString().includes('max') };
  });
  assert.deepEqual(r, { plan: [1, 2], plan2: true, cal: [0, 1, 1, 0], water: [1500, 2000], sleep: [2, 7], rw: ['hA', 2, 7], tol: [0.9, 1.1], habitsAll: true });
  assert.equal(await page.evaluate(() => { const q = DAILY_QUESTS.find(x => x.id === 'dq_habits'); return q.max(S, {}) === Math.max(1, dailyScoreHabits(todayStr()).total || 0); }), true, 'all of today\'s routines');
}, { state: fixtureState() });

test('RQ23 navigation: desktop sidebar with every main module, phone bottom bar of five; no Car or Subscriptions entry; Quick Add uses the new names', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => { view = 'home'; render(); });
  assert.deepEqual(await page.$$eval('nav.bottom button', ns => ns.filter(n => n.offsetParent).map(n => n.dataset.v)), ['home', 'calendar', 'tasks', 'habits', 'goals', 'character', 'finance', 'fitness', 'nutrition', 'health', 'notes', 'journal', 'quests', 'statistics', 'more']);
  await page.click('nav.bottom button[data-v="goals"]'); assert.equal(await page.evaluate(() => view), 'goals');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.deepEqual(await page.$$eval('nav.bottom button', ns => ns.filter(n => n.offsetParent).map(n => n.dataset.v)), ['home', 'calendar', 'tasks', 'habits', 'more']);
  await page.evaluate(() => { view = 'more'; render(); });
  const more = await page.$$eval('#moreGrid [data-v]', ns => ns.map(n => n.dataset.v));
  assert.ok(!more.includes('car') && !more.includes('subscriptions') && !more.includes('planner'), more.join());
  await page.click('#fabBtn'); const qa = await page.$$eval('.sheet .qopt', ns => ns.map(n => [n.dataset.t, n.innerText.trim()]));
  assert.ok(!qa.some(([t]) => t === 'fuel'), 'no car quick add');
  assert.deepEqual(qa.filter(([t]) => ['habit', 'goal'].includes(t)).map(x => x[1]), ['Rutina', 'Projekt']);
}, { state: fixtureState() });

test('RQ24 date / time pickers: a LifeOS picker for every date and time field; keyboard, Escape; the stored values stay ISO; typing still works', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.evaluate(() => { view = 'calendar'; render(); openPlannerForm(null, { date: '2026-09-23' }); });
  assert.equal(await page.locator('.sheet .pk-btn').count(), 5, 'date, start, end date, end, repeat until');
  await page.click('.sheet #pb_date + .pk-btn'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#pb_date'), '2026-09-24');
  assert.equal(await page.inputValue('#pb_enddate'), '2026-09-24', 'the end date follows');
  await page.click('.sheet #pb_start + .pk-btn'); await page.click('.pk-pop [data-h="7"]'); await page.click('.pk-pop [data-mi="45"]');
  assert.equal(await page.inputValue('#pb_start'), '07:45');
  await page.click('.sheet #pb_end + .pk-btn'); await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector('.pk-pop'), document.activeElement.id]), [false, 'pb_end']);
  await page.fill('#pb_end', '08:30'); assert.equal(await page.inputValue('#pb_end'), '08:30');
  assert.match(await page.locator('.sheet #pb_start ~ .pk-show').innerText(), /07:45/);
  const ind = await page.evaluate(() => [...document.styleSheets].some(ss => [...ss.cssRules].some(r => r.selectorText && r.selectorText.includes('::-webkit-calendar-picker-indicator') && r.style.display === 'none'))); assert.equal(ind, true, 'the native picker icon is hidden');
}, { state: fixtureState() });

test('RQ25 categories: a custom category with icon, colour and chosen attributes; note categories Osobní + Práce by default (others kept for existing notes); no favourites in Notes', async ({ page }) => {
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('[data-addcat="life"]');
  await page.fill('#cf_name', 'Skin care'); await page.click('.cf-ic[data-icon="heart"]'); await page.selectOption('#cf_profile', '__mix');
  await page.click('.cf-attr[data-attr="VIT"]'); await page.click('.cf-attr[data-attr="FOC"]'); await page.click('#cf_save');
  const c = await page.evaluate(() => S.lifeCategories.find(x => x.name === 'Skin care'));
  assert.deepEqual([c.icon, c.attrMix], ['heart', { VIT: 1, FOC: 1 }]);
  assert.deepEqual(await page.evaluate(() => catList('notes').filter(x => !x.archived).map(x => x.key)), ['Personal', 'Work']);
  await page.evaluate(() => { S.notes.push({ id: 'ni', title: 'Starý nápad', body: '', category: 'Ideas', tags: [], pinned: false, favorite: true, createdAt: 1, updatedAt: 1 }); view = 'notes'; render(); });
  assert.match(await page.locator('#app').innerText(), /Starý nápad[\s\S]*Nápady|Starý nápad[\s\S]*Ideas/);
  assert.equal(await page.locator('.favB').count(), 0);
  await page.evaluate(() => openNoteForm()); assert.equal(await page.locator('#n_fav').count(), 0);
  await page.click('#n_newcat'); await page.fill('#cf_name', 'Recepty'); await page.click('#cf_save');
  assert.equal(await page.evaluate(() => catLabel(document.querySelector('#n_cat').value, 'notes')), 'Recepty');
}, { state: fixtureState() });

test('RQ26 health: sleep, weight, active kcal only (no manual steps / heart rate); old steps and heart-rate records stay in the data', async ({ page }) => {
  await page.evaluate(() => { S.stepsLog = [{ id: 's1', date: '2026-09-01', steps: 5000 }]; S.heartRateLog = [{ id: 'h1', date: '2026-09-01', value: 60 }]; healthTab = 'steps'; view = 'health'; render(); });
  assert.deepEqual(await page.$$eval('#hTabs [data-k]', ns => ns.map(n => n.dataset.k)), ['sleep', 'weight', 'activecal']);
  assert.deepEqual(await page.evaluate(() => [healthTab, S.stepsLog.length, S.heartRateLog.length, typeof openStepsForm]), ['sleep', 1, 1, 'undefined']);
}, { state: fixtureState() });

test('RQ27 320-1440 px, light + dark: Calendar (month / week / day), Projects, Routines, Quests, Nutrition, Health, Finance, Notes and the add / picker sheets render cleanly', async ({ page }) => {
  await rqBlocks(page); const bad = [];
  for (const w of [320, 360, 390, 430, 768, 1024, 1280, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [v, pre] of [['calendar', "uiCalMode='month'"], ['calendar', "uiCalMode='week'"], ['calendar', "uiCalMode='today'"], ['goals', ''], ['habits', ''], ['quests', ''], ['nutrition', ''], ['health', ''], ['finance', ''], ['notes', '']]) {
      await page.evaluate(([v, pre, theme]) => { closeSheets(); S.settings.theme = theme; applyTheme(); uiCalDay = '2026-09-23'; if (pre) eval(pre); view = v; render(); }, [v, pre, theme]);
      const c = await rqClean(page); if (c.bad || c.dup.length || c.overflow > 0) bad.push(`${w}/${theme}/${v} ${pre}: ${JSON.stringify(c)}`);
    }
    if (theme === 'dark' && (w === 320 || w === 1440)) { await page.evaluate(() => { view = 'calendar'; render(); uiCalAddMenu(todayStr()); }); const c = await rqClean(page); if (c.overflow > 0) bad.push(`${w} add menu`); }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('RQ28 performance: the Calendar with 400 blocks (repeating and multi-day included) and 200 events renders fast; a drag does not rebuild or save until release', async ({ page }) => {
  const r = await page.evaluate(() => { const T = todayStr();
    for (let i = 0; i < 400; i++) S.plannerBlocks.push({ id: 'pp' + i, date: addDays(T, (i % 60) - 30), startTime: String(6 + i % 14).padStart(2, '0') + ':00', endTime: String(7 + i % 14).padStart(2, '0') + ':30', title: 'Blok ' + i, category: 'Work',
      completed: false, createdAt: 1, ...(i % 40 === 0 ? { repeat: { freq: 'daily', days: [], until: '' } } : {}), ...(i % 50 === 1 ? { endDate: addDays(T, (i % 60) - 28) } : {}) });
    for (let i = 0; i < 200; i++) S.events.push({ id: 'pe' + i, title: 'Událost ' + i, date: addDays(T, (i % 120) - 90), start: String(8 + i % 10).padStart(2, '0') + ':00', end: String(9 + i % 10).padStart(2, '0') + ':00', recurring: ['none', 'weekly', 'none', 'monthly'][i % 4] });
    const m = f => { f(); const ts = []; for (let i = 0; i < 5; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[2]; };
    return { month: m(() => { uiCalMode = 'month'; view = 'calendar'; render(); }), week: m(() => { uiCalMode = 'week'; render(); }), day: m(() => { uiCalMode = 'today'; render(); }), home: m(() => { view = 'home'; render(); }) }; });
  console.log('      RQ28 ' + Object.entries(r).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', '));
  assert.ok(r.month < 150 && r.week < 150 && r.day < 100 && r.home < 120, JSON.stringify(r));
  await page.setViewportSize({ width: 1280, height: 900 }); await rqBlocks(page); await rqCal(page, 'today', '2026-09-23');
  await page.evaluate(() => { window.__renders = 0; const r0 = window.render; window.render = function () { window.__renders++; return r0.apply(this, arguments); }; });
  const bb = await page.locator('.cg-it[data-id="b1"]').boundingBox(); const s0 = await rqState(page);
  await page.mouse.move(bb.x + 10, bb.y + 10); await page.mouse.down(); for (let i = 1; i <= 20; i++) await page.mouse.move(bb.x + 10, bb.y + 10 + i * 3);
  assert.deepEqual(await page.evaluate(() => window.__renders), 0); assert.equal(await rqState(page), s0, 'no save while dragging');
  await page.mouse.up(); assert.equal(await page.evaluate(() => window.__renders), 1, 'one render on release');
}, { state: fixtureState() });

test('RQ29 accessibility: calendar items are focusable buttons with names, keyboard move / resize, the pickers and the 0-100 % field have labels; nothing animates with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await rqBlocks(page); await rqCal(page, 'today', '2026-09-23');
  const r = await page.evaluate(() => ({ unnamed: [...document.querySelectorAll('.cal button, .cal [role="button"]')].filter(n => !(n.getAttribute('aria-label') || n.textContent).trim()).length,
    items: [...document.querySelectorAll('.cg-it')].every(n => n.tabIndex === 0 && n.getAttribute('aria-label')),
    moving: [...document.querySelectorAll('.cal, .cal *')].filter(n => { const cs = getComputedStyle(n); return cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01 || parseFloat(cs.transitionDuration) > 0.01; }).length }));
  assert.deepEqual(r, { unnamed: 0, items: true, moving: 0 });
  await page.focus('.cg-it[data-id="b2"]'); await page.keyboard.press('Alt+Shift+ArrowDown');
  assert.equal(await page.evaluate(() => S.plannerBlocks.find(b => b.id === 'b2').endTime), '09:45');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'b2', 'focus stays on the item');
  await page.keyboard.press('Enter'); assert.equal(await page.inputValue('#pb_title'), 'Doktor');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.sheet .pk-btn')].every(b => /Vybrat (datum|čas)/.test(b.getAttribute('aria-label')))));
  await page.evaluate(() => { closeSheets(); openSleepForm(); });
  assert.deepEqual(await page.evaluate(() => [!!document.querySelector('label[for="sl_qp"]'), document.querySelector('#sl_qp_r').getAttribute('aria-label')]), [true, 'Kvalita spánku']);
}, { state: fixtureState() });

// ---------- Reality QA review fixes ----------
test('RQ30 favourite foods CRUD: list the saved foods, create (name required), edit (same record, other fields kept), delete (cancel keeps), use one for the chosen day', async ({ page }) => {
  await page.evaluate(() => { S.customFoods = [{ id: 'cf_old', name: 'Starý shake', calories: 200, protein: 30, carbs: 8, fat: 3, favorite: true, servingSize: '1 ks', createdAt: 1 }, { id: 'cf_rice', name: 'Rýže', calories: 130, protein: 3, carbs: 28, fat: 0, createdAt: 2 }];
    nutriDay = null; view = 'nutrition'; render(); });
  // list: every saved food (old ones included) with its values
  assert.deepEqual(await page.$$eval('#foodList .food-item', ns => ns.map(n => n.dataset.food)), ['cf_old', 'cf_rice'], 'favourites first, then the other saved foods');
  assert.match(await page.locator('.food-item[data-food="cf_old"]').innerText(), /Starý shake[\s\S]*200 kcal · B 30 g · S 8 g · T 3 g/);
  // create: an empty name is refused, nothing saved
  await page.click('#addFood'); await page.click('#fd_save');
  assert.equal(await page.locator('.food-form [data-err="name"]').isVisible(), true); assert.equal(await page.evaluate(() => S.customFoods.length), 2);
  await page.fill('#fd_name', 'Ovesná kaše'); await page.fill('#fd_cal', '350'); await page.fill('#fd_p', '12'); await page.fill('#fd_c', '60'); await page.fill('#fd_f', '7'); await page.click('#fd_save');
  const made = await page.evaluate(() => JSON.parse(JSON.stringify(S.customFoods.find(f => f.name === 'Ovesná kaše'))));
  assert.deepEqual([made.calories, made.protein, made.carbs, made.fat, made.favorite, typeof made.id], [350, 12, 60, 7, true, 'string']);
  assert.equal(await page.locator('.food-item', { hasText: 'Ovesná kaše' }).count(), 1, 'shown right away');
  // edit: the same record changes, its id / createdAt and fields the form does not know stay
  await page.locator('.food-item', { hasText: 'Ovesná kaše' }).locator('.editBtn').click();
  assert.equal(await page.inputValue('#fd_cal'), '350', 'the form shows the stored values');
  await page.fill('#fd_name', 'Ovesná kaše s ovocem'); await page.fill('#fd_cal', '380'); await page.fill('#fd_f', '8'); await page.click('#fd_save');
  const ed = await page.evaluate(id => JSON.parse(JSON.stringify(S.customFoods.find(f => f.id === id))), made.id);
  assert.deepEqual([ed.name, ed.calories, ed.protein, ed.carbs, ed.fat, ed.createdAt], ['Ovesná kaše s ovocem', 380, 12, 60, 8, made.createdAt]);
  await page.locator('.food-item[data-food="cf_old"] .editBtn').click(); await page.fill('#fd_p', '32'); await page.click('#fd_save');
  assert.deepEqual(await page.evaluate(() => { const f = S.customFoods.find(x => x.id === 'cf_old'); return [f.protein, f.servingSize, f.createdAt]; }), [32, '1 ks', 1], 'an old food keeps its other fields');
  // use: into the day shown (tomorrow here), every value copied; a future day pays no XP
  const xp0 = await page.evaluate(() => S.totalXp);
  await page.click('#nuNext'); assert.equal(await page.evaluate(() => nutriDay), '2026-09-24');
  await page.locator(`.food-item[data-food="${made.id}"] .useFood`).click();
  assert.deepEqual(await page.evaluate(() => ['#m_name', '#m_cal', '#m_p', '#m_c', '#m_f', '#m_date'].map(x => document.querySelector(x).value)), ['Ovesná kaše s ovocem', '380', '12', '60', '8', '2026-09-24']);
  await page.click('#m_save');
  assert.deepEqual(await page.evaluate(() => S.meals.filter(m => m.name === 'Ovesná kaše s ovocem').map(m => [m.date, +m.calories, +m.protein, +m.carbs, +m.fat])), [['2026-09-24', 380, 12, 60, 8]]);
  assert.equal(await page.evaluate(() => S.totalXp), xp0, 'a meal for a future day pays no XP');
  assert.equal(await page.evaluate(() => S.customFoods.length), 3, 'using a food never copies or removes it');
  // delete: cancel keeps, confirm removes only that food; the logged meal stays
  await page.locator(`.food-item[data-food="${made.id}"] .delbtn`).click(); await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => S.customFoods.length), 3);
  await page.locator(`.food-item[data-food="${made.id}"] .delbtn`).click(); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => S.customFoods.map(f => f.id)), ['cf_old', 'cf_rice']);
  assert.equal(await page.evaluate(() => S.meals.filter(m => m.name === 'Ovesná kaše s ovocem').length), 1, 'meals logged from it stay');
  await settle(page); await reload(page);
  assert.deepEqual(await page.evaluate(() => S.customFoods.map(f => [f.id, f.protein])), [['cf_old', 32], ['cf_rice', 3]], 'saved');
}, { state: fixtureState() });

test('RQ31 dq_calories is the result of a whole finished day: 1800-2200 of 2000 valid, 2201 invalid, the running day is never final, 1900 -> 2300 the same day ends invalid; XP once', async ({ page }) => {
  const r = await page.evaluate(() => {
    S.nutritionTargets.calories = 2000; const T = todayStr(), Y = addDays(T, -1);
    const on = (D, ...cs) => { S.meals = S.meals.filter(m => m.date !== D); cs.forEach((c, i) => S.meals.push({ id: 'q' + D + i, name: 'x', date: D, calories: c, servings: 1 })); return questCaloriesResult(D); };
    const days = [1799, 1800, 1900, 2100, 2200, 2201].map(c => on(Y, c));
    const today = on(T, 1900); // inside the band, but the day is still running
    const passedThenOver = [on(Y, 1900), (S.meals.push({ id: 'late', name: 'večeře', date: Y, calories: 400, servings: 1 }), questCaloriesResult(Y))];
    const servings = on(Y, 950) && (S.meals.find(m => m.date === Y).servings = 2, questCaloriesResult(Y)); // servings count, like everywhere
    return { days, today, passedThenOver, servings, none: (S.nutritionTargets.calories = 0, questCaloriesResult(Y)) }; });
  assert.deepEqual(r, { days: ['invalid', 'valid', 'valid', 'valid', 'valid', 'invalid'], today: 'open', passedThenOver: ['valid', 'invalid'], servings: 'valid', none: null });
  // end to end through checkQuests: nothing is paid while the day runs; the next day pays for a valid day once, never for 1900 -> 2300
  const board = page => page.evaluate(() => { S.questBoard = { daily: { stamp: todayStr(), items: [{ id: 'dq_calories', p: {} }, { id: 'x1' }, { id: 'x2' }] }, weekly: { stamp: weekStart(), items: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] } }; });
  const run = page => page.evaluate(() => { const a = S.totalXp; checkQuests(); return S.totalXp - a; });
  await page.evaluate(() => { S.nutritionTargets.calories = 2000; const T = todayStr(); S.meals = S.meals.filter(m => m.date !== T && m.date !== addDays(T, -1)); S.meals.push({ id: 'd1', name: 'oběd', date: T, calories: 1900, servings: 1 }); });
  await board(page); assert.equal(await run(page), 0, 'the running day is not final: 1900 pays nothing today');
  await page.evaluate(() => S.meals.push({ id: 'd2', name: 'večeře', date: todayStr(), calories: 400, servings: 1 })); // 2300
  await page.clock.setFixedTime(NOW + 86400000); await board(page);
  assert.equal(await page.evaluate(() => questCaloriesResult(addDays(todayStr(), -1))), 'invalid');
  assert.equal(await run(page), 0, '1900 -> 2300 during the day: final state invalid, no XP');
  await page.evaluate(() => { const Y = addDays(todayStr(), -1); S.meals = S.meals.filter(m => m.date !== Y); S.meals.push({ id: 'd3', name: 'den', date: Y, calories: 2050, servings: 1 }); });
  await page.clock.setFixedTime(NOW + 2 * 86400000); await board(page);
  await page.evaluate(() => { const Y = addDays(todayStr(), -1); S.meals = S.meals.filter(m => m.date !== Y); S.meals.push({ id: 'd4', name: 'den', date: Y, calories: 2050, servings: 1 }); });
  assert.equal(await run(page), 30, 'a valid finished day pays the quest XP once');
  assert.equal(await run(page), 0, 'never twice'); await board(page); assert.equal(await run(page), 0, 'not after a board rebuild either');
  assert.equal(await page.evaluate(() => S.xpLog.filter(x => /^Quest: Včerejší kalorie/.test(x.reason)).map(x => x.amount).join()), '30');
}, { state: fixtureState() });

test('RQ32 Daily Score sleep (algo 3): no qualityPct = the old duration band; quality 0 / 50 / 100; duration + quality combined; stored snapshots are never recomputed', async ({ page }) => {
  const r = await page.evaluate(() => {
    const D = '2026-09-10';
    const at = (bed, wake, extra) => { S.sleepLog = S.sleepLog.filter(x => x.date !== D); S.sleepLog.push(migrateSleepEntry(Object.assign({ id: 'z', date: D, bedtime: bed, wake }, extra || {}))); const a = dailyScoreSleep(D); return [a.band, a.qualityPct, a.score]; };
    return {
      noQuality: [at('23:00', '07:00'), at('01:00', '07:00'), at('21:00', '07:00'), at('23:00', '07:00', { quality: 1 })],
      quality: [0, 50, 100].map(q => at('23:00', '07:00', { qualityPct: q })),
      combined: [at('01:00', '07:00', { qualityPct: 50 }), at('02:00', '07:00', { qualityPct: 90 }), at('21:30', '07:00', { qualityPct: 0 }), at('03:00', '07:00', { qualityPct: 100 })],
      whole: (at('23:00', '07:00', { qualityPct: 50 }), [dailyScore(D).areas.sleep.score, dailyScore(D).algo]) };
  });
  assert.deepEqual(r.noQuality, [[100, null, 100], [67, null, 67], [85, null, 85], [100, null, 100]], 'without qualityPct exactly the old band (1-5 quality ignored as before)');
  assert.deepEqual(r.quality, [[100, 0, 70], [100, 50, 85], [100, 100, 100]], '8 h: 0.7 x 100 + 0.3 x quality');
  assert.deepEqual(r.combined, [[67, 50, 62], [33, 90, 50], [93, 0, 65], [0, 100, 30]], 'round(0.7 x band + 0.3 x quality): 6 h, 5 h, 9.5 h, 4 h');
  assert.deepEqual(r.whole, [85, 3], 'dailyScore() uses the same sleep area');
  // stored snapshots stay as they were (algo 2), even when that night later gets a quality; a new finished day is snapshotted with algo 3
  const snap = { score: 42, label: 'weaker', algo: 2, areas: { tasks: { score: null }, habits: { score: null }, nutrition: { score: null }, sleep: { score: 100, hours: 8 }, fitness: { score: null } }, finalizedAt: 1 };
  await page.evaluate(snap => { S.dailyScoresSince = '2026-09-15'; S.dailyScores = { '2026-09-20': snap };
    S.sleepLog.push(migrateSleepEntry({ id: 'n20', date: '2026-09-20', bedtime: '23:00', wake: '07:00', qualityPct: 0 }), migrateSleepEntry({ id: 'n21', date: '2026-09-21', bedtime: '23:00', wake: '07:00', qualityPct: 50 }));
    finalizeDailyScores(); for (const v of ['home', 'statistics']) { view = v; render(); } }, snap);
  await persist(page); await reload(page); await page.evaluate(() => { finalizeDailyScores(); view = 'home'; render(); });
  const st = await stateOf(page);
  assert.deepEqual(st.dailyScores['2026-09-20'], snap, 'the old snapshot is not recomputed');
  assert.equal(st.dailyScores['2026-09-21'].algo, 3);
}, { state: fixtureState() });

const legacyState = () => ({ schemaVersion: 6, totalXp: 2345, profile: { name: 'Starý účet' }, settings: { theme: 'dark', onboarded: true },
  xpLog: [{ id: 'x1', amount: 30, reason: 'Task: A', ts: 1, key: 'task:t1:2026-09-01' }, { id: 'x2', amount: 15, reason: 'Sleep logged', ts: 2 }],
  tasks: [{ id: 't1', title: 'A', done: true, goalId: 'g1', dueDate: '2026-09-01', priority: 'High', category: 'Work', createdAt: 1 }],
  goals: [{ id: 'g1', title: 'Web', status: 'Active', targetDate: '2026-12-01', createdAt: 1 }], milestones: [{ id: 'm1', goalId: 'g1', title: 'Logo', completed: false, createdAt: 1 }],
  habits: [{ id: 'h1', name: 'Vitamíny', completions: ['2026-09-20', '2026-09-21'], active: true, createdAt: 1 }],
  events: [{ id: 'e1', title: 'Porada', date: '2026-09-02', start: '10:00', end: '11:00', recurring: 'weekly' }, { id: 'e2', title: 'Narozeniny', date: '2026-03-02', recurring: 'monthly' }],
  plannerBlocks: [{ id: 'b1', date: '2026-09-23', startTime: '09:00', endTime: '10:00', title: 'Web', goalId: 'g1', taskId: 't1', category: 'Work', completed: false, createdAt: 1 }],
  meals: [{ id: 'ml1', name: 'Oběd', date: '2026-09-20', calories: 600, protein: 40 }], waterLog: [{ id: 'w1', date: '2026-09-20', amount: 500 }],
  customFoods: [{ id: 'cf1', name: 'Shake', calories: 200, favorite: true }], recipes: [{ id: 'r1', name: 'Kaše', calories: 300 }],
  sleepLog: [{ id: 's1', date: '2026-09-20', bedtime: '23:00', wake: '07:00', quality: 3 }],
  weightLog: [{ id: 'wt1', date: '2026-09-20', weight: 80 }], activeCaloriesLog: [{ id: 'ac1', date: '2026-09-20', calories: 400 }],
  stepsLog: [{ id: 'st1', date: '2026-09-01', steps: 8000 }], heartRateLog: [{ id: 'hr1', date: '2026-09-01', bpm: 60 }],
  vehicles: [{ id: 'v1', name: 'Octavia', mileage: '84000' }], carServices: [{ id: 'cs1', vehicleId: 'v1', type: 'Oil change', date: '2026-08-14', cost: '2500' }], fuelEntries: [{ id: 'f1', vehicleId: 'v1', liters: 40, date: '2026-09-01' }],
  expenses: [{ id: 'ex1', amount: 100, category: 'Food', date: '2026-09-01' }], income: [{ id: 'in1', amount: 1000, category: 'Salary', date: '2026-09-01' }],
  subscriptions: [{ id: 'su1', name: 'Netflix', price: 299, period: 'Monthly', nextPayment: '2026-09-15' }], investments: [{ id: 'iv1', name: 'ETF', contributions: [{ id: 'c1', amount: 100, date: '2026-01-01' }] }],
  notes: [{ id: 'n1', title: 'Pozn', body: 'x', category: 'Ideas', pinned: true, favorite: true, tags: ['a'] }], journal: [{ id: 'j1', date: '2026-09-20', text: 'Den' }] });

test('RQ33 data safety through a real boot: an old stored state (no new optional fields) loads without reset or onboarding, keeps every record and field (Car, steps, heart rate too), migration is idempotent across reloads, export -> import keeps it all', async ({ page }) => {
  const L = legacyState();
  const kept = st => Object.keys(L).filter(k => Array.isArray(L[k])).flatMap(k => L[k].filter(rec => { const m = (st[k] || []).find(x => x.id === rec.id); return !m || Object.keys(rec).some(f => JSON.stringify(m[f]) !== JSON.stringify(rec[f])); }).map(rec => k + ':' + rec.id));
  let st = await stateOf(page);
  assert.deepEqual(kept(st), [], 'every old record with every old field value');
  assert.deepEqual([st.schemaVersion, st.profile.name, st.settings.onboarded, await page.locator('#ob_name').count()], [8, 'Starý účet', true, 0], 'no reset, not a new account');
  // the XP history is kept as it was; the only additions are achievements this old data had already earned (unchanged
  // checkAchievements from main: this legacy state stores no achievement list), never a reset or a re-paid record
  assert.deepEqual(st.xpLog.slice(0, 2), L.xpLog, 'old XP entries untouched');
  assert.ok(st.xpLog.slice(2).every(x => x.reason === 'Achievement') && st.totalXp === L.totalXp + st.xpLog.slice(2).reduce((a, x) => a + x.amount, 0), 'only achievement XP added on top');
  assert.deepEqual([st.vehicles.length, st.carServices.length, st.fuelEntries.length, st.stepsLog.length, st.heartRateLog.length, st.notes[0].favorite], [1, 1, 1, 1, 1, true], 'data without a UI stays');
  const b = st.plannerBlocks[0], e = st.events[0], s = st.sleepLog[0];
  assert.deepEqual([['endDate', 'repeat', 'doneDates', 'habitId'].filter(k => k in b), ['recurDays', 'recurUntil'].filter(k => k in e), 'qualityPct' in s, s.quality], [[], [], false, 3], 'no new optional field is forced onto old records');
  assert.deepEqual(await page.evaluate(() => [eventUpcomingDate(S.events[0]), plannerBlocksOn('2026-09-23').map(x => x.id).join(), plannerBlocksOn('2026-09-24').length]), ['2026-09-23', 'b1', 0], 'old recurrence and blocks read as before');
  // every screen renders with it, nothing is written by looking
  await persist(page); const before = JSON.stringify(await idbState(page));
  await page.evaluate(() => { for (const v of ['home', 'calendar', 'tasks', 'habits', 'goals', 'nutrition', 'health', 'finance', 'notes', 'journal', 'statistics', 'quests', 'settings']) { view = v; render(); } });
  await reload(page); await persist(page);
  assert.equal(JSON.stringify(await idbState(page)), before, 'a second boot (migrate again) changes nothing: idempotent');
  // export -> wipe in memory -> import: identical
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]);
  const exported = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(kept(exported), [], 'the backup holds every old record');
  await page.evaluate(() => { S.tasks = []; S.vehicles = []; S.stepsLog = []; S.sleepLog = []; });
  await importFile(page, await dl.path()); await settle(page);
  st = await stateOf(page);
  assert.deepEqual(st, exported, 'import restores the backup exactly'); assert.deepEqual(kept(st), []);
}, { state: legacyState() });

// ---------- Gym Workout Mode 3.0 (FW) ----------
// Fixture: two old quick-logged workouts (w1, w2: exercises[], no timing). fwSetup adds a "Push Day" template
// (Bench press 3 x 8-10 @ 80, Squat 3 x 5 @ 100). Time is moved with page.clock.setFixedTime (Date only; timers keep running).
const fwSetup = page => page.evaluate(() => {
  const bench = exerciseFind('Bench press'); if (!exerciseFind('Squat')) exerciseAddPreset('Squat');
  return templateSave({ name: 'Push Day', exercises: [{ exerciseId: bench.id, sets: 3, repsMin: 8, repsMax: 10, weight: 80 }, { exerciseId: exerciseFind('Squat').id, sets: 3, repsMin: 5, weight: 100 }] }).template.id;
});
const fwAt = (page, sec) => page.clock.setFixedTime(NOW + sec * 1000);
const fwStart = async page => { await openWorkouts(page); await page.click('.wkStartTpl'); return (await active(page)).id; };
const fwRow = (page, ei, si) => page.locator(`.wk-entry:nth-child(${ei + 1}) .ws-row[data-set]`).nth(si);
const fwTiming = page => page.evaluate(() => { const w = activeWorkout() || S.workouts[S.workouts.length - 1]; const t = workoutTiming(w, Date.now());
  return { total: t.totalSec, active: t.activeSec, rest: t.restSec, cardio: t.cardioSec, phase: t.phase, restFrom: t.restFrom }; });
const fwTick = page => page.evaluate(() => uiWkTick());

test('FW1 old workouts (quick-logged exercises[], Fitness 2.0 without timing) render with no timing, no NaN / undefined; their timing is all null', async ({ page }) => {
  const tid = await fwSetup(page);
  // a Fitness 2.0 workout finished before this pass: startedAt / finishedAt, sets without timestamps
  await page.evaluate(tid => { const r = workoutStart({ templateId: tid }); r.workout.entries[0].sets.forEach(s => s.done = true); workoutFinish(r.workout.id); }, tid);
  await openWorkouts(page);
  const r = await page.evaluate(() => [...S.workouts].map(w => { const t = workoutTiming(w, Date.now()); return [w.id.length > 2 ? 'f2' : w.id, t.totalSec != null, t.activeSec, t.restSec, t.cardioSec]; }));
  assert.deepEqual(r, [['w1', false, null, null, null], ['w2', false, null, null, null], ['f2', true, null, null, null]]);
  const txt = await page.locator('#app').innerText();
  assert.ok(!/undefined|NaN|0:NaN/.test(txt));
  assert.equal(await page.locator('#wList [data-hist]').count(), 0, 'no timing shown for workouts without it');
  for (const id of ['w1', 'w2']) assert.equal(await page.evaluate(id => !!S.workouts.find(w => w.id === id).exercises.length, id), true, 'old records untouched');
  // the old ones still open in their editors
  await page.click('.editBtn[aria-label="Upravit: Push day"]'); assert.equal(await page.inputValue('#w_name'), 'Push day'); await page.evaluate(() => closeSheets());
}, { state: fixtureState() });

test('FW2 + FW3 Start creates exactly one active session; a second Start (Fitness, template, planner) continues it, never a second one', async ({ page }) => {
  await fwSetup(page); const id = await fwStart(page);
  assert.equal(await page.locator('#wkLive').count(), 1);
  assert.equal(await page.evaluate(() => S.workouts.filter(w => w.status === 'active').length), 1);
  await openWorkouts(page); assert.match(await page.locator('#wkResume').innerText(), /Rozpracovaný trénink[\s\S]*Push Day/i);
  assert.equal(await page.locator('.wkStartTpl').count(), 0, 'no second Start while one runs');
  assert.deepEqual(await page.evaluate(() => { const r = workoutStart({ name: 'X' }); return [r.ok, r.reason, r.workout.id]; }), [false, 'active_exists', id]);
  await page.evaluate(() => uiStartWorkout({ name: 'Y' }));
  assert.deepEqual(await page.evaluate(() => [S.workouts.filter(w => w.status === 'active').length, activeWorkout().name]), [1, 'Push Day'], 'continues, never overwrites');
}, { state: fixtureState() });

test('FW4 + FW5-FW10 timers from timestamps: workout clock, Start set (ACTIVE + its clock), Finish set (DONE, duration), rest starts by itself, the next Start ends it (rest duration)', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  await fwAt(page, 125); await fwTick(page);
  assert.equal(await page.locator('#wkClock').innerText(), '2:05', 'workout time = now - startedAt');
  assert.equal(await fwRow(page, 0, 0).getAttribute('data-state'), 'ready');
  await page.click('.wsStart'); // set 1 of Bench press
  assert.equal(await fwRow(page, 0, 0).getAttribute('data-state'), 'active');
  assert.equal(await page.locator('.wsStart').count(), 0, 'one set at a time: no other Start while a set runs');
  await fwAt(page, 167); await fwTick(page);
  assert.equal(await fwRow(page, 0, 0).locator('[data-elapsed]').innerText(), '0:42');
  assert.match(await page.locator('#wkPhase').innerText(), /SÉRIE 1 · BENCH PRESS[\s\S]*0:42/i);
  await page.click('.wsFinish');
  let st = await page.evaluate(() => { const s = activeWorkout().entries[0].sets[0]; return [s.done, s.finishedAt - s.startedAt, workoutSetSec(s), s.weight, s.reps]; });
  assert.deepEqual(st, [true, 42000, 42, 80, 8], 'DONE, 42 s, plan values adopted');
  assert.match(await fwRow(page, 0, 0).innerText(), /0:42/);
  assert.equal((await fwTiming(page)).phase, 'rest', 'the rest starts by itself');
  await fwAt(page, 245); await fwTick(page);
  assert.match(await page.locator('#wkPhase').innerText(), /PAUZA[\s\S]*1:18/i);
  await page.click('.wk-entry:nth-child(1) .wsStart'); // set 2 ends the rest
  const t = await fwTiming(page);
  assert.deepEqual([t.phase, t.active, t.rest], ['set', 42, 78], 'rest 167 -> 245 s closed when set 2 starts');
  assert.equal(await page.evaluate(() => activeWorkout().entries[0].sets[1].startedAt - activeWorkout().startedAt), 245000, 'set 2 starts at the click');
}, { state: fixtureState() });

test('FW11 + FW12 kg / reps stay editable after a set is done and after the workout is finished: values change, timing and XP do not', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  await page.click('.wsStart'); await fwAt(page, 40); await page.click('.wsFinish');
  const x0 = await page.evaluate(() => [S.totalXp, S.xpLog.length]);
  await fwRow(page, 0, 0).locator('[data-f="reps"]').fill('10');
  assert.deepEqual(await page.evaluate(() => { const s = activeWorkout().entries[0].sets[0]; return [s.reps, s.done, workoutSetSec(s)]; }), [10, true, 40], 'only the value changed');
  await page.click('#wkFinish');
  const after = await page.evaluate(() => [S.totalXp, S.xpLog.length]);
  assert.deepEqual(await page.evaluate(() => S.xpLog.filter(x => /^workout:/.test(x.key || '')).map(x => x.amount)), [80], 'the workout pays its 80 XP once (achievements unlocked by it are their own entries)');
  await page.click('#wkSumEdit'); // "Opravit série" from the summary -> the finished workout's edit screen
  await fwRow(page, 0, 0).locator('[data-f="weight"]').fill('82.5');
  const w = await page.evaluate(() => { const w = S.workouts[S.workouts.length - 1], s = w.entries[0].sets[0]; return [w.status, s.weight, s.reps, workoutSetSec(s), S.totalXp, S.xpLog.length]; });
  assert.deepEqual(w, ['done', 82.5, 10, 40, after[0], after[1]], 'edit after finishing: no XP, no re-finish, timing kept');
}, { state: fixtureState() });

test('FW13-FW16 Finish: a running set is resolved first; summary with total / active / rest / cardio, exercises and cardio; active + rest + cardio <= total', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  await page.click('.wsStart'); await fwAt(page, 45); await page.click('.wsFinish');
  await fwAt(page, 135); await page.click('.wk-entry:nth-child(1) .wsStart'); await fwAt(page, 175); await page.click('.wsFinish'); // 40 s, rest 90 s
  await page.evaluate(() => workoutCardioAdd(activeWorkout().id, { type: 'run', durationSec: 900 }));
  await fwAt(page, 300); await page.click('.wk-entry:nth-child(2) .wsStart'); await fwAt(page, 330); // Squat set 1 running (rest 175 -> 300 = 125 s)
  await page.click('#wkFinish');
  assert.match(await page.locator('.cf-sheet').innerText(), /Série právě běží/);
  await page.click('#cf_ok'); await page.waitForSelector('#wkSummary');
  const w = await page.evaluate(() => { const w = S.workouts[S.workouts.length - 1], t = workoutTiming(w, Date.now()); return { st: w.status, t, d: w.finishedAt - w.startedAt, sets: workoutTotalSets(w) }; });
  assert.deepEqual([w.st, w.d, w.t.totalSec, w.t.activeSec, w.t.restSec, w.t.cardioSec, w.sets], ['done', 330000, 330, 115, 215, 900, 3], 'set 3 finished at 330 s');
  assert.ok(w.t.activeSec + w.t.restSec <= w.t.totalSec, 'sets + rests fit inside the workout (cardio was logged by hand here)');
  const sum = await page.locator('#wkSummary').innerText();
  assert.match(sum, /Trénink dokončen[\s\S]*CELKEM\s*5 min[\s\S]*AKTIVNÍ SÉRIE\s*1 min[\s\S]*PAUZY\s*3 min[\s\S]*KARDIO\s*15 min/i);
  assert.match(sum, /Bench press[\s\S]*2 série[\s\S]*80 kg × 8, 8[\s\S]*Aktivní série 1:25 · Pauzy 3:35[\s\S]*Squat[\s\S]*1 série/);
  assert.match(sum, /Běh · 15 min/);
  await page.click('#wkSumOk');
  assert.match(await page.locator('.workout-card').first().innerText(), /Aktivní série\s*1 min[\s\S]*Pauzy\s*3 min[\s\S]*Běh\s*15 min/, 'history shows the timing');
}, { state: fixtureState() });

test('FW17-FW19 reload: during a rest everything comes back (sets, kg, reps, timing, the running rest); a short running set continues; a set found running long after a reload is asked about - finish now or discard its time', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  await page.click('.wsStart'); await fwAt(page, 42); await page.click('.wsFinish'); await fwRow(page, 0, 0).locator('[data-f="reps"]').fill('9'); await settle(page);
  await fwAt(page, 100); await persist(page); await reload(page);
  await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  let t = await fwTiming(page);
  assert.deepEqual([t.phase, t.restFrom - NOW, t.active], ['rest', 42000, 42], 'the rest runs on from the stored finish');
  assert.equal(await fwRow(page, 0, 0).locator('[data-f="reps"]').inputValue(), '9');
  await fwTick(page); assert.match(await page.locator('#wkPhase').innerText(), /0:58/);
  assert.equal(await page.locator('#wkClock').innerText(), '1:40');
  // a short running set survives a reload as running (no question)
  await page.click('.wk-entry:nth-child(1) .wsStart'); await settle(page); await fwAt(page, 130); await reload(page);
  await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  assert.equal(await page.locator('#wkStale').isVisible(), false); assert.equal(await fwRow(page, 0, 1).getAttribute('data-state'), 'active');
  // the same set found 20 minutes later: asked, never auto-finished
  await fwAt(page, 100 + 20 * 60); await reload(page); await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  assert.match(await page.locator('#wkStale').innerText(), /Tato série byla aktivní při zavření aplikace[\s\S]*Dokončit nyní · 20:00[\s\S]*Zrušit čas série/);
  assert.equal(await page.locator('#wkPhase').isVisible(), false, 'no running clock pretends the set went on');
  assert.equal(await page.evaluate(() => activeWorkout().entries[0].sets[1].done), false);
  await page.click('#wkStaleReset');
  assert.deepEqual(await page.evaluate(() => { const s = activeWorkout().entries[0].sets[1]; return [workoutSetState(s), 'startedAt' in s, s.done]; }), ['ready', false, false], 'back to READY, no time stored');
  // and "Finish now" records what the person confirms
  await page.click('.wk-entry:nth-child(1) .wsStart'); await settle(page); await fwAt(page, 100 + 40 * 60); await reload(page); await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  await page.click('#wkStaleFinish');
  assert.equal(await page.evaluate(() => workoutSetSec(activeWorkout().entries[0].sets[1])), 20 * 60, 'finished now: the duration shown on the button');
}, { state: fixtureState() });

test('FW20 + FW21 leaving the workout never ends it (Home, Calendar, Nutrition, Character, back to Fitness); close + reopen restores it; a workout left over the next day asks before it finishes at its last activity', async ({ page }) => {
  await fwSetup(page); const id = await fwStart(page);
  await page.click('.wsStart'); await fwAt(page, 50); await page.click('.wsFinish');
  const before = JSON.stringify(await active(page));
  for (const v of ['home', 'calendar', 'nutrition', 'character', 'notes']) await page.evaluate(v => { view = v; render(); }, v);
  assert.equal(JSON.stringify(await active(page)), before, 'navigating writes nothing to the session');
  await openWorkouts(page); await page.click('#wkContinue');
  assert.equal(await fwRow(page, 0, 0).getAttribute('data-state'), 'done');
  // close the tab, open a new one
  await persist(page); const ctx = page.context(); const p2 = await ctx.newPage(); await page.close();
  await p2.clock.setFixedTime(NOW + 60000); await p2.goto(URL_); await booted(p2);
  assert.equal(await p2.evaluate(() => activeWorkout() && activeWorkout().id), id);
  await p2.evaluate(() => { fitnessTab = 'workouts'; uiWorkoutView = null; view = 'fitness'; render(); });
  assert.match(await p2.locator('#wkResume').innerText(), /Push Day[\s\S]*1:00/);
  // the next day: the session is asked about
  await p2.clock.setFixedTime(NOW + 26 * 3600000); await p2.evaluate(() => { uiWorkoutView = { mode: 'active' }; render(); });
  assert.match(await p2.locator('#wkStale').innerText(), /Tento trénink pořád běží[\s\S]*Dokončit k poslední aktivitě[\s\S]*Pokračovat v tréninku/);
  await p2.click('#wkStaleEnd'); await p2.waitForSelector('#wkSummary');
  assert.deepEqual(await p2.evaluate(id => { const w = workoutFindById(id); return [w.status, w.finishedAt - w.startedAt, workoutTiming(w, Date.now()).restSec]; }, id), ['done', 50000, null], 'ends at the last set, no invented day-long rest');
}, { state: fixtureState() });

test('FW22 multi-tab: a second tab is blocked while the workout runs; after the first closes it takes over and restores the workout with the right timing', async ({ page }) => {
  const errs = [];
  await fwSetup(page); await fwStart(page); await page.click('.wsStart'); await fwAt(page, 30); await page.click('.wsFinish'); await settle(page);
  const B = await extraTab(page, errs); await B.waitForSelector('#tabLock');
  assert.equal(await B.evaluate(() => !!S), false, 'blocked tab has no data and cannot write the workout');
  await page.close(); await B.waitForLoadState(); await ownerReady(B); await injectRawIdb(B);
  await B.clock.setFixedTime(NOW + 90000);
  await B.evaluate(() => { fitnessTab = 'workouts'; uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); uiWkTick(); });
  assert.deepEqual(await B.evaluate(() => { const t = workoutTiming(activeWorkout(), Date.now()); return [t.phase, t.restFrom - activeWorkout().startedAt, t.activeSec]; }), ['rest', 30000, 30]);
  assert.match(await B.locator('#wkPhase').innerText(), /PAUZA[\s\S]*1:00/i);
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

test('FW23-FW28 cardio: + Přidat kardio opens the form only on demand; manual Běh 25 min; timer (Chůze, start -> finish); several entries; edit type / duration; delete asks (cancel keeps); invalid durations refused; 0 extra XP', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  const x0 = await page.evaluate(() => [S.totalXp, JSON.stringify(S.attrs), S.xpLog.length]);
  assert.equal(await page.locator('#cd_min').count(), 0, 'no form until asked');
  await page.click('#cdAdd'); assert.equal(await page.getAttribute('[data-cd-type="run"]', 'aria-checked'), 'true');
  for (const bad of ['0', '-5', '']) { await page.fill('#cd_min', bad); await page.click('#cd_save'); assert.equal(await page.locator('.cd-form [data-err="durationSec"]').isVisible(), true, `refused: "${bad}"`); }
  await page.fill('#cd_min', '25'); await page.click('#cd_save');
  assert.deepEqual(await page.evaluate(() => activeWorkout().cardio.map(c => [c.type, c.durationSec, 'startedAt' in c])), [['run', 1500, false]]);
  await page.click('#cdAdd'); await page.click('[data-cd-type="walk"]'); await page.click('#cd_timer');
  assert.match(await page.locator('#wkPhase').innerText(), /KARDIO · CHŮZE/i);
  assert.equal(await page.locator('.wsStart').count(), 0, 'no set starts while cardio runs');
  await fwAt(page, 600); await fwTick(page); assert.match(await page.locator('[data-cardio] [data-elapsed]').innerText(), /10:00/);
  await page.click('.cdFinish');
  assert.deepEqual(await page.evaluate(() => activeWorkout().cardio.map(c => [c.type, c.durationSec])), [['run', 1500], ['walk', 600]], 'several entries');
  await page.click('#cdAdd'); await page.click('[data-cd-type="stairs"]'); await page.fill('#cd_min', '12'); await page.click('#cd_save');
  const walk = page.locator('.cd-row', { hasText: 'Chůze' });
  await walk.locator('.cdEdit').click(); await page.click('[data-cd-type="run"]'); await page.fill('#cd_min', '11.5'); await page.click('#cd_save');
  assert.deepEqual(await page.evaluate(() => activeWorkout().cardio.map(c => [c.type, c.durationSec])), [['run', 1500], ['run', 690], ['stairs', 720]], 'edited type and duration');
  await page.locator('.cd-row', { hasText: 'Schody' }).locator('.cdDel').click(); assert.match(await page.locator('.cf-sheet').innerText(), /Smazat kardio/); await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => activeWorkout().cardio.length), 3, 'cancel keeps');
  await page.locator('.cd-row', { hasText: 'Schody' }).locator('.cdDel').click(); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => activeWorkout().cardio.length), 2);
  assert.deepEqual(await page.evaluate(() => [S.totalXp, JSON.stringify(S.attrs), S.xpLog.length]), x0, 'cardio pays nothing');
  assert.deepEqual(await page.evaluate(() => [workoutCardioAdd(activeWorkout().id, { type: 'swim', durationSec: 60 }).ok, workoutCardioAdd(activeWorkout().id, { type: 'run', durationSec: 0 }).ok, workoutCardioAdd(activeWorkout().id, { type: 'run', durationSec: 90000 }).ok]), [false, false, false]);
  // a cardio timer survives a reload (it runs on by timestamp); found 4 h later it is asked about
  await page.click('#cdAdd'); await page.click('#cd_timer'); await settle(page); await fwAt(page, 900); await reload(page); await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); uiWkTick(); });
  assert.match(await page.locator('#wkPhase').innerText(), /KARDIO · BĚH[\s\S]*5:00/i);
  await fwAt(page, 4 * 3600); await reload(page); await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  assert.match(await page.locator('#wkStale').innerText(), /Kardio běželo při zavření aplikace/);
  await page.click('#wkStaleReset'); assert.equal(await page.locator('.cd-form').count(), 1, 'enter the real duration instead');
  assert.equal(await page.evaluate(() => activeWorkout().cardio.some(c => c.startedAt && !c.finishedAt)), false);
}, { state: fixtureState() });

test('FW29-FW32 XP freeze: start / finish set, rest, cardio, edits, reload, summary pay 0; Finish pays 80 XP exactly once with the same attributes; the quest completes once; the daily workout cap is unchanged', async ({ page }) => {
  await fwSetup(page); await quietQuests(page);
  const snap = () => page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog.length, S.attrs, S.quests.length, S.achievementsUnlocked]));
  const s0 = await snap();
  await fwStart(page); await page.click('.wsStart'); await fwAt(page, 30); await page.click('.wsFinish'); await fwAt(page, 90);
  await page.click('.wk-entry:nth-child(1) .wsStart'); await fwAt(page, 120); await page.click('.wsFinish');
  await fwRow(page, 0, 0).locator('[data-f="reps"]').fill('12'); await page.evaluate(() => workoutCardioAdd(activeWorkout().id, { type: 'stairs', durationSec: 300 }));
  await persist(page); await reload(page); await page.evaluate(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); });
  assert.equal(await snap(), s0, 'nothing before Finish pays');
  const a0 = await page.evaluate(() => ({ ...S.attrs })), x0 = await page.evaluate(() => S.totalXp);
  await page.click('#wkFinish'); await page.waitForSelector('#wkSummary');
  const a1 = await page.evaluate(() => ({ ...S.attrs })), x1 = await page.evaluate(() => S.totalXp);
  assert.equal(x1 - x0, 80); assert.deepEqual(['STR', 'VIT', 'DEX'].map(k => a1[k] - a0[k]), [24, 14, 10], 'fitness profile split unchanged');
  await page.click('#wkSumOk'); await page.evaluate(() => { checkQuests(); for (const v of ['home', 'fitness', 'quests']) { view = v; render(); } });
  const w = await page.evaluate(() => S.workouts[S.workouts.length - 1].id);
  assert.equal(await page.evaluate(id => S.xpLog.filter(x => x.key === `workout:${id}:${todayStr()}`).length, w), 1, 'one workout ledger entry');
  await page.evaluate(id => workoutFinish(id), w); assert.equal(await page.evaluate(() => S.totalXp), x1, 'finishing again pays nothing');
  // daily cap: still 2 rewarded workouts a day (the review rule), a third pays 0
  const third = await page.evaluate(() => { const pay = () => { const r = workoutStart({ name: 'Extra' }); workoutAddEntry(r.workout.id, exerciseFind('Bench press').id).sets[0].done = true; const a = S.totalXp; workoutFinish(r.workout.id); return S.totalXp - a; }; return [pay(), pay()]; });
  assert.deepEqual(third, [80, 0], 'the second rewarded workout of the day pays, the third does not');
}, { state: fixtureState() });

test('FW30 quest compatibility: dq_workout completes once, at Finish (not at set start / finish / cardio)', async ({ page }) => {
  await fwSetup(page);
  await page.evaluate(() => { S.workouts = S.workouts.filter(w => w.date !== todayStr()); S.settings.trainingDays = [0, 1, 2, 3, 4, 5, 6]; S.questBoard = { daily: { stamp: todayStr(), items: [{ id: 'dq_workout', p: {} }, { id: 'x1' }, { id: 'x2' }] }, weekly: { stamp: weekStart(), items: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] } }; });
  await fwStart(page); await page.click('.wsStart'); await fwAt(page, 30); await page.click('.wsFinish');
  await page.evaluate(() => workoutCardioAdd(activeWorkout().id, { type: 'run', durationSec: 600 }));
  assert.equal(await page.evaluate(() => { checkQuests(); return S.quests.filter(q => q.questId === 'dq_workout').length; }), 0, 'not before Finish');
  await page.click('#wkFinish'); await page.click('#wkSumOk');
  assert.equal(await page.evaluate(() => { checkQuests(); checkQuests(); return S.quests.filter(q => q.questId === 'dq_workout').length; }), 1);
}, { state: fixtureState() });

test('FW33-FW36 data: an old backup imports; a new workout with set timing + cardio survives export -> reset -> import; reset ends the active session (no timer left); deleting a workout asks and leaves no reference', async ({ page }) => {
  await fwSetup(page); await fwStart(page); await page.click('.wsStart'); await fwAt(page, 42); await page.click('.wsFinish');
  await page.evaluate(() => workoutCardioAdd(activeWorkout().id, { type: 'walk', durationSec: 1200 })); await fwAt(page, 100); await page.click('#wkFinish'); await page.click('#wkSumOk');
  const done = await page.evaluate(() => JSON.parse(JSON.stringify(S.workouts[S.workouts.length - 1])));
  await fwStart(page); await page.click('.wsStart'); await settle(page); // a second, running session
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]); const file = await dl.path();
  const exp = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(exp.workouts.find(w => w.id === done.id), done, 'set timing, cardio and both timestamps are in the backup');
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [S.workouts.length, activeWorkout(), document.querySelectorAll('[data-elapsed]').length]), [0, null, 0], 'reset: no session, no running clock');
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); });
  await importFile(page, file); await settle(page);
  const back = await page.evaluate(id => JSON.parse(JSON.stringify(S.workouts.find(w => w.id === id))), done.id);
  assert.deepEqual(back, done); assert.equal(await page.evaluate(() => workoutTiming(S.workouts.find(w => w.status === 'done' && w.cardio), Date.now()).activeSec), 42);
  assert.equal(await page.evaluate(() => !!activeWorkout()), true, 'the backup also restores the running session');
  // an old backup (no timing anywhere) imports cleanly
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixtureState())) }); await settle(page);
  assert.deepEqual(await page.evaluate(() => S.workouts.map(w => w.id)), ['w1', 'w2']);
  await openWorkouts(page); assert.ok(!/NaN|undefined/.test(await page.locator('#app').innerText()));
  // delete a finished workout: asks, removes only it; XP stays
  const x = await page.evaluate(() => S.totalXp);
  await page.locator('.workout-card', { hasText: 'Pull day' }).locator('.delbtn').click(); assert.match(await page.locator('.cf-sheet').innerText(), /Smazat trénink/); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [S.workouts.map(w => w.id), S.totalXp, activeWorkout(), plannerLinks(S.plannerBlocks.find(b => b.id === 'pb_push')).workout]), [['w1'], x, null, null], 'a block that linked it resolves to no workout (as before)');
}, { state: fixtureState() });

test('FW37-FW40 template compatibility, add exercise during the workout, add / remove sets (a done set asks), previous performance "Minule"', async ({ page }) => {
  const tid = await fwSetup(page); const t0 = await page.evaluate(id => JSON.stringify(templateFind(id)), tid);
  // a finished Bench press workout gives the next one its "Minule" line
  await page.evaluate(tid => { const r = workoutStart({ templateId: tid }); r.workout.entries[0].sets.forEach((s, i) => { s.done = true; s.reps = 10 - i; }); workoutFinish(r.workout.id); }, tid);
  await fwStart(page);
  assert.match(await page.locator('.wk-entry').first().locator('.wk-last').innerText(), /Minule\s*80 kg × 10, 9, 8/i);
  await page.click('.wk-entry:nth-child(1) .wkAddSet'); await fwRow(page, 0, 3).locator('[data-f="weight"]').fill('85');
  assert.equal(await page.evaluate(id => JSON.stringify(templateFind(id)), tid), t0, 'session edits never touch the template');
  await page.click('#wkAddEx'); await page.locator('.wk-pick-row', { hasText: 'Deadlift' }).first().click();
  assert.deepEqual(await page.evaluate(() => activeWorkout().entries.map(e => [e.name, e.sets.length])), [['Bench press', 4], ['Squat', 3], ['Deadlift', 1]]);
  assert.equal(await page.evaluate(id => JSON.stringify(templateFind(id)), tid), t0);
  // remove: an untouched set goes at once, a done one asks
  await fwRow(page, 0, 3).locator('.ws-rm').click(); assert.equal(await page.evaluate(() => activeWorkout().entries[0].sets.length), 3);
  await page.click('.wsStart'); await fwAt(page, 20); await page.click('.wsFinish');
  await fwRow(page, 0, 0).locator('.ws-rm').click(); assert.match(await page.locator('.cf-sheet').innerText(), /XP za trénink se nemění/); await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => activeWorkout().entries[0].sets.length), 3);
  await fwRow(page, 0, 0).locator('.ws-rm').click(); await page.click('#cf_ok');
  assert.deepEqual(await page.evaluate(() => [activeWorkout().entries[0].sets.length, workoutTiming(activeWorkout(), Date.now()).activeSec]), [2, null], 'timing re-derived from the remaining sets');
}, { state: fixtureState() });

test('FW41-FW46 + FW48 training readiness: good / low / insufficient / old sleep without quality / recent load; reasons always shown; read-only and deterministic with an explicit now', async ({ page }) => {
  const r = await page.evaluate(() => {
    const T = todayStr(), now = Date.now(), D = n => addDays(T, n);
    const base = () => { const st = JSON.parse(JSON.stringify(S)); st.workouts = []; st.sleepLog = []; st.settings.trainingDays = null; return st; };
    const wk = d => ({ id: 'w' + d, name: 'W', date: D(d), status: 'done', entries: [] });
    const A = base(); A.sleepLog = [{ id: 'a', date: T, bedtime: '23:00', wake: '07:00', qualityPct: 90 }]; A.workouts = [wk(-2)];
    const B = base(); B.sleepLog = [{ id: 'b', date: T, bedtime: '01:00', wake: '06:00', qualityPct: 40 }]; B.workouts = [wk(-1)];
    const C = base(); C.workouts = [wk(-3)];
    const Dd = base(); Dd.sleepLog = [{ id: 'd', date: T, bedtime: '23:30', wake: '07:00', quality: '4' }];
    const E = base(); E.sleepLog = [{ id: 'e', date: T, bedtime: '23:00', wake: '07:00' }]; E.workouts = [wk(-1), wk(-2), wk(-3), wk(-4)];
    const F = base(); F.sleepLog = [{ id: 'f', date: T, bedtime: '23:00', wake: '07:00' }]; F.workouts = [wk(0), wk(-1), wk(-2), wk(-4), wk(-5)]; F.settings.trainingDays = [new Date(T + 'T00:00').getDay()];
    const out = {}; const before = JSON.stringify(S);
    for (const [k, st] of Object.entries({ A, B, C, D: Dd, E, F })) { const x = trainingReadiness(st, now); out[k] = [x.level, x.score, x.reasons.map(r => r.text)]; }
    out.same = JSON.stringify(trainingReadiness(A, now)) === JSON.stringify(trainingReadiness(A, now));
    out.readonly = JSON.stringify(S) === before; return out; });
  assert.deepEqual(r.A, ['good', 97, ['Spánek 8 h 00 min', 'Kvalita spánku 90 %', 'Poslední trénink před 2 dny', '1 trénink za posledních 7 dní']]);
  assert.deepEqual(r.B, ['low', 30, ['Spánek 5 h 00 min', 'Kvalita spánku 40 %', 'Poslední trénink včera', '1 trénink za posledních 7 dní']]);
  assert.deepEqual(r.C, ['insufficient', null, ['Dnešní spánek není zapsaný', 'Poslední trénink před 3 dny', '1 trénink za posledních 7 dní']], 'no sleep: no score');
  assert.deepEqual(r.D, ['good', 100, ['Spánek 7 h 30 min', 'Kvalita spánku nezadaná (počítá se jen délka)', 'Zatím žádný dokončený trénink', '0 tréninků za posledních 7 dní']], 'old 1-5 quality: duration only');
  assert.deepEqual(r.E, ['good', 95, ['Spánek 8 h 00 min', 'Kvalita spánku nezadaná (počítá se jen délka)', 'Poslední trénink včera', '4 tréninky za posledních 7 dní']]);
  assert.deepEqual(r.F, ['medium', 65, ['Spánek 8 h 00 min', 'Kvalita spánku nezadaná (počítá se jen délka)', 'Dnes už máš dokončený trénink', '3 tréninky za poslední 3 dny', '5 tréninků za posledních 7 dní', 'Podle plánu je dnes tréninkový den']]);
  assert.ok(r.same && r.readonly, 'deterministic and read-only');
  // the card: an estimate, with its reasons; insufficient data asks for sleep; nothing is written by rendering it
  await page.evaluate(() => { S.sleepLog = S.sleepLog.filter(x => x.date !== todayStr()); }); await persist(page);
  const idb0 = JSON.stringify(await idbState(page));
  await openWorkouts(page);
  const card = await page.locator('#fitReady').innerText();
  assert.match(card, /Dnešní připravenost[\s\S]*Odhad podle dat v LifeOS[\s\S]*Nedostatek dat[\s\S]*Pro lepší odhad zapiš dnešní spánek[\s\S]*Proč:/i);
  assert.ok(!/\d+ ?%.*připraven/i.test(card) && !/NaN|undefined/.test(card), 'no fake percentage');
  await page.waitForTimeout(400); assert.equal(JSON.stringify(await idbState(page)), idb0, 'readiness writes nothing');
  await page.click('#frSleep'); assert.equal(await page.locator('.sheet #sl_date').count(), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(S.dailyScores)), await page.evaluate(() => JSON.stringify(S.dailyScores)), 'Daily Score snapshots untouched');
}, { state: fixtureState() });

test('FW47 + FW48 the 1 s tick only updates the clocks: no render, same nodes, a focused kg field keeps focus, its typed value and the scroll position; nothing is saved by the tick', async ({ page }) => {
  await fwSetup(page); await fwStart(page); await page.click('.wsStart'); await fwAt(page, 10); await page.click('.wsFinish'); await persist(page);
  await page.evaluate(() => { window.__renders = 0; const r = render; render = function () { window.__renders++; return r.apply(this, arguments); }; window.__idbWrites = 0; const s = idbSet; idbSet = function () { window.__idbWrites++; return s.apply(this, arguments); }; });
  const inp = fwRow(page, 0, 1).locator('[data-f="reps"]'); await inp.click(); await page.keyboard.press('End'); await page.keyboard.type('5');
  await settle(page); await page.evaluate(() => { window.__idbWrites = 0; window.scrollTo(0, 200); }); // the typed value's own save is done
  const mark = await page.evaluate(() => { document.querySelector('.wk-entry').__mark = 1; return [document.activeElement.dataset.f, document.activeElement.value, scrollY]; });
  await fwAt(page, 75); await page.waitForTimeout(2300); // two real 1 s ticks
  const after = await page.evaluate(() => [document.activeElement.dataset.f, document.activeElement.value, scrollY, window.__renders, document.querySelector('.wk-entry').__mark, window.__idbWrites]);
  assert.deepEqual(after.slice(0, 3), mark, 'focus, typed value and scroll kept');
  assert.deepEqual(after.slice(3), [0, 1, 0], 'no render, same DOM, no write by the tick');
  assert.match(await page.locator('#wkPhase').innerText(), /1:05/, 'the clock text still moved');
}, { state: fixtureState() });

test('FW49 + FW50 caret: the tap that focuses a numeric field puts the caret after the value (80 -> 805); a second tap, a drag selection, Tab focus and arrow keys keep the browser behaviour', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  const kg = fwRow(page, 0, 0).locator('[data-f="weight"]'); const bb = await kg.boundingBox();
  await page.mouse.click(bb.x + 4, bb.y + bb.height / 2); await page.keyboard.type('5');
  assert.equal(await kg.inputValue(), '805', 'caret at the end, not |80');
  await page.mouse.click(bb.x + 4, bb.y + bb.height / 2); await page.mouse.click(bb.x + 4, bb.y + bb.height / 2); await page.keyboard.type('1');
  assert.equal(await kg.inputValue(), '1805', 'a later click in the focused field is the person\'s own caret');
  await kg.fill('80'); await page.focus('#wk_name'); await page.keyboard.press('Shift+Tab');
  await page.evaluate(() => { const r = document.querySelector('.wk-entry .ws-row[data-set] [data-f="reps"]'); r.focus(); });
  await page.keyboard.press('ArrowUp'); assert.equal(await fwRow(page, 0, 0).locator('[data-f="reps"]').inputValue(), '9', 'arrow keys still step');
  // other numeric editors share the same helper (a decimal text field: drag selection is kept)
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'cx'; i.inputMode = 'decimal'; i.value = '12345'; i.style.cssText = 'position:fixed;top:300px;left:20px;width:220px;font-size:20px;z-index:99'; document.body.appendChild(i); });
  const c = await page.locator('#cx').boundingBox();
  await page.mouse.move(c.x + 3, c.y + c.height / 2); await page.mouse.down(); await page.mouse.move(c.x + 70, c.y + c.height / 2, { steps: 6 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => { const i = document.getElementById('cx'); return [i.selectionStart > 0 || i.selectionEnd > 0, i.selectionStart !== i.selectionEnd]; }), [true, true], 'drag selection not overwritten');
  await page.evaluate(() => document.getElementById('cx').remove());
  // cardio minutes and the sleep / water / finance number fields are type=number: same helper
  await page.click('#cdAdd'); await page.fill('#cd_min', '25'); await page.evaluate(() => document.activeElement.blur());
  const cm = await page.locator('#cd_min').boundingBox(); await page.mouse.click(cm.x + 4, cm.y + cm.height / 2); await page.keyboard.type('5');
  assert.equal(await page.inputValue('#cd_min'), '255');
}, { state: fixtureState() });

const FW_WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1440];
test('FW51-FW57 + FW59 every Gym Mode screen at 320-1440 px, dark + light: no overflow, no duplicate ids, no undefined / NaN, 44 px targets, no animation with reduced motion', async ({ page }) => {
  const tid = await fwSetup(page);
  await page.evaluate(tid => { S.sleepLog.push({ id: 'qq', date: todayStr(), bedtime: '23:00', wake: '07:04', qualityPct: 87 });
    const r = workoutStart({ templateId: tid }); const w = r.workout; const s = w.entries[0].sets; s[0].startedAt = Date.now() - 300000; s[0].finishedAt = Date.now() - 258000; s[0].done = true;
    s[1].startedAt = Date.now() - 20000; uiWkLiveIds.add(s[1].id); workoutCardioAdd(w.id, { type: 'stairs', durationSec: 600 }); }, tid);
  const scenes = {
    overview: "uiWorkoutView=null;view='fitness';render()",
    set: "uiWorkoutView={mode:'active'};view='fitness';render()",
    rest: "{const w=activeWorkout(),s=w.entries[0].sets[1];if(!s.done){s.finishedAt=Date.now();s.done=true;}}uiWorkoutView={mode:'active'};view='fitness';render()",
    cardioForm: "uiWorkoutView={mode:'active'};view='fitness';render();openCardioForm(activeWorkout(),null)",
    stale: "{const w=activeWorkout(),s=w.entries[1].sets[0];if(!s.startedAt){s.startedAt=Date.now()-3600000;}}uiWorkoutView={mode:'active'};view='fitness';render()",
    summary: "uiWorkoutView=null;view='fitness';render();openWorkoutSummary(S.workouts.find(w=>w.id==='__done'),true)",
    history: "uiWorkoutView=null;view='fitness';render();window.scrollTo(0,document.body.scrollHeight)",
    edit: "uiWorkoutView={mode:'edit',id:'__done'};view='fitness';render()" };
  await page.evaluate(tid => { const w = JSON.parse(JSON.stringify(activeWorkout())); w.id = '__done'; w.status = 'done'; w.finishedAt = Date.now(); w.entries[1].sets[0].startedAt = undefined; w.entries[0].sets[1].startedAt = undefined; w.cardio = [{ id: 'c', type: 'run', durationSec: 900 }]; S.workouts.unshift(w); }, tid);
  const bad = [];
  for (const theme of ['dark', 'light']) for (const width of FW_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const [k, js] of Object.entries(scenes)) {
      const r = await page.evaluate(({ js, theme }) => { closeSheets(); S.settings.theme = theme; applyTheme(); eval(js); uiWkTick();
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id), sheet = document.querySelector('.sheet');
        const small = [...document.querySelectorAll('.wk-screen button, #fitReady button, .wk-cardio button, .cd-form button, .wk-summary button, .wk-phase button, .wk-stale button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 36).map(b => b.className);
        const big = [...document.querySelectorAll('.wsStart, .wsFinish, .wkPhFinish, .wkPhCdFinish, #cdAdd, #cd_save, #cd_timer, .cd-type, #wkStaleFinish, #wkStaleReset, #frSleep')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).map(b => b.id || b.className);
        const anim = [...document.querySelectorAll('.wk-phase, .ws-row.is-active, .fit-ready, .cd-row')].filter(n => getComputedStyle(n).animationName !== 'none' && parseFloat(getComputedStyle(n).animationDuration) > 0.01).length;
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0,
          dup: ids.filter((x, i) => ids.indexOf(x) !== i), nan: /undefined|NaN|\[object/.test(document.body.innerText), small, big, anim,
          live: [...document.querySelectorAll('[data-elapsed]')].filter(n => n.closest('[aria-live]')).length }; }, { js, theme });
      const issues = [r.over > 0 && 'overflow ' + r.over, r.sheetOver > 0 && 'sheet overflow', r.dup.length && 'dup ' + r.dup, r.nan && 'NaN/undefined', r.small.length && 'small ' + r.small, r.big.length && '<44px ' + r.big, r.anim && 'animated', r.live && 'aria-live clock'].filter(Boolean);
      if (issues.length) bad.push(`${theme}/${width}/${k}: ${issues.join('; ')}`);
    }
  }
  assert.deepEqual(bad, []);
}, { state: fixtureState() });

test('FW58 keyboard: Start / Finish set, the cardio form (type radio + Save) and Finish workout work from the keyboard with visible focus; clocks are not announced every second', async ({ page }) => {
  await fwSetup(page); await fwStart(page);
  await page.focus('.wsStart'); await page.keyboard.press('Enter');
  assert.equal(await fwRow(page, 0, 0).getAttribute('data-state'), 'active');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('wsFinish')), true, 'focus moves to Finish set');
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + getComputedStyle(document.activeElement).boxShadow), 'nonenone', 'focus visible');
  await fwAt(page, 33); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => workoutSetSec(activeWorkout().entries[0].sets[0])), 33);
  await page.focus('#cdAdd'); await page.keyboard.press('Enter'); await page.focus('[data-cd-type="stairs"]'); await page.keyboard.press('Space');
  await page.focus('#cd_min'); await page.keyboard.type('8'); await page.focus('#cd_save'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => activeWorkout().cardio.map(c => [c.type, c.durationSec])), [['stairs', 480]]);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-elapsed]')].some(n => n.closest('[aria-live],[role="timer"],[role="status"]'))), false, 'no live region on second clocks');
  for (const sel of ['.wsStart', '.ws-rm', '.cdDel', '.cdEdit']) assert.ok(await page.evaluate(sel => [...document.querySelectorAll(sel)].every(b => (b.getAttribute('aria-label') || b.textContent).trim().length > 2), sel), sel);
  await page.focus('#wkFinish'); await page.keyboard.press('Enter'); await page.waitForSelector('#wkSummary');
}, { state: fixtureState() });

test('FW60 performance (a year: 1 500 tasks, 25 000 XP, 150 timed workouts, 300 sleep records): Fitness overview, active workout, 1 s tick, readiness, summary', async ({ page }) => {
  await withGen(page);
  const r = await page.evaluate(() => { S = defaultState(); S.settings.onboarded = true; closeSheets(); Object.assign(S, window.__gen(1500, 25000, 3)); const T = todayStr();
    const bench = exerciseFind('Bench press') || exerciseAddPreset('Bench Press').exercise, sq = exerciseFind('Squat') || exerciseAddPreset('Squat').exercise;
    for (let i = 0; i < 300; i++) S.sleepLog.push({ id: 'ps' + i, date: addDays(T, -i), bedtime: '23:00', wake: '07:00', qualityPct: 60 + i % 40 });
    for (let i = 0; i < 150; i++) { const d = addDays(T, -i * 2 - 1), t0 = new Date(d + 'T17:00').getTime();
      const en = [bench, sq].map((x, j) => ({ id: 'e' + i + j, exerciseId: x.id, name: x.name, measurement: 'weight_reps', target: null, notes: '', sets: Array.from({ length: 4 }, (_, k) => ({ id: `s${i}${j}${k}`, weight: 80 + j * 20, reps: 8, done: true, warmup: false, startedAt: t0 + (j * 4 + k) * 180000, finishedAt: t0 + (j * 4 + k) * 180000 + 40000 })) }));
      S.workouts.push({ id: 'pw' + i, name: 'Push', date: d, status: 'done', startedAt: t0, finishedAt: t0 + 3000000, entries: en, cardio: [{ id: 'c' + i, type: 'run', durationSec: 900 }] }); }
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    const out = { overview: m(() => { fitnessTab = 'workouts'; uiWorkoutView = null; view = 'fitness'; render(); }, 5), readiness: m(() => trainingReadiness(S, Date.now()), 21) };
    const w = workoutStart({ name: 'Push', templateId: '' }).workout; [bench, sq].forEach(x => workoutAddEntry(w.id, x.id)); w.entries.forEach(e => { for (let k = 0; k < 3; k++) workoutAddSet(w.id, e.id); });
    workoutStartSet(w.id, w.entries[0].id, w.entries[0].sets[0].id, Date.now()); uiWkLiveIds.add(w.entries[0].sets[0].id);
    out.active = m(() => { uiWorkoutView = { mode: 'active' }; view = 'fitness'; render(); }, 5);
    out.tick = m(() => uiWkTick(), 41);
    out.summary = m(() => { closeSheets(); openWorkoutSummary(S.workouts.find(x => x.id === 'pw0'), false); }, 5); closeSheets();
    out.bad = (render(), /undefined|NaN/.test(document.getElementById('app').innerText)); return out; });
  console.log('      FW60 ' + Object.entries(r).filter(([k]) => k !== 'bad').map(([k, v]) => `${k} ${v.toFixed(2)} ms`).join(', '));
  assert.ok(!r.bad);
  assert.ok(r.tick < 2, 'the 1 s tick is cheap'); assert.ok(r.readiness < 10, 'readiness under 10 ms');
  assert.ok(r.overview < 150 && r.active < 150 && r.summary < 100, 'renders stay smooth');
}, { state: fixtureState() });

test('FW59b data safety (merge blocker): an old realistic state of the previous version boots without onboarding or reset, keeps every record, gets no forced new fields, boots idempotently and survives export -> reset -> import', async ({ page }) => {
  const L = legacyState(); L.schemaVersion = 8; L.workouts = [];
  L.workouts.push({ id: 'fw_old', name: 'Push 2.0', date: '2026-09-21', status: 'done', startedAt: 1790000000000, finishedAt: 1790003600000, templateId: 'tp1', plannerBlockId: 'b1', duration: '60', notes: '', exercises: [],
    entries: [{ id: 'en1', exerciseId: 'ex_b', name: 'Bench press', measurement: 'weight_reps', target: null, notes: '', sets: [{ id: 'st1', weight: 80, reps: 8, done: true, warmup: false }] }], plan: [], createdAt: 1 });
  L.workoutTemplates = [{ id: 'tp1', name: 'Push', exercises: [{ exerciseId: 'ex_b', sets: 3, repsMin: 8 }], createdAt: 1 }];
  L.exerciseLibrary = [{ id: 'ex_b', name: 'Bench press', measurement: 'weight_reps', muscles: { Chest: 100 }, archived: false, source: 'user', createdAt: 1 }];
  // deep containment: every old value is still there unchanged (main's own Muscle XP migration may add a `muscles`
  // snapshot to old done entries -- an addition, never a change)
  const has = (o, m) => o === null || typeof o !== 'object' ? JSON.stringify(o) === JSON.stringify(m) : Array.isArray(o) ? Array.isArray(m) && m.length === o.length && o.every((x, i) => has(x, m[i])) : !!m && typeof m === 'object' && Object.keys(o).every(f => has(o[f], m[f]));
  const kept = st => Object.keys(L).filter(k => Array.isArray(L[k])).flatMap(k => L[k].filter(rec => !has(rec, (st[k] || []).find(x => x.id === rec.id))).map(rec => k + ':' + rec.id));
  await page.evaluate(async st => { S = st; await rawIdbPut(st); }, L); await reload(page);
  let st = await stateOf(page);
  assert.deepEqual(kept(st), [], 'every record and field (workouts, templates, exercises, tasks, goals, habits, planner, nutrition, sleep, finance, notes)');
  assert.deepEqual([st.schemaVersion, st.settings.onboarded, await page.locator('#ob_name').count(), st.profile.name], [8, true, 0, 'Starý účet'], 'no onboarding, no reset');
  assert.deepEqual(st.xpLog.slice(0, 2), L.xpLog, 'XP history kept');
  const fw = st.workouts.find(w => w.id === 'fw_old');
  assert.deepEqual([('cardio' in fw), ('startedAt' in fw.entries[0].sets[0]), ('totalDurationSec' in fw)], [false, false, false], 'no new field forced onto old workouts');
  await page.evaluate(() => { fitnessTab = 'workouts'; uiWorkoutView = null; view = 'fitness'; render(); });
  assert.ok(!/NaN|undefined/.test(await page.locator('#app').innerText()));
  await persist(page); const once = JSON.stringify(await idbState(page)); await reload(page); await persist(page);
  assert.equal(JSON.stringify(await idbState(page)), once, 'second boot changes nothing');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]); const file = await dl.path();
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); }); await importFile(page, file); await settle(page);
  st = await stateOf(page); assert.deepEqual(kept(st), [], 'after export -> reset -> import');
  assert.deepEqual(st, JSON.parse(readFileSync(file, 'utf8')));
}, { state: fixtureState() });

// ---------- Apple Health Bridge 1.0 (AH) ----------
// A realistic 30-day payload as the documented "LifeOS Health Sync" shortcut builds it (Europe/Prague, CEST +02:00):
// daily grouped metrics, weight measurements, raw sleep stage samples (23:30 -> 07:12, Awake / Core / Deep / REM / In Bed).
function ahPayload({ to = '2026-09-23', days = 30, gen = '2026-09-23T09:30:00+02:00', drop = [] } = {}) {
  const pad = n => String(n).padStart(2, '0'), add = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const from = add(to, -(days - 1)), list = Array.from({ length: days }, (_, i) => add(from, i));
  const off = d => d >= '2026-10-25' ? '+01:00' : '+02:00';
  const iso = (d, hm) => `${d}T${hm}:00${off(d)}`;
  const M = { steps: [], activeEnergy: [], exerciseTime: [], walkingRunningDistance: [], flightsClimbed: [], restingHeartRate: [], heartRateVariability: [], vo2Max: [], weight: [] };
  const sleep = [];
  list.forEach((d, i) => {
    if (!drop.includes('steps') && i % 11 !== 5) M.steps.push({ date: d, value: 6000 + i * 137, unit: 'count' });
    M.activeEnergy.push({ date: d, value: 380 + i * 7.5, unit: 'kcal' });
    M.exerciseTime.push({ date: d, value: 20 + i % 40, unit: 'min' });
    M.walkingRunningDistance.push({ date: d, value: 4.2 + i / 10, unit: 'km' });
    if (i % 3) M.flightsClimbed.push({ date: d, value: 5 + i % 9, unit: 'count' });
    M.restingHeartRate.push({ date: d, value: 52 + i % 6, unit: 'count/min' });
    if (i % 10 !== 3) M.heartRateVariability.push({ date: d, value: 48 + i % 20, unit: 'ms' });
    if (i % 7 === 0) M.vo2Max.push({ date: d, value: 44 + i / 10, unit: 'ml/(kg·min)' });
    if (i % 8 === 1) { M.weight.push({ date: `${d}T07:05:00${off(d)}`, value: 82 - i / 20, unit: 'kg' }); M.weight.push({ date: `${d}T21:40:00${off(d)}`, value: 82.6 - i / 20, unit: 'kg' }); }
    if (i % 15 === 7) return; // a night without sleep data
    const prev = add(d, -1); // 23:30 -> 07:12 with stages
    sleep.push({ start: iso(prev, '23:30'), end: iso(prev, '23:42'), value: 'Awake' });
    sleep.push({ start: iso(prev, '23:42'), end: iso(d, '01:10'), value: 'Core' });
    sleep.push({ start: iso(d, '01:10'), end: iso(d, '02:05'), value: 'Deep' });
    sleep.push({ start: iso(d, '02:05'), end: iso(d, '03:40'), value: 'Core' });
    sleep.push({ start: iso(d, '03:40'), end: iso(d, '04:25'), value: 'REM' });
    sleep.push({ start: iso(d, '04:25'), end: iso(d, '04:31'), value: 'Awake' });
    sleep.push({ start: iso(d, '04:31'), end: iso(d, '06:20'), value: 'Core' });
    sleep.push({ start: iso(d, '06:20'), end: iso(d, '07:12'), value: 'REM' });
    sleep.push({ start: iso(prev, '23:25'), end: iso(d, '07:15'), value: 'In Bed' });
  });
  if (drop.includes('hrv')) delete M.heartRateVariability;
  return { protocol: 'lifeos-apple-health', version: 1, generatedAt: gen, deviceTimezone: 'Europe/Prague', range: { from, to }, metrics: M, sleep };
}
const ahText = o => JSON.stringify(ahPayload(o));
const ahRewards = page => page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.quests, S.questBoard, S.achievementsUnlocked, S.achievementUnlockedAt, S.dailyScores, S.workouts, S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog, S.meals, S.waterLog]));
const ahDo = (page, txt, force) => page.evaluate(({ txt, force }) => { const r = ahParse(txt); return { parse: r, imp: r.ok ? ahImport(r, { force }) : null }; }, { txt, force });

test('AH1 + AH2 + AH58 an old state (no appleHealth) boots unchanged: no store is created, resolvers fall back to manual data, Health says "not connected", old backups import', async ({ page }) => {
  const st = await stateOf(page);
  assert.equal('appleHealth' in st, false, 'nothing is added at boot');
  const r = await page.evaluate(() => [ahStore(), ahPreferred(), getEffectiveSleep(todayStr()).source, getEffectiveSleep(todayStr()).minutes, getEffectiveActiveCalories(todayStr()), getEffectiveWeight(todayStr()), getEffectiveSteps(todayStr()), ahLatest('hrvMs', todayStr())]);
  assert.deepEqual(r, [null, false, 'manual', 435, { value: 380, source: 'manual' }, { value: 81.6, source: 'manual' }, { value: 4300, source: 'manual' }, null]);
  await page.evaluate(() => { healthTab = 'sleep'; view = 'health'; render(); });
  assert.match(await page.locator('#ahCard').innerText(), /Apple Health není propojené/);
  assert.equal(await page.locator('.ah-tile').count(), 0, 'no empty metric cards');
  await page.evaluate(() => { view = 'settings'; render(); });
  assert.match(await page.locator('#st_ah').innerText(), /Apple Health Bridge[\s\S]*Zatím nesynchronizováno[\s\S]*Synchronizovat Apple Health[\s\S]*Načíst data ze schránky[\s\S]*Vložit data ručně[\s\S]*lokálně přes Apple Shortcuts/);
  assert.equal(await page.locator('#st_ahPref').count() + await page.locator('#st_ahClear').count(), 0, 'no preference / clear before any import');
  await importFile(page, { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacyState())) }); await settle(page);
  assert.equal(await page.evaluate(() => 'appleHealth' in S), false);
}, { state: fixtureState() });

test('AH3 + AH48 + AH8-AH22 a valid 30-day payload: preview counts; sleep nights (stages, awake out, across midnight, missing nights), every metric with units, weight = last of the day, missing metrics absent (never 0)', async ({ page }) => {
  const { parse: r } = await page.evaluate(txt => ({ parse: ahParse(txt) }), ahText());
  assert.equal(r.ok, true); assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.counts, { sleep: 28, steps: 27, activeKcal: 30, exerciseMin: 30, distanceKm: 30, flights: 20, weightKg: 4, weighIns: 8, restingHr: 30, hrvMs: 27, vo2Max: 5, workouts: 0 });
  const d = r.days['2026-09-23'];
  const { segments, ...dsl } = d.sleep;
  assert.deepEqual(dsl, { totalMin: 444, stages: true, bedtime: '23:42', wake: '07:12', awakeMin: 18, coreMin: 292, deepMin: 55, remMin: 97 }, 'Core 292 + Deep 55 + REM 97 = 444; Awake 18 and In Bed are not sleep; filed under the wake-up day');
  const segMin = st => segments.filter(x => st.includes(x.stage)).reduce((a, x) => a + (Date.parse(x.end) - Date.parse(x.start)) / 60000, 0);
  assert.deepEqual([segMin(['core', 'deep', 'rem', 'asleep']), segMin(['core']), segMin(['deep']), segMin(['rem']), segMin(['awake']), segments.some(x => x.stage === 'inbed')], [444, 292, 55, 97, 18, false], 'the stage timeline adds up to the same totals; In Bed is never a segment');
  assert.deepEqual([d.steps, d.activeKcal, d.exerciseMin, d.distanceKm, d.flights, d.restingHr, d.hrvMs], [9973, 597.5, 49, 7.1, 7, 57, 57]);
  assert.equal(r.days['2026-09-01'].sleep, undefined, 'a night with no samples has no sleep (not 0)');
  assert.equal(r.days['2026-08-30'].steps, undefined, 'a day without steps has no steps (not 0)');
  assert.deepEqual([r.days['2026-08-26'].weightKg, r.days['2026-09-03'].weightKg], [82.55, 82.15], 'two weigh-ins a day: the later one (21:40, not the 07:05 one)');
  assert.equal(r.days['2026-08-25'].vo2Max, 44);
  // units: mi -> km, lb -> kg, kJ -> kcal; an unknown unit is refused
  const u = await page.evaluate(() => ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-23', to: '2026-09-23' },
    metrics: { walkingRunningDistance: [{ date: '2026-09-23', value: 5, unit: 'mi' }], weight: [{ date: '2026-09-23', value: 180, unit: 'lb' }], activeEnergy: [{ date: '2026-09-23', value: 1000, unit: 'kJ' }], heartRateVariability: [{ date: '2026-09-23', value: 50, unit: 'furlong' }] } })));
  assert.deepEqual([u.days['2026-09-23'].distanceKm, u.days['2026-09-23'].weightKg, u.days['2026-09-23'].activeKcal, u.days['2026-09-23'].hrvMs, u.warnings], [8.05, 81.65, 239.01, undefined, [{ k: 'bad_value', n: 1 }]]);
  // the preview through the manual paste sheet
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPaste');
  await page.fill('#ah_paste', ahText()); await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /Apple Health import[\s\S]*25\.08\.2026 – 23\.09\.2026 · 30 dní[\s\S]*Spánek\s*28 nocí[\s\S]*Aktivní energie\s*30 dní[\s\S]*Kroky\s*beta\s*27 dní[\s\S]*Hmotnost\s*8 měření[\s\S]*HRV\s*27 dní[\s\S]*Importovat/);
  assert.equal(await page.evaluate(() => 'appleHealth' in S), false, 'no blind import: nothing stored before "Importovat"');
  await page.click('#ah_import');
  const st = await stateOf(page);
  assert.deepEqual([Object.keys(st.appleHealth.days).length, st.appleHealth.preferred, st.appleHealth.lastPayloadGeneratedAt, st.appleHealth.lastRange, st.appleHealth.deviceTimezone], [30, true, '2026-09-23T09:30:00+02:00', { from: '2026-08-25', to: '2026-09-23' }, 'Europe/Prague']);
}, { state: fixtureState() });

test('AH9-AH12 sleep rules: crossing midnight -> the wake-up day; an evening nap after 18:00 counts for the next day; no stages -> "Asleep" duration; overlapping iPhone + Watch samples never counted twice; unknown labels skipped; Czech labels and HealthKit numbers understood', async ({ page }) => {
  const r = await page.evaluate(() => { const P = sleep => JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-20', to: '2026-09-23' }, sleep });
    const x = ahParse(P([
      { start: '2026-09-20T23:45:00+02:00', end: '2026-09-21T07:42:00+02:00', value: 'Asleep' },                          // no stages (iPhone)
      { start: '2026-09-21T23:00:00+02:00', end: '2026-09-22T03:00:00+02:00', value: 'Asleep Core' },                     // Watch stages ...
      { start: '2026-09-22T03:00:00+02:00', end: '2026-09-22T06:00:00+02:00', value: 'Asleep Deep' },
      { start: '2026-09-21T23:10:00+02:00', end: '2026-09-22T05:30:00+02:00', value: 'Asleep' },                          // ... overlapped by the iPhone
      { start: '2026-09-22T19:00:00+02:00', end: '2026-09-22T19:40:00+02:00', value: 'Jádrový spánek' },                  // evening nap -> 23rd
      { start: '2026-09-22T23:30:00+02:00', end: '2026-09-23T06:30:00+02:00', value: 4 },                                 // HealthKit deep
      { start: '2026-09-23T06:30:00+02:00', end: '2026-09-23T06:50:00+02:00', value: 'Bdělý' },
      { start: '2026-09-23T06:50:00+02:00', end: '2026-09-23T07:00:00+02:00', value: 'Something new' },
      { start: '2026-09-23T07:00:00+02:00', end: '2026-09-23T06:00:00+02:00', value: 'Core' }]));                        // negative
    return { d21: x.days['2026-09-21'].sleep, d22: x.days['2026-09-22'].sleep, d23: x.days['2026-09-23'].sleep, w: x.warnings }; });
  assert.deepEqual(r.d21, { totalMin: 477, stages: false, bedtime: '23:45', wake: '07:42', segments: [{ start: '2026-09-20T23:45:00+02:00', end: '2026-09-21T07:42:00+02:00', stage: 'asleep' }] }, 'no stages: the asleep duration (one neutral "asleep" segment, no invented stages)');
  assert.deepEqual([r.d22.totalMin, r.d22.coreMin, r.d22.deepMin, r.d22.remMin, r.d22.stages], [420, 240, 180, 0, true], 'union 23:00-06:00 = 420, the iPhone overlap is not added');
  assert.deepEqual([r.d23.totalMin, r.d23.deepMin, r.d23.coreMin, r.d23.awakeMin, r.d23.bedtime, r.d23.wake], [460, 420, 40, 20, '19:00', '06:30'], 'nap 40 + night 420; awake 20 not sleep');
  assert.deepEqual(r.w, [{ k: 'unknown_sleep', n: 1 }, { k: 'bad_value', n: 1 }]);
}, { state: fixtureState() });

test('AH46 + AH47 time zone and DST (Europe/Prague): summer, winter and the night of 25 Oct (CEST -> CET) are filed under the right day with real durations; UTC times use deviceTimezone', async ({ page }) => {
  const r = await page.evaluate(() => { const P = (sleep, from, to, tz) => JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: to + 'T09:00:00+01:00', deviceTimezone: tz, range: { from, to }, sleep });
    const summer = ahParse(P([{ start: '2026-07-14T23:00:00+02:00', end: '2026-07-15T07:00:00+02:00', value: 'Core' }], '2026-07-15', '2026-07-15', 'Europe/Prague')).days['2026-07-15'].sleep.totalMin;
    const winter = ahParse(P([{ start: '2026-01-14T23:00:00+01:00', end: '2026-01-15T07:00:00+01:00', value: 'Core' }], '2026-01-15', '2026-01-15', 'Europe/Prague')).days['2026-01-15'].sleep.totalMin;
    const dst = ahParse(P([{ start: '2026-10-24T23:00:00+02:00', end: '2026-10-25T07:00:00+01:00', value: 'Core' }], '2026-10-25', '2026-10-25', 'Europe/Prague')).days['2026-10-25'].sleep;
    const spring = ahParse(P([{ start: '2026-03-28T23:00:00+01:00', end: '2026-03-29T07:00:00+02:00', value: 'Core' }], '2026-03-29', '2026-03-29', 'Europe/Prague')).days['2026-03-29'].sleep.totalMin;
    // UTC strings: 05:30Z on 25 Oct is 06:30 in Prague -> 25 Oct, and 22:30Z on 24 Oct is 00:30 on the 25th
    const z = ahParse(P([{ start: '2026-10-24T22:30:00Z', end: '2026-10-25T05:30:00Z', value: 'REM' }], '2026-10-25', '2026-10-25', 'Europe/Prague')).days['2026-10-25'].sleep;
    return { summer, winter, dst, spring, z: [z.totalMin, z.bedtime, z.wake] }; });
  assert.deepEqual([r.summer, r.winter, r.spring], [480, 480, 420], 'spring forward night: 7 real hours');
  assert.deepEqual([r.dst.totalMin, r.dst.bedtime, r.dst.wake], [540, '23:00', '07:00'], 'fall back night: 9 real hours, filed on 25 Oct');
  assert.deepEqual(r.z, [420, '00:30', '06:30']);
}, { state: fixtureState() });

test('AH4-AH7 + AH28 + AH43-AH45 the importer refuses bad input and never crashes: invalid JSON, wrong protocol, future major version, > 5 MB, forbidden keys, bad range; malformed / negative / NaN / Infinity / absurd values are skipped', async ({ page }) => {
  const r = await page.evaluate(() => { const ok = { protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-20', to: '2026-09-23' } };
    const e = x => ahParse(typeof x === 'string' ? x : JSON.stringify(x)).errors[0];
    return { json: e('{not json'), arr: e('[1,2]'), proto: e({ ...ok, protocol: 'other' }), v2: e({ ...ok, version: 2 }), v0: e({ ...ok, version: 'x' }), v11: ahParse(JSON.stringify({ ...ok, version: 1.4, metrics: { steps: [{ date: '2026-09-23', value: 5 }] } })).ok,
      big: e('x'.repeat(5 * 1024 * 1024 + 1)), keys: e('{"protocol":"lifeos-apple-health","version":1,"__proto__":{"polluted":1}}'), keys2: e({ ...ok, metrics: { constructor: [] } }), polluted: ({}).polluted,
      gen: e({ ...ok, generatedAt: 'yesterday' }), range: e({ ...ok, range: { from: '2026-09-23', to: '2026-09-20' } }), long: e({ ...ok, range: { from: '2026-01-01', to: '2026-09-23' } }), empty: e(''), nodata: e(ok),
      bad: ahParse(JSON.stringify({ ...ok, metrics: { steps: [{ date: '2026-09-21', value: -5 }, { date: '2026-02-30', value: 10 }, { date: '2026-09-22', value: 'NaN' }, { date: '2026-09-23', value: 1e999 }, { date: '2026-09-20', value: 'Infinity' }, 7, null],
        restingHeartRate: [{ date: '2026-09-21', value: 400 }, { date: '2026-09-22', value: 55 }], activeEnergy: [{ date: '2026-09-21', value: -100 }, { date: '2025-09-21', value: 100 }], heartRateVariability: [{ date: '2026-09-21', value: { x: 1 } }] },
        sleep: [{ start: '2026-09-21T07:00:00+02:00', end: '2026-09-21T06:00:00+02:00', value: 'Core' }, { start: 'nope', end: 'x', value: 'Core' }, { start: '2026-09-19T07:00:00+02:00', end: '2026-09-21T06:00:00+02:00', value: 'Core' }] })) }; });
  assert.deepEqual([r.json, r.arr, r.proto, r.v2, r.v0, r.v11, r.big, r.keys, r.keys2, r.polluted, r.gen, r.range, r.long, r.empty, r.nodata],
    ['json', 'json', 'protocol', 'version_future', 'version', true, 'too_large', 'keys', 'keys', undefined, 'generated', 'range', 'range_long', 'empty', 'no_data']);
  assert.equal(r.bad.ok, true, 'one good value is enough; the bad ones are skipped');
  assert.deepEqual(r.bad.days, { '2026-09-22': { restingHr: 55 } });
  assert.deepEqual(r.bad.warnings.map(w => w.k + ':' + w.n).sort(), ['bad_date:2', 'bad_entry:2', 'bad_value:9', 'out_of_range:1'].sort());
  // in the UI: an error message, the app keeps working
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPaste'); await page.fill('#ah_paste', '{"protocol":"x"'); await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /Data nelze importovat[\s\S]*Text není platný JSON/);
  await page.click('#ah_retry'); await page.fill('#ah_paste', JSON.stringify({ protocol: 'lifeos-apple-health', version: 9, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-23', to: '2026-09-23' } })); await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /verzi protokolu LifeOS ještě nezná/);
  await page.click('#ah_cancel'); assert.equal(await page.evaluate(() => 'appleHealth' in S), false);
}, { state: fixtureState() });

test('AH23 + AH24 + AH25 + AH59 + AH60 idempotent: the same payload 10x gives the same state (no duplicates, no new sync time); a newer sync replaces the same metric of the same day only; an older payload is ignored unless forced', async ({ page }) => {
  await ahDo(page, ahText());
  const s1 = await page.evaluate(() => JSON.stringify(S.appleHealth));
  for (let i = 0; i < 10; i++) assert.deepEqual((await ahDo(page, ahText())).imp, { ok: true, changed: false, days: 0 });
  assert.equal(await page.evaluate(() => JSON.stringify(S.appleHealth)), s1, '10 more imports: identical store');
  // 20:00 sync: today's steps grew, HRV missing in this payload -> HRV of today stays
  const later = ahPayload({ gen: '2026-09-23T20:00:00+02:00', drop: ['hrv'] }); later.metrics.steps.find(x => x.date === '2026-09-23').value = 14200;
  assert.equal((await ahDo(page, JSON.stringify(later))).imp.changed, true);
  assert.deepEqual(await page.evaluate(() => { const d = S.appleHealth.days['2026-09-23']; return [d.steps, d.hrvMs, S.appleHealth.lastPayloadGeneratedAt, Object.keys(S.appleHealth.days).length]; }), [14200, 57, '2026-09-23T20:00:00+02:00', 30]);
  // the old 09:30 payload again: refused by default, the newer value stays
  const old = await ahDo(page, ahText());
  assert.deepEqual(old.imp, { ok: false, reason: 'older' }); assert.equal(await page.evaluate(() => S.appleHealth.days['2026-09-23'].steps), 14200);
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPaste'); await page.fill('#ah_paste', ahText()); await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /starší než poslední import/); assert.equal(await page.locator('#ah_import').count(), 0);
  await page.click('#ah_force');
  assert.deepEqual(await page.evaluate(() => [S.appleHealth.days['2026-09-23'].steps, S.appleHealth.lastPayloadGeneratedAt]), [9973, '2026-09-23T20:00:00+02:00'], 'forced: values from it, the newest generatedAt stays the reference');
}, { state: fixtureState() });

test('AH26-AH30 manual Health data is never touched; Apple preferred ON / OFF switches the effective source (value + source); manual sleep quality stays manual; the preference survives reload', async ({ page }) => {
  const manual0 = await page.evaluate(() => JSON.stringify([S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog]));
  await page.evaluate(() => { const e = S.sleepLog.find(x => x.date === todayStr()); e.qualityPct = 70; });
  await ahDo(page, ahText());
  const eff = () => page.evaluate(() => { const T = todayStr(); const s = getEffectiveSleep(T); return [s.minutes, s.source, s.qualityPct, s.qualitySource, getEffectiveActiveCalories(T), getEffectiveWeight('2026-08-26'), getEffectiveSteps(T)]; });
  assert.deepEqual(await eff(), [444, 'appleHealth', 70, 'manual', { value: 597.5, source: 'appleHealth' }, { value: 82.55, source: 'appleHealth' }, { value: 9973, source: 'appleHealth' }]);
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPref');
  assert.deepEqual(await eff(), [435, 'manual', 70, 'manual', { value: 380, source: 'manual' }, null, { value: 4300, source: 'manual' }]);
  await settle(page); await reload(page);
  assert.equal(await page.evaluate(() => S.appleHealth.preferred), false, 'kept after reload');
  assert.equal(await page.evaluate(() => Object.keys(S.appleHealth.days).length), 30, 'switching off deletes nothing');
  await page.evaluate(() => { const e = S.sleepLog.find(x => x.date === todayStr()); delete e.qualityPct; });
  assert.equal(await page.evaluate(() => JSON.stringify([S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog])), manual0, 'manual logs exactly as before');
  // mixed sources on the Health screen
  await page.evaluate(() => { S.appleHealth.preferred = true; healthTab = 'sleep'; view = 'health'; render(); });
  assert.match(await page.locator('[data-ah="sleep"]').innerText(), /7 h 24 min[\s\S]*Apple Health/, 'the effective (Apple) value with its source badge');
  assert.match(await page.locator('#hBody').innerText(), /23\.09\.2026[\s\S]*7\.25h · 23:30–06:45/, 'the manual list is unchanged');
}, { state: fixtureState() });

test('AH31 training readiness uses the Apple Health sleep duration (manual quality kept, never invented); HRV / resting HR / VO2 max never change the score; preference OFF = manual as before', async ({ page }) => {
  const r = await page.evaluate(() => { const T = todayStr(), now = Date.now();
    const st = JSON.parse(JSON.stringify(S)); st.workouts = []; st.sleepLog = [{ id: 'm', date: T, bedtime: '00:30', wake: '06:00', qualityPct: 80 }]; st.settings.trainingDays = null;
    const manualOnly = trainingReadiness(st, now);
    st.appleHealth = { version: 1, preferred: true, days: { [T]: { sleep: { totalMin: 480, stages: true }, hrvMs: 20, restingHr: 90, vo2Max: 30 } } };
    const apple = trainingReadiness(st, now);
    st.appleHealth.days[T].hrvMs = 120; st.appleHealth.days[T].restingHr = 40; const apple2 = trainingReadiness(st, now);
    st.sleepLog = []; const noQuality = trainingReadiness(st, now);
    st.appleHealth.preferred = false; const off = trainingReadiness(st, now);
    return { manualOnly: [manualOnly.level, manualOnly.score, manualOnly.reasons[0].text], apple: [apple.level, apple.score, apple.reasons.map(x => x.text)], same: apple.score === apple2.score,
      noQuality: [noQuality.score, noQuality.reasons[1].text], off: off.level }; });
  assert.deepEqual(r.manualOnly, ['medium', 59, 'Spánek 5 h 30 min'], '5.5 h band 50 -> round(0.7 x 50 + 0.3 x 80) = 59');
  assert.deepEqual(r.apple, ['good', 94, ['Spánek 8 h 00 min (Apple Health)', 'Kvalita spánku 80 % (zadaná ručně)', 'Zatím žádný dokončený trénink', '0 tréninků za posledních 7 dní']]);
  assert.equal(r.same, true, 'HRV / resting HR do not move the score');
  assert.deepEqual(r.noQuality, [100, 'Kvalita spánku nezadaná (počítá se jen délka)']);
  assert.equal(r.off, 'insufficient', 'preference off: only the manual sleep (none here)');
}, { state: fixtureState() });

test('AH32-AH36 + AH17 rewards: importing, re-importing, rendering every screen and the quest / achievement / Daily Score checks after an import change no XP, attributes, quests, achievements, Daily Score history, workouts or manual logs', async ({ page }) => {
  await page.evaluate(() => { finalizeDailyScores(); checkQuests(); checkAchievements(); }); await persist(page);
  const r0 = await ahRewards(page), ds0 = await page.evaluate(() => JSON.stringify([dailyScore(todayStr()), questBoardFor('daily').map(x => [x.q.id, questVal(x.q, x.p)])]));
  await ahDo(page, ahText()); await ahDo(page, ahText({ gen: '2026-09-23T21:00:00+02:00' }));
  await page.evaluate(() => { checkQuests(); checkAchievements(); finalizeDailyScores(); for (const v of ['home', 'health', 'fitness', 'quests', 'character', 'statistics', 'settings', 'calendar']) { view = v; render(); } checkQuests(); });
  assert.equal(await ahRewards(page), r0, 'no reward, no quest, no Daily Score snapshot, no manual record changed');
  assert.equal(await page.evaluate(() => JSON.stringify([dailyScore(todayStr()), questBoardFor('daily').map(x => [x.q.id, questVal(x.q, x.p)])])), ds0, 'the live Daily Score and quest progress do not read Apple Health (v1)');
  assert.equal(await page.evaluate(() => S.xpLog.some(x => /apple|health/i.test(x.reason || '') && !/Sleep/.test(x.reason))), false);
}, { state: fixtureState() });

test('AH37-AH39 export contains appleHealth (data, last sync, preference); export -> reset -> import restores it; reset removes it; "Delete imported Apple Health data" asks and removes only S.appleHealth', async ({ page }) => {
  await ahDo(page, ahText()); await page.evaluate(() => { S.appleHealth.preferred = false; }); await persist(page);
  const before = await stateOf(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]); const file = await dl.path();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).appleHealth, before.appleHealth);
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => 'appleHealth' in S), false, 'reset removes it');
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); }); await importFile(page, file); await settle(page);
  assert.deepEqual(await stateOf(page), before, 'restored exactly');
  // clear only Apple Health
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahClear');
  assert.match(await page.locator('.cf-sheet').innerText(), /Smažou se jen data importovaná z Apple Health/); await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => !!S.appleHealth), true, 'cancel keeps');
  await page.click('#st_ahClear'); await page.click('#cf_ok');
  const after = await stateOf(page); const b2 = JSON.parse(JSON.stringify(before)); delete b2.appleHealth;
  assert.deepEqual(after, b2, 'everything else identical');
}, { state: fixtureState() });

test('AH40 Web Locks: a blocked second tab never imports (no data, no store); the importer refuses while the tab is not the owner', async ({ page }) => {
  const errs = []; const B = await extraTab(page, errs); await B.waitForSelector('#tabLock');
  assert.equal(await B.evaluate(() => !!S), false);
  assert.deepEqual(await page.evaluate(txt => { tabActive = false; const r = ahImport(ahParse(txt)); tabActive = true; return [r, 'appleHealth' in S]; }, ahText()), [{ ok: false, reason: 'locked' }, false]);
  assert.deepEqual(errs, []);
}, { state: fixtureState() });

test('AH41 + AH42 + AH56 + AH57 sync flow: Sync opens shortcuts://run-shortcut?name=LifeOS%20Health%20Sync and shows "may be ready"; the clipboard is read only on the tap; a refused clipboard falls back to the paste sheet; works offline; no request leaves the page', async ({ page }) => {
  const requests = []; page.on('request', r => { if (!r.url().startsWith(URL_)) requests.push(r.url()); });
  await page.evaluate(() => { window.__ahUrls = []; uiAhOpenUrl = u => window.__ahUrls.push(u); window.__clipReads = 0; const orig = navigator.clipboard && navigator.clipboard.readText; navigator.clipboard.readText = async () => { window.__clipReads++; throw new DOMException('denied', 'NotAllowedError'); }; view = 'settings'; render(); });
  await page.context().setOffline(true);
  await page.click('#st_ahSync');
  assert.deepEqual(await page.evaluate(() => window.__ahUrls), ['shortcuts://run-shortcut?name=LifeOS%20Health%20Sync']);
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); render(); });
  assert.match(await page.locator('#ahPending').innerText(), /Apple Health data mohou být připravena[\s\S]*Načíst data/);
  assert.equal(await page.evaluate(() => window.__clipReads), 0, 'never read without a tap (render / visibilitychange)');
  await page.click('#ahLoad');
  assert.equal(await page.evaluate(() => window.__clipReads), 1);
  assert.match(await page.locator('.ah-paste').innerText(), /Schránku se nepodařilo přečíst. Vlož data ručně/);
  await page.fill('#ah_paste', ahText()); await page.click('#ah_check'); await page.click('#ah_import');
  assert.equal(await page.evaluate(() => Object.keys(S.appleHealth.days).length), 30, 'imported offline');
  assert.equal(await page.locator('#ahPending').count(), 0, 'the banner goes away after the import');
  // clipboard allowed: the tap reads it and shows the preview
  await page.evaluate(txt => { navigator.clipboard.readText = async () => { window.__clipReads++; return txt; }; S.appleHealth.lastPayloadGeneratedAt = null; view = 'settings'; render(); }, ahText({ gen: '2026-09-23T22:00:00+02:00' }));
  await page.click('#st_ahRead'); assert.match(await page.locator('#ahPreview').innerText(), /Spánek\s*28 nocí/);
  await page.context().setOffline(false);
  assert.deepEqual(requests, [], 'no network request (no upload of Health data)');
  assert.equal(await page.evaluate(() => /fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test([ahParse, ahImport, uiAhReadClipboard, uiAhSync, uiAhPreview, uiAhPasteSheet].map(f => f.toString()).join(''))), false);
}, { state: fixtureState() });

test('AH49 + AH50 performance: a normal 30-day payload parses + imports well under 100 ms, a large valid one (62 days, ~25 000 sleep samples) stays usable; resolvers and readiness < 2 ms; the Health screen renders fast', async ({ page }) => {
  const big = ahPayload({ days: 62, to: '2026-09-23' }); const extra = [];
  for (const s of big.sleep) for (let k = 0; k < 40; k++) extra.push(s); big.sleep = big.sleep.concat(extra);
  const r = await page.evaluate(({ normal, big }) => {
    const m = (f, n) => { f(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[Math.floor(n / 2)]; };
    const out = { size: big.length, parse: m(() => ahParse(normal), 9) };
    out.import = m(() => { delete S.appleHealth; ahImport(ahParse(normal)); }, 9);
    out.big = m(() => ahParse(big), 3); const pb = ahParse(big); out.bigOk = pb.ok && pb.days['2026-09-23'].sleep.totalMin === 444;
    out.resolver = m(() => { const T = todayStr(); getEffectiveSleep(T); getEffectiveActiveCalories(T); getEffectiveWeight(T); getEffectiveSteps(T); ahLatest('hrvMs', T); }, 51);
    out.readiness = m(() => trainingReadiness(S, Date.now()), 51);
    out.health = m(() => { healthTab = 'sleep'; view = 'health'; render(); }, 7);
    return out; }, { normal: ahText(), big: JSON.stringify(big) });
  console.log(`      AH50 parse ${r.parse.toFixed(2)} ms, parse+import ${r.import.toFixed(2)} ms, big (${(r.size / 1e6).toFixed(1)} MB) ${r.big.toFixed(1)} ms, resolvers ${r.resolver.toFixed(3)} ms, readiness ${r.readiness.toFixed(3)} ms, Health render ${r.health.toFixed(1)} ms`);
  assert.ok(r.bigOk, 'the 40 x duplicated samples are not counted twice');
  assert.ok(r.import < 100 && r.parse < 100, '30-day import < 100 ms'); assert.ok(r.resolver < 2 && r.readiness < 2);
  assert.ok(r.big < 2000 && r.health < 150);
}, { state: fixtureState() });

const AH_WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440];
test('AH51-AH55 screens at 320-1440 px, dark + light: Settings (empty / synced), Health without / with / mixed data, preview, error, paste fallback, pending banner - no overflow, ids, NaN; 44 px targets; named controls; switch role', async ({ page }) => {
  const scenes = {
    settingsEmpty: "delete S.appleHealth;view='settings';render();document.getElementById('st_ah').scrollIntoView()",
    healthEmpty: "delete S.appleHealth;healthTab='sleep';view='health';render()",
    healthData: "ahImport(ahParse(window.__ah));healthTab='sleep';view='health';render()",
    settingsData: "ahImport(ahParse(window.__ah));view='settings';render();document.getElementById('st_ah').scrollIntoView()",
    preview: "delete S.appleHealth;view='settings';render();uiAhPreview(window.__ah)",
    error: "view='settings';render();uiAhPreview('{bad')",
    paste: "view='settings';render();uiAhPasteSheet(uiAhT('clip_fail'))",
    pending: "ahImport(ahParse(window.__ah));uiAhPendingSet(true);healthTab='weight';view='health';render()" };
  await page.evaluate(txt => { window.__ah = txt; }, ahText());
  const bad = [];
  for (const theme of ['dark', 'light']) for (const width of AH_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const [k, js] of Object.entries(scenes)) {
      const r = await page.evaluate(({ js, theme }) => { closeSheets(); uiAhPendingSet(false); S.settings.theme = theme; applyTheme(); eval(js);
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id), sheet = document.querySelector('.sheet');
        const ctl = [...document.querySelectorAll('#st_ah button:not(.switch), #ahCard button:not(.switch), .ah-preview button, .ah-paste button, #ahPending button')].filter(b => b.offsetParent);
        const swRow = [...document.querySelectorAll('#st_ahPref')].every(b => b.closest('.set-row').getBoundingClientRect().height >= 44 && b.getBoundingClientRect().height >= 28);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i),
          nan: /undefined|NaN|\[object/.test(document.body.innerText), small: ctl.filter(b => b.getBoundingClientRect().height < 44).map(b => b.id || b.className),
          unnamed: ctl.filter(b => !(b.getAttribute('aria-label') || b.textContent).trim()).length, sw: swRow && [...document.querySelectorAll('#st_ahPref')].every(b => b.getAttribute('role') === 'switch' && b.getAttribute('aria-checked')),
          label: !document.getElementById('ah_paste') || !!document.querySelector('label[for="ah_paste"]') }; }, { js, theme });
      const issues = [r.over > 0 && 'overflow ' + r.over, r.sheetOver > 0 && 'sheet overflow', r.dup.length && 'dup ' + r.dup, r.nan && 'NaN', r.small.length && '<44px ' + r.small, r.unnamed && 'unnamed', !r.sw && 'switch role', !r.label && 'label'].filter(Boolean);
      if (issues.length) bad.push(`${theme}/${width}/${k}: ${issues.join('; ')}`);
    }
  }
  assert.deepEqual(bad, []);
  await page.evaluate(() => { closeSheets(); uiAhPendingSet(false); });
}, { state: fixtureState() });

test('AH54 data safety (blocker): a realistic pre-Apple-Health state saved by the real 29c78a7 build boots unchanged in this build (no onboarding / reset; XP, attributes, quests, Health, workouts identical); an import adds only S.appleHealth; export -> reset -> import keeps everything', async ({ page }) => {
  const L = legacyState(); L.schemaVersion = 8; L.workouts = [{ id: 'w_old', name: 'Push', date: '2026-09-21', status: 'done', startedAt: 1790000000000, finishedAt: 1790003600000, entries: [], exercises: [], duration: '60', notes: '', createdAt: 1 }];
  L.sleepLog.push({ id: 's2', date: '2026-09-23', bedtime: '23:00', wake: '06:30', qualityPct: 75 });
  // the previous release's own boot (migrate + achievements + quests) produces the stored state a real user has today
  const { execFileSync } = await import('node:child_process'); const { mkdtempSync, writeFileSync } = await import('node:fs'); const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lifeos-29c78a7-')), oldApp = path.join(dir, 'LifeOS.html');
  writeFileSync(oldApp, execFileSync('git', ['show', '29c78a7:LifeOS.html'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
  const op = await page.context().newPage(); await op.clock.setFixedTime(NOW); await op.goto('file://' + oldApp); await op.waitForFunction(() => typeof S !== 'undefined' && S);
  const P = await op.evaluate(L => { S = migrate(JSON.parse(JSON.stringify(L))); lastLevelSeen = levelFromXp(S.totalXp).level; applyTheme(); checkAchievements(); checkQuests(); render(); return JSON.parse(JSON.stringify(S)); }, L); await op.close();
  assert.equal(await page.evaluate(() => typeof ahParse), 'function'); assert.equal(P.appleHealth, undefined, 'the old build has no Apple Health');
  await page.evaluate(async st => { S = st; await rawIdbPut(st); }, P); await reload(page);
  const booted = await stateOf(page);
  assert.deepEqual(booted, P, 'booting the new build changes nothing at all (XP, attributes, quests, Health, workouts, settings)');
  assert.deepEqual([booted.settings.onboarded, await page.locator('#ob_name').count()], [true, 0]);
  await persist(page); const b0 = await stateOf(page);
  await ahDo(page, ahText()); await page.evaluate(() => { checkQuests(); checkAchievements(); render(); }); await persist(page);
  const b1 = await stateOf(page);
  assert.deepEqual(Object.keys(b1).filter(k => JSON.stringify(b1[k]) !== JSON.stringify(b0[k])), ['appleHealth'], 'the import added only S.appleHealth');
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]); const file = await dl.path();
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); }); await importFile(page, file); await settle(page);
  assert.deepEqual(await stateOf(page), b1, 'export -> reset -> import: identical');
}, { state: fixtureState() });

// ---------- Apple Health Bridge: real-device payload compatibility (AH61-AH85) ----------
// Synthetic fixture reproducing how iOS Shortcuts really serialized the payload on a real iPhone (no real data):
// "range" and "metrics" are JSON strings; steps / activeEnergy are NDJSON strings (one JSON object per line, numbers as
// strings, "Cal" for kcal) that include the day before range.from; the other metrics are []; "sleep" is an NDJSON string
// from a 31-day query (starts in the night two days before range.from) with Asleep / Awake / Core / Deep / In Bed / REM,
// where an iPhone "Asleep" interval overlaps the Watch stages and spans an Awake segment.
function ahRealSource({ to = '2026-09-23', days = 30 } = {}) {
  const add = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const from = add(to, -(days - 1)), iso = (d, hm) => `${d}T${hm}:00+02:00`;
  const steps = [], energy = [], sleep = [];
  for (let i = -1; i < days; i++) { const d = add(from, i);
    steps.push({ value: String(3000 + ((i + 7) * 2711) % 23000), date: d, unit: 'count' });
    energy.push({ value: String(400 + (i + 1) * 9.6 + 0.0000000000002 * ((i % 3) + 1)), date: d, unit: 'Cal' }); }
  // the tail of the night two days before `from` (a 31-day query starts inside it): expected spillover
  sleep.push({ value: 'Core', start: iso(add(from, -2), '05:00'), end: iso(add(from, -2), '06:30') });
  for (let i = -1; i < days; i++) { const d = add(from, i), p = add(d, -1);
    sleep.push({ value: 'In Bed', start: iso(p, '23:20'), end: iso(d, '07:15') });
    sleep.push({ value: 'Asleep', start: iso(p, '23:35'), end: iso(d, '07:05') });
    sleep.push({ value: 'Core', start: iso(p, '23:40'), end: iso(d, '01:30') });
    sleep.push({ value: 'Deep', start: iso(d, '01:30'), end: iso(d, '02:40') });
    sleep.push({ value: 'REM', start: iso(d, '02:40'), end: iso(d, '04:00') });
    sleep.push({ value: 'Awake', start: iso(d, '04:00'), end: iso(d, '04:10') });
    sleep.push({ value: 'Core', start: iso(d, '04:10'), end: iso(d, '06:00') });
    sleep.push({ value: 'REM', start: iso(d, '06:00'), end: iso(d, '07:10') }); }
  return { from, to, steps, energy, sleep };
}
const ndjson = list => list.map(o => JSON.stringify(o)).join('\n');
// the payload exactly as the real Shortcut produced it (strings inside strings)
function ahRealPayload(o) {
  const s = ahRealSource(o);
  const metrics = { exerciseTime: [], weight: [], vo2Max: [], restingHeartRate: [], heartRateVariability: [], flightsClimbed: [], walkingRunningDistance: [], steps: ndjson(s.steps), activeEnergy: ndjson(s.energy) };
  return { protocol: 'lifeos-apple-health', version: 1, generatedAt: s.to + 'T08:30:00+02:00', deviceTimezone: 'Europe/Prague',
    range: JSON.stringify({ to: s.to, from: s.from }), metrics: JSON.stringify(metrics), sleep: ndjson(s.sleep) };
}
// the same data as canonical JSON (objects, arrays, numbers)
function ahCanonicalOf(o) {
  const s = ahRealSource(o), num = l => l.map(x => ({ ...x, value: Number(x.value) }));
  return { protocol: 'lifeos-apple-health', version: 1, generatedAt: s.to + 'T08:30:00+02:00', deviceTimezone: 'Europe/Prague', range: { from: s.from, to: s.to },
    metrics: { exerciseTime: [], weight: [], vo2Max: [], restingHeartRate: [], heartRateVariability: [], flightsClimbed: [], walkingRunningDistance: [], steps: num(s.steps), activeEnergy: num(s.energy) }, sleep: s.sleep };
}
const ahReal = o => JSON.stringify(ahRealPayload(o));

test('AH61-AH67 + AH72-AH75 the real Shortcuts serialization (stringified range / metrics, NDJSON steps / active energy / sleep, numbers as strings, Cal) normalizes to exactly the canonical result', async ({ page }) => {
  const r = await page.evaluate(({ real, canon }) => {
    const raw = JSON.parse(real), n = ahNormalizeShortcutPayload(raw);
    const a = ahParse(real), b = ahParse(canon);
    return { types: [typeof raw.range, typeof raw.metrics, typeof JSON.parse(raw.metrics).steps, typeof raw.sleep],
      norm: n.ok && [n.payload.range, Array.isArray(n.payload.metrics.steps), n.payload.metrics.steps.length, n.payload.metrics.activeEnergy.length, n.payload.sleep.length, n.payload.metrics.exerciseTime, n.payload.metrics.steps[0], typeof n.payload.generatedAt],
      untouched: JSON.stringify(raw) === real,
      a: { ok: a.ok, counts: a.counts, warnings: a.warnings, day: a.days['2026-09-23'], d0: a.days['2026-08-24'] }, same: JSON.stringify(a.days) === JSON.stringify(b.days) && JSON.stringify(a.counts) === JSON.stringify(b.counts),
      num: [ahNum('12045'), ahNum('667.2000000000002'), ahNum(123), ahNum(123.45), ahNum('123.45'), ahNum(''), ahNum('abc'), ahNum('12abc'), ahNum('NaN'), ahNum('Infinity'), ahNum('-Infinity'), ahNum(NaN), ahNum(Infinity), ahNum(' 12 '), ahNum('1,5')] };
  }, { real: ahReal(), canon: JSON.stringify(ahCanonicalOf()) });
  assert.deepEqual(r.types, ['string', 'string', 'string', 'string'], 'the fixture really is the stringified Shortcuts format');
  const src = ahRealSource(), kc = v => Math.round(Number(v) * 100) / 100;
  assert.deepEqual(r.norm, [{ to: '2026-09-23', from: '2026-08-25' }, true, 31, 31, 249, [], src.steps[0], 'string'], 'range / metrics / lists / sleep become objects and arrays; other strings stay strings');
  assert.equal(r.untouched, true, 'normalization never modifies its input');
  assert.equal(r.a.ok, true);
  assert.deepEqual(r.a.counts, { sleep: 31, steps: 31, activeKcal: 31, exerciseMin: 0, distanceKm: 0, flights: 0, weightKg: 0, weighIns: 0, restingHr: 0, hrvMs: 0, vo2Max: 0, workouts: 0 }, '31 daily records each (incl. the day before from), empty metrics simply absent');
  assert.deepEqual(r.a.warnings, [], 'the expected spillover (day before from, partial night two days back) raises no warning');
  assert.deepEqual([r.a.day.steps, r.a.day.activeKcal], [Number(src.steps.at(-1).value), kc(src.energy.at(-1).value)], 'numbers from strings; Cal -> kcal (not x1000)');
  assert.deepEqual([r.a.day.steps, r.a.day.activeKcal], [8596, 688], 'fixture sanity: "8596" steps, "688.0000000000006" Cal');
  assert.deepEqual([r.a.d0.steps, r.a.d0.activeKcal, r.a.d0.sleep.totalMin], [Number(src.steps[0].value), 400, 445], 'the day before range.from is imported');
  assert.equal(r.same, true, 'real format and canonical format give identical internal data');
  assert.deepEqual(r.num, [12045, 667.2000000000002, 123, 123.45, 123.45, null, null, null, null, null, null, null, null, 12, null], 'strict numbers');
  // Cal is the kilocalorie Health shows: 667.2000000000002 Cal -> 667.2 kcal
  assert.equal(await page.evaluate(() => ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: '{"to":"2026-09-23","from":"2026-09-23"}',
    metrics: JSON.stringify({ activeEnergy: '{"value":"667.2000000000002","date":"2026-09-23","unit":"Cal"}' }) })).days['2026-09-23'].activeKcal), 667.2);
  // the canonical payload of the first version still works unchanged
  const c = await page.evaluate(txt => { const p = ahParse(txt); return [p.ok, p.counts.sleep, p.days['2026-09-23'].sleep.totalMin, p.warnings.length]; }, ahText());
  assert.deepEqual(c, [true, 28, 444, 0]);
}, { state: fixtureState() });

test('AH76-AH79 sleep from the real format: Asleep, Awake, Core, Deep, In Bed and REM all recognized; the iPhone "Asleep" overlapping the stages is not counted twice and does not count the Awake segment; In Bed never counts; a large NDJSON sleep list stays fast', async ({ page }) => {
  const r = await page.evaluate(real => { const p = ahParse(real), d = p.days['2026-09-23'].sleep;
    const kinds = ['Asleep', 'Awake', 'Core', 'Deep', 'In Bed', 'REM'].map(ahSleepKind);
    // a night with only the coarse Asleep + Awake (no stages): Awake still excluded
    const only = ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-23', to: '2026-09-23' },
      sleep: ['{"value":"In Bed","start":"2026-09-22T22:00:00+02:00","end":"2026-09-23T08:00:00+02:00"}', '{"value":"Asleep","start":"2026-09-22T23:00:00+02:00","end":"2026-09-23T07:00:00+02:00"}',
        '{"value":"Awake","start":"2026-09-23T03:00:00+02:00","end":"2026-09-23T03:30:00+02:00"}'].join('\n') })).days['2026-09-23'].sleep;
    return { kinds, d, only }; }, ahReal());
  assert.deepEqual(r.kinds, ['asleep', 'awake', 'core', 'deep', 'inbed', 'rem']);
  // stages 23:40-04:00 + 04:10-07:10 = 440; Asleep 23:35-07:05 adds only 23:35-23:40 (its 04:00-04:10 is Awake) -> 445
  assert.deepEqual([r.d.totalMin, r.d.coreMin, r.d.deepMin, r.d.remMin, r.d.awakeMin, r.d.stages, r.d.bedtime, r.d.wake], [445, 220, 70, 150, 10, true, '23:35', '07:10']);
  assert.deepEqual([r.only.totalMin, r.only.awakeMin, r.only.stages], [450, 30, false], 'Asleep 480 - Awake 30; In Bed (600) never counts');
  // large NDJSON sleep list (~10 000 lines) parses quickly
  const big = await page.evaluate(() => { const lines = []; const T = '2026-09-23';
    for (let i = 0; i < 10000; i++) { const m = i % 400; lines.push(JSON.stringify({ value: ['Core', 'Deep', 'REM', 'Awake', 'Asleep', 'In Bed'][i % 6], start: `2026-09-22T23:${String(m % 60).padStart(2, '0')}:00+02:00`, end: `2026-09-23T0${m % 7}:30:00+02:00` })); }
    const txt = JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: '{"to":"2026-09-23","from":"2026-09-23"}', metrics: '{}', sleep: lines.join('\n') });
    const t = performance.now(); const p = ahParse(txt); return { ms: performance.now() - t, ok: p.ok, total: p.days[T].sleep.totalMin, size: txt.length }; });
  console.log(`      AH76 sleep NDJSON 10 000 lines (${(big.size / 1e6).toFixed(1)} MB): ${big.ms.toFixed(1)} ms`);
  assert.ok(big.ok && big.total > 0 && big.total <= 1440 && big.ms < 1500);
}, { state: fixtureState() });

test('AH68-AH71 malformed real-format payloads are refused as a whole (no partial import): a broken NDJSON line, one bad line among 31, primitive / array lines, unparsable range / metrics strings, prototype keys inside strings', async ({ page }) => {
  const r = await page.evaluate(() => { const base = { protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: '{"to":"2026-09-23","from":"2026-09-20"}' };
    const good = d => JSON.stringify({ value: '1000', date: d, unit: 'count' }); const e = p => { const x = ahParse(JSON.stringify(p)); return x.ok ? 'ok' : x.errors[0]; };
    const lines31 = Array.from({ length: 31 }, (_, i) => good('2026-09-2' + (i % 4)));
    const oneBad = lines31.slice(); oneBad[17] = '{"value":"1000","date":"2026-09-21"';
    return {
      broken: e({ ...base, metrics: JSON.stringify({ steps: '{"value":"1","date":"2026-09-21"' }) }),
      oneBad: e({ ...base, metrics: JSON.stringify({ steps: oneBad.join('\n') }) }),
      allGood: e({ ...base, metrics: JSON.stringify({ steps: lines31.join('\n') }) }),
      prim: ['42', '"text"', 'null', 'true', '[1,2]', '[{"value":"1","date":"2026-09-21"}]'].map(l => e({ ...base, metrics: JSON.stringify({ steps: good('2026-09-21') + '\n' + l }) })),
      sleepBad: e({ ...base, sleep: '{"value":"Core","start":"2026-09-21T01:00:00+02:00","end":"2026-09-21T02:00:00+02:00"}\nnot json' }),
      rangeBad: e({ ...base, range: '{"to":"2026-09-23",' }), rangeArr: e({ ...base, range: '["2026-09-20","2026-09-23"]' }), metricsBad: e({ ...base, metrics: '{steps:' }), metricsNum: e({ ...base, metrics: JSON.stringify({ steps: 5 }) }),
      protoLine: e({ ...base, metrics: JSON.stringify({ steps: '{"__proto__":{"polluted":1},"value":"1","date":"2026-09-21"}' }) }),
      ctorLine: e({ ...base, sleep: '{"constructor":{"x":1},"value":"Core","start":"2026-09-21T01:00:00+02:00","end":"2026-09-21T02:00:00+02:00"}' }),
      protoRange: e({ ...base, range: '{"to":"2026-09-23","from":"2026-09-20","__proto__":{"polluted":1}}' }), protoMetrics: e({ ...base, metrics: '{"prototype":{},"steps":[]}' }),
      polluted: ({}).polluted, store: 'appleHealth' in S };
  });
  assert.deepEqual([r.broken, r.oneBad, r.allGood], ['ndjson', 'ndjson', 'ok'], 'one bad line among 31 rejects the whole payload');
  assert.deepEqual(r.prim, ['ndjson', 'ndjson', 'ndjson', 'ndjson', 'ndjson', 'ndjson'], 'every line must be a JSON object');
  assert.deepEqual([r.sleepBad, r.rangeBad, r.rangeArr, r.metricsBad, r.metricsNum], ['ndjson', 'range', 'range', 'metrics', 'ndjson']);
  assert.deepEqual([r.protoLine, r.ctorLine, r.protoRange, r.protoMetrics, r.polluted, r.store], ['keys', 'keys', 'range', 'metrics', undefined, false]);
  // in the UI: the error, nothing imported
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPaste');
  await page.fill('#ah_paste', JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: '{"to":"2026-09-23","from":"2026-09-20"}', metrics: JSON.stringify({ steps: '{"value":"1","date":"2026-09-21","unit":"count"}\n{oops}' }) }));
  await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /Data nelze importovat[\s\S]*neplatný řádek — nic se neimportovalo/);
  assert.equal(await page.evaluate(() => 'appleHealth' in S), false);
}, { state: fixtureState() });

test('AH80 + AH81 date spillover is bounded: the day before range.from is imported and the partial night two days back is dropped quietly; older samples and anything after range.to are skipped with a warning; strings that only look like JSON (date, unit, sleep value) are never parsed', async ({ page }) => {
  const r = await page.evaluate(() => { const base = { protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: '{"to":"2026-09-23","from":"2026-09-20"}' };
    const st = (d, v) => JSON.stringify({ value: String(v), date: d, unit: 'count' }), sl = (a, b, v) => JSON.stringify({ value: v, start: a, end: b });
    const p = ahParse(JSON.stringify({ ...base, metrics: JSON.stringify({ steps: [st('2026-09-19', 1), st('2026-09-18', 2), st('2026-09-10', 3), st('2026-09-23', 4), st('2026-09-24', 5)].join('\n') }),
      sleep: [sl('2026-09-18T23:00:00+02:00', '2026-09-19T07:00:00+02:00', 'Core'), sl('2026-09-17T23:00:00+02:00', '2026-09-18T07:00:00+02:00', 'Core'), sl('2026-09-14T23:00:00+02:00', '2026-09-15T07:00:00+02:00', 'Core'),
        sl('2026-09-23T19:00:00+02:00', '2026-09-23T20:00:00+02:00', 'Core'), sl('2026-09-26T01:00:00+02:00', '2026-09-26T07:00:00+02:00', 'Core')].join('\n') }));
    const tricky = ahParse(JSON.stringify({ ...base, metrics: { steps: [{ date: '2026-09-21', value: '10', unit: '{"x":1}' }] }, sleep: [{ value: '{"x":"y"}', start: '2026-09-21T01:00:00+02:00', end: '2026-09-21T02:00:00+02:00' }] }));
    const tn = ahNormalizeShortcutPayload({ ...base, generatedAt: '{"a":1}', metrics: { steps: '{"date":"2026-09-21","value":"10","unit":"{\\"x\\":1}"}' }, sleep: '{"value":"{\\"x\\":\\"y\\"}","start":"2026-09-21T01:00:00+02:00","end":"2026-09-21T02:00:00+02:00"}' });
    return { days: Object.keys(p.days).sort(), steps: Object.fromEntries(Object.entries(p.days).filter(([, x]) => x.steps != null).map(([d, x]) => [d, x.steps])), sleepDays: Object.keys(p.days).filter(d => p.days[d].sleep).sort(), warnings: p.warnings,
      tricky: [tricky.ok, tricky.days['2026-09-21'] && tricky.days['2026-09-21'].steps, tricky.warnings],
      tn: tn.ok && [tn.payload.generatedAt, tn.payload.metrics.steps[0].unit, tn.payload.sleep[0].value] }; });
  assert.deepEqual(r.steps, { '2026-09-19': 1, '2026-09-23': 4 }, 'day before from in; two / thirteen days before and after to out');
  assert.deepEqual(r.sleepDays, ['2026-09-19'], 'night of from - 1 in; the partial night of from - 2 and the evening of to + 1 quietly out; older / later nights out');
  assert.deepEqual(r.warnings, [{ k: 'out_of_range', n: 5 }], '2 old steps + 1 later step + 1 old night + 1 later night');
  assert.deepEqual(r.tricky, [true, 10, [{ k: 'unknown_sleep', n: 1 }]], 'unit / sleep value are plain text (a count unit is ignored; "{...}" is not a sleep value)');
  assert.deepEqual(r.tn, ['{"a":1}', '{"x":1}', '{"x":"y"}'], 'normalization leaves generatedAt / unit / sleep value as strings');
}, { state: fixtureState() });

test('AH82-AH85 the real-format payload in the app: paste -> preview (31 days / nights) -> import; 5 more imports change nothing; no XP / attributes / quests / achievements / Daily Score; export -> reset -> import keeps it', async ({ page }) => {
  await page.evaluate(() => { finalizeDailyScores(); checkQuests(); checkAchievements(); }); await persist(page);
  const r0 = await ahRewards(page);
  await page.evaluate(() => { view = 'settings'; render(); }); await page.click('#st_ahPaste'); await page.fill('#ah_paste', ahReal()); await page.click('#ah_check');
  assert.match(await page.locator('#ahPreview').innerText(), /25\.08\.2026 – 23\.09\.2026 · 30 dní[\s\S]*Spánek\s*31 nocí[\s\S]*Aktivní energie\s*31 dní[\s\S]*Kroky\s*beta\s*31 dní/);
  assert.equal(await page.locator('#ahPreview .ah-warn').count(), 0, 'no "skipped" note for the real format');
  await page.click('#ah_import');
  const s1 = await page.evaluate(() => JSON.stringify(S.appleHealth));
  assert.deepEqual(await page.evaluate(() => [Object.keys(S.appleHealth.days).length, S.appleHealth.days['2026-09-23'].sleep.totalMin, S.appleHealth.days['2026-09-23'].activeKcal, S.appleHealth.lastRange]), [31, 445, 688, { from: '2026-08-25', to: '2026-09-23' }]);
  for (let i = 0; i < 5; i++) assert.deepEqual((await ahDo(page, ahReal())).imp, { ok: true, changed: false, days: 0 });
  assert.equal(await page.evaluate(() => JSON.stringify(S.appleHealth)), s1, 'idempotent');
  // the canonical twin changes nothing either (same internal data)
  assert.deepEqual((await ahDo(page, JSON.stringify(ahCanonicalOf()))).imp, { ok: true, changed: false, days: 0 });
  await page.evaluate(() => { checkQuests(); checkAchievements(); finalizeDailyScores(); for (const v of ['home', 'health', 'fitness', 'quests', 'character']) { view = v; render(); } checkQuests(); });
  assert.equal(await ahRewards(page), r0, 'no XP, attributes, quests, achievements, Daily Score, workouts or manual Health changed');
  await persist(page); const before = await stateOf(page);
  await page.click('#settingsBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st_exp')]); const file = await dl.path();
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => 'appleHealth' in S), false);
  await page.evaluate(() => { S.settings.onboarded = true; closeSheets(); }); await importFile(page, file); await settle(page);
  assert.deepEqual(await stateOf(page), before, 'export -> reset -> import');
}, { state: fixtureState() });

// ---------- Apple Health deep integration (AHD1-AHD9): effective data in the normal UI, sleep timeline, step sources, workouts ----------
// Synthetic data only. T = the fixture's today (2026-09-23).
function ahDeepPayload({ T = '2026-09-23', days = 7, weight = true, workouts = true, stepSources = true } = {}) {
  const add = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const from = add(T, -(days - 1)), iso = (d, hm) => `${d}T${hm}:00+02:00`;
  const sleep = [], steps = [], energy = [], ex = [], dist = [], fl = [], hr = [], hrv = [], wt = [];
  for (let i = 0; i < days; i++) { const d = add(from, i), p = add(d, -1);
    [['In Bed', p, '23:20', d, '07:15'], ['Asleep', p, '23:35', d, '07:05'], ['Core', p, '23:40', d, '01:30'], ['Deep', d, '01:30', d, '02:40'], ['REM', d, '02:40', d, '04:00'],
      ['Awake', d, '04:00', d, '04:10'], ['Core', d, '04:10', d, '06:00'], ['REM', d, '06:00', d, '07:10']].forEach(([v, a, x, b, y]) => sleep.push({ value: v, start: iso(a, x), end: iso(b, y) }));
    steps.push({ date: d, value: String(8000 + i * 100), unit: 'count' });
    if (stepSources) steps.push({ date: d, value: String(3000 + i), unit: 'count', source: 'iPhone' }, { date: d, value: String(7000 + i), unit: 'count', source: 'Apple Watch' });
    energy.push({ date: d, value: String(500 + i * 10 + 0.2000000000002), unit: 'Cal' }); ex.push({ date: d, value: String(30 + i), unit: 'min' });
    dist.push({ date: d, value: '4.25', unit: 'km' }); fl.push({ date: d, value: '7', unit: 'count' });
    hr.push({ date: d, value: '54', unit: 'count/min' }); hrv.push({ date: d, value: '47.6', unit: 'ms' });
    if (weight && i % 2 === 0) wt.push({ date: iso(d, '07:30'), value: String(80 + i / 10), unit: 'kg' }); }
  const p = { protocol: 'lifeos-apple-health', version: 1, generatedAt: iso(T, '08:30'), deviceTimezone: 'Europe/Prague', range: { from, to: T },
    metrics: { steps, activeEnergy: energy, exerciseTime: ex, walkingRunningDistance: dist, flightsClimbed: fl, restingHeartRate: hr, heartRateVariability: hrv, weight: wt, vo2Max: [{ date: T, value: '44.2', unit: 'ml/(kg·min)' }] }, sleep };
  if (workouts) p.workouts = [
    { id: 'E2A1-UUID-0001', type: 'Traditional Strength Training', start: iso(T, '06:04'), end: iso(T, '06:58'), durationSec: '3240', activeKcal: '412.4', source: 'Apple Watch' },
    { type: 'Running', start: iso(add(T, -1), '16:20'), end: iso(add(T, -1), '16:58'), durationSec: 2280, activeKcal: 431, distanceKm: '6.2', source: 'Apple Watch' }];
  return p;
}
const ahDeep = o => JSON.stringify(ahDeepPayload(o));
const ahNoReward = page => page.evaluate(() => JSON.stringify([S.totalXp, S.xpLog, S.attrs, S.rpg, S.quests, S.questBoard, S.achievementsUnlocked, S.achievementUnlockedAt, S.dailyScores, S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog]));

test('AHD1 effective data layer: one resolver per metric (steps, active kcal, exercise, distance, flights, weight, resting HR, HRV, VO2 max, sleep) -- Apple while preferred, manual fallback where a manual log exists, else null; manual records never touched', async ({ page }) => {
  const r = await page.evaluate(txt => {
    const T = todayStr(); S.sleepLog.find(x => x.date === T).qualityPct = 80; const man = JSON.stringify([S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog]);
    const F = { steps: getEffectiveSteps, kcal: getEffectiveActiveCalories, ex: getEffectiveExerciseMinutes, dist: getEffectiveDistance, fl: getEffectiveFlights, wt: getEffectiveWeight, rhr: getEffectiveRestingHR, hrv: getEffectiveHRV, vo2: getEffectiveVO2Max };
    const snap = D => Object.fromEntries(Object.entries(F).map(([k, f]) => [k, f(D)]));
    const before = snap(T); ahImport(ahParse(txt)); const on = snap(T), sl = getEffectiveSleep(T);
    const noWeightDay = addDays(T, -1); const fallbackWeight = getEffectiveWeight(noWeightDay); // Apple has no weigh-in that day, no manual either
    S.appleHealth.preferred = false; const off = snap(T); S.appleHealth.preferred = true;
    return { before, on, off, sl: [sl.source, sl.minutes, sl.qualityPct, sl.qualitySource], fallbackWeight, manualSame: man === JSON.stringify([S.sleepLog, S.weightLog, S.activeCaloriesLog, S.stepsLog, S.heartRateLog]) };
  }, ahDeep({ weight: false }));
  const A = v => ({ value: v, source: 'appleHealth' }), M = v => ({ value: v, source: 'manual' });
  assert.deepEqual(r.before, { steps: M(4300), kcal: M(380), ex: null, dist: null, fl: null, wt: M(81.6), rhr: M(62), hrv: null, vo2: null }, 'no Apple data: manual where LifeOS has a log, else null (never 0)');
  assert.deepEqual(r.on, { steps: A(8600), kcal: A(560.2), ex: A(36), dist: A(4.25), fl: A(7), wt: M(81.6), rhr: A(54), hrv: A(47.6), vo2: A(44.2) }, 'Apple preferred: Apple values (Cal = kcal, never x1000); weight [] -> manual fallback');
  assert.deepEqual(r.off, r.before, 'preference OFF: exactly the manual / empty state');
  assert.deepEqual(r.sl, ['appleHealth', 445, 80, 'manual'], 'Apple duration, the manual quality stays manual');
  assert.equal(r.fallbackWeight, null);
  assert.equal(r.manualSame, true, 'manual Health records unchanged');
}, { state: fixtureState() });

test('AHD2 Health UI: a status panel (no duplicate dashboard) + the normal Health overview with every Apple metric and its source badge; Weight / Active kcal / Sleep tabs read the effective data; preference OFF = the manual screens; manual records keep edit / delete', async ({ page }) => {
  await page.evaluate(txt => { S.sleepLog.find(x => x.date === todayStr()).qualityPct = 80; ahImport(ahParse(txt)); healthTab = 'sleep'; view = 'health'; render(); }, ahDeep());
  const r = await page.evaluate(() => {
    const tile = id => { const t = document.querySelector(`#hOverview .ah-tile[data-ah="${id}"]`); return t ? [t.querySelector('.stat-value').textContent.replace(/\s/g, ' ').trim(), t.querySelector('.src-badge').dataset.src] : null; };
    return { panelTiles: document.querySelectorAll('#ahCard .ah-tile').length, panel: !!document.querySelector('#ahCard #ahSyncH') && !!document.querySelector('#ahCard #ahPrefH[role="switch"]') && !!document.querySelector('#ahCard #ahDiagH'),
      tiles: Object.fromEntries(['sleep', 'steps', 'activeKcal', 'exerciseMin', 'distanceKm', 'flights', 'restingHr', 'hrvMs', 'vo2Max', 'weightKg'].map(k => [k, tile(k)])),
      beta: /beta/i.test(document.querySelector('#hOverview [data-ah="steps"] .stat-label').textContent), note: document.getElementById('ahStepNote').textContent,
      sleepCard: !!document.getElementById('slToday'), last: document.querySelector('[data-eff="last"] .stat-value').textContent, q: (document.getElementById('slQuality') || {}).textContent };
  });
  assert.equal(r.panelTiles, 0, 'the Apple Health panel is only status / sync / preference / diagnostics');
  assert.equal(r.panel, true);
  assert.deepEqual(r.tiles, { sleep: ['7 h 25 min', 'apple'], steps: ['8 600', 'apple'], activeKcal: ['560 kcal', 'apple'], exerciseMin: ['36 min', 'apple'], distanceKm: ['4,25 km', 'apple'], flights: ['7', 'apple'],
    restingHr: ['54 bpm', 'apple'], hrvMs: ['48 ms', 'apple'], vo2Max: ['44,2', 'apple'], weightKg: ['80,6 kg', 'apple'] }, 'today Apple has a weigh-in (80.6) and is preferred over the manual 81.6');
  assert.equal(r.beta, true); assert.equal(r.note, 'Hodnota ze Zkratek se může lišit od souhrnu v aplikaci Zdraví při více zdrojích dat.');
  assert.deepEqual([r.sleepCard, r.last, r.q], [true, '7 h 25 min', 'Kvalita spánku 80 % · zadaná ručně']);
  // Weight tab: Apple history rows (read-only) + manual rows (editable); latest = newest effective value
  const w = await page.evaluate(() => { healthTab = 'weight'; render(); return { latest: document.querySelector('[data-eff="weight"] .stat-value').textContent.replace(/\s/g, ' '), src: document.querySelector('[data-eff="weight"] .src-badge').dataset.src,
    apple: [...document.querySelectorAll('#wtAhList .ah-hist')].map(x => x.dataset.ahHist), appleEdit: document.querySelectorAll('#wtAhList .editBtn, #wtAhList .delbtn').length, manual: document.querySelectorAll('#wtList .editBtn').length }; });
  assert.deepEqual(w, { latest: '80,6 kg', src: 'apple', apple: ['2026-09-23', '2026-09-21', '2026-09-19', '2026-09-17'], appleEdit: 0, manual: 2 }, 'Apple history rows are read-only; both manual weigh-ins stay editable');
  const w2 = await page.evaluate(() => { const man = JSON.stringify(S.weightLog); delete S.appleHealth.days[todayStr()].weightKg; render(); return [document.querySelector('[data-eff="weight"] .stat-value').textContent.replace(/\s/g, ' '), document.querySelector('[data-eff="weight"] .src-badge').dataset.src, man === JSON.stringify(S.weightLog)]; });
  assert.deepEqual(w2, ['81,6 kg', 'manual', true], 'no Apple weigh-in that day: the manual weight (Manuálně)');
  const k = await page.evaluate(() => { healthTab = 'activecal'; render(); return [document.querySelector('[data-eff="activeKcal"] .stat-value').textContent.replace(/\s/g, ' '), document.querySelector('[data-eff="activeKcal"] .src-badge').dataset.src, document.querySelectorAll('#acAhList .ah-hist').length, document.querySelectorAll('#acList .editBtn').length]; });
  assert.deepEqual(k, ['560 kcal', 'apple', 7, 1], 'Apple active kcal in the normal lower UI; the manual 380 kcal entry stays listed and editable');
  const off = await page.evaluate(() => { S.appleHealth.preferred = false; healthTab = 'sleep'; render(); return { card: !!document.getElementById('slToday'), last: document.querySelector('#hBody .stat-card .stat-value').textContent, tile: (document.querySelector('#hOverview [data-ah="activeKcal"] .src-badge') || {}).dataset }; });
  assert.deepEqual([off.card, off.last, off.tile && off.tile.src], [false, '7.25h', 'manual'], 'preference OFF: manual sleep screen, manual values in the overview');
}, { state: fixtureState() });

test('AHD3 sleep stage timeline: Core / Deep / REM / Awake in chronological order across midnight; the overlapping Asleep and In Bed never become bars; segments add up to the totals; one segment, many segments, no REM, no Deep, coarse Asleep only ("Spánek", no invented stages)', async ({ page }) => {
  const r = await page.evaluate(txt => {
    const P = sleep => JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: '2026-09-23', to: '2026-09-23' }, sleep });
    const S1 = (v, a, b) => ({ value: v, start: `2026-09-2${a}`, end: `2026-09-2${b}` });
    const dom = () => { healthTab = 'sleep'; view = 'health'; render(); const c = document.getElementById('slToday'); if (!c) return null;
      return { lanes: [...c.querySelectorAll('.sl-lane')].map(l => [l.dataset.lane, l.querySelectorAll('.sl-seg').length]), order: [...c.querySelectorAll('.sl-list li')].map(li => li.textContent.split(' ')[0]),
        from: c.querySelector('.sl-from').textContent, to: c.querySelector('.sl-to').textContent, sum: Object.fromEntries([...c.querySelectorAll('[data-sum]')].map(x => [x.dataset.sum, x.querySelector('b').textContent])),
        coarse: /nevymýšlí/.test(c.textContent), segs: ahSleep('2026-09-23').segments.map(x => x.stage) }; };
    const out = {};
    ahImport(ahParse(txt)); out.full = dom();
    const sg = ahSleep('2026-09-23').segments, minOf = st => sg.filter(x => st.includes(x.stage)).reduce((a, x) => a + (x.e.ms - x.s.ms) / 60000, 0);
    out.sums = [minOf(['core', 'deep', 'rem', 'asleep']), minOf(['awake']), ahSleep('2026-09-23').totalMin, sg.every((x, i) => !i || x.s.ms >= sg[i - 1].e.ms)];
    const one = ahParse(P([S1('Core', '2T23:00:00+02:00', '3T06:00:00+02:00')])); delete S.appleHealth; ahImport(one); out.one = dom();
    delete S.appleHealth; ahImport(ahParse(P([S1('Core', '2T23:00:00+02:00', '3T02:00:00+02:00'), S1('Deep', '3T02:00:00+02:00', '3T03:00:00+02:00'), S1('Core', '3T03:00:00+02:00', '3T06:30:00+02:00')]))); out.noRem = dom();
    delete S.appleHealth; ahImport(ahParse(P([S1('Core', '2T23:00:00+02:00', '3T02:00:00+02:00'), S1('REM', '3T02:00:00+02:00', '3T03:00:00+02:00'), S1('Awake', '3T03:00:00+02:00', '3T03:05:00+02:00'), S1('Core', '3T03:05:00+02:00', '3T06:30:00+02:00')]))); out.noDeep = dom();
    delete S.appleHealth; ahImport(ahParse(P([S1('In Bed', '2T22:50:00+02:00', '3T07:00:00+02:00'), S1('Asleep', '2T23:10:00+02:00', '3T03:00:00+02:00'), S1('Awake', '3T03:00:00+02:00', '3T03:20:00+02:00'), S1('Asleep', '3T03:20:00+02:00', '3T06:40:00+02:00')]))); out.coarse = dom();
    const many = []; for (let i = 0; i < 60; i++) { const a = new Date(Date.parse('2026-09-22T22:00:00+02:00') + i * 8 * 60000), b = new Date(a.getTime() + 8 * 60000); many.push({ value: ['Core', 'Deep', 'REM', 'Awake'][i % 4], start: a.toISOString(), end: b.toISOString() }); }
    delete S.appleHealth; ahImport(ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', deviceTimezone: 'Europe/Prague', range: { from: '2026-09-23', to: '2026-09-23' }, sleep: many }))); out.many = dom();
    return out;
  }, ahDeep());
  assert.deepEqual(r.full.lanes, [['awake', 1], ['rem', 2], ['core', 2], ['deep', 1]], 'lanes Vzhůru / REM / Lehký / Hluboký; one bar per real segment, no Asleep / In Bed bars');
  assert.deepEqual(r.full.order, ['Lehký', 'Hluboký', 'REM', 'Vzhůru', 'Lehký', 'REM'], 'chronological');
  assert.deepEqual([r.full.from, r.full.to], ['23:40', '07:10'], 'across midnight: bedtime -> final wake');
  assert.deepEqual(r.full.sum, { tl_total: '7 h 25 min', tl_core: '3 h 40 min', tl_deep: '1 h 10 min', tl_rem: '2 h 30 min', tl_awake: '0 h 10 min' });
  assert.equal(r.full.segs.includes('inbed'), false);
  assert.deepEqual(r.sums, [445, 10, 445, true], 'the timeline adds up to the totals (Asleep only fills 23:35-23:40, Awake 10 min subtracted), no overlap');
  assert.deepEqual(r.one.lanes, [['awake', 0], ['rem', 0], ['core', 1], ['deep', 0]]);
  assert.deepEqual([r.noRem.lanes, r.noRem.sum.tl_rem], [[['awake', 0], ['rem', 0], ['core', 2], ['deep', 1]], '0 h 00 min']);
  assert.deepEqual([r.noDeep.lanes, r.noDeep.sum.tl_awake], [[['awake', 1], ['rem', 1], ['core', 2], ['deep', 0]], '0 h 05 min']);
  assert.deepEqual([r.coarse.lanes, r.coarse.coarse, r.coarse.sum.tl_total, r.coarse.sum.tl_core], [[['asleep', 2], ['awake', 1]], true, '7 h 10 min', undefined], 'coarse Asleep only: a neutral "Spánek" lane, Awake subtracted, no Core / Deep / REM invented');
  assert.deepEqual(r.many.lanes, [['awake', 15], ['rem', 15], ['core', 15], ['deep', 15]], 'many segments (UTC times + deviceTimezone)');
}, { state: fixtureState() });

test('AHD4 steps stay Beta and source-aware: the optional source field is stored per day (never summed into the total, no correction factor); one source alone is the total; "Zdroj kroků" shows the sources and an explicit choice; no source field = unchanged behaviour', async ({ page }) => {
  const r = await page.evaluate(txt => {
    const T = todayStr(), p = ahParse(txt), d = p.days[T];
    const plain = ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: T, to: T }, metrics: { steps: [{ date: T, value: '460', unit: 'count' }] } })).days[T];
    const single = ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: T, to: T }, metrics: { steps: [{ date: T, value: '348', unit: 'count', source: 'iPhone' }] } })).days[T];
    const multi = ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: T, to: T }, metrics: { steps: [{ date: T, value: '348', unit: 'count', source: 'iPhone' }, { date: T, value: '120', unit: 'count', source: 'Apple Watch' }] } })).days[T];
    ahImport(p); const auto = getEffectiveSteps(T);
    view = 'health'; render(); document.getElementById('ahStepSrc').click();
    const sheet = { picks: [...document.querySelectorAll('#ahStepSheet .ah-src-pick')].map(b => [b.dataset.src, b.getAttribute('aria-checked')]), day: document.querySelector(`#ahStepSheet [data-day="${T}"]`).textContent.replace(/\s+/g, ' ').trim() };
    document.querySelector('#ahStepSheet .ah-src-pick[data-src="Apple Watch"]').click();
    const watch = getEffectiveSteps(T), tileWatch = document.querySelector('#hOverview [data-ah="steps"] .stat-value').textContent.replace(/\s/g, ' ');
    S.appleHealth.stepSource = 'Garmin'; const missing = getEffectiveSteps(T); delete S.appleHealth.stepSource;
    return { plain, single, multi, d: [d.steps, d.stepSources], auto, sheet, watch, tileWatch, missing, prefPersist: null };
  }, ahDeep());
  assert.deepEqual(r.plain, { steps: 460 }, 'no source: exactly the old behaviour');
  assert.deepEqual(r.single, { steps: 348, stepSources: { iPhone: 348 } }, 'one source only: it is the day total');
  assert.deepEqual(r.multi, { stepSources: { iPhone: 348, 'Apple Watch': 120 } }, 'several sources without a summary: no total is guessed or summed');
  assert.deepEqual(r.d, [8600, { iPhone: 3006, 'Apple Watch': 7006 }], 'the summary stays the summary');
  assert.deepEqual(r.auto, { value: 8600, source: 'appleHealth' });
  assert.deepEqual(r.sheet.picks, [['auto', 'true'], ['Apple Watch', 'false'], ['iPhone', 'false']]);
  assert.match(r.sheet.day, /Souhrn zkratky: 8 600 Apple Watch: 7 006 · iPhone: 3 006/);
  assert.deepEqual([r.watch, r.tileWatch], [{ value: 7006, source: 'appleHealth', stepSource: 'Apple Watch' }, '7 006'], 'an explicit source choice uses that source total');
  assert.deepEqual(r.missing, { value: 8600, source: 'appleHealth' }, 'a chosen source missing that day falls back to the summary');
}, { state: fixtureState() });

test('AHD5 workout protocol: optional workouts as an array or the Shortcuts NDJSON string; stable ids (provider UUID, else deterministic source + type + start + end); strict validation skips a malformed workout with a warning; units; a workouts-only payload is valid; v1 unchanged', async ({ page }) => {
  const r = await page.evaluate(txt => {
    const base = JSON.parse(txt), T = todayStr();
    const a = ahParse(txt), nd = ahParse(JSON.stringify({ ...base, workouts: base.workouts.map(w => JSON.stringify(w)).join('\n') }));
    const again = ahParse(txt), ids = Object.keys(a.workouts).sort();
    const W = (o, extra) => ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: T, to: T }, workouts: [Object.assign({ type: 'Walking', start: T + 'T10:00:00+02:00', end: T + 'T10:30:00+02:00' }, o)], ...extra }));
    const bad = [{ end: T + 'T09:00:00+02:00' }, { durationSec: 4000 }, { activeKcal: 'abc' }, { activeKcal: '-5' }, { distanceKm: '12abc' }, { type: 'x'.repeat(81) }, { id: 'bad id!' }, { start: 'yesterday' }, { energyUnit: 'parsecs', activeKcal: 5 }]
      .map(o => { const p = W(o); return [p.ok, p.errors && p.errors[0], p.warnings]; });
    const units = W({ activeKcal: '1000', energyUnit: 'kJ', distanceKm: '2', distanceUnit: 'mi', durationMin: '25' }).workouts;
    const arr = W({}, { workouts: 'not ndjson' }), notList = ahParse(JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: '2026-09-23T09:00:00+02:00', range: { from: T, to: T }, workouts: { a: 1 } }));
    const old = W({ start: '2026-09-01T10:00:00+02:00', end: '2026-09-01T10:30:00+02:00' });
    return { ids, same: JSON.stringify(a.workouts) === JSON.stringify(nd.workouts) && JSON.stringify(a.workouts) === JSON.stringify(again.workouts), w: a.workouts, count: a.counts.workouts, bad, units, arr: [arr.ok, arr.errors[0]], notList: [notList.ok, notList.errors[0]], old: [old.ok, old.errors && old.errors[0], old.warnings] };
  }, ahDeep());
  assert.equal(r.count, 2); assert.equal(r.same, true, 'array and NDJSON give the same workouts; parsing twice gives the same ids');
  assert.equal(r.ids[0], 'E2A1-UUID-0001', 'the provider UUID is the identity'); assert.match(r.ids[1], /^ahw-[0-9a-z]+$/, 'otherwise a deterministic key');
  assert.deepEqual(r.w['E2A1-UUID-0001'], { id: 'E2A1-UUID-0001', start: '2026-09-23T06:04:00+02:00', end: '2026-09-23T06:58:00+02:00', date: '2026-09-23', type: 'Traditional Strength Training', durationSec: 3240, source: 'Apple Watch', activeKcal: 412.4 });
  assert.deepEqual(r.w[r.ids[1]], { id: r.ids[1], start: '2026-09-22T16:20:00+02:00', end: '2026-09-22T16:58:00+02:00', date: '2026-09-22', type: 'Running', durationSec: 2280, source: 'Apple Watch', activeKcal: 431, distanceKm: 6.2 });
  for (const b of r.bad) assert.deepEqual(b, [false, 'no_data', [{ k: 'bad_workout', n: 1 }]], 'a malformed workout is never imported (here it was the only data -> nothing to import)');
  assert.deepEqual(Object.values(r.units).map(w => [w.activeKcal, w.distanceKm, w.durationSec]), [[239, 3.219, 1500]], 'kJ -> kcal, mi -> km, minutes');
  assert.deepEqual(r.arr, [false, 'ndjson']); assert.deepEqual(r.notList, [false, 'ndjson']);
  assert.deepEqual(r.old, [false, 'no_data', [{ k: 'out_of_range', n: 1 }]]);
}, { state: fixtureState() });

test('AHD6 workout import (blocker for rewards): a candidate is never a LifeOS workout until "Add to LifeOS"; adding creates exactly one completed record with the exact kcal / duration / distance; no duplicate after re-adding, 5 re-syncs, reload, export -> reset -> import; 0 XP / attributes / quests / achievements / Daily Score / readiness change; deleting the copy leaves Apple Health data and makes it available again', async ({ page }) => {
  await page.evaluate(() => { finalizeDailyScores(); checkQuests(); checkAchievements(); });
  const txt = ahDeep();
  await page.evaluate(txt => { ahImport(ahParse(txt)); }, txt); await persist(page);
  const r0 = await ahNoReward(page), rd0 = await page.evaluate(() => JSON.stringify(trainingReadiness(S, Date.now())));
  const a = await page.evaluate(() => { const n = S.workouts.length, c = ahWorkoutCandidates().map(x => [x.id, x.state]);
    const add = ahWorkoutAdd('E2A1-UUID-0001'), again = ahWorkoutAdd('E2A1-UUID-0001');
    checkQuests(); checkAchievements(); finalizeDailyScores(); render();
    const w = S.workouts.find(x => x.healthWorkoutId === 'E2A1-UUID-0001');
    return { before: n, cands: c, add: add.ok, again: again.reason, after: S.workouts.length, w: { name: w.name, date: w.date, status: w.status, source: w.source, durationSec: w.durationSec, duration: w.duration, activeKcal: w.activeKcal, healthSource: w.healthSource, startAt: w.startAt },
      completed: completedWorkouts(S).some(x => x.id === w.id), history: fitnessHistoryWorkouts(S).some(x => x.id === w.id), states: ahWorkoutCandidates().map(x => [x.id, x.state]) }; });
  assert.deepEqual(a.cands.map(x => x[1]), ['new', 'new']);
  assert.deepEqual([a.add, a.again, a.after - a.before], [true, 'exists', 1]);
  assert.deepEqual(a.w, { name: 'Silový trénink', date: '2026-09-23', status: 'done', source: 'appleHealth', durationSec: 3240, duration: 54, activeKcal: 412.4, healthSource: 'Apple Watch', startAt: '2026-09-23T06:04:00+02:00' }, 'the workout-specific active kcal, never the daily total');
  assert.deepEqual([a.completed, a.history], [false, true], 'shown in the Fitness history, never counted as a LifeOS completion');
  assert.equal(a.states[0][1], 'added');
  await persist(page);
  assert.equal(await ahNoReward(page), r0, '0 XP, attributes, quests, achievements, Daily Score; manual Health unchanged');
  assert.equal(await page.evaluate(() => JSON.stringify(trainingReadiness(S, Date.now()))), rd0, 'readiness as implemented (Apple workouts are not LifeOS sessions)');
  // re-sync 5x + reload: still one copy, the candidate stays "added"
  for (let i = 0; i < 5; i++) await page.evaluate(txt => ahImport(ahParse(txt), { force: true }), txt);
  await persist(page); await reload(page);
  assert.deepEqual(await page.evaluate(() => [S.workouts.filter(w => w.healthWorkoutId === 'E2A1-UUID-0001').length, ahWorkoutCandidates()[0].state]), [1, 'added']);
  // export -> reset -> import keeps the linkage; a re-sync afterwards still adds nothing
  const exp = await page.evaluate(() => JSON.stringify(S));
  const b = await page.evaluate(exp => { S = migrate(JSON.parse(exp)); ahImport(ahParse(JSON.stringify(Object.assign(JSON.parse(exp).appleHealth ? {} : {}, {}))), {}); return [S.workouts.filter(w => w.healthWorkoutId === 'E2A1-UUID-0001').length, ahWorkoutCandidates().map(x => x.state)]; }, exp);
  assert.deepEqual(b, [1, ['added', 'new']]);
  // delete the LifeOS copy: Apple Health data untouched, the candidate is available again (marked), and can be re-added once
  const d = await page.evaluate(() => { const src = JSON.stringify(S.appleHealth.workouts), w = S.workouts.find(x => x.healthWorkoutId === 'E2A1-UUID-0001');
    view = 'fitness'; render(); document.querySelector(`.ah-wk-card[data-hw="E2A1-UUID-0001"] .delbtn`).click(); document.getElementById('cf_ok').click();
    const st = ahWorkoutCandidates()[0].state, gone = !S.workouts.some(x => x.id === w.id), same = JSON.stringify(S.appleHealth.workouts) === src;
    const re = ahWorkoutAdd('E2A1-UUID-0001'); return { st, gone, same, re: re.ok, n: S.workouts.filter(x => x.healthWorkoutId === 'E2A1-UUID-0001').length, after: ahWorkoutCandidates()[0].state }; });
  assert.deepEqual(d, { st: 'removed', gone: true, same: true, re: true, n: 1, after: 'added' });
  assert.equal(await ahNoReward(page), r0, 'still no reward after delete + re-add');
}, { state: fixtureState() });

test('AHD7 Fitness UX: "Přidat trénink z Apple Health" -> the list of recent workouts (type, date + start, duration, kcal, distance, source, "Už přidáno") -> preview (type, date, start, end, duration, active kcal, distance, source) -> Zrušit / Přidat do LifeOS -> the history shows "Spáleno: 412 kcal" with the Apple Health source', async ({ page }) => {
  await page.evaluate(txt => { ahImport(ahParse(txt)); view = 'fitness'; render(); }, ahDeep());
  await page.click('#ahWkAdd'); await page.waitForSelector('#ahWkSheet');
  const list = await page.$$eval('#ahWkSheet .ah-wk-item', bs => bs.map(b => b.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(list, ['Silový trénink Dnes 06:04 · 54 min · 412 kcal · Apple Watch', 'Běh Včera 16:20 · 38 min · 431 kcal · 6,2 km · Apple Watch']);
  await page.click('#ahWkSheet .ah-wk-item[data-wk="E2A1-UUID-0001"]'); await page.waitForSelector('#ahWkPreview');
  const prev = await page.$$eval('#ahWkPreview [data-wkf]', rs => rs.map(x => [x.dataset.wkf, x.querySelector('b').textContent]));
  assert.deepEqual(prev, [['wk_type', 'Traditional Strength Training'], ['wk_date', '23.09.2026'], ['wk_start', '06:04'], ['wk_end', '06:58'], ['wk_dur', '54 min'], ['wk_kcal', '412 kcal'], ['wk_src', 'Apple Watch']]);
  await page.click('#ahWk_cancel'); assert.equal(await page.evaluate(() => S.workouts.some(w => w.source === 'appleHealth')), false, 'Zrušit adds nothing');
  await page.click('#ahWkAdd'); await page.click('#ahWkSheet .ah-wk-item[data-wk="E2A1-UUID-0001"]'); await page.click('#ahWk_add'); await settle(page);
  const card = await page.$eval('.ah-wk-card[data-hw="E2A1-UUID-0001"]', c => [c.querySelector('[data-burned]').textContent.trim(), c.querySelector('.src-badge').dataset.src, c.querySelectorAll('.editBtn').length, c.textContent.includes('Apple Watch')]);
  assert.deepEqual(card, ['Spáleno: 412 kcal', 'apple', 0, true]);
  await page.click('#ahWkAdd');
  assert.deepEqual(await page.$eval('#ahWkSheet .ah-wk-item[data-wk="E2A1-UUID-0001"]', b => [b.getAttribute('aria-disabled'), b.querySelector('[data-state]').textContent]), ['true', 'Už přidáno']);
  await page.click('#ahWkSheet .ah-wk-item[data-wk="E2A1-UUID-0001"]', { force: true });
  assert.equal(await page.locator('#ahWk_add').count(), 0, 'an added workout cannot be added again');
  await page.evaluate(() => closeSheets());
}, { state: fixtureState() });

test('AHD8 screens 320-1440 px, dark + light: Health with the overview + timeline (sleep / weight / active kcal), step-source sheet, diagnostics, Fitness with the import list + preview + Apple workout card -- no overflow, duplicate ids, NaN / undefined; 44 px targets; named controls', async ({ page }) => {
  const scenes = {
    sleep: "healthTab='sleep';view='health';render()", weight: "healthTab='weight';view='health';render()", kcal: "healthTab='activecal';view='health';render()",
    steps: "healthTab='sleep';view='health';render();uiAhStepSheet()", diag: "view='health';render();uiAhDiagSheet()",
    fitness: "if(!ahLinkedWorkout('E2A1-UUID-0001')) ahWorkoutAdd('E2A1-UUID-0001');view='fitness';render()", wkList: "view='fitness';render();uiAhWorkoutSheet()", wkPrev: "view='fitness';render();uiAhWorkoutPreview(ahWorkoutCandidates()[1].id)" };
  await page.evaluate(txt => ahImport(ahParse(txt)), ahDeep());
  const bad = [];
  for (const theme of ['dark', 'light']) for (const width of AH_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const [k, js] of Object.entries(scenes)) {
      const r = await page.evaluate(({ js, theme }) => { closeSheets(); S.settings.theme = theme; applyTheme(); eval(js);
        const ids = [...document.querySelectorAll('[id]')].map(n => n.id), sheet = document.querySelector('.sheet');
        const ctl = [...document.querySelectorAll('#ahCard button:not(.switch), #hOverview button, .sl-list summary, #ahStepSheet button, #ahDiag button, #ahWkAdd, #ahWkSheet button, #ahWkPreview button, .ah-wk-card button')].filter(b => b.offsetParent);
        return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheetOver: sheet ? sheet.scrollWidth - sheet.clientWidth : 0, dup: ids.filter((x, i) => ids.indexOf(x) !== i),
          nan: /undefined|NaN|\[object/.test(document.body.innerText), small: ctl.filter(b => b.getBoundingClientRect().height < 44).map(b => b.id || b.className),
          unnamed: ctl.filter(b => !(b.getAttribute('aria-label') || b.textContent).trim()).length, sw: [...document.querySelectorAll('#ahPrefH')].every(b => b.getAttribute('role') === 'switch' && b.closest('.ah-pref').getBoundingClientRect().height >= 44) }; }, { js, theme });
      const issues = [r.over > 0 && 'overflow ' + r.over, r.sheetOver > 0 && 'sheet overflow', r.dup.length && 'dup ' + r.dup, r.nan && 'NaN', r.small.length && '<44px ' + r.small, r.unnamed && 'unnamed', !r.sw && 'switch'].filter(Boolean);
      if (issues.length) bad.push(`${theme}/${width}/${k}: ${issues.join('; ')}`);
    }
  }
  assert.deepEqual(bad, []);
  await page.evaluate(() => closeSheets());
}, { state: fixtureState() });

test('AHD9 performance: 62 nights with full stage timelines + 500 workouts parse and import fast; only the selected night is rendered (Health render, Fitness render within budget)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const T = todayStr(), from = addDays(T, -61), iso = (d, hm) => `${d}T${hm}:00+02:00`, sleep = [], workouts = [];
    for (let i = 0; i < 62; i++) { const d = addDays(from, i), p = addDays(d, -1); let t = Date.parse(iso(p, '22:30'));
      for (let k = 0; k < 120; k++) { const a = new Date(t), b = new Date(t + 4 * 60000); sleep.push({ value: ['Core', 'Deep', 'REM', 'Awake', 'Asleep'][k % 5], start: a.toISOString(), end: b.toISOString() }); t += 4 * 60000; } }
    for (let i = 0; i < 500; i++) { const d = addDays(from, i % 62), h = String(6 + (i % 14)).padStart(2, '0'); workouts.push({ type: 'Running', start: iso(d, h + ':0' + (i % 6)), end: iso(d, h + ':4' + (i % 6)), activeKcal: 300 + i, source: 'Apple Watch' }); }
    const txt = JSON.stringify({ protocol: 'lifeos-apple-health', version: 1, generatedAt: iso(T, '09:00'), deviceTimezone: 'Europe/Prague', range: { from, to: T }, sleep, workouts });
    let t0 = performance.now(); const p = ahParse(txt); const parse = performance.now() - t0; t0 = performance.now(); ahImport(p); const imp = performance.now() - t0;
    const times = k => { const a = []; for (let i = 0; i < 5; i++) { const t = performance.now(); k(); a.push(performance.now() - t); } return a.sort((x, y) => x - y)[2]; };
    const health = times(() => { healthTab = 'sleep'; view = 'health'; render(); }), fitness = times(() => { view = 'fitness'; render(); });
    view = 'health'; healthTab = 'sleep'; render();
    return { ok: p.ok, nights: p.counts.sleep, wk: p.counts.workouts, parse, imp, health, fitness, mb: txt.length / 1e6, segs: document.querySelectorAll('.sl-seg').length };
  });
  console.log(`      AHD9 ${r.mb.toFixed(2)} MB: parse ${r.parse.toFixed(0)} ms, import ${r.imp.toFixed(0)} ms, Health render ${r.health.toFixed(1)} ms, Fitness render ${r.fitness.toFixed(1)} ms, timeline bars ${r.segs}`);
  assert.deepEqual([r.ok, r.nights, r.wk], [true, 62, 500]);
  assert.ok(r.segs > 0 && r.segs <= 120, 'only one night of segments in the DOM');
  assert.ok(r.parse < 600 && r.imp < 500 && r.health < 150 && r.fitness < 250, 'fast');
}, { state: fixtureState() });

// ---------- screenshots ----------
// Phase 8B QA matrix: phones 375/390/430 and desktop 1280/1440, each dark + light.
// The original pre-8B set (mobile-dark/mobile-light/desktop-dark) lives in baseline/screens.
const SCREEN_VARIANTS = [375, 390, 430, 1280, 1440].flatMap(w => ['dark', 'light'].map(theme => ({ name: `${w}-${theme}`, viewport: { width: w, height: w >= 1000 ? 800 : 844 }, theme })));
async function screens(outDir, variants = SCREEN_VARIANTS) {
  for (const v of variants) {
    const dir = path.join(outDir, v.name); mkdirSync(dir, { recursive: true });
    const errors = [];
    const { context, page } = await openApp({ state: { ...fixtureState(), settings: { ...fixtureState().settings, theme: v.theme } }, viewport: v.viewport, errors });
    // Queued boot toasts keep appearing for a few seconds; they are not part of the screens.
    await page.addStyleTag({ content: '#toasts{display:none!important}' });
    for (const [i, view] of VIEWS.entries()) {
      await page.evaluate(() => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; uiPlannerDay = todayStr(); });
      await go(page, view);
      await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('toasts').replaceChildren(); }); // boot-time achievement toasts would cover the view
      await page.screenshot({ path: path.join(dir, `${String(i + 1).padStart(2, '0')}-${view}.png`), fullPage: true, animations: 'disabled' });
    }
    await go(page, 'home'); await page.evaluate(() => document.getElementById('toasts').replaceChildren()); await page.click('#fabBtn');
    await page.waitForTimeout(150); // openSheet() moves focus after 30 ms
    await page.screenshot({ path: path.join(dir, '22-quick-add.png'), animations: 'disabled' });
    await page.evaluate(() => closeSheets()); await go(page, 'tasks'); await page.click('#uiAddTask');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(dir, '24-task-form.png'), animations: 'disabled' });
    await context.close();
    const ob = await openApp({ viewport: v.viewport, errors });
    await ob.page.evaluate(t => { S.settings.theme = t; applyTheme(); }, v.theme);
    await ob.page.waitForTimeout(150);
    await ob.page.screenshot({ path: path.join(dir, '23-onboarding.png'), animations: 'disabled' });
    await ob.context.close();
    console.log(`${v.name}: ${VIEWS.length + 3} screenshots -> ${path.relative(process.cwd(), dir)}${errors.length ? '  ERRORS: ' + errors.join('; ') : ''}`);
  }
}
// Pixel comparison of a fresh capture against a stored set (default baseline/screens-8b).
async function compareScreens(refDir) {
  const { PNG } = await import('pngjs');
  const { default: pixelmatch } = await import('pixelmatch');
  const { readdirSync } = await import('node:fs');
  const tmp = path.join(here, 'out', 'compare'); await screens(tmp);
  let worst = 0, diffs = [];
  for (const v of SCREEN_VARIANTS) for (const f of readdirSync(path.join(tmp, v.name))) {
    const ref = path.join(refDir, v.name, f);
    if (!existsSync(ref)) { diffs.push(`${v.name}/${f}: no reference`); continue; }
    const a = PNG.sync.read(readFileSync(ref)), b = PNG.sync.read(readFileSync(path.join(tmp, v.name, f)));
    if (a.width !== b.width || a.height !== b.height) { diffs.push(`${v.name}/${f}: size ${a.width}x${a.height} -> ${b.width}x${b.height}`); continue; }
    const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
    const pct = n / (a.width * a.height) * 100; worst = Math.max(worst, pct);
    if (pct > 0.1) diffs.push(`${v.name}/${f}: ${pct.toFixed(2)}% pixels differ`);
  }
  console.log(`compared against ${path.relative(process.cwd(), refDir)}; worst diff ${worst.toFixed(3)}%`);
  if (diffs.length) { console.log('DIFFERENCES:\n  ' + diffs.join('\n  ')); return 1; }
  console.log('SCREENSHOTS MATCH'); return 0;
}

// ---------- runner ----------
let failed = 0;
const argAfter = flag => { const v = args[args.indexOf(flag) + 1]; return v && !v.startsWith('--') ? v : null; };
if (args.includes('--screens')) {
  await screens(path.resolve(argAfter('--screens') || path.join(here, 'out', 'screens')));
} else if (args.includes('--compare-screens')) {
  failed = await compareScreens(path.resolve(argAfter('--compare-screens') || path.join(here, 'baseline', 'screens-8b')));
} else {
  const only = process.env.ONLY;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    const errors = [], tnotes = [];
    const started = Date.now();
    let context;
    try {
      const o = await openApp({ state: t.opts?.state ?? null, errors });
      context = o.context;
      await t.fn({ page: o.page }, { note: m => tnotes.push(m) });
      if (!o.page.isClosed()) await o.page.waitForTimeout(50); // R1 closes its first tab on purpose
      if (errors.length) throw new Error('console/page errors:\n      ' + errors.join('\n      '));
      console.log(`  ✓ ${t.name} (${Date.now() - started} ms)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${String(e.message + (process.env.STACK ? "\n" + e.stack : "")).split('\n').join('\n      ')}`);
    } finally { await context?.close(); }
    tnotes.forEach(n => notes.push(`${t.name}: ${n}`));
  }
  const ran = only ? tests.filter(t => t.name.includes(only)).length : tests.length;
  console.log(`\n${ran - failed}/${ran} passed`);
  if (notes.length) console.log('\nNOTES (observations, not failures):\n  ' + [...new Set(notes)].join('\n  '));
}
await browser.close(); server.close();
process.exit(failed ? 1 : 0);

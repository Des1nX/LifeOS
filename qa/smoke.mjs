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
  'journal', 'car', 'subscriptions', 'calendar', 'quests', 'statistics', 'search', 'health', 'goalDetail', 'habitDetail', 'settings', 'planner'];
const NAV = ['home', 'tasks', 'habits', 'character', 'more'];
const MORE_ITEMS = ['planner', 'goals', 'finance', 'fitness', 'nutrition', 'notes', 'journal', 'car', 'subscriptions', 'calendar', 'quests',
  'statistics', 'search', 'health', 'character', 'settings'];
const QUICK_ADD = ['task', 'habit', 'goal', 'expense', 'income', 'workout', 'meal', 'note', 'journal', 'event', 'water', 'fuel', 'planner'];

// ---------- harness ----------
const server = http.createServer((req, res) => {
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
const stateOf = page => page.evaluate(() => JSON.parse(JSON.stringify(S)));
const idbState = page => page.evaluate(async () => JSON.parse(JSON.stringify(await rawIdbGet()))); // JSON view, like stateOf (xpLog.key may be undefined)
const go = (page, v) => page.evaluate(v => { view = v; render(); }, v);
function allIds(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach(x => allIds(x, out));
  else if (obj && typeof obj === 'object') { if (typeof obj.id === 'string') out.push(obj.id); Object.values(obj).forEach(x => allIds(x, out)); }
  return out;
}
async function appText(page) { return page.evaluate(() => document.getElementById('app').innerText); }

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
  assert.deepEqual(await page.$$eval('nav.bottom button', bs => bs.map(b => b.dataset.v)), NAV);
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

test('views: all 22 screens render with data and without errors (Phase 10 adds Planner)', async ({ page }, ctx) => {
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
  assert.equal(n, 5, 'five health tabs');
  for (let i = 0; i < n; i++) { await page.locator('#hTabs > *').nth(i).click(); assert.ok((await appText(page)).length > 20); }
  await go(page, 'statistics');
  const p = await page.locator('#spTabs button').count();
  assert.ok(p >= 3, 'statistics periods');
  for (let i = 0; i < p; i++) { await page.locator('#spTabs button').nth(i).click(); assert.equal(await page.locator('#spTabs button').nth(i).getAttribute('class'), 'on'); }
}, { state: fixtureState() });

test('quick add: all 13 entries open their form (water logs directly; Phase 10 adds Planner block)', async ({ page }) => {
  for (const t of QUICK_ADD) {
    await page.click('#fabBtn');
    assert.equal(await page.locator('.sheet .qopt[data-t]').count(), 13);
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.tasks.length > 0);
  assert.deepEqual(await stateOf(page), s, 'import restores identical state');
  await settle(page); await reload(page);
  assert.deepEqual(await stateOf(page), s, 'imported state persisted');
  await page.click('#settingsBtn');
  await page.setInputFiles('#st_impFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
  await page.waitForTimeout(200);
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
    ['openSleepForm()', 'sleepLog'], ['openWeightForm()', 'weightLog'], ['openStepsForm()', 'stepsLog'], ['openHeartRateForm()', 'heartRateLog'],
    ['openActiveCaloriesForm()', 'activeCaloriesLog'], ['openVehicleForm()', 'vehicles'], ['openServiceForm("v1")', 'carServices'], ['openFuelForm("v1")', 'fuelEntries'],
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
  assert.equal(r.score, null); assert.equal(r.label, null); assert.equal(r.relevant, 0); assert.equal(r.algo, 2); // polish pass: algo 2 adds training days
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
  assert.equal(snap.areas.nutrition.mode, 'closed'); assert.equal(snap.areas.nutrition.parts.calories, 0); assert.equal(snap.algo, 2);
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
  assert.equal(snap.score, closed.score); assert.equal(snap.algo, 2); assert.equal(snap.label, closed.label);
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => Object.keys(S.dailyScores).length > 0);
  assert.deepEqual((await stateOf(page)).dailyScores, snap, 'import restores snapshots');
}, { state: fixtureState() });

test('9 history: a pre-Phase-9 backup (no dailyScores keys) imports cleanly; reset clears history', async ({ page }) => {
  const old = fixtureState(); delete old.dailyScores; delete old.dailyScoresSince;
  await page.click('#settingsBtn');
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
}, { state: fixtureState() });

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
  assert.equal(await page.evaluate(() => view), 'planner');
  assert.equal(await page.locator(`#plTimeline [data-block="${b.id}"]`).count(), 1, 'visible on the timeline');
  assert.equal(await untouchable(page), before, 'no XP/RPG/Daily Score change');
}, { state: fixtureState() });

test('10 UI: invalid or equal times show an error and save nothing; overlap is allowed', async ({ page }) => {
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  const n0 = (await stateOf(page)).plannerBlocks.length;
  await page.click('#uiAddBlock');
  await page.fill('#pb_title', 'X'); await page.fill('#pb_start', '15:00'); await page.fill('#pb_end', '15:00');
  await page.click('#pb_save');
  assert.equal(await page.locator('[data-err="endTime"]').isVisible(), true);
  assert.match(await page.locator('[data-err="endTime"]').innerText(), /Konec musí být po začátku/);
  assert.equal(await page.getAttribute('#pb_end', 'aria-invalid'), 'true');
  assert.equal((await stateOf(page)).plannerBlocks.length, n0, 'nothing saved');
  await page.fill('#pb_end', '16:00'); await page.click('#pb_save');          // overlaps Matematika + Konzultace
  const lefts = await page.$$eval('#plTimeline [data-block]', ns => ns.filter(n => n.style.top === ns.find(m => m.dataset.block === 'pb_math').style.top).map(n => n.style.left));
  assert.equal(new Set(lefts).size, lefts.length, 'same-time blocks are side by side');
  assert.equal((await stateOf(page)).plannerBlocks.length, n0 + 1);
}, { state: fixtureState() });

test('10 UI: edit and delete a block through the sheet; the timeline check toggles only the block', async ({ page }) => {
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('[data-block="pb_call"] .pl-open');
  await page.fill('#pb_title', 'Konzultace s učitelem'); await page.fill('#pb_end', '17:00'); await page.click('#pb_save');
  let s = await stateOf(page);
  assert.deepEqual([s.plannerBlocks.find(b => b.id === 'pb_call').title, s.plannerBlocks.find(b => b.id === 'pb_call').endTime], ['Konzultace s učitelem', '17:00']);
  const taskBefore = JSON.stringify(s.tasks.find(t => t.id === 't_open'));
  await page.click('[data-block="pb_math"] .plCheck');
  s = await stateOf(page);
  assert.equal(s.plannerBlocks.find(b => b.id === 'pb_math').completed, true);
  assert.equal(JSON.stringify(s.tasks.find(t => t.id === 't_open')), taskBefore, 'linked task untouched');
  page.on('dialog', d => d.accept());
  await page.click('[data-block="pb_call"] .pl-open'); await page.click('#pb_delete'); await page.click('#cf_ok');
  assert.ok(!(await stateOf(page)).plannerBlocks.some(b => b.id === 'pb_call'));
  assert.equal(await page.locator('[data-block="pb_call"]').count(), 0);
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
  assert.match(await page.locator(`[data-block="${b.id}"]`).innerText(), /Buy groceries/);
  // task side: chip on the row opens the planner day
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.planLink').click();
  assert.equal(await page.evaluate(() => [view, uiPlannerDay].join()), `planner,${TODAY}`);
  // block side: shows the task and its done state after the task is completed
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.check').click();
  await page.waitForTimeout(700);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  const blk = page.locator(`[data-block="${b.id}"]`);
  assert.match(await blk.locator('.pl-open').getAttribute('aria-label'), /úkol hotový/);
  assert.equal(await blk.locator('[title="úkol hotový"] svg').count(), 1, 'compact block still shows the linked task is done (line icon)');
  assert.equal((await stateOf(page)).plannerBlocks.find(x => x.id === b.id).completed, false, 'block keeps its own completed flag');
}, { state: fixtureState() });

test('10 UI: deleting the linked task does not crash the planner', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Write report' }).locator('.delbtn').click(); await page.click('#cf_ok');
  assert.ok(!(await stateOf(page)).tasks.some(t => t.id === 't_open'));
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.match(await page.locator('[data-block="pb_math"]').innerText(), /smazáno/);
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
  assert.equal(await page.evaluate(() => [view, uiPlannerDay].join()), `planner,${TODAY}`);
  await page.evaluate(() => { S.settings.widgets.tasks = false; view = 'home'; render(); });
  assert.equal(await page.locator('[data-plan="home"]').count(), 1, 'independent of the tasks widget');
  await page.evaluate(() => { S.settings.widgets.planner = false; view = 'home'; render(); });
  assert.equal(await page.locator('[data-plan="home"]').count(), 0, 'its own widget key can hide it');
}, { state: fixtureState() });

test('10 UI: day navigation (prev/next/Today) and read-only calendar events (never copied)', async ({ page }) => {
  const events = JSON.stringify((await stateOf(page)).events);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.equal(await page.locator('[data-event="ev1"]').count(), 1, "today's timed event shown as context");
  await page.click('#plNext');
  assert.equal(await page.evaluate(() => uiPlannerDay), dayOff(1));
  assert.match(await page.locator('#plTimeline').innerText(), /Učení/);
  await page.click('#plToday'); assert.equal(await page.evaluate(() => uiPlannerDay), TODAY);
  await page.click('#plPrev'); assert.equal(await page.evaluate(() => uiPlannerDay), dayOff(-1));
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
  assert.equal(await page.evaluate(() => [view, uiPlannerDay].join()), `planner,${TODAY}`);
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.plannerBlocks.length === 5);
  const old = fixtureState(); delete old.plannerBlocks;
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForFunction(() => Array.isArray(S.plannerBlocks) && S.plannerBlocks.length === 0);
  assert.equal((await stateOf(page)).schemaVersion, 8);
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.equal(await page.locator('#plTimeline [data-block]').count(), 0);
  page.on('dialog', d => d.accept());
  await page.evaluate(() => { S.plannerBlocks = [{ id: 'x', date: todayStr(), startTime: '10:00', endTime: '11:00', title: 'x' }]; });
  await page.click('#settingsBtn'); await page.click('#st_reset'); await page.click('#cf_ok'); await page.click('#cf_ok'); // A3: two in-app confirmation steps
  assert.deepEqual((await stateOf(page)).plannerBlocks, []);
}, { state: fixtureState() });

test('10 invariants: a full planner session changes no XP/log/level/attributes/points/achievements/quests/Daily Score, tasks or events', async ({ page }) => {
  const other = () => page.evaluate(() => JSON.stringify([S.tasks, S.events, S.goals, S.workouts, S.habits]));
  const [u0, o0] = [await untouchable(page), await other()];
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('#uiAddBlock'); await page.fill('#pb_title', 'Test'); await page.fill('#pb_start', '11:00'); await page.fill('#pb_end', '11:45');
  await page.click('#pb_link'); await page.click('[data-lk-type="task"][data-lk-id="t_open"]'); await page.click('#pb_save');
  const id = (await stateOf(page)).plannerBlocks.find(b => b.title === 'Test').id;
  await page.click(`[data-block="${id}"] .plCheck`); await page.click(`[data-block="pb_math"] .plCheck`); await page.click(`[data-block="pb_math"] .plCheck`);
  await page.click(`[data-block="${id}"] .pl-open`); await page.fill('#pb_title', 'Test 2'); await page.click('#pb_save');
  page.on('dialog', d => d.accept());
  await page.click(`[data-block="${id}"] .pl-open`); await page.click('#pb_delete'); await page.click('#cf_ok');
  await page.click('#plNext'); await page.click('#plToday');
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.exerciseLibrary.length === 4);
  assert.deepEqual((await stateOf(page)).exerciseLibrary, lib, 'import restores it exactly (same ids)');
  const old = fixtureState(); delete old.exerciseLibrary;
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.workoutTemplates.length === 1);
  assert.deepEqual((await stateOf(page)).workoutTemplates, tpls);
  const old = fixtureState(); delete old.workoutTemplates;
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
  const viaFinish = await delta('const w = workoutStart({ templateId: tid }).workout; workoutFinish(w.id);');
  await page.evaluate(() => { closeSheets(); view = 'fitness'; fitnessTab = 'workouts'; render(); });
  const b = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT }));
  await page.click('#addW'); await page.fill('#w_name', 'Legacy log'); await page.click('#w_save');
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.workouts.length === 3);
  assert.deepEqual((await stateOf(page)).workouts, wk);
  assert.equal(await page.evaluate(() => activeWorkout().name), 'Push A');
  const old = fixtureState();
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
}, { state: fixtureState() });

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

test('11A UI: Finish with no completed working set asks first - Cancel keeps it active, Dokončit finishes with the usual XP', async ({ page }) => {
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
  assert.equal(await page.evaluate(() => S.totalXp) - x0, 80, 'same XP as today for a workout without sets');
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
  await page.setInputFiles('#st_impFile', file);
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.workouts.length === 2);
  assert.equal(await page.evaluate(() => JSON.stringify([exercisePRs(), S.workouts.map(w => w.result)])), before);
  const old = fixtureState();
  old.workouts.push({ id: 'w0', name: 'Older push', date: '2026-09-10', duration: '50', notes: '', createdAt: NOW - 13 * 864e5, exercises: [{ id: 'ex0', name: 'Bench press', sets: '3', reps: '8', weight: '75', muscle: '', rpe: '', rest: '' }] });
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => workoutFindById(completedWorkouts(S)[0].id).entries[0].sets.length === 3);
  assert.deepEqual(await totals(page), t0, 'import of the full backup: no double pay');
  delete backup.muscleProgress;
  await page.setInputFiles('#st_impFile', { name: 'nolog.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
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
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(id => S.plannerBlocks.some(x => x.id === id), bid);
  assert.deepEqual(await blk(page, bid), b, 'export/import');
  assert.equal(await page.evaluate(id => plannerLinks(S.plannerBlocks.find(x => x.id === id)).template.name, bid), 'Pull B');
}, { state: fixtureState() });

test('11A planner: Start creates one standard active workout (plan snapshot, plannerBlockId) - no XP, no quest, no Daily Score change, block not completed', async ({ page }) => {
  const { tid, bid } = await plSetup(page);
  const u0 = await untouchable(page);
  await plView(page);
  await page.click(`[data-block="${bid}"] .plWkStart`);
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
  await page.click(`[data-block="${bid}"] .plWkStart`);
  assert.equal(await page.evaluate(() => S.workouts.filter(x => x.status === 'active').length), 1);
  assert.equal(await page.locator('#wkLive').count(), 1);
}, { state: fixtureState() });

test('11A planner: an active workout from elsewhere is offered for continuation, never a second one', async ({ page }) => {
  const { bid } = await plSetup(page);
  await page.evaluate(() => workoutStart({ name: 'Spontaneous' }));
  await plView(page);
  await page.click(`[data-block="${bid}"] .plWkStart`);
  assert.match(await page.locator('.cf-sheet').innerText(), /Trénink už probíhá[\s\S]*Máš rozpracovaný trénink „Spontaneous“/);
  await page.click('#cf_cancel');
  assert.equal(await page.evaluate(() => S.workouts.filter(x => x.status === 'active').length), 1);
  await page.click(`[data-block="${bid}"] .plWkStart`); await page.click('#cf_ok');
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
    assert.match(await page.locator(`[data-block="${id}"]`).innerText(), /Šablona není dostupná/);
    assert.equal(await page.locator(`[data-block="${id}"] .plWkStart`).count(), 0, 'no Start without a template');
  }
  assert.deepEqual(await page.evaluate(id => plannerStartWorkout(id), bid), { ok: false, reason: 'no_template' });
  await page.click(`[data-block="${bid}"] .pl-open`);
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
}, { state: fixtureState() });

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
}, { state: fixtureState() });

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
  await page.click(`[data-block="${bid}"] .plWkStart`);
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
  await page.setInputFiles('#st_impFile', file);
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
}, { state: fixtureState() });

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
}, { state: fixtureState() });

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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(() => S.investments.length === 1);
  assert.deepEqual(JSON.parse(await snap()), JSON.parse(s0), 'import restores all of it');
  const old = fixtureState();
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
}, { state: fixtureState() });

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
  assert.match(await page.locator('#st_widgets').innerText(), /Dnešní plán[\s\S]*Denní výpravy/);
}, { state: fixtureState() });

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
  await page.click('nav.bottom button[data-v="character"]');
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
  assert.equal(await page.locator('#n_cat option[value="School"]').count(), 1, 'default note categories kept');
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
  await page.setInputFiles('#st_impFile', file);
  await page.waitForFunction(k => S.lifeCategories.some(c => c.key === k), key);
  const old = fixtureState(); delete old.lifeCategories; delete old.questBoard;
  await page.setInputFiles('#st_impFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
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
  await page.click('#uiAddBlock');
  const labels = await page.locator('.pl-form label').allInnerTexts();
  assert.deepEqual(labels.map(l => l.trim()), ['Název', 'Datum', 'Začátek', 'Konec', 'Kategorie', 'Propojeno', 'Poznámky']);
  await page.click('#pb_link');
  const groups = await page.$$eval('#pb_linkList .lk-group', gs => gs.map(g => [g.className.split(' ')[1], getComputedStyle(g.querySelector('.lk-gh i')).backgroundColor]));
  assert.deepEqual(groups.map(g => g[0]), ['lk-task', 'lk-goal', 'lk-workout']);
  assert.deepEqual(groups.map(g => g[1]), ['rgb(96, 165, 250)', 'rgb(248, 113, 113)', 'rgb(167, 139, 250)'], 'blue / red / purple (dark theme)');
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
  await page.click('[data-block="pb_push"] .pl-open');
  assert.match(await page.innerText('#pb_link'), /Buy groceries/, 'primary link shown');
  await page.fill('#pb_notes', 'n'); await page.click('#pb_save');
  b = await blk(page, 'pb_push');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.description, b.notes], ['t_med', 'g_fit', 'w2', 'old description', 'n'], 'nothing lost');
  // choosing a workout replaces the other links; removing the link clears it
  await page.click('[data-block="pb_push"] .pl-open'); await page.click('#pb_link');
  const tid = await page.evaluate(() => S.workoutTemplates[0].id);
  await page.click(`[data-lk-type="workout"][data-lk-id="${tid}"]`); await page.click('#pb_save');
  b = await blk(page, 'pb_push');
  assert.deepEqual([b.taskId, b.goalId, b.workoutId, b.workoutTemplateId], ['', '', '', tid]);
  assert.equal(await page.locator('[data-block="pb_push"] .plWkStart').count(), 1, 'a linked workout can be started');
  await page.click('[data-block="pb_push"] .pl-open'); await page.click('#pb_link'); await page.click('[data-lk-clear]'); await page.click('#pb_save');
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
  assert.match(await page.innerText('#g_modeHelp'), /Po uložení propoj s cílem úkoly/);
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
  assert.equal(await page.locator('#moreGrid .qopt .ic svg').count(), 16);
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
  await page.click('#addW'); await page.fill('#w_name', 'Legacy log'); await page.click('#w_save');
  const a = await page.evaluate(() => ({ ...S.attrs, xp: S.totalXp }));
  assert.deepEqual([a.xp - b.xp, a.STR - b.STR, a.VIT - b.VIT, a.DEX - b.DEX], [80, 24, 14, 10]);
}, { state: fixtureState() });

test('B2 balancing: every meal keeps its 10 XP; only the first meal logged each day gives attribute points (+6 VIT)', async ({ page }) => {
  await quietQuests(page);
  const log = () => page.evaluate(() => S.xpLog.filter(x => x.reason === 'Meal logged').map(x => [x.amount, x.attrs || null]));
  const vit = () => page.evaluate(() => S.attrs.VIT);
  const v0 = await vit(), n0 = (await log()).length;
  for (const name of ['Snídaně', 'Oběd', 'Večeře']) {
    await page.evaluate(() => { closeSheets(); openMealForm(); });
    await page.fill('#m_name', name); await page.fill('#m_cal', '500'); await page.click('#m_save');
  }
  // the "repeat meal" button is the other way to log a meal
  await page.evaluate(() => { view = 'nutrition'; render(); });
  await page.locator('.meal-item .repeatBtn').first().click();
  const l = (await log()).slice(n0);
  assert.deepEqual(l, [[10, { VIT: 6 }], [10, null], [10, null], [10, null]], 'XP for each meal, attributes only once');
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
    ['dq_plan_morning', 25], ['dq_sleep', 15], ['dq_nutrition', 15], ['wq_workouts', 150], ['wq_tasks', 150], ['wq_streak', 150], ['wq_goal', 100], ['wq_score', 120], ['wq_planner', 100]], 'quest XP unchanged');
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
  assert.equal(await page.evaluate(() => view), 'planner', 'inline link still navigates');
  assert.equal(await page.locator('[data-ds="card"] .ds-counts').count(), 0, 'no duplicated counts under the score');
}, { state: fixtureState() });

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
  assert.match(txt, /Smazat návyk\?[\s\S]*včetně celé historie plnění a série[\s\S]*Cíl „[^“]+“ zůstane/);
  await page.click('#cf_cancel'); assert.ok(await page.evaluate(() => S.habits.some(h => h.id === 'h_water')));
  await hb.click(); await page.click('#cf_ok');
  assert.ok(await page.evaluate(() => !S.habits.some(h => h.id === 'h_water')), 'habit deleted');
  await page.locator('#msList .delbtn').first().click(); txt = await sheet();
  assert.match(txt, /Smazat milník\?[\s\S]*Cíl zůstane/);
  await page.click('#cf_cancel'); assert.equal(await page.evaluate(() => S.milestones.length), 2);
  await page.locator('#msList .delbtn').first().click(); await page.click('#cf_ok');
  assert.equal(await page.evaluate(() => S.milestones.length), 1, 'milestone deleted');
  // goal: cascade described and applied (milestones deleted, tasks + habits unlinked)
  await page.evaluate(() => { S.tasks.push({ id: 'tg', title: 'goal task', priority: 'Low', goalId: 'g_fit', done: false, createdAt: 1 }); S.habits.find(h => h.id === 'h_read').goalId = 'g_fit'; view = 'goals'; render(); });
  await page.evaluate(() => document.querySelector('.goal-card .delbtn').click());
  txt = await sheet();
  assert.match(txt, /Smazat cíl\?[\s\S]*Smaže se i jeho 1 milník[\s\S]*Propojený úkol \(1\) zůstane[\s\S]*Propojený návyk \(1\) zůstane/);
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
  await page.setInputFiles('#st_impFile', await dl.path()); await page.waitForFunction(() => S.goals.length > 0);
  assert.equal(JSON.stringify(await stateOf(page)), keep, 'export/import identical');
  await settle(page); await reload(page); assert.equal(JSON.stringify(await stateOf(page)), keep, 'reload identical');
  assert.deepEqual(dialogs, [], 'no native browser dialogs');
}, { state: fixtureState() });

test('R4 deletes: every other delete path and Reset use the app sheet (Czech, danger, cancel keeps), never confirm()', async ({ page }) => {
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.evaluate(() => { exerciseAddPreset('Plank'); exerciseAddPreset('Bench Press'); templateSave({ name: 'QA plan', exercises: [{ exerciseId: exerciseFind('Bench press').id, sets: 2, repsMin: 5, weight: 50 }] }); S.profile.photo = 'data:image/png;base64,iVBORw0KGgo='; S.profile.avatar = 'photo'; });
  const cases = [
    ['habits list', "view='habits';render()", '#hlist .delbtn', 'S.habits.length', /Smazat návyk\?/],
    ['workout', "fitnessTab='workouts';uiWorkoutView=null;view='fitness';render()", '#app .delbtn[aria-label^="Smazat: "]', 'S.workouts.length', /Smazat trénink\?[\s\S]*rekordy se přepočítají/],
    ['meal', "view='nutrition';render()", '#app .meal-item .delbtn, #app .item .delbtn', 'S.meals.length', /Smazat jídlo\?/],
    ['note', "view='notes';render()", '#app .delbtn', 'S.notes.length', /Smazat poznámku\?/],
    ['journal', "view='journal';render()", '#app .delbtn', 'S.journal.length', /Smazat zápis\?/],
    ['service', "view='car';render()", '[id^="svc-"] .delbtn', 'S.carServices.length', /Smazat servisní záznam\?/],
    ['fuel', "view='car';render()", '[id^="fuel-"] .delbtn, [id^="fu-"] .delbtn', 'S.fuelEntries.length', /Smazat tankování\?/],
    ['vehicle', "view='car';render()", '#app .delbtn[aria-label^="Smazat: "]', 'S.vehicles.length', /Smazat vozidlo\?[\s\S]*servis \(\d+\) a tankování \(\d+\)/],
    ['subscription', "view='subscriptions';render()", '#app .item .delbtn', 'S.subscriptions.length', /Smazat předplatné\?/],
    ['event', "view='calendar';render()", '#app .delbtn', 'S.events.length', /Smazat událost\?/],
    ['sleep', "healthTab='sleep';view='health';render()", '#app .item .delbtn', 'S.sleepLog.length', /Záznam spánku z/],
    ['weight', "healthTab='weight';view='health';render()", '#app .item .delbtn', 'S.weightLog.length', /Záznam hmotnosti z/],
    ['steps', "healthTab='steps';view='health';render()", '#app .item .delbtn', 'S.stepsLog.length', /Záznam kroků z/],
    ['heart', "healthTab='heartrate';view='health';render()", '#app .item .delbtn', 'S.heartRateLog.length', /Záznam tepu z/],
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
  await page.setInputFiles('#st_impFile', await dl.path()); await page.waitForFunction(n => S.xpLog.length === n, r.xs);
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
  await page.evaluate(() => window.scrollTo(0, 300)); const top0 = await page.evaluate(() => parseInt(document.querySelector('#plTimeline .pl-now').style.top)); await mark();
  await runTick(30 * 60000);
  assert.ok(await same()); assert.equal(await page.evaluate(() => window.scrollY), 300, 'scroll kept');
  assert.equal(await page.evaluate(() => parseInt(document.querySelector('#plTimeline .pl-now').style.top)) - top0, Math.round(30 * 1.1), 'now-line moved 30 min');
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
}, { state: fixtureState() });

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

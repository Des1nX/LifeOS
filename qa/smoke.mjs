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
  assert.equal(s.profile.avatar, '🧝');
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
  assert.equal(await page.inputValue('#f_xp'), '30', 'High priority pre-fills 30 XP');
  await page.click('#f_save');
  let s = await stateOf(page);
  const t = s.tasks.find(x => x.title === 'QA task');
  assert.ok(t && t.priority === 'High' && t.xpReward === 30 && t.dueDate === TODAY);
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
  await page.locator('.item', { hasText: 'QA task edited' }).locator('.delbtn').click();
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
  assert.equal(s.xpLog.find(x => x.key === key).amount, 10, 'Medium task = 10 XP');
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

test('level system: crossing a level pays Skill/Attribute points once and survives reload', async ({ page }) => {
  const b = await stateOf(page);
  const { level, into, need } = await page.evaluate(() => levelFromXp(S.totalXp));
  await page.evaluate(n => grantXp(n, 'QA level test'), need - into); // exactly reach the next level
  const s = await stateOf(page);
  assert.equal(await page.evaluate(() => levelFromXp(S.totalXp).level), level + 1);
  assert.equal(s.rpg.highestLevelRewarded, level + 1);
  const d = (x, y) => Object.fromEntries(Object.keys(x).map(k => [k, x[k] - y[k]]));
  assert.deepEqual(d(s.rpg.skillPoints, b.rpg.skillPoints), { available: 1, earned: 1, spent: 0 }, '+1 Skill Point');
  assert.deepEqual(d(s.rpg.attributePoints, b.rpg.attributePoints), { available: 3, earned: 3, spent: 0 }, '+3 Attribute Points');
  assert.equal(s.rpg.activityLog.find(a => a.type === 'levelup').title, 'Level ' + (level + 1));
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
  await page.click('#settingsBtn'); await page.click('#st_reset');
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
  await page.waitForTimeout(80);
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
    if (coll === 'budgets') await page.selectOption('#b_cat', 'Transport'); // one budget per category is an app rule; Food already has one
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
  assert.equal(r.score, null); assert.equal(r.label, null); assert.equal(r.relevant, 0); assert.equal(r.algo, 1);
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
  assert.equal(snap.areas.nutrition.mode, 'closed'); assert.equal(snap.areas.nutrition.parts.calories, 0); assert.equal(snap.algo, 1);
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
  assert.equal(snap.score, closed.score); assert.equal(snap.algo, 1); assert.equal(snap.label, closed.label);
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
  await tick(page, DAY); await page.click('#settingsBtn'); await page.click('#st_reset');
  s = await stateOf(page);
  assert.deepEqual(s.dailyScores, {}); assert.equal(s.dailyScoresSince, null);
}, { state: fixtureState() });

test('9 UI: Home shows the live Daily Score with all five areas (N/A labelled, never scored as 0)', async ({ page }) => {
  const r = await page.evaluate(() => dailyScore(todayStr()));
  const card = page.locator('[data-ds="card"]');
  assert.equal(await card.count(), 1);
  assert.equal((await card.locator('.ring > span').innerText()).trim(), String(r.score));
  for (const k of ['tasks', 'habits', 'nutrition', 'sleep', 'fitness']) {
    const txt = (await card.locator(`.ds-row[data-area="${k}"] b`).innerText()).trim();
    assert.equal(txt, r.areas[k].score == null ? 'N/A' : `${r.areas[k].score} %`, k);
  }
  assert.equal(r.areas.fitness.score, null, 'fixture has an unplanned workout today -> N/A');
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
  assert.deepEqual({ ...b, id: 0, createdAt: 0, updatedAt: 0 }, { id: 0, date: TODAY, startTime: '15:00', endTime: '16:00', title: 'Matematika', description: '', category: 'Learning', taskId: '', goalId: '', workoutId: '', notes: '', completed: false, createdAt: 0, updatedAt: 0 });
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
  assert.deepEqual(await page.evaluate(() => plannerLinks(S.plannerBlocks[0])), { task: null, goal: null, workout: null });
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
  await page.click('[data-block="pb_call"] .pl-open'); await page.click('#pb_delete');
  assert.ok(!(await stateOf(page)).plannerBlocks.some(b => b.id === 'pb_call'));
  assert.equal(await page.locator('[data-block="pb_call"]').count(), 0);
}, { state: fixtureState() });

test('10 UI: Task -> Naplánovat creates a linked block, the task itself stays unchanged, links work both ways', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  const taskBefore = JSON.stringify((await stateOf(page)).tasks.find(t => t.id === 't_med'));
  await page.locator('.item', { hasText: 'Buy groceries' }).locator('.editBtn').click();
  await page.click('#f_plan');
  assert.equal(await page.inputValue('#pb_title'), 'Buy groceries');
  assert.equal(await page.inputValue('#pb_task'), 't_med');
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
  assert.match(await blk.innerText(), /✅/, 'compact block still shows the linked task is done');
  assert.equal((await stateOf(page)).plannerBlocks.find(x => x.id === b.id).completed, false, 'block keeps its own completed flag');
}, { state: fixtureState() });

test('10 UI: deleting the linked task does not crash the planner', async ({ page }) => {
  await page.click('nav.bottom button[data-v="tasks"]');
  await page.locator('.item', { hasText: 'Write report' }).locator('.delbtn').click();
  assert.ok(!(await stateOf(page)).tasks.some(t => t.id === 't_open'));
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  assert.match(await page.locator('[data-block="pb_math"]').innerText(), /smazáno/);
}, { state: fixtureState() });

test('10 UI: Home shows Today\'s plan inside the existing tasks widget and opens the planner', async ({ page }) => {
  const card = page.locator('[data-plan="home"]');
  assert.equal(await card.count(), 1);
  assert.deepEqual((await card.locator('.plan-row b').allInnerTexts()).map(x => x.trim()), ['08:00', '15:00', '15:30', '17:00'], "today's blocks only, by time");
  await card.locator('.plan-row').nth(1).click();
  assert.equal(await page.evaluate(() => [view, uiPlannerDay].join()), `planner,${TODAY}`);
  await page.evaluate(() => { S.settings.widgets.tasks = false; view = 'home'; render(); });
  assert.equal(await page.locator('[data-plan="home"]').count(), 0, 'follows the tasks widget visibility; no new widget key');
  assert.ok(!(await page.evaluate(() => WIDGET_DEFS.some(w => /plan/i.test(w.key)))));
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
  await page.click('#settingsBtn'); await page.click('#st_reset');
  assert.deepEqual((await stateOf(page)).plannerBlocks, []);
}, { state: fixtureState() });

test('10 invariants: a full planner session changes no XP/log/level/attributes/points/achievements/quests/Daily Score, tasks or events', async ({ page }) => {
  const other = () => page.evaluate(() => JSON.stringify([S.tasks, S.events, S.goals, S.workouts, S.habits]));
  const [u0, o0] = [await untouchable(page), await other()];
  await page.evaluate(() => { uiPlannerDay = todayStr(); view = 'planner'; render(); });
  await page.click('#uiAddBlock'); await page.fill('#pb_title', 'Test'); await page.fill('#pb_start', '11:00'); await page.fill('#pb_end', '11:45');
  await page.selectOption('#pb_task', 't_open'); await page.selectOption('#pb_goal', 'g_fit'); await page.selectOption('#pb_workout', 'w1'); await page.click('#pb_save');
  const id = (await stateOf(page)).plannerBlocks.find(b => b.title === 'Test').id;
  await page.click(`[data-block="${id}"] .plCheck`); await page.click(`[data-block="pb_math"] .plCheck`); await page.click(`[data-block="pb_math"] .plCheck`);
  await page.click(`[data-block="${id}"] .pl-open`); await page.fill('#pb_title', 'Test 2'); await page.click('#pb_save');
  page.on('dialog', d => d.accept());
  await page.click(`[data-block="${id}"] .pl-open`); await page.click('#pb_delete');
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
  await page.click(`[data-ex="${dl.id}"] .ex-open`); await page.click('#ex_delete');
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
  await page.click('#settingsBtn'); await page.click('#st_reset');
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
  await page.click(`[data-tpl="${t.id}"] .tpl-open`); await page.click('#tp_delete');
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
  await page.click('#settingsBtn'); await page.click('#st_reset');
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
    dq_log_val: DAILY_QUESTS.find(q => q.id === 'dq_log').val(S), wq: WEEKLY_QUESTS.find(q => q.id === 'wq_workouts').val(S),
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
  assert.equal(x1.xp - x0.xp, 80 + 20, '80 workout XP + 20 from the Beast Mode achievement'); assert.equal(x1.vit - x0.vit, 20);
  const w = (await stateOf(page)).workouts.find(z => z.id === wid);
  assert.equal(w.status, 'done'); assert.ok(w.finishedAt >= w.startedAt); assert.equal(w.duration, '1');
  await page.evaluate(() => { checkQuests(); checkAchievements(); });
  const c1 = await consumers(page);
  assert.deepEqual([c1.completed, c1.ds, c1.dsWorkouts, c1.dq_workout, c1.wq, c1.ach, c1.achProg, c1.stats, c1.searchN], [1, 100, 1, true, 1, true, 10, 1, 1], 'after Finish it counts everywhere');
  // exactly once: a second Finish (or a replay of the ledger key) pays nothing
  const x2 = await page.evaluate(wid => { const r = workoutFinish(wid); const g = grantXp(80, 'Workout: Push A', 'STR', `workout:${wid}:${todayStr()}`); return { r, g, xp: S.totalXp, vit: S.attrs.VIT }; }, wid);
  assert.deepEqual(x2.r, { ok: false }); assert.ok(!x2.g);
  assert.equal(x2.vit, x1.vit);
  // quest XP comes from the (unchanged) quest rules, not from Finish itself
  assert.ok(await page.evaluate(() => S.quests.some(q => q.questId === 'dq_workout')));
}, { state: noWorkoutState() });

test('11A active: Finish pays exactly what the Log Workout form pays (same XP, attributes and skill bonus)', async ({ page }) => {
  const tid = await setupTpl(page);
  const delta = async fn => page.evaluate(async fn => {
    const b = { xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT };
    await (new Function('tid', fn))(window.__tid);
    return { xp: S.totalXp - b.xp, STR: S.attrs.STR - b.STR, VIT: S.attrs.VIT - b.VIT };
  }, fn);
  // first_workout is pre-unlocked so neither path also pays the one-off achievement XP
  await page.evaluate(tid => { window.__tid = tid; S.rpg.skillTree.unlocked.push('fitness_training_1'); S.achievementsUnlocked.push('first_workout'); }, tid);
  const viaFinish = await delta('const w = workoutStart({ templateId: tid }).workout; workoutFinish(w.id);');
  await page.evaluate(() => { closeSheets(); view = 'fitness'; fitnessTab = 'workouts'; render(); });
  const b = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT }));
  await page.click('#addW'); await page.fill('#w_name', 'Legacy log'); await page.click('#w_save');
  const a = await page.evaluate(() => ({ xp: S.totalXp, STR: S.attrs.STR, VIT: S.attrs.VIT }));
  const viaForm = { xp: a.xp - b.xp, STR: a.STR - b.STR, VIT: a.VIT - b.VIT };
  assert.deepEqual(viaFinish, viaForm);
  assert.deepEqual([viaFinish.xp, viaFinish.VIT], [80, 20], '80 Character XP and +20 VIT (STR also includes the Training I skill bonus)');
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
  const t = await appText(page);
  assert.ok(!/Push A/.test(t), 'the active workout is not in the history list');
  assert.match(t, /Pull day/);
  await page.evaluate(() => { view = 'home'; render(); });
  assert.ok(!/Push A/.test(await appText(page)));
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
      achievements: fnMap(ACHV), skills: fnMap(SKILLS), skillBranches: [SKILL_BRANCH_LABELS, SKILL_BRANCH_ATTR],
      dailyQuests: fnMap(DAILY_QUESTS), weeklyQuests: fnMap(WEEKLY_QUESTS),
      cats: CATS, attrs: Object.keys(ATTRS), widgets: WIDGET_DEFS, avatars: AVATAR_CHOICES, onboardingPresets: ONBOARDING_HABIT_PRESETS,
      attributePointValue: ATTRIBUTE_POINT_VALUE, i18nKeys: Object.fromEntries(Object.entries(I18N).map(([l, t]) => [l, Object.keys(t).sort()])),
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
      await o.page.waitForTimeout(50);
      if (errors.length) throw new Error('console/page errors:\n      ' + errors.join('\n      '));
      console.log(`  ✓ ${t.name} (${Date.now() - started} ms)`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    } finally { await context?.close(); }
    tnotes.forEach(n => notes.push(`${t.name}: ${n}`));
  }
  const ran = only ? tests.filter(t => t.name.includes(only)).length : tests.length;
  console.log(`\n${ran - failed}/${ran} passed`);
  if (notes.length) console.log('\nNOTES (observations, not failures):\n  ' + [...new Set(notes)].join('\n  '));
}
await browser.close(); server.close();
process.exit(failed ? 1 : 0);

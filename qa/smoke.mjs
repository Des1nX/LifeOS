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
  'journal', 'car', 'subscriptions', 'calendar', 'quests', 'statistics', 'search', 'health', 'goalDetail', 'habitDetail', 'settings'];
const NAV = ['home', 'tasks', 'habits', 'character', 'more'];
const MORE_ITEMS = ['goals', 'finance', 'fitness', 'nutrition', 'notes', 'journal', 'car', 'subscriptions', 'calendar', 'quests',
  'statistics', 'search', 'health', 'character', 'settings'];
const QUICK_ADD = ['task', 'habit', 'goal', 'expense', 'income', 'workout', 'meal', 'note', 'journal', 'event', 'water', 'fuel'];

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

test('views: all 21 screens render with data and without errors', async ({ page }, ctx) => {
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

test('quick add: all 12 entries open their form (water logs directly)', async ({ page }) => {
  for (const t of QUICK_ADD) {
    await page.click('#fabBtn');
    assert.equal(await page.locator('.sheet .qopt[data-t]').count(), 12);
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
const allViews = async (page, fn) => { for (const v of VIEWS) { await page.evaluate(v => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; view = v; render(); }, v); await fn(v); } };

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
    for (const h of await page.$$('.sheet input:not([type=checkbox]):not([type=file]):not(.hide), .sheet textarea')) {
      const [type, val] = await h.evaluate(n => [n.type, n.value]);
      if (val) continue;
      if (type === 'number') await h.fill('5'); else if (type === 'time') await h.fill('07:00'); else if (type === 'date') continue; else await h.fill('QA ' + coll);
    }
    if (coll === 'budgets') await page.selectOption('#b_cat', 'Transport'); // one budget per category is an app rule; Food already has one
    const save = page.locator('.sheet [id$="_save"]').first();
    if (!(await save.count())) { failures.push(`${open}: no save button`); continue; }
    await save.click();
    await page.waitForTimeout(40);
    const after = await page.evaluate(c => S[c].length, coll);
    if (after !== before + 1) failures.push(`${open}: ${coll} ${before} -> ${after}`);
  }
  assert.deepEqual(failures, []);
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
      await page.evaluate(() => { currentHabitId = 'h_read'; currentGoalId = 'g_fit'; });
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

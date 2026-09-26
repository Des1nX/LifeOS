// Dev helper: quick screenshots of selected views.  node shot.mjs <outDir> <width> <theme> view[,view...]
import { chromium } from 'playwright';
import { fixtureState, NOW } from './fixture.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [out, width = '390', theme = 'dark', views = 'home'] = process.argv.slice(2);
const APP = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'LifeOS.html');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +width, height: 900 }, timezoneId: 'Europe/Prague', locale: 'cs-CZ', reducedMotion: 'reduce' });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.clock.setFixedTime(NOW);
await p.goto(APP); await p.waitForFunction(() => typeof S !== 'undefined' && S);
await p.evaluate(({ st, theme }) => { st.settings.theme = theme; S = migrate(st); closeSheets(); applyTheme(); currentHabitId = 'h_read'; currentGoalId = 'g_fit'; }, { st: fixtureState(), theme });
for (const v of views.split(',')) {
  const [name, action] = v.split(':');
  await p.evaluate(n => { view = n; render(); window.scrollTo(0, 0); document.getElementById('toasts').replaceChildren(); }, name);
  if (action === 'fab') await p.click('#fabBtn');
  if (action && action.startsWith('ob')) await p.evaluate(n => showOnboarding(n), +(action.slice(2) || 1));
  if (action && action.startsWith('click=')) await p.click(action.slice(6));
  const segs = action && /^\d+$/.test(action) ? +action : 0; // viewport shots down the page
  await p.waitForTimeout(150);
  if (segs) {
    for (let i = 0; i < segs; i++) {
      await p.evaluate(y => window.scrollTo(0, y), i * 800);
      await p.waitForTimeout(80);
      await p.screenshot({ path: `${out}/${name}-${width}-${theme}-${i}.png` });
    }
  } else await p.screenshot({ path: `${out}/${name}${action ? '-' + action.replace(/[^a-z0-9]/gi, '') : ''}-${width}-${theme}.png`, fullPage: !action });
}
await b.close();

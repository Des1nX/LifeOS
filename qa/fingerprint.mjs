// Business-logic fingerprint for LifeOS.html.
//
// Parses the app's single <script> with acorn and hashes every top-level declaration.
//   * LOGIC declarations (data model, migrations, XP/RPG, persistence, domain helpers, boot,
//     event wiring...) are hashed strictly: any change at all is a FAIL.
//   * UI declarations (render*/open*Form and the small DOM builders) are expected to change in a
//     visual redesign. For them we compute two things:
//       - "effects": every state-touching expression inside the function (calls to logic
//         functions, array mutations, assignments other than pure DOM sinks such as .onclick,
//         .textContent or .style.*). HTML template text is ignored, so restyling markup does not
//         move this hash. A change here is a FAIL -- the UI must keep doing exactly the same
//         things to the data.
//         Navigation-only effects (view/filter/current-id state, render(), searchNavigate(), opening
//         another UI form or screen) are tracked separately and only reported for REVIEW.
//       - "shape": the whole function with HTML template text blanked. A change here is only a
//         REVIEW note (e.g. a querySelector string or a new ${} expression changed).
//
// Usage: node fingerprint.mjs --write   (record baseline/fingerprint.json)
//        node fingerprint.mjs --check   (compare against it; exit 1 on FAIL)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as acorn from 'acorn';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.LIFEOS_HTML ? path.resolve(process.env.LIFEOS_HTML) : path.resolve(here, '..', 'LifeOS.html');
const BASELINE = path.join(here, 'baseline', 'fingerprint.json');

const UI_NAMES = new Set([
  'el', 'render', 'progressCard', 'greet', 'taskItem', 'habitItem', 'goalMini', 'macroRow', 'statRow',
  'statCard', 'chartCard', 'svgBarChart', 'svgLineChart', 'showOnboarding', 'toast', 'catOptions',
  'goalOptions', 'savedFoodOptions', 'closeSheets',
]);
const LOGIC_OVERRIDES = new Set(['openDB']); // IndexedDB, not a form
// New Phase 8B presentation helpers must be named ui*/UI_* so they are classified as UI.
const isUiName = n => !LOGIC_OVERRIDES.has(n) && (UI_NAMES.has(n) || /^(render|open|ui)[A-Z]/.test(n) || /^UI_/.test(n));
// Screen-navigation state. Changing where a button leads, or adding a shortcut that opens an
// existing form/screen, is UI; these effects are reported for REVIEW but never FAIL.
const NAV_STATE = new Set(['view', 'taskFilter', 'goalFilter', 'statsPeriod', 'healthTab', 'calOffset', 'noteSearch', 'currentHabitId', 'currentGoalId']);
const NAV_CALLS = new Set(['render', 'searchNavigate']);

// Assigning to these only changes presentation / wires a handler; the handler body itself is
// still walked, so what it does to the data is captured.
const DOM_SINKS = new Set(['onclick', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onsubmit', 'onblur',
  'onfocus', 'textContent', 'innerHTML', 'innerText', 'className', 'hidden', 'disabled', 'src', 'href',
  'download', 'title', 'placeholder', 'scrollTop', 'scrollLeft', 'open', 'selected', 'cssText']);
const MUTATING_METHODS = new Set(['push', 'splice', 'unshift', 'pop', 'shift', 'sort', 'reverse', 'fill', 'copyWithin']);

export function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> found');
  return m[1];
}

const isHtmlTemplate = n => n.type === 'TemplateLiteral' && n.quasis.some(q => /<\/?[a-zA-Z]/.test(q.value.cooked ?? ''));

// Canonical JSON of an AST node without positions/raw text/comments; HTML template text blanked
// when blankHtml is set (non-HTML templates such as `task:${id}:${date}` XP keys stay strict).
function canon(node, blankHtml) {
  const walk = n => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== 'object') return n;
    const out = {};
    const blank = blankHtml && isHtmlTemplate(n);
    for (const k of Object.keys(n).sort()) {
      if (k === 'start' || k === 'end' || k === 'raw' || k === 'loc' || k === 'range') continue;
      if (blank && k === 'quasis') { out[k] = n.quasis.length; continue; }
      out[k] = walk(n[k]);
    }
    return out;
  };
  return JSON.stringify(walk(node));
}
const h = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

function memberRoot(n) { while (n && n.type === 'MemberExpression') n = n.object; return n; }
function propName(m) { return m.computed ? null : m.property.name; }
function isDomSink(lhs) {
  if (lhs.type !== 'MemberExpression') return false;
  const p = propName(lhs);
  if (p && DOM_SINKS.has(p)) return true;
  for (let n = lhs.object; n && n.type === 'MemberExpression'; n = n.object) if (propName(n) === 'style') return true;
  return false;
}

// Names bound inside a function body. `fresh` = bound to a value created right there (object/array
// literal, el(...), createElement...), so mutating it cannot touch app state; other locals may be
// aliases of state records (const h=S.habits.find(...)) and their mutations still count.
function localBindings(fnNode) {
  const all = new Set(), fresh = new Set(), defs = new Map();
  const DOM_INIT = init => init && init.type === 'CallExpression' && ((init.callee.type === 'Identifier' && init.callee.name === 'el')
    || (init.callee.type === 'MemberExpression' && ['createElement', 'querySelector', 'querySelectorAll', 'getElementById'].includes(propName(init.callee))));
  const addDef = (name, node) => { if (node && !DOM_INIT(node)) (defs.get(name) || defs.set(name, []).get(name)).push(node); };
  const isFresh = init => init && (['ArrayExpression', 'ObjectExpression', 'NewExpression', 'TemplateLiteral', 'Literal'].includes(init.type)
    || (init.type === 'CallExpression' && ((init.callee.type === 'Identifier' && init.callee.name === 'el')
      || (init.callee.type === 'MemberExpression' && ['createElement', 'querySelector', 'querySelectorAll', 'getElementById', 'map', 'filter', 'slice', 'concat'].includes(propName(init.callee))))));
  const addPattern = p => { if (!p) return; if (p.type === 'Identifier') all.add(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach(q => addPattern(q.value ?? q.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern); else if (p.type === 'AssignmentPattern') addPattern(p.left); else if (p.type === 'RestElement') addPattern(p.argument); };
  const visit = n => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclarator') { addPattern(n.id); if (n.id.type === 'Identifier') { if (isFresh(n.init)) fresh.add(n.id.name); addDef(n.id.name, n.init); } }
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') addDef(n.left.name, n.right);
    if (/Function/.test(n.type)) n.params.forEach(addPattern);
    for (const k of Object.keys(n)) if (k !== 'type') visit(n[k]);
  };
  if (fnNode.params) fnNode.params.forEach(addPattern);
  visit(fnNode.body ?? fnNode);
  return { all, fresh, defs };
}

const FRESH_METHODS = ['filter', 'map', 'slice', 'concat', 'flat', 'flatMap', 'keys', 'values', 'entries'];
// An expression that evaluates to a brand-new array/object ([...S.x], S.x.filter(...), a?b.slice():c.filter()).
function freshExpr(e) {
  if (e.type === 'ArrayExpression' || e.type === 'ObjectExpression') return true;
  if (e.type === 'ConditionalExpression') return freshExpr(e.consequent) && freshExpr(e.alternate);
  if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression') return FRESH_METHODS.includes(propName(e.callee));
  return false;
}

// Every state-touching expression in a function body. `effectful` = names of top-level logic
// functions that (transitively) touch state; calls to pure helpers (escapeHtml, fmtDate, tr...)
// are presentation and are ignored.
function collectEffects(fnNode, src, effectful) {
  const { all, fresh, defs } = localBindings(fnNode);
  const effects = [];
  // An effect's hash also covers the definitions of the locals it reads (transitively), so
  // `const xp=...?30:10; grantXp(xp,...)` still fails when the 30/10 changes. Locals holding DOM
  // nodes (el(...), querySelector...) are not expanded -- markup is allowed to change.
  const withDeps = n => {
    const seen = new Set(), parts = [canon(n, true)];
    const scan = node => {
      if (Array.isArray(node)) return node.forEach(scan);
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Identifier' && defs.has(node.name) && !seen.has(node.name)) {
        seen.add(node.name);
        for (const d of defs.get(node.name)) { parts.push(node.name + '=' + canon(d, true)); scan(d); }
      }
      for (const k of Object.keys(node)) if (k !== 'type') scan(node[k]);
    };
    scan(n);
    return parts.join('\n');
  };
  const add = (n, why) => effects.push({ why, hash: h(withDeps(n)), src: src.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 140) });
  const touchesState = target => {
    if (target.type === 'Identifier') return !all.has(target.name);
    const root = memberRoot(target);
    if (root && root.type === 'Identifier') return !fresh.has(root.name);
    return !(root && freshExpr(root));
  };
  const visit = n => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'Identifier' && (NAV_CALLS.has(c.name) || (isUiName(c.name) && effectful.has(c.name)))) add(n, 'nav');
      else if (c.type === 'Identifier' && effectful.has(c.name)) add(n, 'call');
      else if (c.type === 'MemberExpression' && MUTATING_METHODS.has(propName(c)) && touchesState(c.object)) add(n, 'mutate');
      else if (c.type === 'MemberExpression' && propName(c) === 'assign' && c.object.name === 'Object' && n.arguments[0] && n.arguments[0].type !== 'ObjectExpression' && touchesState(n.arguments[0])) add(n, 'assign');
    } else if (n.type === 'AssignmentExpression') {
      if (!isDomSink(n.left) && touchesState(n.left)) add(n, n.left.type === 'Identifier' && NAV_STATE.has(n.left.name) ? 'nav' : 'set');
    } else if (n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) {
      if (touchesState(n.argument)) add(n, 'set');
    }
    for (const k of Object.keys(n)) if (k !== 'type') visit(n[k]);
  };
  visit(fnNode.body ?? fnNode);
  return effects;
}

// Fixpoint: a logic function is effectful if its own body has a state effect or it calls an
// effectful function. Seeded with the browser side-effect entry points the app uses.
function effectfulNames(decls, src) {
  // toast/openSheet/closeSheets are pure presentation (a redesign may reword or restyle them);
  // render() stays counted because *when* the screen refreshes after a data change matters.
  const eff = new Set(['render', 'showOnboarding']);
  const PRESENTATION = new Set(['toast', 'openSheet', 'closeSheets', 'el']);
  const fns = decls.filter(d => d.name && d.stmt.type === 'FunctionDeclaration' || (d.stmt.type === 'VariableDeclaration' && d.stmt.declarations.length === 1 && /Function/.test(d.stmt.declarations[0].init?.type || '')));
  const bodyOf = d => d.stmt.type === 'FunctionDeclaration' ? d.stmt : d.stmt.declarations[0].init;
  for (let changed = true; changed;) {
    changed = false;
    for (const d of fns) if (!eff.has(d.name) && !PRESENTATION.has(d.name) && collectEffects(bodyOf(d), src, eff).length) { eff.add(d.name); changed = true; }
  }
  return eff;
}

function declName(stmt) {
  if (stmt.type === 'FunctionDeclaration') return stmt.id.name;
  if (stmt.type === 'VariableDeclaration') return stmt.declarations.map(d => d.id.name || '?').join(',');
  return null;
}

export function fingerprint(html) {
  const src = extractScript(html);
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const decls = ast.body.map((stmt, i) => ({ stmt, name: declName(stmt) }));
  const effectful = effectfulNames(decls, src);
  const logic = {}, ui = {}, statements = [];
  for (const { stmt, name } of decls) {
    if (name && isUiName(name)) {
      const effects = collectEffects(stmt, src, effectful);
      ui[name] = {
        effectsHash: h(effects.filter(e => e.why !== 'nav').map(e => e.why + ':' + e.hash).sort().join('|')),
        navHash: h(effects.filter(e => e.why === 'nav').map(e => e.hash).sort().join('|')),
        shapeHash: h(canon(stmt, true)),
        effects: effects.map(e => `${e.why} ${e.src}  #${e.hash.slice(0, 8)}`),
      };
    } else if (name) {
      logic[name] = h(canon(stmt, false));
    } else {
      // Anonymous top-level statements (event wiring, boot IIFE, PWA setup): compared as a multiset.
      statements.push({ hash: h(canon(stmt, false)), src: src.slice(stmt.start, stmt.end).replace(/\s+/g, ' ').slice(0, 90) });
    }
  }
  statements.sort((a, b) => a.hash.localeCompare(b.hash));
  const logicHash = h(JSON.stringify([logic, statements.map(s => s.hash)]));
  const effectsHash = h(JSON.stringify(Object.entries(ui).map(([k, v]) => [k, v.effectsHash]).sort()));
  return { logicHash, effectsHash, effectful: [...effectful].sort(), logic, statements, ui };
}

function compare(base, cur) {
  const fails = [], reviews = [];
  for (const k of new Set([...Object.keys(base.logic), ...Object.keys(cur.logic)])) {
    if (!(k in cur.logic)) fails.push(`logic removed: ${k}`);
    else if (!(k in base.logic)) fails.push(`logic added: ${k}`);
    else if (base.logic[k] !== cur.logic[k]) fails.push(`logic changed: ${k}`);
  }
  const bs = base.statements.map(s => s.hash), cs = cur.statements.map(s => s.hash);
  base.statements.filter(s => !cs.includes(s.hash)).forEach(s => fails.push(`top-level statement changed/removed: ${s.src}`));
  cur.statements.filter(s => !bs.includes(s.hash)).forEach(s => fails.push(`top-level statement added: ${s.src}`));
  for (const k of new Set([...Object.keys(base.ui), ...Object.keys(cur.ui)])) {
    const b = base.ui[k], c = cur.ui[k];
    if (!c) { fails.push(`UI function removed: ${k}`); continue; }
    if (!b) { reviews.push(`UI function added: ${k} (effects: ${c.effects.length})`); if (c.effects.length) reviews.push(...c.effects.map(e => `    ${e}`)); continue; }
    if (b.effectsHash !== c.effectsHash) {
      const gone = b.effects.filter(e => !c.effects.includes(e)), added = c.effects.filter(e => !b.effects.includes(e));
      fails.push(`UI effects changed in ${k}:` + gone.map(e => `\n    - ${e}`).join('') + added.map(e => `\n    + ${e}`).join(''));
    } else if (b.navHash !== c.navHash) {
      const nb = b.effects.filter(e => e.startsWith('nav ')), nc = c.effects.filter(e => e.startsWith('nav '));
      reviews.push(`UI navigation changed (data effects identical): ${k}` + nb.filter(e => !nc.includes(e)).map(e => `\n    - ${e}`).join('') + nc.filter(e => !nb.includes(e)).map(e => `\n    + ${e}`).join(''));
    } else if (b.shapeHash !== c.shapeHash) reviews.push(`UI structure changed (effects identical): ${k}`);
  }
  return { fails, reviews };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fp = fingerprint(readFileSync(APP, 'utf8'));
  const summary = `logic declarations: ${Object.keys(fp.logic).length}, top-level statements: ${fp.statements.length}, UI functions: ${Object.keys(fp.ui).length}`;
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE, JSON.stringify(fp, null, 1) + '\n');
    console.log(`baseline written -> ${path.relative(process.cwd(), BASELINE)}\n${summary}\nlogicHash=${fp.logicHash} effectsHash=${fp.effectsHash}`);
  } else {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const { fails, reviews } = compare(base, fp);
    console.log(summary);
    console.log(`logicHash   ${base.logicHash} -> ${fp.logicHash} ${base.logicHash === fp.logicHash ? 'OK' : 'CHANGED'}`);
    console.log(`effectsHash ${base.effectsHash} -> ${fp.effectsHash} ${base.effectsHash === fp.effectsHash ? 'OK' : 'CHANGED'}`);
    if (reviews.length) console.log('\nREVIEW (allowed for a redesign, check intent):\n  ' + reviews.join('\n  '));
    if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
    console.log('\nFINGERPRINT OK');
  }
}

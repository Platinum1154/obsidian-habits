import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// A minimal Obsidian surface lets us exercise the actual render/write code
// without a running desktop vault. Stats and date utilities remain real.
const result = await build({
  stdin: { contents: 'export { HabitsCompact } from "./src/ui/habits-compact"; export { HabitsBlock } from "./src/ui/habits-block";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'obsidian-test-surface', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export class Component {
        children = []; cleanups = [];
        addChild(c) { this.children.push(c); c.onload?.(); return c; }
        removeChild(c) { c.unload(); this.children = this.children.filter(x => x !== c); }
        registerDomEvent(el, type, fn) { el.handlers[type] = fn; this.cleanups.push(() => delete el.handlers[type]); }
        registerEvent() {}
        unload() { this.onunload?.(); this.children.forEach(c => c.unload()); this.cleanups.forEach(f => f()); }
      }
      export class MarkdownRenderChild extends Component { constructor(root) { super(); this.containerEl = root; } }
      export class App {} export class TFile {} export class Notice { constructor(message) { globalThis.lastNotice = message; } }
      export const debounce = fn => fn;
      export const normalizePath = s => s;
      export const setIcon = (el, icon) => { el.icon = icon; };
      export const setTooltip = () => {};
      export const moment = {};
    ` }));
    build.onLoad({ filter: /i18n\/index\.ts$/ }, () => ({ contents: 'export const t = (s, vars = {}) => s.replace(/\\{(.*?)\\}/g, (_, k) => vars[k]);' }));
    build.onLoad({ filter: /ui\/habit-modal\.ts$/ }, () => ({ contents: 'export class HabitModal { open() {} }' }));
    build.onLoad({ filter: /ui\/dashboard\.ts$/ }, () => ({ contents: 'import { MarkdownRenderChild } from "obsidian"; export class HabitsDashboard extends MarkdownRenderChild { constructor(a, s, g, e, p, root) { super(root); } onload() { this.containerEl.createSpan({ text: "Card dashboard" }); } }' }));
    build.onLoad({ filter: /ui\/icon-suggest-modal\.ts$/ }, () => ({ contents: 'export const applyHabitIcon = (el, icon) => { el.icon = icon; };' }));
    build.onLoad({ filter: /ui\/stats-view\.ts$/ }, () => ({ contents: 'export const renderStatsView = () => {};' }));
    build.onLoad({ filter: /\/note-habit\.ts$/ }, () => ({ contents: 'export const notePathForDate = (h, k) => `${h.noteFolder}/${k}.md`; export const createNoteHabitEntry = async () => null;' }));
  } }],
});
const { HabitsCompact, HabitsBlock } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
class Element {
  children = []; handlers = {}; attrs = {}; classes = new Set();
  constructor(tag = 'div', options = {}) { this.tag = tag; this.text = options.text ?? ''; this.attrs = options.attr ?? {}; this.className = options.cls ?? ''; }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  addClass(cls) { this.classes.add(cls); }
  toggleClass(cls, active) { if (active) this.classes.add(cls); else this.classes.delete(cls); }
  setCssProps() {} setAttribute(key, value) { this.attrs[key] = value; }
  empty() { this.children = []; }
  all() { return [this, ...this.children.flatMap(el => el.all())]; }
}
function fixture(overrides = {}, write = async () => {}) {
  const habit = { path: 'Habits/Test.md', name: 'Test', type: 'repetition', frequency: 'daily', target: 5, unit: 'cups', goalDirection: 'min', startDate: '2020-01-01', records: {}, pauses: [], reschedules: [], times: [], group: '', ...overrides };
  const events = {};
  const app = { metadataCache: { on: (name, fn) => { events[name] = fn; } }, vault: { on() {}, getAbstractFileByPath() {} }, workspace: { openLinkText() {} } };
  const store = { getHabits: () => [structuredClone(habit)], setRecord: write };
  const settings = { habitsFolder: 'Habits', sortMode: 'name', manualOrder: [], groups: {}, groupOrder: [], experimental: {} };
  const root = new Element();
  const view = new HabitsCompact(app, store, () => settings, { on() {} }, 'Dashboard.md', root);
  view.selectedDate = new Date(2026, 9, 12); view.onload();
  const button = label => root.all().find(el => el.attrs['aria-label'] === label);
  const text = () => root.all().map(el => el.text).join('');
  return { view, root, habit, events, button, text };
}

test('successful writes bridge stale metadata, then accept external changes', async () => {
  const writes = [];
  const f = fixture({}, async (...args) => writes.push(args));
  f.button('Increase by 1').handlers.click();
  await new Promise(setImmediate);
  assert.match(f.text(), /1 \/ 5 cups/);
  f.button('Increase by 1').handlers.click();
  await new Promise(setImmediate);
  assert.equal(writes[1][2], 2);
  f.habit.records['2026-10-12'] = 4;
  f.events.changed({ path: f.habit.path });
  assert.match(f.text(), /4 \/ 5 cups/);
});

test('double clicks are serialized and changing dates cannot redirect a write', async () => {
  let release; const writes = [];
  const f = fixture({}, (...args) => { writes.push(args); return new Promise(r => { release = r; }); });
  const click = f.button('Increase by 1').handlers.click; click(); click();
  assert.equal(writes.length, 1);
  assert.equal(f.button('Increase by 1').disabled, true);
  f.button('Next day').handlers.click(); release();
  await new Promise(setImmediate);
  assert.equal(writes[0][1], '2026-10-12');
  assert.match(f.text(), /0 \/ 5 cups/);
  f.button('Previous day').handlers.click();
  assert.match(f.text(), /1 \/ 5 cups/);
});

test('failed saves preserve the count and restore controls', async () => {
  const f = fixture({}, async () => { throw new Error('disk full'); });
  f.button('Increase by 1').handlers.click(); await new Promise(setImmediate);
  assert.match(f.text(), /0 \/ 5 cups/);
  assert.equal(f.button('Increase by 1').disabled, false);
  assert.equal(globalThis.lastNotice, 'Could not save habit record.');
});

test('flexible totals span the week while steppers write only the selected day', async () => {
  const writes = [];
  const f = fixture({ frequency: 'flexibleWeekly', records: { '2026-10-12': 2, '2026-10-13': 1 } }, async (...args) => writes.push(args));
  f.button('Next day').handlers.click();
  assert.match(f.text(), /3 \/ 5 cups This week/);
  f.button('Increase by 1').handlers.click(); await new Promise(setImmediate);
  assert.equal(writes[0][2], 2);
  assert.match(f.text(), /4 \/ 5 cups This week/);
});

test('binary limits, paused habits, timed steps and listener cleanup', () => {
  const limit = fixture({ type: 'binary', goalDirection: 'max', target: 0 });
  assert.ok(limit.button('Mark as slipped'));
  const paused = fixture({ pauses: [{ start: '2026-10-01', end: '' }] });
  assert.match(paused.text(), /Paused/); assert.equal(paused.button('Increase by 1'), undefined);
  const timed = fixture({ type: 'timed' }); assert.ok(timed.button('Increase by 5')); assert.ok(timed.button('Decrease by 5'));
  const old = timed.button('Increase by 5'); timed.button('Next day').handlers.click();
  assert.equal(old.handlers.click, undefined);
  timed.view.unload(); assert.equal(timed.button('Increase by 5').handlers.click, undefined);
});

test('existing habits block switches layouts immediately and unloads old controls', () => {
  const root = new Element();
  const settings = { dashboardLayout: 'carousel', habitsFolder: 'Habits', sortMode: 'name', manualOrder: [], groups: {}, groupOrder: [], experimental: {} };
  const listeners = [];
  const events = { on: (_, fn) => { listeners.push(fn); } };
  const app = { metadataCache: { on() {} }, vault: { on() {} } };
  const block = new HabitsBlock(app, { getHabits: () => [] }, () => settings, events, 'Dashboard.md', root);
  block.onload();
  assert.ok(root.all().some(el => el.text === 'Card dashboard'));
  settings.dashboardLayout = 'compact'; listeners[0]();
  assert.ok(root.all().some(el => el.className === 'habits-compact-header'));
  assert.equal(root.all().some(el => el.text === 'Card dashboard'), false);
  const plus = root.all().find(el => el.attrs['aria-label'] === 'Add habit');
  settings.dashboardLayout = 'grid'; listeners[0]();
  assert.equal(plus.handlers.click, undefined);
  assert.ok(root.all().some(el => el.text === 'Card dashboard'));
  assert.equal(block.children.length, 1);
});

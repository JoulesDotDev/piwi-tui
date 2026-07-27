import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';

const root = resolve(import.meta.dir, '..');
type Renderer = (entry: { data?: unknown }, options: { expanded: boolean }, theme: typeof theme) => { render(width: number): string[] } | undefined;
type MessageRenderer = (message: { details?: unknown }, options: { expanded: boolean }, theme: typeof theme) => { render(width: number): string[] } | undefined;
type Command = { getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }> | null; handler?: (...args: any[]) => Promise<void> | void };

// Styled output is intentional: visibleWidth must remain correct with ANSI and Unicode.
const esc = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const theme = {
  fg: (_color: string, text: string) => esc(36, text),
  bg: (_color: string, text: string) => esc(44, text),
  bold: (text: string) => esc(1, text),
};
const entryRenderers = new Map<string, Renderer>();
const messageRenderers = new Map<string, MessageRenderer>();
const commands = new Map<string, Command>();
let latestWidget: { render(width: number): string[] } | undefined;
const fakeUi = {
  setWidget(_key: string, value: unknown) {
    latestWidget = typeof value === 'function' ? (value as (tui: unknown, theme: typeof theme) => { render(width: number): string[] })({}, theme) : undefined;
  },
  notify() {},
};
const api = {
  registerTool() {},
  registerCommand(name: string, command: Command) { commands.set(name, command); },
  registerEntryRenderer(name: string, renderer: Renderer) { entryRenderers.set(name, renderer); },
  registerMessageRenderer(name: string, renderer: MessageRenderer) { messageRenderers.set(name, renderer); },
  on() {},
  appendEntry() {},
};

for (const file of readdirSync(join(root, 'extensions')).filter((name) => name.endsWith('.ts'))) {
  const extension = (await import(join(root, 'extensions', file))).default;
  extension(api);
}

// Two columns is the smallest meaningful width for wide Unicode glyphs.
const widths = [2, 10, 20, 29, 30, 38, 68, 80, 120];
function assertWidth(name: string, component: { render(width: number): string[] }): void {
  for (const width of widths) {
    for (const line of component.render(width)) {
      if (visibleWidth(line) > width) throw new Error(`${name} overflowed ${width} columns: ${JSON.stringify(line)}`);
    }
  }
}
function renderEntry(name: string, data: unknown): void {
  const renderer = entryRenderers.get(name);
  if (!renderer) throw new Error(`Missing entry renderer: ${name}`);
  const component = renderer({ data }, { expanded: true }, theme);
  if (!component) throw new Error(`${name} returned no component`);
  assertWidth(name, component);
}

const hostile = 'A very long task 名称 with emoji ✨ and bidi \u202e12345 plus \x1b[31mANSI\x1b[0m metadata';
renderEntry('doctor-view', { title: 'doctor', rows: [{ text: hostile, tone: 'accent', bold: true }, { text: '✓ Tools ready · bun', tone: 'success' }, { text: 'Read-only · no scripts run', tone: 'dim' }] });
renderEntry('locks-view', { rows: [{ text: 'Lock check', tone: 'accent', bold: true }, { text: `⚠ ${hostile}`, tone: 'warning' }, { text: 'Nothing was changed.', tone: 'muted' }] });
renderEntry('memory-view', { scope: 'all', cwd: join(root, '.pi', 'render-test-missing') });
renderEntry('todo-view', { title: hostile, items: [{ text: hostile, done: false }, { text: hostile, done: true }] });
renderEntry('agenda-view', { kind: 'tasks', lines: [{ text: hostile, color: 'warning', bold: true }, { text: `  ○ ${hostile} ·abc123`, color: 'text' }] });
renderEntry('plan-view', { lines: [{ text: hostile, color: 'accent', bold: true }, { text: `  ✓ ${hostile}`, color: 'dim' }] });

const agents = messageRenderers.get('sub-agent-results');
if (!agents) throw new Error('Missing sub-agent message renderer');
for (const details of [{ doing: hostile, remaining: 2, failed: false }, { doing: hostile, failed: true }, { ok: 1, total: 2 }]) {
  const component = agents({ details }, { expanded: true }, theme);
  if (!component) throw new Error('sub-agent result returned no component');
  assertWidth('sub-agent-results', component);
}
renderEntry('btw-aside', { kind: 'question', question: hostile });
renderEntry('btw-aside', { kind: 'answer', question: hostile, answer: hostile });
renderEntry('btw-aside', { kind: 'error', question: hostile, answer: hostile });
renderEntry('process-event', { title: hostile, tone: 'accent', lines: [hostile, hostile] });

// Exercise the responsive Pomodoro widget through its public command path.
await commands.get('pomodoro')?.handler?.('1 0', { ui: fakeUi });
if (!latestWidget) throw new Error('Pomodoro did not create its live widget');
assertWidth('pomodoro-widget', latestWidget);
await commands.get('pomodoro')?.handler?.('stop', { ui: fakeUi });

const expectedCompletions: Record<string, string[]> = {
  pet: ['help', 'profile', 'care', 'shop', 'collection', 'achievements', 'journal', 'evolution', 'adventure', 'encounter', 'settings', 'status', 'name', 'show', 'hide'],
  guard: ['on', 'off', 'status'],
  memory: ['project', 'global'],
  pomodoro: ['25 5', '50 10', '25 0', 'stop'],
  agents: ['stop'],
  tasks: ['overdue', 'today', 'upcoming', 'someday', 'done'],
};
for (const [name, expected] of Object.entries(expectedCompletions)) {
  const completion = commands.get(name)?.getArgumentCompletions;
  if (!completion) throw new Error(`Missing completion provider: /${name}`);
  const values = completion('').map((item) => item.value);
  for (const value of expected) if (!values.includes(value)) throw new Error(`/${name} is missing completion ${value}`);
  if (completion('zz') !== null) throw new Error(`/${name} should return null for no match`);
}

console.log(`tui render check passed: ${entryRenderers.size} entry renderers, ${messageRenderers.size} message renderers, ${Object.keys(expectedCompletions).length} completion sets`);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';

const root = resolve(import.meta.dir, '..');
const project = mkdtempSync(join(tmpdir(), 'piwi-interactive-'));
const agent = join(project, 'agent');
process.env.PI_CODING_AGENT_DIR = agent;
const expect = (label: string, value: unknown): void => { if (!value) throw new Error(`Interactive command regression failed: ${label}`); };

mkdirSync(join(project, '.pi', 'agenda'), { recursive: true });
mkdirSync(join(project, '.pi', 'plans'), { recursive: true });
mkdirSync(join(project, '.pi', 'wiki'), { recursive: true });
mkdirSync(join(project, '.pi', 'skills', 'demo-skill'), { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(join(project, '.pi', 'TODO.md'), '# Demo todo\n\n- [ ] First step\n- [x] Finished step\n');
writeFileSync(join(project, '.pi', 'agenda', 'tasks.json'), JSON.stringify([{ id: 'task1', text: 'Demo task', done: false, created: '2026-01-01' }]));
writeFileSync(join(project, '.pi', 'agenda', 'boards.json'), JSON.stringify([{ name: 'Demo', columns: [{ name: 'Todo', cards: [{ id: 'card1', text: 'Demo card' }] }, { name: 'Done', cards: [] }] }]));
writeFileSync(join(project, '.pi', 'plans', 'demo.md'), '# Demo plan\n\n- [ ] First plan step\n- [x] Finished plan step\n');
writeFileSync(join(project, '.pi', 'wiki', 'demo.md'), '# Demo page\n\nWiki body.\n');
writeFileSync(join(project, '.pi', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill\n---\n\nInstructions.\n');
writeFileSync(join(project, '.pi', 'MEMORY.md'), '# Memory — this project\n\n- Demo memory fact.\n');
writeFileSync(join(agent, 'counters.json'), JSON.stringify({ version: 1, counters: [{ id: 'demo', name: 'Demo', value: 3, pinned: false, createdAt: 1, updatedAt: 1 }] }));

const commands = new Map<string, any>();
const tools = new Map<string, any>();
const hooks = new Map<string, Function[]>();
const api = {
  registerCommand(name: string, command: any) { commands.set(name, command); },
  registerTool(tool: any) { tools.set(tool.name, tool); }, registerEntryRenderer() {}, registerMessageRenderer() {}, appendEntry() {},
  on(name: string, handler: Function) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
} as any;
const files = ['counters', 'todo', 'tasks', 'plan', 'processes', 'memory', 'skills', 'wiki', 'pet'];
for (const file of files) (await import(`../extensions/${file}.ts?interactive=${Date.now()}-${file}`)).default(api);

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};
const captures: Array<{ command: string; lines: string[]; overlay: boolean }> = [];
let currentCommand = '';
let scriptedKeys: string[] = [];
let scriptedInputs: Array<string | undefined> = [];
let scriptedSelects: Array<string | undefined> = [];
const lifecycleEvents: string[] = [];
const ui = {
  notify() {}, setWidget() {},
  confirm: async () => { lifecycleEvents.push('confirm'); return false; },
  input: async () => { lifecycleEvents.push('input'); return scriptedInputs.shift(); },
  select: async (_title: string, values: string[]) => { lifecycleEvents.push('select'); return scriptedSelects.length ? scriptedSelects.shift() : values[0]; },
  custom: async (factory: Function, options?: { overlay?: boolean }) => new Promise<unknown>((resolvePromise, rejectPromise) => {
    lifecycleEvents.push('custom:start');
    let resolved = false;
    const done = (value?: unknown) => { if (!resolved) { resolved = true; lifecycleEvents.push(`done:${typeof value === 'string' ? value : (value as { kind?: string } | undefined)?.kind ?? 'none'}`); resolvePromise(value); } };
    const tui = { requestRender() {} };
    const component = factory(tui, theme, {}, done);
    const lines = component.render(32);
    captures.push({ command: currentCommand, lines, overlay: options?.overlay === true });
    expect(`${currentCommand} width`, lines.every((line: string) => visibleWidth(line) <= 32));
    component.handleInput?.(scriptedKeys.shift() ?? '\x1b');
    if (!resolved) rejectPromise(new Error(`${currentCommand} did not close for the scripted action`));
  }),
};
const ctx = { cwd: project, mode: 'tui', hasUI: true, isProjectTrusted: () => true, ui } as any;

try {
  for (const handler of hooks.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
  await tools.get('process').execute('test-start', { action: 'start', name: 'focus-test', command: 'sleep 30' }, undefined, undefined, ctx);
  const invocations: Array<[string, string]> = [
    ['counter', ''], ['todo', ''], ['tasks', ''], ['board', 'Demo'], ['plan', 'demo'], ['processes', ''], ['memory', 'project'], ['skills', 'project'], ['wiki', ''],
  ];
  for (const [name, args] of invocations) {
    currentCommand = name;
    const command = commands.get(name);
    expect(`/${name} registered`, command);
    await command.handler(args, ctx);
  }
  for (const [name] of invocations) {
    const capture = captures.find((item) => item.command === name);
    expect(`/${name} opened interactive view`, capture);
    expect(`/${name} stays inline`, !capture!.overlay);
    const plain = capture!.lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(`/${name} shows navigation`, plain.includes('↑↓') || name === 'processes');
    expect(`/${name} shows close key`, plain.includes('esc close') || plain.includes('esc back'));
    if (name === 'todo') {
      expect('/todo uses generic heading', plain.includes('Todo · 1/2'));
      expect('/todo omits checklist icon and custom title', !plain.includes('☑') && !plain.includes('Demo todo'));
    }
  }

  currentCommand = 'counter';
  scriptedKeys = ['n', '\x1b']; scriptedInputs = ['Inline counter']; lifecycleEvents.length = 0;
  const counterCaptureCount = captures.length;
  await commands.get('counter').handler('', ctx);
  expect('counter closes before prompting and reopens inline', captures.length === counterCaptureCount + 2 && lifecycleEvents.indexOf('done:create') < lifecycleEvents.indexOf('input'));
  expect('counter reopen remains non-overlay', captures.slice(counterCaptureCount).every((capture) => !capture.overlay));

  currentCommand = 'todo';
  scriptedKeys = ['n', '\x1b']; scriptedInputs = ['Inline todo step']; lifecycleEvents.length = 0;
  const todoCaptureCount = captures.length;
  await commands.get('todo').handler('', ctx);
  expect('todo closes before prompting and reopens inline', captures.length === todoCaptureCount + 2 && lifecycleEvents.indexOf('done:add') < lifecycleEvents.indexOf('input'));
  expect('todo reopen remains non-overlay', captures.slice(todoCaptureCount).every((capture) => !capture.overlay));

  const inlineCycle = async (name: string, args: string, keys: string[], inputs: Array<string | undefined>, actionKind: string, nestedEvent: string, customCount: number): Promise<void> => {
    currentCommand = name; scriptedKeys = keys; scriptedInputs = inputs; lifecycleEvents.length = 0;
    const before = captures.length;
    await commands.get(name).handler(args, ctx);
    const doneIndex = lifecycleEvents.indexOf(`done:${actionKind}`);
    const nestedIndex = lifecycleEvents.indexOf(nestedEvent, doneIndex + 1);
    expect(`${name} action closes before ${nestedEvent}`, doneIndex >= 0 && nestedIndex > doneIndex);
    expect(`${name} reopens inline`, captures.length === before + customCount && captures.slice(before).every((capture) => !capture.overlay));
  };
  await inlineCycle('counter', '', ['r', '\x1b'], [], 'reset', 'confirm', 2);
  await inlineCycle('todo', '', ['c', '\x1b'], [], 'clear', 'confirm', 2);
  await inlineCycle('tasks', '', ['n', '\x1b'], ['New task', ''], 'create', 'input', 2);
  await inlineCycle('tasks', '', ['d', '\x1b'], [], 'delete', 'confirm', 2);
  await inlineCycle('board', 'Demo', ['n', '\x1b'], ['New card'], 'create', 'input', 2);
  await inlineCycle('board', 'Demo', ['\r', '\x1b'], [], 'move', 'select', 2);
  await inlineCycle('memory', 'project', ['d', '\x1b'], [], 'forget', 'confirm', 2);
  await inlineCycle('processes', '', ['i', '\x1b'], ['hello'], 'input', 'input', 2);
  await inlineCycle('processes', '', ['\r', '\x1b', '\x1b'], [], 'logs', 'custom:start', 3);
  await inlineCycle('processes', '', ['s', '\x1b'], [], 'stop', 'confirm', 2);
  await inlineCycle('skills', 'project', ['/', '\x1b'], ['demo'], 'filter', 'input', 2);
  await inlineCycle('wiki', '', ['/', '\x1b'], ['demo'], 'filter', 'input', 2);
  await inlineCycle('skills', 'project', ['\r', '\x1b', '\x1b'], [], 'open', 'custom:start', 3);
  await inlineCycle('wiki', '', ['\r', '\x1b', '\x1b'], [], 'open', 'custom:start', 3);

  currentCommand = 'plan'; scriptedKeys = ['\r', '\x1b']; lifecycleEvents.length = 0;
  const planCaptureCount = captures.length;
  await commands.get('plan').handler('demo', ctx);
  expect('plan mutation closes and reopens inline', lifecycleEvents.includes('done:toggle') && captures.length === planCaptureCount + 2 && captures.slice(planCaptureCount).every((capture) => !capture.overlay));

  currentCommand = 'pet'; scriptedKeys = ['\r', '\x1b']; scriptedInputs = ['Piwi']; scriptedSelects = ['Never mind']; lifecycleEvents.length = 0;
  const petCaptureCount = captures.length;
  await commands.get('pet').handler('', ctx);
  const petDone = lifecycleEvents.indexOf('done:care');
  expect('pet closes before opening its menu', petDone >= 0 && lifecycleEvents.indexOf('select', petDone + 1) > petDone);
  expect('pet reopens inline', captures.length === petCaptureCount + 2 && captures.slice(petCaptureCount).every((capture) => !capture.overlay));

  console.log('counter, todo, agenda, plan, process, memory, skill, and wiki inline command regressions passed');
} finally {
  for (const handler of hooks.get('session_shutdown') ?? []) await handler({}, ctx);
  rmSync(project, { recursive: true, force: true });
}

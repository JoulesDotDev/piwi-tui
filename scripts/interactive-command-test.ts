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
const hooks = new Map<string, Function[]>();
const api = {
  registerCommand(name: string, command: any) { commands.set(name, command); },
  registerTool() {}, registerEntryRenderer() {}, registerMessageRenderer() {}, appendEntry() {},
  on(name: string, handler: Function) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
} as any;
const files = ['counters', 'todo', 'tasks', 'plan', 'processes', 'memory', 'skills', 'wiki'];
for (const file of files) (await import(`../extensions/${file}.ts?interactive=${Date.now()}-${file}`)).default(api);

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};
const captures: Array<{ command: string; lines: string[] }> = [];
let currentCommand = '';
const ui = {
  notify() {}, setWidget() {},
  confirm: async () => false,
  input: async () => undefined,
  select: async (_title: string, values: string[]) => values[0],
  custom: async (factory: Function) => new Promise<void>((resolvePromise) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolvePromise(); } };
    const tui = { requestRender() {} };
    const component = factory(tui, theme, {}, done);
    const lines = component.render(32);
    captures.push({ command: currentCommand, lines });
    expect(`${currentCommand} width`, lines.every((line: string) => visibleWidth(line) <= 32));
    component.handleInput?.('\x1b');
    if (!resolved) done();
  }),
};
const ctx = { cwd: project, mode: 'tui', hasUI: true, isProjectTrusted: () => true, ui } as any;

try {
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
    const plain = capture!.lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(`/${name} shows navigation`, plain.includes('↑↓') || name === 'processes');
    expect(`/${name} shows close key`, plain.includes('esc close') || plain.includes('esc back'));
  }
  console.log('counter, todo, agenda, plan, process, memory, skill, and wiki interactive command regressions passed');
} finally {
  for (const handler of hooks.get('session_shutdown') ?? []) await handler({}, ctx);
  rmSync(project, { recursive: true, force: true });
}

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import todoExtension from '../extensions/todo.ts';

const expect = (label: string, value: unknown): void => { if (!value) throw new Error(`Todo regression failed: ${label}`); };
const cwd = mkdtempSync(join(tmpdir(), 'piwi-todo-'));
const file = join(cwd, '.pi', 'TODO.md');
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const entries: Array<{ type: string; data: any }> = [];
const pi = {
  registerTool(tool: any) { tools.set(tool.name, tool); },
  registerCommand(name: string, command: any) { commands.set(name, command); },
  registerEntryRenderer() {},
  appendEntry(type: string, data: any) { entries.push({ type, data }); },
} as any;
todoExtension(pi);
const tool = tools.get('todo');
const command = commands.get('todo');
expect('tool and command registered', tool && command);
let approve = true;
const notices: string[] = [];
const ctx = {
  cwd,
  hasUI: true,
  isProjectTrusted: () => true,
  ui: {
    confirm: async () => approve,
    notify: (message: string) => notices.push(message),
  },
} as any;

try {
  await tool.execute('write', { action: 'write', title: 'Retained work', steps: ['First', 'Second'] }, undefined, undefined, ctx);
  await tool.execute('one', { action: 'step', step: 1 }, undefined, undefined, ctx);
  const completed = await tool.execute('two', { action: 'step', step: 2 }, undefined, undefined, ctx);
  expect('completed todo remains on disk', existsSync(file));
  expect('both steps retained complete', (readFileSync(file, 'utf8').match(/- \[x\]/g) ?? []).length === 2);
  expect('completion explains explicit clear', completed.content[0].text.includes('retained for review') && completed.details.completed && !completed.details.cleared);

  approve = false;
  const cancelled = await tool.execute('clear-no', { action: 'clear' }, undefined, undefined, ctx);
  expect('rejected tool clear retains file', existsSync(file) && cancelled.details.cleared === false);
  await command.handler('clear', ctx);
  expect('rejected command clear retains file', existsSync(file));

  approve = true;
  await command.handler('clear', ctx);
  expect('approved command clear removes file', !existsSync(file));
  expect('clear appends local empty view', entries.some((entry) => entry.type === 'todo-view' && entry.data.empty));
  expect('clear completion advertised', command.getArgumentCompletions('').some((item: any) => item.value === 'clear'));
  expect('unknown command rejected locally', (await command.handler('wat', ctx), notices.some((message) => message.includes('/todo clear'))));

  console.log('todo retention and explicit-clear regressions passed');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

/*
 * todo — one lightweight active work checklist per project.
 *
 * Use for quick multi-part execution that does not need plan approval. One `todo`
 * tool writes, updates, reads, or clears <cwd>/.pi/TODO.md. Completing the final
 * item returns the finished checklist, then removes the file automatically.
 * `/todo` renders the current list locally without adding it to model context.
 */
import { CONFIG_DIR_NAME, defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Box, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

interface TodoItem { text: string; done: boolean }
interface TodoList { title: string; items: TodoItem[] }
interface TodoView { title: string; items: TodoItem[]; empty?: boolean }

class TodoToolCard {
  constructor(private readonly title: string, private readonly lines: string[], private readonly theme: { fg(c: string, s: string): string; bg(c: string, s: string): string; bold(s: string): string }) {}
  render(width: number): string[] {
    const box = new Box(1, 1, (content) => this.theme.bg('customMessageBg', content));
    box.addChild(new Text([this.theme.fg('accent', this.theme.bold(`☑ Todo · ${this.title}`)), ...this.lines.map((line) => this.theme.fg('text', line))].join('\n'), 0, 0));
    return box.render(width);
  }
  invalidate(): void {}
}
const fileFor = (cwd: string): string => join(cwd, CONFIG_DIR_NAME, 'TODO.md');
function canonical(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = realpathSync(existing);
  return existing === abs ? real : join(real, relative(existing, abs));
}
function safeFile(cwd: string): string {
  const file = fileFor(cwd);
  const rel = relative(canonical(cwd), canonical(file));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing a TODO path that escapes through a symlink.');
  return file;
}
const clean = (text: string, max = 240): string => Array.from(
  text.normalize('NFKC')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
).slice(0, max).join('');

function readTodo(file: string): TodoList | undefined {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const lines = raw.split('\n');
  const title = clean(lines.find((line) => line.startsWith('# '))?.slice(2) ?? 'Quick work', 80) || 'Quick work';
  const items = lines.flatMap((line): TodoItem[] => {
    const match = line.match(/^- \[([ xX])\] (.+)$/);
    if (!match) return [];
    const text = clean(match[2]);
    return text ? [{ text, done: match[1].toLowerCase() === 'x' }] : [];
  });
  return items.length ? { title, items } : undefined;
}

function encode(todo: TodoList): string {
  return `# ${todo.title}\n\n${todo.items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')}\n`;
}

function atomicWrite(file: string, todo: TodoList): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, encode(todo), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function locked<T>(file: string, action: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random()}`;
  mkdirSync(dirname(file), { recursive: true });
  const candidate = `${lock}.${process.pid}.${Date.now()}.${Math.random()}.candidate`;
  writeFileSync(candidate, ownerToken, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { linkSync(candidate, lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await sleep(20 + Math.floor(Math.random() * 10));
    }
  }
  rmSync(candidate, { force: true });
  if (!acquired) throw new Error('Another Pi session is saving the quick checklist. Try again in a moment; if it persists after a crash, run /locks.');
  try { return action(); }
  finally { try { if (readFileSync(lock, 'utf8') === ownerToken) rmSync(lock, { force: true }); } catch { /* recovered elsewhere */ } }
}

function format(todo: TodoList | undefined): string {
  if (!todo) return 'No active project todo.';
  return `${todo.title}\n${todo.items.map((item, index) => `${item.done ? '✓' : '○'} ${index + 1}. ${item.text}`).join('\n')}`;
}

export default function todoExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'todo',
      label: 'Todo',
      renderShell: 'self',
      renderCall: (args, theme) => new TodoToolCard(args.action === 'step' ? `updating step ${args.step ?? '?'}` : args.action, [args.title ?? (args.steps?.length ? `${args.steps.length} checklist steps` : 'Current checklist')], theme),
      renderResult: (result, _options, theme, context) => {
        const d = result.details as { todo?: TodoList; cleared?: boolean; completed?: boolean } | undefined;
        const todo = d?.todo;
        const done = todo?.items.filter((item) => item.done).length ?? 0;
        const title = d?.completed ? 'complete' : d?.cleared ? 'cleared' : todo ? 'updated' : 'status';
        return new TodoToolCard(context.isError ? 'unavailable' : title, todo ? [todo.title, `${done}/${todo.items.length} complete`] : ['No active checklist'], theme);
      },
      description:
        'Manage the ONE disposable current-work checklist: immediate execution steps for this active run. ' +
        'write replaces it; step updates an item; completion auto-deletes .pi/TODO.md. Never use todo for ' +
        'backlog, reminders, deadlines, or future work—use task_* for those. Use plan for substantial ' +
        'approved work. Requires a trusted project.',
      promptSnippet: 'Track a short project checklist that auto-clears',
      promptGuidelines: [
        'Use todo only for the current run’s immediate multi-step execution checklist. Do not use it as a durable reminder, backlog, deadline, or future-work tracker; use task_* for those. Keep it current and let it auto-clear when complete.',
      ],
      parameters: Type.Object({
        action: StringEnum(['write', 'step', 'read', 'clear'] as const, { description: 'write replaces the checklist; step updates one item; read returns it; clear deletes it.' }),
        title: Type.Optional(Type.String({ maxLength: 80, description: 'Checklist title for write; defaults to Quick work.' })),
        steps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 50, description: 'One to 50 checklist items required for write.' })),
        step: Type.Optional(Type.Integer({ minimum: 1, description: 'Required for step; 1-based item number.' })),
        done: Type.Optional(Type.Boolean({ description: 'State for step; defaults to true.' })),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        if (!ctx.isProjectTrusted()) throw new Error('Project must be trusted before accessing its todo.');
        const file = safeFile(ctx.cwd);
        if (params.action === 'read') {
          const todo = readTodo(file);
          return { content: [{ type: 'text', text: format(todo) }], details: { todo } };
        }
        return locked(file, () => {
          if (params.action === 'clear') {
            rmSync(file, { force: true });
            return { content: [{ type: 'text' as const, text: 'Project todo cleared.' }], details: { cleared: true } };
          }
          if (params.action === 'write') {
            const items = (params.steps ?? []).map((text) => clean(text)).filter(Boolean);
            if (!items.length) throw new Error('Provide at least one non-empty step.');
            const todo: TodoList = {
              title: clean(params.title ?? 'Quick work', 80) || 'Quick work',
              items: items.map((text) => ({ text, done: false })),
            };
            atomicWrite(file, todo);
            return { content: [{ type: 'text' as const, text: `Todo created:\n${format(todo)}` }], details: { todo } };
          }
          const todo = readTodo(file);
          if (!todo) throw new Error('No active project todo.');
          const index = (params.step ?? 0) - 1;
          if (index < 0 || index >= todo.items.length) throw new Error(`Step must be 1-${todo.items.length}.`);
          todo.items[index].done = params.done ?? true;
          if (todo.items.every((item) => item.done)) {
            rmSync(file, { force: true });
            return {
              content: [{ type: 'text' as const, text: `Todo complete and auto-cleared:\n${format(todo)}` }],
              details: { todo, completed: true, cleared: true },
            };
          }
          atomicWrite(file, todo);
          return { content: [{ type: 'text' as const, text: format(todo) }], details: { todo } };
        });
      },
    }),
  );

  pi.registerEntryRenderer<TodoView>('todo-view', (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    if (data.empty) return new Text(theme.fg('muted', 'No active project todo.'), 0, 0);
    const lines = [theme.fg('accent', theme.bold(`✓ ${data.title}`))];
    for (const [index, item] of data.items.entries()) {
      const marker = item.done ? theme.fg('success', '✓') : theme.fg('muted', '○');
      const text = item.done ? theme.fg('text', item.text) + theme.fg('dim', ' · done') : item.text;
      lines.push(`${marker} ${index + 1}. ${text}`);
    }
    return new Text(lines.join('\n'), 0, 0);
  });

  pi.registerCommand('todo', {
    description: 'Show the active short project checklist',
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before viewing its todo.', 'warning');
      const todo = readTodo(safeFile(ctx.cwd));
      pi.appendEntry<TodoView>('todo-view', todo ? { ...todo } : { title: 'Quick work', items: [], empty: true });
    },
  });
}

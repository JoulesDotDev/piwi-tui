/*
 * todo — one lightweight active work checklist per project.
 *
 * Use for quick multi-part execution that does not need plan approval. One `todo`
 * tool writes, updates, reads, or clears <cwd>/.pi/TODO.md. Completed lists stay
 * visible until explicitly cleared. `/todo` renders locally without adding model
 * context; `/todo clear` removes the retained checklist after confirmation.
 */
import { CONFIG_DIR_NAME, defineTool, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Box, Key, Text, matchesKey } from '@earendil-works/pi-tui';
import { PiwiInteractiveList, type InteractiveRow, type InteractiveTheme } from '../lib/interactive-view.ts';
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
        'Manage the ONE current-work checklist: immediate execution steps for this active run. ' +
        'write replaces it; step updates an item; completed lists remain until explicitly cleared. Never use todo for ' +
        'backlog, reminders, deadlines, or future work—use task_* for those. Use plan for substantial ' +
        'approved work. Requires a trusted project.',
      promptSnippet: 'Track one short current-work checklist',
      promptGuidelines: [
        'Use todo only for the current run’s immediate multi-step execution checklist. Do not use it as a durable reminder, backlog, deadline, or future-work tracker; use task_* for those. Keep it current; completed lists remain visible until an explicit clear.',
      ],
      parameters: Type.Object({
        action: StringEnum(['write', 'step', 'read', 'clear'] as const, { description: 'write replaces the checklist; step updates one item; read returns it; clear deletes it.' }),
        title: Type.Optional(Type.String({ maxLength: 80, description: 'Checklist title for write; defaults to Quick work.' })),
        steps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 50, description: 'One to 50 checklist items required for write.' })),
        step: Type.Optional(Type.Integer({ minimum: 1, description: 'Required for step; 1-based item number.' })),
        done: Type.Optional(Type.Boolean({ description: 'State for step; defaults to true.' })),
      }),
      async execute(_id, params, signal, _update, ctx) {
        if (!ctx.isProjectTrusted()) throw new Error('Project must be trusted before accessing its todo.');
        const file = safeFile(ctx.cwd);
        if (params.action === 'read') {
          const todo = readTodo(file);
          return { content: [{ type: 'text', text: format(todo) }], details: { todo } };
        }
        if (params.action === 'clear') {
          const todo = readTodo(file);
          if (!todo) return { content: [{ type: 'text' as const, text: 'No project todo to clear.' }], details: { cleared: false } };
          if (!ctx.hasUI) throw new Error('Clearing the project todo requires interactive approval.');
          const done = todo.items.filter((item) => item.done).length;
          const ok = await ctx.ui.confirm('Clear the project todo?', `${todo.title} · ${done}/${todo.items.length} complete\n\nThis removes .pi/TODO.md.`, { signal });
          if (!ok) return { content: [{ type: 'text' as const, text: 'Project todo retained.' }], details: { todo, cleared: false } };
          return locked(file, () => {
            rmSync(file, { force: true });
            return { content: [{ type: 'text' as const, text: 'Project todo cleared.' }], details: { cleared: true } };
          });
        }
        return locked(file, () => {
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
          const completed = todo.items.every((item) => item.done);
          atomicWrite(file, todo);
          if (completed) {
            return {
              content: [{ type: 'text' as const, text: `Todo complete — retained for review. Use /todo clear when you are ready.\n${format(todo)}` }],
              details: { todo, completed: true, cleared: false },
            };
          }
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

  const openDashboard = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== 'tui') {
      const todo = readTodo(safeFile(ctx.cwd));
      pi.appendEntry<TodoView>('todo-view', todo ? { ...todo } : { title: 'Quick work', items: [], empty: true });
      return;
    }
    const file = safeFile(ctx.cwd);
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let current = readTodo(file);
      let busy = false;
      const rows = (): InteractiveRow[] => (current?.items ?? []).map((item, index) => ({
        id: String(index),
        label: item.text,
        marker: item.done ? '✓' : '○',
        right: item.done ? 'done' : undefined,
        tone: item.done ? 'success' : 'text',
      }));
      let list: PiwiInteractiveList;
      const refresh = (preferred?: string): void => {
        current = readTodo(file);
        list.setTitle(`☑ ${current?.title ?? 'Project todo'} · ${current?.items.length ?? 0}`);
        list.setRows(rows(), preferred);
        tui.requestRender();
      };
      const run = (action: () => Promise<void>): void => {
        if (busy) return;
        busy = true;
        tui.requestRender();
        void action().catch((error) => ctx.ui.notify((error as Error).message, 'warning')).finally(() => { busy = false; refresh(); });
      };
      list = new PiwiInteractiveList(rows(), theme as InteractiveTheme, {
        title: `☑ ${current?.title ?? 'Project todo'} · ${current?.items.length ?? 0}`,
        empty: 'No checklist yet — press n to create one.',
        controls: ['↑↓ select · enter/space toggle · n add', 'r reopen · c clear · esc close'],
        onClose: () => done(undefined),
        requestRender: () => tui.requestRender(),
        onInput: (data, selected) => {
          if (busy) return;
          if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && selected) {
            return run(async () => locked(file, () => {
              const todo = readTodo(file); if (!todo) return;
              const index = Number(selected.id); if (!todo.items[index]) return;
              todo.items[index].done = !todo.items[index].done;
              atomicWrite(file, todo);
            }));
          }
          if (data === 'r' && selected) {
            return run(async () => locked(file, () => {
              const todo = readTodo(file); if (!todo) return;
              const index = Number(selected.id); if (!todo.items[index]) return;
              todo.items[index].done = false;
              atomicWrite(file, todo);
            }));
          }
          if (data === 'n') return run(async () => {
            let todo = readTodo(file);
            let title = todo?.title;
            if (!todo) {
              const enteredTitle = await ctx.ui.input('New checklist', 'Checklist title');
              if (enteredTitle === undefined) return;
              title = clean(enteredTitle, 80) || 'Quick work';
            }
            const entered = await ctx.ui.input(todo ? 'Add a todo step' : 'First todo step', 'What needs doing?');
            if (entered === undefined) return;
            const text = clean(entered);
            if (!text) return;
            await locked(file, () => {
              todo = readTodo(file) ?? { title: title ?? 'Quick work', items: [] };
              if (todo.items.length >= 50) throw new Error('A quick checklist can have at most 50 steps.');
              todo.items.push({ text, done: false });
              atomicWrite(file, todo);
            });
          });
          if (data === 'c') return run(async () => {
            const todo = readTodo(file); if (!todo) return;
            const count = todo.items.filter((item) => item.done).length;
            if (!(await ctx.ui.confirm('Clear the project todo?', `${todo.title} · ${count}/${todo.items.length} complete\n\nThis removes .pi/TODO.md.`))) return;
            await locked(file, () => rmSync(file, { force: true }));
          });
        },
      });
      return list;
    });
  };

  pi.registerCommand('todo', {
    description: 'Show the current checklist or clear it explicitly',
    getArgumentCompletions: (prefix) => {
      const options = ['clear'].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before viewing its todo.', 'warning');
      const file = safeFile(ctx.cwd);
      const action = args.trim().toLowerCase();
      if (action && action !== 'clear') return void ctx.ui.notify('Use /todo or /todo clear.', 'warning');
      if (action === 'clear') {
        const todo = readTodo(file);
        if (!todo) return void ctx.ui.notify('No project todo to clear.', 'info');
        const done = todo.items.filter((item) => item.done).length;
        const ok = await ctx.ui.confirm('Clear the project todo?', `${todo.title} · ${done}/${todo.items.length} complete\n\nThis removes .pi/TODO.md.`);
        if (!ok) return;
        await locked(file, () => rmSync(file, { force: true }));
        pi.appendEntry<TodoView>('todo-view', { title: todo.title, items: [], empty: true });
        return;
      }
      await openDashboard(ctx);
    },
  });
}

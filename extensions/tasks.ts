/**
 * tasks + boards — a lightweight per-project agenda.
 *
 *   tasks  → <cwd>/.pi/agenda/tasks.json   (durable agenda: text + optional due/tags)
 *   boards → <cwd>/.pi/agenda/boards.json  (virtual kanban: columns of tagged cards)
 *
 * Creation/edit is via tools; `/tasks [filter]` and `/board [name]` render themed
 * views into the transcript (no LLM turn). Due dates are surfaced by tools and by
 * `/briefing` — there are no reminders or notifications (a TUI has no daemon).
 * Drop-in, no dependencies.
 */
import { CONFIG_DIR_NAME, defineTool, truncateHead, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Box, Key, Text, matchesKey } from '@earendil-works/pi-tui';
import { PiwiInteractiveList, type InteractiveRow, type InteractiveTheme } from '../lib/interactive-view.ts';
import { Type } from 'typebox';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

class AgendaToolCard {
  constructor(private readonly title: string, private readonly lines: unknown[], private readonly theme: { fg(c: string, s: string): string; bg(c: string, s: string): string; bold(s: string): string }) {}
  render(width: number): string[] { const box = new Box(1, 1, (content) => this.theme.bg('customMessageBg', content)); box.addChild(new Text([this.theme.fg('accent', this.theme.bold(`◆ ${this.title}`)), ...this.lines.map((value) => { const line = String(value ?? ''); return this.theme.fg('text', line.length > 500 ? `${line.slice(0, 497)}…` : line); })].join('\n'), 0, 0)); return box.render(width); }
  invalidate(): void {}
}
interface Task {
  id: string;
  text: string;
  due?: string; // YYYY-MM-DD
  tags?: string[];
  done: boolean;
  recur?: string; // free text, e.g. "weekly"
  created: string;
}
interface Card {
  id: string;
  text: string;
  tags?: string[];
}
interface Column {
  name: string;
  cards: Card[];
}
interface Board {
  name: string;
  columns: Column[];
}

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
const agendaDir = (cwd: string): string => {
  const dir = join(cwd, CONFIG_DIR_NAME, 'agenda');
  const rel = relative(canonical(cwd), canonical(dir));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing an agenda directory that escapes through a symlink.');
  return dir;
};
function assertChild(root: string, file: string): void {
  const rel = relative(canonical(root), canonical(file));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing an agenda file that escapes through a symlink.');
}
const tasksFile = (cwd: string): string => join(agendaDir(cwd), 'tasks.json');
const boardsFile = (cwd: string): string => join(agendaDir(cwd), 'boards.json');

function readJson<T>(file: string, fallback: T): T {
  assertChild(dirname(file), file);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt file is set ASIDE, never silently overwritten by the next save —
    // the user can still recover it by hand.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return fallback;
  }
}
function writeJson(file: string, data: unknown): void {
  assertChild(dirname(file), file);
  mkdirSync(dirname(file), { recursive: true });
  // tmp + rename = atomic on the same filesystem; a crash mid-write can't truncate
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}
const strings = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 50)
  : undefined;
const readTasks = (cwd: string): Task[] => {
  const value = readJson<unknown>(tasksFile(cwd), []);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Task[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Partial<Task>;
    if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || !raw.text.trim()) return [];
    return [{ id: raw.id.slice(0, 100), text: raw.text.trim().slice(0, 2000), due: typeof raw.due === 'string' && validDate(raw.due) ? raw.due : undefined, tags: strings(raw.tags), done: raw.done === true, recur: typeof raw.recur === 'string' && raw.recur.trim() ? raw.recur.trim().slice(0, 500) : undefined, created: typeof raw.created === 'string' ? raw.created : today() }];
  }).slice(0, 5000);
};
const readBoards = (cwd: string): Board[] => {
  const value = readJson<unknown>(boardsFile(cwd), []);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Board[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as { name?: unknown; columns?: unknown };
    if (typeof raw.name !== 'string' || !raw.name.trim() || !Array.isArray(raw.columns)) return [];
    const columns = raw.columns.flatMap((column): Column[] => {
      if (!column || typeof column !== 'object') return [];
      const c = column as { name?: unknown; cards?: unknown };
      if (typeof c.name !== 'string' || !c.name.trim() || !Array.isArray(c.cards)) return [];
      const cards = c.cards.flatMap((card): Card[] => {
        if (!card || typeof card !== 'object') return [];
        const value = card as { id?: unknown; text?: unknown; tags?: unknown };
        return typeof value.id === 'string' && typeof value.text === 'string' && value.text.trim() ? [{ id: value.id.slice(0, 100), text: value.text.trim().slice(0, 2000), tags: strings(value.tags) }] : [];
      });
      return [{ name: c.name.trim().slice(0, 200), cards: cards.slice(0, 500) }];
    });
    return [{ name: raw.name.trim().slice(0, 200), columns: columns.slice(0, 100) }];
  }).slice(0, 100);
};
const shortId = (): string => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const tagList = (t?: string[]): string => (t && t.length ? ` [${t.join(', ')}]` : '');
const clippedText = (text: string): string => {
  const clipped = truncateHead(text);
  return clipped.content + (clipped.truncated ? `\n\n[Agenda output truncated: ${clipped.outputLines}/${clipped.totalLines} lines.]` : '');
};
const sleep = (ms: number): Promise<void> => new Promise((resolve_) => setTimeout(resolve_, ms));
async function agendaLock<T>(cwd: string, action: () => T): Promise<T> {
  const lock = join(agendaDir(cwd), '.lock');
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random()}`;
  mkdirSync(dirname(lock), { recursive: true });
  const candidate = `${lock}.${process.pid}.${Date.now()}.${Math.random()}.candidate`;
  writeFileSync(candidate, ownerToken, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let acquired = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { linkSync(candidate, lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await sleep(20 + Math.floor(Math.random() * 15));
    }
  }
  rmSync(candidate, { force: true });
  if (!acquired) throw new Error('Another Pi session is saving the agenda. Try again in a moment; if it persists after a crash, run /locks.');
  try { return action(); }
  finally { try { if (readFileSync(lock, 'utf8') === ownerToken) rmSync(lock, { force: true }); } catch { /* recovered elsewhere */ } }
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Group open tasks: overdue · today · upcoming · someday. Done listed last. */
function groupTasks(tasks: Task[]): { label: string; items: Task[] }[] {
  const t = today();
  const open = tasks.filter((x) => !x.done);
  const byDue = (a: Task, b: Task): number => (a.due ?? '9999').localeCompare(b.due ?? '9999');
  const overdue = open.filter((x) => x.due && x.due < t).sort(byDue);
  const nowDue = open.filter((x) => x.due === t).sort(byDue);
  const upcoming = open.filter((x) => x.due && x.due > t).sort(byDue);
  const someday = open.filter((x) => !x.due);
  const done = tasks.filter((x) => x.done);
  return [
    { label: 'Overdue', items: overdue },
    { label: 'Today', items: nowDue },
    { label: 'Upcoming', items: upcoming },
    { label: 'Someday', items: someday },
    { label: 'Done', items: done },
  ].filter((g) => g.items.length);
}

export default function tasksExtension(pi: ExtensionAPI): void {
  let completionCwd: string | undefined;
  pi.on('session_start', (_event, ctx) => { completionCwd = ctx.isProjectTrusted() ? ctx.cwd : undefined; });
  pi.on('session_shutdown', () => { completionCwd = undefined; });
  const ownedTools = new Set(['task_add', 'task_update', 'task_remove', 'task_list', 'board_card_add', 'board_card_move', 'board_card_update', 'board_list']);
  pi.on('tool_call', (event, ctx) => {
    if (ownedTools.has(event.toolName) && !ctx.isProjectTrusted()) return { block: true, reason: 'Trust the project before accessing its agenda.' };
  });
  // ---------- task tools ----------
  pi.registerTool(
    defineTool({
      name: 'task_add',
      label: 'Add task',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard('Agenda · adding', [args.text, args.due ? `Due · ${args.due}` : 'Someday / no due date'], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as Task | undefined; return new AgendaToolCard(context.isError ? 'Agenda · unavailable' : 'Agenda · added', [d?.text ?? 'Task', d?.due ? `Due · ${d.due}` : `ID · ${d?.id ?? ''}`], theme); },
      description:
        'Add a durable project agenda task: backlog, reminder, deadline, or explicitly requested later work. ' +
        'Never use task_add for the current run’s immediate execution checklist; use todo for that. Returns the ' +
        'task ID. Recurrence is descriptive only; it does not reschedule automatically. Requires a trusted project.',
      promptSnippet: 'Add a project agenda task',
      promptGuidelines: [
        'Use task_add only when the user explicitly asks to retain future work, a backlog item, reminder, or deadline. Never create an agenda task for immediate steps in the current run; use todo instead. Otherwise ask before adding it.',
      ],
      parameters: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 2000, description: 'Task text.' }),
        due: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Due date, YYYY-MM-DD.' })),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50, description: 'Tags used for grouping.' })),
        recur: Type.Optional(Type.String({ maxLength: 500, description: 'Recurrence note only, e.g. weekly; no automatic rescheduling.' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const text = params.text.trim();
          if (!text) throw new Error('A task needs text.');
          if (params.due && !validDate(params.due)) throw new Error('due must be a real YYYY-MM-DD date.');
          const tasks = readTasks(ctx.cwd);
          const task: Task = { id: shortId(), text, due: params.due, tags: params.tags?.length ? params.tags : undefined, recur: params.recur || undefined, done: false, created: today() };
          tasks.push(task);
          writeJson(tasksFile(ctx.cwd), tasks);
          return { content: [{ type: 'text' as const, text: `Added task ${task.id}: "${text}"${params.due ? ` (due ${params.due})` : ''}.` }], details: task };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'task_update',
      label: 'Update task',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard(`Agenda · ${args.done === true ? 'completing' : args.done === false ? 'reopening' : 'updating'}`, [args.text ?? `Task · ${args.id}`], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as Task | undefined; return new AgendaToolCard(context.isError ? 'Agenda · unavailable' : d?.done ? 'Agenda · completed' : 'Agenda · updated', [d?.text ?? 'Task', d?.due ? `Due · ${d.due}` : `ID · ${d?.id ?? ''}`], theme); },
      description:
        'Update a task by id: mark done/undone, change its text, due date, or tags. Only the fields you ' +
        'pass change. Use task_list or /tasks to find IDs. Requires a trusted project.',
      promptSnippet: 'Complete or edit a task by id',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 100, description: 'ID returned by task_add or task_list.' }),
        done: Type.Optional(Type.Boolean({ description: 'Mark done (true) or reopen (false).' })),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Replacement task text.' })),
        due: Type.Optional(Type.String({ maxLength: 10, description: 'New due date (YYYY-MM-DD), or empty string to clear.' })),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50, description: 'Replacement tags.' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const tasks = readTasks(ctx.cwd);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`No task with id ${params.id}.`);
          if (params.done !== undefined) task.done = params.done;
          if (params.text !== undefined) {
            const text = params.text.trim();
            if (!text) throw new Error('Task text cannot be empty.');
            task.text = text;
          }
          if (params.due !== undefined) {
            if (params.due && !validDate(params.due)) throw new Error('due must be a real YYYY-MM-DD date or "".');
            task.due = params.due || undefined;
          }
          if (params.tags !== undefined) task.tags = params.tags.length ? params.tags : undefined;
          writeJson(tasksFile(ctx.cwd), tasks);
          return { content: [{ type: 'text' as const, text: `Updated task ${task.id}: "${task.text}"${task.done ? ' (done)' : ''}.` }], details: task };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'task_remove',
      label: 'Remove task',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard('Agenda · removing', [`Task · ${args.id}`], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as Task | undefined; return new AgendaToolCard(context.isError ? 'Agenda · unavailable' : 'Agenda · removed', [d?.text ?? 'Task', `ID · ${d?.id ?? ''}`], theme); },
      description: 'Delete a project agenda task by ID. Requires a trusted project.',
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 100, description: 'ID returned by task_add or task_list.' }) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const tasks = readTasks(ctx.cwd);
          const idx = tasks.findIndex((t) => t.id === params.id);
          if (idx < 0) throw new Error(`No task with id ${params.id}.`);
          const [removed] = tasks.splice(idx, 1);
          writeJson(tasksFile(ctx.cwd), tasks);
          return { content: [{ type: 'text' as const, text: `Removed task ${removed.id}: "${removed.text}".` }], details: removed };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'task_list',
      label: 'List tasks',
      renderShell: 'self',
      renderCall: (_args, theme) => new AgendaToolCard('Agenda · reading', ['Project tasks'], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as { count?: number; tasks?: unknown[] } | undefined; const count = d?.count ?? d?.tasks?.length ?? 0; return new AgendaToolCard(context.isError ? 'Agenda · unavailable' : 'Agenda · ready', [`${count} task${count === 1 ? '' : 's'}`], theme); },
      description:
        'Read this project\'s tasks, grouped overdue · today · upcoming · someday (+ done), with ids and ' +
        'due dates. Use to answer what is due or find a task ID. Requires a trusted project.',
      promptSnippet: "Read the project's tasks",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const tasks = readTasks(ctx.cwd);
        const groups = groupTasks(tasks);
        if (!groups.length) return { content: [{ type: 'text', text: 'No tasks yet. Add one with task_add.' }], details: { tasks: [] } };
        const text = groups
          .map((g) => `${g.label}:\n${g.items.map((t) => `  [${t.id}] ${t.done ? '✓ ' : ''}${t.text}${t.due ? ` (${t.due})` : ''}${t.recur ? ` · repeats ${t.recur}` : ''}${tagList(t.tags)}`).join('\n')}`)
          .join('\n\n');
        return { content: [{ type: 'text', text: clippedText(text) }], details: { count: tasks.length } };
      },
    }),
  );

  // ---------- board tools ----------
  const saveBoards = (cwd: string, boards: Board[]): void => writeJson(boardsFile(cwd), boards);
  const findBoard = (boards: Board[], name: string): Board | undefined => boards.find((b) => b.name.toLowerCase() === name.toLowerCase());

  pi.registerTool(
    defineTool({
      name: 'board_card_add',
      label: 'Add board card',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard('Board · adding card', [args.text, `${args.board} › ${args.column}`], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as (Card & { board?: string; column?: string }) | undefined; return new AgendaToolCard(context.isError ? 'Board · unavailable' : 'Board · card added', [d?.text ?? 'Card', d?.board ? `${d.board} › ${d.column}` : `ID · ${d?.id ?? ''}`], theme); },
      description:
        'Add a card to a kanban board column, creating the board and/or column if they don\'t exist. ' +
        'Use boards to track work items by status. Returns the card ID. Requires a trusted project.',
      promptSnippet: 'Add a card to a kanban board',
      parameters: Type.Object({
        board: Type.String({ minLength: 1, maxLength: 200, description: 'Board name.' }),
        column: Type.String({ minLength: 1, maxLength: 200, description: 'Column name, e.g. Todo.' }),
        text: Type.String({ minLength: 1, maxLength: 2000, description: 'Card text.' }),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50, description: 'Card tags.' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const boardName = params.board.trim();
          const colName = params.column.trim();
          const text = params.text.trim();
          if (!boardName || !colName || !text) throw new Error('A card needs a board, a column, and text.');
          const boards = readBoards(ctx.cwd);
          let board = findBoard(boards, boardName);
          if (!board) { board = { name: boardName, columns: [] }; boards.push(board); }
          let col = board.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
          if (!col) { col = { name: colName, cards: [] }; board.columns.push(col); }
          const card: Card = { id: shortId(), text, tags: params.tags?.length ? params.tags : undefined };
          col.cards.push(card);
          saveBoards(ctx.cwd, boards);
          return { content: [{ type: 'text' as const, text: `Added card ${card.id} to ${board.name} › ${col.name}.` }], details: { ...card, board: board.name, column: col.name } };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'board_card_move',
      label: 'Move board card',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard('Board · moving card', [`${args.board} › ${args.toColumn}`, `Card · ${args.id}`], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as (Card & { board?: string; column?: string }) | undefined; return new AgendaToolCard(context.isError ? 'Board · unavailable' : 'Board · card moved', [d?.text ?? 'Card', d?.board ? `${d.board} › ${d.column}` : `ID · ${d?.id ?? ''}`], theme); },
      description: 'Move a card to another column, creating that column if needed. Requires a trusted project.',
      parameters: Type.Object({
        board: Type.String({ minLength: 1, maxLength: 200, description: 'Board name.' }),
        id: Type.String({ minLength: 1, maxLength: 100, description: 'Card ID returned by board tools.' }),
        toColumn: Type.String({ minLength: 1, maxLength: 200, description: 'Destination column name.' }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const destination = params.toColumn.trim();
          if (!destination) throw new Error('Destination column cannot be empty.');
          const boards = readBoards(ctx.cwd);
          const board = findBoard(boards, params.board);
          if (!board) throw new Error(`No board "${params.board}".`);
          let card: Card | undefined;
          for (const column of board.columns) {
            const index = column.cards.findIndex((item) => item.id === params.id);
            if (index >= 0) { [card] = column.cards.splice(index, 1); break; }
          }
          if (!card) throw new Error(`No card ${params.id} on ${board.name}.`);
          let col = board.columns.find((column) => column.name.toLowerCase() === destination.toLowerCase());
          if (!col) { col = { name: destination, cards: [] }; board.columns.push(col); }
          col.cards.push(card);
          saveBoards(ctx.cwd, boards);
          return { content: [{ type: 'text' as const, text: `Moved card ${card.id} to ${board.name} › ${col.name}.` }], details: { ...card, board: board.name, column: col.name } };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'board_card_update',
      label: 'Update board card',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard(`Board · ${args.remove ? 'removing' : 'updating'} card`, [args.text ?? `Card · ${args.id}`, args.board], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as (Card & { board?: string; column?: string; removed?: boolean }) | undefined; return new AgendaToolCard(context.isError ? 'Board · unavailable' : d?.removed ? 'Board · card removed' : 'Board · card updated', [d?.text ?? 'Card', d?.board ? `${d.board} › ${d.column}` : `ID · ${d?.id ?? ''}`], theme); },
      description: 'Update a card\'s text or tags. Set remove:true to delete it; other update fields are then ignored. Requires a trusted project.',
      parameters: Type.Object({
        board: Type.String({ minLength: 1, maxLength: 200, description: 'Board name.' }),
        id: Type.String({ minLength: 1, maxLength: 100, description: 'Card ID returned by board tools.' }),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Replacement card text.' })),
        tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50, description: 'Replacement tags.' })),
        remove: Type.Optional(Type.Boolean({ description: 'Delete the card; other update fields are ignored.' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        return agendaLock(ctx.cwd, () => {
          const boards = readBoards(ctx.cwd);
          const board = findBoard(boards, params.board);
          if (!board) throw new Error(`No board "${params.board}".`);
          for (const column of board.columns) {
            const index = column.cards.findIndex((item) => item.id === params.id);
            if (index < 0) continue;
            if (params.remove) {
              const [removed] = column.cards.splice(index, 1);
              saveBoards(ctx.cwd, boards);
              return { content: [{ type: 'text' as const, text: `Removed card ${removed.id}.` }], details: { ...removed, board: board.name, column: column.name, removed: true } };
            }
            if (params.text !== undefined) {
              const text = params.text.trim();
              if (!text) throw new Error('Card text cannot be empty.');
              column.cards[index].text = text;
            }
            if (params.tags !== undefined) column.cards[index].tags = params.tags.length ? params.tags : undefined;
            saveBoards(ctx.cwd, boards);
            return { content: [{ type: 'text' as const, text: `Updated card ${params.id}.` }], details: { ...column.cards[index], board: board.name, column: column.name } };
          }
          throw new Error(`No card ${params.id} on ${board.name}.`);
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'board_list',
      label: 'List boards',
      renderShell: 'self',
      renderCall: (args, theme) => new AgendaToolCard('Board · reading', [args.board ?? 'All boards'], theme),
      renderResult: (result, _options, theme, context) => { const d = result.details as { boards?: Array<{ name: string; columns: number }> } | undefined; const boards = d?.boards ?? []; return new AgendaToolCard(context.isError ? 'Board · unavailable' : 'Board · ready', [boards.length ? boards.map((board) => `${board.name} · ${board.columns} columns`).join(' · ') : 'No boards'], theme); },
      description: 'List one project board or all boards, including columns and card IDs. Requires a trusted project.',
      parameters: Type.Object({ board: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Board name; omit to list all boards.' })) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const boards = readBoards(ctx.cwd);
        const chosen = params.board ? boards.filter((b) => b.name.toLowerCase() === params.board!.toLowerCase()) : boards;
        if (!chosen.length) return { content: [{ type: 'text', text: params.board ? `No board "${params.board}".` : 'No boards yet. Add a card with board_card_add.' }], details: { boards: [] } };
        const text = chosen
          .map((b) => `# ${b.name}\n${b.columns.map((c) => `## ${c.name} (${c.cards.length})\n${c.cards.map((card) => `  [${card.id}] ${card.text}${tagList(card.tags)}`).join('\n')}`).join('\n')}`)
          .join('\n\n');
        return { content: [{ type: 'text', text: clippedText(text) }], details: { boards: chosen.map((board) => ({ name: board.name, columns: board.columns.length })) } };
      },
    }),
  );

  type TasksDashboardAction = { kind: 'toggle' | 'delete'; id: string } | { kind: 'create' | 'close' };
  type BoardDashboardAction = { kind: 'move' | 'delete'; id: string } | { kind: 'create' | 'close' };

  const openTasksDashboard = async (filter: string, ctx: ExtensionCommandContext): Promise<void> => {
    let preferredId: string | undefined;
    while (true) {
      const tasks = readTasks(ctx.cwd);
      const visibleTasks = (): Array<{ task: Task; group: string }> => groupTasks(tasks)
        .filter((group) => !filter || group.label.toLowerCase() === filter)
        .flatMap((group) => group.items.map((task) => ({ task, group: group.label })));
      const rows = (): InteractiveRow[] => visibleTasks().map(({ task, group }) => ({
        id: task.id, label: `${group} · ${task.text}`, marker: task.done ? '✓' : '○', right: task.due,
        detail: [`id ${task.id}`, task.tags?.length ? `tags: ${task.tags.join(', ')}` : '', task.recur ? `recurs: ${task.recur}` : ''].filter(Boolean).join(' · '),
        tone: task.done ? 'success' : group === 'Overdue' ? 'error' : group === 'Today' ? 'warning' : 'text',
      }));
      const action = await ctx.ui.custom<TasksDashboardAction>((tui, theme, _keys, done) => {
        const list = new PiwiInteractiveList(rows(), theme as InteractiveTheme, {
          title: `◆ Tasks · ${visibleTasks().filter(({ task }) => !task.done).length} open`,
          empty: filter ? `No ${filter} tasks.` : 'No agenda tasks yet — press n to add one.',
          controls: ['↑↓ select · enter/space complete or reopen · n new', 'd delete · esc close'],
          onClose: () => done({ kind: 'close' }), requestRender: () => tui.requestRender(),
          onInput: (data, selected) => {
            if ((matchesKey(data, Key.enter) || matchesKey(data, Key.space)) && selected) return done({ kind: 'toggle', id: selected.id });
            if (data === 'n') return done({ kind: 'create' });
            if (data === 'd' && selected) return done({ kind: 'delete', id: selected.id });
          },
        });
        if (preferredId) list.setRows(rows(), preferredId);
        return list;
      });
      if (!action || action.kind === 'close') return;
      if ('id' in action) preferredId = action.id;
      if (action.kind === 'toggle') await agendaLock(ctx.cwd, () => {
        const all = readTasks(ctx.cwd); const task = all.find((item) => item.id === action.id); if (!task) return;
        task.done = !task.done; writeJson(tasksFile(ctx.cwd), all);
      });
      else if (action.kind === 'create') {
        const entered = await ctx.ui.input('New agenda task', 'What should Piwi remember for later?');
        if (entered === undefined || !entered.trim()) continue;
        const dueInput = await ctx.ui.input('Due date (optional)', 'YYYY-MM-DD or leave blank'); if (dueInput === undefined) continue;
        const due = dueInput.trim() || undefined; if (due && !validDate(due)) { ctx.ui.notify('Due date must be a real YYYY-MM-DD date.', 'warning'); continue; }
        const id = shortId(); preferredId = id;
        await agendaLock(ctx.cwd, () => { const all = readTasks(ctx.cwd); all.push({ id, text: entered.trim().slice(0, 2000), due, done: false, created: today() }); writeJson(tasksFile(ctx.cwd), all); });
      } else {
        const task = readTasks(ctx.cwd).find((item) => item.id === action.id);
        if (task && await ctx.ui.confirm('Delete this agenda task?', task.text)) await agendaLock(ctx.cwd, () => writeJson(tasksFile(ctx.cwd), readTasks(ctx.cwd).filter((item) => item.id !== action.id)));
      }
    }
  };

  const openBoardDashboard = async (boardName: string, ctx: ExtensionCommandContext): Promise<void> => {
    let preferredId: string | undefined;
    while (true) {
      const board = findBoard(readBoards(ctx.cwd), boardName);
      const cards = (): Array<{ card: Card; column: Column }> => board?.columns.flatMap((column) => column.cards.map((card) => ({ card, column }))) ?? [];
      const rows = (): InteractiveRow[] => cards().map(({ card, column }) => ({ id: card.id, label: `${column.name} · ${card.text}`, marker: '•', detail: card.tags?.length ? `tags: ${card.tags.join(', ')}` : `id ${card.id}` }));
      const action = await ctx.ui.custom<BoardDashboardAction>((tui, theme, _keys, done) => {
        const list = new PiwiInteractiveList(rows(), theme as InteractiveTheme, {
          title: `◆ ${board?.name ?? boardName} · ${cards().length} cards`, empty: 'This board has no cards yet — press n to add one.',
          controls: ['↑↓ select · enter move card · n new card', 'd delete card · esc close'],
          onClose: () => done({ kind: 'close' }), requestRender: () => tui.requestRender(),
          onInput: (data, selected) => {
            if (matchesKey(data, Key.enter) && selected) return done({ kind: 'move', id: selected.id });
            if (data === 'n') return done({ kind: 'create' });
            if (data === 'd' && selected) return done({ kind: 'delete', id: selected.id });
          },
        });
        if (preferredId) list.setRows(rows(), preferredId);
        return list;
      });
      if (!action || action.kind === 'close') return;
      if ('id' in action) preferredId = action.id;
      if (action.kind === 'move') {
        const latest = findBoard(readBoards(ctx.cwd), boardName); if (!latest) continue;
        const source = latest.columns.find((column) => column.cards.some((card) => card.id === action.id)); if (!source) continue;
        const targetName = await ctx.ui.select('Move card to', latest.columns.map((column) => column.name));
        if (!targetName || targetName.toLowerCase() === source.name.toLowerCase()) continue;
        await agendaLock(ctx.cwd, () => {
          const all = readBoards(ctx.cwd); const targetBoard = findBoard(all, boardName); if (!targetBoard) return;
          const from = targetBoard.columns.find((column) => column.cards.some((card) => card.id === action.id));
          const to = targetBoard.columns.find((column) => column.name.toLowerCase() === targetName.toLowerCase()); if (!from || !to) return;
          const index = from.cards.findIndex((card) => card.id === action.id); const [card] = from.cards.splice(index, 1); if (card) to.cards.push(card);
          writeJson(boardsFile(ctx.cwd), all);
        });
      } else if (action.kind === 'create') {
        const latest = findBoard(readBoards(ctx.cwd), boardName); if (!latest) continue;
        if (!latest.columns.length) { ctx.ui.notify('Add a board column before creating a card.', 'warning'); continue; }
        const text = await ctx.ui.input('New board card', 'Card text'); if (text === undefined || !text.trim()) continue;
        const columnName = await ctx.ui.select('Add to column', latest.columns.map((column) => column.name)); if (!columnName) continue;
        const id = shortId(); preferredId = id;
        await agendaLock(ctx.cwd, () => {
          const all = readBoards(ctx.cwd); const target = findBoard(all, boardName); const column = target?.columns.find((item) => item.name.toLowerCase() === columnName.toLowerCase()); if (!column) return;
          column.cards.push({ id, text: text.trim().slice(0, 2000) }); writeJson(boardsFile(ctx.cwd), all);
        });
      } else {
        const latest = findBoard(readBoards(ctx.cwd), boardName);
        const found = latest?.columns.flatMap((column) => column.cards).find((card) => card.id === action.id);
        if (found && await ctx.ui.confirm('Delete this board card?', found.text)) await agendaLock(ctx.cwd, () => {
          const all = readBoards(ctx.cwd); const target = findBoard(all, boardName); if (!target) return;
          for (const column of target.columns) column.cards = column.cards.filter((card) => card.id !== action.id);
          writeJson(boardsFile(ctx.cwd), all);
        });
      }
    }
  };

  // ---------- themed views (/tasks, /board) — interactive in TUI, transcript fallback elsewhere ----------
  pi.registerEntryRenderer<{ kind: 'tasks' | 'board'; lines: { text: string; color?: string; bold?: boolean }[] }>(
    'agenda-view',
    (entry, _opts, theme) => {
      const details = entry.data;
      if (!details) return undefined;
      const out = details.lines
        .map((l) => {
          let s = l.text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
          if (l.color) s = theme.fg(l.color as never, s);
          if (l.bold) s = theme.bold(s);
          return s;
        })
        .join('\n');
      return new Text(out, 0, 0);
    },
  );

  const view = (pi_: ExtensionAPI, kind: 'tasks' | 'board', lines: { text: string; color?: string; bold?: boolean }[], _fallback: string): void => {
    const visible = lines.slice(0, 500);
    if (lines.length > visible.length) visible.push({ text: `… ${lines.length - visible.length} more lines; use task_list or board_list for details.`, color: 'muted' });
    pi_.appendEntry('agenda-view', { kind, lines: visible });
  };

  pi.registerCommand('tasks', {
    description: 'Show project tasks (overdue · today · upcoming · someday · done)',
    getArgumentCompletions: (prefix) => {
      const matches = ['overdue', 'today', 'upcoming', 'someday', 'done'].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before viewing its agenda.', 'warning');
      const filter = args.trim().toLowerCase();
      if (ctx.mode === 'tui') return openTasksDashboard(filter, ctx);
      let groups = groupTasks(readTasks(ctx.cwd));
      if (filter) groups = groups.filter((g) => g.label.toLowerCase() === filter);
      if (!groups.length) {
        view(pi, 'tasks', [{ text: filter ? `No ${filter} tasks.` : 'No tasks yet — add one with the task_add tool.', color: 'muted' }], 'No tasks.');
        return;
      }
      const lines: { text: string; color?: string; bold?: boolean }[] = [];
      const totalOpen = groups.reduce((sum, group) => sum + group.items.filter((task) => !task.done).length, 0);
      const overdue = groups.find((group) => group.label === 'Overdue')?.items.length ?? 0;
      const today = groups.find((group) => group.label === 'Today')?.items.length ?? 0;
      lines.push({ text: `Tasks · ${totalOpen} open${overdue ? ` · ! ${overdue} overdue` : ''}${today ? ` · • ${today} today` : ''}`, color: overdue ? 'error' : today ? 'warning' : 'text', bold: true }, { text: '' });
      const colorFor: Record<string, string> = { Overdue: 'error', Today: 'warning', Upcoming: 'accent', Someday: 'muted', Done: 'success' };
      for (const g of groups) {
        lines.push({ text: `── ${g.label}  (${g.items.length})`, color: colorFor[g.label] === 'muted' ? 'text' : colorFor[g.label] ?? 'text', bold: true });
        for (const t of g.items) {
          const box = t.done ? '✓' : '○';
          const due = t.due ? `  ${t.due}` : '';
          lines.push({ text: `  ${box} ${t.text}${due}${tagList(t.tags)}   ·${t.id}${t.done ? ' · done' : ''}`, color: t.done ? 'text' : t.due && (g.label === 'Overdue' || g.label === 'Today') ? colorFor[g.label] : undefined });
        }
        lines.push({ text: '' });
      }
      view(pi, 'tasks', lines, 'tasks');
    },
  });

  pi.registerCommand('board', {
    description: 'Browse a kanban board or choose one interactively',
    getArgumentCompletions: (prefix) => {
      const q = prefix.trim().toLowerCase();
      const options = (completionCwd ? readBoards(completionCwd) : []).map((board) => board.name).filter((name) => name.toLowerCase().startsWith(q)).map((name) => ({ value: name, label: name }));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) return void ctx.ui.notify('Trust the project before viewing its boards.', 'warning');
      const boards = readBoards(ctx.cwd);
      let name = args.trim();
      if (ctx.mode === 'tui') {
        if (!name) {
          if (!boards.length) return void ctx.ui.notify('No boards yet — add a card with board_card_add.', 'info');
          name = await ctx.ui.select('Open a board', boards.map((board) => board.name)) ?? '';
          if (!name) return;
        }
        if (!findBoard(boards, name)) return void ctx.ui.notify(`No board "${name}".`, 'warning');
        return openBoardDashboard(name, ctx);
      }
      if (!name) {
        const list = boards.length ? `Boards · ${boards.length}` : 'No boards yet — add a card with the board_card_add tool.';
        const lines = boards.length
          ? [{ text: list, color: 'accent', bold: true }, { text: '' }, ...boards.map((board) => ({ text: `  • ${board.name}`, color: 'text' })), { text: '' }, { text: 'Use /board <name> to open one.', color: 'muted' }]
          : [{ text: list, color: 'muted' }];
        view(pi, 'board', lines, list);
        return;
      }
      const board = findBoard(boards, name);
      if (!board) {
        const msg = `No board "${name}".`;
        const lines = [{ text: msg, color: 'warning' }, ...boards.map((item) => ({ text: `  • ${item.name}`, color: 'muted' }))];
        view(pi, 'board', lines, msg);
        return;
      }
      const lines: { text: string; color?: string; bold?: boolean }[] = [{ text: board.name, color: 'accent', bold: true }, { text: '' }];
      for (const c of board.columns) {
        lines.push({ text: `── ${c.name}  (${c.cards.length})`, color: 'accent', bold: true });
        if (!c.cards.length) lines.push({ text: '  (empty)', color: 'muted' });
        for (const card of c.cards) lines.push({ text: `  • ${card.text}${tagList(card.tags)}   ·${card.id}` });
        lines.push({ text: '' });
      }
      view(pi, 'board', lines, board.name);
    },
  });
}

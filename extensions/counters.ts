/**
 * counters — tiny global tally counters with a keyboard dashboard and pinned widget.
 * State is shared across projects in ~/.pi/agent/counters.json. No model tools or
 * prompt contribution: /counter is entirely local.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { renderControlHints } from '../lib/interactive-view.ts';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const COUNTER_STATE_VERSION = 1;
export const MAX_COUNTERS = 100;
export const MAX_PINNED = 4;
export const MAX_NAME_LENGTH = 60;
export const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CounterItem {
  id: string;
  name: string;
  value: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface CounterState { version: 1; counters: CounterItem[] }
export type CounterOperation =
  | { kind: 'add'; name: string; amount: number }
  | { kind: 'set'; name: string; value: number }
  | { kind: 'reset'; name: string }
  | { kind: 'help' }
  | { kind: 'dashboard' };

const statePath = (): string => join(getAgentDir(), 'counters.json');
const lockPath = (): string => `${statePath()}.lock`;
export const cleanCounterName = (value: string): string => Array.from(value.normalize('NFKC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, MAX_NAME_LENGTH).join('');
const slugify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'counter';
const validInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_VALUE;
const defaultState = (): CounterState => ({ version: COUNTER_STATE_VERSION, counters: [] });

export function normalizeCounterState(value: unknown): CounterState {
  if (!value || typeof value !== 'object') return defaultState();
  const raw = value as { version?: unknown; counters?: unknown };
  const version = Number(raw.version ?? 1);
  if (version > COUNTER_STATE_VERSION) throw new Error(`Counter state v${version} is newer than this extension supports (v${COUNTER_STATE_VERSION}).`);
  const ids = new Set<string>();
  const names = new Set<string>();
  let pinned = 0;
  const counters: CounterItem[] = [];
  for (const item of Array.isArray(raw.counters) ? raw.counters : []) {
    if (!item || typeof item !== 'object' || counters.length >= MAX_COUNTERS) continue;
    const candidate = item as Partial<CounterItem>;
    const name = cleanCounterName(typeof candidate.name === 'string' ? candidate.name : '');
    if (!name || names.has(name.toLowerCase()) || !validInteger(candidate.value)) continue;
    let id = typeof candidate.id === 'string' ? candidate.id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60) : slugify(name);
    if (!id || ids.has(id)) {
      const base = slugify(name);
      let suffix = 2;
      id = base;
      while (ids.has(id)) id = `${base}-${suffix++}`;
    }
    const wantsPin = candidate.pinned === true && pinned < MAX_PINNED;
    if (wantsPin) pinned += 1;
    const createdAt = validInteger(candidate.createdAt) && candidate.createdAt > 0 ? candidate.createdAt : Date.now();
    const updatedAt = validInteger(candidate.updatedAt) && candidate.updatedAt > 0 ? candidate.updatedAt : createdAt;
    counters.push({ id, name, value: candidate.value, pinned: wantsPin, createdAt, updatedAt });
    ids.add(id);
    names.add(name.toLowerCase());
  }
  return { version: COUNTER_STATE_VERSION, counters };
}

export function readCounterState(file = statePath()): CounterState {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultState();
    throw error;
  }
  try { return normalizeCounterState(JSON.parse(raw)); }
  catch (error) {
    if ((error as Error).message.includes('newer than')) throw error;
    const corrupt = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, corrupt); } catch { /* preserve whichever process recovered it first */ }
    return defaultState();
  }
}

function writeCounterState(state: CounterState, file = statePath()): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}

export async function withCounterState<T>(mutate: (state: CounterState) => T, file = statePath()): Promise<{ state: CounterState; result: T }> {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  let locked = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, 'wx', 0o600);
      writeFileSync(fd, owner, { encoding: 'utf8' });
      closeSync(fd);
      fd = undefined;
      locked = true;
      break;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { rmSync(lock, { force: true }); } catch { /* preserve original failure */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await sleep(20 + Math.floor(Math.random() * 15));
    }
  }
  if (!locked) throw new Error('Another Pi session is saving counters. Try again in a moment; if it persists after a crash, run /locks.');
  try {
    const state = readCounterState(file);
    const result = mutate(state);
    state.counters = normalizeCounterState(state).counters;
    if (readFileSync(lock, 'utf8') !== owner) throw new Error('Lost the global counter state lock; update was not saved.');
    writeCounterState(state, file);
    return { state, result };
  } finally {
    try { if (readFileSync(lock, 'utf8') === owner) rmSync(lock, { force: true }); } catch { /* lock was already removed */ }
  }
}

function tokens(input: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) out.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\([\\"'])/g, '$1'));
  return out;
}

export function parseCounterArgs(input: string): CounterOperation {
  const parts = tokens(input.trim());
  if (!parts.length) return { kind: 'dashboard' };
  if (parts.length === 1 && parts[0].toLowerCase() === 'help') return { kind: 'help' };
  let tail = parts[parts.length - 1]!;
  let kind: 'add' | 'set' | 'reset' = 'add';
  let amount = 1;
  if (tail.toLowerCase() === 'reset') { kind = 'reset'; parts.pop(); }
  else if (/^=[+-]?\d+$/.test(tail)) { kind = 'set'; amount = Number(tail.slice(1)); parts.pop(); }
  else if (/^[+-]\d+$/.test(tail)) { amount = Number(tail); parts.pop(); }
  else if (tail === '+' || tail === '-') { amount = tail === '+' ? 1 : -1; parts.pop(); }
  const name = cleanCounterName(parts.join(' '));
  if (!name) throw new Error('Give the counter a name, for example /counter coffee or /counter "glasses of water" +1.');
  if (!validInteger(amount)) throw new Error('Counter values must be safe whole numbers.');
  return kind === 'reset' ? { kind, name } : kind === 'set' ? { kind, name, value: amount } : { kind, name, amount };
}

function findCounter(state: CounterState, name: string): CounterItem | undefined {
  const q = name.toLowerCase();
  return state.counters.find((counter) => counter.id === q || counter.name.toLowerCase() === q);
}
function nextId(state: CounterState, name: string): string {
  const base = slugify(name);
  let id = base;
  let suffix = 2;
  while (state.counters.some((counter) => counter.id === id)) id = `${base}-${suffix++}`;
  return id;
}
function createCounter(state: CounterState, name: string): CounterItem {
  if (state.counters.length >= MAX_COUNTERS) throw new Error(`Counters are limited to ${MAX_COUNTERS}. Delete one before adding another.`);
  const now = Date.now();
  const counter: CounterItem = { id: nextId(state, name), name, value: 0, pinned: false, createdAt: now, updatedAt: now };
  state.counters.push(counter);
  return counter;
}
function safeAdd(value: number, amount: number): number {
  const next = value + amount;
  if (!validInteger(next)) throw new Error(`Counter values must stay between ${-MAX_VALUE} and ${MAX_VALUE}.`);
  return next;
}

export type CounterMutation =
  | { kind: 'add'; id?: string; name?: string; amount: number }
  | { kind: 'set'; id?: string; name?: string; value: number }
  | { kind: 'reset'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'pin'; id: string }
  | { kind: 'create'; name: string };

export function mutateCounterState(state: CounterState, mutation: CounterMutation): CounterItem | null {
  const lookupName = 'name' in mutation ? mutation.name : undefined;
  const lookup = mutation.kind === 'create' ? undefined : findCounter(state, mutation.id ?? lookupName ?? '');
  if (mutation.kind === 'create') {
    const name = cleanCounterName(mutation.name);
    if (!name) throw new Error('Counter names cannot be empty.');
    if (findCounter(state, name)) throw new Error(`A counter named "${name}" already exists.`);
    return createCounter(state, name);
  }
  if (!lookup && (mutation.kind === 'add' || mutation.kind === 'set')) {
    const name = cleanCounterName(mutation.name ?? '');
    if (!name) throw new Error('Counter not found.');
    const counter = createCounter(state, name);
    counter.value = mutation.kind === 'add' ? safeAdd(0, mutation.amount) : mutation.value;
    counter.updatedAt = Date.now();
    return counter;
  }
  if (!lookup) throw new Error('Counter not found.');
  if (mutation.kind === 'delete') {
    state.counters = state.counters.filter((counter) => counter.id !== lookup.id);
    return null;
  }
  if (mutation.kind === 'pin') {
    if (!lookup.pinned && state.counters.filter((counter) => counter.pinned).length >= MAX_PINNED) throw new Error(`Pin up to ${MAX_PINNED} counters.`);
    lookup.pinned = !lookup.pinned;
  } else if (mutation.kind === 'reset') lookup.value = 0;
  else if (mutation.kind === 'set') {
    if (!validInteger(mutation.value)) throw new Error('Counter values must be safe whole numbers.');
    lookup.value = mutation.value;
  }
  else lookup.value = safeAdd(lookup.value, mutation.amount);
  lookup.updatedAt = Date.now();
  return lookup;
}

interface DashboardTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}
type CounterDashboardExit =
  | { kind: 'create'; selectedId?: string }
  | { kind: 'reset'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'close' };
interface DashboardActions {
  adjust(id: string, amount: number): Promise<CounterState>;
  create(selectedId?: string): void;
  reset(id: string): void;
  remove(id: string): void;
  pin(id: string): Promise<CounterState | null>;
  close(): void;
  render(): void;
  error(message: string): void;
}

export class CounterDashboard implements Component {
  private selected = 0;
  private busy = false;
  constructor(private state: CounterState, private readonly theme: DashboardTheme, private readonly actions: DashboardActions, preferredId?: string) {
    const preferred = preferredId ? state.counters.findIndex((counter) => counter.id === preferredId) : -1;
    if (preferred >= 0) this.selected = preferred;
  }
  private selectedItem(): CounterItem | undefined { return this.state.counters[this.selected]; }
  private update(next: CounterState | null): void {
    if (next) {
      const id = this.selectedItem()?.id;
      this.state = next;
      this.selected = Math.max(0, id ? next.counters.findIndex((counter) => counter.id === id) : this.selected);
      if (this.selected < 0) this.selected = 0;
      if (this.selected >= next.counters.length) this.selected = Math.max(0, next.counters.length - 1);
    }
    this.busy = false;
    this.actions.render();
  }
  private run(action: () => Promise<CounterState | null>): void {
    if (this.busy) return;
    this.busy = true;
    this.actions.render();
    void action().then((state) => this.update(state), (error) => {
      this.busy = false;
      this.actions.error((error as Error).message);
      this.actions.render();
    });
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === 'q') return this.actions.close();
    if (this.busy) return;
    if (matchesKey(data, Key.up) && this.selected > 0) this.selected -= 1;
    else if (matchesKey(data, Key.down) && this.selected < this.state.counters.length - 1) this.selected += 1;
    else if (matchesKey(data, Key.left) || data === '-') {
      const item = this.selectedItem(); if (item) return this.run(() => this.actions.adjust(item.id, -1));
    } else if (matchesKey(data, Key.right) || data === '+' || matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      const item = this.selectedItem(); if (item) return this.run(() => this.actions.adjust(item.id, 1));
    } else if (data === 'n') return this.actions.create(this.selectedItem()?.id);
    else if (data === 'r') { const item = this.selectedItem(); if (item) return this.actions.reset(item.id); }
    else if (data === 'd') { const item = this.selectedItem(); if (item) return this.actions.remove(item.id); }
    else if (data === 'p') { const item = this.selectedItem(); if (item) return this.run(() => this.actions.pin(item.id)); }
    this.actions.render();
  }
  render(width: number): string[] {
    const w = Math.max(20, width);
    const lines = [this.theme.fg('accent', this.theme.bold(`# Counters · ${this.state.counters.length}`)), this.theme.fg('borderMuted', '─'.repeat(w))];
    if (!this.state.counters.length) lines.push(this.theme.fg('muted', '  No counters yet — press n to make one.'));
    const maxRows = 12;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), Math.max(0, this.state.counters.length - maxRows)));
    for (let index = start; index < Math.min(this.state.counters.length, start + maxRows); index += 1) {
      const item = this.state.counters[index]!;
      const selected = index === this.selected;
      const prefix = selected ? '› ' : '  ';
      const pin = item.pinned ? ' ◆' : '';
      const value = item.value.toLocaleString('en-US');
      const suffix = `${pin}  ${value}`;
      const nameWidth = Math.max(1, w - visibleWidth(prefix) - visibleWidth(suffix));
      const name = truncateToWidth(item.name, nameWidth, '…');
      const paddedName = `${name}${' '.repeat(Math.max(0, nameWidth - visibleWidth(name)))}`;
      const paint = (color: string, text: string, bold = false): string => {
        const content = bold ? this.theme.bold(text) : text;
        return this.theme.fg(color, selected ? this.theme.bg('selectedBg', content) : content);
      };
      const row = truncateToWidth(
        `${paint(selected ? 'accent' : 'dim', prefix)}` +
        `${paint('text', paddedName, selected)}` +
        `${pin ? paint('customMessageLabel', pin) : ''}` +
        `${paint('accent', `  ${value}`)}`,
        w,
        '',
      );
      lines.push(row);
    }
    lines.push('');
    const controls = [
      this.busy ? 'Saving…' : '↑↓ select · ←/→ −/+ · enter +1 · n new · p pin',
      'r reset · d delete · esc close',
    ];
    return [
      ...lines.map((line) => truncateToWidth(line, width)),
      ...renderControlHints(this.theme, controls, width),
    ];
  }
  invalidate(): void {}
}

export function pinnedCounterLines(state: CounterState, width: number, theme: DashboardTheme): string[] {
  const counters = state.counters.filter((counter) => counter.pinned).slice(0, MAX_PINNED);
  if (!counters.length) return [];
  const heading = theme.fg('accent', theme.bold('# Counters'));
  const segments = counters.map((counter) => `${counter.name} ${counter.value.toLocaleString('en-US')}`);
  const lines: string[] = [];
  let current = heading;
  for (const segment of segments) {
    const part = `${visibleWidth(current) ? ' · ' : ''}${segment}`;
    if (visibleWidth(current) + visibleWidth(part) > width && visibleWidth(current) > visibleWidth(heading)) {
      lines.push(truncateToWidth(current, width));
      current = `  ${segment}`;
    } else current += part;
  }
  if (current) lines.push(truncateToWidth(current, width));
  return lines.slice(0, 2);
}

interface CounterEntry { name: string; value?: number; action: 'add' | 'set' | 'reset' | 'help'; amount?: number }

export default function countersExtension(pi: ExtensionAPI): void {
  let activeCtx: ExtensionContext | undefined;
  const refreshPinned = (ctx: ExtensionContext, state = readCounterState()): void => {
    activeCtx = ctx;
    if (!state.counters.some((counter) => counter.pinned)) return void ctx.ui.setWidget('counters', undefined);
    ctx.ui.setWidget('counters', (_tui, theme) => ({ render: (width) => pinnedCounterLines(state, width, theme as DashboardTheme), invalidate() {} }), { placement: 'aboveEditor' });
  };

  pi.registerEntryRenderer<CounterEntry>('counter-event', (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const { name, value, action, amount } = entry.data;
    if (action === 'help') return { render: (width) => [theme.fg('accent', theme.bold('# Counter commands')), theme.fg('text', name)].flatMap((line) => [truncateToWidth(line, width)]), invalidate() {} };
    const icon = action === 'reset' ? '↺' : action === 'set' ? '◆' : (amount ?? 0) < 0 ? '▼' : '▲';
    const tone = action === 'reset' ? 'warning' : (amount ?? 0) < 0 ? 'muted' : 'accent';
    return { render: (width) => [truncateToWidth(`${theme.fg(tone, icon)} ${theme.fg('text', name)} ${theme.fg('muted', '·')} ${theme.fg('accent', (value ?? 0).toLocaleString('en-US'))}`, width)], invalidate() {} };
  });

  pi.on('session_start', (_event, ctx) => {
    try { refreshPinned(ctx); }
    catch (error) { ctx.ui.notify(`Counters unavailable: ${(error as Error).message}`, 'warning'); }
  });
  pi.on('session_shutdown', () => {
    activeCtx?.ui.setWidget('counters', undefined);
    activeCtx = undefined;
  });

  const update = async (mutation: CounterMutation, ctx: ExtensionContext): Promise<{ state: CounterState; counter: CounterItem | null }> => {
    const changed = await withCounterState((state) => mutateCounterState(state, mutation));
    refreshPinned(ctx, changed.state);
    return { state: changed.state, counter: changed.result };
  };

  const openDashboard = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== 'tui') return void ctx.ui.notify('/counter dashboard is available in interactive TUI mode.', 'warning');
    let preferredId: string | undefined;
    while (true) {
      const action = await ctx.ui.custom<CounterDashboardExit>((tui, theme, _keys, done) => {
        const dashboard = new CounterDashboard(readCounterState(), theme as DashboardTheme, {
          adjust: async (id, amount) => (await update({ kind: 'add', id, amount }, ctx)).state,
          create: (selectedId) => done({ kind: 'create', selectedId }),
          reset: (id) => done({ kind: 'reset', id }),
          remove: (id) => done({ kind: 'remove', id }),
          pin: async (id) => (await update({ kind: 'pin', id }, ctx)).state,
          close: () => done({ kind: 'close' }),
          render: () => tui.requestRender(),
          error: (message) => ctx.ui.notify(message, 'warning'),
        }, preferredId);
        return dashboard;
      });
      if (!action || action.kind === 'close') return;
      preferredId = action.kind === 'create' ? action.selectedId : action.id;
      if (action.kind === 'create') {
        const value = await ctx.ui.input('New counter', 'What are you counting?');
        if (value === undefined) continue;
        const name = cleanCounterName(value);
        if (!name) continue;
        const changed = await update({ kind: 'create', name }, ctx);
        preferredId = changed.counter?.id ?? preferredId;
      } else if (action.kind === 'reset') {
        const item = readCounterState().counters.find((counter) => counter.id === action.id);
        if (item && await ctx.ui.confirm(`Reset ${item.name}?`, `Set ${item.name} from ${item.value.toLocaleString('en-US')} back to 0?`)) await update({ kind: 'reset', id: action.id }, ctx);
      } else {
        const item = readCounterState().counters.find((counter) => counter.id === action.id);
        if (item && await ctx.ui.confirm(`Delete ${item.name}?`, 'This removes the counter permanently.')) await update({ kind: 'delete', id: action.id }, ctx);
      }
    }
  };

  pi.registerCommand('counter', {
    description: 'Count anything — open the dashboard or adjust a named counter',
    getArgumentCompletions: (prefix) => {
      const q = prefix.trim().toLowerCase();
      const names = readCounterState().counters.map((counter) => counter.name);
      const options = [...names, 'help'].filter((name) => name.toLowerCase().startsWith(q)).map((name) => ({ value: name.includes(' ') ? `"${name}"` : name, label: name }));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      let operation: CounterOperation;
      try { operation = parseCounterArgs(args); }
      catch (error) { return void ctx.ui.notify((error as Error).message, 'warning'); }
      if (operation.kind === 'dashboard') return openDashboard(ctx);
      if (operation.kind === 'help') {
        pi.appendEntry<CounterEntry>('counter-event', { name: '/counter coffee · /counter coffee +5 · /counter coffee -1 · /counter coffee =20 · /counter coffee reset', action: 'help' });
        return;
      }
      let resetId: string | undefined;
      if (operation.kind === 'reset') {
        const item = findCounter(readCounterState(), operation.name);
        if (!item) return void ctx.ui.notify(`No counter named "${operation.name}".`, 'warning');
        if (!(await ctx.ui.confirm(`Reset ${item.name}?`, `Set ${item.value.toLocaleString('en-US')} back to 0?`))) return;
        resetId = item.id;
      }
      try {
        const mutation: CounterMutation = operation.kind === 'reset'
          ? { kind: 'reset', id: resetId! }
          : operation.kind === 'set'
            ? { kind: 'set', name: operation.name, value: operation.value }
            : { kind: 'add', name: operation.name, amount: operation.amount };
        const changed = await update(mutation, ctx);
        const counter = changed.counter;
        if (!counter) return;
        pi.appendEntry<CounterEntry>('counter-event', {
          name: counter.name,
          value: counter.value,
          action: operation.kind,
          amount: operation.kind === 'add' ? operation.amount : undefined,
        });
      } catch (error) { ctx.ui.notify((error as Error).message, 'warning'); }
    },
  });
}

export const counterStateFile = statePath;
export const counterLockFile = lockPath;

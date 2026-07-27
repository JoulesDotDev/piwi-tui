import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  CounterDashboard,
  MAX_PINNED,
  mutateCounterState,
  normalizeCounterState,
  parseCounterArgs,
  pinnedCounterLines,
  readCounterState,
  withCounterState,
  type CounterState,
} from '../extensions/counters.ts';
import countersExtension from '../extensions/counters.ts';

const expect = (label: string, value: unknown): void => { if (!value) throw new Error(`Counter regression failed: ${label}`); };
const dir = mkdtempSync(join(tmpdir(), 'piwi-counters-'));
const stateFile = join(dir, 'counters.json');

try {
  expect('empty command opens dashboard', parseCounterArgs(' ').kind === 'dashboard');
  expect('bare name increments', JSON.stringify(parseCounterArgs('coffee')) === JSON.stringify({ kind: 'add', name: 'coffee', amount: 1 }));
  expect('quoted names parse', JSON.stringify(parseCounterArgs('"glasses of water" +5')) === JSON.stringify({ kind: 'add', name: 'glasses of water', amount: 5 }));
  expect('decrement parses', JSON.stringify(parseCounterArgs('bugs -1')) === JSON.stringify({ kind: 'add', name: 'bugs', amount: -1 }));
  expect('set parses', JSON.stringify(parseCounterArgs('pushups =20')) === JSON.stringify({ kind: 'set', name: 'pushups', value: 20 }));
  expect('reset parses', JSON.stringify(parseCounterArgs('coffee reset')) === JSON.stringify({ kind: 'reset', name: 'coffee' }));

  const state: CounterState = { version: 1, counters: [] };
  const coffee = mutateCounterState(state, { kind: 'add', name: 'Coffee', amount: 1 })!;
  mutateCounterState(state, { kind: 'add', id: coffee.id, amount: 4 });
  expect('counter created and incremented', coffee.value === 5 && state.counters.length === 1);
  mutateCounterState(state, { kind: 'set', id: coffee.id, value: 12 });
  expect('counter set', coffee.value === 12);
  mutateCounterState(state, { kind: 'reset', id: coffee.id });
  expect('counter reset', coffee.value === 0);
  mutateCounterState(state, { kind: 'pin', id: coffee.id });
  expect('counter pinned', coffee.pinned);

  for (let i = 1; i < MAX_PINNED; i++) {
    const counter = mutateCounterState(state, { kind: 'create', name: `Pinned ${i}` })!;
    mutateCounterState(state, { kind: 'pin', id: counter.id });
  }
  const extra = mutateCounterState(state, { kind: 'create', name: 'One too many' })!;
  let pinRejected = false;
  try { mutateCounterState(state, { kind: 'pin', id: extra.id }); } catch { pinRejected = true; }
  expect('pin limit enforced', pinRejected);

  const normalized = normalizeCounterState({ version: 1, counters: [
    { id: 'same', name: 'One', value: 1, pinned: true },
    { id: 'same', name: 'Two', value: 2, pinned: true },
    { id: 'bad', name: 'One', value: 3 },
    { id: 'unsafe', name: '\u202eHidden', value: 4 },
  ] });
  expect('normalization dedupes names and ids', normalized.counters.length === 3 && new Set(normalized.counters.map((item) => item.id)).size === 3);
  expect('control characters cleaned', normalized.counters.some((item) => item.name === 'Hidden'));

  await Promise.all(Array.from({ length: 20 }, () => withCounterState((draft) => mutateCounterState(draft, { kind: 'add', name: 'Concurrent', amount: 1 }), stateFile)));
  expect('concurrent increments preserved', readCounterState(stateFile).counters.find((item) => item.name === 'Concurrent')?.value === 20);
  expect('state is durable JSON', JSON.parse(readFileSync(stateFile, 'utf8')).version === 1);

  writeFileSync(stateFile, '{broken');
  expect('corruption recovers empty without overwrite', readCounterState(stateFile).counters.length === 0);

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const renderedState: CounterState = { version: 1, counters: Array.from({ length: 15 }, (_, index) => ({ id: `c-${index}`, name: index === 0 ? '名称✨ counter' : `Counter ${index}`, value: index, pinned: index < 2, createdAt: 1, updatedAt: 1 })) };
  const dashboard = new CounterDashboard(renderedState, theme, {
    adjust: async () => renderedState,
    create: async () => renderedState,
    reset: async () => renderedState,
    remove: async () => renderedState,
    pin: async () => renderedState,
    close() {}, render() {}, error() {},
  });
  for (const width of [24, 40, 80]) {
    expect(`dashboard width ${width}`, dashboard.render(width).every((line) => visibleWidth(line) <= width));
    expect(`pinned width ${width}`, pinnedCounterLines(renderedState, width, theme).every((line) => visibleWidth(line) <= width));
  }

  // Real command registration/execution against an isolated global agent dir.
  process.env.PI_CODING_AGENT_DIR = dir;
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const entries: Array<{ type: string; data: any }> = [];
  const hooks = new Map<string, Function[]>();
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerEntryRenderer() {},
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
    on(name: string, handler: Function) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
  } as any;
  countersExtension(pi);
  const command = commands.get('counter');
  expect('counter command registered', command);
  const ctx = {
    mode: 'tui',
    ui: {
      confirm: async () => true,
      notify() {},
      setWidget() {},
    },
  } as any;
  await command!.handler('Tea', ctx);
  await command!.handler('Tea +4', ctx);
  expect('direct command updates and renders locally', readCounterState(join(dir, 'counters.json')).counters.find((item) => item.name === 'Tea')?.value === 5 && entries.length === 2);

  console.log('counter persistence, parsing, rendering, and command regressions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

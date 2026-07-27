import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PiwiInteractiveList, PiwiTextViewer, renderControlHints, type InteractiveTheme } from '../lib/interactive-view.ts';

const root = resolve(import.meta.dir, '..');
const expect = (label: string, value: unknown): void => { if (!value) throw new Error(`Interactive-view regression failed: ${label}`); };
const ansi = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const themes: InteractiveTheme[] = [
  { fg: (_color, text) => ansi(36, text), bg: (_color, text) => ansi(44, text), bold: (text) => ansi(1, text) },
  { fg: (_color, text) => ansi(34, text), bg: (_color, text) => ansi(47, text), bold: (text) => ansi(1, text) },
];
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

for (const [themeIndex, theme] of themes.entries()) {
  let closed = false;
  let action = '';
  const list = new PiwiInteractiveList([
    { id: 'one', label: 'A very long selected row with unicode 名称 and useful detail', marker: '○', right: 'today', detail: 'Visible selected-row details' },
    { id: 'two', label: 'Second row', marker: '✓', right: 'done', tone: 'success' },
  ], theme, {
    title: '◆ Interactive test', empty: 'Nothing here.', maxRows: 5,
    controls: ['↑↓ select · enter primary · n new · p pin', 'r reset · d delete · esc close'],
    onInput: (data, selected) => { action = `${data}:${selected?.id}`; },
    onClose: () => { closed = true; },
  });
  for (const width of [10, 20, 38, 80]) {
    const lines = list.render(width);
    expect(`theme ${themeIndex} width ${width}`, lines.every((line) => visibleWidth(line) <= width));
    const controls = strip(lines.join(' '));
    for (const label of ['select', 'primary', 'new', 'pin', 'reset', 'delete', 'close']) expect(`controls remain visible at ${width}: ${label}`, controls.includes(label));
  }
  list.handleInput('\x1b[B');
  list.handleInput('\r');
  expect('selection and primary action', action.endsWith(':two'));
  list.handleInput('\x1b');
  expect('escape closes', closed);

  let viewerClosed = false;
  const viewer = new PiwiTextViewer('◇ Viewer', Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n'), theme, () => { viewerClosed = true; }, 8);
  for (const width of [10, 24, 60]) {
    const lines = viewer.render(width);
    expect(`viewer width ${width}`, lines.every((line) => visibleWidth(line) <= width));
    expect(`viewer controls ${width}`, strip(lines.join(' ')).includes('scroll') && strip(lines.join(' ')).includes('esc back'));
  }
  viewer.handleInput('\x1b[6~');
  expect('viewer page down', strip(viewer.render(40).join(' ')).includes('9-16/40'));
  viewer.handleInput('\x1b');
  expect('viewer escape closes', viewerClosed);
  expect('control helper wraps', renderControlHints(theme, ['one two three four five six'], 8).every((line) => visibleWidth(line) <= 8));
}

const interactive = ['counters.ts', 'todo.ts', 'tasks.ts', 'plan.ts', 'processes.ts', 'memory.ts', 'skills.ts', 'wiki.ts'];
for (const file of interactive) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} uses shared visible-control system`, source.includes('interactive-view.ts'));
  expect(`${file} names close control`, /esc (?:close|back)/.test(source));
}
for (const file of ['pet.ts']) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} keeps controls visible`, /Up\/Down · Enter · Esc/.test(source));
}
for (const file of ['doctor.ts', 'locks.ts']) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} remains read-only`, /read-only|never removes|without changing/i.test(source));
}

console.log('shared interactive controls, dark/light widths, viewers, and surface audit passed');

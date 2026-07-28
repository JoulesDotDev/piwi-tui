import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PiwiInteractiveList, PiwiTextViewer, renderControlHints, type InteractiveTheme } from '../lib/interactive-view.ts';
import { appendInputLog } from '../extensions/processes.ts';

const root = resolve(import.meta.dir, '..');
const expect = (label: string, value: unknown): void => { if (!value) throw new Error(`Interactive-view regression failed: ${label}`); };
const ansi = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const themes: InteractiveTheme[] = [
  { fg: (_color, text) => ansi(36, text), bg: (_color, text) => ansi(44, text), bold: (text) => ansi(1, text) },
  { fg: (_color, text) => ansi(34, text), bg: (_color, text) => ansi(47, text), bold: (text) => ansi(1, text) },
];
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const roleTheme: InteractiveTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};
const styledHints = renderControlHints(roleTheme, ['enter open · d delete'], 200).join('');
expect('control keys use a distinct visual role', styledHints.includes('<customMessageLabel><bold>enter</bold>') && styledHints.includes('<dim>open</dim>') && styledHints.includes('<borderMuted> · </borderMuted>'));
const hierarchyList = new PiwiInteractiveList([{ id: 'one', label: 'Selected', marker: '✓', right: 'done', tone: 'success' }], roleTheme, {
  title: 'Heading', empty: 'Empty', controls: ['enter open'], onInput() {}, onClose() {},
});
const hierarchyOutput = hierarchyList.render(200).join('\n');
expect('selected row applies background to each styled segment', (hierarchyOutput.match(/<selectedBg>/g)?.length ?? 0) >= 3 && hierarchyOutput.includes('<success><selectedBg>✓ '));

for (const [themeIndex, theme] of themes.entries()) {
  let closed = false;
  let action = '';
  let renderRequests = 0;
  const list = new PiwiInteractiveList([
    { id: 'one', label: 'A very long selected row with unicode 名称 and useful detail', marker: '○', right: 'today', detail: 'Visible selected-row details' },
    { id: 'two', label: 'Second row', marker: '✓', right: 'done', tone: 'success' },
  ], theme, {
    title: '# Interactive test', empty: 'Nothing here.', maxRows: 5,
    controls: ['↑↓ select · enter primary · n new · p pin', 'r reset · d delete · esc close'],
    onInput: (data, selected) => { action = `${data}:${selected?.id}`; },
    onClose: () => { closed = true; },
    requestRender: () => { renderRequests += 1; },
  });
  for (const width of [10, 20, 38, 80]) {
    const lines = list.render(width);
    expect(`theme ${themeIndex} width ${width}`, lines.every((line) => visibleWidth(line) <= width));
    const plainLines = lines.map(strip);
    expect(`theme ${themeIndex} spacious frame ${width}`, plainLines[0] === '' && plainLines.at(-1) === '' && plainLines.filter((line) => /^─+$/.test(line)).length >= 2);
    const controls = strip(lines.join(' '));
    for (const label of ['select', 'primary', 'new', 'pin', 'reset', 'delete', 'close']) expect(`controls remain visible at ${width}: ${label}`, controls.includes(label));
  }
  list.handleInput('\x1b[B');
  list.handleInput('\r');
  expect('selection and primary action', action.endsWith(':two'));
  expect('navigation requests render', renderRequests >= 2);
  list.handleInput('\x1b');
  expect('escape closes', closed);

  let viewerClosed = false;
  const viewer = new PiwiTextViewer('# Viewer', Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n'), theme, () => { viewerClosed = true; }, 8);
  for (const width of [10, 24, 60]) {
    const lines = viewer.render(width);
    expect(`viewer width ${width}`, lines.every((line) => visibleWidth(line) <= width));
    expect(`viewer controls ${width}`, strip(lines.join(' ')).includes('scroll') && strip(lines.join(' ')).includes('esc back'));
    const plainLines = lines.map(strip);
    expect(`viewer spacious frame ${width}`, plainLines[0] === '' && plainLines.at(-1) === '' && plainLines.filter((line) => /^─+$/.test(line)).length >= 2);
  }
  viewer.handleInput('\x1b[6~');
  expect('viewer page down', strip(viewer.render(40).join(' ')).includes('9-16/40'));
  viewer.handleInput('\x1b');
  expect('viewer escape closes', viewerClosed);
  const wrapped = new PiwiTextViewer('Wrapped', Array.from({ length: 80 }, (_, index) => String(index)).join(' '), theme, () => {}, 5);
  const firstWrappedPage = strip(wrapped.render(12).join('\n'));
  wrapped.handleInput('\x1b[6~');
  const secondWrappedPage = strip(wrapped.render(12).join('\n'));
  expect('wrapped continuation rows are scrollable', firstWrappedPage !== secondWrappedPage && secondWrappedPage.includes('23'));
  expect('control helper wraps', renderControlHints(theme, ['one two three four five six'], 8).every((line) => visibleWidth(line) <= 8));
}

const interactive = ['counters.ts', 'todo.ts', 'tasks.ts', 'plan.ts', 'processes.ts', 'memory.ts', 'skills.ts', 'wiki.ts'];
for (const file of interactive) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} uses shared visible-control system`, source.includes('interactive-view.ts'));
  expect(`${file} names close control`, /esc (?:close|back)/.test(source));
  expect(`${file} has an inline custom view`, source.includes('ctx.ui.custom'));
  expect(`${file} custom views are not overlays`, !source.includes('{ overlay: true }'));
}
for (const file of ['counters.ts', 'tasks.ts', 'plan.ts', 'processes.ts', 'memory.ts']) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} exposes text filtering`, source.includes('/ filter'));
}
for (const file of ['pet.ts']) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} keeps controls visible`, source.includes("['↑↓ select · enter open · esc close']"));
  expect(`${file} uses the inline close-action-reopen pattern`, source.includes('while (true)') && !source.includes('{ overlay: true }'));
}
for (const file of ['doctor.ts', 'locks.ts']) {
  const source = readFileSync(join(root, 'extensions', file), 'utf8');
  expect(`${file} remains read-only`, /read-only|never removes|without changing/i.test(source));
}

const logDir = mkdtempSync(join(tmpdir(), 'piwi-input-log-'));
try {
  const log = join(logDir, 'combined.log');
  appendInputLog(log, 'ok\n2:forged stderr\n1:forged stdout');
  const records = readFileSync(log, 'utf8').trimEnd().split('\n');
  expect('each input line keeps input prefix', records.length === 3 && records.every((line) => line.startsWith('0:')));
} finally { rmSync(logDir, { recursive: true, force: true }); }

console.log('shared interactive controls, dark/light widths, viewers, and surface audit passed');

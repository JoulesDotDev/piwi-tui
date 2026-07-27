import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';

export interface InteractiveTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}
export interface InteractiveRow {
  id: string;
  label: string;
  marker?: string;
  right?: string;
  detail?: string;
  tone?: string;
}
export interface InteractiveListOptions {
  title: string;
  empty: string;
  controls: string[];
  maxRows?: number;
  onInput(data: string, selected: InteractiveRow | undefined): void;
  onClose(): void;
  requestRender?: () => void;
}

/** Shared Piwi keyboard-list surface. Controls are always visible and wrap rather
 * than truncate, so the user never has to remember hidden keys. */
export class PiwiInteractiveList implements Component {
  private selected = 0;
  private rows: InteractiveRow[];
  constructor(rows: InteractiveRow[], private readonly theme: InteractiveTheme, private readonly options: InteractiveListOptions) {
    this.rows = rows;
  }
  selectedRow(): InteractiveRow | undefined { return this.rows[this.selected]; }
  setTitle(title: string): void { this.options.title = title; }
  setRows(rows: InteractiveRow[], preferredId = this.selectedRow()?.id): void {
    this.rows = rows;
    const preferred = preferredId ? rows.findIndex((row) => row.id === preferredId) : -1;
    if (preferred >= 0) this.selected = preferred;
    else this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === 'q') return this.options.onClose();
    if (matchesKey(data, Key.up) && this.selected > 0) this.selected -= 1;
    else if (matchesKey(data, Key.down) && this.selected < this.rows.length - 1) this.selected += 1;
    else this.options.onInput(data, this.selectedRow());
    this.options.requestRender?.();
  }
  render(width: number): string[] {
    const w = Math.max(1, width);
    const lines: string[] = [truncateToWidth(this.theme.fg('accent', this.theme.bold(this.options.title)), w), ''];
    if (!this.rows.length) lines.push(...wrapTextWithAnsi(this.theme.fg('muted', this.options.empty), w));
    const maxRows = Math.max(3, this.options.maxRows ?? 12);
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), Math.max(0, this.rows.length - maxRows)));
    for (let index = start; index < Math.min(this.rows.length, start + maxRows); index += 1) {
      const row = this.rows[index]!;
      const prefix = index === this.selected ? '› ' : '  ';
      const marker = row.marker ? `${row.marker} ` : '';
      const proposedRight = row.right ? `  ${row.right}` : '';
      const right = visibleWidth(prefix) + visibleWidth(marker) + visibleWidth(proposedRight) + 2 <= w ? proposedRight : '';
      const labelWidth = Math.max(1, w - visibleWidth(prefix) - visibleWidth(marker) - visibleWidth(right));
      const label = truncateToWidth(row.label, labelWidth, '…');
      const paddedLabel = `${label}${' '.repeat(Math.max(0, labelWidth - visibleWidth(label)))}`;
      const plain = truncateToWidth(`${prefix}${marker}${paddedLabel}${right}`, w, '');
      const colored = this.theme.fg(row.tone ?? 'text', plain);
      lines.push(index === this.selected ? this.theme.bg('selectedBg', colored) : colored);
      if (index === this.selected && row.detail) {
        for (const detail of wrapTextWithAnsi(this.theme.fg('dim', `    ${row.detail}`), w)) lines.push(detail);
      }
    }
    lines.push('');
    lines.push(...renderControlHints(this.theme, this.options.controls, w));
    return lines;
  }
  invalidate(): void {}
}

export function renderControlHints(theme: InteractiveTheme, controls: string[], width: number): string[] {
  const w = Math.max(1, width);
  return controls.flatMap((line) => wrapTextWithAnsi(theme.fg('dim', line), w));
}

export class PiwiTextViewer implements Component {
  private offset = 0;
  private totalRows = 0;
  constructor(private readonly title: string, private readonly text: string, private readonly theme: InteractiveTheme, private readonly close: () => void, private readonly maxRows = 18) {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === 'q') return this.close();
    const maxOffset = Math.max(0, this.totalRows - this.maxRows);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset = Math.min(maxOffset, this.offset + 1);
    else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.maxRows);
    else if (matchesKey(data, Key.pageDown)) this.offset = Math.min(maxOffset, this.offset + this.maxRows);
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = maxOffset;
  }
  render(width: number): string[] {
    const w = Math.max(1, width);
    const visual = this.text.split('\n').flatMap((line) => wrapTextWithAnsi(this.theme.fg('text', line || ' '), w));
    this.totalRows = visual.length;
    this.offset = Math.min(this.offset, Math.max(0, this.totalRows - this.maxRows));
    const body = visual.slice(this.offset, this.offset + this.maxRows);
    const position = this.totalRows > this.maxRows ? ` · ${this.offset + 1}-${Math.min(this.totalRows, this.offset + this.maxRows)}/${this.totalRows}` : '';
    return [truncateToWidth(this.theme.fg('accent', this.theme.bold(`${this.title}${position}`)), w), '', ...body, '', ...renderControlHints(this.theme, ['↑↓ scroll · pgup/pgdn · home/end · esc back'], w)];
  }
  invalidate(): void {}
}

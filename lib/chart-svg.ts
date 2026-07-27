/**
 * chart-svg — render an extracted spreadsheet chart to a self-contained SVG
 * string, so it can be saved as an image asset and embedded on a wiki page.
 *
 * Pure string building: no DOM, no canvas, no dependencies. The palette is
 * baked in (the SVG is a standalone asset — the app's theme vars can't reach
 * into a data-URL <img>), so the chart sits on its own light card with a
 * small soft-pastel palette and stays readable on light or dark pages.
 *
 * Supports bar, line, area, and pie/doughnut. Returns null for kinds we don't
 * render (the caller keeps the text summary instead).
 */

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
}
export interface ChartData {
  /** Normalized kind: bar | line | area | pie | doughnut | (other → not rendered). */
  kind: string;
  title: string;
  categories: string[];
  series: ChartSeries[];
}

const W = 540;
const H = 340;
const M = { top: 46, right: 22, bottom: 70, left: 60 };

const CARD = '#ffffff';
const BORDER = '#e5e7eb'; // gray-200
const INK = '#374151'; // gray-700
const MUTE = '#6b7280'; // gray-500
const GRID = '#eef0f2'; // ~gray-100
// A small soft-pastel palette (slightly saturated) for series / pie slices.
const RAMP = ['#7C9CBF', '#8FBF9F', '#E0B97D', '#B79BCB', '#D99A9A', '#7FB5BF', '#C9B68C'];
const FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const color = (i: number): string => RAMP[i % RAMP.length];
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** Round, evenly-spaced axis ticks spanning [min,max]. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) max = min + 1;
  const step0 = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** Pie slice path (filled wedge from the center). Angles in radians. */
function wedge(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = (cx + r * Math.cos(a0)).toFixed(1);
  const y0 = (cy + r * Math.sin(a0)).toFixed(1);
  const x1 = (cx + r * Math.cos(a1)).toFixed(1);
  const y1 = (cy + r * Math.sin(a1)).toFixed(1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

function frame(inner: string, title: string): string {
  const t = title
    ? `<text x="${W / 2}" y="27" text-anchor="middle" font-size="15" font-weight="600" fill="${INK}" font-family="${FONT}">${esc(clip(title, 56))}</text>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${CARD}" stroke="${BORDER}"/>` +
    t +
    inner +
    `</svg>`
  );
}

function renderCartesian(c: ChartData): string {
  const m = c.series.length;
  const cats = c.categories.length ? c.categories : (c.series[0]?.values.map((_, i) => String(i + 1)) ?? []);
  const n = Math.max(cats.length, ...c.series.map((s) => s.values.length));
  const allVals = c.series.flatMap((s) => s.values).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const dMin = Math.min(0, ...allVals);
  let dMax = Math.max(0, ...allVals);
  if (dMin === dMax) dMax = dMin + 1;
  const ticks = niceTicks(dMin, dMax, 4);
  const yMin = Math.min(ticks[0], dMin);
  const yMax = Math.max(ticks[ticks.length - 1], dMax);

  const x0 = M.left;
  const plotW = W - M.left - M.right;
  const plotTop = M.top + (m > 1 ? 12 : 0); // room for a legend row
  const plotH = H - plotTop - M.bottom;
  const band = plotW / Math.max(n, 1);
  const xCenter = (i: number): number => x0 + band * (i + 0.5);
  const yFor = (v: number): number => plotTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const parts: string[] = [];

  // gridlines + y tick labels
  for (const t of ticks) {
    const y = yFor(t).toFixed(1);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${(x0 + plotW).toFixed(1)}" y2="${y}" stroke="${GRID}"/>`);
    parts.push(
      `<text x="${x0 - 8}" y="${(yFor(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTE}" font-family="${FONT}">${esc(fmtNum(t))}</text>`,
    );
  }
  // y axis + zero/baseline
  const yBase = yFor(Math.max(yMin, Math.min(yMax, 0)));
  parts.push(`<line x1="${x0}" y1="${plotTop}" x2="${x0}" y2="${plotTop + plotH}" stroke="${BORDER}"/>`);
  parts.push(`<line x1="${x0}" y1="${yBase.toFixed(1)}" x2="${x0 + plotW}" y2="${yBase.toFixed(1)}" stroke="${INK}"/>`);

  if (c.kind === 'bar') {
    const groupW = band * 0.74;
    const barW = groupW / m;
    for (let si = 0; si < m; si++) {
      for (let i = 0; i < n; i++) {
        const v = c.series[si].values[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const bx = xCenter(i) - groupW / 2 + si * barW;
        const y = yFor(v);
        const yb = yFor(0);
        parts.push(
          `<rect x="${bx.toFixed(1)}" y="${Math.min(y, yb).toFixed(1)}" width="${(barW * 0.9).toFixed(1)}" height="${Math.max(0, Math.abs(yb - y)).toFixed(1)}" fill="${color(si)}" rx="1.5"/>`,
        );
      }
    }
  } else {
    for (let si = 0; si < m; si++) {
      const pts: string[] = [];
      for (let i = 0; i < n; i++) {
        const v = c.series[si].values[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        pts.push(`${xCenter(i).toFixed(1)},${yFor(v).toFixed(1)}`);
      }
      if (!pts.length) continue;
      if (c.kind === 'area') {
        const base = yFor(0).toFixed(1);
        const poly = `${pts[0].split(',')[0]},${base} ${pts.join(' ')} ${pts[pts.length - 1].split(',')[0]},${base}`;
        parts.push(`<polygon points="${poly}" fill="${color(si)}" fill-opacity="0.16"/>`);
      }
      parts.push(
        `<polyline points="${pts.join(' ')}" fill="none" stroke="${color(si)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      for (const p of pts) {
        const [px, py] = p.split(',');
        parts.push(`<circle cx="${px}" cy="${py}" r="2.4" fill="${color(si)}"/>`);
      }
    }
  }

  // x category labels (rotated when crowded/long)
  const rotate = n > 6 || cats.some((s) => s && s.length > 6);
  for (let i = 0; i < n; i++) {
    const label = cats[i];
    if (!label) continue;
    const cx = xCenter(i).toFixed(1);
    const yL = plotTop + plotH + (rotate ? 12 : 16);
    const lab = esc(clip(label, 14));
    parts.push(
      rotate
        ? `<text x="${cx}" y="${yL}" text-anchor="end" font-size="11" fill="${MUTE}" font-family="${FONT}" transform="rotate(-35 ${cx} ${yL})">${lab}</text>`
        : `<text x="${cx}" y="${yL}" text-anchor="middle" font-size="11" fill="${MUTE}" font-family="${FONT}">${lab}</text>`,
    );
  }

  // legend (multi-series only)
  if (m > 1) {
    let lx = x0;
    const ly = M.top - 14;
    for (let si = 0; si < m; si++) {
      const name = clip(c.series[si].name || `Series ${si + 1}`, 16);
      parts.push(`<rect x="${lx.toFixed(1)}" y="${ly - 9}" width="11" height="11" rx="2" fill="${color(si)}"/>`);
      parts.push(`<text x="${(lx + 16).toFixed(1)}" y="${ly}" font-size="11.5" fill="${INK}" font-family="${FONT}">${esc(name)}</text>`);
      lx += 24 + name.length * 6.6;
      if (lx > W - M.right - 60) break; // don't run off the card
    }
  }

  return parts.join('');
}

function renderPie(c: ChartData): string {
  const vals = (c.series[0]?.values ?? []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return '';
  const cats = c.categories.length ? c.categories : vals.map((_, i) => `Item ${i + 1}`);

  const cx = 168;
  const cy = H / 2 + 8;
  const r = 108;
  const parts: string[] = [];
  let a0 = -Math.PI / 2;
  const legendX = cx + r + 24;
  const legendTop = Math.max(M.top + 6, cy - vals.length * 11);

  for (let i = 0; i < vals.length; i++) {
    const frac = vals[i] / total;
    const a1 = a0 + frac * 2 * Math.PI;
    parts.push(`<path d="${wedge(cx, cy, r, a0, a1)}" fill="${color(i)}" stroke="${CARD}" stroke-width="1.5"/>`);
    if (legendX < W - M.right) {
      const ly = legendTop + i * 22;
      parts.push(`<rect x="${legendX}" y="${ly - 9}" width="11" height="11" rx="2" fill="${color(i)}"/>`);
      parts.push(
        `<text x="${legendX + 16}" y="${ly}" font-size="12" fill="${INK}" font-family="${FONT}">${esc(clip(cats[i] ?? '', 16))} · ${Math.round(frac * 100)}%</text>`,
      );
    }
    a0 = a1;
  }
  if (c.kind === 'doughnut') parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="${CARD}"/>`);
  return parts.join('');
}

/** Render a chart to SVG, or null if the kind/data can't be drawn. */
export function renderChartSvg(c: ChartData): string | null {
  if (!c.series.length) return null;
  try {
    if (c.kind === 'pie' || c.kind === 'doughnut') {
      const inner = renderPie(c);
      return inner ? frame(inner, c.title) : null;
    }
    if (c.kind === 'bar' || c.kind === 'line' || c.kind === 'area') {
      return frame(renderCartesian(c), c.title);
    }
    return null;
  } catch {
    return null;
  }
}

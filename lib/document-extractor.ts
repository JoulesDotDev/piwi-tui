/**
 * Extractor — turns a source file into clean markdown, in-stack (Node), no ML
 * models / GPU / Python. Born-digital content parses locally; only scanned PDF
 * pages (no text layer) need the optional `ocr` callback (GPT-5.4 vision).
 *
 *   .docx        → mammoth        (→ markdown)
 *   .pptx        → jszip+fast-xml-parser (title, body, tables, speaker notes, images)
 *   .pdf         → unpdf/pdf.js   (per-page structured markdown — heading tiers
 *                                  from font size, paragraphs from y-gaps, bullets,
 *                                  de-hyphenation; tables stay plain lines.
 *                                  Empty page ⇒ scanned ⇒ ocr())
 *   .xlsx        → exceljs        (per-sheet markdown tables; sparse sheets split
 *                                  into separate clean tables by used region)
 *   .csv/.txt/…  → pass through
 */
import { extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { renderChartSvg, type ChartData, type ChartSeries } from './chart-svg';

export interface ExtractResult {
  markdown: string;
  meta: {
    kind: string;
    chars: number;
    pages?: number;
    /** 1-based page numbers that had no text layer (scanned). */
    scannedPages: number[];
    /** Of those, the ones we actually OCR'd via the vision callback. */
    ocrPages: number[];
    warnings: string[];
  };
}

/** Render a scanned page to an image and return its markdown (GPT-5.4 vision). */
export type OcrFn = (pdfBytes: Uint8Array, pageNumber: number) => Promise<string>;

/** Transcribe/describe an embedded image (docx/pptx/pdf figures) to markdown. */
export type ImageFn = (bytes: Uint8Array, mimeType: string) => Promise<string>;

/**
 * Persist an embedded image binary (docx/pptx/pdf figure) to the project's asset
 * store and return its absolute path — so the agent can later embed the real
 * figure on a wiki page via wiki_image. Omit → image binaries are not saved.
 */
export type SaveImageFn = (bytes: Uint8Array, ext: string) => Promise<string>;

// Plain-text / code files: read directly, no extraction needed.
const PASSTHROUGH = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.org', '.tex', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.xml', '.html', '.htm',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.hpp', '.cpp', '.cc', '.cs', '.php', '.swift', '.css', '.scss', '.sh', '.bash', '.sql',
]);

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_XLSX_REGION_CELLS = 100_000;
/** A page is scanned only when it has no extractable text; sparse text is evidence too. */
const MIN_PAGE_CHARS = 1;

export interface ExtractOpts {
  ocr?: OcrFn;
  /** Describe embedded images via vision (docx/pptx/pdf). Omit → no descriptions. */
  describeImage?: ImageFn;
  /** Save embedded image binaries to the asset store. Omit → images aren't saved. */
  saveImage?: SaveImageFn;
  /** Per-page progress for multi-page PDFs (done of total). */
  onProgress?: (done: number, total: number) => void;
  /** Cap on scanned pages sent to vision OCR per file (cost guard). Default 100. */
  maxOcrPages?: number;
}

export async function extract(path: string, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Source is not a regular file.');
  if (info.size > MAX_SOURCE_BYTES) throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes.`);
  const ext = extname(path).toLowerCase();
  if (PASSTHROUGH.has(ext)) return passthrough(path, ext);
  if (ext === '.docx') return extractDocx(path, opts);
  if (ext === '.pptx') return extractPptx(path, opts);
  if (ext === '.pdf') return extractPdf(path, opts);
  if (ext === '.xlsx') return extractXlsx(path, opts);
  throw new Error(`Unsupported source type: ${ext || '(none)'}`);
}

/** image/* MIME → file extension, for naming saved binaries. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff',
};
const mimeToExt = (m: string): string => MIME_EXT[m.toLowerCase()] ?? 'png';

async function loadSafeZip(input: Buffer | Uint8Array): Promise<any> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(input);
  const files = Object.values(zip.files) as Array<{ _data?: { uncompressedSize?: number } }>;
  if (files.length > MAX_ARCHIVE_ENTRIES) throw new Error(`Office archive exceeds ${MAX_ARCHIVE_ENTRIES} entries.`);
  const expanded = files.reduce((total, file) => total + Math.max(0, Number(file._data?.uncompressedSize ?? 0)), 0);
  if (expanded > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Office archive expands beyond ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes.`);
  return zip;
}

/**
 * One embedded figure → its markdown block. Saves the binary (so it can be
 * embedded on a page) and/or describes it via vision, weaving in the embed hint
 * the agent uses with wiki_image. Returns '' if neither is configured.
 */
async function figureBlock(bytes: Uint8Array, mime: string, ext: string, opts: ExtractOpts): Promise<string> {
  let saved: string | null = null;
  if (opts.saveImage) {
    try { saved = await opts.saveImage(bytes, ext); } catch { saved = null; }
  }
  let desc = '';
  if (opts.describeImage) {
    try { desc = (await opts.describeImage(bytes, mime)).trim(); } catch { desc = ''; }
  }
  if (!saved && !desc) return '';

  const out = ['> **[Figure]**'];
  if (desc) out.push('>', ...desc.split('\n').map((l) => `> ${l}`));
  if (saved) out.push('>', `> ↳ Extracted image asset: ${saved}`);
  return out.join('\n');
}

async function passthrough(path: string, ext: string): Promise<ExtractResult> {
  const markdown = await readFile(path, 'utf8');
  return { markdown, meta: { kind: ext.slice(1), chars: markdown.length, scannedPages: [], ocrPages: [], warnings: [] } };
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/p\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlTables(html: string): { html: string; tables: string[] } {
  const tables: string[] = [];
  const replaced = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cleanCell(decodeHtmlText(cell[1]))),
    ).filter((row) => row.length);
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((row) => row.length));
    rows.forEach((row) => { while (row.length < cols) row.push(''); });
    const [header, ...body] = rows;
    tables.push([`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...body.map((row) => `| ${row.join(' | ')} |`)].join('\n'));
    return `<p>PIWITABLETOKEN${tables.length - 1}</p>`;
  });
  return { html: replaced, tables };
}

async function extractDocx(path: string, opts: ExtractOpts): Promise<ExtractResult> {
  await loadSafeZip(await readFile(path));
  const mammoth = await import('mammoth');
  const TurndownService = (await import('turndown')).default;
  const { gfm } = await import('turndown-plugin-gfm');

  // Each embedded image gets a unique placeholder SRC (not base64, and not the alt —
  // turndown drops an <img> with an empty src), so we can swap in a saved/described
  // figure block afterward, or drop it if neither is configured.
  const images: { id: string; bytes: Uint8Array; type: string }[] = [];
  const convertImage = mammoth.images.imgElement(async (image) => {
    const id = `piwi-fig-${images.length}`;
    const buf = await image.read();
    images.push({ id, bytes: new Uint8Array(buf as Buffer), type: image.contentType || 'image/png' });
    return { src: id };
  });

  // mammoth's markdown writer drops tables entirely, so go via HTML (faithful tables,
  // lists, headings) and convert with turndown + the GFM plugin (real markdown tables).
  const { value: html, messages } = await mammoth.convertToHtml({ path }, { convertImage });
  const extractedTables = extractHtmlTables(html);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.use(gfm);
  let md = td.turndown(extractedTables.html);
  extractedTables.tables.forEach((table, index) => { md = md.replace(`PIWITABLETOKEN${index}`, table); });

  for (const img of images) {
    const block = await figureBlock(img.bytes, img.type, mimeToExt(img.type), opts);
    md = md.replace(new RegExp(`!\\[[^\\]]*\\]\\(${img.id}\\)`), block || '');
  }
  md = md.replace(/\n{3,}/g, '\n\n').trim(); // tidy blank lines from removed images

  const warnings = messages.filter((m) => m.type === 'warning').map((m) => m.message);
  if (images.length && !opts.describeImage && !opts.saveImage) {
    warnings.push(`${images.length} image(s) dropped (no image handling configured)`);
  }
  return { markdown: md, meta: { kind: 'docx', chars: md.length, scannedPages: [], ocrPages: [], warnings } };
}

// --- PPTX (zip of slide XML + media) ---------------------------------------

/** All descendant nodes with the given tag (fast-xml-parser object tree). */
function findAll(node: unknown, tag: string): unknown[] {
  const res: unknown[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      const arr = Array.isArray(v) ? v : [v];
      if (k === tag) res.push(...arr);
      for (const item of arr) if (item && typeof item === 'object') walk(item);
    }
  };
  walk(node);
  return res;
}

/** Concatenate all <a:t> text under a node (one paragraph). */
function nodeText(node: unknown): string {
  return findAll(node, 'a:t')
    .map((t) => (typeof t === 'string' || typeof t === 'number' ? String(t) : ((t as { '#text'?: string })?.['#text'] ?? '')))
    .join('');
}

const IMG_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.png': 'image/png',
};

/** A slide table (a:tbl → a:tr → a:tc) → a markdown table (first row = header). */
function renderPptxTable(tbl: unknown): string {
  const rows = findAll(tbl, 'a:tr').map((tr) => findAll(tr, 'a:tc').map((tc) => cleanCell(nodeText(tc))));
  if (!rows.length || !rows[0]?.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    while (r.length < cols) r.push('');
    return r;
  };
  const [header, ...body] = rows.map(pad);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function renderPptxParagraph(paragraph: unknown): string {
  const text = nodeText(paragraph).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const properties = findAll(paragraph, 'a:pPr')[0] as { '@_lvl'?: string | number } | undefined;
  const level = Math.min(8, Math.max(0, Number(properties?.['@_lvl'] ?? 0) || 0));
  const bullet = findAll(paragraph, 'a:buChar').length > 0 || findAll(paragraph, 'a:buAutoNum').length > 0;
  return bullet ? `${'  '.repeat(level)}- ${text}` : text;
}

async function extractPptx(path: string, opts: ExtractOpts): Promise<ExtractResult> {
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  const zip = await loadSafeZip(await readFile(path));
  let slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const presentation = zip.file('ppt/presentation.xml');
  const presentationRels = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && presentationRels) {
    const targets = new Map<string, string>();
    for (const relationship of findAll(parser.parse(await presentationRels.async('text')), 'Relationship')) {
      const rel = relationship as { '@_Id'?: string; '@_Target'?: string };
      if (rel['@_Id'] && rel['@_Target']) targets.set(rel['@_Id'], `ppt/${rel['@_Target'].replace(/^\.\.\//, '')}`);
    }
    const ordered = findAll(parser.parse(await presentation.async('text')), 'p:sldId')
      .map((slide) => targets.get((slide as { '@_r:id'?: string })['@_r:id'] ?? ''))
      .filter((name): name is string => !!name && !!zip.file(name));
    if (ordered.length) slides = [...ordered, ...slides.filter((name) => !ordered.includes(name))];
  }

  const out: string[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (let i = 0; i < slides.length; i++) {
    const doc = parser.parse(await zip.file(slides[i])!.async('text'));

    // The slide's relationships resolve embedded media AND the speaker-notes slide.
    const relsFile = zip.file(slides[i].replace(/slides\/(slide\d+)\.xml$/, 'slides/_rels/$1.xml.rels'));
    const rels: Record<string, string> = {};
    const relTypes: Record<string, string> = {};
    if (relsFile) {
      for (const r of findAll(parser.parse(await relsFile.async('text')), 'Relationship')) {
        const rel = r as { '@_Id'?: string; '@_Target'?: string; '@_Type'?: string };
        if (rel['@_Id'] && rel['@_Target']) {
          rels[rel['@_Id']] = rel['@_Target'];
          if (rel['@_Type']) relTypes[rel['@_Id']] = rel['@_Type'];
        }
      }
    }

    // Title placeholder (ph type=title/ctrTitle) → the heading; its paragraphs and any
    // table paragraphs are excluded from the body text so nothing duplicates.
    const titleSp = findAll(doc, 'p:sp').find((sp) => {
      const ph = findAll(sp, 'p:ph')[0] as { '@_type'?: string } | undefined;
      return !!ph && (ph['@_type'] === 'title' || ph['@_type'] === 'ctrTitle');
    });
    const title = titleSp ? findAll(titleSp, 'a:p').map(renderPptxParagraph).filter(Boolean).join(' — ') : '';
    const titleParas = new Set<unknown>(titleSp ? findAll(titleSp, 'a:p') : []);
    const tables = findAll(doc, 'a:tbl');
    const tableParas = new Set<unknown>(tables.flatMap((t) => findAll(t, 'a:p')));

    const parts: string[] = [`## Slide ${i + 1}${title ? ` — ${title}` : ''}`];

    const lines = findAll(doc, 'a:p')
      .filter((p) => !titleParas.has(p) && !tableParas.has(p))
      .map(renderPptxParagraph)
      .filter(Boolean);
    if (lines.length) parts.push(lines.join('\n\n'));

    for (const t of tables) {
      const md = renderPptxTable(t);
      if (md) parts.push(md);
    }

    // Embedded images → saved/described figure blocks (resolve a:blip via .rels).
    const refs = [...new Set(findAll(doc, 'a:blip')
      .map((b) => (b as { '@_r:embed'?: string })['@_r:embed'])
      .filter((id): id is string => typeof id === 'string'))];
    for (const rId of refs) {
      const mediaPath = rels[rId]?.replace(/^\.\.\//, 'ppt/');
      const file = mediaPath ? zip.file(mediaPath) : null;
      if (!file) continue;
      if (!opts.describeImage && !opts.saveImage) {
        skipped++;
        continue;
      }
      const ext = extname(mediaPath!).toLowerCase();
      const block = await figureBlock(await file.async('uint8array'), IMG_MIME[ext] ?? 'image/png', ext.slice(1) || 'png', opts);
      if (block) parts.push(block);
    }

    // Speaker notes (often the real substance) via the notesSlide relationship.
    const notesId = Object.keys(relTypes).find((id) => relTypes[id].endsWith('notesSlide'));
    const notesPath = notesId ? rels[notesId]?.replace(/^\.\.\//, 'ppt/') : undefined;
    const notesFile = notesPath ? zip.file(notesPath) : null;
    if (notesFile) {
      const notes = findAll(parser.parse(await notesFile.async('text')), 'a:p')
        .map((p) => nodeText(p).trim())
        .filter((l) => l && !/^\d+$/.test(l)); // drop the slide-number placeholder
      if (notes.length) parts.push(`**Speaker notes:**\n\n${notes.join('\n\n')}`);
    }

    // Preserve every slide boundary, including title-only and intentionally blank slides.
    out.push(parts.join('\n\n'));
  }

  if (skipped) warnings.push(`${skipped} image(s) dropped (no image handling configured)`);
  const markdown = out.join('\n\n').trim();
  return { markdown, meta: { kind: 'pptx', chars: markdown.length, scannedPages: [], ocrPages: [], warnings } };
}

// --- XLSX ------------------------------------------------------------------

type Grid = Map<number, Map<number, string>>; // row → (col → text)
type Region = { rStart: number; rEnd: number; cStart: number; cEnd: number };

/** 1-based column number → A1 letters (1→A, 27→AA). */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Group sorted numbers into contiguous runs (split wherever there's a gap). */
function runs(sorted: number[]): [number, number][] {
  if (!sorted.length) return [];
  const out: [number, number][] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else {
      out.push([start, prev]);
      start = prev = sorted[i];
    }
  }
  out.push([start, prev]);
  return out;
}

/** Split a populated grid into rectangular table regions: row bands × col bands. */
function findRegions(grid: Grid): Region[] {
  const regions: Region[] = [];
  for (const [rStart, rEnd] of runs([...grid.keys()].sort((a, b) => a - b))) {
    const cols = new Set<number>();
    for (let r = rStart; r <= rEnd; r++) for (const c of grid.get(r)?.keys() ?? []) cols.add(c);
    for (const [cStart, cEnd] of runs([...cols].sort((a, b) => a - b))) {
      // Trim rows to those actually populated within THESE columns, so a table
      // sharing a row-band but starting lower isn't padded with empty rows.
      let rs = rEnd + 1;
      let re = rStart - 1;
      for (let r = rStart; r <= rEnd; r++) {
        let has = false;
        for (let c = cStart; c <= cEnd; c++) if (grid.get(r)?.has(c)) { has = true; break; }
        if (has) {
          if (r < rs) rs = r;
          re = r;
        }
      }
      if (rs <= re) regions.push({ rStart: rs, rEnd: re, cStart, cEnd });
    }
  }
  return regions;
}

const cleanCell = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** Clean ISO-ish date (cell.text renders raw dates as an ugly JS toString). */
function fmtDate(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** A cell's clean display text — dates normalized, otherwise exceljs's rendered text. */
function cellToText(cell: { value: unknown; text: string }): string {
  const v = cell.value as { result?: unknown } | Date | null;
  if (v instanceof Date) return fmtDate(v);
  if (v && typeof v === 'object' && (v as { result?: unknown }).result instanceof Date) {
    return fmtDate((v as { result: Date }).result);
  }
  return (cell.text || '').trim();
}

/** Render one region as a markdown table (first row = header). Single col → bullet list. */
function renderRegion(grid: Grid, { rStart, rEnd, cStart, cEnd }: Region): string {
  const rows: string[][] = [];
  for (let r = rStart; r <= rEnd; r++) {
    const cells: string[] = [];
    for (let c = cStart; c <= cEnd; c++) cells.push(cleanCell(grid.get(r)?.get(c) ?? ''));
    rows.push(cells);
  }
  if (cEnd === cStart) return rows.map((r) => r[0]).filter(Boolean).map((v) => `- ${v}`).join('\n');
  const [header, ...body] = rows;
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function renderSparseRegion(grid: Grid, region: Region): string {
  const cells: string[] = [];
  for (let r = region.rStart; r <= region.rEnd; r++) {
    for (const [c, value] of grid.get(r) ?? []) {
      if (c >= region.cStart && c <= region.cEnd) cells.push(`- **${colLetter(c)}${r}** · ${cleanCell(value)}`);
    }
  }
  return cells.slice(0, 10_000).join('\n') + (cells.length > 10_000 ? `\n- … ${cells.length - 10_000} additional populated cells omitted` : '');
}

async function extractXlsx(path: string, opts: ExtractOpts): Promise<ExtractResult> {
  const ExcelJS = (await import('exceljs')).default;
  const buf = await readFile(path);
  await loadSafeZip(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);

  const out: string[] = [];
  const warnings: string[] = [];
  let sheets = 0;
  // Keep each sheet's grid (by name) so charts can resolve cell references that
  // aren't cached in the chart XML itself.
  const grids = new Map<string, Grid>();

  const hiddenSheets: string[] = [];
  wb.eachSheet((ws) => {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') {
      hiddenSheets.push(ws.name);
      return;
    }

    // Sparse grid of only the non-empty cells (uses each cell's displayed text).
    // Absolute row/column coordinates are retained, so blank cells inside a
    // populated region become explicit empty Markdown cells rather than shifting data.
    const grid: Grid = new Map();
    const formulas: string[] = [];
    let omittedFormulas = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const merged = cell as typeof cell & { isMerged?: boolean; master?: { address?: string }; address?: string };
        if (merged.isMerged && merged.master?.address && merged.master.address !== merged.address) return;
        const text = cellToText(cell);
        const value = cell.value as { formula?: string; sharedFormula?: string } | null;
        // ExcelJS's cell.formula getter translates shared formulas for the current
        // coordinate; value.sharedFormula is only the master-cell reference.
        const formula = (cell as typeof cell & { formula?: string }).formula ?? (value && typeof value === 'object' ? value.formula : undefined);
        if (formula) {
          if (formulas.length < 500) formulas.push(`- **${cell.address}** · \`=${formula.replace(/`/g, '\\`')}\`${text ? ` · cached result: ${cleanCell(text)}` : ' · *(no cached result)*'}`);
          else omittedFormulas++;
        }
        if (!text) return;
        if (!grid.has(r)) grid.set(r, new Map());
        grid.get(r)!.set(c, text);
      });
    });
    if (!grid.size && !formulas.length) return; // empty sheet
    grids.set(ws.name, grid);

    sheets++;
    const regions = findRegions(grid);
    const parts: string[] = [`## ${ws.name}`];
    for (const region of regions) {
      // Caption each table with its A1 range only when the sheet has several.
      if (regions.length > 1) {
        parts.push(`**${colLetter(region.cStart)}${region.rStart}:${colLetter(region.cEnd)}${region.rEnd}**`);
      }
      const area = (region.rEnd - region.rStart + 1) * (region.cEnd - region.cStart + 1);
      if (area > MAX_XLSX_REGION_CELLS) {
        parts.push(renderSparseRegion(grid, region));
        warnings.push(`${ws.name} range ${colLetter(region.cStart)}${region.rStart}:${colLetter(region.cEnd)}${region.rEnd} was too sparse/large for a Markdown grid; emitted coordinate-value entries.`);
      } else parts.push(renderRegion(grid, region));
    }
    if (formulas.length) {
      parts.push(`### Formulas\n\n> Cached results are stored workbook values; formulas were not recalculated during extraction.\n\n${formulas.join('\n')}${omittedFormulas ? `\n\n- … ${omittedFormulas} additional formulas omitted` : ''}`);
      warnings.push(`${ws.name} contains formulas whose cached results may be stale.`);
    }
    const merges = ((ws.model as unknown as { merges?: string[] }).merges ?? []).slice(0, 500);
    if (merges.length) {
      const rows = merges.map((range) => {
        const anchor = range.split(':')[0];
        const value = cellToText(ws.getCell(anchor));
        return `- **${range}**${value ? ` · ${cleanCell(value)}` : ''}`;
      });
      parts.push(`### Merged ranges\n\n${rows.join('\n')}`);
    }
    out.push(parts.join('\n\n'));
  });
  if (hiddenSheets.length) warnings.push(`hidden sheets omitted: ${hiddenSheets.join(', ')}`);

  // Charts are vector definitions (not raster) — read them precisely from the XML,
  // render a clean SVG, and (if image-saving is on) save it as an embeddable figure.
  const charts = await extractXlsxCharts(buf, opts, grids);
  if (charts) out.push(charts);

  if (!sheets && !charts) warnings.push('no readable data found in the spreadsheet');
  const markdown = out.join('\n\n').trim();
  return { markdown, meta: { kind: 'xlsx', chars: markdown.length, scannedPages: [], ocrPages: [], warnings } };
}

const CHART_TYPES: Record<string, string> = {
  'c:barChart': 'bar', 'c:bar3DChart': 'bar', 'c:lineChart': 'line', 'c:line3DChart': 'line',
  'c:pieChart': 'pie', 'c:pie3DChart': 'pie', 'c:ofPieChart': 'pie', 'c:doughnutChart': 'doughnut',
  'c:scatterChart': 'scatter', 'c:areaChart': 'area', 'c:area3DChart': 'area', 'c:radarChart': 'radar',
  'c:bubbleChart': 'bubble', 'c:stockChart': 'stock', 'c:surfaceChart': 'surface',
};

/** First non-empty text value of `tag` (a:t or c:v) under a node. */
function firstText(node: unknown, tag: string): string {
  for (const f of findAll(node, tag)) {
    const t = typeof f === 'string' || typeof f === 'number' ? String(f) : ((f as { '#text'?: string })?.['#text'] ?? '');
    if (t.trim()) return t.trim();
  }
  return '';
}

/** One chart's XML → a precise textual summary (type · title · series · data ranges). */
function summarizeChart(doc: unknown): string {
  const kinds = [...new Set(Object.entries(CHART_TYPES).filter(([tag]) => findAll(doc, tag).length).map(([, n]) => n))];
  const title = nodeText(findAll(doc, 'c:title')[0]).trim();
  const names: string[] = [];
  const ranges = new Set<string>();
  for (const ser of findAll(doc, 'c:ser')) {
    const name = nodeText(findAll(ser, 'c:tx')[0]).trim() || firstText(ser, 'c:v');
    if (name) names.push(name);
    for (const f of findAll(ser, 'c:f')) {
      const r = typeof f === 'string' ? f : ((f as { '#text'?: string })?.['#text'] ?? '');
      if (r.trim()) ranges.add(r.trim());
    }
  }
  const bits = [`**[Chart]** ${title ? `“${title}”` : '(untitled)'} — ${kinds.join('/') || 'chart'} chart`];
  if (names.length) bits.push(`· series: ${names.join(', ')}`);
  if (ranges.size) bits.push(`· data: ${[...ranges].join('; ')}`);
  return bits.join(' ');
}

/** Cached <c:pt idx><c:v> values under a node (c:cat / c:val / …), honoring sparse idx. */
function ptCache(node: unknown): string[] {
  const out: string[] = [];
  for (const p of findAll(node, 'c:pt')) {
    const idx = Number((p as { '@_idx'?: string | number })['@_idx']);
    out[Number.isFinite(idx) ? idx : out.length] = firstText(p, 'c:v');
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
  return out;
}

/** The cell reference (<c:f>Sheet1!$B$2:$B$5</c:f>) under a node, if any. */
function refOf(node: unknown): string {
  for (const f of findAll(node, 'c:f')) {
    const r = typeof f === 'string' ? f : ((f as { '#text'?: string })?.['#text'] ?? '');
    if (r.trim()) return r.trim();
  }
  return '';
}

/** A1 column letters → 1-based column number. */
function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Resolve a chart cell reference against the parsed sheet grids (fallback when uncached). */
function resolveRef(ref: string, grids: Map<string, Grid>): string[] {
  const bang = ref.lastIndexOf('!');
  if (bang < 0) return [];
  const sheet = ref.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const grid = grids.get(sheet);
  if (!grid) return [];
  const cell = (s: string): { r: number; c: number } | null => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(s.trim());
    return m ? { c: colToNum(m[1]), r: Number(m[2]) } : null;
  };
  const [aRaw, bRaw] = ref.slice(bang + 1).replace(/\$/g, '').split(':');
  const a = cell(aRaw);
  const b = bRaw ? cell(bRaw) : a;
  if (!a || !b) return [];
  const out: string[] = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push(grid.get(r)?.get(c) ?? '');
  }
  return out;
}

/** Values for a series node: cached if present, else resolved from the sheet. */
function seriesValues(node: unknown, grids: Map<string, Grid>): string[] {
  const cached = ptCache(node);
  if (cached.some((v) => v !== '')) return cached;
  return resolveRef(refOf(node), grids);
}

/** Parse a chart's XML into renderable data (type, title, categories, numeric series). */
export function parseChartData(doc: unknown, grids: Map<string, Grid>): ChartData | null {
  const kind = [...new Set(Object.entries(CHART_TYPES).filter(([tag]) => findAll(doc, tag).length).map(([, n]) => n))][0] ?? '';
  const title = nodeText(findAll(doc, 'c:title')[0]).trim();

  const series: ChartSeries[] = [];
  let categories: string[] = [];
  for (const ser of findAll(doc, 'c:ser')) {
    const txNode = findAll(ser, 'c:tx')[0];
    const name = (firstText(txNode, 'c:v') || nodeText(txNode)).trim() || `Series ${series.length + 1}`;
    const valNode = findAll(ser, 'c:val')[0] ?? findAll(ser, 'c:yVal')[0];
    if (!valNode) continue;
    const values = seriesValues(valNode, grids).map((value) => {
      if (!value.trim()) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    });
    if (!values.length) continue;
    if (!categories.length) {
      const catNode = findAll(ser, 'c:cat')[0] ?? findAll(ser, 'c:xVal')[0];
      if (catNode) categories = seriesValues(catNode, grids);
    }
    series.push({ name, values });
  }
  if (!series.length) return null;
  return { kind, title, categories, series };
}

async function extractXlsxCharts(buf: Buffer, opts: ExtractOpts, grids: Map<string, Grid>): Promise<string> {
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const zip = await loadSafeZip(buf);
  const referencedCharts = new Set<string>();
  for (const relName of Object.keys(zip.files).filter((name) => /^xl\/drawings\/_rels\/.+\.rels$/.test(name))) {
    const relFile = zip.file(relName);
    if (!relFile) continue;
    const relDoc = parser.parse(await relFile.async('text'));
    for (const relationship of findAll(relDoc, 'Relationship')) {
      const rel = relationship as { '@_Target'?: string; '@_Type'?: string };
      if (rel['@_Type']?.includes('/chart') && rel['@_Target']) referencedCharts.add(rel['@_Target'].split('/').pop()!);
    }
  }
  const files = Object.keys(zip.files)
    .filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name) && referencedCharts.has(name.split('/').pop()!))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const blocks: string[] = [];
  for (const name of files) {
    try {
      const doc = parser.parse(await zip.file(name)!.async('text'));
      const summary = summarizeChart(doc);
      if (!summary) continue;
      const data = parseChartData(doc, grids);
      let block = `> ${summary}`;
      if (data) {
        const categories = data.categories.slice(0, 50);
        for (const series of data.series.slice(0, 10)) {
          const points = series.values.slice(0, 50).map((value, index) => `${categories[index] || `Point ${index + 1}`}=${value === null ? '(blank)' : value}`);
          block += `\n> - ${cleanCell(series.name)}: ${points.join(', ')}${series.values.length > 50 ? ', …' : ''}`;
        }
        if (data.series.length > 10) block += `\n> - … ${data.series.length - 10} additional series omitted`;
      }
      // Render the chart to an SVG and save it as an embeddable figure.
      if (opts.saveImage) {
        const svg = data ? renderChartSvg(data) : null;
        if (svg) {
          try {
            const saved = await opts.saveImage(new Uint8Array(Buffer.from(svg, 'utf8')), 'svg');
            block += `\n>\n> ↳ Extracted chart asset: ${saved}`;
          } catch {
            /* keep the text summary if saving fails */
          }
        }
      }
      blocks.push(block);
    } catch {
      /* skip malformed chart */
    }
  }
  return blocks.length ? ['## Charts', ...blocks].join('\n\n') : '';
}

/** Raw pdf.js pixel data (1/3/4 channels) → PNG bytes for vision. */
async function rgbaToPng(data: Uint8ClampedArray, w: number, h: number, channels: 1 | 3 | 4): Promise<Uint8Array> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const rgba = img.data;
  if (channels === 4) {
    rgba.set(data);
  } else {
    for (let i = 0, j = 0; i < w * h; i++) {
      if (channels === 1) {
        const g = data[i];
        rgba[j++] = g; rgba[j++] = g; rgba[j++] = g; rgba[j++] = 255;
      } else {
        rgba[j++] = data[i * 3]; rgba[j++] = data[i * 3 + 1]; rgba[j++] = data[i * 3 + 2]; rgba[j++] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

// ── Born-digital PDF structure reconstruction ────────────────────────────────
// unpdf's extractText flattens a page into raw text — headings, paragraphs, and
// bullets all arrive equally bland. pdf.js exposes each text item's font size,
// position, and advance width, which is enough to rebuild what a typical
// document PDF actually has: heading tiers (font size vs the page's body size),
// paragraphs (vertical gaps + de-hyphenated joins), and bullet lines. Tables
// are NOT reconstructed — positioned-text table detection is too unreliable to
// guess at, so they degrade to plain lines exactly as before.

interface PdfLine {
  text: string;
  size: number;
  bold: boolean;
  gapBefore: number;
  width: number;
  /** Text runs separated by column-sized horizontal gaps — 1 cell = normal prose. */
  cells: { x: number; text: string }[];
  /** Finer word-group runs (small-gap splits) — the table pass regroups these
   *  against a run's established column positions for rows whose own gutters
   *  are too narrow to split confidently. */
  chunks: { x: number; text: string }[];
}

async function pdfPageStructured(pdf: unknown, pageNo: number): Promise<string> {
  const page = await (pdf as { getPage(n: number): Promise<any> }).getPage(pageNo);
  const content = await page.getTextContent();
  const styles: Record<string, { fontFamily?: string }> = content.styles ?? {};
  interface Placed { str: string; x: number; y: number; width: number; size: number; bold: boolean }
  const placed: Placed[] = (content.items as any[])
    .filter((it) => typeof it.str === 'string' && it.str.trim())
    .map((it) => {
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      const family = styles[it.fontName ?? '']?.fontFamily ?? String(it.fontName ?? '');
      return {
        str: it.str as string,
        x: it.transform[4] as number,
        y: it.transform[5] as number,
        width: (it.width as number) || 0,
        size,
        bold: /bold|black|heavy/i.test(family),
      };
    });
  if (!placed.length) return '';

  // Top-to-bottom, then cluster into visual lines by baseline y.
  placed.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  let cur: Placed[] = [];
  let prevY: number | null = null;
  const flush = (): void => {
    if (!cur.length) return;
    cur.sort((a, b) => a.x - b.x);
    let text = cur[0].str;
    const cells: { x: number; text: string }[] = [{ x: cur[0].x, text: cur[0].str }];
    const chunks: { x: number; text: string }[] = [{ x: cur[0].x, text: cur[0].str }];
    for (let i = 1; i < cur.length; i++) {
      const p = cur[i - 1];
      const gap = cur[i].x - (p.x + p.width);
      if (gap > p.size * 1.5) {
        cells.push({ x: cur[i].x, text: cur[i].str }); // column gutter → new cell
      } else {
        cells[cells.length - 1].text += (gap > p.size * 0.25 ? ' ' : '') + cur[i].str;
      }
      if (gap > p.size * 0.7) {
        chunks.push({ x: cur[i].x, text: cur[i].str });
      } else {
        chunks[chunks.length - 1].text += (gap > p.size * 0.25 ? ' ' : '') + cur[i].str;
      }
      text += (gap > p.size * 0.25 ? ' ' : '') + cur[i].str;
    }
    const size = Math.max(...cur.map((c) => c.size));
    const boldRun = cur.filter((c) => c.bold).length >= cur.length / 2;
    const y = cur[0].y;
    const end = cur[cur.length - 1];
    lines.push({
      text: text.replace(/\s+/g, ' ').trim(),
      size,
      bold: boldRun,
      gapBefore: prevY === null ? Number.POSITIVE_INFINITY : prevY - y,
      width: end.x + end.width - cur[0].x,
      cells: cells.map((c) => ({ x: c.x, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text),
      chunks: chunks.map((c) => ({ x: c.x, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text),
    });
    prevY = y;
    cur = [];
  };
  for (const p of placed) {
    if (cur.length && Math.abs(p.y - cur[0].y) > Math.max(2, cur[0].size * 0.45)) flush();
    cur.push(p);
  }
  flush();
  const kept = lines.filter((l) => l.text);
  if (!kept.length) return '';

  // Body size = char-weighted median; heading tiers are RELATIVE to it.
  const sizes: number[] = [];
  for (const l of kept) for (let i = 0; i < l.text.length; i++) sizes.push(l.size);
  sizes.sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 10;

  const tier = (l: PdfLine): number => {
    if (l.text.length > 110 || /[.:;,]$/.test(l.text)) return 0; // sentences aren't headings
    const r = l.size / body;
    if (r >= 1.7) return 1;
    if (r >= 1.35) return 2;
    if (r >= 1.12 && l.bold) return 3;
    return 0;
  };
  // A page where "everything is a heading" (uniform large fonts, posters) is
  // telling us the heuristic doesn't apply — fall back to plain paragraphs.
  const headingsOk = kept.filter((l) => tier(l) > 0).length <= kept.length * 0.4;

  // Reflow: join a line into the running paragraph ONLY when the previous line
  // reads as wrapped prose — near-full width, no sentence-terminal punctuation,
  // and a normal (page-median) line gap. Short lines (table rows, sub-heads,
  // paragraph endings) keep their own line, so tables never melt into a blob.
  const gaps = kept
    .slice(1)
    .map((l) => l.gapBefore)
    .filter((g) => Number.isFinite(g) && g > 0 && g < body * 4)
    .sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length / 2)] || body * 1.2;
  const widths = kept.map((l) => l.width).sort((a, b) => a - b);
  const fullWidth = widths[Math.floor(widths.length * 0.9)] || 1;

  // Table pass: a run of ≥3 consecutive lines with the SAME cell count (2–8) and
  // column starts that line up becomes a markdown table (first row = header).
  // Anything short of that stays plain lines — a wrongly-guessed table is worse
  // than no table.
  const rowish = (l: PdfLine): boolean => l.cells.length >= 2 && l.cells.length <= 8;
  // Assign a line's word-chunks to a run's established column positions — the
  // rescue path for rows whose own gutters were too narrow to split on. Returns
  // the cells only if every column gets text (a partial match is not a row).
  const regroup = (l: PdfLine, colXs: number[]): string[] | null => {
    if (l.chunks.length < colXs.length) return null;
    const cells: string[] = colXs.map(() => '');
    for (const ch of l.chunks) {
      let k = 0;
      for (let c = colXs.length - 1; c > 0; c--) {
        if (ch.x >= colXs[c] - body) {
          k = c;
          break;
        }
      }
      cells[k] += (cells[k] ? ' ' : '') + ch.text;
    }
    return cells.every((c) => c) ? cells : null;
  };
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const blocks: (PdfLine | { table: string })[] = [];
  for (let i = 0; i < kept.length; ) {
    if (rowish(kept[i])) {
      const colXs = kept[i].cells.map((c) => c.x);
      const rows: string[][] = [kept[i].cells.map((c) => c.text)];
      let j = i + 1;
      while (j < kept.length && kept[j].gapBefore <= lineGap * 2.2) {
        const direct =
          kept[j].cells.length === colXs.length &&
          kept[j].cells.every((c, k) => Math.abs(c.x - colXs[k]) <= body * 2);
        const cells = direct ? kept[j].cells.map((c) => c.text) : regroup(kept[j], colXs);
        if (!cells) break;
        rows.push(cells);
        j++;
      }
      if (rows.length >= 3) {
        const row = (cells: string[]): string => `| ${cells.map(esc).join(' | ')} |`;
        blocks.push({ table: [row(rows[0]), `|${' --- |'.repeat(colXs.length)}`, ...rows.slice(1).map(row)].join('\n') });
        i = j;
        continue;
      }
    }
    blocks.push(kept[i]);
    i++;
  }

  const BULLET = /^[•▪◦●·‣∙*–—-]\s+/;
  const parts: string[] = [];
  let para: string[] = [];
  let last: PdfLine | null = null; // the line the paragraph currently ends on
  const endPara = (): void => {
    if (para.length) {
      parts.push(para.join(' '));
      para = [];
    }
    last = null;
  };
  for (const b of blocks) {
    if ('table' in b) {
      endPara();
      parts.push(b.table);
      continue;
    }
    const l = b;
    const t = headingsOk ? tier(l) : 0;
    if (t) {
      endPara();
      parts.push(`${'#'.repeat(t)} ${l.text}`);
      continue;
    }
    if (BULLET.test(l.text)) {
      endPara();
      parts.push(`- ${l.text.replace(BULLET, '')}`);
      continue;
    }
    const joinable =
      !!last &&
      last.cells.length < 2 && // a stray table-ish row never absorbs the next line
      l.cells.length < 2 &&
      l.gapBefore <= lineGap * 1.4 &&
      last.width >= fullWidth * 0.7 &&
      !/[.!?:;]\s*$/.test(last.text);
    if (para.length && !joinable) endPara();
    if (para.length && /[a-z]-$/.test(para[para.length - 1]) && /^[a-z]/.test(l.text)) {
      // De-hyphenate a word split across lines.
      para[para.length - 1] = para[para.length - 1].slice(0, -1) + l.text;
    } else {
      para.push(l.text);
    }
    last = l;
  }
  endPara();
  return parts.join('\n\n').trim();
}

interface PdfImage { data: Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 }

/** Embedded figures on a text PDF page → saved/described figure blocks. Skips tiny icons. */
async function pdfPageFigures(pdf: unknown, pageNo: number, opts: ExtractOpts): Promise<string[]> {
  const { extractImages } = await import('unpdf');
  let images: PdfImage[];
  try {
    images = (await extractImages(pdf as never, pageNo)) as unknown as PdfImage[];
  } catch {
    return [];
  }
  const figures: string[] = [];
  for (const img of images) {
    if (img.width < 64 || img.height < 64) continue; // decorative icon/bullet/rule
    try {
      const png = await rgbaToPng(img.data, img.width, img.height, img.channels);
      const block = await figureBlock(png, 'image/png', 'png', opts);
      if (block) figures.push(block);
    } catch {
      /* skip on failure */
    }
  }
  return figures;
}

async function extractPdf(path: string, opts: ExtractOpts): Promise<ExtractResult> {
  const { ocr, onProgress } = opts;
  const { getDocumentProxy, extractText } = await import('unpdf');
  const bytes = new Uint8Array(await readFile(path));
  // pdf.js transfers/detaches `bytes` to its worker, so keep a pristine copy for
  // rendering scanned pages (each ocr call gets a fresh slice off this).
  const ocrBytes = ocr ? bytes.slice() : undefined;
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages: string[] = Array.isArray(text) ? text : [text];

  const scannedPages: number[] = [];
  const ocrPages: number[] = [];
  const warnings: string[] = [];
  const out: string[] = [];
  const maxOcr = opts.maxOcrPages ?? 100; // cap vision calls per file (cost guard)
  let ocrAttempts = 0;

  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const body = (pages[i] ?? '').trim();
    out.push(`## Page ${pageNo}`);
    if (body.replace(/\s+/g, '').length >= MIN_PAGE_CHARS) {
      // Structure-aware rebuild (headings/paragraphs/bullets); a page the
      // heuristic can't read (or an item-level pdf.js error) keeps unpdf's text.
      let structured = '';
      try {
        structured = await pdfPageStructured(pdf, pageNo);
      } catch {
        structured = '';
      }
      // Page markers own level 2; nest reconstructed headings beneath them.
      const pageMarkdown = (structured || body).replace(/^(#{1,4}) /gm, (_match, hashes: string) => `${'#'.repeat(Math.min(6, hashes.length + 2))} `);
      out.push(pageMarkdown);
      if (opts.describeImage || opts.saveImage) {
        const figs = await pdfPageFigures(pdf, pageNo, opts); // embedded figures → saved/described
        if (figs.length) out.push(figs.join('\n\n'));
      }
    } else if (ocr && ocrAttempts < maxOcr) {
      // No text layer → scanned page; OCR it (the slow, per-page cloud step).
      scannedPages.push(pageNo);
      ocrAttempts++;
      try {
        const md = (await ocr(ocrBytes!.slice(), pageNo)).trim();
        if (md) {
          out.push(md);
          ocrPages.push(pageNo);
        } else {
          out.push(`<!-- page ${pageNo}: scanned, OCR returned empty -->`);
        }
      } catch (e) {
        warnings.push(`page ${pageNo} OCR failed: ${(e as Error).message}`);
        out.push(`<!-- page ${pageNo}: scanned, OCR failed -->`);
      }
    } else if (ocr) {
      // OCR available, but the per-file page cap is reached (cost guard).
      scannedPages.push(pageNo);
      out.push(`<!-- page ${pageNo}: scanned; OCR page limit (${maxOcr}) reached, skipped -->`);
    } else {
      scannedPages.push(pageNo);
      out.push(`<!-- page ${pageNo}: scanned (no text layer); OCR not run -->`);
    }
    onProgress?.(pageNo, pages.length);
  }
  if (ocr && scannedPages.length > ocrAttempts) {
    warnings.push(`OCR limited to ${maxOcr} pages; ${scannedPages.length - ocrAttempts} scanned page(s) skipped`);
  }

  const markdown = out.join('\n\n').trim();
  return { markdown, meta: { kind: 'pdf', chars: markdown.length, pages: totalPages, scannedPages, ocrPages, warnings } };
}

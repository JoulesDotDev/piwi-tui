import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extract } from '../lib/document-extractor.ts';

const root = resolve(import.meta.dir, '..');
const temp = mkdtempSync(join(tmpdir(), 'piwi-extraction-'));
const expect = (label: string, condition: unknown): void => { if (!condition) throw new Error(`Extraction regression: ${label}`); };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function makeDocx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Structured Report</w:t></w:r></w:p><w:p><w:r><w:t>Introductory paragraph.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Quality</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>');
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

function makePdf(path: string): void {
  const streams = [
    'BT /F1 18 Tf 72 720 Td (First Page Heading) Tj 0 -32 Td /F1 11 Tf (First page body text.) Tj ET',
    'BT /F1 18 Tf 72 720 Td (Second Page Heading) Tj 0 -32 Td /F1 11 Tf (Second page body text.) Tj ET',
    'BT /F1 11 Tf 72 720 Td (OK) Tj ET',
  ];
  const pageStart = 3;
  const fontObject = pageStart + streams.length;
  const contentStart = fontObject + 1;
  const pages = streams.map((_stream, index) => `${pageStart + index} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages}] /Count ${streams.length} >>`,
    ...streams.map((_stream, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentStart + index} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, pdf, 'binary');
}

async function makePptx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', `
<p:sld><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:txBody><a:p><a:r><a:t>Revenue increased</a:t></a:r></a:p><a:p><a:r><a:t>Costs remained stable</a:t></a:r></a:p><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>Regional detail</a:t></a:r></a:p></p:txBody></p:sp>
  <a:tbl><a:tr><a:tc><a:p><a:r><a:t>Metric</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Value</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>Growth</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>12%</a:t></a:r></a:p></a:tc></a:tr></a:tbl>
  <p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
</p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml', '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Title Only</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  zip.file('ppt/slides/slide3.xml', '<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>');
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/><p:sldId r:id="rId3"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId3" Target="slides/slide3.xml"/></Relationships>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rIdImage" Target="../media/image1.png" Type="image"/><Relationship Id="rIdNotes" Target="../notesSlides/notesSlide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"/></Relationships>');
  zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Discuss regional details</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>');
  zip.file('ppt/media/image1.png', png);
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makeXlsx(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.addRow(['Product', 'Q1', 'Q2', 'Total']);
  sheet.addRow(['Alpha', 10, '', { formula: 'SUM(B2:C2)', result: 10 }]);
  sheet.addRow(['Beta', '', 20, { formula: 'SUM(B3:C3)', result: 20 }]);
  sheet.getCell('A5').value = 'Separate note';
  sheet.mergeCells('A7:B7');
  sheet.getCell('A7').value = 'Merged group';
  const sparse = workbook.addWorksheet('SparseDiagonal');
  for (let i = 1; i <= 400; i++) sparse.getCell(i, i).value = `V${i}`;
  const hidden = workbook.addWorksheet('Internal');
  hidden.state = 'hidden';
  hidden.getCell('A1').value = 'Hidden secret';
  const base = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = await JSZip.loadAsync(base);
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships><Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>');
  zip.file('xl/charts/chart1.xml', `
<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Quarterly Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:v>Revenue</c:v></c:tx><c:cat><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:cat><c:val><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt><c:pt idx="2"><c:v></c:v></c:pt></c:numCache></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`);
  zip.file('xl/charts/chart2.xml', '<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Orphan Chart</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>');
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

try {
  const docx = join(temp, 'structured.docx');
  await makeDocx(docx);
  const doc = await extract(docx);
  expect('DOCX heading retained', doc.markdown.includes('# Structured Report'));
  expect('DOCX paragraph retained', doc.markdown.includes('Introductory paragraph.'));
  expect('DOCX table retained', doc.markdown.includes('| Metric | Value |') && doc.markdown.includes('| Quality | High |'));

  const pdf = join(temp, 'pages.pdf');
  makePdf(pdf);
  const pages = await extract(pdf);
  expect('PDF page boundaries retained', pages.markdown.includes('## Page 1') && pages.markdown.includes('## Page 2') && pages.markdown.includes('## Page 3'));
  expect('PDF page text retained', pages.markdown.includes('First page body text') && pages.markdown.includes('Second page body text'));
  expect('short PDF text retained', pages.markdown.includes('OK') && !pages.meta.scannedPages.includes(3));
  expect('PDF headings nested below pages', !/^# First Page Heading$/m.test(pages.markdown) && !/^## First Page Heading$/m.test(pages.markdown));

  const pptx = join(temp, 'slides.pptx');
  await makePptx(pptx);
  const saved: string[] = [];
  const ppt = await extract(pptx, {
    describeImage: async () => 'A tiny extracted test figure.',
    saveImage: async (_bytes, ext) => { const target = `assets/figure.${ext}`; saved.push(target); return target; },
  });
  expect('slide 1 heading/title', ppt.markdown.includes('## Slide 1 — Quarterly Review'));
  expect('slide body separated', ppt.markdown.includes('Revenue increased\n\nCosts remained stable'));
  expect('slide bullets retained', ppt.markdown.includes('  - Regional detail'));
  expect('slide table', ppt.markdown.includes('| Metric | Value |') && ppt.markdown.includes('| Growth | 12% |'));
  expect('speaker notes', ppt.markdown.includes('**Speaker notes:**') && ppt.markdown.includes('Discuss regional details'));
  expect('image caption and asset', ppt.markdown.includes('A tiny extracted test figure.') && ppt.markdown.includes('assets/figure.png') && saved.length === 1);
  expect('title-only slide retained', ppt.markdown.includes('## Slide 2 — Title Only'));
  expect('blank slide retained', ppt.markdown.includes('## Slide 3'));

  const xlsx = join(temp, 'sparse.xlsx');
  await makeXlsx(xlsx);
  const chartAssets: string[] = [];
  const book = await extract(xlsx, { saveImage: async (_bytes, ext) => { const target = `assets/chart.${ext}`; chartAssets.push(target); return target; } });
  expect('sheet heading', book.markdown.includes('## Data'));
  expect('sparse alpha row keeps empty Q2', book.markdown.includes('| Alpha | 10 |  | 10 |'));
  expect('sparse beta row keeps empty Q1', book.markdown.includes('| Beta |  | 20 | 20 |'));
  expect('separate range retained', book.markdown.includes('Separate note'));
  expect('merged cell emitted once', (book.markdown.match(/Merged group/g) ?? []).length >= 1 && book.markdown.includes('**A7:B7**'));
  expect('formula text retained', book.markdown.includes('**D2**') && book.markdown.includes('=SUM(B2:C2)') && book.markdown.includes('cached result: 10')); 
  expect('formula freshness warning', book.meta.warnings.some((warning) => warning.includes('may be stale')));
  expect('hidden sheet warning', book.meta.warnings.some((warning) => warning.includes('Internal')) && !book.markdown.includes('Hidden secret'));
  expect('large sparse sheet bounded', book.meta.warnings.some((warning) => warning.includes('too sparse/large')) && book.markdown.includes('**OJ400** · V400'));
  expect('chart summary and values', book.markdown.includes('## Charts') && book.markdown.includes('Quarterly Sales') && book.markdown.includes('Revenue') && book.markdown.includes('Q1=10') && book.markdown.includes('Q2=20') && book.markdown.includes('Q3=(blank)'));
  expect('orphan chart ignored', !book.markdown.includes('Orphan Chart'));
  expect('chart SVG asset', chartAssets.some((asset) => asset.endsWith('.svg')) && book.markdown.includes('assets/chart.svg'));

  const guiExtractor = resolve(root, '../app/electron/ingest/extractor.ts');
  const guiChart = resolve(root, '../app/electron/ingest/chart-svg.ts');
  if (existsSync(guiExtractor)) expect('GUI/TUI extractor copies match', readFileSync(guiExtractor).equals(readFileSync(join(root, 'lib/document-extractor.ts'))));
  if (existsSync(guiChart)) expect('GUI/TUI chart copies match', readFileSync(guiChart).equals(readFileSync(join(root, 'lib/chart-svg.ts'))));
  console.log(`extraction quality regressions passed: ${basename(pptx)}, ${basename(xlsx)}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

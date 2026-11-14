/**
 * Export a finished PDF (annotations already drawn in) to other formats.
 * Everything runs on the device; the heavy libraries load only when an export is chosen.
 */
import { zipSync } from 'fflate';
import { pdfjsLib } from './model.js';
import { canvasToBytes } from './util.js';

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  zip: 'application/zip',
  txt: 'text/plain',
};

async function open(bytes, password) {
  return pdfjsLib.getDocument({ data: bytes.slice(), password: password || undefined }).promise;
}

/** Render every page of a PDF to image bytes. */
export async function renderPages(bytes, { dpi = 150, type = 'image/png', quality = 0.9, password, onProgress } = {}) {
  const pdf = await open(bytes, password);
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i - 1, pdf.numPages);
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    out.push({ bytes: await canvasToBytes(c, type, quality), w: vp.width / (dpi / 72), h: vp.height / (dpi / 72), px: [c.width, c.height] });
    c.width = 0;
  }
  await pdf.destroy();
  return out;
}

/* ---------------- reading text back with its layout ---------------- */

/** Lines of text on a page, top to bottom, each with positioned segments. Coordinates in points. */
async function pageLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(m[1]) > 0.02 * Math.abs(m[0]) + 0.01) continue;
    const fh = Math.hypot(m[2], m[3]);
    if (fh < 2) continue;
    let fontName = '';
    try {
      fontName = (page.commonObjs.get(it.fontName)?.name || '') + ' ' + (tc.styles[it.fontName]?.fontFamily || '');
    } catch {}
    items.push({ str: it.str, x: m[4], base: m[5], w: it.width, fh, bold: /bold|black|heavy|semibold/i.test(fontName), italic: /ital|obliq/i.test(fontName) });
  }
  items.sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const L = lines.find((l) => Math.abs(l.base - it.base) < it.fh * 0.35);
    if (L) L.segs.push(it);
    else lines.push({ base: it.base, fh: it.fh, segs: [it] });
  }
  for (const l of lines) {
    l.segs.sort((a, b) => a.x - b.x);
    // Merge pieces that touch into one segment; a wide gap starts a new one (a new column).
    const merged = [];
    for (const s of l.segs) {
      const last = merged[merged.length - 1];
      const gap = last ? s.x - (last.x + last.w) : Infinity;
      if (last && gap < s.fh * 1.5) {
        last.str += (gap > s.fh * 0.15 && !last.str.endsWith(' ') && !s.str.startsWith(' ') ? ' ' : '') + s.str;
        last.w = s.x + s.w - last.x;
        last.bold &&= s.bold;
      } else merged.push({ ...s });
    }
    l.segs = merged;
    l.fh = Math.max(...merged.map((s) => s.fh));
    l.x = merged[0].x;
    l.text = merged.map((s) => s.str).join('\t');
  }
  lines.sort((a, b) => a.base - b.base);
  return { lines, w: vp.width, h: vp.height };
}

/* ---------------- Word ---------------- */

/**
 * mode 'text': editable paragraphs, headings and line breaks; pages without text (scans) are kept as pictures.
 * mode 'layout': every page as a full-page picture, which looks exactly like the PDF but is not editable.
 */
export async function toDocx(bytes, { mode = 'text', password, onProgress } = {}) {
  const D = await import('docx');
  const pdf = await open(bytes, password);
  const sections = [];
  const pics = mode === 'layout' ? await renderPages(bytes, { dpi: 150, type: 'image/jpeg', quality: 0.88, password }) : null;
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i - 1, pdf.numPages);
    const page = await pdf.getPage(i);
    const { lines, w, h } = await pageLines(page);
    const pageProps = { page: { size: { width: Math.round(w * 20), height: Math.round(h * 20) }, margin: mode === 'layout' ? { top: 0, bottom: 0, left: 0, right: 0 } : { top: 1000, bottom: 1000, left: 1100, right: 1100 } } };
    const chars = lines.reduce((n, l) => n + l.text.length, 0);
    if (mode === 'layout' || chars < 20) {
      const pic = pics?.[i - 1] || (await renderPages(await pageOnly(bytes, i, password), { dpi: 150, type: 'image/jpeg', quality: 0.88 }))[0];
      const maxW = mode === 'layout' ? w : w - 110;
      const scale = Math.min(1, maxW / w);
      sections.push({
        properties: pageProps,
        children: [new D.Paragraph({ children: [new D.ImageRun({ type: 'jpg', data: pic.bytes, transformation: { width: Math.round(w * scale * (96 / 72)), height: Math.round(h * scale * (96 / 72)) } })] })],
      });
      continue;
    }
    const sizes = lines.map((l) => l.fh).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 11;
    const left = Math.min(...lines.map((l) => l.x));
    const paras = [];
    let cur = null;
    lines.forEach((l, n) => {
      const prev = lines[n - 1];
      const gap = prev ? l.base - prev.base : 0;
      const heading = l.fh >= body * 1.3;
      const breakPara = !cur || heading || cur.heading || gap > Math.max(l.fh, prev.fh) * 1.65 || Math.abs(l.fh - prev.fh) > body * 0.2 || /^[•▪◦\-–]\s|^\d+[.)]\s/.test(l.text);
      if (breakPara) {
        cur = { heading, size: l.fh, indent: l.x - left, runs: [] };
        paras.push(cur);
      } else cur.runs.push({ text: ' ' });
      for (const s of l.segs) cur.runs.push({ text: s.str + (s === l.segs[l.segs.length - 1] ? '' : '\t'), bold: s.bold, italic: s.italic });
    });
    sections.push({
      properties: pageProps,
      children: paras.map(
        (p) =>
          new D.Paragraph({
            spacing: { after: 120 },
            indent: p.indent > 8 ? { left: Math.round(p.indent * 20) } : undefined,
            children: p.runs.map((r) => new D.TextRun({ text: r.text, bold: r.bold || p.heading, italics: r.italic, size: Math.round(Math.min(72, Math.max(7, p.size)) * 2) })),
          }),
      ),
    });
  }
  await pdf.destroy();
  const doc = new D.Document({ sections });
  return new Uint8Array(await (await D.Packer.toBlob(doc)).arrayBuffer());
}

async function pageOnly(bytes, n, password) {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const src = await PDFDocument.load(bytes, { password: password || '' });
  const d = await PDFDocument.create();
  const [p] = await d.copyPages(src, [n - 1]);
  d.addPage(p);
  return d.save();
}

/* ---------------- Excel ---------------- */

const NUM = /^\s*([-+(]?)\s*[$€£¥₱]?\s*(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*(%?)\)?\s*$/;
function asValue(s) {
  const m = s.match(NUM);
  if (!m) return s.trim();
  let v = parseFloat(s.replace(/[^\d.]/g, ''));
  if (m[1] === '-' || m[1] === '(') v = -v;
  if (m[5]) v /= 100;
  return v;
}

/** One worksheet per page. Text that lines up vertically is placed in the same column. */
export async function toXlsx(bytes, { password, onProgress } = {}) {
  const ExcelJS = (await import('exceljs/dist/exceljs.min.js')).default;
  const wb = new ExcelJS.Workbook();
  const pdf = await open(bytes, password);
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i - 1, pdf.numPages);
    const { lines } = await pageLines(await pdf.getPage(i));
    const ws = wb.addWorksheet(`Page ${i}`);
    if (!lines.length) {
      ws.getCell('A1').value = 'No text on this page. Run "Recognize text (OCR)" first for scanned pages.';
      continue;
    }
    // Column anchors: cluster the left edges of segments.
    const xs = lines.flatMap((l) => l.segs.map((s) => s.x)).sort((a, b) => a - b);
    const anchors = [];
    for (const x of xs) if (!anchors.length || x - anchors[anchors.length - 1] > 14) anchors.push(x);
    const widths = anchors.map(() => 8);
    lines.forEach((l, r) => {
      let lastCol = -1;
      for (const s of l.segs) {
        let col = 0;
        for (let k = 0; k < anchors.length; k++) if (anchors[k] <= s.x + 7) col = k;
        if (col <= lastCol) col = lastCol + 1;
        lastCol = col;
        const cell = ws.getCell(r + 1, col + 1);
        cell.value = asValue(s.str);
        if (s.bold) cell.font = { bold: true };
        widths[col] = Math.max(widths[col] || 8, Math.min(60, s.str.length + 2));
      }
    });
    widths.forEach((w, k) => (ws.getColumn(k + 1).width = w));
  }
  await pdf.destroy();
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/* ---------------- PowerPoint ---------------- */

export async function toPptx(bytes, { password, onProgress } = {}) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pages = await renderPages(bytes, { dpi: 150, type: 'image/jpeg', quality: 0.9, password, onProgress });
  const pres = new PptxGenJS();
  const { w, h } = pages[0];
  pres.defineLayout({ name: 'PDF', width: w / 72, height: h / 72 });
  pres.layout = 'PDF';
  for (const p of pages) {
    const slide = pres.addSlide();
    const k = Math.min(w / p.w, h / p.h);
    const sw = (p.w * k) / 72;
    const sh = (p.h * k) / 72;
    let b64 = '';
    for (let i = 0; i < p.bytes.length; i += 0x8000) b64 += String.fromCharCode(...p.bytes.subarray(i, i + 0x8000));
    slide.addImage({ data: 'data:image/jpeg;base64,' + btoa(b64), x: (w / 72 - sw) / 2, y: (h / 72 - sh) / 2, w: sw, h: sh });
  }
  return new Uint8Array(await pres.write({ outputType: 'uint8array' }));
}

/* ---------------- images / text ---------------- */

export async function toImages(bytes, base, { format = 'png', dpi = 150, password, onProgress } = {}) {
  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const pages = await renderPages(bytes, { dpi, type, quality: 0.9, password, onProgress });
  if (pages.length === 1) return { name: `${base}.${format}`, bytes: pages[0].bytes, mime: MIME[format] };
  const files = {};
  pages.forEach((p, i) => (files[`${base}-${String(i + 1).padStart(3, '0')}.${format}`] = [p.bytes, { level: 0 }]));
  return { name: `${base}-${format}.zip`, bytes: zipSync(files), mime: MIME.zip };
}

export async function toText(bytes, { password } = {}) {
  const pdf = await open(bytes, password);
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const { lines } = await pageLines(await pdf.getPage(i));
    parts.push(lines.map((l) => l.segs.map((s) => s.str).join('    ')).join('\n'));
  }
  await pdf.destroy();
  return new TextEncoder().encode(parts.join('\n\n\f'));
}

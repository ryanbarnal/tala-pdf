/**
 * Convert other document types into PDF, entirely on the device.
 *
 * Every format is first turned into an HTML page (Word with mammoth, Excel with ExcelJS, PowerPoint and
 * CSV with small parsers here). The HTML then becomes a PDF in one of two ways:
 *  - desktop app: Chromium's own PDF printer (vector, real text);
 *  - browser: each page is drawn to an image, with an invisible text layer on top so the result is
 *    still searchable and selectable.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from '@cantoo/pdf-lib';
import { canvasToBytes } from './util.js';

export const CONVERTIBLE = /\.(docx|xlsx|csv|pptx|txt|md|html?)$/i;
export const UNSUPPORTED_HINT = {
  doc: 'Older Word files (.doc) are not supported. In Word, use File › Save As › Word Document (.docx), then open that.',
  xls: 'Older Excel files (.xls) are not supported. In Excel, use File › Save As › Excel Workbook (.xlsx), then open that.',
  ppt: 'Older PowerPoint files (.ppt) are not supported. In PowerPoint, use File › Save As › PowerPoint Presentation (.pptx), then open that.',
  odt: 'OpenDocument text is not supported yet. Save it as .docx first.',
  ods: 'OpenDocument spreadsheets are not supported yet. Save it as .xlsx first.',
  odp: 'OpenDocument presentations are not supported yet. Save it as .pptx first.',
  rtf: 'RTF is not supported yet. Save it as .docx first.',
};

const PX_PER_PT = 96 / 72;
const A4 = { w: 794, h: 1123 }; // CSS px at 96 dpi
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const BASE_CSS = `
  html { background: #fff; }
  body { margin: 0; color: #111; font: 11pt/1.45 Calibri, Carlito, "Segoe UI", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { font-size: 20pt; margin: 0 0 10pt; } h2 { font-size: 15pt; margin: 14pt 0 8pt; } h3 { font-size: 12.5pt; margin: 12pt 0 6pt; }
  p { margin: 0 0 7pt; } ul, ol { margin: 0 0 7pt; padding-left: 22pt; }
  table { border-collapse: collapse; margin: 0 0 9pt; }
  td, th { border: 1px solid #c4c9d4; padding: 2pt 5pt; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 10pt/1.4 Consolas, "Courier New", monospace; margin: 0; }
  .page-break { break-before: page; }
  .sheet-title { font-size: 12pt; margin: 0 0 6pt; color: #333; }
  .sheet td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .slide { position: relative; overflow: hidden; break-after: page; }
  .slide:last-child { break-after: auto; }
  .slide .box { position: absolute; box-sizing: border-box; overflow: hidden; }
  .slide .box p { margin: 0 0 4pt; }
`;

function wrap(body, page, extraCss = '') {
  const m = page.margin;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${page.w / 96}in ${page.h / 96}in; margin: ${m / 96}in; }
    ${BASE_CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

/* ---------------- sanitising user-supplied HTML ---------------- */

function sanitize(doc) {
  for (const el of doc.querySelectorAll('script, iframe, object, embed, link, meta, base, frame, frameset, form, noscript')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'src' || a.name === 'xlink:href') && (v.startsWith('javascript:') || /^https?:/.test(v)))) {
        el.removeAttribute(a.name);
      }
    }
  }
  return doc;
}

/* ---------------- Word ---------------- */

async function docxToHtml(bytes) {
  const mammoth = (await import('mammoth/mammoth.browser.min.js')).default;
  const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  const doc = sanitize(new DOMParser().parseFromString(`<body>${res.value}</body>`, 'text/html'));
  const page = { ...A4, margin: 91 }; // 24 mm
  return { html: wrap(doc.body.innerHTML || '<p></p>', page), page };
}

/* ---------------- Excel / CSV ---------------- */

function argbToCss(argb) {
  if (!argb || typeof argb !== 'string' || argb.length < 6) return null;
  const hex = argb.slice(-6);
  return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const isNum = (s) => /^\s*[-+(]?[$€£¥₱]?\s?\d[\d,]*(\.\d+)?%?\)?\s*$/.test(s);

function rowsToTable(rows) {
  return `<table class="sheet">${rows
    .map((r) => `<tr>${r.map((c) => `<td${isNum(c) ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

async function xlsxToHtml(bytes) {
  const ExcelJS = (await import('exceljs/dist/exceljs.min.js')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const parts = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    // Merged ranges: master cell gets row/colspan; the others are skipped.
    const span = new Map();
    const covered = new Set();
    for (const range of ws.model.merges || []) {
      const [a, b] = range.split(':');
      const tl = ws.getCell(a);
      const br = ws.getCell(b);
      span.set(`${tl.row}:${tl.col}`, { rs: br.row - tl.row + 1, cs: br.col - tl.col + 1 });
      for (let r = tl.row; r <= br.row; r++) for (let c = tl.col; c <= br.col; c++) if (r !== tl.row || c !== tl.col) covered.add(`${r}:${c}`);
    }
    // Trim to the area that actually holds values.
    let maxR = 0;
    let maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.text !== '' && cell.text != null) {
          maxR = Math.max(maxR, r);
          maxC = Math.max(maxC, c);
        }
      });
    });
    if (!maxR) return;
    const cols = [];
    for (let c = 1; c <= maxC; c++) {
      const w = ws.getColumn(c).width;
      cols.push(`<col style="width:${Math.round((w || 9) * 7 + 10)}px">`);
    }
    const rows = [];
    for (let r = 1; r <= maxR; r++) {
      const row = ws.getRow(r);
      if (row.hidden) continue;
      const cells = [];
      for (let c = 1; c <= maxC; c++) {
        if (covered.has(`${r}:${c}`)) continue;
        const cell = row.getCell(c);
        const st = [];
        const f = cell.font || {};
        if (f.bold) st.push('font-weight:700');
        if (f.italic) st.push('font-style:italic');
        const fc = argbToCss(f.color?.argb);
        if (fc) st.push('color:' + fc);
        const bg = cell.fill?.type === 'pattern' ? argbToCss(cell.fill.fgColor?.argb) : null;
        if (bg) st.push('background:' + bg);
        const al = cell.alignment?.horizontal;
        const num = typeof cell.value === 'number' || cell.type === ExcelJS.ValueType.Formula && typeof cell.result === 'number';
        if (al === 'center' || al === 'right' || al === 'left') st.push('text-align:' + al);
        else if (num) st.push('text-align:right');
        if (cell.alignment?.wrapText) st.push('white-space:pre-wrap');
        else st.push('white-space:nowrap');
        const sp = span.get(`${r}:${c}`);
        const attrs = (sp?.rs > 1 ? ` rowspan="${sp.rs}"` : '') + (sp?.cs > 1 ? ` colspan="${sp.cs}"` : '');
        let text = '';
        try {
          text = cell.text ?? '';
        } catch {
          text = String(cell.value ?? '');
        }
        cells.push(`<td${attrs} style="${st.join(';')}">${esc(text)}</td>`);
      }
      rows.push(`<tr>${cells.join('')}</tr>`);
    }
    parts.push(
      `<section class="${parts.length ? 'page-break' : ''}"><h2 class="sheet-title">${esc(ws.name)}</h2><table class="sheet fit"><colgroup>${cols.join('')}</colgroup>${rows.join('')}</table></section>`,
    );
  });
  if (!parts.length) throw new Error('This workbook has no visible data.');
  const page = { w: A4.h, h: A4.w, margin: 38 }; // landscape, 10 mm
  return { html: wrap(parts.join(''), page, 'table.sheet td { font-size: 9pt; }'), page };
}

/* ---------------- PowerPoint ---------------- */

const EMU = 9525; // EMU per CSS px

function xml(zip, path) {
  const f = zip[path];
  return f ? new DOMParser().parseFromString(strFromU8(f), 'application/xml') : null;
}
function rels(zip, path) {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const relPath = `${dir}/_rels/${path.slice(dir.length + 1)}.rels`;
  const doc = xml(zip, relPath);
  const map = {};
  if (!doc) return map;
  for (const r of doc.getElementsByTagName('Relationship')) {
    const t = r.getAttribute('Target');
    map[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', target: r.getAttribute('TargetMode') === 'External' ? null : resolve(dir, t) };
  }
  return map;
}
function resolve(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const desc = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);

function xfrmOf(el) {
  const x = kid(kid(el, 'spPr'), 'xfrm') || kid(el, 'xfrm');
  const off = desc(x, 'off');
  const ext = desc(x, 'ext');
  if (!off || !ext) return null;
  return { x: +off.getAttribute('x') / EMU, y: +off.getAttribute('y') / EMU, w: +ext.getAttribute('cx') / EMU, h: +ext.getAttribute('cy') / EMU };
}
function phOf(sp) {
  const ph = desc(sp, 'ph');
  return ph ? { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') } : null;
}
function findPlaceholderXfrm(docs, ph) {
  for (const d of docs) {
    if (!d) continue;
    for (const sp of d.getElementsByTagNameNS('*', 'sp')) {
      const p = phOf(sp);
      if (!p) continue;
      const sameIdx = ph.idx != null && p.idx === ph.idx;
      const sameType = p.type === ph.type || (ph.type === 'ctrTitle' && p.type === 'title') || (ph.type === 'subTitle' && p.type === 'body');
      if (sameIdx || sameType) {
        const x = xfrmOf(sp);
        if (x) return x;
      }
    }
  }
  return null;
}
function colorOf(el) {
  const c = desc(el, 'srgbClr');
  return c ? '#' + c.getAttribute('val') : null;
}

function textBodyHtml(tx, ph) {
  const isTitle = ph && /title|ctrTitle/i.test(ph.type);
  const defSize = isTitle ? 32 : ph ? 20 : 18;
  const out = [];
  for (const p of kids(tx, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = +(pPr?.getAttribute('lvl') || 0);
    const algn = { ctr: 'center', r: 'right', just: 'justify' }[pPr?.getAttribute('algn')] || null;
    const noBullet = pPr && kid(pPr, 'buNone');
    const bullet = !isTitle && !noBullet && (kid(pPr, 'buChar') || (ph && ph.type === 'body'));
    let html = '';
    let firstSize = null;
    for (const r of [...p.children]) {
      if (r.localName === 'br') html += '<br>';
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      const sz = rPr?.getAttribute('sz') ? +rPr.getAttribute('sz') / 100 : defSize;
      firstSize ??= sz;
      const st = [`font-size:${sz}pt`];
      if (rPr?.getAttribute('b') === '1' || (isTitle && rPr?.getAttribute('b') !== '0')) st.push('font-weight:700');
      if (rPr?.getAttribute('i') === '1') st.push('font-style:italic');
      if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') st.push('text-decoration:underline');
      const col = colorOf(kid(rPr, 'solidFill'));
      if (col) st.push('color:' + col);
      html += `<span style="${st.join(';')}">${esc(kid(r, 't')?.textContent || '')}</span>`;
    }
    if (!html) {
      out.push(`<p style="font-size:${defSize}pt">&nbsp;</p>`);
      continue;
    }
    const pst = [`margin-left:${lvl * 24}px`];
    if (algn) pst.push('text-align:' + algn);
    out.push(`<p style="${pst.join(';')}">${bullet ? `<span style="font-size:${firstSize}pt">•&nbsp;</span>` : ''}${html}</p>`);
  }
  return out.join('');
}

function bytesToDataUrl(bytes, path) {
  const ext = path.split('.').pop().toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
  if (!mime) return null; // EMF/WMF and other vector formats browsers cannot draw
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

function pptxToHtml(bytes) {
  const zip = unzipSync(bytes);
  const pres = xml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('This is not a PowerPoint presentation.');
  const sz = desc(pres, 'sldSz');
  const W = sz ? +sz.getAttribute('cx') / EMU : 960;
  const H = sz ? +sz.getAttribute('cy') / EMU : 540;
  const presRels = rels(zip, 'ppt/presentation.xml');
  const order = [...pres.getElementsByTagNameNS('*', 'sldId')].map((s) => presRels[s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')]?.target).filter(Boolean);
  const slides = [];
  for (const path of order) {
    const sd = xml(zip, path);
    if (!sd) continue;
    if (sd.documentElement.getAttribute('show') === '0') continue; // hidden slide
    const r = rels(zip, path);
    const layoutPath = Object.values(r).find((x) => x.type.endsWith('/slideLayout'))?.target;
    const layout = layoutPath ? xml(zip, layoutPath) : null;
    const masterPath = layoutPath ? Object.values(rels(zip, layoutPath)).find((x) => x.type.endsWith('/slideMaster'))?.target : null;
    const master = masterPath ? xml(zip, masterPath) : null;
    const bg = colorOf(desc(sd, 'bg')) || colorOf(desc(layout, 'bg')) || colorOf(desc(master, 'bg')) || '#ffffff';
    const boxes = [];
    const tree = desc(sd, 'spTree');
    const walk = (parent) => {
      for (const el of parent.children) {
        if (el.localName === 'grpSp') walk(el);
        else if (el.localName === 'sp') {
          const ph = phOf(el);
          const box = xfrmOf(el) || (ph && findPlaceholderXfrm([layout, master], ph));
          const tx = kid(el, 'txBody');
          const fillCol = colorOf(kid(kid(el, 'spPr'), 'solidFill'));
          const text = tx ? textBodyHtml(tx, ph) : '';
          if (!box || (!text.replace(/<[^>]+>|&nbsp;/g, '').trim() && !fillCol)) continue;
          const anchor = desc(tx, 'bodyPr')?.getAttribute('anchor');
          const just = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
          boxes.push(
            `<div class="box" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;padding:5px 10px;display:flex;flex-direction:column;justify-content:${just};${fillCol ? 'background:' + fillCol : ''}">${text}</div>`,
          );
        } else if (el.localName === 'pic') {
          const box = xfrmOf(el);
          const id = desc(el, 'blip')?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') || desc(el, 'blip')?.getAttribute('r:embed');
          const target = id && r[id]?.target;
          const url = target && zip[target] ? bytesToDataUrl(zip[target], target) : null;
          if (box && url) boxes.push(`<img class="box" src="${url}" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;object-fit:fill">`);
        } else if (el.localName === 'graphicFrame') {
          const tbl = desc(el, 'tbl');
          const box = xfrmOf(el);
          if (!tbl || !box) continue;
          const rows = kids(tbl, 'tr')
            .map((tr) => `<tr>${kids(tr, 'tc').map((tc) => `<td>${textBodyHtml(kid(tc, 'txBody'), null) || '&nbsp;'}</td>`).join('')}</tr>`)
            .join('');
          boxes.push(`<div class="box" style="left:${box.x}px;top:${box.y}px;width:${box.w}px"><table style="width:100%;font-size:12pt">${rows}</table></div>`);
        }
      }
    };
    if (tree) walk(tree);
    slides.push(`<section class="slide" style="width:${W}px;height:${H}px;background:${bg}">${boxes.join('')}</section>`);
  }
  if (!slides.length) throw new Error('This presentation has no slides.');
  const page = { w: W, h: H, margin: 0 };
  return { html: wrap(slides.join(''), page), page };
}

/* ---------------- text / html ---------------- */

function textToHtml(bytes) {
  const text = new TextDecoder().decode(bytes);
  const page = { ...A4, margin: 76 };
  return { html: wrap(`<pre>${esc(text)}</pre>`, page), page };
}

function htmlFileToHtml(bytes) {
  const doc = sanitize(new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html'));
  const page = { ...A4, margin: 76 };
  const styles = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  for (const s of doc.querySelectorAll('style')) s.remove();
  return { html: wrap(doc.body.innerHTML, page, styles), page };
}

/* ---------------- layout pass shared by both renderers ---------------- */

/** Lay the HTML out in a hidden frame at the page's content width. */
async function layout(html, page) {
  const frame = document.createElement('iframe');
  const cw = page.w - page.margin * 2;
  Object.assign(frame.style, { position: 'fixed', left: '-20000px', top: '0', width: cw + 'px', height: '100px', border: '0', visibility: 'hidden' });
  frame.setAttribute('aria-hidden', 'true');
  document.body.append(frame);
  frame.srcdoc = html;
  await new Promise((res) => frame.addEventListener('load', res, { once: true }));
  const d = frame.contentDocument;
  await Promise.all([...d.images].map((im) => (im.complete ? null : im.decode().catch(() => {}))));
  await d.fonts?.ready;
  // Shrink tables and pictures that are wider than the page so nothing is cut off.
  for (const t of d.querySelectorAll('table.fit, table')) {
    const w = t.scrollWidth;
    if (w > cw + 1) t.style.zoom = String(Math.max(0.3, cw / w));
  }
  frame.style.height = d.documentElement.scrollHeight + 'px';
  return { frame, doc: d, cw };
}

/** Desktop: hand the laid-out HTML to Chromium's PDF printer. */
async function renderNative(html, page) {
  const { frame, doc } = await layout(html, page);
  try {
    return { bytes: await window.desktop.htmlToPdf('<!doctype html>' + doc.documentElement.outerHTML), words: null };
  } finally {
    frame.remove();
  }
}

/** Browser: draw each page to an image and keep the text as positioned words. */
async function renderRaster(html, page, onProgress) {
  const { default: html2canvas } = await import('html2canvas');
  const { frame, doc, cw } = await layout(html, page);
  try {
    const win = frame.contentWindow;
    const total = doc.documentElement.scrollHeight;
    const ch = page.h - page.margin * 2;
    const slides = [...doc.querySelectorAll('.slide')];

    // Page boundaries: forced breaks, then never through a line of text, a picture or a table row.
    const blocks = [];
    const words = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.data))) {
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const r = range.getClientRects()[0];
        if (!r || r.width < 0.5 || r.height < 0.5) continue;
        words.push({ text: m[0], x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    for (const w of words) blocks.push([w.y, w.y + w.h]);
    for (const el of doc.querySelectorAll('img, tr, svg, canvas')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.height < ch) blocks.push([r.top, r.bottom]);
    }
    const forced = [...doc.querySelectorAll('.page-break')].map((el) => el.getBoundingClientRect().top).filter((y) => y > 0);
    const breaks = [0];
    if (slides.length) {
      for (const s of slides) breaks.push(s.getBoundingClientRect().bottom);
      breaks.pop();
      breaks.push(total);
    } else {
      let start = 0;
      while (start < total - 1) {
        let end = Math.min(start + ch, total);
        const f = forced.find((y) => y > start + 1 && y < end);
        if (f) end = f;
        else if (end < total) {
          for (let guard = 0; guard < 50; guard++) {
            const cut = blocks.filter(([a, b]) => a < end - 0.5 && b > end + 0.5 && a > start + 1);
            if (!cut.length) break;
            end = Math.min(...cut.map(([a]) => a));
          }
          if (end <= start + 1) end = Math.min(start + ch, total);
        }
        breaks.push(end);
        start = end;
      }
    }

    const out = await PDFDocument.create();
    const k = 2;
    const pageWords = [];
    const n = breaks.length - 1;
    for (let i = 0; i < n; i++) {
      onProgress?.(i, n);
      const y0 = breaks[i];
      const hgt = Math.max(1, breaks[i + 1] - y0);
      const shot = await html2canvas(doc.body, {
        x: 0,
        y: y0,
        width: slides.length ? page.w : cw,
        height: hgt,
        windowWidth: cw,
        windowHeight: Math.ceil(total),
        scale: k,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: false,
      });
      const c = document.createElement('canvas');
      c.width = Math.round(page.w * k);
      c.height = Math.round(page.h * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(shot, page.margin * k, page.margin * k);
      const img = await out.embedJpg(await canvasToBytes(c, 'image/jpeg', 0.9));
      const pw = page.w * 0.75;
      const ph = page.h * 0.75;
      out.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      c.width = shot.width = 0;
      pageWords.push(
        words
          .filter((w) => w.y + w.h / 2 >= y0 && w.y + w.h / 2 < y0 + hgt)
          .map((w) => ({ text: w.text, x: (page.margin + w.x) * 0.75, y: (page.margin + w.y - y0) * 0.75, w: w.w * 0.75, h: w.h * 0.75 })),
      );
    }
    void win;
    return { bytes: await out.save(), words: pageWords };
  } finally {
    frame.remove();
  }
}

/**
 * Convert one file. Returns {bytes, words}: words is per-page text positions (points) when the
 * pages were drawn as images, or null when the PDF already has real text.
 */
export async function convertToPdf(name, bytes, onProgress) {
  const ext = name.split('.').pop().toLowerCase();
  if (UNSUPPORTED_HINT[ext]) throw new Error(UNSUPPORTED_HINT[ext]);
  onProgress?.('Reading ' + name, null);
  let res;
  if (ext === 'docx') res = await docxToHtml(bytes);
  else if (ext === 'xlsx') res = await xlsxToHtml(bytes);
  else if (ext === 'csv') {
    const page = { w: A4.h, h: A4.w, margin: 38 };
    res = { html: wrap(rowsToTable(parseCsv(new TextDecoder().decode(bytes))), page, 'table.sheet td { font-size: 9pt; white-space: nowrap; }'), page };
  } else if (ext === 'pptx') res = pptxToHtml(bytes);
  else if (ext === 'html' || ext === 'htm') res = htmlFileToHtml(bytes);
  else if (ext === 'txt' || ext === 'md') res = textToHtml(bytes);
  else throw new Error(`.${ext} files cannot be converted.`);
  onProgress?.('Laying out pages', null);
  if (window.desktop?.htmlToPdf) return renderNative(res.html, res.page);
  return renderRaster(res.html, res.page, (i, n) => onProgress?.(`Page ${i + 1} of ${n}`, i / n));
}

export { PX_PER_PT };

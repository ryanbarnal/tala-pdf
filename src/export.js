import {
  PDFDocument,
  StandardFonts,
  PDFName,
  PDFPage,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFStream,
  PDFHexString,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  degrees,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  moveTo,
  lineTo,
  appendBezierCurve,
  closePath,
  stroke,
  fill,
  fillAndStroke,
  rectangle,
  setLineWidth,
  setLineCap,
  setLineJoin,
  setStrokingColor,
  setFillingColor,
  setGraphicsState,
} from '@cantoo/pdf-lib';
import { sources, pageView, pdfjsLib, ownSize, FONT_CSS, TEXT_PAD, LINE_H } from './model.js';
import { hexToRgb, canvasToBytes, dataUrlToBytes } from './util.js';

const col = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
};

const STD = {
  sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

/** Matrix placing a y-up local frame (origin bottom-left of the box's own rect) into display space. */
function boxMatrix(a) {
  const [ow, oh] = ownSize(a);
  const t = ((a.angle || 0) * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const ox = -ow / 2;
  const oy = oh / 2;
  return [cos, sin, sin, -cos, cx + ox * cos - oy * sin, cy + ox * sin + oy * cos];
}

function wrapLines(text, font, size, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && font.widthOfTextAtSize(test.trimEnd(), size) > maxW) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Render text with browser fonts when the PDF standard fonts cannot encode it (non-Latin, emoji). */
async function rasterText(a, ow, oh, nowrap) {
  const k = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(ow * k));
  c.height = Math.max(1, Math.ceil(oh * k));
  const g = c.getContext('2d');
  g.scale(k, k);
  g.font = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size}px ${FONT_CSS[a.family || 'sans']}`;
  g.fillStyle = a.color || '#000000';
  g.textBaseline = 'alphabetic';
  const lines = [];
  for (const para of a.text.split('\n')) {
    if (nowrap) {
      lines.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line && g.measureText((line + word).trimEnd()).width > ow - TEXT_PAD * 2) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    lines.push(line);
  }
  const base = a.base != null ? a.base : TEXT_PAD + a.size * 0.95;
  lines.forEach((l, i) => g.fillText(l, nowrap ? 0 : TEXT_PAD, base + i * a.size * LINE_H));
  return canvasToBytes(c);
}

/** Text positions from pdf.js, in the same shape as OCR words, for pages saved as images. */
async function textWords(jsPage, viewport) {
  const tc = await jsPage.getTextContent();
  const out = [];
  for (const it of tc.items) {
    const text = (it.str || '').trim();
    if (!text) continue;
    const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
    if (Math.abs(m[1]) > 0.02 * Math.abs(m[0]) + 0.01) continue; // rotated text
    const fh = Math.hypot(m[2], m[3]);
    if (fh < 2 || !it.width) continue;
    out.push({ text, x: m[4], y: m[5] - fh * 0.82, w: it.width * viewport.scale, h: fh });
  }
  return out;
}

/**
 * Delete every object that can no longer be reached from the document root. Without this, pages that
 * were deleted or redacted would stay inside the saved file where a tool could still extract them.
 */
function sweepUnreachable(ctx) {
  const seen = new Set();
  const t = ctx.trailerInfo;
  const stack = [t.Root, t.Info, t.Encrypt, t.ID].filter(Boolean);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/**
 * Build the final PDF bytes for a document.
 * opts.onProgress(done, total)
 */
export async function buildPdf(doc, opts = {}) {
  const primary = doc.primarySource();
  if (!primary) throw new Error('This document has no pages.');
  // An empty password unlocks files that open freely but carry an owner password (locked permissions),
  // which is common for manuals, statements and e-books.
  const parse = (src) => PDFDocument.load(src.bytes, { password: src.password || '', updateMetadata: false });
  const loaded = new Map();
  const broken = new Set(); // sources the writer cannot parse; their pages are saved as images
  const load = async (src) => {
    if (!loaded.has(src.id) && !broken.has(src.id)) {
      try {
        loaded.set(src.id, await parse(src));
      } catch (e) {
        console.warn('cannot rewrite', src.name, e);
        broken.add(src.id);
      }
    }
    return loaded.get(src.id) || null;
  };

  let out;
  try {
    out = await parse(primary);
  } catch (e) {
    console.warn('cannot rewrite', primary.name, e);
    broken.add(primary.id);
    out = await PDFDocument.create();
  }
  opts.flattened = 0;
  // Pages are re-linked into a new flat page tree at the end, so first copy down anything a page
  // inherits from its old parent nodes.
  const orig = out.getPages();
  for (const p of orig) {
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const key = PDFName.of(k);
      if (!p.node.get(key)) {
        const v = p.node.getInheritableAttribute(key);
        if (v) p.node.set(key, v);
      }
    }
  }
  const finalRefs = [];
  const used = new Set();
  const fonts = new Map();
  const getFont = async (family, bold, italic) => {
    const name = STD[family || 'sans'][(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fonts.has(name)) fonts.set(name, await out.embedFont(StandardFonts[name]));
    return fonts.get(name);
  };
  const charsets = new Map();
  const canEncode = (font, s) => {
    let set = charsets.get(font);
    if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
    for (const ch of s) if (!set.has(ch.codePointAt(0))) return false;
    return true;
  };
  const gsCache = new WeakMap();
  const gstate = (page, key, dict) => {
    let m = gsCache.get(page);
    if (!m) gsCache.set(page, (m = new Map()));
    if (!m.has(key)) m.set(key, page.node.newExtGState('TGS', out.context.obj({ Type: 'ExtGState', ...dict })));
    return m.get(key);
  };

  for (let n = 0; n < doc.pages.length; n++) {
    const pg = doc.pages[n];
    opts.onProgress?.(n, doc.pages.length);
    const src = sources.get(pg.src);
    const { page: jsPage, viewport } = await pageView(pg, 1);
    const redacts = pg.annots.filter((a) => a.type === 'redact');
    let page;
    let toPdf; // display -> pdf user space

    const from = broken.has(src.id) ? null : src === primary ? out : await load(src);
    const flatten = redacts.length || !from;
    let words = pg.ocr;
    if (!from) {
      opts.flattened++;
      if (!words) words = await textWords(jsPage, viewport);
    }

    if (flatten) {
      // The page becomes a flat image: for redaction (areas burned in), or when the writer cannot
      // parse the source file. In the second case the page's text is kept as an invisible layer.
      const k = 2.5;
      const vp = jsPage.getViewport({ scale: k, rotation: viewport.rotation });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await jsPage.render({
        canvasContext: g,
        viewport: vp,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
        annotationStorage: src.pdf.annotationStorage,
      }).promise;
      g.fillStyle = '#000';
      for (const r of redacts) g.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
      const img = await out.embedJpg(await canvasToBytes(c, 'image/jpeg', 0.9));
      page = PDFPage.create(out);
      page.setSize(pg.w, pg.h);
      page.drawImage(img, { x: 0, y: 0, width: pg.w, height: pg.h });
      toPdf = [1, 0, 0, -1, 0, pg.h];
    } else {
      if (src === primary && !used.has(pg.idx)) {
        used.add(pg.idx);
        page = orig[pg.idx];
      } else {
        [page] = await out.copyPages(from, [pg.idx]);
      }
      if (pg.rot) page.setRotation(degrees((page.getRotation().angle + pg.rot) % 360));
      toPdf = invert(viewport.transform);
    }

    finalRefs.push(page.ref);

    const ops = (...o) => page.pushOperators(...o);
    const begin = (local) => {
      ops(pushGraphicsState(), concatTransformationMatrix(...toPdf));
      if (local) ops(concatTransformationMatrix(...local));
    };
    const end = () => ops(popGraphicsState());

    // Invisible OCR text so scanned pages become searchable.
    if (words?.length && !redacts.length) {
      const font = await getFont('sans');
      const gs = gstate(page, 'ocr', { ca: 0, CA: 0 });
      for (const w of words) {
        const s = w.text.replace(/[^\x20-\x7e\xa1-\xff]/g, '');
        if (!s || !canEncode(font, s)) continue;
        const size = Math.max(2, w.h);
        const sx = w.w / font.widthOfTextAtSize(s, size);
        begin([sx, 0, 0, -1, w.x, w.y + w.h * 0.82]);
        ops(setGraphicsState(gs));
        page.drawText(s + ' ', { x: 0, y: 0, size, font });
        end();
      }
    }

    for (const a of pg.annots) {
      switch (a.type) {
        case 'highlight': {
          begin();
          ops(setGraphicsState(gstate(page, 'hl', { ca: 1, BM: 'Multiply' })), setFillingColor(col(a.color)));
          for (const r of a.rects) ops(rectangle(r.x, r.y, r.w, r.h), fill());
          end();
          break;
        }
        case 'underline':
        case 'strike': {
          begin();
          ops(setStrokingColor(col(a.color)));
          for (const r of a.rects) {
            const horiz = r.w >= r.h;
            const t = Math.max(0.6, (horiz ? r.h : r.w) * 0.07);
            const f = a.type === 'underline' ? 0.93 : 0.55;
            ops(setLineWidth(t));
            if (horiz) ops(moveTo(r.x, r.y + r.h * f), lineTo(r.x + r.w, r.y + r.h * f), stroke());
            else ops(moveTo(r.x + r.w * f, r.y), lineTo(r.x + r.w * f, r.y + r.h), stroke());
          }
          end();
          break;
        }
        case 'ink': {
          begin();
          ops(setStrokingColor(col(a.color)), setLineWidth(a.sw), setLineCap(1), setLineJoin(1));
          for (const p of a.paths) {
            if (!p.length) continue;
            ops(moveTo(p[0][0], p[0][1]));
            if (p.length === 1) ops(lineTo(p[0][0] + 0.01, p[0][1]));
            for (let i = 1; i < p.length; i++) ops(lineTo(p[i][0], p[i][1]));
            ops(stroke());
          }
          end();
          break;
        }
        case 'rect':
        case 'ellipse': {
          begin();
          if (a.type === 'rect') ops(rectangle(a.x, a.y, a.w, a.h));
          else {
            const rx = a.w / 2;
            const ry = a.h / 2;
            const cx = a.x + rx;
            const cy = a.y + ry;
            const k = 0.5523;
            ops(
              moveTo(cx + rx, cy),
              appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
              appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
              appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
              appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
              closePath(),
            );
          }
          const hasStroke = a.color && a.sw;
          if (a.fill) ops(setFillingColor(col(a.fill)));
          if (hasStroke) ops(setStrokingColor(col(a.color)), setLineWidth(a.sw));
          ops(a.fill && hasStroke ? fillAndStroke() : a.fill ? fill() : stroke());
          end();
          break;
        }
        case 'line':
        case 'arrow': {
          begin();
          ops(setStrokingColor(col(a.color)), setLineWidth(a.sw), setLineCap(1), setLineJoin(1));
          ops(moveTo(a.x1, a.y1), lineTo(a.x2, a.y2), stroke());
          if (a.type === 'arrow') {
            const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
            const len = Math.max(8, a.sw * 4);
            const p = (d) => [a.x2 - len * Math.cos(ang + d), a.y2 - len * Math.sin(ang + d)];
            const [l, r] = [p(0.45), p(-0.45)];
            ops(moveTo(l[0], l[1]), lineTo(a.x2, a.y2), lineTo(r[0], r[1]), stroke());
          }
          end();
          break;
        }
        case 'image': {
          const bytes = dataUrlToBytes(a.data);
          const img = a.data.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
          const [ow, oh] = ownSize(a);
          begin(boxMatrix(a));
          page.drawImage(img, { x: 0, y: 0, width: ow, height: oh });
          end();
          break;
        }
        case 'text':
        case 'textedit': {
          if (a.type === 'textedit' && a.bg) {
            begin();
            ops(setFillingColor(col(a.bg)), rectangle(a.x, a.y, a.w, a.h), fill());
            end();
          }
          if (!a.text.trim()) break;
          const [ow, oh] = ownSize(a);
          const font = await getFont(a.family, a.bold, a.italic);
          begin(boxMatrix(a));
          if (canEncode(font, a.text.replace(/\n/g, ' '))) {
            const single = a.type === 'textedit';
            const lines = single ? [a.text] : wrapLines(a.text, font, a.size, (ow - TEXT_PAD * 2) * 1.01);
            const base = a.base != null ? a.base : TEXT_PAD + a.size * 0.95;
            lines.forEach((l, i) => {
              if (!l) return;
              page.drawText(l, {
                x: single ? 0 : TEXT_PAD,
                y: oh - base - i * a.size * LINE_H,
                size: a.size,
                font,
                color: col(a.color || '#000000'),
              });
            });
          } else {
            const img = await out.embedPng(await rasterText(a, ow, oh, a.type === 'textedit'));
            page.drawImage(img, { x: 0, y: 0, width: ow, height: oh });
          }
          end();
          break;
        }
        case 'note': {
          const [x1, y1] = apply(toPdf, a.x, a.y + 20);
          const [x2, y2] = apply(toPdf, a.x + 20, a.y);
          const [r, g, b] = hexToRgb(a.color || '#ffd54a');
          const ref = out.context.register(
            out.context.obj({
              Type: 'Annot',
              Subtype: 'Text',
              Rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
              Contents: PDFHexString.fromText(a.text || ''),
              Name: 'Comment',
              C: [r / 255, g / 255, b / 255],
              F: 4,
              Open: false,
            }),
          );
          page.node.addAnnot(ref);
          break;
        }
      }
    }
  }

  // Replace the page tree with one flat node listing the pages in their new order.
  const treeRef = out.catalog.get(PDFName.of('Pages'));
  const tree = out.catalog.Pages();
  tree.set(PDFName.of('Kids'), out.context.obj(finalRefs));
  tree.set(PDFName.of('Count'), out.context.obj(finalRefs.length));
  for (const ref of finalRefs) out.context.lookup(ref).set(PDFName.of('Parent'), treeRef);
  out.pageCache?.invalidate?.();

  if (!broken.has(primary.id)) await applyForms(out, primary);

  // Pages of the original that are no longer used may still be pointed at by form fields, bookmarks
  // or link targets. Empty them so nothing of their content survives, then drop unreachable objects.
  const keep = new Set(finalRefs.map((r) => r.tag));
  for (const p of orig) {
    if (keep.has(p.ref.tag)) continue;
    for (const k of ['Contents', 'Resources', 'Annots', 'Thumb', 'B']) p.node.delete(PDFName.of(k));
  }
  await out.flush();
  sweepUnreachable(out.context);

  if (doc.protect?.password) {
    out.encrypt({
      userPassword: doc.protect.password,
      ownerPassword: doc.protect.password,
      permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true },
    });
  }
  out.setModificationDate(new Date());
  opts.onProgress?.(doc.pages.length, doc.pages.length);
  return out.save({ useObjectStreams: true });
}

/** Copy the values typed into pdf.js form widgets into the saved file. */
async function applyForms(out, src) {
  const stored = src.pdf.annotationStorage.getAll();
  if (!stored) return;
  let fields;
  try {
    fields = await src.pdf.getFieldObjects();
  } catch {
    return;
  }
  if (!fields) return;
  const form = out.getForm();
  let touched = false;
  for (const [name, widgets] of Object.entries(fields)) {
    const vals = widgets.filter((w) => stored[w.id]).map((w) => ({ w, v: stored[w.id].value }));
    if (!vals.length) continue;
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      const { w, v } = vals[vals.length - 1];
      if (f instanceof PDFTextField) f.setText(v == null ? '' : String(v));
      else if (f instanceof PDFCheckBox) v && v !== 'Off' ? f.check() : f.uncheck();
      else if (f instanceof PDFRadioGroup) {
        const on = vals.find((x) => x.v && x.v !== 'Off');
        if (on) f.select(String(on.w.exportValues ?? on.v));
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        f.select(Array.isArray(v) ? v.map(String) : String(v));
      }
      void w;
      touched = true;
    } catch (e) {
      console.warn('form field', name, e);
    }
  }
  if (!touched) return;
  try {
    form.updateFieldAppearances();
  } catch {
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), out.context.obj(true));
  }
}

/** New single-source PDFs used for blank pages and image pages. */
export async function blankPdf(w = 595.28, h = 841.89, count = 1) {
  const d = await PDFDocument.create();
  for (let i = 0; i < count; i++) d.addPage([w, h]);
  return d.save();
}

export async function imagesToPdf(files) {
  const d = await PDFDocument.create();
  for (const f of files) {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    // Normalise through a canvas: handles HEIC-less browsers' supported types, EXIF rotation, and WebP.
    const maxPx = 3000;
    const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    const png = f.type === 'image/png';
    if (!png) {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
    }
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const bytes = await canvasToBytes(c, png ? 'image/png' : 'image/jpeg', 0.9);
    const img = png ? await d.embedPng(bytes) : await d.embedJpg(bytes);
    // Fit inside A4 in the image's orientation, keeping aspect ratio.
    const land = c.width > c.height;
    const [PW, PH] = land ? [841.89, 595.28] : [595.28, 841.89];
    const s = Math.min(PW / c.width, PH / c.height);
    const page = d.addPage([c.width * s, c.height * s]);
    page.drawImage(img, { x: 0, y: 0, width: c.width * s, height: c.height * s });
  }
  return d.save();
}

/** Re-render every page as a JPEG: much smaller for scans, but text stops being selectable. */
export async function rasterizePdf(bytes, dpi, quality, pdfjsLib, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const d = await PDFDocument.create();
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress?.(i - 1, pdf.numPages);
    const p = await pdf.getPage(i);
    const vp1 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    const img = await d.embedJpg(await canvasToBytes(c, 'image/jpeg', quality));
    d.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = 0;
  }
  await pdf.destroy();
  return d.save({ useObjectStreams: true });
}

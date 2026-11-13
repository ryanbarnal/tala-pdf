import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { uid } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
export { pdfjsLib };

const ASSET = new URL('./pdfjs/', document.baseURI).href;

/** Loaded source PDFs, shared across open documents. id -> {id, name, bytes, pdf, password, sizes} */
export const sources = new Map();

/**
 * Parse PDF bytes into a source. askPassword(retry) resolves to a string, or null to cancel.
 */
export async function addSource(bytes, name, askPassword, presetPassword, id = uid()) {
  const src = { id, name, bytes, pdf: null, password: presetPassword || null, sizes: [] };
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    password: presetPassword || undefined,
    cMapUrl: ASSET + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSET + 'standard_fonts/',
  });
  task.onPassword = (update, reason) => {
    Promise.resolve(askPassword ? askPassword(reason === 2, name) : null).then((pw) => {
      if (pw == null) task.destroy();
      else {
        src.password = pw;
        update(pw);
      }
    });
  };
  try {
    src.pdf = await task.promise;
  } catch (e) {
    if (task.destroyed || /destroyed/i.test(e.message)) throw new Error('cancelled');
    throw new Error(`"${name}" could not be opened. It may be damaged or not a PDF.`);
  }
  for (let i = 1; i <= src.pdf.numPages; i++) {
    const p = await src.pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    src.sizes.push({ w: vp.width, h: vp.height });
  }
  sources.set(src.id, src);
  return src;
}

export function pagesFromSource(src, indices) {
  const idx = indices || src.sizes.map((_, i) => i);
  return idx.map((i) => ({
    id: uid(),
    src: src.id,
    idx: i,
    w: src.sizes[i].w,
    h: src.sizes[i].h,
    rot: 0,
    annots: [],
    ocr: null,
  }));
}

export class Doc {
  constructor(name) {
    this.id = uid();
    this.name = name;
    this.ref = null; // desktop path or web file handle
    this.pages = [];
    this.undo = [];
    this.redo = [];
    this.dirty = false;
    this.protect = null; // {password} when the saved file should be encrypted
    this.listeners = new Set();
    this.rev = 0;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what) {
    this.rev++;
    for (const fn of this.listeners) fn(what);
  }

  snapshot() {
    return this.pages.map((p) => ({ ...p, annots: p.annots.map((a) => ({ ...a })) }));
  }

  /** Run a mutation with undo support. `what` is 'annots' or 'pages'. */
  change(what, fn) {
    this.undo.push(this.snapshot());
    if (this.undo.length > 80) this.undo.shift();
    this.redo = [];
    fn();
    this.dirty = true;
    this.emit(what);
  }
  /** Mark dirty without an undo step (form fields, protection). */
  touch(what = 'meta') {
    this.dirty = true;
    this.emit(what);
  }
  doUndo() {
    if (!this.undo.length) return;
    this.redo.push(this.snapshot());
    this.pages = this.undo.pop();
    this.dirty = true;
    this.emit('pages');
  }
  doRedo() {
    if (!this.redo.length) return;
    this.undo.push(this.snapshot());
    this.pages = this.redo.pop();
    this.dirty = true;
    this.emit('pages');
  }

  usedSources() {
    return [...new Set(this.pages.map((p) => p.src))].map((id) => sources.get(id));
  }
  /** The source contributing the most pages; its forms, outline and metadata are kept on save. */
  primarySource() {
    const count = new Map();
    for (const p of this.pages) count.set(p.src, (count.get(p.src) || 0) + 1);
    let best = null;
    for (const [id, n] of count) if (!best || n > count.get(best)) best = id;
    return best ? sources.get(best) : null;
  }
}

/** pdf.js page proxy + viewport for a model page at the given scale. */
export async function pageView(pg, scale = 1) {
  const page = await sources.get(pg.src).pdf.getPage(pg.idx + 1);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + pg.rot) % 360 });
  return { page, viewport };
}

const BOX = new Set(['text', 'image', 'textedit']);

/** Rotate one annotation 90° clockwise within a page of display size W×H. */
function rotAnnot(a, W, H) {
  const pt = (x, y) => [H - y, x];
  const rc = (r) => ({ ...r, x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w });
  const n = { ...a };
  if (a.rects) n.rects = a.rects.map(rc);
  if (a.paths) n.paths = a.paths.map((p) => p.map(([x, y]) => pt(x, y)));
  if (a.x1 != null) {
    [n.x1, n.y1] = pt(a.x1, a.y1);
    [n.x2, n.y2] = pt(a.x2, a.y2);
  } else if (a.w != null) {
    Object.assign(n, rc(a));
  } else if (a.x != null) {
    [n.x, n.y] = pt(a.x, a.y);
    if (a.type === 'note') n.x -= 20;
  }
  if (BOX.has(a.type)) n.angle = ((a.angle || 0) + 90) % 360;
  return n;
}

export function rotatePage(pg, quarterTurns) {
  let p = { ...pg };
  const t = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < t; i++) {
    p = {
      ...p,
      annots: p.annots.map((a) => rotAnnot(a, p.w, p.h)),
      w: p.h,
      h: p.w,
      rot: (p.rot + 90) % 360,
      ocr: null,
    };
  }
  return p;
}

/** Own (unrotated) width/height of a box annotation. */
export function ownSize(a) {
  return (a.angle || 0) % 180 ? [a.h, a.w] : [a.w, a.h];
}

export const FONT_CSS = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
export const TEXT_PAD = 2;
export const LINE_H = 1.2;

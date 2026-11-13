import { pdfjsLib, pageView, sources, ownSize, FONT_CSS, TEXT_PAD, LINE_H } from './model.js';
import { h, uid, clamp, rgbToHex, debounce, icon } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  return el;
};

export const DRAW_TOOLS = new Set(['pen', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'text', 'note', 'edittext']);
export const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strike']);
const RESIZABLE = new Set(['text', 'image', 'rect', 'ellipse', 'redact']);

export function bbox(a) {
  if (a.rects) {
    const x = Math.min(...a.rects.map((r) => r.x));
    const y = Math.min(...a.rects.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...a.rects.map((r) => r.x + r.w)) - x,
      h: Math.max(...a.rects.map((r) => r.y + r.h)) - y,
    };
  }
  if (a.paths) {
    const pts = a.paths.flat();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (a.x1 != null) {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (a.type === 'note') return { x: a.x, y: a.y, w: 20, h: 20 };
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function translate(a, dx, dy) {
  const n = { ...a };
  if (a.rects) n.rects = a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  if (a.paths) n.paths = a.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy]));
  if (a.x1 != null) {
    n.x1 += dx;
    n.x2 += dx;
    n.y1 += dy;
    n.y2 += dy;
  } else if (a.x != null) {
    n.x += dx;
    n.y += dy;
  }
  return n;
}

const linkStub = (viewer) => ({
  externalLinkEnabled: true,
  eventBus: { dispatch() {}, on() {}, off() {} },
  getDestinationHash: () => '#',
  getAnchorUrl: () => '#',
  addLinkAttributes(link, url) {
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  },
  executeNamedAction() {},
  executeSetOCGState() {},
  goToDestination: (dest) => viewer.goToDest(dest),
});

export class Viewer {
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks; // {onPage, onSelect, onScale, onTool, askNote}
    this.doc = null;
    this.scale = 1;
    this.fit = true;
    this.tool = 'select';
    this.sel = null; // {pageId, id}
    this.editing = null;
    this.query = '';
    this.style = { color: '#d92d20', hl: '#ffe14d', sw: 2, size: 14, family: 'sans', bold: false, italic: false };
    host.dataset.tool = 'select';
    this.pagesEl = h('div.pages');
    host.append(this.pagesEl);
    this.els = new Map();
    this.io = new IntersectionObserver((ents) => this.onIntersect(ents), { root: host, rootMargin: '600px 0px' });
    host.addEventListener('scroll', () => this.trackPage(), { passive: true });
    host.addEventListener('pointerup', () => setTimeout(() => this.markupFromSelection(), 0));
    document.addEventListener(
      'selectionchange',
      debounce(() => {
        if (matchMedia('(pointer: coarse)').matches) this.markupFromSelection();
      }, 900),
    );
    host.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.setScale(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
    host.addEventListener('pointerdown', (e) => {
      if (e.target === host || e.target === this.pagesEl || e.target.classList?.contains('page')) this.select(null);
    });
    new ResizeObserver(
      debounce(() => {
        if (this.fit && this.doc && host.clientWidth) this.fitWidth();
      }, 120),
    ).observe(host);
  }

  setDoc(doc) {
    this.unsub?.();
    this.doc = doc;
    this.sel = null;
    this.editing = null;
    this.els.clear();
    this.pagesEl.replaceChildren();
    if (!doc) return;
    this.unsub = doc.onChange((what) => {
      if (what === 'pages') this.syncPages();
      else if (what === 'annots') this.redrawOverlays();
    });
    this.scale = doc.view?.scale || this.scale;
    this.fit = doc.view ? doc.view.fit : true;
    this.syncPages();
    if (this.fit) this.fitWidth();
    this.host.scrollTop = doc.view?.top || 0;
    this.trackPage();
  }

  saveViewState() {
    if (this.doc) this.doc.view = { scale: this.scale, fit: this.fit, top: this.host.scrollTop };
  }

  /* ---------- page list ---------- */

  syncPages() {
    const keep = new Map();
    const frag = [];
    for (const pg of this.doc.pages) {
      let el = this.els.get(pg.id);
      const key = `${pg.src}:${pg.idx}:${pg.rot}`;
      if (!el || el._key !== key) {
        if (el) this.io.unobserve(el);
        el = h('div.page', { dataset: { id: pg.id } });
        el._key = key;
        el._tok = 0;
        this.io.observe(el);
      }
      this.sizePage(el, pg);
      keep.set(pg.id, el);
      frag.push(el);
    }
    for (const [id, el] of this.els) if (keep.get(id) !== el) this.io.unobserve(el);
    this.els = keep;
    // Reorder with minimal DOM churn.
    frag.forEach((el, i) => {
      if (this.pagesEl.children[i] !== el) this.pagesEl.insertBefore(el, this.pagesEl.children[i] || null);
    });
    while (this.pagesEl.children.length > frag.length) this.pagesEl.lastChild.remove();
    if (this.sel && !this.findAnnot(this.sel)) this.select(null);
    this.redrawOverlays();
    this.trackPage();
  }

  sizePage(el, pg) {
    el.style.width = pg.w * this.scale + 'px';
    el.style.height = pg.h * this.scale + 'px';
    el.style.setProperty('--scale-factor', this.scale);
  }

  onIntersect(ents) {
    for (const e of ents) {
      const el = e.target;
      el._vis = e.isIntersecting;
      if (e.isIntersecting) this.ensureRendered(el);
      else if (el._rscale) this.release(el);
    }
  }

  release(el) {
    el._tok++;
    el._task?.cancel();
    el._rscale = null;
    el.replaceChildren();
    el._ov = null;
  }

  async ensureRendered(el) {
    if (!this.doc || el._rscale === this.scale) return;
    const pg = this.doc.pages.find((p) => p.id === el.dataset.id);
    if (!pg) return;
    const tok = ++el._tok;
    el._task?.cancel();
    const scale = this.scale;
    el._rscale = scale;
    try {
      const { page, viewport } = await pageView(pg, scale);
      let k = Math.min(window.devicePixelRatio || 1, 2.5);
      const area = viewport.width * viewport.height * k * k;
      if (area > 12e6) k *= Math.sqrt(12e6 / area);
      const vpR = page.getViewport({ scale: scale * k, rotation: viewport.rotation });
      const canvas = h('canvas.pdfcanvas');
      canvas.width = Math.round(vpR.width);
      canvas.height = Math.round(vpR.height);
      const task = page.render({
        canvasContext: canvas.getContext('2d', { willReadFrequently: false }),
        viewport: vpR,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
      });
      el._task = task;
      await task.promise;
      if (tok !== el._tok) return;
      const text = h('div.textLayer');
      const tc = await page.getTextContent();
      if (tok !== el._tok) return;
      const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: text, viewport });
      await tl.render();
      if (tok !== el._tok) return;
      el._tc = tc;
      el._page = page;
      el._vp1 = page.getViewport({ scale: 1, rotation: viewport.rotation });
      el._lines = null;
      const annLayer = h('div.annotationLayer');
      const src = sources.get(pg.src);
      try {
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (annotations.length) {
          const layer = new pdfjsLib.AnnotationLayer({
            div: annLayer,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: null,
            structTreeLayer: null,
          });
          await layer.render({
            annotations,
            imageResourcesPath: new URL('./pdfjs/images/', document.baseURI).href,
            renderForms: true,
            linkService: linkStub(this),
            downloadManager: null,
            annotationStorage: src.pdf.annotationStorage,
            enableScripting: false,
            hasJSActions: false,
            fieldObjects: null,
          });
          annLayer.addEventListener('input', () => this.doc?.touch('form'));
          annLayer.addEventListener('change', () => this.doc?.touch('form'));
        }
      } catch (e) {
        console.warn('annotation layer', e);
      }
      if (tok !== el._tok) return;
      const ocr = h('div.ocrLayer');
      const ov = h('div.overlay');
      const hl = h('div.hlLayer');
      el.replaceChildren(canvas, hl, text, annLayer, ocr, ov);
      el._canvas = canvas;
      el._ov = ov;
      el._hl = hl;
      el._ocr = ocr;
      this.bindOverlay(el, ov);
      this.drawOcr(el, pg);
      this.drawOverlay(el);
      this.applySearch(el, text);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('render', e);
    }
  }

  /* ---------- zoom / navigation ---------- */

  setScale(s, keepFit = false) {
    if (!this.doc) return;
    s = clamp(s, 0.2, 6);
    if (Math.abs(s - this.scale) < 0.001) return;
    const host = this.host;
    const ratio = host.scrollHeight ? (host.scrollTop + host.clientHeight / 2) / host.scrollHeight : 0;
    const wasTop = host.scrollTop < 4;
    this.scale = s;
    if (!keepFit) this.fit = false;
    for (const pg of this.doc.pages) {
      const el = this.els.get(pg.id);
      if (el) this.sizePage(el, pg);
    }
    host.scrollTop = wasTop ? 0 : ratio * host.scrollHeight - host.clientHeight / 2;
    this.redrawOverlays();
    this.rerender();
    this.hooks.onScale?.(s);
  }
  rerender = debounce(() => {
    for (const el of this.els.values()) if (el._vis) this.ensureRendered(el);
  }, 160);

  /** Fit pages to the viewer width. Unless `full`, stop at 150% so wide windows stay readable. */
  fitWidth(full = this.fitFull) {
    if (!this.doc?.pages.length) return;
    const maxW = Math.max(...this.doc.pages.map((p) => p.w));
    const pad = this.host.clientWidth < 600 ? 16 : 48;
    this.fit = true;
    this.fitFull = !!full;
    const s = (this.host.clientWidth - pad) / maxW;
    this.setScale(full ? s : Math.min(s, 1.5), true);
    this.hooks.onScale?.(this.scale);
  }

  trackPage() {
    if (!this.doc) return;
    const mid = this.host.scrollTop + this.host.clientHeight / 3;
    let i = 0;
    for (const el of this.pagesEl.children) {
      if (el.offsetTop + el.offsetHeight > mid) break;
      i++;
    }
    i = Math.min(i, this.doc.pages.length - 1);
    if (i !== this.current) {
      this.current = i;
      this.hooks.onPage?.(i);
    }
  }

  scrollToPage(i, yFrac = 0) {
    const el = this.pagesEl.children[i];
    if (el) this.host.scrollTop = el.offsetTop - 8 + yFrac * el.offsetHeight;
  }

  async goToDest(dest) {
    const pdf = this.doc.primarySource()?.pdf;
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!dest) return;
      const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      const src = this.doc.primarySource().id;
      const i = this.doc.pages.findIndex((p) => p.src === src && p.idx === idx);
      if (i >= 0) this.scrollToPage(i);
    } catch (e) {
      console.warn(e);
    }
  }

  /* ---------- search ---------- */

  setSearch(q) {
    this.query = q.trim().toLowerCase();
    for (const el of this.els.values()) {
      const tl = el.querySelector('.textLayer');
      if (tl) this.applySearch(el, tl);
    }
  }
  applySearch(el, tl) {
    for (const s of [...tl.querySelectorAll('span[role="presentation"]'), ...(el._ocr?.children || [])]) {
      const raw = s.dataset.raw ?? s.textContent;
      const i = this.query ? raw.toLowerCase().indexOf(this.query) : -1;
      if (i < 0) {
        if (s.dataset.raw != null) {
          s.textContent = raw;
          delete s.dataset.raw;
        }
        continue;
      }
      s.dataset.raw = raw;
      s.replaceChildren(raw.slice(0, i), h('span.hit', raw.slice(i, i + this.query.length)), raw.slice(i + this.query.length));
    }
  }

  /* ---------- OCR text layer ---------- */

  drawOcr(el, pg) {
    const host = el._ocr;
    if (!host) return;
    host.replaceChildren();
    if (!pg.ocr) return;
    const g = (this._mctx ||= document.createElement('canvas').getContext('2d'));
    const S = this.scale;
    for (const w of pg.ocr) {
      g.font = `${w.h}px sans-serif`;
      const mw = g.measureText(w.text + ' ').width || 1;
      host.append(
        h(
          'span',
          {
            style: {
              left: w.x * S + 'px',
              top: w.y * S + 'px',
              fontSize: w.h * S + 'px',
              transform: `scaleX(${(w.w + w.h * 0.25) / mw})`,
            },
          },
          w.text + ' ',
        ),
      );
    }
  }

  /* ---------- annotations overlay ---------- */

  redrawOverlays() {
    for (const el of this.els.values()) if (el._ov) this.drawOverlay(el);
    for (const pg of this.doc.pages) {
      const el = this.els.get(pg.id);
      if (el?._ocr && el._ocrRev !== pg.ocr) {
        el._ocrRev = pg.ocr;
        this.drawOcr(el, pg);
      }
    }
  }

  pageOf(el) {
    return this.doc.pages.find((p) => p.id === el.dataset.id);
  }
  findAnnot(sel) {
    const pg = this.doc?.pages.find((p) => p.id === sel.pageId);
    const a = pg?.annots.find((x) => x.id === sel.id);
    return a ? { pg, a } : null;
  }

  drawOverlay(el, override) {
    const pg = this.pageOf(el);
    const ov = el._ov;
    if (!pg || !ov) return;
    const S = this.scale;
    const editingHere = this.editing && this.editing.pageId === pg.id ? this.editing : null;
    const keepEl = editingHere ? ov.querySelector(`[data-id="${editingHere.id}"]`) : null;
    ov.replaceChildren();
    ov.dataset.tool = this.tool;
    // Highlight colour is painted in a layer under the text so it tints the page instead of hiding it;
    // the overlay keeps an invisible twin of each highlight for clicking and dragging.
    el._hl.replaceChildren(
      ...pg.annots
        .map((a) => (override && override.id === a.id ? override : a))
        .filter((a) => a.type === 'highlight')
        .flatMap((a) => a.rects.map((r) => h('i', { style: { left: r.x * S + 'px', top: r.y * S + 'px', width: r.w * S + 'px', height: r.h * S + 'px', background: a.color } }))),
    );
    if (this.tool === 'edittext') this.drawLineBoxes(el, pg, ov);
    for (let a of pg.annots) {
      if (override && override.id === a.id) a = override;
      if (keepEl && a.id === editingHere.id) {
        ov.append(keepEl);
        continue;
      }
      const node = this.annotEl(a, pg, S);
      node.dataset.id = a.id;
      node.classList.add('annot', 'a-' + a.type);
      if (this.sel?.id === a.id) node.classList.add('sel');
      ov.append(node);
    }
    if (this.sel?.pageId === pg.id && !editingHere) {
      let a = pg.annots.find((x) => x.id === this.sel.id);
      if (override && override.id === a?.id) a = override;
      if (a) {
        const b = bbox(a);
        const box = h('div.selbox', {
          style: { left: b.x * S - 3 + 'px', top: b.y * S - 3 + 'px', width: b.w * S + 6 + 'px', height: b.h * S + 6 + 'px' },
        });
        if (RESIZABLE.has(a.type)) box.append(h('div.handle', { dataset: { handle: 'se' } }));
        ov.append(box);
      }
    }
  }

  annotEl(a, pg, S) {
    const px = (v) => v * S + 'px';
    const place = (el, r) => Object.assign(el.style, { left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) });
    switch (a.type) {
      case 'highlight':
      case 'underline':
      case 'strike': {
        const g = h('div');
        for (const r of a.rects) {
          const d = h('div.mk');
          place(d, r);
          if (a.id === 'draft' && a.type === 'highlight') d.style.background = a.color;
          else if (a.type !== 'highlight') {
            const horiz = r.w >= r.h;
            const t = Math.max(1, (horiz ? r.h : r.w) * 0.07 * S);
            const f = a.type === 'underline' ? 0.93 : 0.55;
            d.append(
              h('i', {
                style: horiz
                  ? { left: 0, right: 0, top: `calc(${f * 100}% - ${t / 2}px)`, height: t + 'px', background: a.color }
                  : { top: 0, bottom: 0, left: `calc(${f * 100}% - ${t / 2}px)`, width: t + 'px', background: a.color },
              }),
            );
          }
          g.append(d);
        }
        return g;
      }
      case 'ink':
      case 'line':
      case 'arrow': {
        const g = h('div.vec');
        const s = svg('svg', { viewBox: `0 0 ${pg.w} ${pg.h}`, width: pg.w * S, height: pg.h * S });
        const common = { fill: 'none', stroke: a.color, 'stroke-width': a.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        const hit = { fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(a.sw, 14 / S), class: 'hit-area' };
        const add = (d) => {
          s.append(svg('path', { d, ...hit }), svg('path', { d, ...common }));
        };
        if (a.type === 'ink') {
          for (const p of a.paths) add('M' + p.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + (p.length === 1 ? 'h0.01' : ''));
        } else {
          let d = `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
          if (a.type === 'arrow') {
            const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
            const len = Math.max(8, a.sw * 4);
            const p = (t) => `${a.x2 - len * Math.cos(ang + t)} ${a.y2 - len * Math.sin(ang + t)}`;
            d += `M${p(0.45)}L${a.x2} ${a.y2}L${p(-0.45)}`;
          }
          add(d);
        }
        g.append(s);
        return g;
      }
      case 'rect':
      case 'ellipse': {
        const d = h('div.shape');
        place(d, a);
        if (a.fill) d.style.background = a.fill;
        if (a.color && a.sw) d.style.boxShadow = `inset 0 0 0 ${a.sw * S}px ${a.color}`;
        if (a.type === 'ellipse') d.style.borderRadius = '50%';
        if (a.whiteout) d.classList.add('whiteout');
        return d;
      }
      case 'redact': {
        const d = h('div.redact', h('span', 'Redacted on save'));
        place(d, a);
        return d;
      }
      case 'note': {
        const d = h('button.note', { type: 'button', title: a.text || 'Note', style: { color: a.color || '#f5b301' } }, icon('MessageSquareText', Math.max(14, 20 * S)));
        Object.assign(d.style, { left: px(a.x), top: px(a.y), width: px(20), height: px(20) });
        return d;
      }
      case 'image': {
        const d = h('div.box');
        place(d, a);
        const [ow, oh] = ownSize(a);
        d.append(
          h('img' + (a.angle ? '' : '.flat'), {
            src: a.data,
            draggable: false,
            style: { width: px(ow), height: px(oh), transform: `translate(-50%,-50%) rotate(${a.angle || 0}deg)` },
          }),
        );
        return d;
      }
      case 'text':
      case 'textedit': {
        const d = h('div.box');
        place(d, a);
        const [ow, oh] = ownSize(a);
        if (a.type === 'textedit' && a.bg) d.style.background = a.bg;
        const inner = h('div.txt' + (a.angle ? '' : '.flat'), {
          spellcheck: false,
          style: {
            width: a.type === 'text' ? px(ow) : 'auto',
            minWidth: a.type === 'textedit' ? px(ow) : null,
            minHeight: px(oh),
            transform: `translate(-50%,-50%) rotate(${a.angle || 0}deg)`,
            fontFamily: FONT_CSS[a.family || 'sans'],
            fontSize: px(a.size),
            lineHeight: LINE_H,
            fontWeight: a.bold ? '700' : '400',
            fontStyle: a.italic ? 'italic' : 'normal',
            color: a.color || '#000',
            padding: a.type === 'text' ? px(TEXT_PAD) : `${px(Math.max(0, a.base - a.size * 0.95))} 0 0 0`,
            whiteSpace: a.type === 'text' ? 'pre-wrap' : 'pre',
          },
        });
        inner.textContent = a.text;
        d.append(inner);
        return d;
      }
    }
    return h('div');
  }

  /* ---------- existing-text line detection ---------- */

  lines(el) {
    if (el._lines) return el._lines;
    const tc = el._tc;
    const vt = el._vp1.transform;
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = pdfjsLib.Util.transform(vt, it.transform);
      if (Math.abs(m[1]) > 0.02 * Math.abs(m[0]) + 0.01) continue; // skip rotated text
      const fh = Math.hypot(m[2], m[3]);
      if (fh < 3) continue;
      const st = tc.styles[it.fontName] || {};
      items.push({ str: it.str, x: m[4], base: m[5], w: it.width, fh, font: it.fontName, asc: st.ascent || 0.88, desc: st.descent || -0.2, fam: st.fontFamily || '' });
    }
    items.sort((a, b) => a.base - b.base || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const L = lines.find(
        (l) => Math.abs(l.base - it.base) < it.fh * 0.3 && Math.abs(l.fh - it.fh) < it.fh * 0.25 && it.x - (l.x + l.w) < it.fh * 1.2 && it.x - (l.x + l.w) > -it.fh * 0.5,
      );
      if (L) {
        const gap = it.x - (L.x + L.w);
        if (gap > it.fh * 0.18 && !L.str.endsWith(' ') && !it.str.startsWith(' ')) L.str += ' ';
        L.str += it.str;
        L.w = it.x + it.w - L.x;
      } else lines.push({ ...it });
    }
    for (const l of lines) {
      let name = '';
      try {
        name = el._page.commonObjs.get(l.font)?.name || '';
      } catch {}
      const n = (name + ' ' + l.fam).toLowerCase();
      l.family = /courier|mono|consol|menlo/.test(n) ? 'mono' : /times|georgia|garamond|minion|roman|(^| )serif|cambria|book/.test(n) && !/sans/.test(n) ? 'serif' : 'sans';
      l.bold = /bold|black|heavy|semibold|demi/.test(n);
      l.italic = /ital|obliq/.test(n);
      l.top = l.base - l.fh * l.asc;
      l.h = l.fh * (l.asc - l.desc);
    }
    return (el._lines = lines);
  }

  drawLineBoxes(el, pg, ov) {
    if (!el._tc) return;
    const S = this.scale;
    const taken = pg.annots.filter((a) => a.type === 'textedit');
    for (const l of this.lines(el)) {
      if (taken.some((a) => Math.abs(a.y - (l.top - 1)) < 2 && Math.abs(a.x - (l.x - 1)) < 2)) continue;
      const b = h('div.linebox', { title: 'Click to edit this line' });
      Object.assign(b.style, { left: (l.x - 1) * S + 'px', top: (l.top - 1) * S + 'px', width: (l.w + 2) * S + 'px', height: (l.h + 2) * S + 'px' });
      b._line = l;
      ov.append(b);
    }
  }

  sampleColors(el, pg, r) {
    const c = el._canvas;
    const k = c.width / pg.w;
    const x = Math.max(0, Math.floor(r.x * k));
    const y = Math.max(0, Math.floor(r.y * k));
    const w = Math.max(1, Math.min(c.width - x, Math.ceil(r.w * k)));
    const hh = Math.max(1, Math.min(c.height - y, Math.ceil(r.h * k)));
    let d;
    try {
      d = c.getContext('2d').getImageData(x, y, w, hh).data;
    } catch {
      return { bg: '#ffffff', fg: '#000000' };
    }
    // Background: most common colour along the box edge. Text: the pixel furthest from it.
    const count = new Map();
    const edge = (px, py) => {
      const i = (py * w + px) * 4;
      const key = (d[i] >> 3 << 10) | (d[i + 1] >> 3 << 5) | (d[i + 2] >> 3);
      const e = count.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++;
      e.r += d[i];
      e.g += d[i + 1];
      e.b += d[i + 2];
      count.set(key, e);
    };
    for (let px = 0; px < w; px += 2) {
      edge(px, 0);
      edge(px, hh - 1);
    }
    for (let py = 0; py < hh; py += 2) {
      edge(0, py);
      edge(w - 1, py);
    }
    let best = { n: 0 };
    for (const e of count.values()) if (e.n > best.n) best = e;
    const bg = [best.r / best.n, best.g / best.n, best.b / best.n];
    let far = 0;
    let fg = bg[0] + bg[1] + bg[2] > 380 ? [0, 0, 0] : [255, 255, 255];
    for (let i = 0; i < d.length; i += 16) {
      const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dist > far) {
        far = dist;
        fg = [d[i], d[i + 1], d[i + 2]];
      }
    }
    return { bg: rgbToHex(...bg), fg: rgbToHex(...fg) };
  }

  /* ---------- tools ---------- */

  setTool(tool) {
    if (MARKUP_TOOLS.has(tool) && this.markupFromSelection(tool)) tool = 'select';
    this.commitEdit();
    this.tool = tool;
    this.host.dataset.tool = tool;
    if (tool !== 'select') this.sel = null;
    this.redrawOverlays();
    this.hooks.onTool?.(tool);
    this.hooks.onSelect?.(this.getSelected());
  }

  select(sel) {
    if (this.sel?.id === sel?.id) return;
    this.commitEdit();
    this.sel = sel;
    this.redrawOverlays();
    this.hooks.onSelect?.(this.getSelected());
  }
  getSelected() {
    return this.sel ? this.findAnnot(this.sel)?.a || null : null;
  }

  updateSelected(patch) {
    const f = this.sel && this.findAnnot(this.sel);
    if (!f) return;
    this.commitEdit();
    this.doc.change('annots', () => {
      f.pg.annots = f.pg.annots.map((a) => (a.id === f.a.id ? { ...a, ...patch } : a));
    });
    if (f.a.type === 'text' && ('size' in patch || 'family' in patch || 'bold' in patch)) this.refit(f.pg, f.a.id);
    this.hooks.onSelect?.(this.getSelected());
  }

  /** Recompute a text box's height from its rendered content. */
  refit(pg, id) {
    const el = this.els.get(pg.id);
    const inner = el?._ov?.querySelector(`[data-id="${id}"] .txt`);
    if (!inner) return;
    const a = pg.annots.find((x) => x.id === id);
    inner.style.minHeight = '0';
    const oh = inner.offsetHeight / this.scale;
    const n = { ...a };
    if ((a.angle || 0) % 180) n.w = oh;
    else n.h = oh;
    pg.annots = pg.annots.map((x) => (x.id === id ? n : x));
    this.drawOverlay(el);
  }

  deleteSelected() {
    const f = this.sel && this.findAnnot(this.sel);
    if (!f) return false;
    this.editing = null;
    this.sel = null;
    this.doc.change('annots', () => {
      f.pg.annots = f.pg.annots.filter((a) => a.id !== f.a.id);
    });
    this.hooks.onSelect?.(null);
    return true;
  }

  addAnnot(pg, a, { select = true } = {}) {
    a.id = uid();
    this.doc.change('annots', () => {
      pg.annots = [...pg.annots, a];
    });
    if (select) {
      this.tool = 'select';
      this.host.dataset.tool = 'select';
      this.hooks.onTool?.('select');
      this.sel = { pageId: pg.id, id: a.id };
      this.redrawOverlays();
      this.hooks.onSelect?.(a);
    }
    return a;
  }

  /** Place an image (or signature) in the middle of the visible part of the current page. */
  placeImage(data, iw, ih, maxW = 220) {
    const pg = this.doc.pages[this.current || 0];
    const el = this.els.get(pg.id);
    const w = Math.min(maxW, pg.w * 0.6);
    const hh = (w * ih) / iw;
    const hostR = this.host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cy = clamp((hostR.top + hostR.height / 2 - r.top) / this.scale, hh / 2 + 4, pg.h - hh / 2 - 4);
    this.addAnnot(pg, { type: 'image', x: (pg.w - w) / 2, y: cy - hh / 2, w, h: hh, data, angle: 0 });
  }

  markupFromSelection(force) {
    const tool = force || this.tool;
    if (!MARKUP_TOOLS.has(tool) || !this.doc) return false;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return false;
    const range = s.getRangeAt(0);
    if (!this.host.contains(range.commonAncestorContainer)) return false;
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    const byPage = new Map();
    for (const el of this.els.values()) {
      if (!el._ov) continue;
      const pr = el.getBoundingClientRect();
      for (const r of rects) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) continue;
        if (r.width > pr.width * 0.98 && r.height > pr.height * 0.5) continue; // container rects
        const list = byPage.get(el) || [];
        list.push({ x: (r.left - pr.left) / this.scale, y: (r.top - pr.top) / this.scale, w: r.width / this.scale, h: r.height / this.scale });
        byPage.set(el, list);
      }
    }
    if (!byPage.size) return false;
    this.doc.change('annots', () => {
      for (const [el, list] of byPage) {
        // Merge fragments that sit on the same line.
        list.sort((a, b) => a.y - b.y || a.x - b.x);
        const merged = [];
        for (const r of list) {
          const m = merged.find((q) => Math.abs(q.y + q.h / 2 - (r.y + r.h / 2)) < Math.min(q.h, r.h) * 0.5 && r.x <= q.x + q.w + r.h * 0.6);
          if (m) {
            const x2 = Math.max(m.x + m.w, r.x + r.w);
            const y2 = Math.max(m.y + m.h, r.y + r.h);
            m.x = Math.min(m.x, r.x);
            m.y = Math.min(m.y, r.y);
            m.w = x2 - m.x;
            m.h = y2 - m.y;
          } else merged.push({ ...r });
        }
        const pg = this.pageOf(el);
        pg.annots = [...pg.annots, { id: uid(), type: tool, rects: merged, color: tool === 'highlight' ? this.style.hl : this.style.color }];
      }
    });
    s.removeAllRanges();
    return true;
  }

  /* ---------- pointer handling ---------- */

  bindOverlay(el, ov) {
    const pt = (e) => {
      const r = ov.getBoundingClientRect();
      const pg = this.pageOf(el);
      return [clamp((e.clientX - r.left) / this.scale, 0, pg.w), clamp((e.clientY - r.top) / this.scale, 0, pg.h)];
    };

    // Keep keyboard focus in a text box while the pointer is used elsewhere on the page.
    ov.addEventListener('mousedown', (e) => {
      if (DRAW_TOOLS.has(this.tool) && !e.target.closest('.editing')) e.preventDefault();
    });

    ov.addEventListener('dblclick', (e) => {
      const node = e.target.closest('.annot');
      if (!node || this.tool !== 'select') return;
      const pg = this.pageOf(el);
      const a = pg.annots.find((x) => x.id === node.dataset.id);
      if (a?.type === 'text' || a?.type === 'textedit') this.startEdit(el, pg, a.id);
    });

    ov.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const pg = this.pageOf(el);
      const tool = this.tool;
      const [x0, y0] = pt(e);

      if (this.editing) {
        if (e.target.closest(`[data-id="${this.editing.id}"]`)) return;
        this.commitEdit();
      }

      // --- select tool: pick, move, resize
      if (tool === 'select') {
        const handle = e.target.closest('.handle');
        const node = handle ? null : e.target.closest('.annot');
        const id = handle ? this.sel.id : node?.dataset.id;
        if (!id) return;
        e.preventDefault();
        const orig = pg.annots.find((a) => a.id === id);
        this.select({ pageId: pg.id, id });
        ov.setPointerCapture(e.pointerId);
        let cur = null;
        const move = (ev) => {
          const [x, y] = pt(ev);
          const dx = x - x0;
          const dy = y - y0;
          if (!cur && Math.hypot(dx, dy) * this.scale < 4) return;
          if (handle) {
            let w = Math.max(8, orig.w + dx);
            let hh = Math.max(8, orig.h + dy);
            if (orig.type === 'image') hh = (w * orig.h) / orig.w;
            cur = { ...orig, w: Math.min(w, pg.w - orig.x), h: Math.min(hh, pg.h - orig.y) };
          } else {
            const b = bbox(orig);
            cur = translate(orig, clamp(dx, -b.x, pg.w - b.x - b.w), clamp(dy, -b.y, pg.h - b.y - b.h));
          }
          this.drawOverlay(el, cur);
        };
        const up = () => {
          ov.removeEventListener('pointermove', move);
          ov.removeEventListener('pointerup', up);
          ov.removeEventListener('pointercancel', up);
          if (cur) {
            this.doc.change('annots', () => {
              pg.annots = pg.annots.map((a) => (a.id === id ? cur : a));
            });
            if (handle && orig.type === 'text') this.refit(pg, id);
          } else if (orig.type === 'note') this.editNote(pg, orig);
        };
        ov.addEventListener('pointermove', move);
        ov.addEventListener('pointerup', up);
        ov.addEventListener('pointercancel', up);
        return;
      }

      if (!DRAW_TOOLS.has(tool)) return;
      e.preventDefault();

      if (tool === 'edittext') {
        const box = e.target.closest('.linebox');
        const existing = e.target.closest('.a-textedit');
        if (existing) return this.startEdit(el, pg, existing.dataset.id);
        if (!box) return;
        const l = box._line;
        const r = { x: l.x - 1, y: l.top - 1, w: l.w + 2, h: l.h + 2 };
        const { bg, fg } = this.sampleColors(el, pg, r);
        const a = this.addAnnot(
          pg,
          { type: 'textedit', ...r, w0: r.w, text: l.str, orig: l.str, size: l.fh, base: l.base - r.y, family: l.family, bold: l.bold, italic: l.italic, color: fg, bg, angle: 0 },
          { select: false },
        );
        this.startEdit(el, pg, a.id);
        return;
      }

      if (tool === 'text') {
        const size = this.style.size;
        const w = Math.max(40, Math.min(240, pg.w - x0 - 4));
        const a = this.addAnnot(
          pg,
          { type: 'text', x: x0, y: Math.min(y0 - size * 0.6, pg.h - size * 1.5), w, h: size * LINE_H + TEXT_PAD * 2, text: '', size, family: this.style.family, bold: this.style.bold, italic: this.style.italic, color: this.style.color === '#d92d20' ? '#000000' : this.style.color, angle: 0 },
          { select: false },
        );
        this.startEdit(el, pg, a.id, true);
        return;
      }

      if (tool === 'note') {
        const a = this.addAnnot(pg, { type: 'note', x: Math.min(x0, pg.w - 22), y: Math.min(y0, pg.h - 22), text: '', color: '#f5b301' });
        this.editNote(pg, a, true);
        return;
      }

      // --- drag-to-draw tools
      ov.setPointerCapture(e.pointerId);
      const st = this.style;
      let draft =
        tool === 'pen'
          ? { type: 'ink', paths: [[[x0, y0]]], color: st.color, sw: st.sw }
          : tool === 'line' || tool === 'arrow'
            ? { type: tool, x1: x0, y1: y0, x2: x0, y2: y0, color: st.color, sw: st.sw }
            : tool === 'whiteout'
              ? { type: 'rect', whiteout: true, x: x0, y: y0, w: 0, h: 0, fill: '#ffffff', color: null, sw: 0 }
              : tool === 'redact'
                ? { type: 'redact', x: x0, y: y0, w: 0, h: 0 }
                : { type: tool, x: x0, y: y0, w: 0, h: 0, color: st.color, sw: st.sw, fill: null };
      draft.id = 'draft';
      const preview = h('div.draft');
      ov.append(preview);
      const show = () => {
        const node = this.annotEl(draft, pg, this.scale);
        node.classList.add('annot', 'a-' + draft.type);
        preview.replaceChildren(node);
      };
      const move = (ev) => {
        const evs = ev.getCoalescedEvents?.() || [ev];
        for (const c of evs.length ? evs : [ev]) {
          const [x, y] = pt(c);
          if (draft.type === 'ink') {
            const p = draft.paths[0];
            const last = p[p.length - 1];
            if (Math.hypot(x - last[0], y - last[1]) * this.scale > 1.5) p.push([x, y]);
          } else if (draft.x1 != null) {
            draft.x2 = x;
            draft.y2 = y;
          } else {
            draft.x = Math.min(x0, x);
            draft.y = Math.min(y0, y);
            draft.w = Math.abs(x - x0);
            draft.h = Math.abs(y - y0);
          }
        }
        show();
      };
      const up = () => {
        ov.removeEventListener('pointermove', move);
        ov.removeEventListener('pointerup', up);
        ov.removeEventListener('pointercancel', up);
        preview.remove();
        const b = bbox(draft);
        if (draft.type !== 'ink' && Math.max(b.w, b.h) * this.scale < 4) return;
        this.addAnnot(pg, draft, { select: false });
      };
      ov.addEventListener('pointermove', move);
      ov.addEventListener('pointerup', up);
      ov.addEventListener('pointercancel', up);
    });
  }

  startEdit(el, pg, id, isNew = false) {
    this.commitEdit();
    this.sel = { pageId: pg.id, id };
    this.drawOverlay(el);
    const node = el._ov.querySelector(`[data-id="${id}"]`);
    const inner = node?.querySelector('.txt');
    if (!inner) return;
    this.editing = { pageId: pg.id, id, isNew, el };
    node.classList.add('editing');
    inner.contentEditable = 'true';
    try {
      inner.contentEditable = 'plaintext-only';
    } catch {}
    inner.focus();
    const r = document.createRange();
    r.selectNodeContents(inner);
    if (isNew) r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    inner.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && pg.annots.find((a) => a.id === id)?.type === 'textedit')) {
        e.preventDefault();
        this.commitEdit();
      }
    });
    inner.addEventListener('blur', () => setTimeout(() => this.editing?.id === id && this.commitEdit(), 150));
    this.hooks.onSelect?.(this.getSelected());
  }

  commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const f = this.findAnnot(ed);
    const inner = ed.el._ov?.querySelector(`[data-id="${ed.id}"] .txt`);
    if (!f || !inner) return this.redrawOverlays();
    const text = inner.innerText.replace(/ /g, ' ').replace(/\n$/, '');
    const a = f.a;
    if (a.type === 'text' && !text.trim()) {
      // An empty text box is discarded along with the undo step that created it.
      f.pg.annots = f.pg.annots.filter((x) => x.id !== a.id);
      if (ed.isNew) this.doc.undo.pop();
      this.sel = null;
      this.doc.emit('annots');
      this.hooks.onSelect?.(null);
      return;
    }
    const n = { ...a, text: a.type === 'textedit' ? text.replace(/\n/g, ' ') : text };
    inner.style.minHeight = '0';
    inner.style.minWidth = '0';
    if (a.type === 'text') {
      const oh = Math.max(inner.offsetHeight / this.scale, a.size * LINE_H + TEXT_PAD * 2);
      if ((a.angle || 0) % 180) n.w = oh;
      else n.h = oh;
    } else {
      const ow = Math.max(a.w0, inner.offsetWidth / this.scale + 1);
      if ((a.angle || 0) % 180) n.h = ow;
      else n.w = ow;
    }
    if (n.text === a.text && n.w === a.w && n.h === a.h) return this.redrawOverlays();
    if (ed.isNew) {
      f.pg.annots = f.pg.annots.map((x) => (x.id === a.id ? n : x));
      this.doc.dirty = true;
      this.doc.emit('annots');
    } else {
      this.doc.change('annots', () => {
        f.pg.annots = f.pg.annots.map((x) => (x.id === a.id ? n : x));
      });
    }
  }

  async editNote(pg, a, isNew) {
    const text = await this.hooks.askNote(a.text, isNew);
    if (text === undefined) {
      if (isNew) {
        pg.annots = pg.annots.filter((x) => x.id !== a.id);
        this.doc.undo.pop();
        this.sel = null;
        this.doc.emit('annots');
      }
      return;
    }
    if (text === null) return this.deleteSelected();
    if (text !== a.text) {
      this.doc.change('annots', () => {
        pg.annots = pg.annots.map((x) => (x.id === a.id ? { ...x, text } : x));
      });
    }
  }
}

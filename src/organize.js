import { h, icon, uid, toast } from './util.js';
import { pageView, rotatePage, addSource, pagesFromSource, sources } from './model.js';
import { blankPdf } from './export.js';

/* ---- shared thumbnail rendering with a small cache ---- */
const thumbCache = new Map();
let chain = Promise.resolve();

export function thumb(pg, width = 150) {
  const key = `${pg.src}:${pg.idx}:${pg.rot}:${width}`;
  const c = h('canvas.thumb-canvas');
  c.width = width * 2;
  c.height = Math.round((width * 2 * pg.h) / pg.w);
  c.style.aspectRatio = `${pg.w} / ${pg.h}`;
  const hit = thumbCache.get(key);
  if (hit) {
    c.getContext('2d').drawImage(hit, 0, 0);
    return c;
  }
  // Render one at a time so a long document does not flood the PDF worker.
  chain = chain.then(async () => {
    if (!c.isConnected && !c._force) return;
    try {
      const { page, viewport } = await pageView(pg, (width * 2) / pg.w);
      await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
      thumbCache.set(key, c);
      if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value);
    } catch {}
  });
  return c;
}

/** Lazily fill thumbnail slots as they scroll into view. */
export function lazyThumbs(root, getPage, width) {
  const io = new IntersectionObserver(
    (ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const pg = getPage(e.target.dataset.id);
        if (pg) e.target.replaceChildren(thumb(pg, width));
      }
    },
    { root, rootMargin: '400px' },
  );
  return io;
}

export const clonePage = (p) => ({ ...p, id: uid(), annots: p.annots.map((a) => ({ ...a, id: uid() })) });

export class Organizer {
  constructor(host, app) {
    this.host = host;
    this.app = app;
    this.sel = new Set();
    this.anchor = null;
    this.grid = h('div.org-grid', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Pages' });
    this.bar = h('div.org-bar');
    this.count = h('span.org-count');
    host.append(this.bar, this.grid);
    this.io = lazyThumbs(this.grid, (id) => this.doc?.pages.find((p) => p.id === id), 170);
    this.buildBar();
  }

  get doc() {
    return this.app.doc;
  }

  buildBar() {
    const b = (ic, label, fn, needSel = true) =>
      h('button.btn.small', { type: 'button', title: label, dataset: needSel ? { needsel: '1' } : {}, onClick: fn }, icon(ic, 16), h('span', label));
    this.bar.append(
      h('div.org-group', this.count, h('button.btn.small', { type: 'button', onClick: () => this.selectAll() }, 'Select all')),
      h(
        'div.org-group',
        b('RotateCcw', 'Rotate left', () => this.rotate(-1)),
        b('RotateCw', 'Rotate right', () => this.rotate(1)),
        b('ArrowLeft', 'Move earlier', () => this.move(-1)),
        b('ArrowRight', 'Move later', () => this.move(1)),
        b('Copy', 'Duplicate', () => this.duplicate()),
        b('Trash2', 'Delete', () => this.remove()),
      ),
      h(
        'div.org-group',
        b('FileOutput', 'Extract to new tab', () => this.extract()),
        b('ArrowRightLeft', 'Copy to another tab', () => this.copyToTab()),
        b('Scissors', 'Split into files', () => this.app.splitDoc(), false),
      ),
      h(
        'div.org-group',
        b('FilePlus2', 'Insert blank page', () => this.insertBlank(), false),
        b('Files', 'Insert PDF', () => this.insertPdf(), false),
        b('ImagePlus', 'Insert images', () => this.insertImages(), false),
      ),
      h('button.btn.primary.small.org-done', { type: 'button', onClick: () => this.app.setMode('view') }, 'Done'),
    );
  }

  refresh() {
    const doc = this.doc;
    if (!doc) return;
    for (const id of [...this.sel]) if (!doc.pages.some((p) => p.id === id)) this.sel.delete(id);
    const old = new Map([...this.grid.children].map((el) => [el.dataset.key, el]));
    const cells = doc.pages.map((pg, i) => {
      const key = `${pg.id}:${pg.rot}`;
      let cell = old.get(key);
      if (!cell) {
        const slot = h('div.org-thumb', { dataset: { id: pg.id }, style: { aspectRatio: `${pg.w} / ${pg.h}` } });
        cell = h('div.org-cell', { role: 'option', tabIndex: 0, draggable: true, dataset: { id: pg.id, key } }, slot, h('div.org-num'));
        this.io.observe(slot);
        this.bindCell(cell);
      }
      cell.querySelector('.org-num').textContent = i + 1;
      cell.classList.toggle('on', this.sel.has(pg.id));
      cell.setAttribute('aria-selected', this.sel.has(pg.id));
      return cell;
    });
    cells.forEach((el, i) => {
      if (this.grid.children[i] !== el) this.grid.insertBefore(el, this.grid.children[i] || null);
    });
    while (this.grid.children.length > cells.length) this.grid.lastChild.remove();
    this.updateBar();
  }

  updateBar() {
    const n = this.sel.size;
    this.count.textContent = n ? `${n} of ${this.doc.pages.length} selected` : `${this.doc.pages.length} pages`;
    for (const el of this.bar.querySelectorAll('[data-needsel]')) el.disabled = !n;
  }

  bindCell(cell) {
    const id = cell.dataset.id;
    const toggle = (e) => {
      const ids = this.doc.pages.map((p) => p.id);
      if (e.shiftKey && this.anchor) {
        const [a, b] = [ids.indexOf(this.anchor), ids.indexOf(id)].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) this.sel.add(ids[i]);
      } else {
        this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id);
        this.anchor = id;
      }
      this.refresh();
    };
    cell.addEventListener('click', toggle);
    cell.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggle(e);
      }
    });
    cell.addEventListener('dblclick', () => {
      this.app.setMode('view');
      this.app.viewer.scrollToPage(this.doc.pages.findIndex((p) => p.id === id));
    });
    cell.addEventListener('dragstart', (e) => {
      if (!this.sel.has(id)) {
        this.sel = new Set([id]);
        this.refresh();
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'pages');
      this.dragging = true;
    });
    cell.addEventListener('dragend', () => {
      this.dragging = false;
      for (const el of this.grid.querySelectorAll('.drop-before,.drop-after')) el.classList.remove('drop-before', 'drop-after');
    });
    cell.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      const r = cell.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      for (const el of this.grid.querySelectorAll('.drop-before,.drop-after')) el.classList.remove('drop-before', 'drop-after');
      cell.classList.add(after ? 'drop-after' : 'drop-before');
    });
    cell.addEventListener('drop', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const after = cell.classList.contains('drop-after');
      if (this.sel.has(id)) return;
      this.doc.change('pages', () => {
        const moving = this.doc.pages.filter((p) => this.sel.has(p.id));
        const rest = this.doc.pages.filter((p) => !this.sel.has(p.id));
        const at = rest.findIndex((p) => p.id === id) + (after ? 1 : 0);
        rest.splice(at, 0, ...moving);
        this.doc.pages = rest;
      });
    });
  }

  selectAll() {
    const all = this.sel.size === this.doc.pages.length;
    this.sel = new Set(all ? [] : this.doc.pages.map((p) => p.id));
    this.refresh();
  }
  selected() {
    return this.doc.pages.filter((p) => this.sel.has(p.id));
  }
  /** Index after the last selected page, or the end. */
  insertAt() {
    let i = -1;
    this.doc.pages.forEach((p, n) => {
      if (this.sel.has(p.id)) i = n;
    });
    return i < 0 ? this.doc.pages.length : i + 1;
  }

  rotate(dir) {
    this.doc.change('pages', () => {
      this.doc.pages = this.doc.pages.map((p) => (this.sel.has(p.id) ? rotatePage(p, dir) : p));
    });
  }
  move(dir) {
    const pages = [...this.doc.pages];
    const idx = pages.map((p, i) => (this.sel.has(p.id) ? i : -1)).filter((i) => i >= 0);
    if (dir < 0 ? idx[0] === 0 : idx[idx.length - 1] === pages.length - 1) return;
    for (const i of dir < 0 ? idx : idx.reverse()) [pages[i], pages[i + dir]] = [pages[i + dir], pages[i]];
    this.doc.change('pages', () => (this.doc.pages = pages));
  }
  duplicate() {
    const copies = [];
    this.doc.change('pages', () => {
      this.doc.pages = this.doc.pages.flatMap((p) => {
        if (!this.sel.has(p.id)) return [p];
        const c = clonePage(p);
        copies.push(c.id);
        return [p, c];
      });
    });
    this.sel = new Set(copies);
    this.refresh();
  }
  remove() {
    if (this.sel.size >= this.doc.pages.length) return toast('A document needs at least one page.', 'error');
    this.doc.change('pages', () => {
      this.doc.pages = this.doc.pages.filter((p) => !this.sel.has(p.id));
    });
    this.sel.clear();
    this.refresh();
  }
  extract() {
    this.app.newDocFromPages(this.selected().map(clonePage), this.doc.name.replace(/\.pdf$/i, '') + ' (extract).pdf');
  }
  copyToTab() {
    this.app.copyPagesToTab(this.selected().map(clonePage));
  }
  insert(pages) {
    const at = this.insertAt();
    this.doc.change('pages', () => {
      const list = [...this.doc.pages];
      list.splice(at, 0, ...pages);
      this.doc.pages = list;
    });
    this.sel = new Set(pages.map((p) => p.id));
    this.refresh();
    this.grid.children[at]?.scrollIntoView({ block: 'nearest' });
  }
  async insertBlank() {
    const ref = this.doc.pages[Math.max(0, this.insertAt() - 1)];
    const src = await addSource(await blankPdf(ref.w, ref.h), 'Blank page');
    this.insert(pagesFromSource(src));
  }
  async insertPdf() {
    const pages = await this.app.pickPdfPages();
    if (pages.length) this.insert(pages);
  }
  async insertImages() {
    const pages = await this.app.pickImagePages();
    if (pages.length) this.insert(pages);
  }
}

void sources;

import { pageView } from './model.js';

let workerPromise = null;
const BASE = new URL('./ocr/', document.baseURI).href;

async function getWorker(onStatus) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng', 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'core/',
        langPath: BASE + 'lang/',
        gzip: true,
        workerBlobURL: false,
        logger: (m) => onStatus?.(m),
      });
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

/** Recognise text on one page. Returns words in page display coordinates (points). */
export async function ocrPage(pg, onStatus) {
  const worker = await getWorker(onStatus);
  const k = 200 / 72;
  const { page, viewport } = await pageView(pg, k);
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport }).promise;
  const { data } = await worker.recognize(c, {}, { blocks: true });
  c.width = 0;
  const words = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        // Use the line's height for every word so selection highlights line up.
        const ly = l.bbox.y0 / k;
        const lh = (l.bbox.y1 - l.bbox.y0) / k;
        for (const w of l.words || []) {
          if (!w.text.trim() || w.confidence < 30) continue;
          words.push({ text: w.text, x: w.bbox.x0 / k, y: ly, w: (w.bbox.x1 - w.bbox.x0) / k, h: lh });
        }
      }
    }
  }
  return words;
}

/** True when a page already carries real text, so OCR would only duplicate it. */
export async function hasText(pg) {
  const { page } = await pageView(pg, 1);
  const tc = await page.getTextContent();
  return tc.items.reduce((n, it) => n + (it.str || '').trim().length, 0) > 20;
}

// Copies the runtime files that must be served as-is: pdf.js character maps and fonts,
// and the OCR engine with its English language data. Everything ships with the app, so it works offline.
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const pub = (...p) => join(root, 'public', ...p);

for (const d of ['pdfjs', 'ocr']) rmSync(pub(d), { recursive: true, force: true });
mkdirSync(pub('ocr', 'core'), { recursive: true });
mkdirSync(pub('ocr', 'lang'), { recursive: true });

cpSync(nm('pdfjs-dist', 'cmaps'), pub('pdfjs', 'cmaps'), { recursive: true });
cpSync(nm('pdfjs-dist', 'standard_fonts'), pub('pdfjs', 'standard_fonts'), { recursive: true });
cpSync(nm('pdfjs-dist', 'web', 'images'), pub('pdfjs', 'images'), { recursive: true });
cpSync(nm('tesseract.js', 'dist', 'worker.min.js'), pub('ocr', 'worker.min.js'));
for (const f of readdirSync(nm('tesseract.js-core'))) {
  // The LSTM-only builds are all the app uses; skip the larger legacy-engine builds.
  if (/^tesseract-core.*-lstm\.(wasm\.js|js|wasm)$/.test(f)) cpSync(nm('tesseract.js-core', f), pub('ocr', 'core', f));
}
cpSync(nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), pub('ocr', 'lang', 'eng.traineddata.gz'));
console.log('assets copied');

// Builds a small PDF with text, a form and several pages for the smoke test.
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
for (let i = 1; i <= 3; i++) {
  const p = doc.addPage([595.28, 841.89]);
  p.drawText(`Quarterly report, page ${i}`, { x: 60, y: 770, size: 22, font: bold });
  const lines = [
    'The quick brown fox jumps over the lazy dog.',
    'Invoice total: 1,250.00 due on 30 November.',
    'Contact the office to arrange delivery.',
  ];
  lines.forEach((l, n) => p.drawText(l, { x: 60, y: 720 - n * 22, size: 13, font, color: rgb(0.1, 0.1, 0.1) }));
  if (i === 1) {
    const form = doc.getForm();
    p.drawText('Name:', { x: 60, y: 600, size: 12, font });
    const tf = form.createTextField('customer.name');
    tf.addToPage(p, { x: 110, y: 592, width: 220, height: 22 });
    p.drawText('Approved:', { x: 60, y: 560, size: 12, font });
    form.createCheckBox('approved').addToPage(p, { x: 130, y: 556, width: 16, height: 16 });
  }
}
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/fixture.pdf', import.meta.url), await doc.save());
console.log('fixture written');

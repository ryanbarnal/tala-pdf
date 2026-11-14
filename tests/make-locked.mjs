// A PDF that opens without a password but is encrypted with an owner password and restricted
// permissions, like many manuals and bank statements. This is what failed to save.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { writeFileSync } from 'node:fs';
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 2; i++) d.addPage([595, 842]).drawText(`User manual page ${i}: activate the camera first.`, { x: 60, y: 760, size: 14, font: f });
d.encrypt({ userPassword: '', ownerPassword: 'owner-secret', permissions: { printing: 'lowResolution', modifying: false, copying: false, annotating: false } });
writeFileSync(new URL('./out/locked.pdf', import.meta.url), await d.save());
console.log('locked.pdf written');

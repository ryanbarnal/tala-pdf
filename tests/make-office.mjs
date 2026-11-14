// Real Word, Excel and PowerPoint files for the conversion tests.
import { writeFileSync } from 'node:fs';
import * as D from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';

const out = (n) => new URL('./out/' + n, import.meta.url);

const doc = new D.Document({
  sections: [
    {
      children: [
        new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun('Service agreement')] }),
        new D.Paragraph({ children: [new D.TextRun({ text: 'This agreement is made between ', bold: false }), new D.TextRun({ text: 'Tala Studio', bold: true }), new D.TextRun(' and the client.')] }),
        ...Array.from({ length: 70 }, (_, i) => new D.Paragraph(`Clause ${i + 1}. The provider will deliver the work described in schedule ${i + 1} on time and to the agreed standard.`)),
        new D.Table({
          rows: [
            new D.TableRow({ children: ['Item', 'Amount'].map((t) => new D.TableCell({ children: [new D.Paragraph(t)] })) }),
            new D.TableRow({ children: ['Design', '42,000'].map((t) => new D.TableCell({ children: [new D.Paragraph(t)] })) }),
          ],
        }),
        new D.Paragraph('Final clause: signed in Makati.'),
      ],
    },
  ],
});
writeFileSync(out('contract.docx'), Buffer.from(await D.Packer.toBuffer(doc)));

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Budget');
ws.addRow(['Category', 'January', 'February', 'March']);
ws.getRow(1).font = { bold: true };
ws.addRow(['Rent', 18500, 18500, 18500]);
ws.addRow(['Utilities', 3200.5, 2980, 3105.25]);
ws.addRow(['Groceries', 9100, 8700, 9400]);
ws.mergeCells('A6:D6');
ws.getCell('A6').value = 'Quarter total 101,086';
wb.addWorksheet('Notes').addRow(['Rates reviewed every quarter']);
await wb.xlsx.writeFile(out('budget.xlsx').pathname);

const pres = new PptxGenJS();
pres.layout = 'LAYOUT_16x9';
const s1 = pres.addSlide();
s1.addText('Quarterly review', { x: 0.5, y: 0.6, w: 9, h: 1.2, fontSize: 40, bold: true, color: '1B2338' });
s1.addText('Prepared for the board', { x: 0.5, y: 2.0, w: 9, h: 0.8, fontSize: 20 });
const s2 = pres.addSlide();
s2.background = { color: 'F4F1FF' };
s2.addText('Highlights', { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 30, bold: true });
s2.addText([{ text: 'Revenue up 12 percent', options: { bullet: true } }, { text: 'Two new offices opened', options: { bullet: true } }], { x: 0.7, y: 1.5, w: 8.5, h: 2, fontSize: 20 });
s2.addShape(pres.ShapeType.rect, { x: 7.5, y: 3.6, w: 1.8, h: 1.2, fill: { color: 'E2A400' } });
writeFileSync(out('review.pptx'), await pres.write({ outputType: 'nodebuffer' }));
writeFileSync(out('notes.txt'), 'Meeting notes\n\nAgenda: budget, hiring, office move.\n');
writeFileSync(out('old.doc'), 'not really a doc');
console.log('office fixtures written');

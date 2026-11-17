// Builds the Tala PDF user manual (public/manual/Tala-PDF-Manual.pdf) from the real app.
//   npm run build && npm run manual
// Needs Playwright with Chromium (npx playwright install chromium).
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const shots = require('./manual-shots.cjs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'tests', 'out', 'manual');
const OUT = path.join(ROOT, 'public', 'manual', 'Tala-PDF-Manual.pdf');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const font = (p) => 'file://' + path.join(ROOT, 'node_modules', '@fontsource', p);
const svgFile = (n) => fs.readFileSync(path.join(ROOT, 'branding', n), 'utf8').replace(/^<svg /, '<svg class="cover-svg" ');

const fig = (name, caption, extra = '') => `<figure class="${extra}"><img src="${name}.jpg" alt=""><figcaption>${caption}</figcaption></figure>`;
const steps = (...items) => `<ol class="steps">${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
const tip = (t) => `<p class="tip"><strong>Tip.</strong> ${t}</p>`;
const note = (t) => `<p class="note"><strong>Good to know.</strong> ${t}</p>`;
const k = (s) => s.split('+').map((x) => `<kbd>${x}</kbd>`).join('+');

function html(c) {
  const ws = c.workspace || {};
  const labels = [
    ['tabs', 'Document tabs. Each open file has its own tab; a dot means unsaved changes.'],
    ['sidebar', 'Sidebar with page thumbnails, the outline and search.'],
    ['file', 'Open, Save, Save as, Export and Search.'],
    ['tools', 'Mark-up and editing tools.'],
    ['pages', 'Pages view for reordering, rotating, merging and splitting.'],
    ['more', 'More actions: print, share, OCR, password, file size.'],
    ['help', 'Help: this manual, keyboard shortcuts and About.'],
    ['page', 'The document. Scroll to move between pages.'],
  ].filter(([key]) => ws[key]);
  const pins = labels.map(([key], i) => `<span class="pin" style="left:${(ws[key].x * 100).toFixed(2)}%;top:${(ws[key].y * 100).toFixed(2)}%">${i + 1}</span>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tala PDF User Manual</title><style>
@font-face { font-family: Fraunces; font-weight: 600; src: url(${font('fraunces/files/fraunces-latin-600-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Source Sans 3'; font-weight: 400; src: url(${font('source-sans-3/files/source-sans-3-latin-400-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Source Sans 3'; font-weight: 600; src: url(${font('source-sans-3/files/source-sans-3-latin-600-normal.woff2')}) format('woff2'); }
@font-face { font-family: 'Source Sans 3'; font-weight: 400; font-style: italic; src: url(${font('source-sans-3/files/source-sans-3-latin-400-italic.woff2')}) format('woff2'); }
@page { size: A4; margin: 18mm 18mm 20mm; }
@page :first { margin: 0; }
:root { --ink: #0f1e3d; --teal: #0e7c74; --blue: #163a7a; --gold: #f0a92b; --muted: #55607a; --line: #d8dee8; --wash: #f1f6f6; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10.5pt/1.55 'Source Sans 3', sans-serif; color: var(--ink); }
h1, h2, h3 { font-family: Fraunces, Georgia, serif; font-weight: 600; line-height: 1.2; break-after: avoid; }
h2 { font-size: 21pt; margin: 0 0 10pt; color: var(--blue); }
h2 .n { color: var(--teal); margin-right: 8pt; }
h3 { font-size: 13pt; margin: 16pt 0 5pt; }
p { margin: 0 0 7pt; }
.chapter { break-before: page; }
.lead { font-size: 12pt; color: var(--muted); margin-bottom: 12pt; }
figure { margin: 10pt 0 12pt; break-inside: avoid; }
figure img { width: 100%; display: block; border: 1px solid var(--line); border-radius: 6pt; }
figure.half { width: 62%; }
figure.wide { width: 82%; }
figure.small { width: 40%; }
figure.phone { width: 38%; float: right; margin: 0 0 8pt 14pt; }
figcaption { font-size: 9pt; color: var(--muted); margin-top: 4pt; font-style: italic; }
.steps { padding-left: 16pt; margin: 4pt 0 9pt; }
.steps li { margin-bottom: 3pt; }
ul { padding-left: 15pt; margin: 3pt 0 9pt; } li { margin-bottom: 2pt; }
.tip, .note { padding: 7pt 10pt; border-radius: 5pt; margin: 8pt 0 10pt; break-inside: avoid; }
.tip { background: #fff5e2; border-left: 3pt solid var(--gold); }
.note { background: var(--wash); border-left: 3pt solid var(--teal); }
kbd { font: 8.5pt/1 ui-monospace, Menlo, Consolas, monospace; border: 1px solid #b9c3d3; border-bottom-width: 2px; border-radius: 3pt; padding: 1.5pt 4pt; background: #f6f8fb; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; break-inside: auto; }
td, th { text-align: left; padding: 5pt 6pt; border-top: 1px solid var(--line); vertical-align: top; }
th { font-size: 8.5pt; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-top: 0; }
tr { break-inside: avoid; }
.tool { white-space: nowrap; font-weight: 600; }
.annot { position: relative; }
.pin { position: absolute; transform: translate(-50%, -50%); width: 17pt; height: 17pt; border-radius: 50%; background: var(--gold); color: var(--ink); font: 600 9pt/17pt 'Source Sans 3'; text-align: center; box-shadow: 0 0 0 2pt #fff; }
.legend { columns: 2; column-gap: 18pt; padding-left: 15pt; font-size: 9.5pt; }
.cover { height: 297mm; padding: 28mm 22mm 22mm; display: flex; flex-direction: column; color: #fff; background: radial-gradient(120% 90% at 25% 15%, #0e7c74 0%, #163a7a 55%, #0f1e3d 100%); }
.cover .cover-svg { width: 150px; height: auto; }
.cover h1 { font-size: 40pt; margin: 26pt 0 4pt; }
.cover h1 span { color: var(--gold); }
.cover .sub { font-size: 15pt; color: #c8d6ec; margin: 0; }
.cover .grow { flex: 1; }
.cover .meta { font-size: 10.5pt; color: #c8d6ec; line-height: 1.7; }
.cover .meta strong { color: #fff; }
.toc { list-style: none; padding: 0; margin: 10pt 0 0; columns: 2; column-gap: 24pt; }
.toc li { padding: 5pt 0; border-bottom: 1px solid var(--line); break-inside: avoid; }
.toc a { color: var(--ink); text-decoration: none; }
.toc .n { display: inline-block; width: 20pt; color: var(--teal); font-weight: 600; }
.clear { clear: both; }
.credit { margin-top: 18pt; padding-top: 10pt; border-top: 1px solid var(--line); color: var(--muted); }
</style></head><body>

<section class="cover">
  ${svgFile('tala-pdf-mark-on-dark.svg')}
  <h1>Tala <span>PDF</span></h1>
  <p class="sub">User manual</p>
  <div class="grow"></div>
  <div class="meta"><strong>Version ${pkg.version}</strong><br>Read, mark up, sign and edit PDFs on Windows, macOS and any browser.<br><br>Created by <strong>Ryan Ocbina Barnal</strong></div>
</section>

<section>
  <h2>Contents</h2>
  <ol class="toc">
    ${[
      ['start', 'Getting started'], ['tour', 'A tour of the app'], ['open', 'Opening and creating files'], ['read', 'Reading and finding'],
      ['markup', 'Marking up'], ['forms', 'Forms and signatures'], ['edit', 'Changing existing text'], ['pages', 'Working with pages'],
      ['save', 'Saving, exporting and printing'], ['protect', 'Protecting and shrinking files'], ['ocr', 'Scanned documents (OCR)'],
      ['phone', 'Using Tala PDF on a phone'], ['keys', 'Keyboard shortcuts'], ['faq', 'Questions and troubleshooting'],
    ].map(([id, t], i) => `<li><a href="#${id}"><span class="n">${i + 1}</span>${t}</a></li>`).join('')}
  </ol>
  <h3>About this manual</h3>
  <p>Tala PDF reads, marks up, signs and edits PDF files. It also turns Word, Excel and PowerPoint files into PDFs, and PDFs back into those formats. It works the same in the desktop app for Windows and macOS and in a web browser on any phone, tablet or computer.</p>
  <p>Everything happens on your own device. Files are never uploaded, so Tala PDF works offline and your documents stay private.</p>
  <p>In this manual, <strong>Ctrl</strong> means the Control key on Windows and the Command key (⌘) on a Mac.</p>
</section>

<section class="chapter" id="start">
  <h2><span class="n">1</span>Getting started</h2>
  <p class="lead">Install the desktop app, or open Tala PDF in a browser.</p>
  <h3>On Windows</h3>
  ${steps('Download <em>Tala-PDF-Setup</em> (.exe) from the Releases page of the Tala PDF repository.', 'Open it. If Windows shows "Windows protected your PC", choose <strong>More info</strong>, then <strong>Run anyway</strong>. This appears because the installer is not yet code-signed.', 'Follow the installer. Tala PDF appears in the Start menu.')}
  <h3>On a Mac</h3>
  ${steps('Download the disk image (.dmg): <em>arm64</em> for Apple silicon Macs (M1 and later), <em>x64</em> for Intel Macs.', 'Open it and drag Tala PDF into Applications.', 'Open Tala PDF. If macOS blocks it, open <strong>System Settings › Privacy &amp; Security</strong>, scroll down and choose <strong>Open Anyway</strong>.')}
  <h3>On a phone, tablet or any browser</h3>
  <p>Open the Tala PDF web address. To keep it on your home screen and use it offline:</p>
  <ul><li><strong>iPhone or iPad:</strong> tap Share, then <strong>Add to Home Screen</strong>.</li><li><strong>Android:</strong> open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li><strong>Chrome or Edge on a computer:</strong> click the install icon at the right of the address bar.</li></ul>
  ${tip('In the desktop app you can make Tala PDF the default app for PDFs. On Windows, right-click a PDF, choose <strong>Open with › Choose another app</strong>, pick Tala PDF and tick <strong>Always</strong>. On a Mac, use <strong>Get Info › Open with › Change All</strong>.')}
  <h3>The home screen</h3>
  <p>When Tala PDF opens you see the home screen. From here you can open a file, start a blank document, convert a document, turn photos into a PDF or merge several PDFs. Recent files appear below with a preview of their first page.</p>
  ${fig('home', 'The home screen, with recent files.', 'wide')}
</section>

<section class="chapter" id="tour">
  <h2><span class="n">2</span>A tour of the app</h2>
  <p class="lead">Everything you need sits in two rows above the document.</p>
  <div class="annot">${fig('workspace', 'A document open for editing, with page thumbnails on the left.')}${pins}</div>
  <ol class="legend">${labels.map(([, t]) => `<li>${t}</li>`).join('')}</ol>
  <p>When a tool or an item on the page is selected, an <strong>options row</strong> appears under the toolbar with its colour, line width, font and size, and a <strong>Done</strong> or <strong>Delete</strong> button.</p>
  <p>Use the <strong>sun or moon</strong> button at the top right to switch between the light and dark look. For reading at night, choose <strong>More › Dark pages for reading</strong> to dim the pages themselves.</p>
</section>

<section class="chapter" id="open">
  <h2><span class="n">3</span>Opening and creating files</h2>
  <h3>Open a file</h3>
  <ul><li>Click <strong>Open</strong> on the home screen or in the toolbar (${k('Ctrl+O')}), or</li><li>drag files from your desktop or folder onto the Tala PDF window, or</li><li>in the desktop app, double-click a PDF once Tala PDF is your default PDF app.</li></ul>
  <p>Each file opens in its own tab. Click a tab to switch, and click its <strong>×</strong> to close it. If a file is protected with a password, Tala PDF asks for it.</p>
  <h3>Convert Word, Excel, PowerPoint and other files</h3>
  <p>Open a <strong>.docx</strong>, <strong>.xlsx</strong>, <strong>.csv</strong>, <strong>.pptx</strong>, <strong>.txt</strong> or <strong>.html</strong> file the same way, or use <strong>Convert to PDF</strong> on the home screen. It becomes a new PDF in its own tab. Save it to keep it.</p>
  <ul><li>Word documents keep their headings, paragraphs, lists, tables and pictures.</li><li>Each Excel sheet starts on a new page. Wide sheets are scaled to fit the page.</li><li>Each PowerPoint slide becomes one page, with its text boxes, pictures and tables in place.</li></ul>
  ${note('In the desktop app, converted files contain real text. In a browser, pages are drawn as pictures with an invisible text layer, so you can still search and select text. Older .doc, .xls and .ppt files must first be saved as .docx, .xlsx or .pptx in Office.')}
  <h3>Create a new PDF</h3>
  <ul><li><strong>Blank document</strong> starts with one empty A4 page.</li><li><strong>From images</strong> turns photos or scans into a PDF, one picture per page.</li><li><strong>Scan with camera</strong> (on phones and tablets) takes a photo of a page.</li><li><strong>Merge PDFs</strong> joins several PDFs into one, then shows the pages so you can arrange them.</li></ul>
  <h3>Recent files and unsaved work</h3>
  <p>The home screen lists the files you opened recently. Click one to open it again. If Tala PDF closes before you save, for example after a power cut, your work appears under <strong>Unsaved work</strong> the next time you open the app. Click it to carry on where you left off.</p>
</section>

<section class="chapter" id="read">
  <h2><span class="n">4</span>Reading and finding</h2>
  <h3>Move around</h3>
  <ul><li>Scroll to move through pages, or type a page number in the box in the toolbar.</li><li>Click a thumbnail in the sidebar to jump to that page. Click the sidebar button at the far left of the toolbar to show or hide it.</li><li>The <strong>Outline</strong> tab lists the document's chapters, if it has them.</li></ul>
  <h3>Zoom</h3>
  <p>Use the <strong>−</strong> and <strong>+</strong> buttons, ${k('Ctrl')} with the mouse wheel, or pinch on a touch screen. Click the percentage to fit the page to the window width (${k('Ctrl+0')}).</p>
  <h3>Search</h3>
  <p>Press ${k('Ctrl+F')} or click the magnifier. Type a word to see every match with the text around it; click a result to go there. Matches are also highlighted on the pages.</p>
  ${fig('search', 'Searching a document. Each result shows its page and the words around it.', 'half')}
  ${tip('Scanned pages are pictures, so their words cannot be found until you run <strong>Recognize text (OCR)</strong>. See chapter 11.')}
</section>

<section class="chapter" id="markup">
  <h2><span class="n">5</span>Marking up</h2>
  <p class="lead">Pick a tool in the toolbar. Its options appear in the row below. Click <strong>Done</strong> or press ${k('Esc')} to stop.</p>
  ${fig('markup', 'The Highlight tool is active; its colours appear in the options row.')}
  <table><thead><tr><th>Tool</th><th>How to use it</th></tr></thead><tbody>
    <tr><td class="tool">Select</td><td>Click an item you added to select it. Drag to move it, drag the round handle to resize it, press ${k('Delete')} to remove it. Double-click a text box to change its words.</td></tr>
    <tr><td class="tool">Highlight, Underline, Strikethrough</td><td>Choose the tool, then drag across the text. You can also select text first and then click the tool.</td></tr>
    <tr><td class="tool">Note</td><td>Click where the note should go and type. Notes are saved as real PDF comments that other PDF apps can open.</td></tr>
    <tr><td class="tool">Draw</td><td>Draw freehand with a mouse, finger or pen.</td></tr>
    <tr><td class="tool">Add text</td><td>Click where the text should start and type. Choose font, size, bold, italic and colour in the options row.</td></tr>
    <tr><td class="tool">Rectangle, Ellipse, Line, Arrow</td><td>Drag to draw. Set the colour and line width in the options row.</td></tr>
    <tr><td class="tool">Whiteout</td><td>Drag over something to cover it with white, for example to type over an old date.</td></tr>
    <tr><td class="tool">Redact</td><td>Drag over private information. When you save, it is removed from the file for good. See chapter 10.</td></tr>
    <tr><td class="tool">Image</td><td>Choose a picture; it is placed on the current page. You can also paste a picture with ${k('Ctrl+V')} or drag one onto the page.</td></tr>
  </tbody></table>
  <p>Undo and redo any change with the arrow buttons or ${k('Ctrl+Z')} and ${k('Ctrl+Y')}.</p>
  ${note('Your mark-up stays editable while the document is open. When you save, it becomes part of the page, except notes, which stay as comments.')}
</section>

<section class="chapter" id="forms">
  <h2><span class="n">6</span>Forms and signatures</h2>
  <h3>Fill in a form</h3>
  <p>If the PDF has form fields, click a field and type, or tick a box. The answers are saved into the form, so other people can read and change them.</p>
  <p>For a form without fields, use <strong>Add text</strong> to type anywhere. In <strong>More</strong> you will also find <strong>Add today's date</strong> and <strong>Add checkmark</strong>.</p>
  <h3>Sign</h3>
  ${steps('Click the <strong>Sign</strong> button (the pen on a line) in the toolbar.', 'Draw your signature with a mouse, finger or pen, type your name, or upload a photo of your signature on white paper.', 'Choose the ink colour and click <strong>Place signature</strong>.', 'Drag the signature into place and resize it with its round handle.')}
  ${fig('signature', 'Drawing a signature. Tick the box to keep it for next time.', 'half')}
  ${tip('Signatures you keep are stored only on this device. Click a saved signature to place it again, or the bin to forget it.')}
</section>

<section class="chapter" id="edit">
  <h2><span class="n">7</span>Changing existing text</h2>
  <p>Use the <strong>Edit text</strong> tool to correct words that are already in the PDF.</p>
  ${steps('Click <strong>Edit text</strong> in the toolbar. Every line of text gets a dotted outline.', 'Click the line you want to change, and type.', 'Press <strong>Enter</strong> or click elsewhere to finish.')}
  ${fig('edittext', 'With Edit text active, each line can be clicked and retyped.')}
  <p>Tala PDF covers the old line with the background colour and writes the new words in the closest standard font (sans-serif, serif or monospace) at the same size. You can change the font, size and colour in the options row. To bring back the original line, select it and click <strong>Restore original</strong>.</p>
  ${note('The original words remain in the file underneath the new line. To remove words for good, use <strong>Redact</strong> instead.')}
</section>

<section class="chapter" id="pages">
  <h2><span class="n">8</span>Working with pages</h2>
  <h3>In the sidebar</h3>
  <ul><li>Drag a thumbnail up or down to move that page.</li><li>Right-click a thumbnail to rotate, duplicate, delete it, insert a blank page after it, or copy it into a new document.</li></ul>
  <h3>In the Pages view</h3>
  <p>Click <strong>Pages</strong> in the toolbar to see every page at once. Click pages to select them (hold <strong>Shift</strong> to select a run), then use the buttons at the top.</p>
  ${fig('organize', 'The Pages view with the second page selected.')}
  <ul><li><strong>Rotate, Move, Duplicate, Delete</strong> work on the selected pages. You can also drag pages to a new position.</li><li><strong>Insert blank page, Insert PDF, Insert images</strong> add pages after the selection.</li><li><strong>Extract to new tab</strong> copies the selected pages into a new document.</li><li><strong>Copy to another tab</strong> adds them to the end of another open document.</li><li><strong>Split into files</strong> saves the document as separate PDFs, for example one per page, in a zip file.</li></ul>
  <p>Click <strong>Done</strong> to return to the document.</p>
</section>

<section class="chapter" id="save">
  <h2><span class="n">9</span>Saving, exporting and printing</h2>
  <h3>Save</h3>
  <p>Click <strong>Save</strong> (${k('Ctrl+S')}) to save your changes. In the desktop app, and in Chrome or Edge on a computer, this updates the file you opened. In other browsers and on phones, the saved PDF goes to your Downloads.</p>
  <p>Click <strong>Save as</strong> (${k('Ctrl+Shift+S')}), next to Save, to save a copy under a new name or in another place.</p>
  <h3>Export</h3>
  <p>Click <strong>Export</strong> (${k('Ctrl+Shift+E')}), next to Save as. Choose a format and which pages to include: all pages, the current page, or a list such as <em>1-3, 5</em>.</p>
  ${fig('export', 'The Export window.', 'half')}
  <table><thead><tr><th>Format</th><th>What you get</th></tr></thead><tbody>
    <tr><td class="tool">Word</td><td>Editable text with headings and paragraphs. Pages without text, such as scans, are added as pictures.</td></tr>
    <tr><td class="tool">Word, exact look</td><td>Each page as a picture. It looks identical to the PDF but cannot be edited as text.</td></tr>
    <tr><td class="tool">Excel</td><td>One sheet per page, with text that lines up placed in the same column. Numbers become real numbers.</td></tr>
    <tr><td class="tool">PowerPoint</td><td>One slide per page.</td></tr>
    <tr><td class="tool">PNG or JPEG images</td><td>A picture of each page at the resolution you choose. Several pages arrive in one zip file.</td></tr>
    <tr><td class="tool">Plain text</td><td>Just the words.</td></tr>
    <tr><td class="tool">PDF copy</td><td>A separate PDF, useful for sending only some pages.</td></tr>
  </tbody></table>
  <h3>Print and share</h3>
  <p>Choose <strong>More › Print</strong> (${k('Ctrl+P')}). Your mark-up and signatures are printed too. On phones, <strong>More › Share</strong> sends the PDF to another app, such as mail or messages.</p>
  ${fig('more-menu', 'The More menu.', 'small')}
</section>

<section class="chapter" id="protect">
  <h2><span class="n">10</span>Protecting and shrinking files</h2>
  <h3>Password</h3>
  <p>Choose <strong>More › Protect with password</strong> and enter a password twice. Anyone opening the saved file will need it. To remove or change a password, choose the same menu item again.</p>
  ${note('There is no way to recover a forgotten password. Keep it somewhere safe.')}
  <h3>Redact</h3>
  <p>Use the <strong>Redact</strong> tool to mark private information such as account numbers. When you save, Tala PDF asks you to confirm. The marked pages are then turned into pictures with the marked areas blacked out, and the original words are removed from the file.</p>
  <p>Redacted pages lose selectable text. Run OCR afterwards if you need to search them again.</p>
  <h3>Reduce file size</h3>
  <p>Choose <strong>More › Reduce file size</strong> and pick a level. <strong>Standard</strong> keeps everything as it is. <strong>Strong</strong> and <strong>Strongest</strong> turn pages into pictures, which suits scans and photos but removes selectable text. Tala PDF shows the before and after sizes and saves the smaller file as a separate copy.</p>
</section>

<section class="chapter" id="ocr">
  <h2><span class="n">11</span>Scanned documents (OCR)</h2>
  <p>A scanned page is a picture of text. OCR (optical character recognition) reads the words in the picture so you can search, select, copy and highlight them.</p>
  ${steps('Open the scanned PDF.', 'Choose <strong>More › Recognize text (OCR)</strong>.', 'Choose <strong>This page</strong> or <strong>All pages without text</strong>, then <strong>Start</strong>.', 'Save the document to keep the recognised text in the file.')}
  <p>Recognition runs on your own device and works best with clear, straight, English print. In a browser, the first run downloads the recognition engine (about 20 MB) once; the desktop app already includes it.</p>
</section>

<section class="chapter" id="phone">
  <h2><span class="n">12</span>Using Tala PDF on a phone</h2>
  ${fig('phone', 'On a phone, page thumbnails run along the bottom.', 'phone')}
  <p>Tala PDF works the same way on phones and tablets, with the layout arranged for a small screen.</p>
  <ul><li>File buttons sit on the first row and the drawing tools on a second row that you can swipe sideways.</li><li><strong>Save as</strong> and <strong>Export</strong> are in the <strong>More</strong> menu (the three dots).</li><li>Tap the sidebar button to show page thumbnails as a strip along the bottom. Tap a thumbnail to jump to that page.</li><li>To highlight, choose the tool, then press and hold on a word and drag the selection handles.</li><li>Draw and sign with your finger.</li><li>Saving downloads the edited file, or use <strong>More › Share</strong> to send it to another app.</li></ul>
  <div class="clear"></div>
</section>

<section class="chapter" id="keys">
  <h2><span class="n">13</span>Keyboard shortcuts</h2>
  <table><thead><tr><th>Action</th><th>Keys</th></tr></thead><tbody>
  ${[['Open a file', 'Ctrl+O'], ['Save', 'Ctrl+S'], ['Save as', 'Ctrl+Shift+S'], ['Export', 'Ctrl+Shift+E'], ['Print', 'Ctrl+P'], ['Find in the document', 'Ctrl+F'], ['Undo', 'Ctrl+Z'], ['Redo', 'Ctrl+Y'], ['Zoom in', 'Ctrl+='], ['Zoom out', 'Ctrl+-'], ['Fit page width', 'Ctrl+0'], ['Delete the selected item or pages', 'Delete'], ['Stop the current tool, or clear the selection', 'Esc'], ['Select all pages (Pages view)', 'Ctrl+A'], ['Open this manual', 'F1']]
    .map(([a, b]) => `<tr><td>${a}</td><td>${k(b)}</td></tr>`).join('')}
  </tbody></table>
  <p>The same list is in the app under <strong>Help › Keyboard shortcuts</strong>.</p>
  ${fig('help-menu', 'The Help menu at the top right opens this manual, the shortcuts and About.', 'half')}
</section>

<section class="chapter" id="faq">
  <h2><span class="n">14</span>Questions and troubleshooting</h2>
  <h3>How do I get updates?</h3>
  <p>Tala PDF checks for new versions by itself. On Windows, a new version downloads in the background; when it is ready, a message offers <strong>Restart now</strong>, or it installs the next time you quit. On a Mac, the message offers <strong>Download</strong>, which opens the download page for the new version. In a browser or on a phone, the message offers <strong>Reload now</strong>. To check straight away, choose <strong>Help › Check for updates</strong>. Unsaved work is kept as a recovery copy before the app restarts.</p>
  <h3>Where are my files stored?</h3>
  <p>Only on your device. Tala PDF does not upload documents anywhere. Recent files and unsaved work are kept in the app's own storage on this device.</p>
  <h3>A PDF opens, but other apps say editing is not allowed. Can I save it?</h3>
  <p>Yes. Some PDFs, such as manuals and statements, open freely but carry an owner password that locks editing. Tala PDF can still edit and save them. The saved copy does not carry the original restrictions.</p>
  <h3>Why did some pages save as pictures?</h3>
  <p>Pages you redacted are always saved as pictures. Occasionally a PDF uses features Tala PDF cannot rewrite; its pages are then saved as pictures with their text kept as a searchable layer, and the app tells you when this happens.</p>
  <h3>My changed text looks a little different from the original.</h3>
  <p>Edit text uses the closest standard font, because the PDF's own font often cannot be reused for new words. Adjust the font and size in the options row to get closer.</p>
  <h3>Saving on my phone creates a new file in Downloads.</h3>
  <p>Mobile browsers do not let a web page replace a file in place. Use the file in Downloads, or <strong>More › Share</strong> to send it straight to another app.</p>
  <h3>Windows or macOS warned me when installing.</h3>
  <p>The installers are not yet code-signed, so the system asks you to confirm once. Chapter 1 shows the steps.</p>
  <h3>A Word or PowerPoint file did not convert exactly.</h3>
  <p>Conversion keeps text, headings, tables, pictures and slide layouts, but not every detail: Word headers and footers, Excel charts, and PowerPoint themes, animations and charts are left out.</p>
  <p class="credit">Tala PDF ${pkg.version}. Created by Ryan Ocbina Barnal. Tala is the Filipino word for star.<br>Built with pdf.js, pdf-lib, Tesseract.js, mammoth, ExcelJS, docx, PptxGenJS and html2canvas. Licensed under the GNU General Public License v3.</p>
</section>
</body></html>`;
}

(async () => {
  for (const s of ['make-fixture.mjs', 'make-office.mjs']) execFileSync(process.execPath, [path.join(ROOT, 'tests', s)], { stdio: 'inherit' });
  console.log('taking screenshots…');
  const callouts = await shots(WORK);
  fs.writeFileSync(path.join(WORK, 'manual.html'), html(callouts));
  console.log('printing PDF…');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(WORK, 'manual.html'));
  await page.evaluate(() => document.fonts.ready);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const cover = await page.pdf({ preferCSSPageSize: true, printBackground: true, pageRanges: '1' });
  const body = await page.pdf({
    preferCSSPageSize: true,
    pageRanges: '2-',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font:8px sans-serif;color:#7a8499;padding:0 18mm;display:flex;justify-content:space-between"><span>Tala PDF user manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    tagged: true,
    outline: true,
  });
  await browser.close();
  // Join cover + body. Page numbers in the footer count from the contents page.
  const outDoc = await PDFDocument.load(body);
  const [c] = await outDoc.copyPages(await PDFDocument.load(cover), [0]);
  outDoc.insertPage(0, c);
  outDoc.setTitle('Tala PDF User Manual');
  outDoc.setAuthor('Ryan Ocbina Barnal');
  outDoc.setSubject('How to use Tala PDF');
  fs.writeFileSync(OUT, await outDoc.save());
  console.log('manual written:', path.relative(ROOT, OUT), (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

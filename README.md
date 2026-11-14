# Tala PDF

A PDF reader and editor that runs on Windows, macOS, and in any phone or desktop browser.
Files stay on your device. Nothing is uploaded.

## What it does

**Read**
- Page thumbnails beside the document, like Preview: drag to reorder, right-click to rotate, duplicate,
  insert or delete. On phones they become a filmstrip along the bottom.
- Outline, zoom, text search with highlighted matches
- Select and copy text, dark theme, dark pages for night reading
- Several documents open in tabs

**Mark up**
- Highlight, underline, strikethrough (select the text)
- Sticky notes (saved as real PDF comments other readers can open)
- Freehand pen, rectangles, ellipses, lines, arrows
- Text boxes, images, whiteout
- Fill in form fields; draw, type, or upload a signature and reuse it

**Edit**
- Change a line of existing text in place
- Reorder, rotate, duplicate, delete pages; insert blank pages, other PDFs, or images
- Merge PDFs, extract pages to a new document, split into separate files
- Create a PDF from images or a phone camera; export pages as PNG or as plain text

**Convert to PDF**
- Word (.docx), Excel (.xlsx, .csv), PowerPoint (.pptx), plain text and web pages (.html)
- Open them like any PDF, drop them on the window, or use **Convert to PDF** on the home screen
- In the desktop app the result has real, selectable text. In a browser each page is drawn as a
  picture with an invisible, searchable text layer, the same way OCR works.

**Export**
- The **Export** button next to **Save as** turns the document, the current page, or a page range into:
  Word (editable text, or an exact-look version with each page as a picture), Excel (one sheet per page,
  text placed in rows and columns), PowerPoint (one slide per page), PNG or JPEG images, plain text,
  or a separate PDF

**Protect and shrink**
- Password-protect a file, change or remove its password
- Redact: marked areas are burned into the page and the original content is removed from the file
- Reduce file size

**Extras**
- OCR for scanned pages (English), so they become searchable and selectable
- Recent files with first-page previews, and automatic recovery of unsaved work after a crash or accidental close
- Print, and share from a phone's share sheet

## Install

### Windows and macOS

Download the installer from the repository's **Releases** page.

The installers are not code-signed, so each system asks once before running them:

- **Windows**: on the blue "Windows protected your PC" screen choose **More info**, then **Run anyway**.
- **macOS**: open the `.dmg`, drag the app to Applications, and open it. When macOS blocks it, go to
  **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway**.
  Pick the `arm64` disk image for Apple silicon Macs and `x64` for Intel Macs.

After installing you can set Tala PDF as the default app for `.pdf` files.

### Phone, tablet, or any browser

Open the web version (the repository's GitHub Pages address, `https://<owner>.github.io/<repo>/`).
To keep it on the home screen and use it offline:

- **iPhone / iPad**: Share → **Add to Home Screen**
- **Android**: browser menu → **Install app** or **Add to Home screen**
- **Desktop Chrome / Edge**: the install icon in the address bar

## Things to know

- **Editing existing text** covers the old line and draws the new one in the closest standard font
  (sans-serif, serif, or monospace). The original characters remain in the file underneath the cover.
  To remove content for good, use **Redact**.
- **Redaction** turns the affected page into an image. Text on that page can no longer be selected
  until you run OCR on it again.
- **Your annotations stay editable until you close the document.** Once a saved file is reopened they are
  part of the page, except sticky notes, which remain comments.
- **Locked PDFs** (ones that open freely but restrict editing, such as many manuals) can be edited and
  saved. The saved copy no longer carries the original restrictions.
- **Converting** keeps text, headings, tables, pictures and slide layouts, but not every detail: Word
  page breaks, headers and footers, Excel charts, and PowerPoint themes, animations and charts are not
  reproduced. Older .doc, .xls and .ppt files must be saved as .docx, .xlsx or .pptx first.
- **Exporting to Word or Excel** rebuilds the document from its text, so complex layouts come out simplified.
  Choose "Word, exact look" when appearance matters more than editing.
- **Strong compression** turns pages into images, which removes selectable text.
- **OCR** recognises English. On the web the engine (about 20 MB) is downloaded the first time you use it
  and then kept for offline use; the desktop app ships with it.
- **Saving on phones** downloads the edited file or sends it through the share sheet, because mobile
  browsers do not let a web page overwrite a file in place.
- Password protection uses the PDF standard's encryption. There is no way to recover a forgotten password.

## Develop

Needs Node.js 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

Other commands:

| Command | What it does |
|---|---|
| `npm run build` | Web version into `dist/` (with offline support) |
| `npm run desktop` | Build and start the desktop app locally |
| `npm run dist` | Build the installer for the system you are on, into `release/` |
| `npm test` | Browser end-to-end checks against `dist/` (run `npm run build` first) |
| `npm run test:desktop` | Desktop app checks (run `npm run build:desktop` first) |

The tests drive a real browser through [Playwright](https://playwright.dev), which must be installed
separately (`npm i -D playwright` and `npx playwright install chromium`).

### Layout

| Path | Purpose |
|---|---|
| `src/model.js` | Document model: pages, annotations, undo, rotation |
| `src/viewer.js` | Page rendering and every on-page tool |
| `src/export.js` | Writes the final PDF: page order, annotations, forms, redaction, encryption |
| `src/organize.js` | Page grid: reorder, rotate, insert, extract |
| `src/main.js` | App shell: tabs, toolbar, sidebar, dialogs, file actions |
| `src/platform.js` | File open/save for desktop, browsers with file access, and everything else |
| `src/store.js` | Recent files, recovery snapshots, saved signatures (all stored locally) |
| `src/ocr.js` | Text recognition |
| `src/convert.js` | Word, Excel, PowerPoint, text and HTML into PDF |
| `src/exporters.js` | PDF into Word, Excel, PowerPoint, images and text |
| `electron/` | Desktop shell |

To rename the app, change `APP_NAME` in `src/config.js`, `productName` in `package.json`,
the manifest names in `vite.config.js`, and the `<title>` in `index.html`.

## Release

**Web version**: every push to `main` publishes to GitHub Pages
(one-time setup: repository **Settings → Pages → Source: GitHub Actions**).

**Desktop installers**: push a version tag and the installers are attached to a GitHub release.

```bash
npm version patch
```

```bash
git push --follow-tags
```

You can also run the **Desktop installers** workflow by hand from the Actions tab and download the
installers from the run's artifacts.

### Signing (optional)

Unsigned installers work, with the one-time prompts described above. To remove the prompts:

- **macOS** needs an Apple Developer account. Add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets, pass them to the build step,
  and remove `"identity": "-"` from the `mac` section of `package.json`.
- **Windows** needs a code-signing certificate, supplied the same way through `CSC_LINK` and
  `CSC_KEY_PASSWORD`.

## Built with

[pdf.js](https://mozilla.github.io/pdf.js/) for rendering, [pdf-lib](https://github.com/cantoo-scribe/pdf-lib)
for writing, [Tesseract.js](https://tesseract.projectnaptha.com/) for OCR, [mammoth](https://github.com/mwilliamson/mammoth.js),
[ExcelJS](https://github.com/exceljs/exceljs), [docx](https://docx.js.org), [PptxGenJS](https://gitbrent.github.io/PptxGenJS/)
and [html2canvas](https://html2canvas.hertzen.com) for conversions, [Electron](https://www.electronjs.org/)
for the desktop app, and [Lucide](https://lucide.dev) icons.

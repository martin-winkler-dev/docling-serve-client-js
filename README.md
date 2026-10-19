[![Test](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/test.yml/badge.svg)](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/test.yml)
[![Package](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/package.yml/badge.svg)](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/package.yml)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmartin-winkler-dev%2Fdocling-serve-client-js%2Fmain%2Fpackage.json&query=%24.engines.bun&label=Bun&logo=bun&color=blue)](https://bun.sh)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmartin-winkler-dev%2Fdocling-serve-client-js%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&logo=nodedotjs&color=blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

# docling-serve-client

Typed HTTP client for a running [docling-serve](https://github.com/docling-project/docling-serve): **PDF or image
bytes in, docling's Markdown or DoclingDocument JSON out**.

- Two outputs: `convertMarkdown` returns docling's Markdown unchanged except for image handling; `convertDocument`
  returns the DoclingDocument (the JSON AST with labels, reading order, pages and bounding boxes) as docling sends it.
- No cleanup, no heuristics on text. Repairs and analysis belong in the code that uses this client. The Markdown is
  docling's raw output, e.g. with `&amp;` entities, soft hyphens and dot leaders left in.
- In-memory only: no file I/O, no streaming.
- **Calls never throw on runtime failures.** Every call resolves to `{ ok: true, data } | { ok: false, error }`.
  Two exceptions are programming errors: the factory throws a `TypeError` on an invalid config, and a call with an
  invalid option throws a `TypeError` (the promise rejects) before it sends anything.
- Sync (`convert*`) and async (`submit*` + `check`). No built-in polling, queueing or rate limiting.
- Zero dependencies. ESM, works in Node ≥ 22.12 (also via `require()`) and Bun.

## Usage

```ts
import { createDoclingClient } from 'docling-serve-client';

const docling = createDoclingClient({ baseUrl: 'http://127.0.0.1:5001' });

// Input is always a Uint8Array (Node Buffer is one): a PDF, or a PNG, JPEG, TIFF or WebP image
const pdf = await readFile('paper.pdf');                                  // node:fs/promises
// const pdf = await Bun.file('paper.pdf').bytes();                       // Bun
// const pdf = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer()); // any download

const md = await docling.convertMarkdown(pdf);
if (md.ok) console.log(md.data.markdown, md.data.warnings);

const doc = await docling.convertDocument(pdf);
if (doc.ok) {
    for (const item of doc.data.document.texts) {
        if (item.label === 'section_header') console.log(item.level, item.text, item.prov[0]?.page_no);
    }
} else {
    console.error(doc.error.code, doc.error.message);
}
```

### Async

`submitMarkdown()` and `submitDocument()` return a plain JSON job object. Store all of it and pass it back to
`check()`. A Markdown job carries its image handling, so `check()` works the same from another process or after a
restart. `check()` returns the result type that matches the job's `kind`.

```ts
const job = await docling.submitDocument(pdf);
if (!job.ok) return handle(job.error);
await save(JSON.stringify(job.data)); // { kind: 'document', id }

// later, as often as you like:
const state = await docling.check(JSON.parse(await load()));
if (state.ok) {
    switch (state.data.status) {
        case 'queued':  /* state.data.position */ break;
        case 'running': break;
        case 'done':    use(state.data.document); break;
    }
}
```

docling-serve deletes a result `DOCLING_SERVE_RESULT_REMOVAL_DELAY` seconds (default 300) after its first fetch
(`DOCLING_SERVE_SINGLE_USE_RESULTS=true`, the default). A `check()` whose result download failed (network error,
`timeoutMs`, abort) can be repeated within that time; later `check()` returns `not_found` (`Result already fetched or
expired`), so persist the `done` data. Start docling-serve with `DOCLING_SERVE_SINGLE_USE_RESULTS=false` to keep results
until they expire. These are server settings; `convert*()` is not affected.

### Options

Set docling options on the factory and override them per call, key by key; `ocrLang`, `pageRange` and
`documentTimeout` are factory-only and reject per call. Nothing is silently ignored or converted:
an unknown option or an invalid value throws a `TypeError` at the start of the call, before any request
(`Option "x" is not supported`, `Invalid value for option "x"`; nested keys are named like `imageOptions.prefix`).

```ts
const docling = createDoclingClient({
    baseUrl: 'http://127.0.0.1:5001',
    apiKey: '…',                        // only if docling-serve requires X-Api-Key
    timeoutMs: 120_000,                 // optional limit per request; on expiry the call resolves with `aborted`
    options: { ocrLang: ['de', 'en'] }, // docling defaults for every call
    fetch: myFetch,                     // optional custom fetch
});

await docling.convertDocument(pdf, { ocr: false, images: 'placeholder', signal: AbortSignal.timeout(60_000) });
```

docling options (factory and per call):

| option | default | effect |
|---|---|---|
| `headingHierarchy` | `true` | heading levels by bookmarks, numbering and font; `false` = every heading level 1 |
| `formulaEnrichment` | `true` | formulas as LaTeX (extra model; runs only on formulas); without it formula `text` is empty and the md shows `<!-- formula-not-decoded -->` |
| `codeEnrichment` | `false` | code listings via extra model (slower) |
| `chartExtraction` | `false` | charts as data (vision model, slower) |
| `pipeline` | `'standard'` | `'vlm'` runs a vision-language model per page (slow) |
| `pdfBackend` | `'docling_parse'` | text extractor; `'pypdfium2'` reads ligatures and word spaces better but misses page headers and footers |
| `ocr` | `true` | OCR bitmap content of PDFs (scans, pictures); image input is always OCRed |
| `forceOcr` | `false` | OCR whole PDF pages and drop their text layer, for PDFs with broken text; ignored for image input |

Factory only (`options` of `createDoclingClient`; per call they throw `Option "x" is not supported`). Use a second
client for other values:

| option | default | effect |
|---|---|---|
| `ocrLang` | engine default | BCP-47 hints in order of preference, e.g. `['de', 'en-US']`; `[]` = engine default |
| `pageRange` | all pages | `[from, to]`, 1-based, inclusive |
| `documentTimeout` | server default | server-side limit in seconds |

Per call only: `signal` (cancels the request), `images`, for Markdown `imageOptions`, for documents `pageImages`.
`timeoutMs` is a factory setting: it limits every request except `GET /version` and is combined with `signal`.

Always on, not configurable: table structure with the accurate TableFormer model (`do_table_structure`,
`table_mode: 'accurate'`), pictures and page images at 144 dpi (`images_scale=2`, exported as `PAGE_IMAGE_SCALE`)
and, for Markdown, compact tables (`md_compact_tables`). The image scale does not affect OCR: docling OCRs at its own
fixed 216 dpi.

### Input formats

The format is detected from the first bytes; anything else resolves to `invalid_input` without a request.

| input | detected by | sent as |
|---|---|---|
| PDF | `%PDF-` within the first 1024 bytes | `from_formats=pdf`, `document.pdf` |
| PNG, JPEG, TIFF, WebP | file signature at byte 0 | `from_formats=image`, `document.png` / `.jpg` / `.tiff` / `.webp` |

An image is converted as one page: docling runs layout detection and OCR on it, and `ocrLang` applies. OCR is always
on for images and never full-page: `ocr: false` would return no text, and `forceOcr: true` merges words (`stepsand`),
so both are ignored for image input. Use it e.g. to re-read a crop of a page whose text layer is broken. Text only
comes back if the server has a working OCR engine. PDF-only options (`pdfBackend`, `pageRange`) have no effect on
images.

### Images in the DoclingDocument

| `images` | effect |
|---|---|
| `'embedded'` (default) | `pictures[].image.uri` is a `data:image/png;base64,…` URI; pictures keep their position, captions and size |
| `'placeholder'` | `pictures[].image` is `null`; the picture items stay, the document is much smaller |

The base64 data stays inside the document. Pull it out when you need files, e.g. when rendering Markdown from the
document. `isSmallImage(picture.image.size)` applies the same size filter as `omitSmall` (see below).

### Page images

`pageImages: true` (documents only, default `false`) asks docling to render every page (`include_page_images`). The
client moves them out of the document: `document.pages[n].image` is always `null`, so the JSON stays small, and the
images come back decoded in `data.pageImages`, in page order:

```ts
const res = await docling.convertDocument(pdf, { pageImages: true, images: 'placeholder' });
if (res.ok) {
    await writeFile(`out/${docId}.json`, JSON.stringify(res.data.document)); // no page image data inside
    for (const image of res.data.pageImages) {
        await writeFile(`out/${docId}-p${image.page}.png`, image.bytes);   // { page, mimeType, width, height, dpi, bytes }
    }
}
```

- `page` is the 1-based PDF page (absolute, also with `pageRange`); `dpi` is always 144.
- `width` and `height` are pixels from the PNG header, else docling's `image.size`. Pixel size = page size in points
  × 2; an A4 page is about 1190 × 1684 px and 0.4 to 0.6 MB as PNG.
- Page images are independent of `images`: `images: 'placeholder'` drops picture data and keeps page images.
- Async: `submitDocument(pdf, { pageImages: true })` stores nothing extra in the job; `check()` returns the images.
- A page image that is not a base64 data URI or has invalid or empty data is missing from `pageImages`, stays in
  `document.pages[].image` as docling sent it, and is reported as a `page_image_not_decoded` warning (`details.page`).

The document keeps docling's bboxes as sent: PDF points, mostly with a bottom-left origin. `toPageImageBox` maps one
onto its page image as `{ page, x, y, width, height }` in pixels with a top-left origin (unrounded), ready to store
next to the page image file or to crop with:

```ts
for (const item of res.data.document.texts) {
    for (const prov of item.prov) {
        const box = toPageImageBox(res.data.document, prov); // undefined if the page is missing
    }
}
// table cells carry their own bbox (top-left origin) and the page of their table:
const box = toPageImageBox(document, { page_no: table.prov[0].page_no, bbox: cell.bbox });
```

The boxes fit page images of any conversion by this client, also when `pageImages` was off.

### Images in the Markdown

| `images` | effect |
|---|---|
| `'placeholder'` (default) | `<!-- image -->` marks a picture, as docling writes it |
| `'none'` | placeholders removed |
| `'extract'` | pictures come back as bytes in `data.images`, linked as `<prefix><n>.<ext>` |

With `'extract'`, `imageOptions` is required on each call, because the prefix names one document's images:

```ts
const res = await docling.convertMarkdown(pdf, {
    images: 'extract',
    imageOptions: { prefix: `images/${docId}-` }, // omitSmall: drop bullets, icons and small logos, default true
});
if (res.ok) {
    await writeFile(`out/${docId}.md`, res.data.markdown);           // ![Image](images/1234-1.png)
    for (const image of res.data.images) {
        await writeFile(`out/${image.path}`, image.bytes);           // { path, mimeType, bytes, width, height }
    }
}
```

- `n` starts at 1 and counts kept images only. `<ext>` comes from the MIME type: `png`, `jpg`, `gif`, `webp`, `svg`,
  `tiff`, `bmp`, otherwise `bin`.
- `omitSmall` (default `true`) removes small pictures from the Markdown and does not return them. Small means: area
  below 15 000 px, longer side below 200 px, or shorter side below 24 px (`isSmallImage`). Only PNGs have a known
  size (`readPngSize`); other formats are always kept and report `width` and `height` as `0`.
- A picture with invalid or empty base64 data is removed and reported as an `image_not_decoded` warning
  (`details.index`: 1-based position among all embedded pictures); the conversion still succeeds.
- A picture docling sent without image data keeps its `<!-- image -->` placeholder, as in `'placeholder'` mode.
- Removing a picture or placeholder keeps the blank line that separates the paragraphs around it.

### Warnings

`data.warnings` lists non-fatal notes. The conversion still succeeded; decide yourself whether a warning matters.

| code | `details` | meaning |
|---|---|---|
| `server` | `{ component, module, category, page }` | problem reported by docling-serve (e.g. a single page failed, `document timeout exceeded`); `page` is the 1-based PDF page, or `null` |
| `image_not_decoded` | `{ index }` | Markdown with `images: 'extract'` only, see above |
| `page_image_not_decoded` | `{ page }` | documents with `pageImages: true` only, see above |

Pages docling gave up on (e.g. `documentTimeout` exceeded) have no content. The only sign is a `server` warning per
failed page.

### Server versions

`data.versions` holds the versions the server reports on `GET /version`, unchanged, e.g.
`{ 'docling-serve': '1.36.0', docling: '2.135.0', 'docling-core': '2.101.1', … }`, or `null` if it reports none.
Store it with each converted document: the same PDF can convert differently under another docling version, and
`document.version` is the DoclingDocument schema version. Errors from a request the server answered (`http`,
`not_found`, `conversion_failed`, `invalid_response`) carry the same `error.versions`. Each client asks for the
versions once and keeps them; the request has its own 2 s limit, and when it fails `versions` is `null` and the next
result asks again. Create a new client after a server update.

### Broken umlauts / special characters

If the output shows `fŸhrt`, `Nu§baum`, `…sterreich`, the PDF's text layer uses an encoding docling-parse misreads
(seen with `/MacRomanEncoding` PDFs from Mac Word). Re-convert that document with `{ forceOcr: true }` (with `ocrLang: ['de']` on the factory).
It is slower, so use it per document, not by default.

### Errors

`error.code` is one of:

| code | meaning |
|---|---|
| `invalid_input` | not a non-empty PDF, PNG, JPEG, TIFF or WebP `Uint8Array`, a truncated PDF (cross-reference offset past the end of the file), or not a job object from `submit*()`, or input that could not be prepared for upload (e.g. out of memory); no request sent |
| `network` | server unreachable (the message includes the cause, e.g. `ECONNREFUSED`) |
| `aborted` | your `signal` fired (incl. `AbortSignal.timeout()`) or `timeoutMs` expired |
| `http` | non-2xx response (`error.status` set), e.g. auth, sync wait exceeded |
| `not_found` | `check()`: `Unknown job id` (e.g. after a server restart), or `Result already fetched or expired`; the server's own message follows in parentheses |
| `conversion_failed` | the server could not convert the document, also a `partial_success` (or a success with error items) that has no Markdown or DoclingDocument |
| `invalid_response` | unexpected response body (no status, no Markdown or DoclingDocument without server details, a non-JSON body (quoted in the message), an unusable task id, or a body too large to read) |

`conversion_failed` adds `error.details` as `{ errors, failure }`: `errors` lists docling's error items as
`{ message, details }` (component, module, category, page); `failure` is docling's task classification
`{ category, phase, retryable }` for async jobs, or `null`.

## Development

### Running docling-serve (CUDA)

```bash
# Install or reinstall docling-serve with CUDA 12.6
uv tool install --reinstall --torch-backend cu126 docling-serve

# Start the server on port 5001
docling-serve run --port 5001
```

```bash
bun install
bun runtest check -p tsconfig.test.json   # lint fixes, typecheck, lint, unit tests against a mock docling server
bun run test:e2e                          # end-to-end tests against docling-serve on :5001; fail if it is down
bun run check                             # lint, tests, build, smoke tests on the built package, package check
```

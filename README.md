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
  Two exceptions are programming errors: the factory throws a `TypeError` on invalid config, and any call with an
  invalid option rejects with a `TypeError` before sending a request.
- Sync (`convert*`) and async (`submit*` + `check`). No built-in polling, queueing or rate limiting.
- Zero dependencies. ESM, works in Node ≥ 22.12 (also via `require()`) and Bun.

## Installation

```bash
bun add docling-serve-client
# or
npm install docling-serve-client
```

## Usage

```ts
import { readFile } from 'node:fs/promises';
import { createDoclingClient } from 'docling-serve-client';

const docling = createDoclingClient({ baseUrl: 'http://127.0.0.1:5001' });

// Input is always a Uint8Array (Node Buffer is one): a PDF, or a PNG, JPEG, TIFF or WebP image
const pdf = await readFile('paper.pdf');
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
restart. `check()` returns the result type that matches the job's `kind`. The job also carries the
[conversion settings](#conversion-settings) of its submission; `check()` does not need them, so a stored job may omit
`settings`, and the `done` state does not repeat them.

```ts
import type { DocumentJob } from 'docling-serve-client';

const job = await docling.submitDocument(pdf);
if (!job.ok) return handle(job.error);
await save(JSON.stringify(job.data)); // { kind: 'document', id, settings }

// later, as often as you like (e.g. in a polling loop or another worker):
const storedJob: DocumentJob = JSON.parse(await load());
const state = await docling.check(storedJob);
if (state.ok) {
    switch (state.data.status) {
        case 'queued':  console.log('Queue position:', state.data.position); break;
        case 'running': console.log('Processing...'); break;
        case 'done':    use(state.data.document); break;
    }
} else {
    // state.error.code: 'not_found' (e.g. expired or unknown id), 'http', 'conversion_failed', etc.
    console.error(state.error.code, state.error.message);
}

// In-process polling loop until done:
while (true) {
    const poll = await docling.check(storedJob);
    if (!poll.ok) {
        console.error('Job error:', poll.error.code, poll.error.message);
        break;
    }
    if (poll.data.status === 'done') {
        use(poll.data.document);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
}
```

For Markdown jobs (`submitMarkdown`), `check()` returns `JobState<ConvertedMarkdown>` whose `done` state provides
`markdown`, `images`, `warnings`, and `versions`.

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
| `ocrEngine` | `'auto'` | OCR engine preset (`ocr_preset`): `'auto'`, `'rapidocr'`, `'easyocr'`, `'tesseract'`, `'tesserocr'`, `'ocrmac'` or any other non-empty preset id; the server rejects an id it does not allow with `http` 422, see [server capabilities](#server-capabilities) |

Factory only (`options` of `createDoclingClient`; per call they reject with `Option "x" is not supported`). Use a second
client for other values:

| option | default | effect |
|---|---|---|
| `ocrLang` | engine default | BCP-47 hints in order of preference, e.g. `['de', 'en-US']`; `[]` = engine default |
| `pageRange` | all pages | `[from, to]`, 1-based, inclusive |
| `documentTimeout` | server default | server-side limit in seconds |

Per call only (not allowed in factory `options`, rejected with `Option "x" is not supported`):

| option | calls | default | effect |
|---|---|---|---|
| `images` | `convertMarkdown`, `submitMarkdown` | `'placeholder'` | `'placeholder'`, `'none'`, or `'extract'` |
| `imageOptions` | `convertMarkdown`, `submitMarkdown` | none | `{ prefix: string, omitSmall?: boolean }`; required with `images: 'extract'`, not allowed otherwise |
| `images` | `convertDocument`, `submitDocument` | `'embedded'` | `'embedded'` or `'placeholder'` |
| `pageImages` | `convertDocument`, `submitDocument` | `false` | renders pages as images, decoded in `pageImages` |
| `signal` | all calls (`convert*`, `submit*`, `check`, `capabilities`) | none | `AbortSignal` to cancel the request |

`timeoutMs` is a factory setting: it limits every request except `GET /version` and is combined with `signal`.

Always on, not configurable: table structure with the accurate TableFormer model (`do_table_structure`,
`table_mode: 'accurate'`, `table_structure_preset: 'tableformer_v1_accurate'`, `table_cell_matching`), pictures and
page images at 144 dpi (`images_scale=2`, exported as `PAGE_IMAGE_SCALE`) and, for Markdown, compact tables
(`md_compact_tables`) without page break placeholders (`md_page_break_placeholder`). The image scale does not affect
OCR: docling OCRs at its own fixed 216 dpi. Model presets are pinned: `granite_docling` for `pipeline: 'vlm'`,
`granite_vision_v4` for `chartExtraction`, `codeformulav2` for formula and code enrichment. Picture classification
and description stay off.

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
import { writeFile } from 'node:fs/promises';

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
import { toPageImageBox } from 'docling-serve-client';

for (const item of res.data.document.texts) {
    for (const prov of item.prov) {
        const box = toPageImageBox(res.data.document, prov); // undefined if coordinates or page missing
    }
}

// table cells carry their own bbox (top-left origin) and belong to the page of their table:
for (const table of res.data.document.tables) {
    const pageNo = table.prov[0]?.page_no ?? 1;
    for (const row of table.data.grid) {
        for (const cell of row) {
            if (cell.bbox) {
                const box = toPageImageBox(res.data.document, { page_no: pageNo, bbox: cell.bbox });
            }
        }
    }
}
```

The boxes fit page images of any conversion by this client, also when `pageImages` was off.

### DoclingDocument structure

`convertDocument()` returns the full JSON AST (`doc.data.document`) typed as `DoclingDocument`:

- `texts`: array of text blocks (`label`, `text`, `orig`, `prov: [{ page_no, bbox, charspan }]`). Common labels include `'paragraph'`, `'section_header'`, `'title'`, `'list_item'`, `'code'`, `'formula'`, `'footnote'`, `'page_header'`, `'page_footer'`, `'caption'`. Section headers include heading `level`. List items include `enumerated` and `marker`. Code listings include `code_language`. Formulas contain LaTeX in `text` with `formulaEnrichment`. Note on `prov.charspan`: `[start, end)` span is in Python Unicode code points; slice in JS using `Array.from(item.text).slice(start, end).join('')`, not `item.text.slice(start, end)`.
- `tables`: array of tables (`prov`, `data: { grid: TableCell[][], num_rows, num_cols }`). Cells contain `text`, `row_span`, `col_span`, `bbox`, `column_header`, and `row_header`.
- `pictures`: array of figures with `captions`, `prov`, `image` (`ImageRef` with base64 data URI when `images: 'embedded'`, or `null` when `images: 'placeholder'`), and `annotations` (e.g. chart data when `chartExtraction` was enabled, classifications, descriptions).
- `groups`: structural groupings (`(ListGroup | InlineGroup | GroupItem)[]`) such as lists, inline formatting runs, chapters, or form sections.
- `key_value_items`: key-value regions extracted from forms or documents (`graph: { cells: GraphCell[], links: GraphLink[] }`).
- `form_items`: form regions and form fields (`graph: { cells: GraphCell[], links: GraphLink[] }`).
- `pages`: record of page metadata keyed by 1-based page number string (`"1"`, `"2"`, ...) with `size: { width, height }` in PDF points.
- `body`: root group of content in reading order. Walk `body.children` (`{ $ref: string }` JSON pointers, e.g. `'#/texts/0'`) depth-first to follow the logical document flow.
- `furniture`: root group of header, footer and page number items outside the body flow.

#### Navigating the AST in reading order

The root content in reading order is stored in `body.children`. Each child is a JSON pointer reference (e.g. `#/texts/0`, `#/tables/1`, `#/groups/2`). You can resolve references and walk the reading order like this:

```ts
import type { DoclingDocument } from 'docling-serve-client';

// Resolving a JSON pointer reference (e.g. '#/texts/0'):
function resolveRef(doc: DoclingDocument, ref: string) {
    const [, collection, idx] = ref.split('/');
    return (doc as Record<string, any>)[collection]?.[Number(idx)];
}

// Walking body items in logical reading order:
function* walkReadingOrder(
    doc: DoclingDocument,
    node: { children: { $ref: string }[] } = doc.body,
): Generator<any> {
    for (const child of node.children) {
        const item = resolveRef(doc, child.$ref);
        if (!item) continue;
        if ('children' in item && Array.isArray(item.children) && item.children.length > 0) {
            yield* walkReadingOrder(doc, item);
        } else {
            yield item;
        }
    }
}
```

### Images in the Markdown

| `images` | effect |
|---|---|
| `'placeholder'` (default) | `<!-- image -->` marks a picture, as docling writes it |
| `'none'` | placeholders removed |
| `'extract'` | pictures come back as bytes in `data.images`, linked as `<prefix><n>.<ext>` |

With `'extract'`, `imageOptions` is required on each call, because the prefix names one document's images:

```ts
import { writeFile } from 'node:fs/promises';

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

### Conversion settings

`convert*()` results (`data.settings`) and `submit*()` jobs (`job.settings`) carry the form fields the request sent,
as a typed `DoclingSettings` object. The client sends an explicit value for every field it controls, also where it
equals docling-serve's default, so the settings do not depend on the server's defaults. Store them with the versions
to know how a document was converted.

```ts
const res = await docling.convertMarkdown(pdf, { ocrEngine: 'rapidocr' });
if (res.ok) {
    res.data.settings.ocrPreset;            // 'rapidocr'
    res.data.settings.tableStructurePreset; // 'tableformer_v1_accurate'
    res.data.settings.vlmPipelinePreset;    // null: pipeline is 'standard'
}
```

- Each key is the camelCase name of a docling-serve form field (`ocrPreset` = `ocr_preset`).
- `null` means the field was not sent: Markdown-only fields for document output, the preset of a disabled stage,
  unset `pageRange` and `documentTimeout`. An empty `ocrLang` was not sent either (engine default).
- Image input records what was sent: `doOcr: true` and `forceOcr: false`, whatever `ocr` and `forceOcr` say.
- Server configuration that has no request field (e.g. the layout model) is not included; see
  `stages.layout` of the [server capabilities](#server-capabilities).

### Server capabilities

`docling.capabilities()` asks `GET /v1/capabilities` for the presets, limits and features of the server. It is for
diagnostics, e.g. to list the allowed `ocrEngine` ids; conversions never call it. It takes only `{ signal }`.

```ts
const caps = await docling.capabilities();
if (caps.ok) {
    caps.data.stages.ocr?.presets.map((preset) => preset.id); // ['auto', 'easyocr', 'rapidocr', 'tesseract', …]
    caps.data.stages.table_structure?.default;                // 'tableformer_v1_accurate'
    caps.data.limits.maxImagesScale;                          // 2, or null when unlimited
    caps.data.features.apiKeyRequired;                        // false
}
```

- The server's snake_case keys come back in camelCase; `stages` keys stay as the server sends them (`ocr`, `layout`,
  `table_structure`, `vlm_pipeline`, `chart_extraction`, …). Each stage has `option` (its form field), `default` and
  `presets` (`{ id, name, description, source }`).
- Missing or mistyped fields become `[]`, `''`, `null` or `false`, so a newer or older payload does not fail the call.
- An allowed preset is not always usable: e.g. `ocrmac` only runs on macOS.
- An older server without the endpoint answers `http` with `status: 404`.

### Broken umlauts / special characters

If the output shows `fŸhrt`, `Nu§baum`, `…sterreich`, the PDF's text layer uses an encoding docling-parse misreads
(seen with `/MacRomanEncoding` PDFs from Mac Word). Re-convert that document with `{ forceOcr: true }` (with `ocrLang: ['de']` on the factory).
It is slower, so use it per document, not by default.

### Errors

All client calls resolve to a `Result<T>` union:
- `{ ok: true, data: T }` on success
- `{ ok: false, error: ConvertError }` on runtime failure

#### Error fields

Every `ConvertError` contains:
- `code`: one of the `ErrorCode` values below
- `message`: human-readable explanation of the failure
- `status`: optional HTTP status code (present when the server answered, e.g. `400`, `404`, `422`, `500`)
- `versions`: server versions captured from `GET /version` if the server answered, or `null`
- `details`: `{ errors: ServerError[]; failure: TaskFailure | null }` (present only when `code === 'conversion_failed'`)

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

TypeScript narrows `error` on `error.code`:

```ts
if (!res.ok) {
    switch (res.error.code) {
        case 'conversion_failed':
            console.error('Conversion failed:', res.error.message);
            console.error('Server error items:', res.error.details.errors);
            console.error('Task failure:', res.error.details.failure);
            break;
        case 'http':
            console.error(`HTTP error ${res.error.status}:`, res.error.message);
            break;
        case 'invalid_input':
            console.error('Input rejected before request:', res.error.message);
            break;
        default:
            console.error(res.error.code, res.error.message);
    }
}
```

#### Programming errors vs runtime errors

| Error Category | Trigger | Handling |
|---|---|---|
| **Runtime failure** | Server unreachable, invalid input file bytes, server HTTP 4xx/5xx, model/conversion failure, abort signal or request timeout | Resolves to `{ ok: false, error: ConvertError }` (never throws) |
| **Programming error** | Invalid client config (malformed URL, invalid types), unsupported or mistyped call options, incompatible options (such as `imageOptions` without `images: 'extract'`) | Throws `TypeError` synchronously on factory; rejects with `TypeError` on async client calls before sending request |

### Exported types, utilities & constants

In addition to `createDoclingClient`, the package exports helper functions, constants, and TypeScript types:

```ts
import {
    createDoclingClient,
    toPageImageBox,
    isSmallImage,
    readPngSize,
    PAGE_IMAGE_SCALE,
    type DoclingClient,
    type DoclingConfig,
    type ClientOptions,
    type DoclingOptions,
    type MarkdownOptions,
    type DocumentOptions,
    type CallOptions,
    type Result,
    type ConvertError,
    type ErrorCode,
    type ConvertedMarkdown,
    type ConvertedDocument,
    type DoclingDocument,
    type DocumentJob,
    type MarkdownJob,
    type Job,
    type JobRef,
    type JobState,
    type DoclingSettings,
    type ServerCapabilities,
    type ExtractedImage,
    type PageImage,
    type PageImageBox,
    type ImageSize,
    type MarkdownWarning,
    type DocumentWarning,
    type ServerError,
    type TaskFailure,
} from 'docling-serve-client';
```

- `toPageImageBox(document, prov)`: maps a provenance item `{ page_no, bbox }` to `{ page, x, y, width, height }` in pixels with a top-left origin; returns `undefined` if the page is missing or coordinates are invalid.
- `isSmallImage(size)`: returns `true` if pixel dimensions match the `omitSmall` filter (area < 15,000 px, long side < 200 px, or short side < 24 px).
- `readPngSize(bytes)`: parses `{ width, height }` directly from a PNG's IHDR header; returns `undefined` if not a valid PNG.
- `PAGE_IMAGE_SCALE`: constant `2` (144 dpi resolution used by docling page images and bounding box coordinates).

## Running docling-serve

The client connects to a running [docling-serve](https://github.com/docling-project/docling-serve) server:

```bash
# Install docling-serve (default / CPU)
uv tool install docling-serve

# Or with CUDA (check your driver with nvidia-smi; use matching PyTorch tag, e.g. cu124, cu126)
uv tool install --torch-backend <cuda-tag> docling-serve

# Or via Docker (CPU)
docker run -p 5001:5001 quay.io/ds4sd/docling-serve

# Or via Docker (NVIDIA GPU / CUDA)
docker run --gpus all -p 5001:5001 quay.io/ds4sd/docling-serve

# Start the local server (listens on http://127.0.0.1:5001 by default)
docling-serve run
```

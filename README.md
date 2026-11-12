[![Test](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/test.yml/badge.svg)](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/test.yml)
[![Package](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/package.yml/badge.svg)](https://github.com/martin-winkler-dev/docling-serve-client-js/actions/workflows/package.yml)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmartin-winkler-dev%2Fdocling-serve-client-js%2Fmain%2Fpackage.json&query=%24.engines.bun&label=Bun&logo=bun&color=blue)](https://bun.sh)
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmartin-winkler-dev%2Fdocling-serve-client-js%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node.js&logo=nodedotjs&color=blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

# docling-serve-client

Typed HTTP client for a running [docling-serve](https://github.com/docling-project/docling-serve): **PDF or image bytes in, docling's Markdown or DoclingDocument JSON out**.

- **Two outputs**: `convertMarkdown` returns docling's Markdown unchanged (with configurable image handling); `convertDocument` returns the full DoclingDocument JSON AST (labels, reading order, page metadata, bounding boxes).
- **No text heuristics**: raw docling output is preserved exactly as returned by the server (e.g. HTML entities, soft hyphens, dot leaders).
- **In-memory only**: no file I/O or streaming dependencies.
- **Never throws on runtime failures**: all client calls resolve to `{ ok: true, data } | { ok: false, error }`. Programming errors throw a `TypeError` (synchronously on the factory for invalid configuration; rejected on methods before sending requests for invalid options).
- **Three execution modes**: single requests (`convert*`), background jobs (`submit*` + `check`), and automated polling helpers (`run*`, `waitForJob`). See [Single request or job?](#single-request-or-job).
- **Zero dependencies**: pure ESM, runs on Node ≥ 22.12 (including `require()`) and Bun.

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

// Input is a Uint8Array (Node Buffer is an instance): PDF, PNG, JPEG, TIFF, or WebP
const pdf = await readFile('paper.pdf');
// const pdf = await Bun.file('paper.pdf').bytes(); // Bun

// 1. Convert to Markdown
const md = await docling.convertMarkdown(pdf);
if (md.ok) {
    console.log(md.data.markdown, md.data.warnings);
}

// 2. Convert to DoclingDocument JSON AST
const doc = await docling.convertDocument(pdf);
if (doc.ok) {
    for (const item of doc.data.document.texts) {
        if (item.label === 'section_header') {
            console.log(item.level, item.text, item.prov[0]?.page_no);
        }
    }
} else {
    console.error(doc.error.code, doc.error.message);
}

// 3. Automated job helper (identical data, typically faster for small inputs)
const fast = await docling.runDocument(pdf);
if (fast.ok) {
    console.log(fast.data.document.texts.length, fast.data.settings);
}
```

### Single request or job?

docling-serve exposes two endpoint families, covered by three client patterns:

| Client Calls | docling-serve Endpoints | Execution Model |
|---|---|---|
| Single request: `convertMarkdown`, `convertDocument` | Sync: `POST /v1/convert/file` | Holds a single HTTP connection open until conversion completes |
| Background job: `submitMarkdown`, `submitDocument`, `check` | Async: `POST /v1/convert/file/async`, `GET /v1/status/poll/{id}`, `GET /v1/result/{id}` | Returns a job ID immediately; caller persists job and polls with `check()` |
| Job helper: `runMarkdown`, `runDocument`, `waitForJob` | Async (as above) | Submits (or takes a stored job) and polls every `pollMs` (default 10 ms) until complete |

Under the hood, docling-serve processes single requests as background jobs polled at intervals of `DOCLING_SERVE_SYNC_POLL_INTERVAL` seconds (default 2). A sync request only finishes on a tick: a 0.5 s conversion waits up to 2 s, and a 2.1 s conversion waits 4 s. Measured on a one-page PDF (docling-serve 1.38.2, 5 calls each after warm-up):

| Call | Duration per call |
|---|---|
| `convertDocument`, `convertMarkdown` | 2006 to 2033 ms |
| `runDocument`, `runMarkdown` | 221 to 420 ms |

Which to use:

- **Small inputs or latency-sensitive tasks** (single images, OCR crops, one-page PDFs): use `runMarkdown` or `runDocument`. They resolve to the same `data` as `convert*` and act as drop-in replacements.
- **Long documents**: any call works (latency overhead is at most one tick). Single requests fail with HTTP 504 after `DOCLING_SERVE_MAX_SYNC_WAIT` (120 s), so use a job or job helper for long conversions.
- **Cross-process workflows, queue progress, or recovery**: use `submit*`, persist the job object, and poll with `check()` or `waitForJob()`.
- **Single HTTP request without polling**: use `convert*`.

Relevant docling-serve environment variables (read from the server environment or `.env` in the server root):

| Variable | Default | Description |
|---|---|---|
| `DOCLING_SERVE_SYNC_POLL_INTERVAL` | `2` | Seconds between status checks on the sync endpoint (integer; `1` halves single-request wait; fractions like `0.5` fail server startup) |
| `DOCLING_SERVE_MAX_SYNC_WAIT` | `120` | Seconds a single request waits before returning HTTP 504 (the server task continues running) |
| `DOCLING_SERVE_SINGLE_USE_RESULTS` | `true` | Purges task results `DOCLING_SERVE_RESULT_REMOVAL_DELAY` seconds after first result fetch (see [Jobs](#jobs)) |
| `DOCLING_SERVE_RESULT_REMOVAL_DELAY` | `300` | Seconds from first result fetch until the task is deleted |

```bash
DOCLING_SERVE_SYNC_POLL_INTERVAL=1 docling-serve run --host 127.0.0.1 --port 5001
```

In Node, `fetch` aborts if response headers take longer than 300 s (`network` error due to undici's default `headersTimeout`), so single requests fail after 300 s even if `DOCLING_SERVE_MAX_SYNC_WAIT` is set higher. Jobs are not affected.

### Jobs

`submitMarkdown()` and `submitDocument()` return a plain JSON job object. Persist it and pass it to `check()` or `waitForJob()`. A Markdown job preserves its image handling settings across processes and restarts, returning the result type matching the job's `kind`. Jobs also store the [conversion settings](#conversion-settings) sent at submission; `check()` and `waitForJob()` do not require `settings` and omit them from their result.

```ts
import type { DocumentJob } from 'docling-serve-client';

// 1. One awaited helper call: submit, poll every 10 ms, return result (same data as convertDocument)
const res = await docling.runDocument(pdf, { images: 'placeholder' });
if (res.ok) {
    console.log(res.data.document, res.data.settings);
}

// 2. Or submit and store the job handle:
const job = await docling.submitDocument(pdf);
if (!job.ok) {
    throw new Error(`${job.error.code}: ${job.error.message}`);
}
await save(JSON.stringify(job.data)); // { kind: 'document', id, settings }

// 3. Later (in this or another process): poll until complete
const storedJob: DocumentJob = JSON.parse(await load());
const done = await docling.waitForJob(storedJob, { pollMs: 100 }); // Result<ConvertedDocument>
if (done.ok) {
    console.log(done.data.document);
} else {
    console.error(done.error.code, done.error.message);
}

// 4. Or check status on demand (e.g. for progress bars):
const state = await docling.check(storedJob);
if (state.ok) {
    switch (state.data.status) {
        case 'queued':  console.log('Queue position:', state.data.position); break;
        case 'running': console.log('Processing...'); break;
        case 'done':    console.log(state.data.document); break;
    }
} else {
    // state.error.code: 'not_found' (expired or unknown ID), 'http', 'conversion_failed', etc.
    console.error(state.error.code, state.error.message);
}
```

For Markdown jobs (`submitMarkdown`), `check()` returns `JobState<ConvertedMarkdown>` (`done` provides `markdown`, `images`, `warnings`, `versions`) and `waitForJob()` returns `ConvertedMarkdown`.

Job helper details:

- `runMarkdown()` / `runDocument()` = `submit*()` + `waitForJob()`. They accept `convert*` options plus `pollMs` and resolve to `WithSettings<...>` (matching `convert*`).
- `waitForJob()` resolves to `check()`'s `done` data without `status` (`ConvertedMarkdown | ConvertedDocument` when called with an unnarrowed `JobRef`).
- The first status poll runs immediately; `pollMs` delays only after `queued` or `running` states, keeping at most one request in flight. Finished jobs return in a single check.
- The first encountered error terminates the call without retries (same error codes as `submit*` and `check()`).
- `signal` covers submission, status polls, and waits. Factory `timeoutMs` limits individual HTTP requests. Use `signal: AbortSignal.timeout(ms)` to bound total execution time.
- Aborting a call (or encountering an HTTP 504 on `convert*`) cancels only client-side execution; docling-serve has no task cancellation endpoint, so the server task continues.
- `run*` does not return the job handle. To retain job IDs across restarts or retry result downloads, use `submit*` with `waitForJob()`.

When `DOCLING_SERVE_SINGLE_USE_RESULTS=true` (the default), docling-serve purges a task `DOCLING_SERVE_RESULT_REMOVAL_DELAY` seconds (default 300) after its result is first fetched. If a download in `check()` or `waitForJob()` fails (e.g. network interruption or abort), it can be retried within this window. Once purged, calls return `not_found` (`Unknown job id`). To retain completed tasks on the server, configure `DOCLING_SERVE_SINGLE_USE_RESULTS=false`. Single requests (`convert*`) are unaffected.

### Client configuration and options

Create a client instance with `createDoclingClient(config)`:

```ts
import { createDoclingClient } from 'docling-serve-client';

const docling = createDoclingClient({
    baseUrl: 'http://127.0.0.1:5001',   // base URL (may include a path prefix); trailing slash stripped; no query, fragment, or auth
    apiKey: 'my-secret-key',            // optional X-Api-Key header
    timeoutMs: 120_000,                 // optional per-request timeout in ms (resolves to aborted)
    pollMs: 10,                         // default polling interval in ms for job helpers (default 10)
    options: { ocrLang: ['de', 'en'] }, // default docling options applied to every call
    fetch: customFetch,                 // optional custom fetch implementation
});
```

#### Factory configuration (`DoclingConfig`)

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | *required* | docling-serve base URL (e.g. `'http://127.0.0.1:5001'`). May include a path prefix; trailing slash stripped; no query, fragment, or credentials |
| `apiKey` | `string` | none | Sent in `X-Api-Key` request header |
| `timeoutMs` | `number` | none | Per-request timeout in milliseconds (integer `1..2147483647`; resolves to `aborted` on expiry; excludes `/version`) |
| `pollMs` | `number` | `10` | Default polling interval in ms for job helpers (`run*`, `waitForJob`) (integer `1..2147483647`) |
| `options` | `ClientOptions` | none | Default conversion options applied to every call |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation for proxies, mocking, or custom dispatchers |

The default `pollMs` of 10 ms sends up to 100 status requests per second per active job. On a local docling-serve instance with the default in-memory engine, status lookups are in-memory checks. For remote servers, queue-backed workers (RQ or Ray), or high-concurrency environments, configure 100 to 500 ms. The client performs no internal request queueing or rate limiting.

#### Conversion options (`DoclingOptions`)

Configurable on the factory as defaults and overridable per call. Invalid option keys or values throw a `TypeError` synchronously on the factory, or reject with a `TypeError` on client calls before sending a request (`Option "x" is not supported`, `Invalid value for option "x"`; nested keys are named like `imageOptions.prefix`).

| Option | Type | Default | Description |
|---|---|---|---|
| `headingHierarchy` | `boolean` | `true` | Infers heading levels from bookmarks, numbering, and font styles. When `false`, all headings are level 1 |
| `formulaEnrichment` | `boolean` | `true` | Extracts math formulas as LaTeX via dedicated model. When `false`, formula text is empty and Markdown shows `<!-- formula-not-decoded -->` |
| `codeEnrichment` | `boolean` | `false` | Extracts code listings via dedicated model (slower) |
| `chartExtraction` | `boolean` | `false` | Extracts charts and plots as structured data via vision model (slower) |
| `pipeline` | `'standard' \| 'vlm'` | `'standard'` | Processing pipeline. `'vlm'` runs a vision-language model per page (slow) |
| `pdfBackend` | `'docling_parse' \| 'pypdfium2'` | `'docling_parse'` | Text extraction engine. `'pypdfium2'` handles ligatures and word spaces better but omits page headers/footers |
| `ocr` | `boolean` | `true` | Runs OCR on scanned pages and raster graphics. Image input always runs OCR |
| `forceOcr` | `boolean` | `false` | Forces full-page OCR across all pages and drops the PDF text layer (for PDFs with corrupt text encodings). Enables OCR even with `ocr: false`. Slower than standard OCR, so prefer using it per document. Ignored for image input |
| `ocrEngine` | `OcrEngine` | `'auto'` | OCR engine preset (`ocr_preset`), e.g. `'auto'`, `'rapidocr'`, `'easyocr'`, `'tesseract'`, `'tesserocr'`, `'ocrmac'`, or any non-empty preset ID allowed by the server. An unallowed preset is rejected by the server with `http` status 422 (see [Server capabilities](#server-capabilities)) |

#### Factory-only options

Configured in `options` of `createDoclingClient`. Passing these per-call rejects with a `TypeError: Option "x" is not supported`. Use a separate client instance if different values are required.

| Option | Type | Default | Description |
|---|---|---|---|
| `ocrLang` | `string[]` | engine default | BCP-47 language priority codes, e.g. `['de', 'en-US']`. `[]` uses the engine default |
| `pageRange` | `[number, number]` | all pages | Inclusive 1-based page range `[from, to]` |
| `documentTimeout` | `number` | server default | Server-side conversion timeout in seconds |

#### Per-call options

Options passed to individual conversion calls. These cannot be set in factory `options` (the factory throws a synchronous `TypeError: Option "x" is not supported`).

| Option | Applicable Calls | Type | Default | Description |
|---|---|---|---|---|
| `images` | Markdown calls | `'placeholder' \| 'none' \| 'extract'` | `'placeholder'` | Markdown image handling mode (see [Images in Markdown](#images-in-markdown)) |
| `imageOptions` | Markdown calls | `{ prefix: string, omitSmall?: boolean }` | none | Link prefix and size filtering. Required with `images: 'extract'`; rejected otherwise |
| `images` | Document calls | `'embedded' \| 'placeholder'` | `'embedded'` | AST picture image mode (see [Images in the DoclingDocument](#images-in-the-doclingdocument)) |
| `pageImages` | Document calls | `boolean` | `false` | Renders pages as images, decoded into `data.pageImages` (see [Page images](#page-images)) |
| `signal` | All calls | `AbortSignal` | none | Cancels the request or overall operation on abort |
| `pollMs` | `runMarkdown`, `runDocument`, `waitForJob` | `number` | factory `pollMs` (`10`) | Polling interval in milliseconds (integer `1..2147483647`). Rejected by `convert*`, `submit*`, and `check` |

#### Pinned server settings

The client enforces explicit server settings for consistent output:
- **Table structure**: Accurate TableFormer model is always enabled (`do_table_structure: true`, `table_mode: 'accurate'`, `table_structure_preset: 'tableformer_v1_accurate'`, `table_cell_matching: true`).
- **Resolution**: Pictures and page images render at 144 DPI (`images_scale: 2`, exported as `PAGE_IMAGE_SCALE`). Note: OCR runs independently at docling's internal 216 DPI.
- **Markdown format**: Compact tables are enabled (`md_compact_tables: true`) without page break placeholders (`md_page_break_placeholder: ''`). For document output, both parameters are omitted (`null`).
- **Model presets**: Pinned to `granite_docling` for `pipeline: 'vlm'`, `granite_vision_v4` for `chartExtraction`, and `codeformulav2` for code and formula enrichment. Picture classification and description remain disabled.

### Input formats

Input is supplied as a `Uint8Array` (Node `Buffer` instances are compatible). File formats are detected directly from header magic bytes; unsupported formats immediately resolve to `invalid_input` without sending an HTTP request:

| Format | Detection Signature | Sent As |
|---|---|---|
| PDF | `%PDF-` within the first 1024 bytes | `from_formats=pdf`, `document.pdf` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` at byte 0 | `from_formats=image`, `document.png` |
| JPEG | `FF D8 FF` at byte 0 | `from_formats=image`, `document.jpg` |
| TIFF | Little-endian `49 49 2A 00` or big-endian `4D 4D 00 2A` at byte 0 | `from_formats=image`, `document.tiff` |
| WebP | `RIFF` at byte 0 and `WEBP` at byte 8 | `from_formats=image`, `document.webp` |

Image inputs are converted as single-page documents. Docling runs layout detection and OCR on the image (`ocrLang` applies). Because images contain no embedded text layer, text extraction requires a working OCR engine on the server. OCR is always active for images: `ocr: false` and `forceOcr: true` are ignored (forcing full-page OCR on images merges words like `stepsand`). PDF-specific options (`pdfBackend`, `pageRange`) do not affect images.

### Images in the DoclingDocument

| `images` | Effect |
|---|---|
| `'embedded'` (default) | `pictures[].image.uri` contains a `data:image/png;base64,…` URI. Pictures retain bounding boxes, captions, and dimensions |
| `'placeholder'` | `pictures[].image` is `null`. Picture entries, bounding boxes, and captions remain intact; document payload is significantly smaller |

Base64 image data remains inside the document JSON. `isSmallImage(picture.image.size)` can be used to filter icons and decorative elements using the same heuristic as `omitSmall`.

### Page images

Setting `pageImages: true` (document conversions only; default `false`) requests page renderings from docling (`include_page_images`). The client strips embedded base64 data from `document.pages[n].image` (setting it to `null`) and returns decoded raw PNG images in `data.pageImages`:

```ts
import { writeFile } from 'node:fs/promises';

const res = await docling.convertDocument(pdf, { pageImages: true, images: 'placeholder' });
if (res.ok) {
    await writeFile(`out/${docId}.json`, JSON.stringify(res.data.document)); // Small JSON without embedded page images
    for (const image of res.data.pageImages) {
        await writeFile(`out/${docId}-p${image.page}.png`, image.bytes);     // { page, mimeType, width, height, dpi, bytes }
    }
}
```

- `page`: 1-based page number (absolute, preserved across `pageRange`); `dpi` is the resolution reported by docling (typically 144), or `0` if not reported.
- `width` and `height`: Pixel dimensions parsed from the PNG header (or docling's `image.size`). Scaled at 2 px per PDF point (an A4 page is ~1190 × 1684 px, ~0.4–0.6 MB PNG).
- Independent of `images`: `{ images: 'placeholder', pageImages: true }` drops figure raster data while returning page images.
- Job persistence: `submitDocument(pdf, { pageImages: true })` requires no extra storage; `check()` and `waitForJob()` return decoded page images.
- Any page image whose URI is not a base64 data URI, or contains invalid or empty data, is omitted from `pageImages`, retained in `document.pages[].image` as docling sent it, and reported in `data.warnings` with code `page_image_not_decoded` (`details.page`).

#### Mapping bounding boxes to page images (`toPageImageBox`)

Docling documents store coordinates in PDF points, typically with a `BOTTOMLEFT` origin. The helper `toPageImageBox` maps any provenance bounding box to top-left pixel coordinates matching rendered page images:

```ts
import { toPageImageBox } from 'docling-serve-client';

for (const item of res.data.document.texts) {
    for (const prov of item.prov) {
        const box = toPageImageBox(res.data.document, prov); // { page, x, y, width, height }
    }
}

// Table cells provide their own bbox (with TOPLEFT origin) and belong to their table's page:
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

`toPageImageBox` calculates pixel coordinates using `PAGE_IMAGE_SCALE` (`2`). It works on any conversion result, even when `pageImages: false` was used. Returns `undefined` if page dimensions or coordinates are missing or invalid.

### DoclingDocument structure

`convertDocument()` returns the full JSON AST (`doc.data.document`) typed as `DoclingDocument`:

- `texts`: Array of text blocks (`label`, `text`, `orig`, `prov: [{ page_no, bbox, charspan }]`). Common labels: `'paragraph'`, `'section_header'`, `'title'`, `'list_item'`, `'code'`, `'formula'`, `'footnote'`, `'page_header'`, `'page_footer'`, `'caption'`. Section headers include heading `level`. List items include `enumerated` and `marker`. Code listings include `code_language`. Formulas contain LaTeX in `text` when `formulaEnrichment` is enabled. Note on `prov.charspan`: `[start, end)` is in Python Unicode code points; slice in JavaScript using `Array.from(item.text).slice(start, end).join('')` instead of `item.text.slice(start, end)` to handle surrogate pairs.
- `tables`: Array of tables (`prov`, `data: { grid: TableCell[][], num_rows, num_cols }`). Cells provide `text`, `row_span`, `col_span`, `bbox`, `column_header`, and `row_header`.
- `pictures`: Array of figures with `captions`, `prov`, `image` (`ImageRef` with base64 data URI when `images: 'embedded'`, or `null` when `images: 'placeholder'`), and `annotations` (e.g. chart data when `chartExtraction` was enabled, classifications, descriptions).
- `groups`: Structural groupings (`(ListGroup | InlineGroup | GroupItem)[]`) such as lists, inline formatting runs, chapters, or form sections.
- `key_value_items`: Key-value regions extracted from forms or documents (`graph: { cells: GraphCell[], links: GraphLink[] }`).
- `form_items`: Form regions and fields (`graph: { cells: GraphCell[], links: GraphLink[] }`).
- `pages`: Record of page metadata keyed by 1-based page number string (`"1"`, `"2"`, ...) with `size: { width, height }` in PDF points.
- `body`: Root container of content in logical reading order. Walk `body.children` (`{ $ref: string }` JSON pointers, e.g. `'#/texts/0'`) depth-first to traverse the document flow.
- `furniture`: Root container of headers, footers, and page numbers outside the body flow.

#### Navigating the AST in reading order

Root document flow is organized under `body.children`. Each child contains a JSON pointer reference (e.g. `#/texts/0`, `#/tables/1`, `#/groups/2`). References can be resolved and traversed like this:

```ts
import type { DoclingDocument } from 'docling-serve-client';

// Resolves a JSON pointer reference (e.g. '#/texts/0' or '#/body'):
function resolveRef(doc: DoclingDocument, ref: string) {
    const parts = ref.replace(/^#\//, '').split('/');
    if (parts.length === 1) return (doc as Record<string, any>)[parts[0]!];
    return (doc as Record<string, any>)[parts[0]!]?.[Number(parts[1])];
}

// Walks body items in logical reading order:
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

### Images in Markdown

| `images` | Effect |
|---|---|
| `'placeholder'` (default) | `<!-- image -->` comment marks figure locations as produced by docling |
| `'none'` | Removes image comments |
| `'extract'` | Extracts images as binary buffers in `data.images` and updates Markdown links to `<prefix><n>.<ext>` |

When `images: 'extract'` is selected, `imageOptions` is required:

```ts
import { writeFile } from 'node:fs/promises';

const res = await docling.convertMarkdown(pdf, {
    images: 'extract',
    imageOptions: { prefix: `images/${docId}-` }, // omitSmall defaults to true
});
if (res.ok) {
    await writeFile(`out/${docId}.md`, res.data.markdown); // e.g. ![Image](images/doc123-1.png)
    for (const image of res.data.images) {
        await writeFile(`out/${image.path}`, image.bytes); // { path, mimeType, bytes, width, height }
    }
}
```

- Image numbering `n` starts at 1 and counts only retained images. Extension `<ext>` is derived from MIME type (`png`, `jpg`, `gif`, `webp`, `svg`, `tiff`, `bmp`, or `bin`).
- `omitSmall` (default `true`): Drops small icons, bullets, and decorative lines. Small images meet any of: area < 15,000 px, long side < 200 px, or short side < 24 px (`isSmallImage`). Only PNG images have known dimensions (`readPngSize`); non-PNG formats are retained with `width` and `height` set to `0`.
- Corrupt or empty base64 image data is removed and recorded in `data.warnings` with code `image_not_decoded` (`details.index` is the 1-based index among embedded images).
- Figures emitted by docling without image data retain their `<!-- image -->` placeholder comment.
- Removing placeholders or small images preserves adjacent paragraph line spacing.

### Warnings

`data.warnings` contains non-fatal issues encountered during an otherwise successful conversion:

| Code | `details` | Description |
|---|---|---|
| `server` | `{ component, module, category, page }` | Warning reported by docling-serve (e.g. single page failure or `document timeout exceeded`). `page` is the 1-based page number or `null` |
| `image_not_decoded` | `{ index }` | Undecodable embedded image in Markdown (`images: 'extract'`). `index` is 1-based |
| `page_image_not_decoded` | `{ page }` | Undecodable page image in Document output (`pageImages: true`). `page` is 1-based |

Pages abandoned by the server (e.g. due to `documentTimeout`) contain no extracted content and trigger a `server` warning.

### Server versions

`data.versions` contains version metadata reported by `GET /version` (e.g. `{ 'docling-serve': '1.38.2', docling: '2.135.0', 'docling-core': '2.101.1', ... }`), or `null` if unreachable.

Storing versions alongside converted documents aids reproducibility, as conversion output can vary across docling releases (`document.version` indicates the DoclingDocument schema version, whereas `data.versions` reflects server runtime packages). Errors from requests answered by the server (`http`, `not_found`, `conversion_failed`, `invalid_response`) also populate `error.versions`. The client caches versions across requests; if a version check fails (2 s timeout), `versions` is `null` and retried on the next request. Create a new client instance after upgrading docling-serve.

### Conversion settings

Results from `convert*()` and `run*()` (`data.settings`) and job objects from `submit*()` (`job.settings`) include a typed `DoclingSettings` record of all form parameters sent to docling-serve.

The client sends explicit values for every setting it controls, avoiding reliance on server defaults:

```ts
const res = await docling.convertMarkdown(pdf, { ocrEngine: 'rapidocr' });
if (res.ok) {
    console.log(res.data.settings.ocrPreset);            // 'rapidocr'
    console.log(res.data.settings.tableStructurePreset); // 'tableformer_v1_accurate'
    console.log(res.data.settings.vlmPipelinePreset);    // null (pipeline is 'standard')
}
```

- Keys represent camelCase mappings of server form parameters (`ocrPreset` = `ocr_preset`).
- `null` indicates the parameter was omitted: Markdown-specific fields for JSON output, presets of inactive pipeline stages, or unset factory options (`pageRange`, `documentTimeout`). An empty `ocrLang` is omitted (server engine default).
- For image input, `doOcr: true` and `forceOcr: false` are recorded regardless of option flags.
- For PDF input with `forceOcr: true`, `doOcr: true` is recorded even when `ocr: false`.
- Server configuration outside request fields (e.g. default layout model) is not included; inspect `stages.layout` via `docling.capabilities()`.

### Server capabilities

`docling.capabilities({ signal? })` queries `GET /v1/capabilities` to inspect supported presets, stages, and limits. Used for diagnostics (e.g. checking available OCR engines); conversion calls do not invoke it automatically:

```ts
const caps = await docling.capabilities();
if (caps.ok) {
    console.log(caps.data.stages.ocr?.presets.map((p) => p.id)); // ['auto', 'easyocr', 'rapidocr', 'tesseract', ...]
    console.log(caps.data.stages.table_structure?.default);       // 'tableformer_v1_accurate'
    console.log(caps.data.limits.maxImagesScale);                 // 2 or null
    console.log(caps.data.features.apiKeyRequired);               // false
}
```

- Snake_case server keys are converted to camelCase, while `stages` keys retain their server names (`ocr`, `layout`, `table_structure`, `vlm_pipeline`, `chart_extraction`, etc.). Each stage provides its form parameter name (`option`), server default (`default`), and allowed presets (`presets: { id, name, description, source }[]`).
- Missing or mistyped payload properties fall back to safe empty defaults (`[]`, `''`, `null`, `false`).
- Capabilities do not guarantee runtime availability (e.g. `ocrmac` requires macOS).
- Older server versions lacking the endpoint return an `http` error with status `404`.

### Corrupt text encodings & special characters

If output displays corrupted umlauts or symbols (e.g. `fŸhrt`, `Nu§baum`, `…sterreich`), the PDF text layer uses an encoding incompatible with docling's parser (common in Mac Word documents with `/MacRomanEncoding`). Re-convert with `{ forceOcr: true }` (and configure `ocrLang` on the factory) to bypass the corrupt text layer and run full-page OCR.

### Errors

All client methods return a discriminated `Result<T>` union:
- `{ ok: true, data: T }` on success
- `{ ok: false, error: ConvertError }` on runtime failure

#### Error structure

Every `ConvertError` contains:
- `code`: Error classification (see table below)
- `message`: Diagnostic description
- `status`: Optional HTTP status code when answered by the server (e.g. `400`, `404`, `422`, `500`)
- `versions`: Server versions captured via `GET /version`, or `null`
- `details`: `{ errors: ServerError[]; failure: TaskFailure | null }` (present only when `code === 'conversion_failed'`). `errors` lists docling error items with `{ message, details: { component, module, category, page } }`; `failure` categorizes task failure as `{ category, phase, retryable }` (or `null`)

| Code | Cause |
|---|---|
| `invalid_input` | Input is not a non-empty `Uint8Array`, contains an unrecognized file signature, has a truncated PDF cross-reference table, is an invalid job object, or failed buffer preparation before upload. No request sent |
| `network` | Server unreachable or connection refused |
| `aborted` | Abort signal fired (including `AbortSignal.timeout()`), or factory `timeoutMs` expired |
| `http` | Non-2xx HTTP response, or single-request timeout (HTTP 504 after `DOCLING_SERVE_MAX_SYNC_WAIT`) |
| `not_found` | `check()` or `waitForJob()`: unknown or expired job ID (`Unknown job id` after server restart or expiration of 300 s result delay), or task purged between poll and fetch (`Result already fetched or expired`). Server message follows in parentheses |
| `conversion_failed` | Server failed to convert the document (or returned partial success without output content). Details provided in `error.details` |
| `invalid_response` | Unexpected response payload (unparseable JSON, missing task ID, missing output data, or body exceeding readable bounds) |

#### Error narrowing in TypeScript

TypeScript automatically narrows `error.details` based on `error.code`:

```ts
if (!res.ok) {
    switch (res.error.code) {
        case 'conversion_failed':
            console.error('Conversion failed:', res.error.message);
            console.error('Server errors:', res.error.details.errors);
            console.error('Task failure:', res.error.details.failure);
            break;
        case 'http':
            console.error(`HTTP error ${res.error.status}:`, res.error.message);
            break;
        case 'invalid_input':
            console.error('Validation failed before request:', res.error.message);
            break;
        default:
            console.error(res.error.code, res.error.message);
    }
}
```

#### Runtime errors vs programming errors

| Category | Causes | Handling |
|---|---|---|
| **Runtime failure** | Server down, invalid file bytes, HTTP 4xx/5xx, model crash, request timeout, abort signal | Resolves to `{ ok: false, error: ConvertError }` (never throws) |
| **Programming error** | Malformed base URL, invalid config types, unsupported call options, mutually exclusive options (e.g. `imageOptions` without `images: 'extract'`) | Factory throws `TypeError` synchronously; methods reject with `TypeError` before sending a request |

### Exported types, utilities & constants

In addition to `createDoclingClient`, the package exports helper functions, constants, and TypeScript types:

```ts
import {
    createDoclingClient,
    toPageImageBox,
    isSmallImage,
    readPngSize,
    PAGE_IMAGE_SCALE,
    type CallOptions,
    type CapabilityLimits,
    type CapabilityPreset,
    type CapabilityStage,
    type ClientOptions,
    type ConversionFailure,
    type ConvertError,
    type ConvertedDocument,
    type ConvertedMarkdown,
    type ConvertInput,
    type DoclingClient,
    type DoclingConfig,
    type DoclingDocument,
    type DoclingOptions,
    type DoclingSettings,
    type DocumentImageMode,
    type DocumentJob,
    type DocumentOptions,
    type DocumentWarning,
    type ErrorCode,
    type ExtractedImage,
    type ImageOptions,
    type ImageSize,
    type ImageWarning,
    type Job,
    type JobRef,
    type JobState,
    type MarkdownImageMode,
    type MarkdownJob,
    type MarkdownJobOutput,
    type MarkdownOptions,
    type MarkdownWarning,
    type OcrEngine,
    type PageImage,
    type PageImageBox,
    type PageImageWarning,
    type PdfBackend,
    type PdfInput,
    type Pipeline,
    type PollOptions,
    type Result,
    type ServerCapabilities,
    type ServerDetails,
    type ServerError,
    type ServerVersions,
    type ServerWarning,
    type TaskFailure,
    type WithSettings,
} from 'docling-serve-client';
```

- `toPageImageBox(document, prov)`: Maps a provenance entry `{ page_no, bbox }` to `{ page, x, y, width, height }` in top-left pixel coordinates. Returns `undefined` if page dimensions or coordinates are missing or invalid.
- `isSmallImage(size)`: Returns `true` if pixel dimensions match the `omitSmall` filter (area < 15,000 px, long side < 200 px, or short side < 24 px).
- `readPngSize(bytes)`: Extracts `{ width, height }` directly from a PNG's IHDR chunk. Returns `undefined` for invalid or non-PNG data.
- `PAGE_IMAGE_SCALE`: Constant `2` (144 DPI resolution used by docling page images and coordinate scaling).

## Running docling-serve

The client connects to a running [docling-serve](https://github.com/docling-project/docling-serve) instance:

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

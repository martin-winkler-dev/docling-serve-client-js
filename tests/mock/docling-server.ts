// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/style/useNamingConvention: mirrors docling-serve's snake_case form fields and JSON
// A fake `fetch` that answers like docling-serve for every request this package sends. It renders a small synthetic
// document as md (`to_formats=md`) or DoclingDocument JSON (`to_formats=json`), so the options that change the output
// (headings, tables, images, page range) have a visible effect.
import type {
    DoclingDocument,
    PictureItem,
    ProvenanceItem,
    RefItem,
    SectionHeaderItem,
    TableCell,
    TableItem,
    TextItem,
} from '../../src/document.js';
import { pngBytes, toBase64 } from './image-bytes.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Fake docling-serve: a `fetch` plus the requests it received. */
export type MockDoclingServer = {
    fetch: typeof fetch;
    /** Every request received, oldest first. */
    requests: MockRequest[];
    /** The next request answers with this response, or rejects with this error (like a network failure). */
    failNext(answer: Response | Error): void;
};

/** One request as the mock received it. */
export type MockRequest = {
    method: string;
    path: string;
    headers: Headers;
    /** The parsed multipart body of a POST request. */
    form?: FormData;
};

/** Server settings of the mock. */
export type MockServerOptions = {
    /** Require this `X-Api-Key`, like docling-serve started with `DOCLING_SERVE_API_KEY`. */
    apiKey?: string;
};

/** Content block of a mock page; `text` is plain, md escaping happens on render. */
export type MockBlock =
    | { type: 'heading'; level: number; text: string }
    | { type: 'text'; text: string }
    | { type: 'table'; rows: string[][] }
    | { type: 'picture'; width: number; height: number };

/** Async task; its status advances with each poll. */
type MockTask = {
    id: string;
    polls: number;
    /** Conversion result, returned by `/v1/result/:id` once the task is done. */
    result: ConvertResult;
};

/** Body of docling-serve's `ConvertDocumentResponse`. */
type ConvertResult = {
    document: { filename: string; md_content: string | null; json_content: DoclingDocument | null };
    status: 'success' | 'failure';
    errors: { component_type: string; module_name: string; error_message: string }[];
    processing_time: number;
    timings: Record<string, never>;
};

/** Output choices read from the form. */
type RenderStyle = {
    /** Real heading levels (`do_pdf_heading_hierarchy`); otherwise every heading has level 1 in JSON, `##` in md. */
    hierarchy: boolean;
    /** Minimal md table padding (`md_compact_tables`). */
    compact: boolean;
    /** Picture data requested (`image_export_mode=embedded` and `include_images=true`). */
    embedded: boolean;
    /** Page images requested (`image_export_mode=embedded` and `include_page_images=true`). */
    pageImages: boolean;
    /** `images_scale`; docling's default is 2. */
    scale: number;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** The synthetic two-page document every conversion "reads". */
export const MOCK_PAGES: MockBlock[][] = [
    [
        { type: 'heading', level: 1, text: 'Mock Report' },
        { type: 'picture', width: 88, height: 32 },
        { type: 'heading', level: 2, text: '1 Introduction' },
        { type: 'text', text: 'Research & Development on page one.' },
    ],
    [
        { type: 'heading', level: 3, text: '1.1 Details' },
        {
            type: 'table',
            rows: [
                ['Project', 'Budget'],
                ['Alpha', '120 000'],
            ],
        },
        { type: 'picture', width: 400, height: 300 },
        { type: 'text', text: 'Text on page two.' },
    ],
];

/** A PDF containing these bytes makes the mock report a failed conversion. */
export const BROKEN_PDF_MARKER = '%%MOCK_BROKEN%%';

/** What the mock answers on `GET /version`, shaped like docling-serve's (incl. its `plaform` typo). */
export const MOCK_VERSIONS = {
    'docling-serve': '1.35.0',
    docling: '2.130.0',
    'docling-parse': '7.21.0',
    python: 'cpython-312 (3.12.10)',
    plaform: 'Mock-OS',
};

/** Polls until a task is done: 1st poll `pending`, 2nd `started`, 3rd and later the final status. */
export const POLLS_UNTIL_DONE = 3;

/** DoclingDocument schema version the mock claims to send. */
export const MOCK_SCHEMA_VERSION = '1.10.0';

/** Page size of every mock page in PDF points (A4). */
const PAGE_SIZE = { width: 595, height: 842 };

/** Height in points of one block's bounding box; blocks are stacked top-down. */
const BLOCK_HEIGHT = 40;

/** Form fields validated as booleans. */
const BOOLEAN_FIELDS = [
    'include_images',
    'include_page_images',
    'do_pdf_heading_hierarchy',
    'md_compact_tables',
    'do_table_structure',
    'do_formula_enrichment',
    'do_code_enrichment',
    'do_chart_extraction',
    'do_ocr',
    'force_ocr',
];

/** Form fields validated as enums, with docling-serve's allowed values. */
const ENUM_FIELDS: Record<string, string[]> = {
    from_formats: ['docx', 'pptx', 'html', 'image', 'pdf', 'md', 'csv', 'xlsx'],
    to_formats: ['md', 'json', 'yaml', 'html', 'html_split_page', 'text', 'doctags'],
    image_export_mode: ['placeholder', 'embedded', 'referenced'],
    table_mode: ['fast', 'accurate'],
    pipeline: ['legacy', 'standard', 'vlm', 'asr'],
    pdf_backend: ['pypdfium2', 'docling_parse', 'dlparse_v1', 'dlparse_v2', 'dlparse_v4'],
};

/** Matches task routes; group 1: `status/poll` or `result`, group 2: task id. */
const MATCH_TASK_ROUTE = /^\/v1\/(status\/poll|result)\/([^/]+)$/;

/** Matches an unsigned integer form value. */
const MATCH_INTEGER = /^\d+$/;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Fake docling-serve answering through `fetch`**.
 *
 * - routes: `/health`, `/version`, `/v1/convert/file`, `/v1/convert/file/async`, `/v1/status/poll/:id`, `/v1/result/:id`
 * - 401 without the configured api key (health and version stay open), 422 on invalid form fields
 * - an aborted request signal rejects like `fetch`; `failNext` answers take precedence over every route
 */
export function createMockDoclingServer(options: MockServerOptions = {}): MockDoclingServer {
    const requests: MockRequest[] = [];
    const answers: (Response | Error)[] = [];
    const tasks = new Map<string, MockTask>();

    return {
        requests,
        failNext(answer) {
            answers.push(answer);
        },
        fetch: mockFetch as typeof fetch,
    };

    /** Normalizes `fetch` arguments into a `Request`. */
    async function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        return handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
    }

    /** Records the request, then answers it like docling-serve. */
    async function handle(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        const form = request.method === 'POST' ? ((await request.formData()) as FormData) : undefined;
        requests.push({ method: request.method, path, headers: request.headers, ...(form ? { form } : {}) });
        if (request.signal.aborted) {
            throw request.signal.reason;
        }
        const answer = answers.shift();
        if (answer instanceof Error) {
            throw answer;
        }
        if (answer) {
            return answer;
        }
        if (request.method === 'GET' && path === '/health') {
            return Response.json({ status: 'ok' });
        }
        if (request.method === 'GET' && path === '/version') {
            return Response.json(MOCK_VERSIONS);
        }
        if (options.apiKey !== undefined && request.headers.get('X-Api-Key') !== options.apiKey) {
            return Response.json({ detail: 'Invalid API key' }, { status: 401 });
        }
        if (form && (path === '/v1/convert/file' || path === '/v1/convert/file/async')) {
            const invalid = validateForm(form);
            if (invalid.length > 0) {
                return Response.json({ detail: invalid }, { status: 422 });
            }
            const result = await convert(form);
            if (path === '/v1/convert/file') {
                return Response.json(result);
            }
            const task: MockTask = { id: `mock-task-${tasks.size + 1}`, polls: 0, result };
            tasks.set(task.id, task);
            return Response.json(taskStatus(task));
        }
        const [, route, id = ''] = MATCH_TASK_ROUTE.exec(path) ?? [];
        const task = tasks.get(id);
        if (request.method === 'GET' && route === 'status/poll' && task) {
            task.polls++;
            return Response.json(taskStatus(task));
        }
        if (request.method === 'GET' && route === 'result' && task) {
            return task.polls >= POLLS_UNTIL_DONE
                ? Response.json(task.result)
                : Response.json(
                      { detail: 'Task result not found. Please wait for a completion status.' },
                      { status: 404 },
                  );
        }
        return Response.json({ detail: route ? 'Task not found.' : 'Not Found' }, { status: 404 });
    }
}

/** Renders the md docling would return for this form; pages are joined like paragraphs. */
export function renderMockMarkdown(form: FormData): string {
    const style = readStyle(form);
    return selectPages(form)
        .flatMap(({ blocks }) => blocks.map((block) => renderBlock(block, style)))
        .join('\n\n');
}

/**
 * **The DoclingDocument docling returns with `to_formats=json`**.
 *
 * - headings become `section_header` texts, other text `text`; tables and pictures their own items
 * - every item hangs off `body` in reading order and points back with `parent`; `furniture` is empty
 * - picture `image` holds a PNG data URI only with embedded images, else `null`
 * - page `image` holds a PNG data URI of the page size × `images_scale` only with page images, else `null`
 * - `pages` and `prov.page_no` keep the absolute page numbers of a page range
 */
export function renderMockDocument(form: FormData): DoclingDocument {
    const style = readStyle(form);
    const doc: DoclingDocument = {
        schema_name: 'DoclingDocument',
        version: MOCK_SCHEMA_VERSION,
        name: 'document',
        origin: { mimetype: 'application/pdf', binary_hash: 1234567890, filename: 'document.pdf' },
        furniture: groupRoot('#/furniture', 'furniture'),
        body: groupRoot('#/body', 'body'),
        groups: [],
        texts: [],
        pictures: [],
        tables: [],
        key_value_items: [],
        form_items: [],
        pages: {},
    };
    for (const { pageNo, blocks } of selectPages(form)) {
        const image = style.pageImages ? pageImage(style.scale) : null;
        doc.pages[String(pageNo)] = { size: PAGE_SIZE, image, page_no: pageNo };
        blocks.forEach((block, position) => {
            doc.body.children.push(addItem(doc, block, provenance(pageNo, position, block), style));
        });
    }
    return doc;
}

// -------------------------------------------------------------------
// --- 4. Internal Functions
// -------------------------------------------------------------------

/** FastAPI-style validation of the fields this package sends. Unknown fields are ignored, like the real server. */
function validateForm(form: FormData): object[] {
    const errors: object[] = [];
    if (!(form.get('files') instanceof File)) {
        errors.push(fieldError('files', 'missing', 'Field required', null));
    }
    for (const name of BOOLEAN_FIELDS) {
        for (const value of form.getAll(name)) {
            if (value !== 'true' && value !== 'false') {
                errors.push(fieldError(name, 'bool_parsing', 'Input should be a valid boolean', value));
            }
        }
    }
    for (const [name, allowed] of Object.entries(ENUM_FIELDS)) {
        for (const value of form.getAll(name)) {
            if (typeof value !== 'string' || !allowed.includes(value)) {
                errors.push(
                    fieldError(name, 'enum', `Input should be ${allowed.map((v) => `'${v}'`).join(', ')}`, value),
                );
            }
        }
    }
    const pageRange = form.getAll('page_range');
    if (pageRange.length > 0 && (pageRange.length !== 2 || !pageRange.every((v) => MATCH_INTEGER.test(String(v))))) {
        errors.push(fieldError('page_range', 'value_error', 'Expected two page numbers', pageRange));
    }
    const scale = form.get('images_scale');
    if (scale !== null && !Number.isFinite(Number(scale))) {
        errors.push(fieldError('images_scale', 'float_parsing', 'Input should be a valid number', scale));
    }
    const timeout = form.get('document_timeout');
    if (timeout !== null && !Number.isFinite(Number(timeout))) {
        errors.push(fieldError('document_timeout', 'float_parsing', 'Input should be a valid number', timeout));
    }
    return errors;
}

/** Conversion result; only the requested `to_formats` are filled, a broken PDF fails with one error item. */
async function convert(form: FormData): Promise<ConvertResult> {
    const file = form.get('files') as File;
    const broken = (await file.text()).includes(BROKEN_PDF_MARKER);
    const formats = form.getAll('to_formats');
    return {
        document: {
            filename: file.name,
            md_content: broken || !formats.includes('md') ? null : renderMockMarkdown(form),
            json_content: broken || !formats.includes('json') ? null : renderMockDocument(form),
        },
        status: broken ? 'failure' : 'success',
        errors: broken
            ? [
                  {
                      component_type: 'document_backend',
                      module_name: 'mock',
                      error_message: 'Mock: input is not a valid PDF',
                  },
              ]
            : [],
        processing_time: 0.01,
        timings: {},
    };
}

/** Rendering choices of the form; docling sends picture data only with both image fields set. */
function readStyle(form: FormData): RenderStyle {
    return {
        hierarchy: form.get('do_pdf_heading_hierarchy') === 'true',
        compact: form.get('md_compact_tables') === 'true',
        embedded: form.get('image_export_mode') === 'embedded' && form.get('include_images') === 'true',
        pageImages: form.get('image_export_mode') === 'embedded' && form.get('include_page_images') === 'true',
        scale: Number(form.get('images_scale') ?? 2),
    };
}

/** Pages within `page_range` (1-based, inclusive), with their absolute page number. */
function selectPages(form: FormData): { pageNo: number; blocks: MockBlock[] }[] {
    const [from = 1, to = MOCK_PAGES.length] = form.getAll('page_range').map(Number);
    return MOCK_PAGES.slice(from - 1, to).map((blocks, index) => ({ pageNo: from + index, blocks }));
}

/** md of one block, escaped and laid out like docling's md export. */
function renderBlock(block: MockBlock, style: RenderStyle): string {
    switch (block.type) {
        case 'heading':
            // without hierarchy every heading is flat, like docling's level-1 section headers
            return `${'#'.repeat(style.hierarchy ? block.level : 2)} ${escapeMarkdown(block.text)}`;
        case 'text':
            return escapeMarkdown(block.text);
        case 'table':
            return renderTable(block.rows, style.compact);
        case 'picture':
            return style.embedded ? `![Image](${pictureUri(block.width, block.height)})` : '<!-- image -->';
    }
}

/** Escapes `&` as docling's md export does. */
function escapeMarkdown(text: string): string {
    return text.replaceAll('&', '&amp;');
}

/** Padded like docling's default, or minimal with `md_compact_tables`. */
function renderTable(rows: string[][], compact: boolean): string {
    const header = rows[0] ?? [];
    const widths = header.map((_, col) => (compact ? 0 : Math.max(...rows.map((row) => row[col]?.length ?? 0))));
    const lines = rows.map((row) => `| ${row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join(' | ')} |`);
    const separator = compact
        ? `| ${header.map(() => '-').join(' | ')} |`
        : `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
    lines.splice(1, 0, separator);
    return lines.join('\n');
}

/** PNG data URI of a picture with this pixel size. */
function pictureUri(width: number, height: number): string {
    return `data:image/png;base64,${toBase64(pngBytes(width, height))}`;
}

/** Page image like docling's: PNG of the page size × scale, at 72 × scale dpi. */
function pageImage(scale: number): NonNullable<DoclingDocument['pages'][string]['image']> {
    const size = { width: Math.round(PAGE_SIZE.width * scale), height: Math.round(PAGE_SIZE.height * scale) };
    return { mimetype: 'image/png', dpi: 72 * scale, size, uri: pictureUri(size.width, size.height) };
}

/** Root group of the document (`body` or `furniture`). */
function groupRoot(selfRef: string, layer: 'body' | 'furniture'): DoclingDocument['body'] {
    return {
        self_ref: selfRef,
        parent: null,
        children: [],
        content_layer: layer,
        meta: null,
        name: '_root_',
        label: 'unspecified',
    };
}

/** Bounding box stacked top-down by position, charspan over the block's text. */
function provenance(pageNo: number, position: number, block: MockBlock): ProvenanceItem {
    const top = PAGE_SIZE.height - 50 - position * BLOCK_HEIGHT;
    const length = block.type === 'heading' || block.type === 'text' ? block.text.length : 0;
    return {
        page_no: pageNo,
        bbox: { l: 50, t: top, r: PAGE_SIZE.width - 50, b: top - BLOCK_HEIGHT + 5, coord_origin: 'BOTTOMLEFT' },
        charspan: [0, length],
    };
}

/** Appends the block as a text, table or picture item under `body`; returns its ref. */
function addItem(doc: DoclingDocument, block: MockBlock, prov: ProvenanceItem, style: RenderStyle): RefItem {
    const parent = { $ref: '#/body' };
    const node = { parent, children: [], content_layer: 'body' as const, prov: [prov] };
    switch (block.type) {
        case 'heading':
        case 'text': {
            const selfRef = `#/texts/${doc.texts.length}`;
            const text = { ...node, self_ref: selfRef, meta: null, orig: block.text, text: block.text };
            const item: SectionHeaderItem | TextItem =
                block.type === 'heading'
                    ? {
                          ...text,
                          label: 'section_header',
                          level: style.hierarchy ? block.level : 1,
                          formatting: null,
                          hyperlink: null,
                      }
                    : { ...text, label: 'text', formatting: null, hyperlink: null };
            doc.texts.push(item);
            return { $ref: selfRef };
        }
        case 'table': {
            const selfRef = `#/tables/${doc.tables.length}`;
            const item: TableItem = {
                ...node,
                ...floatingFields(null),
                self_ref: selfRef,
                label: 'table',
                meta: null,
                data: tableData(block.rows),
                annotations: [],
            };
            doc.tables.push(item);
            return { $ref: selfRef };
        }
        case 'picture': {
            const selfRef = `#/pictures/${doc.pictures.length}`;
            const image = style.embedded
                ? {
                      mimetype: 'image/png',
                      dpi: 72,
                      size: { width: block.width, height: block.height },
                      uri: pictureUri(block.width, block.height),
                  }
                : null;
            const item: PictureItem = {
                ...node,
                ...floatingFields(image),
                self_ref: selfRef,
                label: 'picture',
                meta: null,
                annotations: [],
            };
            doc.pictures.push(item);
            return { $ref: selfRef };
        }
    }
}

/** Caption, reference and footnote lists (empty) with the item's image. */
function floatingFields(
    image: PictureItem['image'],
): Pick<PictureItem, 'captions' | 'references' | 'footnotes' | 'image'> {
    return { captions: [], references: [], footnotes: [], image };
}

/** Table cells and grid; the first row is the column header. */
function tableData(rows: string[][]): TableItem['data'] {
    const grid: TableCell[][] = rows.map((row, r) =>
        row.map((text, c) => ({
            bbox: null,
            row_span: 1,
            col_span: 1,
            start_row_offset_idx: r,
            end_row_offset_idx: r + 1,
            start_col_offset_idx: c,
            end_col_offset_idx: c + 1,
            text,
            column_header: r === 0,
            row_header: false,
            row_section: false,
            fillable: false,
        })),
    );
    return {
        table_cells: grid.flat(),
        num_rows: rows.length,
        num_cols: rows[0]?.length ?? 0,
        orientation: 'rot_0',
        grid,
    };
}

/** Task status body; a done failed task carries the first error message. */
function taskStatus(task: MockTask): object {
    const done = task.polls >= POLLS_UNTIL_DONE;
    const failed = task.result.status === 'failure';
    const status = done ? (failed ? 'failure' : 'success') : task.polls === 2 ? 'started' : 'pending';
    return {
        task_id: task.id,
        task_type: 'convert',
        task_status: status,
        task_position: status === 'pending' ? 1 : null,
        task_meta: null,
        ...(done && failed ? { error_message: task.result.errors[0]?.error_message } : {}),
    };
}

/** FastAPI validation error item for one form field. */
function fieldError(name: string, type: string, msg: string, input: unknown): object {
    return { type, loc: ['body', name], msg, input };
}

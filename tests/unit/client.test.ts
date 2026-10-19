// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/style/useNamingConvention: fixtures mirror docling-serve's snake_case JSON
import { describe, expect, spyOn, test } from 'bun:test';
import { createDoclingClient } from '../../src/client.js';
import type { DoclingDocument } from '../../src/document.js';
import type {
    ConvertError,
    ConvertedDocument,
    ConvertedMarkdown,
    DoclingClient,
    DoclingConfig,
    DocumentJob,
    Job,
    JobState,
    MarkdownJob,
    Result,
    TaskFailure,
} from '../../src/types.js';
import {
    BROKEN_PDF_MARKER,
    createMockDoclingServer,
    MOCK_SCHEMA_VERSION,
    MOCK_VERSIONS,
    type MockDoclingServer,
    type MockServerOptions,
    renderMockDocument,
    renderMockMarkdown,
} from '../mock/docling-server.js';
import { pngBytes, toBase64 } from '../mock/image-bytes.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** Base URL of the mock; `setup` appends a trailing `/` to check it is removed. */
const BASE_URL = 'http://docling:5001';

/** Link prefix for extracted images. */
const PREFIX = 'out/images/1234-';

/** Minimal bytes that pass the PDF header check. */
const PDF = new TextEncoder().encode('%PDF-1.7\n...');

/** Minimal PNG: signature and IHDR only. */
const PNG = pngBytes(300, 80);

/** PDF the mock reports as a failed conversion. */
const BROKEN_PDF = new TextEncoder().encode(`%PDF-1.7\n${BROKEN_PDF_MARKER}`);

/** Stored md job with placeholder images. */
const MD_JOB: MarkdownJob = { kind: 'markdown', id: 't-1', output: { images: 'placeholder' } };

/** Stored document job. */
const DOC_JOB: DocumentJob = { kind: 'document', id: 't-1' };

/** Server details of an error item that sent no fields besides the message. */
const NO_DETAILS = { component: null, module: null, category: null, page: null };

/** Error of a successful request whose response has no DoclingDocument. */
const NO_DOCUMENT: ConvertError = {
    code: 'invalid_response',
    message: 'Response has no DoclingDocument in json_content',
    versions: MOCK_VERSIONS,
};

/** Fields every request sends, independent of the output format. */
const DEFAULT_FIELDS = {
    from_formats: 'pdf',
    do_table_structure: 'true',
    table_mode: 'accurate',
    do_pdf_heading_hierarchy: 'true',
    do_formula_enrichment: 'true',
    code_formula_preset: 'codeformulav2',
    do_code_enrichment: 'false',
    do_chart_extraction: 'false',
    pipeline: 'standard',
    pdf_backend: 'docling_parse',
    do_ocr: 'true',
    force_ocr: 'false',
    include_page_images: 'false',
    images_scale: '2',
};

/** docling's md of the mock document with default options: heading hierarchy, compact tables, placeholders. */
const DEFAULT_MARKDOWN = [
    '# Mock Report',
    '<!-- image -->',
    '## 1 Introduction',
    'Research &amp; Development on page one.',
    '### 1.1 Details',
    '| Project | Budget |\n| - | - |\n| Alpha | 120 000 |',
    '<!-- image -->',
    'Text on page two.',
].join('\n\n');

/** Smallest DoclingDocument the client accepts. */
const MINIMAL_DOCUMENT = { schema_name: 'DoclingDocument', body: { children: [] } };

// -------------------------------------------------------------------
// --- 2. Helpers
// -------------------------------------------------------------------

/** Client over a fresh mock server; the base URL gets a trailing `/`. */
function setup(config: Omit<DoclingConfig, 'baseUrl'> = {}, serverOptions: MockServerOptions = {}) {
    const server = createMockDoclingServer(serverOptions);
    const client = createDoclingClient({ baseUrl: `${BASE_URL}/`, fetch: server.fetch, ...config });
    return { server, client };
}

/** Form of the last POST request. */
function lastForm(server: MockDoclingServer): FormData {
    return server.requests.findLast((request) => request.form)?.form ?? new FormData();
}

/** Form fields of the last POST request, without the file; repeated fields as lists. */
function sentFields(server: MockDoclingServer): Record<string, string | string[]> {
    const fields: Record<string, string | string[]> = {};
    const form = lastForm(server);
    for (const name of new Set(form.keys())) {
        const values = form.getAll(name).map(String);
        if (name !== 'files') {
            fields[name] = values.length === 1 ? (values[0] as string) : values;
        }
    }
    return fields;
}

/** Paths of every request, oldest first. */
function sentPaths(server: MockDoclingServer): string[] {
    return server.requests.map((request) => request.path);
}

/** Error of a failed result; `undefined` on success. */
function errorOf(res: Result<unknown>) {
    return res.ok ? undefined : res.error;
}

/** Data of a successful result. */
function dataOf<T>(res: Result<T>): T {
    if (!res.ok) {
        throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
    }
    return res.data;
}

/** Result of a `done` job state. */
function doneOf<T>(res: Result<JobState<T>>): { status: 'done' } & T {
    const state = dataOf(res);
    if (state.status !== 'done') {
        throw new Error(`Expected done, got ${state.status}`);
    }
    return state;
}

/** Sync conversion response with md content. */
function converted(md: string | null, status = 'success', errors: object[] = []): Response {
    return Response.json({ document: { filename: 'x.pdf', md_content: md }, status, errors, processing_time: 1 });
}

/** Sync conversion response with JSON content. */
function convertedJson(json: unknown, status = 'success', errors: object[] = []): Response {
    return Response.json({ document: { filename: 'x.pdf', json_content: json }, status, errors, processing_time: 1 });
}

/** Task status response for task `t-1`. */
function task(taskStatus: string, extra: object = {}): Response {
    return Response.json({
        task_id: 't-1',
        task_type: 'convert',
        task_status: taskStatus,
        task_position: null,
        ...extra,
    });
}

/** Polls until the job is no longer queued or running (the mock finishes on the third poll). */
async function checkUntilDone(client: DoclingClient, job: Job) {
    const states = [];
    for (let i = 0; i < 3; i++) {
        states.push(await client.check(job));
    }
    return states;
}

/** `fetch` that never answers conversion, poll and result requests, but rejects once their signal aborts. */
function hangExceptVersion(server: MockDoclingServer): typeof fetch {
    async function hang(url: string | URL | Request, init?: RequestInit) {
        if (String(url).endsWith('/version')) {
            return server.fetch(url, init);
        }
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
    }
    return hang as typeof fetch;
}

/** Item a `$ref` like `#/texts/0` points to. */
function resolveRef(doc: DoclingDocument, ref: string): unknown {
    const [, collection = '', index] = ref.split('/');
    const items = (doc as unknown as Record<string, unknown>)[collection];
    return index === undefined ? items : (items as unknown[])[Number(index)];
}

// -------------------------------------------------------------------
// --- 3. Tests
// -------------------------------------------------------------------

describe('createDoclingClient', () => {
    test('returns the five client functions for a valid config', () => {
        const { client } = setup({ apiKey: 'k', timeoutMs: 1000, options: { ocr: false, pageRange: [1, 2] } });
        expect(Object.keys(client).sort()).toEqual([
            'check',
            'convertDocument',
            'convertMarkdown',
            'submitDocument',
            'submitMarkdown',
        ]);
    });

    test('throws a TypeError naming the problem for an invalid config', () => {
        const invalid: [unknown, string][] = [
            [undefined, 'Invalid config: expected an object'],
            [{}, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'docling:5001' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: BASE_URL, timeoutMs: 0 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: BASE_URL, cleanMarkdown: true }, 'Option "cleanMarkdown" is not supported'],
            [{ baseUrl: BASE_URL, options: { images: 'none' } }, 'Option "images" is not supported'],
            [{ baseUrl: BASE_URL, options: { pageNumbers: true } }, 'Option "pageNumbers" is not supported'],
            [{ baseUrl: BASE_URL, options: { signal: AbortSignal.abort() } }, 'Option "signal" is not supported'],
        ];
        for (const [config, message] of invalid) {
            expect(() => createDoclingClient(config as DoclingConfig)).toThrow(new TypeError(message));
        }
    });
});

describe('request', () => {
    test('convertMarkdown sends md with compact tables, placeholders and every default explicitly', async () => {
        const { server, client } = setup();
        await client.convertMarkdown(PDF);
        const [request] = server.requests;
        expect([request?.method, request?.path]).toEqual(['POST', '/v1/convert/file']);
        expect(request?.headers.get('X-Api-Key')).toBeNull();
        const file = request?.form?.get('files') as File;
        expect(file.name).toBe('document.pdf');
        expect(file.type).toBe('application/pdf');
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
        expect(sentFields(server)).toEqual({
            ...DEFAULT_FIELDS,
            to_formats: 'md',
            md_compact_tables: 'true',
            include_images: 'false',
            image_export_mode: 'placeholder',
        });
    });

    test('convertDocument sends json with embedded images by default, without md fields', async () => {
        const { server, client } = setup();
        await client.convertDocument(PDF);
        expect(sentFields(server)).toEqual({
            ...DEFAULT_FIELDS,
            to_formats: 'json',
            include_images: 'true',
            image_export_mode: 'embedded',
        });
    });

    test('image modes map to image_export_mode and include_images', async () => {
        const { server, client } = setup();
        const cases: [() => Promise<unknown>, string, string][] = [
            [() => client.convertMarkdown(PDF, { images: 'none' }), 'placeholder', 'false'],
            [() => client.convertMarkdown(PDF, { images: 'placeholder' }), 'placeholder', 'false'],
            [
                () => client.convertMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }),
                'embedded',
                'true',
            ],
            [() => client.convertDocument(PDF, { images: 'embedded' }), 'embedded', 'true'],
            [() => client.convertDocument(PDF, { images: 'placeholder' }), 'placeholder', 'false'],
            [() => client.submitMarkdown(PDF, { images: 'none' }), 'placeholder', 'false'],
            [
                () => client.submitMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }),
                'embedded',
                'true',
            ],
            [() => client.submitDocument(PDF), 'embedded', 'true'],
            [() => client.submitDocument(PDF, { images: 'placeholder' }), 'placeholder', 'false'],
        ];
        for (const [call, mode, include] of cases) {
            await call();
            expect(sentFields(server)).toMatchObject({
                image_export_mode: mode,
                include_images: include,
                include_page_images: 'false',
            });
        }
    });

    test('pageImages switches on embedded export and include_page_images, independent of picture data', async () => {
        const { server, client } = setup();
        const cases: [() => Promise<unknown>, string][] = [
            [() => client.convertDocument(PDF, { pageImages: true }), 'true'],
            [() => client.convertDocument(PDF, { pageImages: true, images: 'placeholder' }), 'false'],
            [() => client.submitDocument(PDF, { pageImages: true, images: 'placeholder' }), 'false'],
        ];
        for (const [call, include] of cases) {
            await call();
            expect(sentFields(server)).toMatchObject({
                image_export_mode: 'embedded',
                include_images: include,
                include_page_images: 'true',
            });
        }
    });

    test('images_scale is always 2; imageScale is not supported', async () => {
        const { server, client } = setup();
        await client.convertDocument(PDF, { pageImages: true });
        expect(sentFields(server).images_scale).toBe('2');
        await client.submitMarkdown(PDF);
        expect(sentFields(server).images_scale).toBe('2');
        await expect(client.convertDocument(PDF, { imageScale: 1 } as never)).rejects.toThrow(
            new TypeError('Option "imageScale" is not supported'),
        );
        expect(() => createDoclingClient({ baseUrl: BASE_URL, options: { imageScale: 1 } as never })).toThrow(
            new TypeError('Option "imageScale" is not supported'),
        );
    });

    test('image input is sent as from_formats=image with a matching file name and MIME type', async () => {
        const { server, client } = setup({ options: { ocrLang: ['de'] } });
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        const cases: [Uint8Array, string, string][] = [
            [PNG, 'document.png', 'image/png'],
            [jpeg, 'document.jpg', 'image/jpeg'],
        ];
        for (const [bytes, name, type] of cases) {
            await client.convertMarkdown(bytes);
            const file = lastForm(server).get('files') as File;
            expect([file.name, file.type]).toEqual([name, type]);
            expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(bytes));
            expect(sentFields(server)).toMatchObject({ from_formats: 'image', do_ocr: 'true', force_ocr: 'false' });
            expect(sentFields(server).ocr_lang).toBe('de');
        }
        expect(dataOf(await client.convertDocument(PNG)).document.schema_name).toBe('DoclingDocument');
        expect(sentFields(server).from_formats).toBe('image');
    });

    test('image input always runs OCR, never full-page; the PDF settings of ocr and forceOcr are ignored', async () => {
        const { server, client } = setup({ options: { ocr: false, forceOcr: true } });
        await client.convertMarkdown(PNG);
        expect(sentFields(server)).toMatchObject({ from_formats: 'image', do_ocr: 'true', force_ocr: 'false' });
        await client.submitDocument(PNG, { ocr: false, forceOcr: true });
        expect(sentFields(server)).toMatchObject({ from_formats: 'image', do_ocr: 'true', force_ocr: 'false' });
        await client.convertDocument(PDF);
        expect(sentFields(server)).toMatchObject({ from_formats: 'pdf', do_ocr: 'false', force_ocr: 'true' });
    });

    test('submit functions post the same fields to the async endpoint', async () => {
        const { server, client } = setup();
        await client.submitMarkdown(PDF);
        expect(sentPaths(server).at(-1)).toBe('/v1/convert/file/async');
        expect(sentFields(server)).toMatchObject({ to_formats: 'md', md_compact_tables: 'true' });
        await client.submitDocument(PDF);
        expect(sentPaths(server).at(-1)).toBe('/v1/convert/file/async');
        expect(sentFields(server).to_formats).toBe('json');
        expect('md_compact_tables' in sentFields(server)).toBe(false);
    });

    test('factory options apply to every call; call options override them key by key', async () => {
        const { server, client } = setup({
            options: {
                ocr: false,
                pipeline: 'vlm',
                pdfBackend: 'pypdfium2',
                ocrLang: ['de', 'en'],
                pageRange: [2, 3],
                documentTimeout: 30,
            },
        });
        await client.convertMarkdown(PDF, {
            pipeline: 'standard',
            headingHierarchy: false,
            codeEnrichment: true,
            chartExtraction: true,
            forceOcr: true,
        });
        expect(sentFields(server)).toMatchObject({
            do_ocr: 'false',
            pipeline: 'standard',
            pdf_backend: 'pypdfium2',
            do_pdf_heading_hierarchy: 'false',
            do_formula_enrichment: 'true',
            do_code_enrichment: 'true',
            code_formula_preset: 'codeformulav2',
            do_chart_extraction: 'true',
            force_ocr: 'true',
            ocr_lang: ['de', 'en'],
            page_range: ['2', '3'],
            document_timeout: '30',
        });
        await client.convertDocument(PDF);
        expect(sentFields(server)).toMatchObject({
            do_ocr: 'false',
            pipeline: 'vlm',
            ocr_lang: ['de', 'en'],
            page_range: ['2', '3'],
            document_timeout: '30',
        });
    });

    test('ocrLang, pageRange and documentTimeout are factory-only: per call they reject before any request', async () => {
        const { server, client } = setup({ options: { ocrLang: ['fr'] } });
        const perCall: [Record<string, unknown>, string][] = [
            [{ ocrLang: ['de'] }, 'ocrLang'],
            [{ ocrLang: [] }, 'ocrLang'],
            [{ pageRange: [1, 1] }, 'pageRange'],
            [{ pageRange: undefined }, 'pageRange'],
            [{ documentTimeout: 60 }, 'documentTimeout'],
        ];
        for (const [options, name] of perCall) {
            const error = new TypeError(`Option "${name}" is not supported`);
            await expect(client.convertMarkdown(PDF, options as never)).rejects.toThrow(error);
            await expect(client.convertDocument(PDF, options as never)).rejects.toThrow(error);
            await expect(client.submitMarkdown(PDF, options as never)).rejects.toThrow(error);
            await expect(client.submitDocument(PDF, options as never)).rejects.toThrow(error);
        }
        expect(server.requests).toHaveLength(0);
        await client.convertMarkdown(PDF, { ocr: undefined } as never);
        expect(sentFields(server).ocr_lang).toBe('fr');
    });

    test('an empty factory ocrLang sends no ocr_lang field', async () => {
        const { server, client } = setup({ options: { ocrLang: [] } });
        await client.convertMarkdown(PDF);
        expect('ocr_lang' in sentFields(server)).toBe(false);
    });

    test('code_formula_preset is sent only with formula or code enrichment', async () => {
        const { server, client } = setup({ options: { formulaEnrichment: false } });
        await client.convertMarkdown(PDF);
        expect('code_formula_preset' in sentFields(server)).toBe(false);
        await client.convertDocument(PDF, { codeEnrichment: true });
        expect(sentFields(server).code_formula_preset).toBe('codeformulav2');
    });

    test('sends the api key on every request', async () => {
        const { server, client } = setup({ apiKey: 'secret' }, { apiKey: 'secret' });
        expect((await client.convertMarkdown(PDF)).ok).toBe(true);
        expect((await client.convertDocument(PDF)).ok).toBe(true);
        const job = dataOf(await client.submitDocument(PDF));
        expect((await client.check(job)).ok).toBe(true);
        expect(server.requests.map((request) => request.headers.get('X-Api-Key'))).toEqual(
            server.requests.map(() => 'secret'),
        );
        const unauthorized = await setup({}, { apiKey: 'secret' }).client.convertMarkdown(PDF);
        expect(errorOf(unauthorized)).toEqual({
            code: 'http',
            message: 'HTTP 401: Invalid API key',
            status: 401,
            versions: MOCK_VERSIONS,
        });
    });

    test('an aborted signal maps to aborted for every call', async () => {
        const { client } = setup();
        const signal = AbortSignal.abort();
        const results = [
            await client.convertMarkdown(PDF, { signal }),
            await client.convertDocument(PDF, { signal }),
            await client.submitMarkdown(PDF, { signal }),
            await client.submitDocument(PDF, { signal }),
            await client.check(MD_JOB, { signal }),
        ];
        expect(results.map((res) => errorOf(res)?.code)).toEqual(results.map(() => 'aborted'));
    });

    test('timeoutMs aborts requests that take too long, alone or combined with a caller signal', async () => {
        const server = createMockDoclingServer();
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: hangExceptVersion(server), timeoutMs: 50 });
        const signal = new AbortController().signal;
        const results = [
            await client.convertMarkdown(PDF),
            await client.convertDocument(PDF, { signal }),
            await client.submitMarkdown(PDF),
            await client.submitDocument(PDF),
            await client.check(DOC_JOB),
            await client.check(MD_JOB, { signal }),
        ];
        expect(results.map((res) => errorOf(res)?.code)).toEqual(results.map(() => 'aborted'));
    });

    test('invalid input resolves to invalid_input, without a request and without versions', async () => {
        const { server, client } = setup();
        const error: ConvertError = {
            code: 'invalid_input',
            message: 'Expected a non-empty PDF, PNG, JPEG, TIFF or WebP as Uint8Array',
        };
        const gif = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
        for (const bad of [new Uint8Array(), new TextEncoder().encode('hi'), gif, 'x' as unknown as Uint8Array]) {
            expect(errorOf(await client.convertMarkdown(bad))).toEqual(error);
            expect(errorOf(await client.convertDocument(bad))).toEqual(error);
            expect(errorOf(await client.submitMarkdown(bad))).toEqual(error);
            expect(errorOf(await client.submitDocument(bad))).toEqual(error);
        }
        expect(server.requests).toHaveLength(0);
    });

    test('invalid options reject with a TypeError before the PDF is checked and before any request', async () => {
        const { server, client } = setup();
        const markdown: [unknown, string][] = [
            ['all', 'Invalid options: expected an object'],
            [{ ocr: 'yes' }, 'Invalid value for option "ocr"'],
            [{ images: 'embedded' }, 'Invalid value for option "images"'],
            [{ images: 'extract' }, `Option "imageOptions" is required with images: 'extract'`],
            [{ images: 'extract', imageOptions: { omitSmall: false } }, 'Option "imageOptions.prefix" is required'],
            [{ images: 'extract', imageOptions: { prefix: 'a b' } }, 'Invalid value for option "imageOptions.prefix"'],
            [{ imageOptions: { prefix: PREFIX } }, `Option "imageOptions" is not supported without images: 'extract'`],
            [{ pageNumbers: true }, 'Option "pageNumbers" is not supported'],
            [{ repairs: false }, 'Option "repairs" is not supported'],
            [{ tableMode: 'fast' }, 'Option "tableMode" is not supported'],
            [{ pageImages: true }, 'Option "pageImages" is not supported'],
            [{ imageScale: 2 }, 'Option "imageScale" is not supported'],
        ];
        const document: [unknown, string][] = [
            [[], 'Invalid options: expected an object'],
            [{ images: 'extract' }, 'Invalid value for option "images"'],
            [{ images: 'none' }, 'Invalid value for option "images"'],
            [{ imageOptions: { prefix: PREFIX } }, 'Option "imageOptions" is not supported'],
            [{ pageRange: [3, 2] }, 'Option "pageRange" is not supported'],
            [{ pageImages: 'yes' }, 'Invalid value for option "pageImages"'],
            [{ imageScale: 2 }, 'Option "imageScale" is not supported'],
        ];
        for (const [options, message] of markdown) {
            await expect(client.convertMarkdown(PDF, options as never)).rejects.toThrow(new TypeError(message));
            await expect(client.submitMarkdown(new Uint8Array(), options as never)).rejects.toThrow(
                new TypeError(message),
            );
        }
        for (const [options, message] of document) {
            await expect(client.convertDocument(PDF, options as never)).rejects.toThrow(new TypeError(message));
            await expect(client.submitDocument(new Uint8Array(), options as never)).rejects.toThrow(
                new TypeError(message),
            );
        }
        expect(server.requests).toHaveLength(0);
    });

    test('a truncated PDF is rejected without a request; a complete one is sent', async () => {
        const { server, client } = setup();
        const truncated = new TextEncoder().encode('%PDF-1.7\n1 0 obj\nstartxref\n9000\n%%EOF\n');
        const error: ConvertError = {
            code: 'invalid_input',
            message: `PDF is truncated: cross-reference offset 9000 lies past the end of the file (${truncated.length} bytes)`,
        };
        expect(errorOf(await client.convertMarkdown(truncated))).toEqual(error);
        expect(errorOf(await client.convertDocument(truncated))).toEqual(error);
        expect(errorOf(await client.submitMarkdown(truncated))).toEqual(error);
        expect(errorOf(await client.submitDocument(truncated))).toEqual(error);
        expect(server.requests).toHaveLength(0);
        const complete = new TextEncoder().encode('%PDF-1.7\nxref\nstartxref\n9\n%%EOF\n');
        expect((await client.convertMarkdown(complete)).ok).toBe(true);
    });
});

describe('convertMarkdown', () => {
    test("returns docling's md unchanged, with placeholders by default", async () => {
        const { server, client } = setup();
        const res = await client.convertMarkdown(PDF);
        expect(res).toEqual({
            ok: true,
            data: { markdown: DEFAULT_MARKDOWN, images: [], warnings: [], versions: MOCK_VERSIONS },
        });
        expect(dataOf(res).markdown).toBe(renderMockMarkdown(lastForm(server)));
    });

    test('headingHierarchy: false and pageRange reach the server', async () => {
        const { client } = setup();
        const flat = dataOf(await client.convertMarkdown(PDF, { headingHierarchy: false }));
        expect(flat.markdown).toContain('## Mock Report\n\n');
        expect(flat.markdown).toContain('## 1.1 Details\n\n');
        const secondPage = dataOf(await setup({ options: { pageRange: [2, 2] } }).client.convertMarkdown(PDF));
        expect(secondPage.markdown).toStartWith('### 1.1 Details\n\n');
        expect(secondPage.markdown).not.toContain('Mock Report');
    });

    test("images: 'none' removes the placeholders with their blank line", async () => {
        const { client } = setup();
        const res = dataOf(await client.convertMarkdown(PDF, { images: 'none' }));
        expect(res.markdown).toBe(DEFAULT_MARKDOWN.replaceAll('<!-- image -->\n\n', ''));
        expect(res.images).toEqual([]);
    });

    test("images: 'extract' returns the bytes and links them under the prefix", async () => {
        const { client } = setup();
        const res = dataOf(
            await client.convertMarkdown(PDF, {
                images: 'extract',
                imageOptions: { prefix: PREFIX, omitSmall: false },
            }),
        );
        expect(res.markdown).toBe(
            DEFAULT_MARKDOWN.replace('<!-- image -->', '![Image](out/images/1234-1.png)').replace(
                '<!-- image -->',
                '![Image](out/images/1234-2.png)',
            ),
        );
        expect(res.images.map(({ path, mimeType, width, height }) => ({ path, mimeType, width, height }))).toEqual([
            { path: 'out/images/1234-1.png', mimeType: 'image/png', width: 88, height: 32 },
            { path: 'out/images/1234-2.png', mimeType: 'image/png', width: 400, height: 300 },
        ]);
        expect(res.images[1]?.bytes).toEqual(pngBytes(400, 300));
        expect(res.warnings).toEqual([]);
    });

    test("images: 'extract' drops the small badge entirely by default (omitSmall)", async () => {
        const { client } = setup();
        const res = dataOf(await client.convertMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }));
        expect(res.markdown).toBe(
            DEFAULT_MARKDOWN.replace('<!-- image -->\n\n', '').replace(
                '<!-- image -->',
                '![Image](out/images/1234-1.png)',
            ),
        );
        expect(res.images.map((image) => [image.path, image.width, image.height])).toEqual([
            ['out/images/1234-1.png', 400, 300],
        ]);
    });

    test("images: 'extract' keeps docling's placeholders for pictures sent without data", async () => {
        const { server, client } = setup();
        const md = `a\n\n<!-- image -->\n\n![Image](data:image/png;base64,${toBase64(pngBytes(400, 300))})\n\nb`;
        server.failNext(converted(md));
        const res = dataOf(await client.convertMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }));
        expect(res.markdown).toBe('a\n\n<!-- image -->\n\n![Image](out/images/1234-1.png)\n\nb');
        expect(res.warnings).toEqual([]);
    });

    test('broken embedded image data is removed with an image_not_decoded warning after server warnings', async () => {
        const { server, client } = setup();
        const good = toBase64(pngBytes(400, 300));
        const md = `text\n\n![Image](data:image/png;base64,a=b)\n\n![Chart](data:image/png;base64,${good})`;
        server.failNext(converted(md, 'partial_success', [{ error_message: 'Page 2 failed to parse.' }]));
        const res = await client.convertMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } });
        expect(res).toEqual({
            ok: true,
            data: {
                markdown: 'text\n\n![Chart](out/images/1234-1.png)',
                images: [
                    {
                        path: 'out/images/1234-1.png',
                        mimeType: 'image/png',
                        bytes: pngBytes(400, 300),
                        width: 400,
                        height: 300,
                    },
                ],
                warnings: [
                    {
                        code: 'server',
                        message: 'Page 2 failed to parse.',
                        details: { ...NO_DETAILS, page: 3 },
                    },
                    {
                        code: 'image_not_decoded',
                        message: 'Embedded image 1 has invalid or empty base64 data and was removed',
                        details: { index: 1 },
                    },
                ],
                versions: MOCK_VERSIONS,
            },
        });
    });

    test('placeholder and none modes leave embedded data URIs as docling sent them', async () => {
        const { server, client } = setup();
        const md = '![Image](data:image/png;base64,a=b)\n\n<!-- image -->\n\nend';
        server.failNext(converted(md));
        expect(dataOf(await client.convertMarkdown(PDF)).markdown).toBe(md);
        server.failNext(converted(md));
        expect(dataOf(await client.convertMarkdown(PDF, { images: 'none' })).markdown).toBe(
            '![Image](data:image/png;base64,a=b)\n\nend',
        );
    });

    test('partial success returns md with server warnings', async () => {
        const { server, client } = setup();
        server.failNext(converted('text', 'partial_success', [{ error_message: 'page 3 failed' }, {}]));
        expect(await client.convertMarkdown(PDF)).toEqual({
            ok: true,
            data: {
                markdown: 'text',
                images: [],
                warnings: [{ code: 'server', message: 'page 3 failed', details: NO_DETAILS }],
                versions: MOCK_VERSIONS,
            },
        });
    });

    test('server warnings carry the error item fields and the 1-based PDF page', async () => {
        const { server, client } = setup();
        const errors = [
            // older docling: 0-based page index in the message
            {
                error_message: 'Page 1 failed to parse.',
                component_type: 'document_backend',
                module_name: 'DoclingParseV4PageBackend',
            },
            // newer docling: structured 1-based page_no and category
            {
                error_message: 'Page failed to parse.',
                component_type: 'document_backend',
                module_name: 'DoclingParseV4PageBackend',
                category: 'backend_failure',
                page_no: 5,
            },
            { error_message: 'Page 1 failed to parse.', page_no: 'x', category: 7, component_type: '' },
            // page_no below 1 or fractional: page from the message, else null
            { error_message: 'Page 3 failed to parse.', page_no: 0 },
            { error_message: 'Page failed to parse.', page_no: -1 },
            { error_message: 'Page failed to parse.', page_no: 2.5 },
        ];
        server.failNext(converted('text', 'partial_success', errors));
        const res = dataOf(await client.convertMarkdown(PDF));
        expect(res.warnings.flatMap((w) => (w.code === 'server' ? [w.details] : []))).toEqual([
            { component: 'document_backend', module: 'DoclingParseV4PageBackend', category: null, page: 2 },
            {
                component: 'document_backend',
                module: 'DoclingParseV4PageBackend',
                category: 'backend_failure',
                page: 5,
            },
            { ...NO_DETAILS, page: 2 },
            { ...NO_DETAILS, page: 4 },
            NO_DETAILS,
            NO_DETAILS,
        ]);
    });

    test('malformed error items and failure fields never throw', async () => {
        const { server, client } = setup();
        const bodies = [
            { status: 'success', document: { md_content: 'x' }, errors: {} },
            { status: 'success', document: { md_content: 'x' }, errors: 'x' },
            { status: 'success', document: { md_content: 'x' }, errors: [null, 'x', 5, { error_message: 5 }] },
            { status: 'success', document: { md_content: 'x' }, errors: [{ error_message: '' }] },
        ];
        for (const body of bodies) {
            server.failNext(Response.json(body));
            expect(await client.convertMarkdown(PDF)).toEqual({
                ok: true,
                data: { markdown: 'x', images: [], warnings: [], versions: MOCK_VERSIONS },
            });
        }
        server.failNext(Response.json({ status: 'failure', errors: [null], failure: { message: 1 } }));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (status: failure)');
    });

    test('a failed conversion maps to conversion_failed with the reason and the error items', async () => {
        const { client } = setup();
        expect(errorOf(await client.convertMarkdown(BROKEN_PDF))).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (Mock: input is not a valid PDF)',
            details: {
                errors: [
                    {
                        message: 'Mock: input is not a valid PDF',
                        details: { component: 'document_backend', module: 'mock', category: null, page: null },
                    },
                ],
                failure: null,
            },
            versions: MOCK_VERSIONS,
        });
    });

    test('failure reasons: joined error messages, failure message, bare status', async () => {
        const { server, client } = setup();
        server.failNext(converted(null, 'failure', [{ error_message: 'a' }, { error_message: 'b' }]));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (a; b)');
        server.failNext(converted(null, 'failure'));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (status: failure)');
        server.failNext(converted('x', 'skipped'));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (status: skipped)');
        const failure = { message: 'capacity', category: 'capacity', phase: 'admission', retryable: true };
        server.failNext(Response.json({ failure }));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (capacity)',
            details: { errors: [], failure: { category: 'capacity', phase: 'admission', retryable: true } },
            versions: MOCK_VERSIONS,
        });
    });

    test('responses without status or md_content are invalid_response', async () => {
        const { server, client } = setup();
        const noStatus = [
            null,
            'x',
            {},
            { failure: null },
            { status: null },
            { status: 500 },
            { status: '' },
            { status: true },
        ];
        for (const body of noStatus) {
            server.failNext(Response.json(body));
            expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
                code: 'invalid_response',
                message: 'Unexpected response: no conversion status',
                versions: MOCK_VERSIONS,
            });
        }
        server.failNext(Response.json({ status: null, failure: { message: 'worker lost' } }));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (worker lost)');
        const noMarkdown = [
            converted(null),
            Response.json({ status: 'success' }),
            Response.json({ status: 'success', document: null }),
            Response.json({ status: 'success', document: ['x'] }),
            Response.json({ status: 'success', document: { md_content: 5 } }),
        ];
        for (const answer of noMarkdown) {
            server.failNext(answer);
            expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
                code: 'invalid_response',
                message: 'Response has no md_content',
                versions: MOCK_VERSIONS,
            });
        }
    });

    test('a successful status without content but with server details is conversion_failed with all details', async () => {
        const { server, client } = setup();
        server.failNext(converted(null, 'partial_success', [{ error_message: 'Page 1 failed to parse.' }]));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (Page 1 failed to parse.)',
            details: {
                errors: [{ message: 'Page 1 failed to parse.', details: { ...NO_DETAILS, page: 2 } }],
                failure: null,
            },
            versions: MOCK_VERSIONS,
        });
        server.failNext(Response.json({ status: 'partial_success', document: { md_content: null } }));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (status: partial_success, no md_content)',
            details: { errors: [], failure: null },
            versions: MOCK_VERSIONS,
        });
        const failure = { message: 'OCR out of memory', category: 'capacity', phase: 'execution', retryable: true };
        server.failNext(Response.json({ status: 'success', document: {}, failure }));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (OCR out of memory)',
            details: { errors: [], failure: { category: 'capacity', phase: 'execution', retryable: true } },
            versions: MOCK_VERSIONS,
        });
        server.failNext(convertedJson(null, 'partial_success', [{ error_message: 'Layout failed.' }]));
        expect(errorOf(await client.convertDocument(PDF))).toMatchObject({
            code: 'conversion_failed',
            message: 'Conversion failed (Layout failed.)',
            details: { errors: [{ message: 'Layout failed.' }], failure: null },
        });
        server.failNext(convertedJson({}, 'partial_success', [{ error_message: 'Layout failed.' }]));
        expect(errorOf(await client.convertDocument(PDF))).toEqual({
            code: 'invalid_response',
            message: 'Response has no DoclingDocument in json_content',
            versions: MOCK_VERSIONS,
        });
        server.failNext(convertedJson(null));
        expect(errorOf(await client.convertDocument(PDF))?.code).toBe('invalid_response');
        server.failNext(task('partial_success'));
        server.failNext(converted(null, 'partial_success', [{ error_message: 'Page 1 failed to parse.' }]));
        expect(errorOf(await client.check(MD_JOB))?.code).toBe('conversion_failed');
    });

    test('an empty md is a valid result', async () => {
        const { server, client } = setup();
        server.failNext(converted(''));
        expect(dataOf(await client.convertMarkdown(PDF)).markdown).toBe('');
    });

    test('passes through http, invalid JSON and network errors', async () => {
        const { server, client } = setup();
        server.failNext(Response.json({ detail: 'x' }, { status: 504 }));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'http',
            message: 'HTTP 504: x',
            status: 504,
            versions: MOCK_VERSIONS,
        });
        server.failNext(new Response('<html>'));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'invalid_response',
            message: 'Response body is not valid JSON: <html>',
            status: 200,
            versions: MOCK_VERSIONS,
        });
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({ code: 'network', message: 'refused' });
    });

    test('docling rejecting a field answers http 422 with the field errors', async () => {
        const { server, client } = setup();
        server.failNext(Response.json({ detail: [{ loc: ['body', 'pipeline'], msg: 'bad' }] }, { status: 422 }));
        const error = errorOf(await client.convertMarkdown(PDF));
        expect(error?.code).toBe('http');
        expect(error?.status).toBe(422);
        expect(error?.message).toBe('HTTP 422: [{"loc":["body","pipeline"],"msg":"bad"}]');
    });
});

describe('convertDocument', () => {
    test('returns the DoclingDocument as sent, with embedded picture data by default', async () => {
        const { server, client } = setup();
        const res = dataOf(await client.convertDocument(PDF));
        expect(res).toEqual({
            document: renderMockDocument(lastForm(server)),
            pageImages: [],
            warnings: [],
            versions: MOCK_VERSIONS,
        });
        expect(res.document.schema_name).toBe('DoclingDocument');
        expect(res.document.version).toBe(MOCK_SCHEMA_VERSION);
        expect(res.document.pictures.map((picture) => picture.image?.uri.slice(0, 22))).toEqual([
            'data:image/png;base64,',
            'data:image/png;base64,',
        ]);
        expect(res.document.pictures.map((picture) => picture.image?.size)).toEqual([
            { width: 88, height: 32 },
            { width: 400, height: 300 },
        ]);
    });

    test("images: 'placeholder' keeps the picture items without image data", async () => {
        const { client } = setup();
        const res = dataOf(await client.convertDocument(PDF, { images: 'placeholder' }));
        expect(res.document.pictures).toHaveLength(2);
        expect(res.document.pictures.map((picture) => [picture.self_ref, picture.image])).toEqual([
            ['#/pictures/0', null],
            ['#/pictures/1', null],
        ]);
    });

    test('pageImages: true moves the page images out of the document, in page order', async () => {
        const { server, client } = setup();
        const res = dataOf(await client.convertDocument(PDF, { pageImages: true }));
        const sent = renderMockDocument(lastForm(server));
        const sentUris = Object.values(sent.pages).map((page) => page.image?.uri.slice(0, 22));
        expect(sentUris).toEqual(['data:image/png;base64,', 'data:image/png;base64,']);
        const stripped = Object.fromEntries(
            Object.entries(sent.pages).map(([key, page]) => [key, { ...page, image: null }]),
        );
        expect(res.document).toEqual({ ...sent, pages: stripped });
        expect(res.pageImages).toEqual([
            { page: 1, mimeType: 'image/png', width: 1190, height: 1684, dpi: 144, bytes: pngBytes(1190, 1684) },
            { page: 2, mimeType: 'image/png', width: 1190, height: 1684, dpi: 144, bytes: pngBytes(1190, 1684) },
        ]);
        expect(res.warnings).toEqual([]);
        const ranged = setup({ options: { pageRange: [2, 2] } }).client;
        const range = dataOf(await ranged.convertDocument(PDF, { pageImages: true }));
        expect(range.pageImages.map(({ page, width, height, dpi }) => [page, width, height, dpi])).toEqual([
            [2, 1190, 1684, 144],
        ]);
    });

    test('undecodable page images stay in the document and are reported after server warnings', async () => {
        const { server, client } = setup();
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        const size = { width: 10, height: 10 };
        /** Page with a JPEG image ref of the given URI. */
        function page(pageNo: number, uri: string) {
            return {
                size,
                page_no: pageNo,
                image: { mimetype: 'image/jpeg', dpi: 144, size: { width: 20, height: 30 }, uri },
            };
        }
        const pages = {
            '3': page(3, 'file:///page3.png'),
            '1': page(1, `data:image/jpeg;base64,${toBase64(jpeg)}`),
            '2': page(2, 'data:image/png;base64,'),
            '4': { size, page_no: 4, image: null },
            '5': { size, page_no: 5, image: 'not an image ref' },
        };
        server.failNext(
            convertedJson({ ...MINIMAL_DOCUMENT, pages }, 'partial_success', [{ error_message: 'Page 4 failed.' }]),
        );
        const res = dataOf(await client.convertDocument(PDF, { pageImages: true }));
        expect(res.pageImages).toEqual([
            { page: 1, mimeType: 'image/jpeg', width: 20, height: 30, dpi: 144, bytes: jpeg },
        ]);
        expect(res.document.pages).toEqual({ ...pages, '1': { ...pages['1'], image: null } } as never);
        expect(res.warnings.map((warning) => [warning.code, warning.details.page])).toEqual([
            ['server', null],
            ['page_image_not_decoded', 2],
            ['page_image_not_decoded', 3],
            ['page_image_not_decoded', 5],
        ]);
        expect(res.warnings[2]?.message).toBe(
            'Page image of page 3 is not a base64 image data URI or has invalid or empty data',
        );
    });

    test('docling options shape the document: flat headings and a page range with absolute page numbers', async () => {
        const { client } = setup({ options: { pageRange: [2, 2] } });
        const res = dataOf(await client.convertDocument(PDF, { headingHierarchy: false }));
        expect(Object.keys(res.document.pages)).toEqual(['2']);
        expect(res.document.texts.map((text) => [text.label, text.text, text.prov[0]?.page_no])).toEqual([
            ['section_header', '1.1 Details', 2],
            ['text', 'Text on page two.', 2],
        ]);
        expect(res.document.texts[0]).toMatchObject({ level: 1 });
    });

    test('everything besides schema_name and body is passed on unchecked', async () => {
        const { server, client } = setup();
        const json = { ...MINIMAL_DOCUMENT, version: '9.9.9', extra: { kept: true } };
        server.failNext(convertedJson(json));
        expect(dataOf(await client.convertDocument(PDF)).document).toEqual(json as unknown as DoclingDocument);
    });

    test('partial success returns the document with server warnings', async () => {
        const { server, client } = setup();
        server.failNext(
            convertedJson(MINIMAL_DOCUMENT, 'partial_success', [
                { error_message: 'Page failed to parse.', page_no: 2, category: 'backend_failure' },
            ]),
        );
        expect(dataOf(await client.convertDocument(PDF)).warnings).toEqual([
            {
                code: 'server',
                message: 'Page failed to parse.',
                details: { ...NO_DETAILS, category: 'backend_failure', page: 2 },
            },
        ]);
    });

    test('a failed conversion maps to conversion_failed', async () => {
        const { client } = setup();
        const error = errorOf(await client.convertDocument(BROKEN_PDF));
        expect(error).toMatchObject({
            code: 'conversion_failed',
            message: 'Conversion failed (Mock: input is not a valid PDF)',
            versions: MOCK_VERSIONS,
        });
    });

    test('a missing or invalid json_content is invalid_response', async () => {
        const { server, client } = setup();
        const answers = [
            convertedJson(null),
            convertedJson('x'),
            convertedJson([MINIMAL_DOCUMENT]),
            convertedJson({ ...MINIMAL_DOCUMENT, schema_name: 'Other' }),
            convertedJson({ schema_name: 'DoclingDocument' }),
            convertedJson({ schema_name: 'DoclingDocument', body: [] }),
            convertedJson({ schema_name: 'DoclingDocument', body: null }),
            converted('# md only'),
            Response.json({ status: 'success', document: null }),
        ];
        for (const answer of answers) {
            server.failNext(answer);
            expect(errorOf(await client.convertDocument(PDF))).toEqual(NO_DOCUMENT);
        }
        server.failNext(Response.json({}));
        expect(errorOf(await client.convertDocument(PDF))?.code).toBe('invalid_response');
    });

    test('passes through http and network errors', async () => {
        const { server, client } = setup();
        server.failNext(new Response('', { status: 503 }));
        expect(errorOf(await client.convertDocument(PDF))).toEqual({
            code: 'http',
            message: 'HTTP 503: no response body',
            status: 503,
            versions: MOCK_VERSIONS,
        });
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.convertDocument(PDF))).toEqual({ code: 'network', message: 'refused' });
    });
});

describe('versions', () => {
    test('results carry the server versions; non-string values are dropped', async () => {
        const { server, client } = setup();
        server.failNext(converted('x'));
        server.failNext(Response.json({ docling: '2.130.0', 'docling-parse': 7, extra: null }));
        const res = await client.convertMarkdown(PDF);
        expect(dataOf(res).versions).toEqual({ docling: '2.130.0' });
        expect(sentPaths(server)).toEqual(['/v1/convert/file', '/version']);
    });

    test('a missing or broken version endpoint gives null, the conversion still succeeds', async () => {
        const { server, client } = setup();
        const answers = [
            new Response('', { status: 404 }),
            Response.json({ docling: 2 }),
            Response.json('x'),
            Response.json(null),
            new Response('<html>'),
        ];
        for (const answer of answers) {
            server.failNext(converted('x'));
            server.failNext(answer);
            expect(dataOf(await client.convertMarkdown(PDF)).versions).toBeNull();
        }
        server.failNext(convertedJson(MINIMAL_DOCUMENT));
        server.failNext(new TypeError('refused'));
        expect(dataOf(await client.convertDocument(PDF)).versions).toBeNull();
    });

    test('versions are fetched once per client and shared by concurrent results', async () => {
        const { server, client } = setup();
        const results = await Promise.all([client.convertMarkdown(PDF), client.convertDocument(PDF)]);
        await client.convertMarkdown(PDF);
        expect(results.map((res) => (res.ok ? res.data.versions : undefined))).toEqual([MOCK_VERSIONS, MOCK_VERSIONS]);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(1);
        const other = createDoclingClient({ baseUrl: BASE_URL, fetch: server.fetch });
        await other.convertMarkdown(PDF);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(2);
    });

    test('a failed version request is not cached; the next result asks again', async () => {
        const { server, client } = setup();
        server.failNext(converted('x'));
        server.failNext(new Response('', { status: 503 }));
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toBeNull();
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toEqual(MOCK_VERSIONS);
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toEqual(MOCK_VERSIONS);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(2);
    });

    test('a hanging version endpoint gives null after 2 s, the conversion still succeeds', async () => {
        const server = createMockDoclingServer();
        async function hangOnVersion(url: string | URL | Request, init?: RequestInit) {
            return String(url).endsWith('/version') ? new Promise<Response>(() => {}) : server.fetch(url, init);
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: hangOnVersion as typeof fetch, timeoutMs: 50 });
        const started = performance.now();
        const res = await client.convertMarkdown(PDF);
        const elapsed = performance.now() - started;
        expect(dataOf(res).versions).toBeNull();
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThan(2500);
    });

    test('aborting the caller signal after the conversion does not affect the version request', async () => {
        const server = createMockDoclingServer();
        const controller = new AbortController();
        async function abortAfterConversion(url: string | URL | Request, init?: RequestInit) {
            const res = await server.fetch(url, init);
            if (String(url).endsWith('/v1/convert/file')) {
                controller.abort();
            }
            return res;
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: abortAfterConversion as typeof fetch });
        const res = await client.convertMarkdown(PDF, { signal: controller.signal });
        expect(dataOf(res).versions).toEqual(MOCK_VERSIONS);
        expect(sentPaths(server)).toEqual(['/v1/convert/file', '/version']);
    });

    test('errors get versions only when the server answered the request', async () => {
        const { server, client } = setup();
        server.failNext(new TypeError('refused'));
        const network = errorOf(await client.convertMarkdown(PDF));
        expect(network?.code).toBe('network');
        expect(network && 'versions' in network).toBe(false);
        const aborted = errorOf(await client.convertDocument(PDF, { signal: AbortSignal.abort() }));
        expect(aborted && 'versions' in aborted).toBe(false);
        const invalid = errorOf(await client.convertMarkdown(new Uint8Array()));
        expect(invalid && 'versions' in invalid).toBe(false);
        const badJob = errorOf(await client.check({ kind: 'document', id: 'a/b' }));
        expect(badJob && 'versions' in badJob).toBe(false);
        expect(sentPaths(server)).not.toContain('/version');
        server.failNext(Response.json({ detail: 'x' }, { status: 500 }));
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.convertMarkdown(PDF))).toEqual({
            code: 'http',
            message: 'HTTP 500: x',
            status: 500,
            versions: null,
        });
    });
});

describe('submit + check', () => {
    test('submitMarkdown returns a markdown job; check walks queued -> running -> done', async () => {
        const { server, client } = setup();
        const job = await client.submitMarkdown(PDF, {
            images: 'extract',
            imageOptions: { prefix: PREFIX, omitSmall: false },
        });
        expect(sentPaths(server)).toEqual(['/v1/convert/file/async']);
        expect(job).toEqual({
            ok: true,
            data: {
                kind: 'markdown',
                id: 'mock-task-1',
                output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } },
            },
        });
        const stored: MarkdownJob = JSON.parse(JSON.stringify(dataOf(job)));
        const [queued, running, done] = await checkUntilDone(client, stored);
        expect(queued).toEqual({ ok: true, data: { status: 'queued', position: 1 } });
        expect(running).toEqual({ ok: true, data: { status: 'running' } });
        const result = doneOf(done as Result<JobState<ConvertedMarkdown>>);
        expect(result.images.map((image) => image.path)).toEqual(['out/images/1234-1.png', 'out/images/1234-2.png']);
        expect(result.markdown).toContain('Research &amp; Development');
        expect(result.warnings).toEqual([]);
        expect(result.versions).toEqual(MOCK_VERSIONS);
        expect(sentPaths(server).slice(-3)).toEqual([
            '/v1/status/poll/mock-task-1',
            '/v1/result/mock-task-1',
            '/version',
        ]);
    });

    test('the markdown job keeps the resolved image options; omitSmall defaults to true', async () => {
        const { client } = setup();
        const job = dataOf(await client.submitMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }));
        expect(job.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } });
        expect(dataOf(await client.submitMarkdown(PDF)).output).toEqual({ images: 'placeholder' });
    });

    test('check applies the image handling stored in the job', async () => {
        const { client } = setup();
        const job = dataOf(await client.submitMarkdown(PDF, { images: 'none' }));
        const done = (await checkUntilDone(client, job)).at(-1) as Result<JobState<ConvertedMarkdown>>;
        expect(doneOf(done)).toEqual({
            status: 'done',
            markdown: DEFAULT_MARKDOWN.replaceAll('<!-- image -->\n\n', ''),
            images: [],
            warnings: [],
            versions: MOCK_VERSIONS,
        });
    });

    test('submitDocument returns a document job; check returns the document when done', async () => {
        const { server, client } = setup();
        const job = await client.submitDocument(PDF, { images: 'placeholder' });
        expect(job).toEqual({ ok: true, data: { kind: 'document', id: 'mock-task-1' } });
        const form = lastForm(server);
        const states = await checkUntilDone(client, dataOf(job));
        expect(states.slice(0, 2).map((state) => dataOf(state).status)).toEqual(['queued', 'running']);
        const done = doneOf(states[2] as Result<JobState<ConvertedDocument>>);
        expect(done).toEqual({
            status: 'done',
            document: renderMockDocument(form),
            pageImages: [],
            warnings: [],
            versions: MOCK_VERSIONS,
        });
        expect(done.document.pictures.every((picture) => picture.image === null)).toBe(true);
    });

    test('check returns the page images of a document job submitted with pageImages', async () => {
        const { client } = setup();
        const job = dataOf(await client.submitDocument(PDF, { pageImages: true, images: 'placeholder' }));
        expect(job).toEqual({ kind: 'document', id: 'mock-task-1' });
        const done = doneOf((await checkUntilDone(client, job))[2] as Result<JobState<ConvertedDocument>>);
        expect(done.pageImages.map(({ page, width, height }) => [page, width, height])).toEqual([
            [1, 1190, 1684],
            [2, 1190, 1684],
        ]);
        expect(Object.values(done.document.pages).every((item) => item.image === null)).toBe(true);
    });

    test('a done document task without a DoclingDocument is invalid_response', async () => {
        const { server, client } = setup();
        server.failNext(task('success'));
        server.failNext(converted('# md'));
        expect(errorOf(await client.check(DOC_JOB))).toEqual(NO_DOCUMENT);
        server.failNext(task('partial_success'));
        server.failNext(convertedJson(MINIMAL_DOCUMENT, 'partial_success', [{ error_message: 'p' }]));
        expect(doneOf(await client.check(DOC_JOB)).warnings).toEqual([
            { code: 'server', message: 'p', details: NO_DETAILS },
        ]);
    });

    test('a failed task maps to conversion_failed for both job kinds', async () => {
        const { client } = setup();
        const jobs = [dataOf(await client.submitMarkdown(BROKEN_PDF)), dataOf(await client.submitDocument(BROKEN_PDF))];
        for (const job of jobs) {
            const done = (await checkUntilDone(client, job)).at(-1) as Result<unknown>;
            expect(errorOf(done)).toEqual({
                code: 'conversion_failed',
                message: 'Conversion failed (Mock: input is not a valid PDF)',
                details: { errors: [], failure: null },
                versions: MOCK_VERSIONS,
            });
        }
    });

    test('failure reasons: failure message, error message, skipped, non-string values', async () => {
        const { server, client } = setup();
        const timeout = { message: 'timeout', category: 'timeout', phase: 'execution', retryable: true };
        const cases: [Response, string, TaskFailure | null][] = [
            [
                task('failure', { failure: timeout }),
                'Conversion failed (timeout)',
                { category: 'timeout', phase: 'execution', retryable: true },
            ],
            [task('failure', { error_message: 'oom' }), 'Conversion failed (oom)', null],
            [task('failure', { failure: null, error_message: '' }), 'Conversion failed (status: failure)', null],
            [task('skipped'), 'Conversion failed (status: skipped)', null],
            [
                task('failure', { failure: { message: 42, category: 1, retryable: 'yes' }, error_message: {} }),
                'Conversion failed (status: failure)',
                { category: null, phase: null, retryable: null },
            ],
        ];
        for (const [response, message, failure] of cases) {
            server.failNext(response);
            expect(errorOf(await client.check(MD_JOB))).toEqual({
                code: 'conversion_failed',
                message,
                details: { errors: [], failure },
                versions: MOCK_VERSIONS,
            });
        }
    });

    test('done, but the result failed, expired or the server is down', async () => {
        const { server, client } = setup();
        server.failNext(task('partial_success'));
        server.failNext(converted(null, 'failure'));
        expect(errorOf(await client.check(MD_JOB))?.code).toBe('conversion_failed');
        server.failNext(task('success'));
        server.failNext(new Response('', { status: 404 }));
        expect(errorOf(await client.check(DOC_JOB))).toEqual({
            code: 'not_found',
            message: 'Result already fetched or expired: t-1; resubmit the PDF (HTTP 404: no response body)',
            status: 404,
            versions: MOCK_VERSIONS,
        });
        server.failNext(task('success'));
        server.failNext(new Response('', { status: 500 }));
        expect(errorOf(await client.check(MD_JOB))).toEqual({
            code: 'http',
            message: 'HTTP 500: no response body',
            status: 500,
            versions: MOCK_VERSIONS,
        });
        server.failNext(task('success'));
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.check(MD_JOB))).toEqual({ code: 'network', message: 'refused' });
        server.failNext(task('success'));
        server.failNext(converted(null));
        expect(errorOf(await client.check(MD_JOB))?.message).toBe('Response has no md_content');
    });

    test('an extract job reports undecodable images when done', async () => {
        const { server, client } = setup();
        server.failNext(task('success'));
        server.failNext(converted('![Image](data:image/png;base64,a=b)'));
        const job: MarkdownJob = {
            kind: 'markdown',
            id: 't-1',
            output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } },
        };
        const done = doneOf(await client.check(job));
        expect(done.markdown).toBe('');
        expect(done.warnings.map((warning) => warning.code)).toEqual(['image_not_decoded']);
    });

    test('a check after docling removed the result is not_found with the server message', async () => {
        const { server, client } = setup();
        const job = dataOf(await client.submitDocument(PDF));
        await checkUntilDone(client, job);
        server.failNext(task('success'));
        server.failNext(Response.json({ detail: 'Task result not found.' }, { status: 404 }));
        expect(errorOf(await client.check(job))?.message).toBe(
            'Result already fetched or expired: mock-task-1; resubmit the PDF (HTTP 404: Task result not found.)',
        );
    });

    test('unknown job ids, unexpected statuses, bodies and network errors', async () => {
        const { server, client } = setup();
        expect(errorOf(await client.check({ ...MD_JOB, id: 'nope' }))).toEqual({
            code: 'not_found',
            message: 'Unknown job id: nope (HTTP 404: Task not found.)',
            status: 404,
            versions: MOCK_VERSIONS,
        });
        expect(errorOf(await client.check({ kind: 'document', id: 'nope' }))?.code).toBe('not_found');
        server.failNext(task('exploded'));
        expect(errorOf(await client.check(MD_JOB))).toEqual({
            code: 'invalid_response',
            message: 'Unexpected task status: exploded',
            versions: MOCK_VERSIONS,
        });
        server.failNext(Response.json(null));
        expect(errorOf(await client.check(MD_JOB))?.message).toBe('Unexpected task status: undefined');
        server.failNext(new Response('', { status: 500 }));
        expect(errorOf(await client.check(MD_JOB))?.code).toBe('http');
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.check(MD_JOB))?.code).toBe('network');
        server.failNext(task('pending', { task_position: '3' }));
        expect(await client.check(MD_JOB)).toEqual({ ok: true, data: { status: 'queued', position: null } });
        server.failNext(task('pending', { task_position: 4 }));
        expect(await client.check(DOC_JOB)).toEqual({ ok: true, data: { status: 'queued', position: 4 } });
    });

    test('invalid job objects resolve to invalid_input without a request', async () => {
        const { server, client } = setup();
        const expected = 'Expected the job object returned by submitMarkdown() or submitDocument()';
        const bad: unknown[] = [
            't-1',
            null,
            [],
            { id: 't-1' },
            { kind: 'other', id: 't-1' },
            { ...MD_JOB, id: '../result/t-1' },
            { ...MD_JOB, id: 'a/b' },
            { ...MD_JOB, id: '' },
            { ...DOC_JOB, id: 5 },
            { kind: 'markdown', id: 't-1' },
            { kind: 'markdown', id: 't-1', output: null },
            { kind: 'markdown', id: 't-1', output: { images: 'embedded' } },
            // shape of the removed pageNumbers/repairs jobs
            { id: 't-1', output: { images: 'placeholder', pageNumbers: false } },
        ];
        for (const job of bad) {
            expect(errorOf(await client.check(job as Job))).toEqual({ code: 'invalid_input', message: expected });
        }
        const badOutput: [unknown, string][] = [
            [{ images: 'extract' }, `Option "imageOptions" is required with images: 'extract'`],
            [{ images: 'extract', imageOptions: { prefix: '' } }, 'Invalid value for option "imageOptions.prefix"'],
            [{ images: 'extract', imageOptions: {} }, 'Option "imageOptions.prefix" is required'],
            [
                { images: 'none', imageOptions: { prefix: PREFIX } },
                `Option "imageOptions" is not supported without images: 'extract'`,
            ],
        ];
        for (const [output, message] of badOutput) {
            const job = { kind: 'markdown', id: 't-1', output } as unknown as Job;
            expect(errorOf(await client.check(job))).toEqual({
                code: 'invalid_input',
                message: `${expected}: ${message}`,
            });
        }
        expect(server.requests).toHaveLength(0);
    });

    test('invalid check options reject with a TypeError, even for an invalid job', async () => {
        const { server, client } = setup();
        await expect(client.check(MD_JOB, { ocr: false } as never)).rejects.toThrow(
            new TypeError('Option "ocr" is not supported'),
        );
        await expect(client.check('x' as unknown as Job, 'x' as never)).rejects.toThrow(
            new TypeError('Invalid options: expected an object'),
        );
        await expect(client.check(DOC_JOB, { signal: 'x' } as never)).rejects.toThrow(
            new TypeError('Invalid value for option "signal"'),
        );
        expect(server.requests).toHaveLength(0);
    });

    test('a document job with extra fields is accepted; only kind and id are used', async () => {
        const { server, client } = setup();
        server.failNext(task('started'));
        const job = { kind: 'document', id: 't-1', output: 'ignored' } as unknown as Job;
        expect(await client.check(job)).toEqual({ ok: true, data: { status: 'running' } });
        expect(sentPaths(server)).toEqual(['/v1/status/poll/t-1']);
    });

    test('submit errors: http status, network and a missing task id', async () => {
        const { server, client } = setup();
        server.failNext(new Response('', { status: 401 }));
        expect(errorOf(await client.submitMarkdown(PDF))?.status).toBe(401);
        server.failNext(new TypeError('refused'));
        expect(errorOf(await client.submitDocument(PDF))).toEqual({ code: 'network', message: 'refused' });
        for (const body of [{}, null, { task_id: '' }, { task_id: 5 }]) {
            server.failNext(Response.json(body));
            expect(errorOf(await client.submitMarkdown(PDF))).toEqual({
                code: 'invalid_response',
                message: 'Response has no task_id',
                versions: MOCK_VERSIONS,
            });
            server.failNext(Response.json(body));
            expect(errorOf(await client.submitDocument(PDF))?.message).toBe('Response has no task_id');
        }
    });

    test('submit rejects a task id that check could not use', async () => {
        const { server, client } = setup();
        for (const id of ['a/b', '../x', 'tenant:task.1']) {
            server.failNext(Response.json({ task_id: id, task_status: 'pending' }));
            expect(errorOf(await client.submitMarkdown(PDF))).toEqual({
                code: 'invalid_response',
                message: `Response has an unusable task_id: ${JSON.stringify(id)}`,
                versions: MOCK_VERSIONS,
            });
        }
        server.failNext(Response.json({ task_id: `${'x'.repeat(200)}/` }));
        const message = errorOf(await client.submitDocument(PDF))?.message ?? '';
        expect(message).toBe(`Response has an unusable task_id: "${'x'.repeat(99)}`);
    });

    test('a 404 in check keeps the server detail, e.g. a wrong route', async () => {
        const { server, client } = setup();
        server.failNext(Response.json({ detail: 'Not Found' }, { status: 404 }));
        expect(errorOf(await client.check(MD_JOB))?.message).toBe('Unknown job id: t-1 (HTTP 404: Not Found)');
    });

    test('an input that cannot be prepared for upload resolves invalid_input without a request', async () => {
        const { server, client } = setup();
        const append = spyOn(FormData.prototype, 'append').mockImplementation(() => {
            throw new RangeError('Array buffer allocation failed');
        });
        try {
            const results = [await client.convertMarkdown(PDF), await client.submitDocument(PDF)];
            for (const res of results) {
                expect(errorOf(res)).toEqual({
                    code: 'invalid_input',
                    message: 'Input could not be prepared for upload: Array buffer allocation failed',
                });
            }
        } finally {
            append.mockRestore();
        }
        expect(server.requests).toHaveLength(0);
    });

    test('uploads views and SharedArrayBuffer-backed input with exactly their bytes', async () => {
        const { server, client } = setup();
        const padded = new Uint8Array(PDF.length + 8);
        padded.set(PDF, 4);
        const shared = new Uint8Array(new SharedArrayBuffer(PDF.length));
        shared.set(PDF);
        for (const input of [padded.subarray(4, 4 + PDF.length), shared]) {
            await client.convertMarkdown(input);
            const file = lastForm(server).get('files') as File;
            expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
        }
    });
});

describe('mock server', () => {
    test('rejects invalid form fields with a FastAPI-style 422', async () => {
        const server = createMockDoclingServer();
        const form = new FormData();
        form.append('do_ocr', 'yes');
        form.append('pipeline', 'fast');
        form.append('page_range', '1');
        form.append('document_timeout', 'soon');
        const res = await server.fetch(`${BASE_URL}/v1/convert/file`, { method: 'POST', body: form });
        expect(res.status).toBe(422);
        const { detail } = (await res.json()) as { detail: { loc: string[] }[] };
        expect(detail.map((error) => error.loc[1])).toEqual([
            'files',
            'do_ocr',
            'pipeline',
            'page_range',
            'document_timeout',
        ]);
    });

    test('answers health, version, unknown routes, unknown tasks and unfinished results', async () => {
        const server = createMockDoclingServer({ apiKey: 'secret' });
        expect(await (await server.fetch(`${BASE_URL}/health`)).json()).toEqual({ status: 'ok' });
        expect(await (await server.fetch(`${BASE_URL}/version`)).json()).toEqual(MOCK_VERSIONS);
        expect((await server.fetch(`${BASE_URL}/v1/result/x`)).status).toBe(401);
        const headers = { 'X-Api-Key': 'secret' };
        const unknown = await server.fetch(`${BASE_URL}/v1/unknown`, { headers });
        expect([unknown.status, await unknown.json()]).toEqual([404, { detail: 'Not Found' }]);
        const noTask = await server.fetch(`${BASE_URL}/v1/status/poll/nope`, { headers });
        expect([noTask.status, await noTask.json()]).toEqual([404, { detail: 'Task not found.' }]);
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: server.fetch, apiKey: 'secret' });
        const job = dataOf(await client.submitMarkdown(PDF));
        expect((await server.fetch(`${BASE_URL}/v1/result/${job.id}`, { headers })).status).toBe(404);
    });

    test('fills only the requested to_formats', async () => {
        const server = createMockDoclingServer();
        const filled: [string, boolean, boolean][] = [];
        for (const format of ['md', 'json']) {
            const form = new FormData();
            form.append('files', new Blob([PDF]), 'a.pdf');
            form.append('to_formats', format);
            const res = await server.fetch(`${BASE_URL}/v1/convert/file`, { method: 'POST', body: form });
            const { document } = (await res.json()) as { document: { md_content: unknown; json_content: unknown } };
            filled.push([format, document.md_content !== null, document.json_content !== null]);
        }
        expect(filled).toEqual([
            ['md', true, false],
            ['json', false, true],
        ]);
    });

    test('a failed async task reports failure with the error message', async () => {
        const server = createMockDoclingServer();
        const form = new FormData();
        form.append('files', new Blob([BROKEN_PDF]), 'a.pdf');
        form.append('to_formats', 'md');
        const submitted = await server.fetch(`${BASE_URL}/v1/convert/file/async`, { method: 'POST', body: form });
        expect(await submitted.json()).toMatchObject({ task_id: 'mock-task-1', task_status: 'pending' });
        const polls = [];
        for (let i = 0; i < 3; i++) {
            polls.push(await (await server.fetch(`${BASE_URL}/v1/status/poll/mock-task-1`)).json());
        }
        expect(polls.map((poll) => (poll as { task_status: string }).task_status)).toEqual([
            'pending',
            'started',
            'failure',
        ]);
        expect(polls[2]).toMatchObject({ error_message: 'Mock: input is not a valid PDF' });
        const result = await (await server.fetch(`${BASE_URL}/v1/result/mock-task-1`)).json();
        expect(result).toMatchObject({ status: 'failure', document: { md_content: null, json_content: null } });
    });

    test('renders a DoclingDocument whose refs resolve and point back to their parent', () => {
        const form = new FormData();
        form.append('to_formats', 'json');
        form.append('do_pdf_heading_hierarchy', 'true');
        const doc = renderMockDocument(form);
        expect(doc).toMatchObject({
            schema_name: 'DoclingDocument',
            version: '1.10.0',
            body: { self_ref: '#/body', parent: null, content_layer: 'body' },
            furniture: { self_ref: '#/furniture', parent: null, children: [], content_layer: 'furniture' },
            groups: [],
        });
        expect(Object.keys(doc.pages)).toEqual(['1', '2']);
        expect(doc.pages['1']).toEqual({ size: { width: 595, height: 842 }, image: null, page_no: 1 });
        const refs = doc.body.children.map((child) => child.$ref);
        expect(refs).toEqual([
            '#/texts/0',
            '#/pictures/0',
            '#/texts/1',
            '#/texts/2',
            '#/texts/3',
            '#/tables/0',
            '#/pictures/1',
            '#/texts/4',
        ]);
        for (const ref of refs) {
            expect(resolveRef(doc, ref)).toMatchObject({ self_ref: ref, parent: { $ref: '#/body' } });
        }
        expect(doc.texts.map((text) => [text.label, 'level' in text ? text.level : null])).toEqual([
            ['section_header', 1],
            ['section_header', 2],
            ['text', null],
            ['section_header', 3],
            ['text', null],
        ]);
        expect(doc.texts[2]?.text).toBe('Research & Development on page one.');
        expect(doc.tables[0]?.data).toMatchObject({ num_rows: 2, num_cols: 2 });
        expect(doc.tables[0]?.data.grid[1]?.map((cell) => cell.text)).toEqual(['Alpha', '120 000']);
        expect(doc.tables[0]?.data.table_cells).toHaveLength(4);
        expect(doc.pictures.map((picture) => picture.prov[0]?.page_no)).toEqual([1, 2]);
    });

    test('picture data only with image_export_mode=embedded and include_images=true', () => {
        const cases: [string, string, boolean][] = [
            ['embedded', 'true', true],
            ['embedded', 'false', false],
            ['placeholder', 'true', false],
            ['placeholder', 'false', false],
        ];
        for (const [mode, include, embedded] of cases) {
            const form = new FormData();
            form.append('image_export_mode', mode);
            form.append('include_images', include);
            const doc = renderMockDocument(form);
            expect(doc.pictures.every((picture) => (picture.image !== null) === embedded)).toBe(true);
            expect(renderMockMarkdown(form).includes('data:image/png;base64,')).toBe(embedded);
        }
    });
});

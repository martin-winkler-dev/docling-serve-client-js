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
    DoclingSettings,
    DocumentJob,
    Job,
    JobRef,
    JobState,
    MarkdownJob,
    Result,
    ServerCapabilities,
    TaskFailure,
} from '../../src/types.js';
import {
    BROKEN_PDF_MARKER,
    createMockDoclingServer,
    MOCK_CAPABILITIES,
    MOCK_SCHEMA_VERSION,
    MOCK_VERSIONS,
    type MockDoclingServer,
    type MockServerOptions,
    NO_RESULT_DETAIL,
    renderMockDocument,
    renderMockMarkdown,
    WORKER_ERROR_MARKER,
    WORKER_ERROR_MESSAGE,
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

/** PDF whose conversion makes the mock worker raise an exception. */
const CRASH_PDF = new TextEncoder().encode(`%PDF-1.7\n${WORKER_ERROR_MARKER}`);

/** Error of `BROKEN_PDF`, the same on the sync endpoint and the job path. */
const BROKEN_PDF_ERROR: ConvertError = {
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
};

/** Stored md job with placeholder images, without the optional settings. */
const MD_JOB: Omit<MarkdownJob, 'settings'> = { kind: 'markdown', id: 't-1', output: { images: 'placeholder' } };

/** Stored document job, without the optional settings. */
const DOC_JOB: Omit<DocumentJob, 'settings'> = { kind: 'document', id: 't-1' };

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
    ocr_preset: 'auto',
    table_structure_preset: 'tableformer_v1_accurate',
    table_cell_matching: 'true',
    do_picture_classification: 'false',
    do_picture_description: 'false',
    abort_on_error: 'false',
};

/** Settings of `convertMarkdown(PDF)` with default options. */
const MD_SETTINGS: DoclingSettings = {
    fromFormats: 'pdf',
    toFormats: 'md',
    imageExportMode: 'placeholder',
    includeImages: false,
    includePageImages: false,
    imagesScale: 2,
    mdCompactTables: true,
    mdPageBreakPlaceholder: '',
    doOcr: true,
    forceOcr: false,
    ocrPreset: 'auto',
    ocrLang: [],
    pdfBackend: 'docling_parse',
    pipeline: 'standard',
    vlmPipelinePreset: null,
    doTableStructure: true,
    tableMode: 'accurate',
    tableStructurePreset: 'tableformer_v1_accurate',
    tableCellMatching: true,
    doPdfHeadingHierarchy: true,
    doFormulaEnrichment: true,
    doCodeEnrichment: false,
    codeFormulaPreset: 'codeformulav2',
    doChartExtraction: false,
    chartExtractionPreset: null,
    doPictureClassification: false,
    doPictureDescription: false,
    pageRange: null,
    documentTimeout: null,
    abortOnError: false,
};

/** Settings of `convertDocument(PDF)` with default options: json without md fields, embedded pictures. */
const DOC_SETTINGS: DoclingSettings = {
    ...MD_SETTINGS,
    toFormats: 'json',
    imageExportMode: 'embedded',
    includeImages: true,
    mdCompactTables: null,
    mdPageBreakPlaceholder: null,
};

/** `MOCK_CAPABILITIES` as `capabilities()` returns it. */
const EXPECTED_CAPABILITIES: ServerCapabilities = {
    versions: MOCK_CAPABILITIES.versions,
    stages: Object.fromEntries(
        Object.entries(MOCK_CAPABILITIES.stages).map(([key, stage]) => [
            key,
            {
                option: stage.option,
                customConfigOption: stage.custom_config_option,
                default: stage.default,
                presets: stage.presets,
            },
        ]),
    ),
    sources: MOCK_CAPABILITIES.sources,
    targets: MOCK_CAPABILITIES.targets,
    outputFormats: MOCK_CAPABILITIES.output_formats,
    imageExportModes: MOCK_CAPABILITIES.image_export_modes,
    limits: {
        maxDocumentTimeout: 604800,
        maxImagesScale: 2,
        maxSourcesPerRequest: 3,
        maxNumPages: null,
        maxFileSize: null,
    },
    features: { apiKeyRequired: false, artifactStorage: false, websocket: true },
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
async function checkUntilDone(client: DoclingClient, job: JobRef) {
    const states = [];
    for (let i = 0; i < 3; i++) {
        states.push(await client.check(job));
    }
    return states;
}

/** `fetch` that never answers conversion, poll and result requests, but rejects once their signal aborts. */
function hangExceptVersion(server: MockDoclingServer): typeof fetch {
    /** Stalls responses until signal aborts. */
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

/** Submits the bytes as an md job straight to the mock, then polls it three times; returns the status bodies. */
async function pollMockTask(server: MockDoclingServer, bytes: Uint8Array): Promise<Record<string, unknown>[]> {
    const form = new FormData();
    form.append('files', new Blob([bytes]), 'a.pdf');
    form.append('to_formats', 'md');
    const submitted = await server.fetch(`${BASE_URL}/v1/convert/file/async`, { method: 'POST', body: form });
    expect(await submitted.json()).toMatchObject({ task_id: 'mock-task-1', task_status: 'pending' });
    const polls: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
        const poll = await server.fetch(`${BASE_URL}/v1/status/poll/mock-task-1`);
        polls.push((await poll.json()) as Record<string, unknown>);
    }
    return polls;
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
    test('returns the nine client functions for a valid configuration', () => {
        const config = { apiKey: 'k', timeoutMs: 1000, pollMs: 50, options: { ocr: false, pageRange: [1, 2] } };
        const { client } = setup(config as Omit<DoclingConfig, 'baseUrl'>);
        expect(Object.keys(client).sort()).toEqual([
            'capabilities',
            'check',
            'convertDocument',
            'convertMarkdown',
            'runDocument',
            'runMarkdown',
            'submitDocument',
            'submitMarkdown',
            'waitForJob',
        ]);
    });

    test('throws a TypeError with descriptive message for invalid configuration', () => {
        const invalid: [unknown, string][] = [
            [undefined, 'Invalid config: expected an object'],
            [{}, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'docling:5001' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: BASE_URL, timeoutMs: 0 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: BASE_URL, pollMs: 0 }, 'Invalid value for option "pollMs"'],
            [{ baseUrl: BASE_URL, pollMs: 2 ** 31 }, 'Invalid value for option "pollMs"'],
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

describe('request dispatch', () => {
    test('convertMarkdown sends markdown conversion request with compact tables, placeholders, and default form fields', async () => {
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
            md_page_break_placeholder: '',
            include_images: 'false',
            image_export_mode: 'placeholder',
        });
    });

    test('convertDocument sends json conversion request with embedded images and omits markdown fields', async () => {
        const { server, client } = setup();
        await client.convertDocument(PDF);
        expect(sentFields(server)).toEqual({
            ...DEFAULT_FIELDS,
            to_formats: 'json',
            include_images: 'true',
            image_export_mode: 'embedded',
        });
    });

    test('maps image modes to image_export_mode and include_images form fields', async () => {
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

    test('enables embedded export and include_page_images when pageImages is true', async () => {
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

    test('sends fixed images_scale of 2 and rejects unsupported imageScale option', async () => {
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

    test('submits image inputs with from_formats=image, matching filename, and MIME type', async () => {
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

    test('enforces OCR for image inputs while ignoring pdf ocr and forceOcr settings', async () => {
        const { server, client } = setup({ options: { ocr: false, forceOcr: true } });
        const md = dataOf(await client.convertMarkdown(PNG));
        expect(sentFields(server)).toMatchObject({ from_formats: 'image', do_ocr: 'true', force_ocr: 'false' });
        expect(md.settings).toMatchObject({ fromFormats: 'image', doOcr: true, forceOcr: false });
        const job = dataOf(await client.submitDocument(PNG, { ocr: false, forceOcr: true }));
        expect(sentFields(server)).toMatchObject({ from_formats: 'image', do_ocr: 'true', force_ocr: 'false' });
        expect(job.settings).toMatchObject({ fromFormats: 'image', doOcr: true, forceOcr: false });
        // forceOcr turns OCR on for PDFs: docling ignores force_ocr while do_ocr is false.
        const pdf = dataOf(await client.convertDocument(PDF));
        expect(sentFields(server)).toMatchObject({ from_formats: 'pdf', do_ocr: 'true', force_ocr: 'true' });
        expect(pdf.settings).toMatchObject({ fromFormats: 'pdf', doOcr: true, forceOcr: true });
    });

    test('disables OCR for PDFs when ocr is false without forceOcr', async () => {
        const { server, client } = setup({ options: { ocr: false } });
        const md = dataOf(await client.convertMarkdown(PDF));
        expect(sentFields(server)).toMatchObject({ from_formats: 'pdf', do_ocr: 'false', force_ocr: 'false' });
        expect(md.settings).toMatchObject({ doOcr: false, forceOcr: false });
    });

    test('serializes all supported option combinations into matching form fields and settings', async () => {
        const { server, client } = setup({
            options: { ocrLang: ['de', 'en'], pageRange: [2, 3], documentTimeout: 45 },
        });
        /** Converts a `DoclingSettings` object to the expected `sentFields(server)` record. */
        function toFormRecord(settings: DoclingSettings): Record<string, string | string[]> {
            const record: Record<string, string | string[]> = {};
            for (const [key, value] of Object.entries(settings)) {
                if (value === null || (Array.isArray(value) && value.length === 0)) {
                    continue;
                }
                const name = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
                record[name] = Array.isArray(value) ? value.map(String) : String(value);
            }
            return record;
        }
        const md = dataOf(
            await client.convertMarkdown(PDF, {
                pipeline: 'vlm',
                chartExtraction: true,
                formulaEnrichment: false,
                ocrEngine: 'rapidocr',
                images: 'extract',
                imageOptions: { prefix: PREFIX },
            }),
        );
        expect(sentFields(server)).toEqual(toFormRecord(md.settings));
        expect(md.settings).toMatchObject({
            pipeline: 'vlm',
            vlmPipelinePreset: 'granite_docling',
            doChartExtraction: true,
            chartExtractionPreset: 'granite_vision_v4',
            doFormulaEnrichment: false,
            doCodeEnrichment: false,
            codeFormulaPreset: null,
            ocrPreset: 'rapidocr',
            ocrLang: ['de', 'en'],
            pageRange: [2, 3],
            documentTimeout: 45,
        });
        const doc = dataOf(await client.convertDocument(PNG, { ocrEngine: 'custom-ocr-v2', pageImages: true }));
        expect(sentFields(server)).toEqual(toFormRecord(doc.settings));
        expect(doc.settings.ocrPreset).toBe('custom-ocr-v2');
        const sub = dataOf(await setup().client.submitDocument(PDF));
        expect(sub.settings).toEqual(DOC_SETTINGS);
    });

    test('submits markdown and document jobs to async endpoint with identical form fields', async () => {
        const { server, client } = setup();
        await client.submitMarkdown(PDF);
        expect(sentPaths(server).at(-1)).toBe('/v1/convert/file/async');
        expect(sentFields(server)).toMatchObject({ to_formats: 'md', md_compact_tables: 'true' });
        await client.submitDocument(PDF);
        expect(sentPaths(server).at(-1)).toBe('/v1/convert/file/async');
        expect(sentFields(server).to_formats).toBe('json');
        expect('md_compact_tables' in sentFields(server)).toBe(false);
    });

    test('applies factory options to all calls and allows call-level options to override them', async () => {
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
            // per-call forceOcr turns OCR on over the factory's ocr: false
            do_ocr: 'true',
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

    test('rejects factory-only options passed at call time before making a request', async () => {
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
            await expect(client.runMarkdown(PDF, options as never)).rejects.toThrow(error);
            await expect(client.runDocument(PDF, options as never)).rejects.toThrow(error);
        }
        expect(server.requests).toHaveLength(0);
        await client.convertMarkdown(PDF, { ocr: undefined } as never);
        expect(sentFields(server).ocr_lang).toBe('fr');
    });

    test('omits ocr_lang form field when factory ocrLang is empty', async () => {
        const { server, client } = setup({ options: { ocrLang: [] } });
        await client.convertMarkdown(PDF);
        expect('ocr_lang' in sentFields(server)).toBe(false);
    });

    test('sends code_formula_preset only when formula or code enrichment is enabled', async () => {
        const { server, client } = setup({ options: { formulaEnrichment: false } });
        await client.convertMarkdown(PDF);
        expect('code_formula_preset' in sentFields(server)).toBe(false);
        await client.convertDocument(PDF, { codeEnrichment: true });
        expect(sentFields(server).code_formula_preset).toBe('codeformulav2');
    });

    test('includes API key header on every request', async () => {
        const { server, client } = setup({ apiKey: 'secret' }, { apiKey: 'secret' });
        expect((await client.convertMarkdown(PDF)).ok).toBe(true);
        expect((await client.convertDocument(PDF)).ok).toBe(true);
        const job = dataOf(await client.submitDocument(PDF));
        expect((await client.check(job)).ok).toBe(true);
        expect((await client.waitForJob(job, { pollMs: 1 })).ok).toBe(true);
        expect((await client.runMarkdown(PDF, { pollMs: 1 })).ok).toBe(true);
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

    test('returns aborted error code across all client methods when signal is aborted', async () => {
        const { client } = setup();
        const signal = AbortSignal.abort();
        const results = [
            await client.convertMarkdown(PDF, { signal }),
            await client.convertDocument(PDF, { signal }),
            await client.submitMarkdown(PDF, { signal }),
            await client.submitDocument(PDF, { signal }),
            await client.check(MD_JOB, { signal }),
            await client.runMarkdown(PDF, { signal }),
            await client.runDocument(PDF, { signal }),
            await client.waitForJob(MD_JOB, { signal }),
        ];
        expect(results.map((res) => errorOf(res)?.code)).toEqual(results.map(() => 'aborted'));
    });

    test('aborts requests exceeding timeoutMs alone or when combined with caller signal', async () => {
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
            await client.runMarkdown(PDF),
            await client.runDocument(PDF, { signal }),
            await client.waitForJob(DOC_JOB, { signal }),
        ];
        expect(results.map((res) => errorOf(res)?.code)).toEqual(results.map(() => 'aborted'));
    });

    test('returns invalid_input without making a request when input bytes are invalid', async () => {
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
            expect(errorOf(await client.runMarkdown(bad))).toEqual(error);
            expect(errorOf(await client.runDocument(bad))).toEqual(error);
        }
        expect(server.requests).toHaveLength(0);
    });

    test('rejects invalid options with a TypeError before inspecting input or sending requests', async () => {
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
            await expect(client.runMarkdown(new Uint8Array(), options as never)).rejects.toThrow(
                new TypeError(message),
            );
        }
        for (const [options, message] of document) {
            await expect(client.convertDocument(PDF, options as never)).rejects.toThrow(new TypeError(message));
            await expect(client.submitDocument(new Uint8Array(), options as never)).rejects.toThrow(
                new TypeError(message),
            );
            await expect(client.runDocument(new Uint8Array(), options as never)).rejects.toThrow(
                new TypeError(message),
            );
        }
        expect(server.requests).toHaveLength(0);
    });

    test('rejects truncated PDF input before request and transmits complete PDF', async () => {
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
        expect(errorOf(await client.runMarkdown(truncated))).toEqual(error);
        expect(errorOf(await client.runDocument(truncated))).toEqual(error);
        expect(server.requests).toHaveLength(0);
        const complete = new TextEncoder().encode('%PDF-1.7\nxref\nstartxref\n9\n%%EOF\n');
        expect((await client.convertMarkdown(complete)).ok).toBe(true);
    });
});

describe('convertMarkdown', () => {
    test('returns server markdown unchanged with image placeholders by default', async () => {
        const { server, client } = setup();
        const res = await client.convertMarkdown(PDF);
        expect(res).toEqual({
            ok: true,
            data: {
                markdown: DEFAULT_MARKDOWN,
                images: [],
                warnings: [],
                versions: MOCK_VERSIONS,
                settings: MD_SETTINGS,
            },
        });
        expect(dataOf(res).markdown).toBe(renderMockMarkdown(lastForm(server)));
    });

    test('verifies headingHierarchy and pageRange options reach the server', async () => {
        const { client } = setup();
        const flat = dataOf(await client.convertMarkdown(PDF, { headingHierarchy: false }));
        expect(flat.markdown).toContain('## Mock Report\n\n');
        expect(flat.markdown).toContain('## 1.1 Details\n\n');
        const secondPage = dataOf(await setup({ options: { pageRange: [2, 2] } }).client.convertMarkdown(PDF));
        expect(secondPage.markdown).toStartWith('### 1.1 Details\n\n');
        expect(secondPage.markdown).not.toContain('Mock Report');
    });

    test("removes image placeholders and adjacent blank lines when images is 'none'", async () => {
        const { client } = setup();
        const res = dataOf(await client.convertMarkdown(PDF, { images: 'none' }));
        expect(res.markdown).toBe(DEFAULT_MARKDOWN.replaceAll('<!-- image -->\n\n', ''));
        expect(res.images).toEqual([]);
    });

    test("extracts embedded images as bytes and rewrites links using prefix when images is 'extract'", async () => {
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

    test('omits small badge images by default when extracting images', async () => {
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

    test('preserves placeholders for pictures without embedded data when extracting images', async () => {
        const { server, client } = setup();
        const md = `a\n\n<!-- image -->\n\n![Image](data:image/png;base64,${toBase64(pngBytes(400, 300))})\n\nb`;
        server.failNext(converted(md));
        const res = dataOf(await client.convertMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }));
        expect(res.markdown).toBe('a\n\n<!-- image -->\n\n![Image](out/images/1234-1.png)\n\nb');
        expect(res.warnings).toEqual([]);
    });

    test('removes invalid embedded image data and produces an image_not_decoded warning', async () => {
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
                settings: { ...MD_SETTINGS, imageExportMode: 'embedded', includeImages: true },
            },
        });
    });

    test('preserves embedded data URIs when images option is placeholder or none', async () => {
        const { server, client } = setup();
        const md = '![Image](data:image/png;base64,a=b)\n\n<!-- image -->\n\nend';
        server.failNext(converted(md));
        expect(dataOf(await client.convertMarkdown(PDF)).markdown).toBe(md);
        server.failNext(converted(md));
        expect(dataOf(await client.convertMarkdown(PDF, { images: 'none' })).markdown).toBe(
            '![Image](data:image/png;base64,a=b)\n\nend',
        );
    });

    test('returns markdown and server warnings on partial success response', async () => {
        const { server, client } = setup();
        server.failNext(converted('text', 'partial_success', [{ error_message: 'page 3 failed' }, {}]));
        expect(await client.convertMarkdown(PDF)).toEqual({
            ok: true,
            data: {
                markdown: 'text',
                images: [],
                warnings: [{ code: 'server', message: 'page 3 failed', details: NO_DETAILS }],
                versions: MOCK_VERSIONS,
                settings: MD_SETTINGS,
            },
        });
    });

    test('maps server error items to warnings with 1-based PDF page numbers', async () => {
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

    test('safely parses malformed error items and failure fields without throwing', async () => {
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
                data: { markdown: 'x', images: [], warnings: [], versions: MOCK_VERSIONS, settings: MD_SETTINGS },
            });
        }
        server.failNext(Response.json({ status: 'failure', errors: [null], failure: { message: 1 } }));
        expect(errorOf(await client.convertMarkdown(PDF))?.message).toBe('Conversion failed (status: failure)');
    });

    test('maps failed conversion response to conversion_failed with reason and error details', async () => {
        const { client } = setup();
        expect(errorOf(await client.convertMarkdown(BROKEN_PDF))).toEqual(BROKEN_PDF_ERROR);
    });

    test('maps sync worker error to HTTP 404 error with server detail', async () => {
        const { client } = setup();
        expect(errorOf(await client.convertMarkdown(CRASH_PDF))).toEqual({
            code: 'http',
            message: `HTTP 404: ${NO_RESULT_DETAIL}`,
            status: 404,
            versions: MOCK_VERSIONS,
        });
    });

    test('extracts failure reasons from error messages, failure payload, or status string', async () => {
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

    test('returns invalid_response when status or md_content is missing', async () => {
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

    test('returns conversion_failed when success status lacks content but includes error details', async () => {
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

    test('treats an empty markdown string as a valid conversion result', async () => {
        const { server, client } = setup();
        server.failNext(converted(''));
        expect(dataOf(await client.convertMarkdown(PDF)).markdown).toBe('');
    });

    test('propagates HTTP error status, invalid JSON, and network errors', async () => {
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

    test('maps server 422 validation failure to HTTP error with field details', async () => {
        const { server, client } = setup();
        server.failNext(Response.json({ detail: [{ loc: ['body', 'pipeline'], msg: 'bad' }] }, { status: 422 }));
        const error = errorOf(await client.convertMarkdown(PDF));
        expect(error?.code).toBe('http');
        expect(error?.status).toBe(422);
        expect(error?.message).toBe('HTTP 422: [{"loc":["body","pipeline"],"msg":"bad"}]');
    });
});

describe('convertDocument', () => {
    test('returns DoclingDocument with embedded picture data by default', async () => {
        const { server, client } = setup();
        const res = dataOf(await client.convertDocument(PDF));
        expect(res).toEqual({
            document: renderMockDocument(lastForm(server)),
            pageImages: [],
            warnings: [],
            versions: MOCK_VERSIONS,
            settings: DOC_SETTINGS,
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

    test("retains picture elements without image data when images is 'placeholder'", async () => {
        const { client } = setup();
        const res = dataOf(await client.convertDocument(PDF, { images: 'placeholder' }));
        expect(res.document.pictures).toHaveLength(2);
        expect(res.document.pictures.map((picture) => [picture.self_ref, picture.image])).toEqual([
            ['#/pictures/0', null],
            ['#/pictures/1', null],
        ]);
    });

    test('extracts page images into separate array in page order when pageImages is true', async () => {
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

    test('leaves undecodable page images in document and emits page_image_not_decoded warnings', async () => {
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

    test('applies headingHierarchy and pageRange options to document structure', async () => {
        const { client } = setup({ options: { pageRange: [2, 2] } });
        const res = dataOf(await client.convertDocument(PDF, { headingHierarchy: false }));
        expect(Object.keys(res.document.pages)).toEqual(['2']);
        expect(res.document.texts.map((text) => [text.label, text.text, text.prov[0]?.page_no])).toEqual([
            ['section_header', '1.1 Details', 2],
            ['text', 'Text on page two.', 2],
        ]);
        expect(res.document.texts[0]).toMatchObject({ level: 1 });
    });

    test('passes additional DoclingDocument properties through without modification', async () => {
        const { server, client } = setup();
        const json = { ...MINIMAL_DOCUMENT, version: '9.9.9', extra: { kept: true } };
        server.failNext(convertedJson(json));
        expect(dataOf(await client.convertDocument(PDF)).document).toEqual(json as unknown as DoclingDocument);
    });

    test('returns document and server warnings on partial success response', async () => {
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

    test('maps failed conversion response to conversion_failed error', async () => {
        const { client } = setup();
        const error = errorOf(await client.convertDocument(BROKEN_PDF));
        expect(error).toMatchObject({
            code: 'conversion_failed',
            message: 'Conversion failed (Mock: input is not a valid PDF)',
            versions: MOCK_VERSIONS,
        });
    });

    test('returns invalid_response when json_content is missing or malformed', async () => {
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

    test('propagates HTTP and network errors during document conversion', async () => {
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
    test('attaches server versions to results and filters out non-string values', async () => {
        const { server, client } = setup();
        server.failNext(converted('x'));
        server.failNext(Response.json({ docling: '2.130.0', 'docling-parse': 7, extra: null }));
        const res = await client.convertMarkdown(PDF);
        expect(dataOf(res).versions).toEqual({ docling: '2.130.0' });
        expect(sentPaths(server)).toEqual(['/v1/convert/file', '/version']);
    });

    test('sets versions to null and preserves conversion success when version endpoint fails', async () => {
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

    test('caches server versions per client across concurrent requests', async () => {
        const { server, client } = setup();
        const results = await Promise.all([client.convertMarkdown(PDF), client.convertDocument(PDF)]);
        await client.convertMarkdown(PDF);
        expect(results.map((res) => (res.ok ? res.data.versions : undefined))).toEqual([MOCK_VERSIONS, MOCK_VERSIONS]);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(1);
        const other = createDoclingClient({ baseUrl: BASE_URL, fetch: server.fetch });
        await other.convertMarkdown(PDF);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(2);
    });

    test('retries fetching versions on subsequent calls when initial request fails', async () => {
        const { server, client } = setup();
        server.failNext(converted('x'));
        server.failNext(new Response('', { status: 503 }));
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toBeNull();
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toEqual(MOCK_VERSIONS);
        expect(dataOf(await client.convertMarkdown(PDF)).versions).toEqual(MOCK_VERSIONS);
        expect(sentPaths(server).filter((path) => path === '/version')).toHaveLength(2);
    });

    test('times out hanging version request after two seconds without failing conversion', async () => {
        const server = createMockDoclingServer();
        /** Stalls only the /version route indefinitely. */
        async function hangOnVersion(url: string | URL | Request, init?: RequestInit) {
            return String(url).endsWith('/version') ? new Promise<Response>(() => {}) : server.fetch(url, init);
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: hangOnVersion as typeof fetch, timeoutMs: 50 });
        const started = performance.now();
        const res = await client.convertMarkdown(PDF);
        const elapsed = performance.now() - started;
        expect(dataOf(res).versions).toBeNull();
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThan(3500);
    });

    test('completes version request even if caller signal aborts after conversion completes', async () => {
        const server = createMockDoclingServer();
        const controller = new AbortController();
        /** Aborts controller immediately after conversion route completes. */
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

    test('includes versions in error results only when server responded', async () => {
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

describe('submit and check', () => {
    test('submits markdown job and polls status through queued, running, and done states', async () => {
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
                settings: { ...MD_SETTINGS, imageExportMode: 'embedded', includeImages: true },
            },
        });
        const stored: MarkdownJob = JSON.parse(JSON.stringify(dataOf(job)));
        const [queued, running, done] = await checkUntilDone(client, stored);
        expect(queued).toEqual({ ok: true, data: { status: 'queued', position: 1 } });
        expect(running).toEqual({ ok: true, data: { status: 'running' } });
        const result = doneOf(done as Result<JobState<ConvertedMarkdown>>);
        expect('settings' in result).toBe(false);
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

    test('preserves resolved image options on markdown job with omitSmall defaulting to true', async () => {
        const { client } = setup();
        const job = dataOf(await client.submitMarkdown(PDF, { images: 'extract', imageOptions: { prefix: PREFIX } }));
        expect(job.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } });
        expect(dataOf(await client.submitMarkdown(PDF)).output).toEqual({ images: 'placeholder' });
    });

    test('applies image processing options stored in the job during check', async () => {
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

    test('submits document job and returns converted document upon completion', async () => {
        const { server, client } = setup();
        const job = await client.submitDocument(PDF, { images: 'placeholder' });
        expect(job).toEqual({
            ok: true,
            data: {
                kind: 'document',
                id: 'mock-task-1',
                settings: { ...DOC_SETTINGS, imageExportMode: 'placeholder', includeImages: false },
            },
        });
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

    test('returns extracted page images for document job submitted with pageImages', async () => {
        const { client } = setup();
        const job = dataOf(await client.submitDocument(PDF, { pageImages: true, images: 'placeholder' }));
        expect(job).toEqual({
            kind: 'document',
            id: 'mock-task-1',
            settings: { ...DOC_SETTINGS, includeImages: false, includePageImages: true },
        });
        const done = doneOf((await checkUntilDone(client, job))[2] as Result<JobState<ConvertedDocument>>);
        expect(done.pageImages.map(({ page, width, height }) => [page, width, height])).toEqual([
            [1, 1190, 1684],
            [2, 1190, 1684],
        ]);
        expect(Object.values(done.document.pages).every((item) => item.image === null)).toBe(true);
    });

    test('returns invalid_response when completed document task has no DoclingDocument', async () => {
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

    test('maps task result with conversion failure to conversion_failed error with details', async () => {
        const { client } = setup();
        const jobs = [dataOf(await client.submitMarkdown(BROKEN_PDF)), dataOf(await client.submitDocument(BROKEN_PDF))];
        for (const job of jobs) {
            const done = (await checkUntilDone(client, job)).at(-1) as Result<unknown>;
            expect(errorOf(done)).toEqual(BROKEN_PDF_ERROR);
        }
    });

    test('maps worker task failure to conversion_failed error with task error message', async () => {
        const { server, client } = setup();
        const jobs = [dataOf(await client.submitMarkdown(CRASH_PDF)), dataOf(await client.submitDocument(CRASH_PDF))];
        for (const job of jobs) {
            const done = (await checkUntilDone(client, job)).at(-1) as Result<unknown>;
            expect(errorOf(done)).toEqual({
                code: 'conversion_failed',
                message: `Conversion failed (${WORKER_ERROR_MESSAGE})`,
                details: { errors: [], failure: null },
                versions: MOCK_VERSIONS,
            });
        }
        expect(sentPaths(server).filter((path) => path.startsWith('/v1/result'))).toEqual([]);
    });

    test('parses task failure reasons from failure object, error message, or status', async () => {
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

    test('handles completed tasks whose result failed, expired, or encountered server errors', async () => {
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

    test('emits undecodable image warnings when completed extract job finishes', async () => {
        const { server, client } = setup();
        server.failNext(task('success'));
        server.failNext(converted('![Image](data:image/png;base64,a=b)'));
        const job: JobRef = {
            kind: 'markdown',
            id: 't-1',
            output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } },
        };
        const done = doneOf(await client.check(job));
        expect(done.markdown).toBe('');
        expect(done.warnings.map((warning) => warning.code)).toEqual(['image_not_decoded']);
    });

    test('returns not_found when task result expires between status poll and result retrieval', async () => {
        const { server, client } = setup();
        const job = dataOf(await client.submitDocument(PDF));
        await checkUntilDone(client, job);
        server.failNext(task('success'));
        server.failNext(Response.json({ detail: 'Task result not found.' }, { status: 404 }));
        expect(errorOf(await client.check(job))?.message).toBe(
            'Result already fetched or expired: mock-task-1; resubmit the PDF (HTTP 404: Task result not found.)',
        );
    });

    test('handles unknown job IDs, unexpected task statuses, invalid payloads, and network failures', async () => {
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

    test('rejects invalid job objects with invalid_input before making a request', async () => {
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

    test('rejects invalid check options with a TypeError before validating job object', async () => {
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

    test('accepts document job with additional fields using only kind and id', async () => {
        const { server, client } = setup();
        server.failNext(task('started'));
        const job = { kind: 'document', id: 't-1', output: 'ignored' } as unknown as Job;
        expect(await client.check(job)).toEqual({ ok: true, data: { status: 'running' } });
        expect(sentPaths(server)).toEqual(['/v1/status/poll/t-1']);
    });

    test('handles HTTP errors, network failures, and missing task IDs during job submission', async () => {
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

    test('rejects unusable or invalid task IDs returned by submit endpoint', async () => {
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

    test('preserves server detail message when check encounters HTTP 404', async () => {
        const { server, client } = setup();
        server.failNext(Response.json({ detail: 'Not Found' }, { status: 404 }));
        expect(errorOf(await client.check(MD_JOB))?.message).toBe('Unknown job id: t-1 (HTTP 404: Not Found)');
    });

    test('returns invalid_input when input cannot be prepared for upload', async () => {
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

    test('uploads typed array views and SharedArrayBuffer-backed inputs with exact byte content', async () => {
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

describe('job helpers', () => {
    test('runMarkdown resolves identical result to convertMarkdown via submit, polling, and retrieval', async () => {
        const options = { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } } as const;
        const sync = await setup().client.convertMarkdown(PDF, options);
        const { server, client } = setup();
        const res = await client.runMarkdown(PDF, { ...options, pollMs: 1 });
        expect(res).toEqual(sync);
        expect('status' in dataOf(res)).toBe(false);
        expect(sentPaths(server)).toEqual([
            '/v1/convert/file/async',
            '/v1/status/poll/mock-task-1',
            '/v1/status/poll/mock-task-1',
            '/v1/status/poll/mock-task-1',
            '/v1/result/mock-task-1',
            '/version',
        ]);
    });

    test('runDocument resolves identical result to convertDocument with extracted page images', async () => {
        const options = { images: 'placeholder', pageImages: true, headingHierarchy: false } as const;
        const sync = await setup().client.convertDocument(PDF, options);
        const { client } = setup();
        const res = await client.runDocument(PDF, { ...options, pollMs: 1 });
        expect(res).toEqual(sync);
        const data = dataOf(res);
        expect('status' in data).toBe(false);
        expect(data.settings).toEqual({
            ...DOC_SETTINGS,
            includeImages: false,
            includePageImages: true,
            doPdfHeadingHierarchy: false,
        });
        expect(data.pageImages).toHaveLength(2);
    });

    test('waitForJob resolves completed result without status field for either job kind', async () => {
        const { server, client } = setup();
        const mdJob: MarkdownJob = JSON.parse(
            JSON.stringify(dataOf(await client.submitMarkdown(PDF, { images: 'none' }))),
        );
        const docJob = dataOf(await client.submitDocument(PDF));
        expect(await client.waitForJob(mdJob, { pollMs: 1 })).toEqual({
            ok: true,
            data: {
                markdown: DEFAULT_MARKDOWN.replaceAll('<!-- image -->\n\n', ''),
                images: [],
                warnings: [],
                versions: MOCK_VERSIONS,
            },
        });
        const { settings: _settings, ...stored } = docJob;
        const doc = dataOf(await client.waitForJob(stored, { pollMs: 1 }));
        expect(doc.document.schema_name).toBe('DoclingDocument');
        expect('status' in doc || 'settings' in doc).toBe(false);
        const polls = sentPaths(server).filter((path) => path.startsWith('/v1/status/poll/'));
        expect(polls).toHaveLength(6);
    });

    test('executes first status check immediately and polls with delay only while queued or running', async () => {
        const { server, client } = setup({ pollMs: 60_000 });
        server.failNext(task('success'));
        server.failNext(converted('done'));
        const started = performance.now();
        expect(dataOf(await client.waitForJob(MD_JOB)).markdown).toBe('done');
        server.failNext(Response.json({ task_id: 't-1', task_status: 'pending' }));
        server.failNext(task('success'));
        server.failNext(converted('ran'));
        expect(dataOf(await client.runMarkdown(PDF)).markdown).toBe('ran');
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test('waits pollMs between status requests using call option or factory default', async () => {
        const { client } = setup({ pollMs: 40 });
        let started = performance.now();
        expect((await client.runDocument(PDF)).ok).toBe(true);
        // three polls, two waits of 40 ms
        expect(performance.now() - started).toBeGreaterThanOrEqual(75);
        const slow = setup({ pollMs: 60_000 }).client;
        started = performance.now();
        expect((await slow.runMarkdown(PDF, { pollMs: 1 })).ok).toBe(true);
        const job = dataOf(await slow.submitDocument(PDF));
        expect((await slow.waitForJob(job, { pollMs: 1 })).ok).toBe(true);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test('defaults to 10 ms polling interval between status requests', async () => {
        const { client } = setup();
        const started = performance.now();
        expect((await client.runMarkdown(PDF)).ok).toBe(true);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(18);
        expect(elapsed).toBeLessThan(1000);
    });

    test('resolves aborted immediately when abort signal triggers during polling delay', async () => {
        const { server, client } = setup();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30);
        const started = performance.now();
        const res = await client.runDocument(PDF, { pollMs: 60_000, signal: controller.signal });
        expect(errorOf(res)).toEqual({ code: 'aborted', message: 'Aborted while waiting for job mock-task-1' });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(sentPaths(server)).toEqual(['/v1/convert/file/async', '/v1/status/poll/mock-task-1']);
    });

    test('aborts execution when signal triggers after status response before next delay', async () => {
        const server = createMockDoclingServer();
        const controller = new AbortController();
        /** Aborts the caller signal once the first status answer has arrived. */
        async function abortAfterPoll(url: string | URL | Request, init?: RequestInit) {
            const res = await server.fetch(url, init);
            if (String(url).includes('/v1/status/poll/')) {
                controller.abort();
            }
            return res;
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: abortAfterPoll as typeof fetch });
        const res = await client.runMarkdown(PDF, { pollMs: 60_000, signal: controller.signal });
        expect(errorOf(res)).toEqual({ code: 'aborted', message: 'Aborted while waiting for job mock-task-1' });
        expect(sentPaths(server)).toEqual(['/v1/convert/file/async', '/v1/status/poll/mock-task-1']);
    });

    test('removes abort event listener from caller signal after each polling wait', async () => {
        const { client } = setup({ pollMs: 1 });
        const signal = new AbortController().signal;
        const added = spyOn(signal, 'addEventListener');
        const removed = spyOn(signal, 'removeEventListener');
        expect((await client.runDocument(PDF, { signal })).ok).toBe(true);
        /** Counts the abort listener calls in a spy's call list. */
        function waits(calls: unknown[][]) {
            return calls.filter(([type]) => type === 'abort').length;
        }
        // two waits between three polls; AbortSignal.any() may add listeners of its own, so compare only ours
        expect(waits(removed.mock.calls)).toBeGreaterThanOrEqual(2);
        expect(waits(added.mock.calls)).toBeGreaterThanOrEqual(waits(removed.mock.calls));
    });

    test('resolves aborted with caller error when aborted during an in-flight status request', async () => {
        const { server, client } = setup();
        const job = dataOf(await client.submitMarkdown(PDF));
        server.delayNext(60_000);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('stopped by caller', 'AbortError')), 30);
        const res = await client.waitForJob(job, { signal: controller.signal });
        expect(errorOf(res)).toEqual({ code: 'aborted', message: 'stopped by caller' });
    });

    test('applies timeoutMs per individual request rather than across entire polling helper', async () => {
        const { server, client } = setup({ timeoutMs: 50 });
        // every request answers within 50 ms, the whole call takes longer
        const started = performance.now();
        expect((await client.runMarkdown(PDF, { pollMs: 30 })).ok).toBe(true);
        expect(performance.now() - started).toBeGreaterThanOrEqual(55);
        const job = dataOf(await client.submitDocument(PDF));
        server.delayNext(5_000);
        expect(errorOf(await client.waitForJob(job))?.code).toBe('aborted');
    });

    test('returns conversion_failed with error details for broken PDF in run helpers', async () => {
        const { client } = setup({ pollMs: 1 });
        expect(errorOf(await client.runMarkdown(BROKEN_PDF))).toEqual(BROKEN_PDF_ERROR);
        expect(errorOf(await client.runDocument(BROKEN_PDF))).toEqual(BROKEN_PDF_ERROR);
    });

    test('returns conversion_failed with task error message on worker crash in run helpers', async () => {
        const { client } = setup({ pollMs: 1 });
        const error = errorOf(await client.runDocument(CRASH_PDF));
        expect(error).toEqual({
            code: 'conversion_failed',
            message: `Conversion failed (${WORKER_ERROR_MESSAGE})`,
            details: { errors: [], failure: null },
            versions: MOCK_VERSIONS,
        });
    });

    test('terminates polling loop immediately on first error without retrying', async () => {
        const { server, client } = setup({ pollMs: 1 });
        server.failNext(new Response('', { status: 503 }));
        expect(errorOf(await client.runMarkdown(PDF))).toEqual({
            code: 'http',
            message: 'HTTP 503: no response body',
            status: 503,
            versions: MOCK_VERSIONS,
        });
        expect(sentPaths(server).filter((path) => path.startsWith('/v1/'))).toEqual(['/v1/convert/file/async']);
        const job = dataOf(await client.submitDocument(PDF));
        server.failNext(task('pending'));
        server.failNext(new Response('', { status: 500 }));
        const before = server.requests.length;
        expect(errorOf(await client.waitForJob(job))?.code).toBe('http');
        // versions are cached by now: only the two status requests
        expect(sentPaths(server).slice(before)).toEqual(['/v1/status/poll/mock-task-1', '/v1/status/poll/mock-task-1']);
    });

    test('returns not_found for unknown job IDs and invalid_input for malformed job objects', async () => {
        const { server, client } = setup();
        expect(errorOf(await client.waitForJob({ kind: 'document', id: 'nope' }))).toEqual({
            code: 'not_found',
            message: 'Unknown job id: nope (HTTP 404: Task not found.)',
            status: 404,
            versions: MOCK_VERSIONS,
        });
        const before = server.requests.length;
        expect(errorOf(await client.waitForJob({ id: 't-1' } as unknown as Job))).toEqual({
            code: 'invalid_input',
            message: 'Expected the job object returned by submitMarkdown() or submitDocument()',
        });
        expect(server.requests.length).toBe(before);
    });

    test('validates job object once so subsequent caller mutations do not affect execution', async () => {
        const server = createMockDoclingServer();
        const job: { kind: string; id: string; output: { images: string } } = {
            kind: 'markdown',
            id: '',
            output: { images: 'none' },
        };
        /** Breaks the caller's job object after the first status answer. */
        async function mutateAfterPoll(url: string | URL | Request, init?: RequestInit) {
            const res = await server.fetch(url, init);
            if (String(url).includes('/v1/status/poll/')) {
                job.kind = 'garbage';
                job.id = 'not a valid id!';
                job.output.images = 'placeholder';
            }
            return res;
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: mutateAfterPoll as typeof fetch, pollMs: 1 });
        job.id = dataOf(await client.submitMarkdown(PDF, { images: 'none' })).id;
        const id = job.id;
        const done = dataOf(await client.waitForJob(job as unknown as MarkdownJob));
        // images: 'none' from the job as passed in, not 'placeholder' from the changed object
        expect(done.markdown).toBe(DEFAULT_MARKDOWN.replaceAll('<!-- image -->\n\n', ''));
        expect(sentPaths(server).filter((path) => path.startsWith('/v1/status/poll/'))).toEqual([
            `/v1/status/poll/${id}`,
            `/v1/status/poll/${id}`,
            `/v1/status/poll/${id}`,
        ]);
    });

    test('allows retrying result retrieval with a second waitForJob call after transient network error', async () => {
        const server = createMockDoclingServer();
        let resultRequests = 0;
        /** Breaks the first result download like a dropped connection. */
        async function flakyFetch(url: string | URL | Request, init?: RequestInit) {
            if (String(url).includes('/v1/result/') && resultRequests++ === 0) {
                throw new TypeError('connection reset');
            }
            return server.fetch(url, init);
        }
        const client = createDoclingClient({ baseUrl: BASE_URL, fetch: flakyFetch as typeof fetch, pollMs: 1 });
        const job = dataOf(await client.submitDocument(PDF));
        expect(errorOf(await client.waitForJob(job))).toEqual({ code: 'network', message: 'connection reset' });
        expect(dataOf(await client.waitForJob(job)).document.schema_name).toBe('DoclingDocument');
        expect(resultRequests).toBe(2);
    });

    test('rejects invalid helper options with a TypeError before sending requests', async () => {
        const { server, client } = setup();
        for (const pollMs of [0, 1.5, '10', 2 ** 31, null]) {
            const error = new TypeError('Invalid value for option "pollMs"');
            await expect(client.runMarkdown(PDF, { pollMs } as never)).rejects.toThrow(error);
            await expect(client.runDocument(PDF, { pollMs } as never)).rejects.toThrow(error);
            await expect(client.waitForJob(MD_JOB, { pollMs } as never)).rejects.toThrow(error);
        }
        await expect(client.waitForJob(DOC_JOB, { images: 'none' } as never)).rejects.toThrow(
            new TypeError('Option "images" is not supported'),
        );
        await expect(client.waitForJob({ id: 1 } as never, 'x' as never)).rejects.toThrow(
            new TypeError('Invalid options: expected an object'),
        );
        await expect(client.runDocument(PDF, { images: 'none', pollMs: 5 } as never)).rejects.toThrow(
            new TypeError('Invalid value for option "images"'),
        );
        const notSupported = new TypeError('Option "pollMs" is not supported');
        await expect(client.convertMarkdown(PDF, { pollMs: 10 } as never)).rejects.toThrow(notSupported);
        await expect(client.convertDocument(PDF, { pollMs: 10 } as never)).rejects.toThrow(notSupported);
        await expect(client.submitMarkdown(PDF, { pollMs: 10 } as never)).rejects.toThrow(notSupported);
        await expect(client.submitDocument(PDF, { pollMs: 10 } as never)).rejects.toThrow(notSupported);
        await expect(client.check(MD_JOB, { pollMs: 10 } as never)).rejects.toThrow(notSupported);
        await expect(client.capabilities({ pollMs: 10 } as never)).rejects.toThrow(notSupported);
        expect(server.requests).toHaveLength(0);
    });
});

describe('capabilities', () => {
    test('fetches server capabilities and maps snake_case properties to camelCase', async () => {
        const { server, client } = setup({ apiKey: 'secret' }, { apiKey: 'secret' });
        const res = await client.capabilities();
        expect(res).toEqual({ ok: true, data: EXPECTED_CAPABILITIES });
        expect(sentPaths(server)).toEqual(['/v1/capabilities']);
        expect(server.requests[0]?.headers.get('X-Api-Key')).toBe('secret');
    });

    test('safely parses capabilities payload with missing, extra, or mistyped fields', async () => {
        const { server, client } = setup();
        server.failNext(
            Response.json({
                versions: { docling: '2.140.0', skipped: 1 },
                stages: {
                    ocr: {
                        option: 'ocr_preset',
                        custom_config_option: 'ocr_custom',
                        default: 'auto',
                        presets: [
                            { id: 'auto', name: 'auto', description: 'default ocr', source: 'docling' },
                            { id: 'bare' },
                            { name: 'missing-id' },
                            null,
                        ],
                    },
                    broken: null,
                },
                sources: ['file', 42],
                targets: null,
                output_formats: 'not-an-array',
                limits: { max_images_scale: Number.NaN, max_num_pages: 100 },
                features: { websocket: 'yes', api_key_required: true },
            }),
        );
        expect(dataOf(await client.capabilities())).toEqual({
            versions: { docling: '2.140.0' },
            stages: {
                ocr: {
                    option: 'ocr_preset',
                    customConfigOption: 'ocr_custom',
                    default: 'auto',
                    presets: [
                        { id: 'auto', name: 'auto', description: 'default ocr', source: 'docling' },
                        { id: 'bare', name: '', description: null, source: '' },
                    ],
                },
                broken: { option: '', customConfigOption: null, default: '', presets: [] },
            },
            sources: ['file'],
            targets: { allowed: [], default: '' },
            outputFormats: [],
            imageExportModes: [],
            limits: {
                maxDocumentTimeout: null,
                maxImagesScale: null,
                maxSourcesPerRequest: null,
                maxNumPages: 100,
                maxFileSize: null,
            },
            features: { apiKeyRequired: true, artifactStorage: false, websocket: false },
        });
    });

    test('handles non-object capabilities body as invalid_response and propagates HTTP and abort errors', async () => {
        const { server, client } = setup();
        for (const body of [null, 'x', [1]]) {
            server.failNext(Response.json(body));
            expect(errorOf(await client.capabilities())).toEqual({
                code: 'invalid_response',
                message: 'Capabilities response is not a JSON object',
                versions: MOCK_VERSIONS,
            });
        }
        server.failNext(Response.json({ detail: 'Not Found' }, { status: 404 }));
        expect(errorOf(await client.capabilities())).toEqual({
            code: 'http',
            message: 'HTTP 404: Not Found',
            status: 404,
            versions: MOCK_VERSIONS,
        });
        expect(errorOf(await client.capabilities({ signal: AbortSignal.abort() }))?.code).toBe('aborted');
    });

    test('rejects invalid options with a TypeError before sending capabilities request', async () => {
        const { server, client } = setup();
        await expect(client.capabilities({ invalid: true } as never)).rejects.toThrow(
            new TypeError('Option "invalid" is not supported'),
        );
        await expect(client.capabilities('bad' as never)).rejects.toThrow(
            new TypeError('Invalid options: expected an object'),
        );
        expect(server.requests).toHaveLength(0);
    });
});

describe('mock server', () => {
    test('returns HTTP 422 validation error for invalid form fields', async () => {
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

    test('handles health, version, unknown routes, missing tasks, and pending results', async () => {
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

    test('populates only the requested to_formats in conversion response', async () => {
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

    test('simulates task success with failed result body for broken PDF conversion', async () => {
        const server = createMockDoclingServer();
        const polls = await pollMockTask(server, BROKEN_PDF);
        expect(polls.map((poll) => poll.task_status)).toEqual(['pending', 'started', 'success']);
        expect(polls[2]).toMatchObject({ error_message: null });
        const result = await (await server.fetch(`${BASE_URL}/v1/result/mock-task-1`)).json();
        expect(result).toMatchObject({
            status: 'failure',
            document: { md_content: null, json_content: null },
            errors: [{ error_message: 'Mock: input is not a valid PDF' }],
        });
    });

    test('reports task failure with error message and stores no result when worker crashes', async () => {
        const server = createMockDoclingServer();
        const polls = await pollMockTask(server, CRASH_PDF);
        expect(polls.map((poll) => poll.task_status)).toEqual(['pending', 'started', 'failure']);
        expect(polls[2]).toMatchObject({ error_message: WORKER_ERROR_MESSAGE });
        const result = await server.fetch(`${BASE_URL}/v1/result/mock-task-1`);
        expect([result.status, await result.json()]).toEqual([404, { detail: NO_RESULT_DETAIL }]);
    });

    test('delays next request response and rejects promptly if signal is aborted during delay', async () => {
        const server = createMockDoclingServer();
        server.delayNext(30);
        const started = performance.now();
        expect((await server.fetch(`${BASE_URL}/health`)).status).toBe(200);
        expect(performance.now() - started).toBeGreaterThanOrEqual(25);
        server.delayNext(10_000);
        const controller = new AbortController();
        const pending = server.fetch(`${BASE_URL}/health`, { signal: controller.signal });
        controller.abort(new DOMException('stop', 'AbortError'));
        await expect(pending).rejects.toThrow('stop');
        expect((await server.fetch(`${BASE_URL}/health`)).status).toBe(200);
    });

    test('rejects immediately when delayNext encounters an already-aborted signal', async () => {
        const server = createMockDoclingServer();
        server.delayNext(60_000);
        const started = performance.now();
        const signal = AbortSignal.abort(new DOMException('gone', 'AbortError'));
        await expect(server.fetch(`${BASE_URL}/health`, { signal })).rejects.toThrow('gone');
        expect(performance.now() - started).toBeLessThan(1_000);
        // the delay was used up by the aborted request
        expect((await server.fetch(`${BASE_URL}/health`)).status).toBe(200);
    });

    test('generates DoclingDocument with valid bidirectional child-parent references', () => {
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

    test('includes picture data only when image_export_mode is embedded and include_images is true', () => {
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

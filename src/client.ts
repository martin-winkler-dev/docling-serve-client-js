// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { readCapabilities } from './capabilities.js';
import { errorMessage, fetchJson } from './core/http.js';
import { detectInputFormat, type InputFormat } from './core/input.js';
import { findTruncatedXref } from './core/pdf.js';
import { ERR, fail, ok } from './core/result.js';
import { PAGE_IMAGE_SCALE } from './images.js';
import {
    isJobId,
    type ResolvedOptions,
    resolveCheckOptions,
    resolveConfig,
    resolveDocumentCall,
    resolveMarkdownCall,
    validateJob,
} from './options.js';
import { type DoclingFailureInfo, readDocument, readFailure, readMarkdown, readText } from './response.js';
import type {
    ConvertError,
    ConvertedDocument,
    ConvertedMarkdown,
    ConvertInput,
    DoclingClient,
    DoclingConfig,
    DoclingSettings,
    DocumentJob,
    JobRef,
    JobState,
    MarkdownJob,
    Result,
    ServerCapabilities,
    ServerVersions,
    WithSettings,
} from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

// biome-ignore-start lint/style/useNamingConvention: mirrors docling-serve's snake_case JSON
/** Task status payload of docling-serve's submit and poll endpoints. */
type DoclingTaskStatus = {
    task_id?: unknown;
    task_status?: unknown;
    task_position?: unknown;
    error_message?: unknown;
    failure?: DoclingFailureInfo | null;
};
// biome-ignore-end lint/style/useNamingConvention: mirrors docling-serve's snake_case JSON

/** Output format sent as `to_formats`, with its image fields. */
type FormatFields = {
    format: 'md' | 'json';
    /** Asks docling for base64 picture data (`image_export_mode=embedded`, `include_images=true`). */
    embedImages: boolean;
    /** Asks docling for base64 page images (`image_export_mode=embedded`, `include_page_images=true`). */
    pageImages: boolean;
};

/** Parsed JSON answer of a conversion POST, with the settings its form was built from. */
type Posted = {
    body: unknown;
    settings: DoclingSettings;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Table structure model; pinned so the server's fallback preset cannot change table output. */
const TABLE_STRUCTURE_PRESET = 'tableformer_v1_accurate';

/** Model of `pipeline: 'vlm'`. */
const VLM_PIPELINE_PRESET = 'granite_docling';

/** Model of `chartExtraction`. */
const CHART_EXTRACTION_PRESET = 'granite_vision_v4';

/** Model of `formulaEnrichment` and `codeEnrichment`. */
const CODE_FORMULA_PRESET = 'codeformulav2';

/** Matches each upper-case letter of a camelCase settings key, for its snake_case form field name. */
const MATCH_UPPER_CASE = /[A-Z]/g;

/** Error message for missing, empty or unrecognized input bytes. */
const INVALID_INPUT = 'Expected a non-empty PDF, PNG, JPEG, TIFF or WebP as Uint8Array';

/** Error codes of requests the server answered; only these get server versions. */
const SERVER_ANSWERED: ReadonlySet<ConvertError['code']> = new Set([
    'http',
    'not_found',
    'conversion_failed',
    'invalid_response',
]);

/** Time limit for the `/version` request; a slower server gets `versions: null`. */
const VERSION_TIMEOUT_MS = 2000;

/** Characters of an unusable task id quoted in the error message. */
const MAX_SHOWN_ID_LENGTH = 100;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **docling-serve client factory**.
 *
 * - validates configuration once; its only state is the cached server versions
 * - returned functions resolve to `Result`; invalid options reject with a `TypeError` before any request
 * - `timeoutMs` limits every request except `/version`, which has its own limit
 * @throws `TypeError` on invalid configuration.
 */
export function createDoclingClient(config: DoclingConfig): DoclingClient {
    const { baseUrl, apiKey, fetch: fetchFn, timeoutMs, defaults } = resolveConfig(config);
    const headers: Record<string, string> = apiKey === undefined ? {} : { 'X-Api-Key': apiKey };
    /** Pending or resolved `/version` answer shared by all calls of this client. */
    let versionsCache: Promise<ServerVersions | null> | undefined;

    return {
        convertMarkdown,
        convertDocument,
        submitMarkdown,
        submitDocument,
        check: check as DoclingClient['check'],
        capabilities,
    };

    /** Converts PDF or image bytes to md in one request. */
    async function convertMarkdown(
        input: ConvertInput,
        options?: unknown,
    ): Promise<Result<WithSettings<ConvertedMarkdown>>> {
        const call = resolveMarkdownCall(defaults, options);
        const fields: FormatFields = { format: 'md', embedImages: call.output.images === 'extract', pageImages: false };
        const res = await post('/v1/convert/file', input, call.options, fields, call.signal);
        if (!res.ok) {
            return res;
        }
        const converted = await withVersions<ConvertedMarkdown>(readMarkdown(res.data.body, call.output));
        return converted.ok ? ok({ ...converted.data, settings: res.data.settings }) : converted;
    }

    /** Converts PDF or image bytes to a DoclingDocument in one request. */
    async function convertDocument(
        input: ConvertInput,
        options?: unknown,
    ): Promise<Result<WithSettings<ConvertedDocument>>> {
        const call = resolveDocumentCall(defaults, options);
        const fields: FormatFields = {
            format: 'json',
            embedImages: call.images === 'embedded',
            pageImages: call.pageImages,
        };
        const res = await post('/v1/convert/file', input, call.options, fields, call.signal);
        if (!res.ok) {
            return res;
        }
        const converted = await withVersions<ConvertedDocument>(readDocument(res.data.body));
        return converted.ok ? ok({ ...converted.data, settings: res.data.settings }) : converted;
    }

    /** Starts an async md conversion; the job carries the image handling for `check` and the sent settings. */
    async function submitMarkdown(input: ConvertInput, options?: unknown): Promise<Result<MarkdownJob>> {
        const call = resolveMarkdownCall(defaults, options);
        const fields: FormatFields = { format: 'md', embedImages: call.output.images === 'extract', pageImages: false };
        const task = await submit(input, call.options, fields, call.signal);
        return task.ok
            ? ok({ kind: 'markdown', id: task.data.id, output: call.output, settings: task.data.settings })
            : task;
    }

    /** Starts an async document conversion; page images need no job field, `check` moves any it finds. */
    async function submitDocument(input: ConvertInput, options?: unknown): Promise<Result<DocumentJob>> {
        const call = resolveDocumentCall(defaults, options);
        const fields: FormatFields = {
            format: 'json',
            embedImages: call.images === 'embedded',
            pageImages: call.pageImages,
        };
        const task = await submit(input, call.options, fields, call.signal);
        return task.ok ? ok({ kind: 'document', id: task.data.id, settings: task.data.settings }) : task;
    }

    /**
     * **Polls a job and fetches its result when done**.
     *
     * - unknown job id: `not_found` with `Unknown job id`
     * - result fetched more than `DOCLING_SERVE_RESULT_REMOVAL_DELAY` (default 300 s) ago or expired: `not_found` with
     *   `Result already fetched or expired`
     */
    async function check(
        job: JobRef,
        options?: unknown,
    ): Promise<Result<JobState<ConvertedMarkdown | ConvertedDocument>>> {
        const { signal } = resolveCheckOptions(options);
        const valid = validateJob(job);
        if (!valid.ok) {
            return valid;
        }
        const { id } = valid.data;
        const res = await get(`/v1/status/poll/${id}`, signal);
        if (!res.ok) {
            const error =
                res.error.status === 404 ? ERR.NOT_FOUND(`Unknown job id: ${id} (${res.error.message})`) : res.error;
            return failWithVersions(error);
        }
        const task = (res.data ?? {}) as DoclingTaskStatus;
        switch (task.task_status) {
            case 'pending': {
                const position = typeof task.task_position === 'number' ? task.task_position : null;
                return ok({ status: 'queued', position });
            }
            case 'started':
                return ok({ status: 'running' });
            case 'success':
            case 'partial_success': {
                const result = await get(`/v1/result/${id}`, signal);
                if (!result.ok) {
                    const error =
                        result.error.status === 404
                            ? ERR.NOT_FOUND(
                                  `Result already fetched or expired: ${id}; resubmit the PDF (${result.error.message})`,
                              )
                            : result.error;
                    return failWithVersions(error);
                }
                const checked = valid.data;
                const output =
                    checked.kind === 'markdown' ? readMarkdown(result.data, checked.output) : readDocument(result.data);
                const done = await withVersions<ConvertedMarkdown | ConvertedDocument>(output);
                return done.ok ? ok({ status: 'done', ...done.data }) : done;
            }
            case 'failure':
            case 'skipped': {
                const reason =
                    readText(task.failure?.message) ?? readText(task.error_message) ?? `status: ${task.task_status}`;
                const details = { errors: [], failure: readFailure(task.failure) };
                return failWithVersions(ERR.CONVERSION_FAILED(reason, details));
            }
            default:
                return failWithVersions(ERR.INVALID_RESPONSE(`Unexpected task status: ${String(task.task_status)}`));
        }
    }

    /**
     * **Queries `GET /v1/capabilities` on demand**.
     *
     * - older servers without the endpoint answer `http` (404)
     */
    async function capabilities(options?: unknown): Promise<Result<ServerCapabilities>> {
        const { signal } = resolveCheckOptions(options);
        const res = await get('/v1/capabilities', signal);
        if (!res.ok) {
            return failWithVersions(res.error);
        }
        const read = readCapabilities(res.data);
        return read.ok ? read : failWithVersions(read.error);
    }

    /** Posts the input to the async endpoint; resolves to the task id and the sent settings. */
    async function submit(
        input: ConvertInput,
        options: ResolvedOptions,
        fields: FormatFields,
        signal: AbortSignal | undefined,
    ): Promise<Result<{ id: string; settings: DoclingSettings }>> {
        const res = await post('/v1/convert/file/async', input, options, fields, signal);
        if (!res.ok) {
            return res;
        }
        const id: unknown = (res.data.body as DoclingTaskStatus | null)?.task_id;
        if (readText(id) === undefined) {
            return failWithVersions(ERR.INVALID_RESPONSE('Response has no task_id'));
        }
        if (!isJobId(id)) {
            const shown = JSON.stringify(id).slice(0, MAX_SHOWN_ID_LENGTH);
            return failWithVersions(ERR.INVALID_RESPONSE(`Response has an unusable task_id: ${shown}`));
        }
        return ok({ id, settings: res.data.settings });
    }

    /** Detects and checks the input format, then sends a multipart POST with timeout; errors already carry versions. */
    async function post(
        route: string,
        input: ConvertInput,
        options: ResolvedOptions,
        fields: FormatFields,
        signal: AbortSignal | undefined,
    ): Promise<Result<Posted>> {
        const format = readInputFormat(input);
        if (!format.ok) {
            return format;
        }
        const settings = buildSettings(format.data, options, fields);
        let body: FormData;
        try {
            body = buildFormData(input, format.data, settings);
        } catch (error) {
            return fail(ERR.INVALID_INPUT(`Input could not be prepared for upload: ${errorMessage(error)}`));
        }
        const limited = withTimeout(signal, timeoutMs);
        const res = await fetchJson(fetchFn, `${baseUrl}${route}`, {
            method: 'POST',
            headers,
            body,
            ...(limited === undefined ? {} : { signal: limited }),
        });
        return res.ok ? ok({ body: res.data, settings }) : failWithVersions(res.error);
    }

    /** GET request; `limit: false` skips `timeoutMs` (used by `/version`). */
    function get(route: string, signal: AbortSignal | undefined, limit = true): Promise<Result<unknown>> {
        const limited = limit ? withTimeout(signal, timeoutMs) : signal;
        return fetchJson(fetchFn, `${baseUrl}${route}`, {
            headers,
            ...(limited === undefined ? {} : { signal: limited }),
        });
    }

    /** Adds server versions to a parsed result, or to its error if the server answered. */
    async function withVersions<T>(result: Result<Omit<T, 'versions'>>): Promise<Result<T>> {
        if (!result.ok) {
            return failWithVersions(result.error);
        }
        return ok({ ...result.data, versions: await fetchVersions() } as T);
    }

    /** Adds server versions to errors of requests the server answered; other errors stay as they are. */
    async function failWithVersions<T>(error: ConvertError): Promise<Result<T>> {
        return fail(SERVER_ANSWERED.has(error.code) ? { ...error, versions: await fetchVersions() } : error);
    }

    /**
     * **Server versions, fetched once per client and cached**.
     *
     * - concurrent calls share one request
     * - `null` (unreachable, timed out or empty) is not cached; the next call asks again
     */
    function fetchVersions(): Promise<ServerVersions | null> {
        versionsCache ??= requestVersions().then((versions) => {
            if (versions === null) {
                versionsCache = undefined;
            }
            return versions;
        });
        return versionsCache;
    }

    /**
     * **Queries `/version` with its own timeout**.
     *
     * - ignores the caller signal, so aborting after the conversion does not fail the result
     * - resolves `null` after `VERSION_TIMEOUT_MS` even if `fetch` ignores the timeout signal
     */
    async function requestVersions(): Promise<ServerVersions | null> {
        const timeout = AbortSignal.timeout(VERSION_TIMEOUT_MS);
        const timedOut = new Promise<null>((resolve) => {
            timeout.addEventListener('abort', () => resolve(null), { once: true });
        });
        const res = await Promise.race([get('/version', timeout, false), timedOut]);
        if (res === null || !res.ok || res.data === null || typeof res.data !== 'object') {
            return null;
        }
        const versions = Object.entries(res.data).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        );
        return versions.length === 0 ? null : Object.fromEntries(versions);
    }
}

// -------------------------------------------------------------------
// --- 4. Internal Functions
// -------------------------------------------------------------------

/** Caller signal combined with a `timeoutMs` limit; either alone when the other is unset. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
    if (timeoutMs === undefined) {
        return signal;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * **Input format by magic bytes; PDFs are also checked for truncation**.
 *
 * - unrecognized bytes or a truncated PDF: `invalid_input`
 */
function readInputFormat(input: unknown): Result<InputFormat> {
    const format = detectInputFormat(input);
    if (format === undefined) {
        return fail(ERR.INVALID_INPUT(INVALID_INPUT));
    }
    const bytes = input as Uint8Array;
    const offset = format.fromFormat === 'pdf' ? findTruncatedXref(bytes) : undefined;
    return offset === undefined
        ? ok(format)
        : fail(
              ERR.INVALID_INPUT(
                  `PDF is truncated: cross-reference offset ${offset} lies past the end of the file (${bytes.length} bytes)`,
              ),
          );
}

/**
 * **Every form field of a conversion request, as typed settings**.
 *
 * - md: `md_compact_tables=true`, empty page break placeholder; json sends neither
 * - images: `image_export_mode=embedded` when picture data or page images are requested, else `placeholder`;
 *   `include_images` and `include_page_images` pick which data docling sends
 * - `images_scale` fixed at `PAGE_IMAGE_SCALE`; it sets picture and page image resolution only, OCR has its own scale
 * - image input: OCR always on and never full-page, whatever `ocr` and `forceOcr` say
 * - model presets pinned; a preset of a disabled stage is not sent
 * - fields docling-serve would default silently are sent with that default
 */
function buildSettings(
    { fromFormat }: InputFormat,
    options: ResolvedOptions,
    { format, embedImages, pageImages }: FormatFields,
): DoclingSettings {
    // Image has no text layer: without OCR it yields no text, and full-page OCR merges words.
    const isImage = fromFormat === 'image';
    const isMarkdown = format === 'md';
    return {
        fromFormats: fromFormat,
        toFormats: format,
        imageExportMode: embedImages || pageImages ? 'embedded' : 'placeholder',
        includeImages: embedImages,
        includePageImages: pageImages,
        imagesScale: PAGE_IMAGE_SCALE,
        mdCompactTables: isMarkdown ? true : null,
        mdPageBreakPlaceholder: isMarkdown ? '' : null,
        doOcr: isImage || options.ocr,
        forceOcr: !isImage && options.forceOcr,
        ocrPreset: options.ocrEngine,
        ocrLang: [...(options.ocrLang ?? [])],
        pdfBackend: options.pdfBackend,
        pipeline: options.pipeline,
        vlmPipelinePreset: options.pipeline === 'vlm' ? VLM_PIPELINE_PRESET : null,
        doTableStructure: true,
        tableMode: 'accurate',
        tableStructurePreset: TABLE_STRUCTURE_PRESET,
        tableCellMatching: true,
        doPdfHeadingHierarchy: options.headingHierarchy,
        doFormulaEnrichment: options.formulaEnrichment,
        doCodeEnrichment: options.codeEnrichment,
        codeFormulaPreset: options.formulaEnrichment || options.codeEnrichment ? CODE_FORMULA_PRESET : null,
        doChartExtraction: options.chartExtraction,
        chartExtractionPreset: options.chartExtraction ? CHART_EXTRACTION_PRESET : null,
        doPictureClassification: false,
        doPictureDescription: false,
        pageRange: options.pageRange === undefined ? null : [options.pageRange[0], options.pageRange[1]],
        documentTimeout: options.documentTimeout ?? null,
        abortOnError: false,
    };
}

/**
 * **Builds the multipart body from the settings, so sent fields and returned settings cannot differ**.
 *
 * - field name: settings key in snake_case (`ocrPreset` → `ocr_preset`)
 * - `null` not sent; lists as repeated fields (empty list: not sent); booleans and numbers as strings
 * - input: file name and MIME type matching `from_formats`
 */
function buildFormData(input: ConvertInput, { mimeType, fileName }: InputFormat, settings: DoclingSettings): FormData {
    const form = new FormData();
    // Blob does not accept SharedArrayBuffer-backed input: copy only that into a fresh ArrayBuffer.
    const bytes = input.buffer instanceof ArrayBuffer ? (input as Uint8Array<ArrayBuffer>) : new Uint8Array(input);
    form.append('files', new Blob([bytes], { type: mimeType }), fileName);
    for (const [key, value] of Object.entries(settings)) {
        const name = key.replace(MATCH_UPPER_CASE, (letter) => `_${letter.toLowerCase()}`);
        for (const item of value === null ? [] : Array.isArray(value) ? value : [value]) {
            form.append(name, String(item));
        }
    }
    return form;
}

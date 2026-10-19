// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { ERR, fail, ok } from './core/result.js';
import { isPlainObject } from './core/validate.js';
import type { DoclingDocument } from './document.js';
import { extractImages, extractPageImages, removeImagePlaceholders } from './images.js';
import type {
    ConversionFailure,
    ConvertedDocument,
    ConvertedMarkdown,
    MarkdownJobOutput,
    MarkdownWarning,
    Result,
    ServerWarning,
    TaskFailure,
} from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

// biome-ignore-start lint/style/useNamingConvention: mirrors docling-serve's snake_case JSON
/** Untrusted subset of docling-serve conversion response payload. */
type DoclingConvertResponse = {
    status?: unknown;
    document?: { md_content?: unknown; json_content?: unknown } | null;
    errors?: (DoclingErrorItem | null)[];
    failure?: DoclingFailureInfo | null;
};

/** Untrusted docling `PublicFailureInfo` of a failed task. */
export type DoclingFailureInfo = {
    message?: unknown;
    category?: unknown;
    phase?: unknown;
    retryable?: unknown;
};

/** Untrusted docling `ErrorItem`; `category` and `page_no` only in newer docling. */
type DoclingErrorItem = {
    error_message?: unknown;
    component_type?: unknown;
    module_name?: unknown;
    category?: unknown;
    page_no?: unknown;
};
// biome-ignore-end lint/style/useNamingConvention: mirrors docling-serve's snake_case JSON

/** Successful conversion: status, untrusted document payload, docling's non-fatal errors and failure info. */
type ServerOutput = {
    status: 'success' | 'partial_success';
    document: NonNullable<DoclingConvertResponse['document']>;
    warnings: ServerWarning[];
    /** Failure message docling sent along; `undefined` if none. */
    failureMessage: string | undefined;
    failure: TaskFailure | null;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Matches older docling's page error `Page 1 failed to parse.`; group 1: 0-based page index. */
const MATCH_FAILED_PAGE = /^Page (\d+) failed to parse\./;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Reads `md_content` and applies the image handling**.
 *
 * - `'extract'`: embedded images become `images` and file links; `'none'`: placeholders removed
 * - otherwise docling's md is returned unchanged
 */
export function readMarkdown(body: unknown, output: MarkdownJobOutput): Result<Omit<ConvertedMarkdown, 'versions'>> {
    const server = readConvertResponse(body);
    if (!server.ok) {
        return server;
    }
    const markdown = server.data.document.md_content;
    if (markdown == null) {
        return missingContent(server.data, 'md_content');
    }
    if (typeof markdown !== 'string') {
        return fail(ERR.INVALID_RESPONSE('Response has no md_content'));
    }
    const warnings: MarkdownWarning[] = server.data.warnings;
    if (output.images === 'extract') {
        const extracted = extractImages(markdown, output.imageOptions);
        return ok({ ...extracted, warnings: [...warnings, ...extracted.warnings] });
    }
    const md = output.images === 'none' ? removeImagePlaceholders(markdown) : markdown;
    return ok({ markdown: md, images: [], warnings });
}

/**
 * **Reads `json_content`**.
 *
 * - only `schema_name` and `body` are checked, the rest is passed on as sent
 * - page images are moved from `pages[].image` to `pageImages`; undecodable ones stay and are reported after server warnings
 */
export function readDocument(body: unknown): Result<Omit<ConvertedDocument, 'versions'>> {
    const server = readConvertResponse(body);
    if (!server.ok) {
        return server;
    }
    const json = server.data.document.json_content;
    if (json == null) {
        return missingContent(server.data, 'json_content');
    }
    if (!isPlainObject(json) || json.schema_name !== 'DoclingDocument' || !isPlainObject(json.body)) {
        return fail(ERR.INVALID_RESPONSE('Response has no DoclingDocument in json_content'));
    }
    const { document, pageImages, warnings } = extractPageImages(json as DoclingDocument);
    return ok({ document, pageImages, warnings: [...server.data.warnings, ...warnings] });
}

/** Parses docling's task failure classification; `null` if absent. */
export function readFailure(failure: DoclingFailureInfo | null | undefined): TaskFailure | null {
    if (failure == null || typeof failure !== 'object') {
        return null;
    }
    return {
        category: readText(failure.category) ?? null,
        phase: readText(failure.phase) ?? null,
        retryable: typeof failure.retryable === 'boolean' ? failure.retryable : null,
    };
}

/** Non-empty string, or `undefined` if empty or not a string. */
export function readText(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

// -------------------------------------------------------------------
// --- 4. Internal Functions
// -------------------------------------------------------------------

/**
 * **Splits a conversion response into success or failure**.
 *
 * - `success` and `partial_success` pass on the document with docling's error items as warnings
 * - any other status: `conversion_failed` with the failure message, else the joined error messages
 * - status missing, empty or not a string, and no failure: `invalid_response`
 */
function readConvertResponse(body: unknown): Result<ServerOutput> {
    const res = (body ?? {}) as DoclingConvertResponse;
    const errors = Array.isArray(res.errors) ? res.errors : [];
    const warnings = errors.flatMap((error) => (error == null ? [] : readServerError(error)));
    const failureMessage = readText(res.failure?.message);
    const failure = readFailure(res.failure);
    if (res.status === 'success' || res.status === 'partial_success') {
        const document = isPlainObject(res.document) ? res.document : {};
        return ok({ status: res.status, document, warnings, failureMessage, failure });
    }
    if (readText(res.status) === undefined && res.failure == null) {
        return fail(ERR.INVALID_RESPONSE('Unexpected response: no conversion status'));
    }
    const messages = warnings.map(({ message }) => message).join('; ');
    const reason = failureMessage ?? (messages || `status: ${String(res.status)}`);
    return fail(ERR.CONVERSION_FAILED(reason, { errors: toServerErrors(warnings), failure }));
}

/**
 * **Result for a successful status without the requested content**.
 *
 * - `partial_success`, error items or a failure: `conversion_failed` with all server details
 * - plain `success` without any of them: `invalid_response`
 */
function missingContent(server: ServerOutput, field: 'md_content' | 'json_content'): Result<never> {
    const { status, warnings, failureMessage, failure } = server;
    if (status !== 'partial_success' && warnings.length === 0 && failure === null) {
        const content = field === 'md_content' ? 'md_content' : 'DoclingDocument in json_content';
        return fail(ERR.INVALID_RESPONSE(`Response has no ${content}`));
    }
    const messages = warnings.map(({ message }) => message).join('; ');
    const reason = failureMessage ?? (messages || `status: ${status}, no ${field}`);
    return fail(ERR.CONVERSION_FAILED(reason, { errors: toServerErrors(warnings), failure }));
}

/** Server warnings as `ConversionFailure.errors`. */
function toServerErrors(warnings: ServerWarning[]): ConversionFailure['errors'] {
    return warnings.map(({ message, details }) => ({ message, details }));
}

/**
 * **Reads one docling error item**.
 *
 * - items without `error_message` are dropped
 * - 1-based page from `page_no` (newer docling) or the older error text; `null` if unassigned
 */
function readServerError(error: DoclingErrorItem): ServerWarning[] {
    const message = readText(error.error_message);
    if (message === undefined) {
        return [];
    }
    const pageIndex = MATCH_FAILED_PAGE.exec(message)?.[1];
    const page = isPageNumber(error.page_no) ? error.page_no : pageIndex === undefined ? null : Number(pageIndex) + 1;
    return [
        {
            code: 'server',
            message,
            details: {
                component: readText(error.component_type) ?? null,
                module: readText(error.module_name) ?? null,
                category: readText(error.category) ?? null,
                page,
            },
        },
    ];
}

/** docling `page_no`: integer >= 1; `0`, negatives and fractions are rejected. */
function isPageNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

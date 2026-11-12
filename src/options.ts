// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { ERR, fail, ok } from './core/result.js';
import {
    invalidValue,
    isBoolean,
    isOneOf,
    isPlainObject,
    OPTIONS_OBJECT_EXPECTED,
    type OptionRule,
    validateKeys,
} from './core/validate.js';
import type {
    CallOptions,
    ClientOptions,
    DoclingConfig,
    DoclingOptions,
    DocumentImageMode,
    DocumentOptions,
    ImageOptions,
    JobRef,
    MarkdownImageMode,
    MarkdownJobOutput,
    MarkdownOptions,
    PollOptions,
    Result,
} from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Factory-only option keys; they fall back to the server default when omitted. */
type FactoryOnly = Exclude<keyof ClientOptions, keyof DoclingOptions>;

/** docling options with every per-call default filled in. */
export type ResolvedOptions = Required<DoclingOptions> & Pick<ClientOptions, FactoryOnly>;

/** Validated client configuration. */
export type ResolvedConfig = {
    /** Base URL without trailing slash. */
    baseUrl: string;
    apiKey?: string;
    fetch: typeof fetch;
    /** Time limit per request in ms; unset means no limit. */
    timeoutMs?: number;
    /** Delay between job helper status polls in ms; defaults to `DEFAULT_POLL_MS`. */
    pollMs: number;
    /** Factory defaults merged over `DEFAULT_OPTIONS`. */
    defaults: ResolvedOptions;
};

/** Validated poll settings for job helpers. */
export type PollCall = {
    pollMs: number;
    signal?: AbortSignal;
};

/** Validated md call: server options, image handling and signal. */
export type MarkdownCall = {
    options: ResolvedOptions;
    output: MarkdownJobOutput;
    signal?: AbortSignal;
};

/** Validated document call: server options, picture data mode, page images and signal. */
export type DocumentCall = {
    options: ResolvedOptions;
    images: DocumentImageMode;
    pageImages: boolean;
    signal?: AbortSignal;
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Allowed `pipeline` values. */
const PIPELINES = ['standard', 'vlm'] as const;

/** Allowed `pdfBackend` values. */
const PDF_BACKENDS = ['docling_parse', 'pypdfium2'] as const;

/** Allowed `images` values of md calls. */
const MARKDOWN_IMAGE_MODES: readonly MarkdownImageMode[] = ['none', 'placeholder', 'extract'];

/** Allowed `images` values of document calls. */
const DOCUMENT_IMAGE_MODES: readonly DocumentImageMode[] = ['embedded', 'placeholder'];

/** Defaults of every docling option sent explicitly. */
export const DEFAULT_OPTIONS: Readonly<ResolvedOptions> = Object.freeze({
    headingHierarchy: true,
    formulaEnrichment: true,
    codeEnrichment: false,
    chartExtraction: false,
    pipeline: 'standard',
    pdfBackend: 'docling_parse',
    ocr: true,
    forceOcr: false,
    ocrEngine: 'auto',
});

/** Rules for docling options, accepted by the factory and every conversion call. */
const CALL_OPTION_RULES: Record<keyof DoclingOptions, OptionRule> = {
    headingHierarchy: isBoolean,
    formulaEnrichment: isBoolean,
    codeEnrichment: isBoolean,
    chartExtraction: isBoolean,
    pipeline: (value) => isOneOf(value, PIPELINES),
    pdfBackend: (value) => isOneOf(value, PDF_BACKENDS),
    ocr: isBoolean,
    forceOcr: isBoolean,
    ocrEngine: (value) => typeof value === 'string' && value !== '',
};

/** Rules for factory options: per-call options plus the factory-only ones. */
const CLIENT_OPTION_RULES: Record<keyof ClientOptions, OptionRule> = {
    ...CALL_OPTION_RULES,
    ocrLang: isLanguageList,
    pageRange: isPageRange,
    documentTimeout: isPositiveNumber,
};

/** Rules for md call options; `imageOptions` keys are checked by `resolveImageOutput`. */
const MARKDOWN_RULES: Record<keyof MarkdownOptions, OptionRule> = {
    ...CALL_OPTION_RULES,
    signal: isAbortSignal,
    images: (value) => isOneOf(value, MARKDOWN_IMAGE_MODES),
    imageOptions: isPlainObject,
};

/** Rules for document call options. */
const DOCUMENT_RULES: Record<keyof DocumentOptions, OptionRule> = {
    ...CALL_OPTION_RULES,
    signal: isAbortSignal,
    images: (value) => isOneOf(value, DOCUMENT_IMAGE_MODES),
    pageImages: isBoolean,
};

/** Rules for image extraction options. */
const IMAGE_OPTION_RULES: Record<keyof ImageOptions, OptionRule> = {
    prefix: isImagePrefix,
    omitSmall: isBoolean,
};

/** Rules for `check` and `capabilities` options. */
const CHECK_RULES: Record<keyof CallOptions, OptionRule> = {
    signal: isAbortSignal,
};

/** Rules for `waitForJob` options. */
const POLL_RULES: Record<keyof PollOptions, OptionRule> = {
    ...CHECK_RULES,
    pollMs: isTimerDelay,
};

/** Rules for `runMarkdown` options: md call options plus `pollMs`. */
const RUN_MARKDOWN_RULES: Record<keyof (MarkdownOptions & PollOptions), OptionRule> = {
    ...MARKDOWN_RULES,
    ...POLL_RULES,
};

/** Rules for `runDocument` options: document call options plus `pollMs`. */
const RUN_DOCUMENT_RULES: Record<keyof (DocumentOptions & PollOptions), OptionRule> = {
    ...DOCUMENT_RULES,
    ...POLL_RULES,
};

/** Rules for factory configuration; the keys of `options` are checked separately. */
const CONFIG_RULES: Record<keyof DoclingConfig, OptionRule> = {
    baseUrl: isHttpUrl,
    apiKey: (value) => typeof value === 'string' && value !== '',
    fetch: (value) => typeof value === 'function',
    timeoutMs: isTimerDelay,
    pollMs: isTimerDelay,
    options: isPlainObject,
};

/** Default delay in ms between job helper status polls. */
const DEFAULT_POLL_MS = 10;

/** Job id of word characters and `-` only, so it cannot leave the URL path segment. */
const MATCH_JOB_ID = /^[\w-]+$/;

/** Matches BCP-47 language tags (e.g. 'en', 'de-AT'). */
const MATCH_LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Matches path prefixes free of md link delimiters. */
const MATCH_IMAGE_PREFIX = /^[^\s()<>]+$/;

/** Matches one or more trailing slashes of a base URL. */
const MATCH_TRAILING_SLASHES = /\/+$/;

/** Matches HTTP or HTTPS protocol schemes. */
const MATCH_HTTP_PROTOCOL = /^https?:$/;

/** Maximum timer delay in ms (2^31 - 1); Node timers overflow above this and fire after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Error message for a missing or malformed job object. */
const INVALID_JOB = 'Expected the job object returned by submitMarkdown() or submitDocument()';

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Validates factory configuration**.
 *
 * - `baseUrl` is required; trailing `/` are removed
 * @throws `TypeError` on invalid configuration.
 */
export function resolveConfig(config: unknown): ResolvedConfig {
    if (!isPlainObject(config)) {
        throw new TypeError('Invalid config: expected an object');
    }
    const {
        baseUrl,
        apiKey,
        fetch: fetchFn,
        timeoutMs,
        pollMs = DEFAULT_POLL_MS,
        options,
    } = validateKeys<DoclingConfig>(config, CONFIG_RULES);
    if (baseUrl === undefined) {
        throw new TypeError(invalidValue('baseUrl'));
    }
    const defaults = {
        ...DEFAULT_OPTIONS,
        ...(options === undefined ? {} : validateKeys(options, CLIENT_OPTION_RULES)),
    };
    return {
        baseUrl: baseUrl.replace(MATCH_TRAILING_SLASHES, ''),
        ...(apiKey === undefined ? {} : { apiKey }),
        fetch: fetchFn ?? fetch,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        pollMs,
        defaults,
    };
}

/**
 * Merges and validates md call options against factory defaults.
 * @throws `TypeError` on invalid options.
 */
export function resolveMarkdownCall(defaults: Readonly<ResolvedOptions>, options: unknown): MarkdownCall {
    return toMarkdownCall(defaults, validateKeys<MarkdownOptions>(callObject(options), MARKDOWN_RULES));
}

/**
 * Merges and validates document call options against factory defaults.
 * @throws `TypeError` on invalid options.
 */
export function resolveDocumentCall(defaults: Readonly<ResolvedOptions>, options: unknown): DocumentCall {
    return toDocumentCall(defaults, validateKeys<DocumentOptions>(callObject(options), DOCUMENT_RULES));
}

/**
 * Merges md call options and poll settings; `pollMs` defaults to factory `pollMs`.
 * @throws `TypeError` on invalid options.
 */
export function resolveRunMarkdownCall(
    defaults: Readonly<ResolvedOptions>,
    defaultPollMs: number,
    options: unknown,
): MarkdownCall & PollCall {
    const { pollMs = defaultPollMs, ...call } = validateKeys<MarkdownOptions & PollOptions>(
        callObject(options),
        RUN_MARKDOWN_RULES,
    );
    return { ...toMarkdownCall(defaults, call), pollMs };
}

/**
 * Merges document call options and poll settings; `pollMs` defaults to factory `pollMs`.
 * @throws `TypeError` on invalid options.
 */
export function resolveRunDocumentCall(
    defaults: Readonly<ResolvedOptions>,
    defaultPollMs: number,
    options: unknown,
): DocumentCall & PollCall {
    const { pollMs = defaultPollMs, ...call } = validateKeys<DocumentOptions & PollOptions>(
        callObject(options),
        RUN_DOCUMENT_RULES,
    );
    return { ...toDocumentCall(defaults, call), pollMs };
}

/**
 * Checks signal-only call options (`check`, `capabilities`).
 * @throws `TypeError` on invalid options.
 */
export function resolveCheckOptions(options: unknown): CallOptions {
    return validateKeys<CallOptions>(callObject(options), CHECK_RULES);
}

/**
 * Checks `waitForJob` options; `pollMs` defaults to factory `pollMs`.
 * @throws `TypeError` on invalid options.
 */
export function resolvePollOptions(defaultPollMs: number, options: unknown): PollCall {
    const { pollMs = defaultPollMs, signal } = validateKeys<PollOptions>(callObject(options), POLL_RULES);
    return { pollMs, ...(signal === undefined ? {} : { signal }) };
}

/**
 * **Checks a job object against the shape `submitMarkdown()` and `submitDocument()` return**.
 *
 * - never throws: a malformed job is `invalid_input`
 * - `settings` and other extra keys are ignored and not returned
 */
export function validateJob(job: unknown): Result<JobRef> {
    if (!isPlainObject(job) || !isJobId(job.id)) {
        return fail(ERR.INVALID_INPUT(INVALID_JOB));
    }
    if (job.kind === 'document') {
        return ok({ kind: 'document', id: job.id });
    }
    if (job.kind !== 'markdown' || !isPlainObject(job.output) || !isOneOf(job.output.images, MARKDOWN_IMAGE_MODES)) {
        return fail(ERR.INVALID_INPUT(INVALID_JOB));
    }
    try {
        return ok({
            kind: 'markdown',
            id: job.id,
            output: resolveImageOutput(job.output.images, job.output.imageOptions),
        });
    } catch (error) {
        return fail(ERR.INVALID_INPUT(`${INVALID_JOB}: ${(error as Error).message}`));
    }
}

/** Task id `check` accepts: word characters and `-` only, so it cannot leave the URL path segment. */
export function isJobId(value: unknown): value is string {
    return typeof value === 'string' && MATCH_JOB_ID.test(value);
}

// -------------------------------------------------------------------
// --- 4. Private Functions
// -------------------------------------------------------------------

/**
 * Returns call options as a plain object (`undefined` becomes `{}`).
 * @throws `TypeError` when options is not a plain object.
 */
function callObject(options: unknown): Record<string, unknown> {
    if (options === undefined) {
        return {};
    }
    if (!isPlainObject(options)) {
        throw new TypeError(OPTIONS_OBJECT_EXPECTED);
    }
    return options;
}

/**
 * Splits validated md call options into server options over the defaults, image handling and signal.
 * @throws `TypeError` on a missing, unexpected or invalid `imageOptions`.
 */
function toMarkdownCall(defaults: Readonly<ResolvedOptions>, options: Partial<MarkdownOptions>): MarkdownCall {
    const { signal, images = 'placeholder', imageOptions, ...docling } = options;
    const output = resolveImageOutput(images, imageOptions);
    return { options: { ...defaults, ...docling }, output, ...(signal === undefined ? {} : { signal }) };
}

/** Splits validated document call options into server options over the defaults, image modes and signal. */
function toDocumentCall(defaults: Readonly<ResolvedOptions>, options: Partial<DocumentOptions>): DocumentCall {
    const { signal, images = 'embedded', pageImages = false, ...docling } = options;
    return { options: { ...defaults, ...docling }, images, pageImages, ...(signal === undefined ? {} : { signal }) };
}

/**
 * **Combines image mode and image options into the md job output**.
 *
 * - `imageOptions` with `prefix` is required with `'extract'` and not allowed otherwise
 * @throws `TypeError` on a missing, unexpected or invalid `imageOptions`.
 */
function resolveImageOutput(images: MarkdownImageMode, imageOptions: unknown): MarkdownJobOutput {
    if (images !== 'extract') {
        if (imageOptions !== undefined) {
            throw new TypeError(`Option "imageOptions" is not supported without images: 'extract'`);
        }
        return { images };
    }
    if (imageOptions === undefined) {
        throw new TypeError(`Option "imageOptions" is required with images: 'extract'`);
    }
    if (!isPlainObject(imageOptions)) {
        throw new TypeError(invalidValue('imageOptions'));
    }
    const { prefix, omitSmall = true } = validateKeys<ImageOptions>(imageOptions, IMAGE_OPTION_RULES, 'imageOptions.');
    if (prefix === undefined) {
        throw new TypeError('Option "imageOptions.prefix" is required');
    }
    return { images, imageOptions: { prefix, omitSmall } };
}

/** Finite number greater than zero. */
function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Integer ms from 1 to `MAX_TIMEOUT_MS`; `AbortSignal.timeout` throws on fractions, `setTimeout` overflows above. */
function isTimerDelay(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

/** 1-based ascending integer pair `[from, to]`. */
function isPageRange(value: unknown): value is [number, number] {
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        Number.isInteger(value[0]) &&
        Number.isInteger(value[1]) &&
        value[0] >= 1 &&
        value[1] >= value[0]
    );
}

/** Array of BCP-47 language tags; empty means the OCR engine default. */
function isLanguageList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((tag) => typeof tag === 'string' && MATCH_LANGUAGE_TAG.test(tag));
}

/** Path prefix without md-breaking characters. */
function isImagePrefix(value: unknown): value is string {
    return typeof value === 'string' && MATCH_IMAGE_PREFIX.test(value);
}

/** `AbortSignal` instance. */
function isAbortSignal(value: unknown): value is AbortSignal {
    return value instanceof AbortSignal;
}

/**
 * **HTTP or HTTPS URL that routes can be appended to**.
 *
 * - no `?` or `#`, even empty ones: `${baseUrl}${route}` would put the route into the query or fragment
 * - no user name or password: Node's `fetch` refuses such URLs; the key belongs in `apiKey`
 */
function isHttpUrl(value: unknown): value is string {
    if (typeof value !== 'string' || !URL.canParse(value) || value.includes('?') || value.includes('#')) {
        return false;
    }
    const url = new URL(value);
    return MATCH_HTTP_PROTOCOL.test(url.protocol) && url.username === '' && url.password === '';
}

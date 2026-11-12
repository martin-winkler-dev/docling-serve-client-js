// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { OPTIONS_OBJECT_EXPECTED } from '../../src/core/validate.js';
import {
    DEFAULT_OPTIONS,
    type ResolvedOptions,
    resolveCheckOptions,
    resolveConfig,
    resolveDocumentCall,
    resolveMarkdownCall,
    resolvePollOptions,
    resolveRunDocumentCall,
    resolveRunMarkdownCall,
    validateJob,
} from '../../src/options.js';
import type { JobRef, Result } from '../../src/types.js';

/** Image prefix used by the extract tests. */
const PREFIX = 'out/images/1234-';

/** Every per-call docling option with a non-default value. */
const CALL_OPTIONS: ResolvedOptions = {
    headingHierarchy: false,
    formulaEnrichment: false,
    codeEnrichment: true,
    chartExtraction: true,
    pipeline: 'vlm',
    pdfBackend: 'pypdfium2',
    ocr: false,
    forceOcr: true,
    ocrEngine: 'rapidocr',
};

/** Every docling option, factory-only ones included, with a non-default value. */
const ALL_OPTIONS: ResolvedOptions = {
    ...CALL_OPTIONS,
    ocrLang: ['de', 'en-US', 'zh-Hant', 'deu'],
    pageRange: [2, 5],
    documentTimeout: 1.5,
};

/** Factory-only options; any value is rejected per call. */
const FACTORY_ONLY: Record<string, unknown>[] = [
    { ocrLang: ['de'] },
    { pageRange: [1, 2] },
    { documentTimeout: 30 },
    { ocrLang: [] },
    { pageRange: null },
    { pageRange: undefined },
];

/** Invalid values per per-call docling option; none of them may be converted. */
const INVALID_CALL_OPTIONS: Record<string, unknown>[] = [
    { ocr: 1 },
    { ocr: 'true' },
    { ocr: null },
    { forceOcr: 0 },
    { headingHierarchy: 0 },
    { formulaEnrichment: 'yes' },
    { codeEnrichment: 1 },
    { chartExtraction: [] },
    { pipeline: 'VLM' },
    { pipeline: ' standard' },
    { pipeline: 1 },
    { pdfBackend: 'pdfium' },
    { pdfBackend: 'dlparse_v4' },
    { pdfBackend: 1 },
    { ocrEngine: '' },
    { ocrEngine: 1 },
    { ocrEngine: null },
];

/** Invalid values of factory-only options. */
const INVALID_FACTORY_OPTIONS: Record<string, unknown>[] = [
    { pageRange: [0, 2] },
    { pageRange: [3, 2] },
    { pageRange: [1] },
    { pageRange: [1, 2, 3] },
    { pageRange: [1.5, 2] },
    { pageRange: [1, '2'] },
    { pageRange: '1-2' },
    { ocrLang: 'de' },
    { ocrLang: ['de', ''] },
    { ocrLang: ['de_DE'] },
    { ocrLang: ['d'] },
    { ocrLang: [1] },
    { documentTimeout: 0 },
    { documentTimeout: -1 },
    { documentTimeout: '60' },
    { documentTimeout: Number.NaN },
    { documentTimeout: Number.POSITIVE_INFINITY },
];

/** Invalid values of every factory option. */
const INVALID_OPTIONS = [...INVALID_CALL_OPTIONS, ...INVALID_FACTORY_OPTIONS];

/** Invalid `pollMs` values: not an integer from 1 to 2^31 - 1 (`setTimeout` fires a larger delay after 1 ms). */
const INVALID_POLL_MS: unknown[] = [0, -1, 1.5, '10', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 53];

/** Objects that are not plain: rejected as options, config and `imageOptions`. */
const NON_PLAIN_OBJECTS: unknown[] = [new Map([['ocr', false]]), new Date(), new (class Options {})(), /x/];

/** Keys no docling option set accepts: unsupported options, misspellings, and prototype properties. */
const UNKNOWN_KEYS = [
    'tableMode',
    'imageScale',
    'repairs',
    'pageNumbers',
    'cleanMarkdown',
    'deepHeadings',
    'filename',
    'OCR',
    'constructor',
    'toString',
];

/** Error of a failed result; `undefined` for a successful one. */
function errorOf(res: Result<unknown>) {
    return res.ok ? undefined : res.error;
}

/** Asserts that `run` throws a `TypeError` with exactly `message`. */
function expectTypeError(run: () => unknown, message: string) {
    expect(run).toThrow(TypeError);
    expect(run).toThrow(new TypeError(message));
}

describe('DEFAULT_OPTIONS', () => {
    test('defines documented default options as a frozen object', () => {
        expect(DEFAULT_OPTIONS).toEqual({
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
        expect(Object.isFrozen(DEFAULT_OPTIONS)).toBe(true);
    });
});

describe('resolveConfig', () => {
    test('trims trailing slashes from baseUrl and merges provided options with defaults', () => {
        const config = resolveConfig({ baseUrl: 'http://docling:5001//', apiKey: 'k', options: { ocr: false } });
        expect(config).toEqual({
            baseUrl: 'http://docling:5001',
            apiKey: 'k',
            fetch,
            pollMs: 10,
            defaults: { ...DEFAULT_OPTIONS, ocr: false },
        });
    });

    test('accepts all valid docling options including custom ocrEngine identifiers', () => {
        expect(resolveConfig({ baseUrl: 'http://x', options: ALL_OPTIONS }).defaults).toEqual(ALL_OPTIONS);
        expect(resolveConfig({ baseUrl: 'http://x', options: { ocrEngine: 'nemotron-ocr' } }).defaults.ocrEngine).toBe(
            'nemotron-ocr',
        );
    });

    test('preserves custom fetch implementation and timeoutMs while treating undefined keys as omitted', () => {
        /** Stub fetch function for configuration tests. */
        async function customFetch() {
            return Response.json({});
        }
        const custom = customFetch as unknown as typeof fetch;
        const config = {
            baseUrl: 'https://x',
            apiKey: undefined,
            fetch: custom,
            timeoutMs: undefined,
            pollMs: undefined,
            options: undefined,
        };
        expect(resolveConfig(config)).toEqual({
            baseUrl: 'https://x',
            fetch: custom,
            pollMs: 10,
            defaults: DEFAULT_OPTIONS,
        });
        expect(resolveConfig({ baseUrl: 'https://x', timeoutMs: 1500 }).timeoutMs).toBe(1500);
        expect(resolveConfig({ baseUrl: 'https://x', timeoutMs: 2_147_483_647 }).timeoutMs).toBe(2_147_483_647);
        expect(resolveConfig({ baseUrl: 'https://x', pollMs: 1 }).pollMs).toBe(1);
        expect(resolveConfig({ baseUrl: 'https://x', pollMs: 250 }).pollMs).toBe(250);
        expect(resolveConfig({ baseUrl: 'https://x', pollMs: 2_147_483_647 }).pollMs).toBe(2_147_483_647);
        expect(resolveConfig({ baseUrl: 'https://x', options: { ocr: undefined } }).defaults).toEqual(DEFAULT_OPTIONS);
    });

    test('clones option arrays to prevent external mutation leaks', () => {
        const ocrLang = ['de'];
        const pageRange: [number, number] = [1, 2];
        const config = resolveConfig({ baseUrl: 'http://x', options: { ocrLang, pageRange } });
        ocrLang.push('en');
        pageRange[1] = 9;
        expect([config.defaults.ocrLang, config.defaults.pageRange]).toEqual([['de'], [1, 2]]);
    });

    test('preserves empty ocrLang array as engine default', () => {
        expect(resolveConfig({ baseUrl: 'http://x', options: { ocrLang: [] } }).defaults.ocrLang).toEqual([]);
    });

    test('accepts null-prototype objects and rejects non-plain objects', () => {
        const config = Object.assign(Object.create(null), { baseUrl: 'http://x' });
        expect(resolveConfig(config).baseUrl).toBe('http://x');
        for (const value of NON_PLAIN_OBJECTS) {
            expectTypeError(() => resolveConfig(value), 'Invalid config: expected an object');
            expectTypeError(
                () => resolveConfig({ baseUrl: 'http://x', options: value }),
                'Invalid value for option "options"',
            );
        }
    });

    test('throws TypeError with invalid option name for invalid configuration fields', () => {
        const invalid: [unknown, string][] = [
            [undefined, 'Invalid config: expected an object'],
            [null, 'Invalid config: expected an object'],
            ['http://x', 'Invalid config: expected an object'],
            [['http://x'], 'Invalid config: expected an object'],
            [{}, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: undefined }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: '' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: '127.0.0.1:5001' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'ftp://x' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 5 }, 'Invalid value for option "baseUrl"'],
            // A query or fragment, even an empty one, would swallow the appended route.
            [{ baseUrl: 'http://x/?a=1' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'http://x/?' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'http://x#top' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'http://x/#' }, 'Invalid value for option "baseUrl"'],
            // Node's fetch refuses URLs with credentials.
            [{ baseUrl: 'http://user:pass@x' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'http://user@x' }, 'Invalid value for option "baseUrl"'],
            [{ baseUrl: 'http://x', apiKey: '' }, 'Invalid value for option "apiKey"'],
            [{ baseUrl: 'http://x', apiKey: 1 }, 'Invalid value for option "apiKey"'],
            [{ baseUrl: 'http://x', fetch: 'x' }, 'Invalid value for option "fetch"'],
            [{ baseUrl: 'http://x', timeoutMs: 0 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: '5' }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: Number.POSITIVE_INFINITY }, 'Invalid value for option "timeoutMs"'],
            // AbortSignal.timeout throws on fractions and above 2^32 - 1; Node fires above 2^31 - 1 after 1 ms.
            [{ baseUrl: 'http://x', timeoutMs: 1500.5 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: 2 ** 31 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: 2 ** 53 }, 'Invalid value for option "timeoutMs"'],
            ...INVALID_POLL_MS.map((pollMs): [unknown, string] => [
                { baseUrl: 'http://x', pollMs },
                'Invalid value for option "pollMs"',
            ]),
            // pollMs is a factory top-level setting, not a docling option.
            [{ baseUrl: 'http://x', options: { pollMs: 10 } }, 'Option "pollMs" is not supported'],
            [{ baseUrl: 'http://x', options: null }, 'Invalid value for option "options"'],
            [{ baseUrl: 'http://x', options: [] }, 'Invalid value for option "options"'],
            [{ baseUrl: 'http://x', cleanMarkdown: true }, 'Option "cleanMarkdown" is not supported'],
            [{ baseUrl: 'http://x', repairs: true }, 'Option "repairs" is not supported'],
            [{ baseUrl: 'http://x', options: { ocr: 1 } }, 'Invalid value for option "ocr"'],
        ];
        for (const [config, message] of invalid) {
            expectTypeError(() => resolveConfig(config), message);
        }
    });

    test('rejects per-call options when supplied as factory configuration defaults', () => {
        const perCall = [
            { images: 'placeholder' },
            { images: 'extract' },
            { images: 'embedded' },
            { imageOptions: { prefix: 'x' } },
            { pageImages: true },
            { signal: new AbortController().signal },
        ];
        for (const options of perCall) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveConfig({ baseUrl: 'http://x', options }), `Option "${name}" is not supported`);
        }
    });

    test('rejects invalid option values and unknown keys in configuration', () => {
        for (const options of INVALID_OPTIONS) {
            const [name] = Object.keys(options);
            expectTypeError(
                () => resolveConfig({ baseUrl: 'http://x', options }),
                `Invalid value for option "${name}"`,
            );
        }
        for (const name of UNKNOWN_KEYS) {
            expectTypeError(
                () => resolveConfig({ baseUrl: 'http://x', options: { [name]: true } }),
                `Option "${name}" is not supported`,
            );
        }
    });
});

describe('resolveMarkdownCall', () => {
    test('resolves defaults with placeholder image output and undefined signal when options are omitted', () => {
        const expected = { options: DEFAULT_OPTIONS, output: { images: 'placeholder' } } as const;
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, undefined)).toEqual(expected);
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, {})).toEqual(expected);
        expect('signal' in resolveMarkdownCall(DEFAULT_OPTIONS, {})).toBe(false);
    });

    test('applies per-call options overriding default configuration', () => {
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, CALL_OPTIONS).options).toEqual(CALL_OPTIONS);
    });

    test('rejects factory-only options in per-call options while retaining factory defaults', () => {
        for (const options of FACTORY_ONLY) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, options), `Option "${name}" is not supported`);
        }
        const defaults = { ...DEFAULT_OPTIONS, ocrLang: ['de'], pageRange: [1, 2] as [number, number] };
        const call = resolveMarkdownCall(defaults, { ocr: false });
        expect(call.options).toEqual({ ...defaults, ocr: false });
    });

    test('overrides factory defaults per key and preserves defaults for undefined values', () => {
        const defaults = { ...DEFAULT_OPTIONS, ocr: false, pageRange: [1, 2] as [number, number] };
        const call = resolveMarkdownCall(defaults, { ocr: undefined, pipeline: 'vlm', images: undefined });
        expect(call.options).toEqual({ ...defaults, pipeline: 'vlm' });
        expect(call.output).toEqual({ images: 'placeholder' });
    });

    test('isolates abort signal and image output options from server options payload', () => {
        const signal = new AbortController().signal;
        const call = resolveMarkdownCall(DEFAULT_OPTIONS, { signal, ocr: false, images: 'none' });
        expect(call).toEqual({ options: { ...DEFAULT_OPTIONS, ocr: false }, output: { images: 'none' }, signal });
        expect(call.signal).toBe(signal);
    });

    test('defaults omitSmall to true for extract image mode and allows explicit false', () => {
        const call = resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions: { prefix: PREFIX } });
        expect(call.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } });
        const all = resolveMarkdownCall(DEFAULT_OPTIONS, {
            images: 'extract',
            imageOptions: { prefix: PREFIX, omitSmall: false },
        });
        expect(all.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } });
    });

    test('requires imageOptions when images mode is extract and rejects them otherwise', () => {
        expectTypeError(
            () => resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract' }),
            `Option "imageOptions" is required with images: 'extract'`,
        );
        expectTypeError(
            () => resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions: undefined }),
            `Option "imageOptions" is required with images: 'extract'`,
        );
        for (const images of ['none', 'placeholder', undefined]) {
            expectTypeError(
                () => resolveMarkdownCall(DEFAULT_OPTIONS, { images, imageOptions: { prefix: PREFIX } }),
                `Option "imageOptions" is not supported without images: 'extract'`,
            );
        }
    });

    test('validates nested imageOptions properties with fully qualified option names', () => {
        const invalid: [unknown, string][] = [
            [{}, 'Option "imageOptions.prefix" is required'],
            [{ prefix: undefined, omitSmall: true }, 'Option "imageOptions.prefix" is required'],
            [{ prefix: '' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: 'a b-' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: 'a\tb-' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: 'a(b-' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: 'a)b-' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: '<a>-' }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: 5 }, 'Invalid value for option "imageOptions.prefix"'],
            [{ prefix: PREFIX, omitSmall: 'yes' }, 'Invalid value for option "imageOptions.omitSmall"'],
            [{ prefix: PREFIX, omitSmall: 1 }, 'Invalid value for option "imageOptions.omitSmall"'],
            [{ prefix: PREFIX, minWidth: 100 }, 'Option "imageOptions.minWidth" is not supported'],
            [{ prefix: PREFIX, minHeight: 50 }, 'Option "imageOptions.minHeight" is not supported'],
            ['out/', 'Invalid value for option "imageOptions"'],
            [null, 'Invalid value for option "imageOptions"'],
            [[PREFIX], 'Invalid value for option "imageOptions"'],
        ];
        for (const [imageOptions, message] of invalid) {
            expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions }), message);
        }
    });

    test('accepts valid prefix patterns without whitespace or invalid characters', () => {
        for (const prefix of ['x', 'images/doc1_', './out/a-', 'C:/out/', 'a[1]-', 'ä/ö-']) {
            const call = resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions: { prefix } });
            expect(call.output).toEqual({ images: 'extract', imageOptions: { prefix, omitSmall: true } });
        }
    });

    test('throws TypeError for invalid image modes, abort signals, and docling options', () => {
        for (const images of ['embedded', 'Extract', true, null]) {
            expectTypeError(
                () => resolveMarkdownCall(DEFAULT_OPTIONS, { images }),
                'Invalid value for option "images"',
            );
        }
        for (const signal of [{}, 'x', null, new AbortController()]) {
            expectTypeError(
                () => resolveMarkdownCall(DEFAULT_OPTIONS, { signal }),
                'Invalid value for option "signal"',
            );
        }
        for (const options of INVALID_CALL_OPTIONS) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, options), `Invalid value for option "${name}"`);
        }
    });

    test('throws TypeError for unknown keys and non-plain object options', () => {
        for (const name of UNKNOWN_KEYS) {
            expectTypeError(
                () => resolveMarkdownCall(DEFAULT_OPTIONS, { [name]: 1 }),
                `Option "${name}" is not supported`,
            );
        }
        // page images exist only in the DoclingDocument
        expectTypeError(
            () => resolveMarkdownCall(DEFAULT_OPTIONS, { pageImages: true }),
            'Option "pageImages" is not supported',
        );
        for (const options of [null, 'x', 5, ['ocr'], ...NON_PLAIN_OBJECTS]) {
            expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, options), OPTIONS_OBJECT_EXPECTED);
        }
        for (const imageOptions of NON_PLAIN_OBJECTS) {
            expectTypeError(
                () => resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions }),
                'Invalid value for option "imageOptions"',
            );
        }
    });
});

describe('resolveDocumentCall', () => {
    test('resolves defaults with embedded images, no page images, and undefined signal when options are omitted', () => {
        const expected = { options: DEFAULT_OPTIONS, images: 'embedded', pageImages: false } as const;
        expect(resolveDocumentCall(DEFAULT_OPTIONS, undefined)).toEqual(expected);
        expect(resolveDocumentCall(DEFAULT_OPTIONS, { images: undefined, signal: undefined })).toEqual(expected);
    });

    test('resolves docling options, image mode, pageImages flag, and abort signal', () => {
        const signal = AbortSignal.abort();
        const options = { ...CALL_OPTIONS, images: 'placeholder', pageImages: true, signal };
        const call = resolveDocumentCall(DEFAULT_OPTIONS, options);
        expect(call).toEqual({ options: CALL_OPTIONS, images: 'placeholder', pageImages: true, signal });
        const defaults = { ...DEFAULT_OPTIONS, ocr: false };
        expect(resolveDocumentCall(defaults, { forceOcr: true }).options).toEqual({ ...defaults, forceOcr: true });
    });

    test('rejects factory-only options in per-call document conversion options', () => {
        for (const options of FACTORY_ONLY) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveDocumentCall(DEFAULT_OPTIONS, options), `Option "${name}" is not supported`);
        }
    });

    test('throws TypeError for markdown-specific image modes, imageOptions, and invalid option values', () => {
        for (const images of ['extract', 'none', 'Embedded', 1]) {
            expectTypeError(
                () => resolveDocumentCall(DEFAULT_OPTIONS, { images }),
                'Invalid value for option "images"',
            );
        }
        expectTypeError(
            () => resolveDocumentCall(DEFAULT_OPTIONS, { imageOptions: { prefix: PREFIX } }),
            'Option "imageOptions" is not supported',
        );
        expectTypeError(
            () => resolveDocumentCall(DEFAULT_OPTIONS, { signal: {} }),
            'Invalid value for option "signal"',
        );
        for (const pageImages of [1, 'true', null]) {
            expectTypeError(
                () => resolveDocumentCall(DEFAULT_OPTIONS, { pageImages }),
                'Invalid value for option "pageImages"',
            );
        }
        for (const options of INVALID_CALL_OPTIONS) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveDocumentCall(DEFAULT_OPTIONS, options), `Invalid value for option "${name}"`);
        }
    });

    test('throws TypeError for unknown keys and non-plain object document options', () => {
        for (const name of UNKNOWN_KEYS) {
            expectTypeError(
                () => resolveDocumentCall(DEFAULT_OPTIONS, { [name]: 1 }),
                `Option "${name}" is not supported`,
            );
        }
        for (const options of [null, 'x', 5, ['ocr'], ...NON_PLAIN_OBJECTS]) {
            expectTypeError(() => resolveDocumentCall(DEFAULT_OPTIONS, options), OPTIONS_OBJECT_EXPECTED);
        }
    });
});

describe('resolveCheckOptions', () => {
    test('accepts empty options or abort signal while treating undefined signal as omitted', () => {
        const signal = AbortSignal.abort();
        expect(resolveCheckOptions(undefined)).toEqual({});
        expect(resolveCheckOptions({})).toEqual({});
        expect(resolveCheckOptions({ signal: undefined })).toEqual({});
        expect(resolveCheckOptions({ signal })).toEqual({ signal });
    });

    test('throws TypeError for conversion options, invalid signals, and non-plain objects', () => {
        for (const name of ['ocr', 'images', 'imageOptions', 'pageRange']) {
            expectTypeError(() => resolveCheckOptions({ [name]: 1 }), `Option "${name}" is not supported`);
        }
        expectTypeError(() => resolveCheckOptions({ signal: 'x' }), 'Invalid value for option "signal"');
        expectTypeError(() => resolveCheckOptions(null), OPTIONS_OBJECT_EXPECTED);
        expectTypeError(() => resolveCheckOptions('x'), OPTIONS_OBJECT_EXPECTED);
        expectTypeError(() => resolveCheckOptions(new Map()), OPTIONS_OBJECT_EXPECTED);
    });

    test('throws TypeError for unknown keys even when their value is explicitly undefined', () => {
        expectTypeError(
            () => resolveConfig({ baseUrl: 'http://x', unknownOption: undefined }),
            'Option "unknownOption" is not supported',
        );
        expectTypeError(
            () => resolveConfig({ baseUrl: 'http://x', options: { unknownOption: undefined } }),
            'Option "unknownOption" is not supported',
        );
        expectTypeError(
            () => resolveMarkdownCall(DEFAULT_OPTIONS, { unknownOption: undefined }),
            'Option "unknownOption" is not supported',
        );
        expectTypeError(
            () => resolveDocumentCall(DEFAULT_OPTIONS, { unknownOption: undefined }),
            'Option "unknownOption" is not supported',
        );
        expectTypeError(
            () => resolveCheckOptions({ unknownOption: undefined }),
            'Option "unknownOption" is not supported',
        );
        expectTypeError(
            () =>
                resolveMarkdownCall(DEFAULT_OPTIONS, {
                    images: 'extract',
                    imageOptions: { prefix: PREFIX, unknownOption: undefined },
                }),
            'Option "imageOptions.unknownOption" is not supported',
        );
    });
});

describe('pollMs resolution', () => {
    test('rejects pollMs in convert, submit, and check options', () => {
        const message = 'Option "pollMs" is not supported';
        expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, { pollMs: 10 }), message);
        expectTypeError(() => resolveDocumentCall(DEFAULT_OPTIONS, { pollMs: 10 }), message);
        expectTypeError(() => resolveCheckOptions({ pollMs: 10 }), message);
        expectTypeError(() => resolveCheckOptions({ pollMs: undefined }), message);
    });

    test('prefers per-call pollMs over factory default and includes signal only when defined', () => {
        const signal = AbortSignal.abort();
        expect(resolvePollOptions(10, undefined)).toEqual({ pollMs: 10 });
        expect(resolvePollOptions(250, {})).toEqual({ pollMs: 250 });
        expect(resolvePollOptions(250, { pollMs: undefined, signal: undefined })).toEqual({ pollMs: 250 });
        expect(resolvePollOptions(250, { pollMs: 1, signal })).toEqual({ pollMs: 1, signal });
        expect(resolvePollOptions(10, { pollMs: 2_147_483_647 })).toEqual({ pollMs: 2_147_483_647 });
    });

    test('throws TypeError for invalid pollMs values, conversion options, invalid signals, and non-plain objects', () => {
        for (const pollMs of INVALID_POLL_MS) {
            expectTypeError(() => resolvePollOptions(10, { pollMs }), 'Invalid value for option "pollMs"');
        }
        for (const name of ['ocr', 'images', 'pageImages', 'imageOptions', 'unknownOption']) {
            expectTypeError(() => resolvePollOptions(10, { [name]: undefined }), `Option "${name}" is not supported`);
        }
        expectTypeError(() => resolvePollOptions(10, { signal: 'x' }), 'Invalid value for option "signal"');
        for (const options of [null, 'x', 5, ...NON_PLAIN_OBJECTS]) {
            expectTypeError(() => resolvePollOptions(10, options), OPTIONS_OBJECT_EXPECTED);
        }
    });

    test('resolves markdown call options combined with pollMs interval', () => {
        const signal = AbortSignal.abort();
        expect(resolveRunMarkdownCall(DEFAULT_OPTIONS, 10, undefined)).toEqual({
            ...resolveMarkdownCall(DEFAULT_OPTIONS, undefined),
            pollMs: 10,
        });
        const options = { ...CALL_OPTIONS, images: 'extract', imageOptions: { prefix: PREFIX }, signal } as const;
        expect(resolveRunMarkdownCall(DEFAULT_OPTIONS, 250, { ...options, pollMs: 5 })).toEqual({
            ...resolveMarkdownCall(DEFAULT_OPTIONS, options),
            pollMs: 5,
        });
        expect(resolveRunMarkdownCall(DEFAULT_OPTIONS, 250, { pollMs: undefined }).pollMs).toBe(250);
    });

    test('resolves document call options combined with pollMs interval', () => {
        const options = { ...CALL_OPTIONS, images: 'placeholder', pageImages: true } as const;
        expect(resolveRunDocumentCall(DEFAULT_OPTIONS, 10, undefined)).toEqual({
            ...resolveDocumentCall(DEFAULT_OPTIONS, undefined),
            pollMs: 10,
        });
        expect(resolveRunDocumentCall(DEFAULT_OPTIONS, 10, { ...options, pollMs: 99 })).toEqual({
            ...resolveDocumentCall(DEFAULT_OPTIONS, options),
            pollMs: 99,
        });
    });

    test('rejects invalid pollMs and options rejected by base conversion resolvers', () => {
        for (const pollMs of INVALID_POLL_MS) {
            const message = 'Invalid value for option "pollMs"';
            expectTypeError(() => resolveRunMarkdownCall(DEFAULT_OPTIONS, 10, { pollMs }), message);
            expectTypeError(() => resolveRunDocumentCall(DEFAULT_OPTIONS, 10, { pollMs }), message);
        }
        for (const options of [...FACTORY_ONLY, { pageImages: true }, { unknownOption: 1 }]) {
            const [name] = Object.keys(options);
            expectTypeError(
                () => resolveRunMarkdownCall(DEFAULT_OPTIONS, 10, options),
                `Option "${name}" is not supported`,
            );
        }
        for (const options of [...FACTORY_ONLY, { imageOptions: { prefix: PREFIX } }]) {
            const [name] = Object.keys(options);
            expectTypeError(
                () => resolveRunDocumentCall(DEFAULT_OPTIONS, 10, options),
                `Option "${name}" is not supported`,
            );
        }
        expectTypeError(
            () => resolveRunMarkdownCall(DEFAULT_OPTIONS, 10, { images: 'extract' }),
            `Option "imageOptions" is required with images: 'extract'`,
        );
        expectTypeError(
            () => resolveRunDocumentCall(DEFAULT_OPTIONS, 10, { images: 'extract' }),
            'Invalid value for option "images"',
        );
        expectTypeError(() => resolveRunDocumentCall(DEFAULT_OPTIONS, 10, 'x'), OPTIONS_OBJECT_EXPECTED);
    });
});

describe('validateJob', () => {
    /** Valid markdown job fixture with image extraction. */
    const extractJob: JobRef = {
        kind: 'markdown',
        id: 'task-1',
        output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } },
    };
    /** Valid document job fixture. */
    const documentJob: JobRef = { kind: 'document', id: '0b5e_c0de-42' };

    test('validates markdown and document job references across JSON serialization roundtrips', () => {
        const jobs: JobRef[] = [
            extractJob,
            documentJob,
            { kind: 'markdown', id: 't', output: { images: 'none' } },
            { kind: 'markdown', id: 't', output: { images: 'placeholder' } },
        ];
        for (const job of jobs) {
            expect(validateJob(job)).toEqual({ ok: true, data: job });
            expect(validateJob(JSON.parse(JSON.stringify(job)))).toEqual({ ok: true, data: job });
        }
    });

    test('returns a clean job copy stripping unrecognised properties', () => {
        expect(validateJob({ ...documentJob, savedAt: 1, output: { images: 'none' } })).toEqual({
            ok: true,
            data: documentJob,
        });
        const res = validateJob({ ...extractJob, savedAt: 1 });
        expect(res).toEqual({ ok: true, data: extractJob });
        expect(res.ok && res.data).not.toBe(extractJob);
    });

    test('applies default omitSmall value of true when missing from stored extract job reference', () => {
        const stored = { kind: 'markdown', id: 't', output: { images: 'extract', imageOptions: { prefix: PREFIX } } };
        expect(validateJob(stored)).toEqual({
            ok: true,
            data: {
                kind: 'markdown',
                id: 't',
                output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } },
            },
        });
    });

    test('rejects malformed or invalid job references with invalid_input error code', () => {
        const invalid = [
            undefined,
            null,
            'task-1',
            ['task-1'],
            { id: 'task-1' },
            { id: 'task-1', output: { images: 'none' } },
            { kind: 'Document', id: 'task-1' },
            { kind: 'json', id: 'task-1' },
            { ...documentJob, id: 1 },
            { ...documentJob, id: '' },
            { ...documentJob, id: '../result/x' },
            { ...documentJob, id: 'a/b' },
            { ...documentJob, id: 'a?b' },
            { ...extractJob, id: 'a b' },
            { kind: 'markdown', id: 'task-1' },
            { kind: 'markdown', id: 'task-1', output: null },
            { kind: 'markdown', id: 'task-1', output: 'none' },
            { kind: 'markdown', id: 'task-1', output: {} },
            { kind: 'markdown', id: 'task-1', output: { images: 'embedded' } },
        ];
        for (const value of invalid) {
            expect(errorOf(validateJob(value))).toEqual({
                code: 'invalid_input',
                message: 'Expected the job object returned by submitMarkdown() or submitDocument()',
            });
        }
    });

    test('rejects invalid markdown job image output and includes option validation error details', () => {
        const invalid: [unknown, string][] = [
            [{ images: 'extract' }, `Option "imageOptions" is required with images: 'extract'`],
            [{ images: 'extract', imageOptions: 'x' }, 'Invalid value for option "imageOptions"'],
            [{ images: 'extract', imageOptions: {} }, 'Option "imageOptions.prefix" is required'],
            [{ images: 'extract', imageOptions: { prefix: 'a b' } }, 'Invalid value for option "imageOptions.prefix"'],
            [
                { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: 1 } },
                'Invalid value for option "imageOptions.omitSmall"',
            ],
            [
                { images: 'extract', imageOptions: { prefix: PREFIX, minWidth: 1 } },
                'Option "imageOptions.minWidth" is not supported',
            ],
            [
                { images: 'none', imageOptions: { prefix: PREFIX } },
                `Option "imageOptions" is not supported without images: 'extract'`,
            ],
        ];
        for (const [output, message] of invalid) {
            expect(errorOf(validateJob({ kind: 'markdown', id: 't', output }))).toEqual({
                code: 'invalid_input',
                message: `Expected the job object returned by submitMarkdown() or submitDocument(): ${message}`,
            });
        }
    });
});

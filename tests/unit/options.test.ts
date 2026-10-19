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
    validateJob,
} from '../../src/options.js';
import type { Job, Result } from '../../src/types.js';

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

/** Objects that are not plain: rejected as options, config and `imageOptions`. */
const NON_PLAIN_OBJECTS: unknown[] = [new Map([['ocr', false]]), new Date(), new (class Options {})(), /x/];

/** Keys no docling option set accepts: removed options, misspellings and prototype keys. */
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
    test('are the documented defaults and frozen', () => {
        expect(DEFAULT_OPTIONS).toEqual({
            headingHierarchy: true,
            formulaEnrichment: true,
            codeEnrichment: false,
            chartExtraction: false,
            pipeline: 'standard',
            pdfBackend: 'docling_parse',
            ocr: true,
            forceOcr: false,
        });
        expect(Object.isFrozen(DEFAULT_OPTIONS)).toBe(true);
    });
});

describe('resolveConfig', () => {
    test('trims trailing slashes and merges options over the defaults', () => {
        const config = resolveConfig({ baseUrl: 'http://docling:5001//', apiKey: 'k', options: { ocr: false } });
        expect(config).toEqual({
            baseUrl: 'http://docling:5001',
            apiKey: 'k',
            fetch,
            defaults: { ...DEFAULT_OPTIONS, ocr: false },
        });
    });

    test('accepts every docling option as factory default', () => {
        expect(resolveConfig({ baseUrl: 'http://x', options: ALL_OPTIONS }).defaults).toEqual(ALL_OPTIONS);
    });

    test('keeps a custom fetch and timeoutMs; undefined optional keys count as missing', () => {
        async function customFetch() {
            return Response.json({});
        }
        const custom = customFetch as unknown as typeof fetch;
        const config = {
            baseUrl: 'https://x',
            apiKey: undefined,
            fetch: custom,
            timeoutMs: undefined,
            options: undefined,
        };
        expect(resolveConfig(config)).toEqual({ baseUrl: 'https://x', fetch: custom, defaults: DEFAULT_OPTIONS });
        expect(resolveConfig({ baseUrl: 'https://x', timeoutMs: 1500 }).timeoutMs).toBe(1500);
        expect(resolveConfig({ baseUrl: 'https://x', options: { ocr: undefined } }).defaults).toEqual(DEFAULT_OPTIONS);
    });

    test('copies option lists, so later changes by the caller do not leak in', () => {
        const ocrLang = ['de'];
        const pageRange: [number, number] = [1, 2];
        const config = resolveConfig({ baseUrl: 'http://x', options: { ocrLang, pageRange } });
        ocrLang.push('en');
        pageRange[1] = 9;
        expect([config.defaults.ocrLang, config.defaults.pageRange]).toEqual([['de'], [1, 2]]);
    });

    test('an empty ocrLang means the engine default', () => {
        expect(resolveConfig({ baseUrl: 'http://x', options: { ocrLang: [] } }).defaults.ocrLang).toEqual([]);
    });

    test('accepts null-prototype objects and rejects other non-plain objects', () => {
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

    test('throws a TypeError naming the key for invalid config', () => {
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
            [{ baseUrl: 'http://x', apiKey: '' }, 'Invalid value for option "apiKey"'],
            [{ baseUrl: 'http://x', apiKey: 1 }, 'Invalid value for option "apiKey"'],
            [{ baseUrl: 'http://x', fetch: 'x' }, 'Invalid value for option "fetch"'],
            [{ baseUrl: 'http://x', timeoutMs: 0 }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: '5' }, 'Invalid value for option "timeoutMs"'],
            [{ baseUrl: 'http://x', timeoutMs: Number.POSITIVE_INFINITY }, 'Invalid value for option "timeoutMs"'],
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

    test('rejects per-call options as factory defaults', () => {
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

    test('rejects invalid values and unknown keys in options', () => {
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
    test('without options: the defaults, placeholder output and no signal', () => {
        const expected = { options: DEFAULT_OPTIONS, output: { images: 'placeholder' } } as const;
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, undefined)).toEqual(expected);
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, {})).toEqual(expected);
        expect('signal' in resolveMarkdownCall(DEFAULT_OPTIONS, {})).toBe(false);
    });

    test('applies every per-call docling option over the defaults', () => {
        expect(resolveMarkdownCall(DEFAULT_OPTIONS, CALL_OPTIONS).options).toEqual(CALL_OPTIONS);
    });

    test('rejects factory-only options, keeps them from the factory defaults', () => {
        for (const options of FACTORY_ONLY) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveMarkdownCall(DEFAULT_OPTIONS, options), `Option "${name}" is not supported`);
        }
        const defaults = { ...DEFAULT_OPTIONS, ocrLang: ['de'], pageRange: [1, 2] as [number, number] };
        const call = resolveMarkdownCall(defaults, { ocr: false });
        expect(call.options).toEqual({ ...defaults, ocr: false });
    });

    test('call options override the factory defaults key by key; undefined keeps the default', () => {
        const defaults = { ...DEFAULT_OPTIONS, ocr: false, pageRange: [1, 2] as [number, number] };
        const call = resolveMarkdownCall(defaults, { ocr: undefined, pipeline: 'vlm', images: undefined });
        expect(call.options).toEqual({ ...defaults, pipeline: 'vlm' });
        expect(call.output).toEqual({ images: 'placeholder' });
    });

    test('separates the signal and the image output from the server options', () => {
        const signal = new AbortController().signal;
        const call = resolveMarkdownCall(DEFAULT_OPTIONS, { signal, ocr: false, images: 'none' });
        expect(call).toEqual({ options: { ...DEFAULT_OPTIONS, ocr: false }, output: { images: 'none' }, signal });
        expect(call.signal).toBe(signal);
    });

    test('extract: omitSmall defaults to true and can be turned off', () => {
        const call = resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions: { prefix: PREFIX } });
        expect(call.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: true } });
        const all = resolveMarkdownCall(DEFAULT_OPTIONS, {
            images: 'extract',
            imageOptions: { prefix: PREFIX, omitSmall: false },
        });
        expect(all.output).toEqual({ images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } });
    });

    test('imageOptions are required with extract and not allowed otherwise', () => {
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

    test('validates every image option with its nested name', () => {
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

    test('accepts any prefix without whitespace, parentheses or angle brackets', () => {
        for (const prefix of ['x', 'images/doc1_', './out/a-', 'C:/out/', 'a[1]-', 'ä/ö-']) {
            const call = resolveMarkdownCall(DEFAULT_OPTIONS, { images: 'extract', imageOptions: { prefix } });
            expect(call.output).toEqual({ images: 'extract', imageOptions: { prefix, omitSmall: true } });
        }
    });

    test('throws for invalid image modes, signals and docling options', () => {
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

    test('throws for unknown keys and options that are not an object', () => {
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
    test('without options: the defaults, embedded images, no page images and no signal', () => {
        const expected = { options: DEFAULT_OPTIONS, images: 'embedded', pageImages: false } as const;
        expect(resolveDocumentCall(DEFAULT_OPTIONS, undefined)).toEqual(expected);
        expect(resolveDocumentCall(DEFAULT_OPTIONS, { images: undefined, signal: undefined })).toEqual(expected);
    });

    test('applies docling options, image mode, page images and signal', () => {
        const signal = AbortSignal.abort();
        const options = { ...CALL_OPTIONS, images: 'placeholder', pageImages: true, signal };
        const call = resolveDocumentCall(DEFAULT_OPTIONS, options);
        expect(call).toEqual({ options: CALL_OPTIONS, images: 'placeholder', pageImages: true, signal });
        const defaults = { ...DEFAULT_OPTIONS, ocr: false };
        expect(resolveDocumentCall(defaults, { forceOcr: true }).options).toEqual({ ...defaults, forceOcr: true });
    });

    test('rejects factory-only options', () => {
        for (const options of FACTORY_ONLY) {
            const [name] = Object.keys(options);
            expectTypeError(() => resolveDocumentCall(DEFAULT_OPTIONS, options), `Option "${name}" is not supported`);
        }
    });

    test('throws for md image modes, imageOptions and invalid values', () => {
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

    test('throws for unknown keys and options that are not an object', () => {
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
    test('accepts nothing or a signal; an undefined signal counts as missing', () => {
        const signal = AbortSignal.abort();
        expect(resolveCheckOptions(undefined)).toEqual({});
        expect(resolveCheckOptions({})).toEqual({});
        expect(resolveCheckOptions({ signal: undefined })).toEqual({});
        expect(resolveCheckOptions({ signal })).toEqual({ signal });
    });

    test('throws for conversion options, bad signals and non-objects', () => {
        for (const name of ['ocr', 'images', 'imageOptions', 'pageRange']) {
            expectTypeError(() => resolveCheckOptions({ [name]: 1 }), `Option "${name}" is not supported`);
        }
        expectTypeError(() => resolveCheckOptions({ signal: 'x' }), 'Invalid value for option "signal"');
        expectTypeError(() => resolveCheckOptions(null), OPTIONS_OBJECT_EXPECTED);
        expectTypeError(() => resolveCheckOptions('x'), OPTIONS_OBJECT_EXPECTED);
        expectTypeError(() => resolveCheckOptions(new Map()), OPTIONS_OBJECT_EXPECTED);
    });

    test('throws for unknown keys even when their value is undefined', () => {
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

describe('validateJob', () => {
    const extractJob: Job = {
        kind: 'markdown',
        id: 'task-1',
        output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } },
    };
    const documentJob: Job = { kind: 'document', id: '0b5e_c0de-42' };

    test('accepts both job kinds, also after a JSON round trip', () => {
        const jobs: Job[] = [
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

    test('returns a copy without extra fields', () => {
        expect(validateJob({ ...documentJob, savedAt: 1, output: { images: 'none' } })).toEqual({
            ok: true,
            data: documentJob,
        });
        const res = validateJob({ ...extractJob, savedAt: 1 });
        expect(res).toEqual({ ok: true, data: extractJob });
        expect(res.ok && res.data).not.toBe(extractJob);
    });

    test('a stored extract job without omitSmall gets the default true', () => {
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

    test('rejects malformed jobs with invalid_input', () => {
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

    test('rejects invalid image output of md jobs with the option error appended', () => {
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

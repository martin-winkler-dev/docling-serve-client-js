// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import type { BoundingBox, DoclingDocument } from '../../src/document.js';
import {
    type ExtractedMarkdown,
    extractImages,
    extractPageImages,
    isSmallImage,
    PAGE_IMAGE_SCALE,
    readPngSize,
    removeImagePlaceholders,
    toPageImageBox,
} from '../../src/images.js';
import type { ImageOptions, ImageSize } from '../../src/types.js';
import { pngBytes, toBase64 } from '../mock/image-bytes.js';

/** Image extraction options with omitSmall disabled. */
const OPTIONS: Required<ImageOptions> = { prefix: 'out/images/1234-', omitSmall: false };

/** Minimal GIF header. */
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');

/** JPEG SOI + EOI: a format whose size is not read. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** Builds a markdown embedded base64 image link. */
function embedded(bytes: Uint8Array, mimeType = 'image/png', alt = 'Image'): string {
    return `![${alt}](data:${mimeType};base64,${toBase64(bytes)})`;
}

/** `extractImages` with the default test options. */
function extracted(markdown: string, options: Partial<Required<ImageOptions>> = {}): ExtractedMarkdown {
    return extractImages(markdown, { ...OPTIONS, ...options });
}

/** Document with two pages of 600 x 800 pt and 400 x 300 pt; only `pages` is read. */
const DOCUMENT = {
    pages: {
        '1': { page_no: 1, size: { width: 600, height: 800 }, image: null },
        '2': { page_no: 2, size: { width: 400, height: 300 }, image: null },
    },
} as unknown as DoclingDocument;

/** Box 100 pt from the left and 50 pt from the top of page 1, 200 x 30 pt, with a bottom-left origin. */
const BOTTOM_LEFT_BOX: BoundingBox = { l: 100, t: 750, r: 300, b: 720, coord_origin: 'BOTTOMLEFT' };

describe('toPageImageBox', () => {
    test('transforms bottom-left origin box to top-left origin and scales coordinates to 144 dpi pixels', () => {
        expect(PAGE_IMAGE_SCALE).toBe(2);
        expect(toPageImageBox(DOCUMENT, { page_no: 1, bbox: BOTTOM_LEFT_BOX })).toEqual({
            page: 1,
            x: 200,
            y: 100,
            width: 400,
            height: 60,
        });
    });

    test('scales top-left origin box without coordinate inversion using page height', () => {
        const bbox: BoundingBox = { l: 10, t: 20, r: 50, b: 35, coord_origin: 'TOPLEFT' };
        expect(toPageImageBox(DOCUMENT, { page_no: 2, bbox })).toEqual({
            page: 2,
            x: 20,
            y: 40,
            width: 80,
            height: 30,
        });
        const flipped = toPageImageBox(DOCUMENT, {
            page_no: 2,
            bbox: { ...bbox, t: 280, b: 265, coord_origin: 'BOTTOMLEFT' },
        });
        expect(flipped).toEqual({ page: 2, x: 20, y: 40, width: 80, height: 30 });
    });

    test('normalizes bounding box with inverted coordinates to positive width and height', () => {
        const bbox: BoundingBox = { l: 300, t: 720, r: 100, b: 750, coord_origin: 'BOTTOMLEFT' };
        expect(toPageImageBox(DOCUMENT, { page_no: 1, bbox })).toEqual({
            page: 1,
            x: 200,
            y: 100,
            width: 400,
            height: 60,
        });
    });

    test('returns undefined without throwing for missing pages or non-finite coordinates', () => {
        expect(toPageImageBox(DOCUMENT, { page_no: 3, bbox: BOTTOM_LEFT_BOX })).toBeUndefined();
        expect(toPageImageBox(DOCUMENT, { page_no: 1, bbox: { ...BOTTOM_LEFT_BOX, t: Number.NaN } })).toBeUndefined();
        expect(toPageImageBox(DOCUMENT, { page_no: 1, bbox: null as never })).toBeUndefined();
        expect(toPageImageBox({} as DoclingDocument, { page_no: 1, bbox: BOTTOM_LEFT_BOX })).toBeUndefined();
        expect(toPageImageBox(undefined as never, undefined as never)).toBeUndefined();
        expect(toPageImageBox(DOCUMENT, { bbox: BOTTOM_LEFT_BOX } as never)).toBeUndefined();
        expect(toPageImageBox(DOCUMENT, { page_no: Number.NaN, bbox: BOTTOM_LEFT_BOX })).toBeUndefined();
        expect(
            toPageImageBox(
                { pages: { undefined: { size: { width: 600, height: 800 } } } } as never,
                { bbox: BOTTOM_LEFT_BOX } as never,
            ),
        ).toBeUndefined();
        const noHeight = { pages: { '1': { page_no: 1, size: { width: 600 } } } } as unknown as DoclingDocument;
        expect(toPageImageBox(noHeight, { page_no: 1, bbox: BOTTOM_LEFT_BOX })).toBeUndefined();
    });
});

describe('readPngSize', () => {
    test('extracts image dimensions from PNG header', () => {
        expect(readPngSize(pngBytes(400, 300))).toEqual({ width: 400, height: 300 });
    });

    test('extracts image dimensions from a subarray view of a larger buffer', () => {
        const buffer = new Uint8Array(100);
        buffer.set(pngBytes(7, 9), 10);
        expect(readPngSize(buffer.subarray(10, 55))).toEqual({ width: 7, height: 9 });
    });

    test('returns undefined for non-PNG formats and truncated headers', () => {
        expect(readPngSize(GIF)).toBeUndefined();
        expect(readPngSize(JPEG)).toBeUndefined();
        const notPng = pngBytes(400, 300);
        notPng[1] = 0x51;
        expect(readPngSize(notPng)).toBeUndefined();
        expect(readPngSize(new Uint8Array())).toBeUndefined();
        expect(readPngSize(pngBytes(1, 1).subarray(0, 20))).toBeUndefined();
        expect(readPngSize(pngBytes(1, 1).subarray(0, 24))).toEqual({ width: 1, height: 1 });
    });

    test('requires full 8-byte PNG signature and leading IHDR chunk', () => {
        const shortSignature = new Uint8Array(24);
        shortSignature.set([0x89, 0x50, 0x4e, 0x47]);
        shortSignature.set([0, 0, 1, 0x90, 0, 0, 1, 0x2c], 16);
        expect(readPngSize(shortSignature)).toBeUndefined();
        const badSignature = pngBytes(400, 300);
        badSignature[7] = 0x00;
        expect(readPngSize(badSignature)).toBeUndefined();
        const noIhdr = pngBytes(400, 300);
        noIhdr.set([0x49, 0x44, 0x41, 0x54], 12); // IDAT
        expect(readPngSize(noIhdr)).toBeUndefined();
    });

    test('extracts dimensions from Buffer instances', () => {
        expect(readPngSize(Buffer.from(pngBytes(12, 34)))).toEqual({ width: 12, height: 34 });
    });

    test('returns undefined for non-Uint8Array inputs', () => {
        const png = pngBytes(400, 300);
        const invalid: unknown[] = [undefined, null, 'PNG', [...png], png.buffer, new DataView(png.buffer), {}];
        for (const value of invalid) {
            expect(readPngSize(value as Uint8Array)).toBeUndefined();
        }
    });
});

describe('extractImages', () => {
    test('replaces embedded data URI images with prefixed paths and returns image bytes', () => {
        const png = pngBytes(400, 300);
        const md = `# T\n\n${embedded(png)}\n\ntext\n\n${embedded(JPEG, 'image/jpeg', 'Figure')}`;
        expect(extracted(md)).toEqual({
            markdown: '# T\n\n![Image](out/images/1234-1.png)\n\ntext\n\n![Figure](out/images/1234-2.jpg)',
            images: [
                { path: 'out/images/1234-1.png', mimeType: 'image/png', bytes: png, width: 400, height: 300 },
                { path: 'out/images/1234-2.jpg', mimeType: 'image/jpeg', bytes: JPEG, width: 0, height: 0 },
            ],
            warnings: [],
        });
    });

    test('decodes base64 image data containing embedded whitespace and line breaks', () => {
        const base64 = toBase64(pngBytes(3, 4)).replace(/(.{10})/g, '$1\n');
        const res = extracted(`![Image](data:image/png;base64,${base64})`);
        expect(res.images[0]?.width).toBe(3);
    });

    test('removes small images cleanly and numbers only retained images when omitSmall is enabled', () => {
        const badge = embedded(pngBytes(88, 32));
        const md = `${badge}\n\nA\n\n${badge}\n\n${embedded(pngBytes(400, 300))}\n\nB\n\n${badge}`;
        const res = extracted(md, { omitSmall: true });
        expect(res.markdown).toBe('A\n\n![Image](out/images/1234-1.png)\n\nB');
        expect(res.images.map((image) => image.path)).toEqual(['out/images/1234-1.png']);
        expect(extracted(md).images).toHaveLength(4);
    });

    test('treats unreadable image sizes as 0x0 and retains them when omitSmall is enabled', () => {
        const md = `a\n\n${embedded(GIF, 'image/gif')}\n\nb`;
        const kept = extracted(md, { omitSmall: true });
        expect(kept.markdown).toBe('a\n\n![Image](out/images/1234-1.gif)\n\nb');
        expect(kept.images[0]).toMatchObject({ width: 0, height: 0, mimeType: 'image/gif' });
    });

    test('maps MIME subtypes to standard file extensions and unknown types to bin', () => {
        const extensions = [
            ['image/png', 'png'],
            ['image/jpeg', 'jpg'],
            ['image/jpg', 'jpg'],
            ['image/gif', 'gif'],
            ['image/webp', 'webp'],
            ['image/svg+xml', 'svg'],
            ['image/tiff', 'tiff'],
            ['image/bmp', 'bmp'],
            ['image/JPEG', 'jpg'],
            ['image/x-emf', 'bin'],
            ['image/vnd.microsoft.icon', 'bin'],
        ] as const;
        for (const [mimeType, extension] of extensions) {
            const [image] = extracted(embedded(GIF, mimeType)).images;
            expect(image).toMatchObject({ path: `out/images/1234-1.${extension}`, mimeType });
        }
    });

    test('returns extracted image bytes as standalone Uint8Array buffers', () => {
        const png = pngBytes(5, 6);
        const [image] = extracted(`${embedded(png)}\n\n${embedded(JPEG, 'image/jpeg')}`).images;
        expect(image?.bytes.constructor).toBe(Uint8Array);
        expect(image?.bytes).toEqual(png);
        expect(image?.bytes.byteOffset).toBe(0);
        expect(image?.bytes.buffer.byteLength).toBe(png.length);
    });

    test('decodes base64url encoded image data', () => {
        const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
        expect(toBase64(bytes)).toBe('+/+/');
        const [image] = extracted('![Image](data:image/gif;base64,-_-_)').images;
        expect(image?.bytes).toEqual(bytes);
    });

    test('removes image references with invalid base64 characters and emits image_not_decoded warning', () => {
        for (const broken of ['iVBOR!w0KGgo=', 'QUJD QUJD*', 'ab"cd']) {
            const res = extracted(`a\n\n![Image](data:image/png;base64,${broken})\n\nb`);
            expect(res.markdown).toBe('a\n\nb');
            expect(res.warnings.map((warning) => warning.code)).toEqual(['image_not_decoded']);
        }
    });

    test('decodes unpadded base64 image data', () => {
        const [image] = extracted('![Image](data:image/gif;base64,QQ)').images;
        expect(image?.bytes).toEqual(new Uint8Array([65]));
    });

    test('preserves existing image placeholders for pictures without embedded data', () => {
        const md = `a\n\n<!-- image -->\n\n${embedded(pngBytes(1, 1))}`;
        expect(extracted(md).markdown).toBe(`a\n\n<!-- image -->\n\n![Image](out/images/1234-1.png)`);
    });

    test('removes omitted small images adjacent to placeholders while preserving placeholders', () => {
        const badge = embedded(pngBytes(88, 32));
        const md = `a\n\n<!-- image -->\n\n${badge}\n\nb\n\n${badge}\n<!-- image -->\n\nc`;
        expect(extracted(md, { omitSmall: true }).markdown).toBe('a\n\n<!-- image -->\n\nb\n\n<!-- image -->\n\nc');
    });

    test('preserves paragraph boundary when removing omitted images', () => {
        const md = `a\n\n${embedded(pngBytes(88, 32))}\nb`;
        expect(extracted(md, { omitSmall: true }).markdown).toBe('a\n\nb');
    });

    test('removes invalid or empty base64 images with warning while preserving valid images', () => {
        for (const broken of ['abc=def', '', 'AAAAA', 'QQ==QQ==', '====']) {
            const png = pngBytes(2, 2);
            const md = `a\n\n![Broken](data:image/png;base64,${broken})\n\nb\n\n${embedded(png)}`;
            expect(extracted(md)).toEqual({
                markdown: 'a\n\nb\n\n![Image](out/images/1234-1.png)',
                images: [{ path: 'out/images/1234-1.png', mimeType: 'image/png', bytes: png, width: 2, height: 2 }],
                warnings: [
                    {
                        code: 'image_not_decoded',
                        message: 'Embedded image 1 has invalid or empty base64 data and was removed',
                        details: { index: 1 },
                    },
                ],
            });
        }
    });

    test('maintains sequential image index in warnings including omitted small images', () => {
        const badge = embedded(pngBytes(88, 32));
        const md = `${badge}\n\n${embedded(pngBytes(400, 300))}\n\n![Broken](data:image/png;base64,abc=def)`;
        const res = extracted(md, { omitSmall: true });
        expect(res.markdown).toBe('![Image](out/images/1234-1.png)');
        expect(res.warnings.map((warning) => warning.details)).toEqual([{ index: 3 }]);
    });

    test('removes inline images within text lines cleanly when omitted', () => {
        const md = `see ${embedded(pngBytes(16, 16))} and ![Broken](data:image/png;base64,) here`;
        const res = extracted(md, { omitSmall: true });
        expect(res.markdown).toBe('see  and  here');
        expect(res.images).toEqual([]);
        expect(res.warnings.map((warning) => warning.details)).toEqual([{ index: 2 }]);
    });

    test('returns markdown unchanged when no images are present', () => {
        const md = '# T\n\n![Photo](photo.png)\n\ntext';
        expect(extracted(md)).toEqual({ markdown: md, images: [], warnings: [] });
    });
});

describe('isSmallImage', () => {
    test('returns false for figures exceeding dimensions or area threshold', () => {
        const figures = [
            [435, 48],
            [95, 230],
            [433, 72],
            [302, 225],
            [400, 300],
        ] as const;
        for (const [width, height] of figures) {
            expect(isSmallImage({ width, height })).toBe(false);
        }
    });

    test('returns true for small badges, icons, square logos, and thin lines', () => {
        const small = [
            [157, 35],
            [88, 32],
            [178, 157],
            [150, 150],
            [2000, 11],
        ] as const;
        for (const [width, height] of small) {
            expect(isSmallImage({ width, height })).toBe(true);
        }
    });

    test('enforces threshold boundaries for area (15000), long edge (200), and short edge (24)', () => {
        expect(isSmallImage({ width: 200, height: 75 })).toBe(false);
        expect(isSmallImage({ width: 200, height: 74 })).toBe(true);
        expect(isSmallImage({ width: 199, height: 199 })).toBe(true);
        expect(isSmallImage({ width: 24, height: 1000 })).toBe(false);
        expect(isSmallImage({ width: 23, height: 1000 })).toBe(true);
    });

    test('evaluates picture sizes with fractional dimensions correctly', () => {
        expect(isSmallImage({ width: 433.5, height: 72.25 })).toBe(false);
        expect(isSmallImage({ width: 87.9, height: 31.4 })).toBe(true);
    });

    test('returns false without throwing for invalid or non-numeric image sizes', () => {
        const invalid: unknown[] = [
            undefined,
            null,
            {},
            { width: 10 },
            { height: 10 },
            { width: '10', height: 10 },
            { width: 10, height: null },
            { width: Number.NaN, height: 10 },
            { width: 10, height: Number.POSITIVE_INFINITY },
        ];
        for (const size of invalid) {
            expect(isSmallImage(size as ImageSize)).toBe(false);
        }
    });
});

describe('removeImagePlaceholders', () => {
    /** Image placeholder marker. */
    const P = '<!-- image -->';

    test('removes standalone placeholder paragraphs and collapses adjacent blank lines', () => {
        expect(removeImagePlaceholders(`${P}\n\nA`)).toBe('A');
        expect(removeImagePlaceholders(`A\n\n${P}\n\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n\n${P}`)).toBe('A');
        expect(removeImagePlaceholders(`A\n\n${P}\n`)).toBe('A\n');
        expect(removeImagePlaceholders(`A\n\n${P}\n\n  ${P} \n\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(P)).toBe('');
    });

    test('removes placeholders between consecutive text lines without modifying text', () => {
        expect(removeImagePlaceholders(`A\n${P}\nB`)).toBe('A\nB');
        expect(removeImagePlaceholders(`A\n${P}\n${P}\nB`)).toBe('A\nB');
    });

    test('preserves paragraph boundary when placeholder has whitespace on only one side', () => {
        expect(removeImagePlaceholders(`A\n\n${P}\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n${P}\n\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n\n${P}\n${P}\n\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n\n${P}\n\n${P}\n\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n\n${P}\n${P}\nB`)).toBe('A\n\nB');
        expect(removeImagePlaceholders(`A\n${P}`)).toBe('A');
        expect(removeImagePlaceholders(`${P}\nA`)).toBe('A');
    });

    test('removes inline placeholder comments within a text line', () => {
        expect(removeImagePlaceholders(`see ${P} here`)).toBe('see  here');
    });

    test('returns markdown unchanged when no placeholders are present', () => {
        expect(removeImagePlaceholders('a\n\n\n\nb')).toBe('a\n\n\n\nb');
    });
});

describe('extractPageImages', () => {
    test('falls back to 0x0 dimensions for non-PNG page images without explicit size metadata', () => {
        const doc = {
            pages: {
                '1': {
                    page_no: 1,
                    size: { width: 600, height: 800 },
                    image: {
                        mimetype: 'image/jpeg',
                        uri: `data:image/jpeg;base64,${toBase64(JPEG)}`,
                    },
                },
            },
        } as unknown as DoclingDocument;
        const result = extractPageImages(doc);
        expect(result.pageImages).toEqual([
            {
                page: 1,
                mimeType: 'image/jpeg',
                width: 0,
                height: 0,
                dpi: 0,
                bytes: JPEG,
            },
        ]);
        expect(result.warnings).toHaveLength(0);
    });
});

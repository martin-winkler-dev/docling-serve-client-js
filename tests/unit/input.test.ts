// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { detectInputFormat } from '../../src/core/input.js';
import { pngBytes } from '../mock/image-bytes.js';

/** JPEG SOI marker + APP0 start. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** Little-endian TIFF header. */
const TIFF_LE = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);

/** Big-endian TIFF header. */
const TIFF_BE = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);

/** RIFF container header of a WebP file. */
const WEBP = new TextEncoder().encode('RIFF\x24\x00\x00\x00WEBPVP8 ');

describe('detectInputFormat', () => {
    test('PDF: %PDF- within the first 1024 bytes', () => {
        const pdf = { fromFormat: 'pdf', mimeType: 'application/pdf', fileName: 'document.pdf' } as const;
        expect(detectInputFormat(new TextEncoder().encode('%PDF-1.7\n...'))).toEqual(pdf);
        expect(detectInputFormat(new TextEncoder().encode('junk%PDF-1.7\n...'))).toEqual(pdf);
        expect(detectInputFormat(Buffer.from('%PDF-1.4'))).toEqual(pdf);
    });

    test('images by their signature at byte 0, with docling format image and a matching file name', () => {
        const cases: [Uint8Array, string, string][] = [
            [pngBytes(10, 10), 'image/png', 'document.png'],
            [JPEG, 'image/jpeg', 'document.jpg'],
            [TIFF_LE, 'image/tiff', 'document.tiff'],
            [TIFF_BE, 'image/tiff', 'document.tiff'],
            [WEBP, 'image/webp', 'document.webp'],
        ];
        for (const [bytes, mimeType, fileName] of cases) {
            expect(detectInputFormat(bytes)).toEqual({ fromFormat: 'image', mimeType, fileName });
        }
    });

    test('an image whose data contains %PDF- stays an image', () => {
        const png = new Uint8Array([...pngBytes(1, 1), ...new TextEncoder().encode('%PDF-')]);
        expect(detectInputFormat(png)?.fromFormat).toBe('image');
    });

    test('unknown, partial, empty and non-Uint8Array input is undefined', () => {
        const unknown = [
            new Uint8Array(),
            new TextEncoder().encode('hello'),
            new TextEncoder().encode('GIF89a\x01\x00\x01\x00'),
            pngBytes(1, 1).subarray(0, 4),
            new TextEncoder().encode('RIFF\x24\x00\x00\x00WAVEfmt '),
            new Uint8Array([0xff, 0xd8]),
            new TextEncoder().encode(`${'x'.repeat(1024)}%PDF-1.7`),
        ];
        for (const bytes of unknown) {
            expect(detectInputFormat(bytes)).toBeUndefined();
        }
        for (const value of [pngBytes(1, 1).buffer, '%PDF-', null, undefined, [0x89, 0x50]]) {
            expect(detectInputFormat(value)).toBeUndefined();
        }
    });
});

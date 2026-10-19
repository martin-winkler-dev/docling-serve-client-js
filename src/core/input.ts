// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { isPdf } from './pdf.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Detected input format and how it is sent to docling-serve. */
export type InputFormat = {
    /** docling's `from_formats` value. */
    fromFormat: 'pdf' | 'image';
    /** MIME type of the multipart file part. */
    mimeType: string;
    /** File name of the multipart file part; docling reads the format from its extension. */
    fileName: string;
};

/** Image format recognized by byte signatures at fixed offsets. */
type ImageSignature = {
    mimeType: string;
    extension: string;
    /** Byte runs that must all match, each at its offset. */
    parts: [offset: number, bytes: number[]][];
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Image formats docling reads with `from_formats=image` (checked live on docling-serve 1.36.0). */
const IMAGE_SIGNATURES: readonly ImageSignature[] = [
    { mimeType: 'image/png', extension: 'png', parts: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
    { mimeType: 'image/jpeg', extension: 'jpg', parts: [[0, [0xff, 0xd8, 0xff]]] },
    // little-endian `II*\0` and big-endian `MM\0*`
    { mimeType: 'image/tiff', extension: 'tiff', parts: [[0, [0x49, 0x49, 0x2a, 0x00]]] },
    { mimeType: 'image/tiff', extension: 'tiff', parts: [[0, [0x4d, 0x4d, 0x00, 0x2a]]] },
    // `RIFF` <size> `WEBP`
    {
        mimeType: 'image/webp',
        extension: 'webp',
        parts: [
            [0, [0x52, 0x49, 0x46, 0x46]],
            [8, [0x57, 0x45, 0x42, 0x50]],
        ],
    },
];

/** Format of PDF input. */
const PDF_FORMAT: InputFormat = { fromFormat: 'pdf', mimeType: 'application/pdf', fileName: 'document.pdf' };

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Detects the input format by magic bytes**.
 *
 * - image signatures must start at byte 0; PDF: `%PDF-` within the first 1024 bytes
 * - images are checked first, so an image whose data happens to contain `%PDF-` is still an image
 * @returns `undefined` for empty, non-`Uint8Array` or unrecognized input
 */
export function detectInputFormat(bytes: unknown): InputFormat | undefined {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return undefined;
    }
    const image = IMAGE_SIGNATURES.find(({ parts }) =>
        parts.every(([offset, run]) => run.every((byte, i) => bytes[offset + i] === byte)),
    );
    if (image !== undefined) {
        return { fromFormat: 'image', mimeType: image.mimeType, fileName: `document.${image.extension}` };
    }
    return isPdf(bytes) ? PDF_FORMAT : undefined;
}

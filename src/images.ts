// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { isPlainObject } from './core/validate.js';
import type { BoundingBox, DoclingDocument, PageItem } from './document.js';
import type {
    ExtractedImage,
    ImageOptions,
    ImageSize,
    ImageWarning,
    PageImage,
    PageImageBox,
    PageImageWarning,
} from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Rewritten md, extracted image files, and `image_not_decoded` warnings. */
export type ExtractedMarkdown = {
    markdown: string;
    images: ExtractedImage[];
    warnings: ImageWarning[];
};

/** Document with decoded `pages[].image` set to `null`, the decoded page images and `page_image_not_decoded` warnings. */
export type ExtractedPageImages = {
    document: DoclingDocument;
    pageImages: PageImage[];
    warnings: PageImageWarning[];
};

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/**
 * **Pixels per PDF point of pictures and page images**: `images_scale` (144 dpi).
 *
 * - fixed, so page images and `toPageImageBox` always agree
 * - docling-serve's default and its maximum (`max_images_scale`); OCR runs at its own scale and is not affected
 */
export const PAGE_IMAGE_SCALE = 2;

/** docling's md comment for a picture without image data. */
const IMAGE_PLACEHOLDER = '<!-- image -->';

/** Internal marker for images dropped by `extractImages`; NUL never occurs in docling md. */
const OMITTED_IMAGE = '\u0000omitted-image\u0000';

/** Matches embedded base64 image links `![alt](data:image/...;base64,...)`; any data up to `)`, validated on decode. */
const MATCH_EMBEDDED_IMAGE = /!\[([^\]]*)\]\(data:(image\/[\w.+-]+);base64,([^)]*)\)/g;

/** Matches a whole base64 image data URI; group 1: MIME type, group 2: data (any, validated on decode). */
const MATCH_DATA_URI = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/;

/** PNG file signature, followed by the IHDR chunk length. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunk type `IHDR` at offsets 12 to 15 of a PNG. */
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];

/** Matches whitespace that docling may wrap base64 data with. */
const MATCH_WHITESPACE = /\s+/g;

/** File extension per lowercase MIME subtype; any other subtype gets `bin`. */
const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
    ['png', 'png'],
    ['jpeg', 'jpg'],
    ['jpg', 'jpg'],
    ['gif', 'gif'],
    ['webp', 'webp'],
    ['svg+xml', 'svg'],
    ['tiff', 'tiff'],
    ['bmp', 'bmp'],
]);

/** Extension for MIME subtypes missing from `IMAGE_EXTENSIONS`. */
const UNKNOWN_EXTENSION = 'bin';

/** Min pixel area of a figure. */
const MIN_FIGURE_AREA = 15_000;

/** Min length of a figure's longer side in pixels. */
const MIN_FIGURE_LONG_SIDE = 200;

/** Min length of a figure's shorter side in pixels. */
const MIN_FIGURE_SHORT_SIDE = 24;

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Size heuristic behind `omitSmall`**: icons, bullets, small logos and thin rules count as small.
 *
 * - small: area below 15 000 px, longer side below 200 px, or shorter side below 24 px
 * - works on `ExtractedImage` and on `pictures[].image.size` of a DoclingDocument
 * - `false` when width or height is not a finite number
 */
export function isSmallImage(size: ImageSize): boolean {
    const { width, height } = (size ?? {}) as Partial<ImageSize>;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return false;
    }
    const [w, h] = [width as number, height as number];
    return w * h < MIN_FIGURE_AREA || Math.max(w, h) < MIN_FIGURE_LONG_SIDE || Math.min(w, h) < MIN_FIGURE_SHORT_SIDE;
}

/** Reads pixel size from PNG IHDR chunk; returns `undefined` for non-PNG or truncated data. */
export function readPngSize(bytes: Uint8Array): ImageSize | undefined {
    if (!(bytes instanceof Uint8Array) || bytes.length < 24) {
        return undefined;
    }
    // IHDR holds 32-bit width and height at offsets 16 and 20.
    const isPng =
        PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && PNG_IHDR.every((byte, i) => bytes[12 + i] === byte);
    if (!isPng) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * **Extracts base64 images into raw bytes and replaces them with file links**.
 *
 * - links: `<prefix><n>.<ext>`, numbered over kept images only; extension mapped from the MIME subtype
 * - small images (with `omitSmall`) and undecodable images are removed like placeholders
 * - undecodable image: `image_not_decoded` warning with its 1-based index among all embedded images
 * - docling's own `<!-- image -->` placeholders (pictures sent without data) are kept
 */
export function extractImages(markdown: string, options: Required<ImageOptions>): ExtractedMarkdown {
    const images: ExtractedImage[] = [];
    const warnings: ImageWarning[] = [];
    let output = '';
    let copiedUpTo = 0;
    let index = 0;
    for (const match of markdown.matchAll(MATCH_EMBEDDED_IMAGE)) {
        const [token, alt = '', mimeType = '', base64 = ''] = match;
        index++;
        output += markdown.slice(copiedUpTo, match.index);
        copiedUpTo = match.index + token.length;
        const bytes = decodeBase64(base64);
        if (bytes === undefined) {
            warnings.push({
                code: 'image_not_decoded',
                message: `Embedded image ${index} has invalid or empty base64 data and was removed`,
                details: { index },
            });
            output += OMITTED_IMAGE;
            continue;
        }
        const size = readPngSize(bytes);
        if (options.omitSmall && size !== undefined && isSmallImage(size)) {
            // Marker, so removing it below also normalizes surrounding blank lines.
            output += OMITTED_IMAGE;
            continue;
        }
        const { width, height } = size ?? { width: 0, height: 0 };
        const subtype = mimeType.slice('image/'.length).toLowerCase();
        const extension = IMAGE_EXTENSIONS.get(subtype) ?? UNKNOWN_EXTENSION;
        const path = `${options.prefix}${images.length + 1}.${extension}`;
        images.push({ path, mimeType, bytes, width, height });
        output += `![${alt}](${path})`;
    }
    output += markdown.slice(copiedUpTo);
    return { markdown: removeMarkerLines(output, OMITTED_IMAGE), images, warnings };
}

/**
 * **Moves page images out of the DoclingDocument into raw bytes**.
 *
 * - every decoded `pages[].image` becomes `null`; the input document is not changed
 * - page number from `page_no`, else from the `pages` key; result sorted by page
 * - a URI that is not a base64 image data URI, or has invalid or empty data: `page_image_not_decoded` warning,
 *   and the page keeps its `image` as sent
 * - a document without a `pages` object is returned as it is
 */
export function extractPageImages(document: DoclingDocument): ExtractedPageImages {
    const pages: unknown = document.pages;
    if (!isPlainObject(pages)) {
        return { document, pageImages: [], warnings: [] };
    }
    const pageImages: PageImage[] = [];
    const warnings: PageImageWarning[] = [];
    const strippedPages: Record<string, PageItem> = {};
    for (const [key, page] of Object.entries(pages)) {
        strippedPages[key] = page as PageItem;
        if (!isPlainObject(page) || page.image == null) {
            continue;
        }
        const pageNo = Number.isInteger(page.page_no) ? (page.page_no as number) : Number(key);
        const image = (isPlainObject(page.image) ? page.image : {}) as Partial<NonNullable<PageItem['image']>>;
        const [, mimeType = '', base64 = ''] = MATCH_DATA_URI.exec(String(image.uri)) ?? [];
        const bytes = decodeBase64(base64);
        if (bytes === undefined) {
            warnings.push({
                code: 'page_image_not_decoded',
                message: `Page image of page ${pageNo} is not a base64 image data URI or has invalid or empty data`,
                details: { page: pageNo },
            });
            continue;
        }
        strippedPages[key] = { ...page, image: null } as PageItem;
        const { width, height } = readPngSize(bytes) ?? readImageSize(image.size) ?? { width: 0, height: 0 };
        const dpi = typeof image.dpi === 'number' && Number.isFinite(image.dpi) ? image.dpi : 0;
        pageImages.push({ page: pageNo, mimeType, width, height, dpi, bytes });
    }
    pageImages.sort((a, b) => a.page - b.page);
    return { document: { ...document, pages: strippedPages }, pageImages, warnings };
}

/**
 * **Maps a docling bounding box onto its page image, in pixels with a top-left origin**.
 *
 * - `prov`: any `prov[]` entry; for a table cell pass `{ page_no: table.prov[0].page_no, bbox: cell.bbox }`
 * - flips `BOTTOMLEFT` boxes using the page height from `document.pages`, then scales points by `PAGE_IMAGE_SCALE`
 * - works without `pageImages: true`; the boxes fit the page images of any conversion by this client
 * - returns `undefined` when `page_no` or coordinate is not a finite number, or page is missing from `document.pages`
 */
export function toPageImageBox(
    document: DoclingDocument,
    prov: { page_no: number; bbox?: BoundingBox | null },
): PageImageBox | undefined {
    const pageNo = prov?.page_no;
    if (!isFiniteNumber(pageNo)) {
        return undefined;
    }
    const pages: unknown = document?.pages;
    const page: unknown = isPlainObject(pages) ? pages[String(pageNo)] : undefined;
    const size: unknown = isPlainObject(page) ? page.size : undefined;
    const bbox: unknown = prov?.bbox;
    if (!isPlainObject(size) || !isPlainObject(bbox)) {
        return undefined;
    }
    const { l, t, r, b } = bbox;
    const pageHeight = size.height;
    const isValid =
        isFiniteNumber(l) && isFiniteNumber(t) && isFiniteNumber(r) && isFiniteNumber(b) && isFiniteNumber(pageHeight);
    if (!isValid) {
        return undefined;
    }
    const [top, bottom] = bbox.coord_origin === 'BOTTOMLEFT' ? [pageHeight - t, pageHeight - b] : [t, b];
    return {
        page: pageNo,
        x: Math.min(l, r) * PAGE_IMAGE_SCALE,
        y: Math.min(top, bottom) * PAGE_IMAGE_SCALE,
        width: Math.abs(r - l) * PAGE_IMAGE_SCALE,
        height: Math.abs(bottom - top) * PAGE_IMAGE_SCALE,
    };
}

/**
 * **Removes `<!-- image -->` placeholders**.
 *
 * - a placeholder line goes; blank lines separating the text around it stay, without leaving a blank-line run
 * - a placeholder inside a line is cut out of it
 */
export function removeImagePlaceholders(markdown: string): string {
    return removeMarkerLines(markdown, IMAGE_PLACEHOLDER);
}

// -------------------------------------------------------------------
// --- 4. Internal Functions
// -------------------------------------------------------------------

/**
 * **Decodes base64 into a plain `Uint8Array`**.
 *
 * - `Buffer.from` ignores whitespace and stops at the first invalid character or inner `=`
 * - valid only when decoded length equals `floor(length * 3 / 4) - padding` of stripped input
 * - small buffers come from Node's shared pool and are copied, so `bytes.buffer` holds this image only
 * - returns `undefined` for invalid or empty base64
 */
function decodeBase64(base64: string): Uint8Array | undefined {
    const stripped = base64.replace(MATCH_WHITESPACE, '');
    if (stripped.length % 4 === 1) {
        return undefined;
    }
    const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0;
    const decoded = Buffer.from(stripped, 'base64');
    if (decoded.length === 0 || decoded.length !== Math.floor((stripped.length * 3) / 4) - padding) {
        return undefined;
    }
    const isOwnBuffer = decoded.byteOffset === 0 && decoded.buffer.byteLength === decoded.length;
    return isOwnBuffer ? new Uint8Array(decoded.buffer, 0, decoded.length) : new Uint8Array(decoded);
}

/**
 * **Removes `marker` from md, normalizing blank lines around marker-only lines**.
 *
 * - marker-only line: dropped; one neighbouring blank line goes only when blank lines are left on both sides,
 *   or at the start or end of the md, so paragraphs stay separated
 * - marker inside a line: cut out of it
 */
function removeMarkerLines(markdown: string, marker: string): string {
    if (!markdown.includes(marker)) {
        return markdown;
    }
    const lines = markdown.split('\n');
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim() !== marker) {
            kept.push(line.replaceAll(marker, ''));
            continue;
        }
        const previous = kept.at(-1);
        const next = lines[i + 1];
        if (isBlank(next) && (previous === undefined || isBlank(previous))) {
            i++;
        } else if (next === undefined && isBlank(previous)) {
            kept.pop();
        }
    }
    return kept.join('\n');
}

/** Size with finite width and height; `undefined` otherwise. */
function readImageSize(size: unknown): ImageSize | undefined {
    if (!isPlainObject(size) || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
        return undefined;
    }
    return { width: size.width as number, height: size.height as number };
}

/** Number other than `NaN` and `±Infinity`. */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Defined and whitespace-only line. */
function isBlank(line: string | undefined): boolean {
    return line !== undefined && line.trim() === '';
}

// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// End-to-end tests against a running docling-serve. They only run with DOCLING_E2E=1 (`bun run test:e2e`) and then fail
// when the server is not reachable, so a renamed server field or changed output shows up. CI skips them.
import { beforeAll, describe, expect, test } from 'bun:test';
import {
    type AnyTextItem,
    type ClientOptions,
    type ConvertedDocument,
    type ConvertedMarkdown,
    createDoclingClient,
    type DoclingClient,
    type DocumentJob,
    isSmallImage,
    type JobState,
    type MarkdownJob,
    type Result,
    readPngSize,
} from '../../src/index.js';
import { createSamplePdf, SAMPLE_TEXT } from './sample-pdf.js';

const E2E = process.env.DOCLING_E2E === '1';
const BASE_URL = process.env.DOCLING_URL ?? 'http://127.0.0.1:5001';
const TIMEOUT = 180_000;
const PREFIX = 'out/images/1234-';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
/** Start of picture data URIs with `images: 'embedded'`. */
const PNG_DATA_URI = 'data:image/png;base64,';

let docling: DoclingClient;
/** Client limited to page 1 (`pageRange` is factory-only). */
let firstPage: DoclingClient;
/** Two text pages: "Sample Report" (with `&` and `<` in the body) and "Second Page". */
let textPdf: Uint8Array;
/** Numbered headings, a bar chart picture and a small badge picture. */
let imagePdf: Uint8Array;

/** Polls a md job every 500 ms until it is done or failed. */
async function waitForMarkdown(job: MarkdownJob): Promise<Result<JobState<ConvertedMarkdown>>> {
    const deadline = Date.now() + TIMEOUT;
    let state = await docling.check(job);
    while (state.ok && state.data.status !== 'done' && Date.now() < deadline) {
        await Bun.sleep(500);
        state = await docling.check(job);
    }
    return state;
}

/** Polls a document job every 500 ms until it is done or failed. */
async function waitForDocument(job: DocumentJob): Promise<Result<JobState<ConvertedDocument>>> {
    const deadline = Date.now() + TIMEOUT;
    let state = await docling.check(job);
    while (state.ok && state.data.status !== 'done' && Date.now() < deadline) {
        await Bun.sleep(500);
        state = await docling.check(job);
    }
    return state;
}

/** Number of `#` of the heading with this text, 0 when it is not a heading. */
function headingLevel(markdown: string, heading: string): number {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^(#+) ${escaped}$`, 'm').exec(markdown)?.[1]?.length ?? 0;
}

/** Data of a successful result; throws with the error code otherwise. */
function dataOf<T>(res: Result<T>): T {
    if (!res.ok) {
        throw new Error(`${res.error.code}: ${res.error.message}`);
    }
    return res.data;
}

/** Text item whose text equals `text`. */
function textItem(items: AnyTextItem[], text: string): AnyTextItem | undefined {
    return items.find((item) => item.text === text);
}

describe.skipIf(!E2E)('docling-serve (e2e)', () => {
    beforeAll(async () => {
        const online = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) }).then(
            (res) => res.ok,
            () => false,
        );
        if (!online) {
            throw new Error(`docling-serve is not reachable at ${BASE_URL}`);
        }
        docling = createDoclingClient({ baseUrl: BASE_URL });
        firstPage = createDoclingClient({ baseUrl: BASE_URL, options: { pageRange: [1, 1] } });
        textPdf = await Bun.file(new URL('../fixtures/sample.pdf', import.meta.url)).bytes();
        imagePdf = createSamplePdf();
    });

    test(
        'contract: the server accepts every option with a non-default value, for both formats',
        async () => {
            // A broken PDF fails before any model loads, so this only checks that no field is rejected (422).
            const broken = new TextEncoder().encode('%PDF-1.7 truncated');
            const options: ClientOptions = {
                headingHierarchy: false,
                formulaEnrichment: false,
                codeEnrichment: true,
                chartExtraction: true,
                pipeline: 'vlm',
                pdfBackend: 'pypdfium2',
                ocr: false,
                forceOcr: true,
                ocrLang: ['de', 'en-US'],
                pageRange: [1, 1],
                documentTimeout: 30,
            };
            const client = createDoclingClient({ baseUrl: BASE_URL, options });
            const markdownJob = dataOf(
                await client.submitMarkdown(broken, {
                    images: 'extract',
                    imageOptions: { prefix: PREFIX },
                }),
            );
            const markdownState = await waitForMarkdown(markdownJob);
            expect(markdownState.ok || markdownState.error.code).toBe('conversion_failed');
            const documentJob = dataOf(
                await client.submitDocument(broken, { images: 'placeholder', pageImages: true }),
            );
            const documentState = await waitForDocument(documentJob);
            expect(documentState.ok || documentState.error.code).toBe('conversion_failed');
        },
        TIMEOUT,
    );

    test(
        'page images: moved out of the document as PNG bytes; an image converts as one page',
        async () => {
            const { document, pageImages, warnings } = dataOf(
                await firstPage.convertDocument(textPdf, {
                    pageImages: true,
                    images: 'placeholder',
                }),
            );
            expect(warnings).toEqual([]);
            expect(JSON.stringify(document)).not.toContain('data:image');
            expect(document.pages['1']?.image).toBeNull();
            const [page] = pageImages;
            expect(pageImages).toHaveLength(1);
            expect(page?.page).toBe(1);
            expect(page?.mimeType).toBe('image/png');
            expect([...(page?.bytes.subarray(0, 4) ?? [])]).toEqual(PNG_SIGNATURE);
            expect(readPngSize(page?.bytes ?? new Uint8Array())).toEqual({ width: page?.width, height: page?.height });
            // rendered at 144 dpi: two pixels per point
            expect(page?.dpi).toBe(144);
            expect(Math.abs((page?.width ?? 0) - 2 * (document.pages['1']?.size.width ?? 0))).toBeLessThanOrEqual(1);
            // The page image goes back in as image input; docling treats it as a single page.
            // OCR runs although the options turn it off: an image has no other text.
            const image = dataOf(
                await docling.convertDocument(page?.bytes ?? new Uint8Array(), { ocr: false, forceOcr: true }),
            );
            expect(Object.keys(image.document.pages)).toEqual(['1']);
            expect(image.document.texts.length).toBeGreaterThan(0);
            expect(image.document.origin?.filename).toBe('document.png');
        },
        TIMEOUT,
    );

    test(
        'convertMarkdown: a page range; docling md is returned unchanged',
        async () => {
            const { markdown, images, warnings, versions } = dataOf(await firstPage.convertMarkdown(textPdf));
            expect(markdown).toContain('Sample Report');
            expect(markdown).not.toContain('Second Page');
            // docling escapes HTML entities; the client no longer repairs them
            expect(markdown).toContain('Research &amp; Development');
            expect(images).toEqual([]);
            expect(warnings).toEqual([]);
            expect(versions?.['docling-serve']).toBeString();
        },
        TIMEOUT,
    );

    test(
        'convertMarkdown: the pypdfium2 backend reads the text too',
        async () => {
            const { markdown } = dataOf(await docling.convertMarkdown(textPdf, { pdfBackend: 'pypdfium2' }));
            expect(markdown).toContain('Sample Report');
            expect(markdown).toContain('Second Page');
        },
        TIMEOUT,
    );

    test(
        'convertMarkdown: headingHierarchy nests numbered headings; false keeps them flat',
        async () => {
            const nested = dataOf(await docling.convertMarkdown(imagePdf, { images: 'none' })).markdown;
            expect(headingLevel(nested, SAMPLE_TEXT.section)).toBeGreaterThan(0);
            expect(headingLevel(nested, SAMPLE_TEXT.subsection)).toBeGreaterThan(
                headingLevel(nested, SAMPLE_TEXT.section),
            );
            const flat = dataOf(
                await docling.convertMarkdown(imagePdf, { images: 'none', headingHierarchy: false }),
            ).markdown;
            expect(headingLevel(flat, SAMPLE_TEXT.subsection)).toBe(headingLevel(flat, SAMPLE_TEXT.section));
        },
        TIMEOUT,
    );

    test(
        'convertMarkdown: images placeholder marks pictures, none removes them',
        async () => {
            const placeholder = dataOf(await docling.convertMarkdown(imagePdf));
            expect(placeholder.markdown.match(/<!-- image -->/g)).toHaveLength(2);
            expect(placeholder.markdown).not.toContain('base64');
            expect(placeholder.images).toEqual([]);
            const none = dataOf(await docling.convertMarkdown(imagePdf, { images: 'none' }));
            expect(none.markdown).not.toContain('<!--');
            expect(none.markdown).not.toMatch(/\n\n\n/);
            expect(none.markdown).toContain(SAMPLE_TEXT.results);
            expect(none.images).toEqual([]);
        },
        TIMEOUT,
    );

    test(
        'convertMarkdown: images extract returns PNG bytes linked under the prefix; omitSmall drops the badge',
        async () => {
            const all = dataOf(
                await docling.convertMarkdown(imagePdf, {
                    images: 'extract',
                    imageOptions: { prefix: PREFIX, omitSmall: false },
                }),
            );
            expect(all.markdown).not.toContain('base64');
            expect(all.markdown).not.toContain('<!-- image -->');
            expect(all.warnings).toEqual([]);
            expect(all.images).toHaveLength(2);
            for (const [index, extracted] of all.images.entries()) {
                expect(extracted.path).toBe(`${PREFIX}${index + 1}.png`);
                expect(extracted.mimeType).toBe('image/png');
                expect(all.markdown).toContain(`](${extracted.path})`);
                expect([...extracted.bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
                expect(readPngSize(extracted.bytes)).toEqual({ width: extracted.width, height: extracted.height });
            }
            expect(all.images.map(isSmallImage)).toEqual([false, true]);
            const filtered = dataOf(
                await docling.convertMarkdown(imagePdf, { images: 'extract', imageOptions: { prefix: PREFIX } }),
            );
            expect(filtered.images.map((extracted) => extracted.path)).toEqual([`${PREFIX}1.png`]);
            expect(filtered.images[0]?.width).toBeGreaterThan(300);
            expect(filtered.markdown).not.toContain(`${PREFIX}2.png`);
        },
        TIMEOUT,
    );

    test(
        'convertDocument: embedded pictures carry PNG data URIs; texts are typed by label',
        async () => {
            const { document, warnings, versions } = dataOf(await docling.convertDocument(imagePdf));
            expect(document.schema_name).toBe('DoclingDocument');
            expect(document.body.children.length).toBeGreaterThan(0);
            expect(Object.keys(document.pages)).toEqual(['1']);
            expect(warnings).toEqual([]);
            expect(versions?.['docling-serve']).toBeString();
            expect(document.pictures).toHaveLength(2);
            const sizes = document.pictures.map((picture) => {
                expect(picture.image?.uri).toStartWith(PNG_DATA_URI);
                return picture.image?.size ?? { width: 0, height: 0 };
            });
            expect(sizes.map(isSmallImage)).toEqual([false, true]);
            const section = textItem(document.texts, SAMPLE_TEXT.section);
            const subsection = textItem(document.texts, SAMPLE_TEXT.subsection);
            expect(section?.label).toBe('section_header');
            expect(subsection?.label).toBe('section_header');
            if (section?.label === 'section_header' && subsection?.label === 'section_header') {
                expect(subsection.level).toBeGreaterThan(section.level);
            }
        },
        TIMEOUT,
    );

    test(
        'convertDocument: placeholder keeps picture items without image data',
        async () => {
            const { document } = dataOf(await docling.convertDocument(imagePdf, { images: 'placeholder' }));
            expect(document.pictures).toHaveLength(2);
            for (const picture of document.pictures) {
                expect(picture.image).toBeNull();
                expect(picture.prov.length).toBeGreaterThan(0);
            }
            expect(JSON.stringify(document)).not.toContain('base64');
        },
        TIMEOUT,
    );

    test('enrichments: formula and code models run', async () => {
        const res = await firstPage.convertMarkdown(textPdf, {
            formulaEnrichment: true,
            codeEnrichment: true,
        });
        expect(dataOf(res).markdown).toContain('Sample Report');
    }, 600_000);

    test(
        'submitMarkdown + check: the job object survives a JSON round trip',
        async () => {
            const job = dataOf(
                await docling.submitMarkdown(imagePdf, {
                    images: 'extract',
                    imageOptions: { prefix: PREFIX, omitSmall: false },
                }),
            );
            expect(job).toMatchObject({
                kind: 'markdown',
                output: { images: 'extract', imageOptions: { prefix: PREFIX, omitSmall: false } },
            });
            const state = dataOf(await waitForMarkdown(JSON.parse(JSON.stringify(job))));
            expect(state.status).toBe('done');
            if (state.status === 'done') {
                expect(state.images).toHaveLength(2);
                expect(state.markdown).toContain(`](${PREFIX}1.png)`);
                expect(state.versions?.['docling-serve']).toBeString();
            }
        },
        TIMEOUT,
    );

    test(
        'submitMarkdown + check: placeholder and none apply when the result is picked up',
        async () => {
            const placeholder = dataOf(await waitForMarkdown(dataOf(await docling.submitMarkdown(imagePdf))));
            expect(placeholder.status === 'done' && placeholder.markdown).toContain('<!-- image -->');
            const none = dataOf(
                await waitForMarkdown(dataOf(await docling.submitMarkdown(imagePdf, { images: 'none' }))),
            );
            expect(none.status === 'done' && none.markdown).not.toContain('<!--');
        },
        TIMEOUT,
    );

    test(
        'submitDocument + check: embedded and placeholder pictures',
        async () => {
            const job = dataOf(await docling.submitDocument(imagePdf));
            expect(job).toEqual({ kind: 'document', id: expect.any(String) });
            const embedded = dataOf(await waitForDocument(JSON.parse(JSON.stringify(job))));
            expect(embedded.status).toBe('done');
            if (embedded.status === 'done') {
                expect(embedded.document.pictures.map((picture) => picture.image?.uri.slice(0, 22))).toEqual([
                    PNG_DATA_URI,
                    PNG_DATA_URI,
                ]);
            }
            const placeholder = dataOf(
                await waitForDocument(dataOf(await docling.submitDocument(imagePdf, { images: 'placeholder' }))),
            );
            expect(
                placeholder.status === 'done' && placeholder.document.pictures.map((picture) => picture.image),
            ).toEqual([null, null]);
        },
        TIMEOUT,
    );

    test(
        'broken PDF -> conversion_failed, for both formats',
        async () => {
            const broken = new TextEncoder().encode('%PDF-1.7 truncated garbage');
            const markdown = await docling.convertMarkdown(broken);
            expect(markdown.ok || markdown.error.code).toBe('conversion_failed');
            const document = await docling.convertDocument(broken);
            expect(document.ok || document.error.code).toBe('conversion_failed');
        },
        TIMEOUT,
    );

    test('unknown job id -> not_found, for both job kinds', async () => {
        const markdown = await docling.check({ kind: 'markdown', id: 'does-not-exist', output: { images: 'none' } });
        expect(markdown.ok || markdown.error.code).toBe('not_found');
        const document = await docling.check({ kind: 'document', id: 'does-not-exist' });
        expect(document.ok || document.error.code).toBe('not_found');
    });

    test('unreachable server -> network', async () => {
        const unreachable = createDoclingClient({ baseUrl: 'http://127.0.0.1:1' });
        const markdown = await unreachable.convertMarkdown(textPdf);
        expect(markdown.ok || markdown.error.code).toBe('network');
        const document = await unreachable.convertDocument(textPdf);
        expect(document.ok || document.error.code).toBe('network');
    });
});

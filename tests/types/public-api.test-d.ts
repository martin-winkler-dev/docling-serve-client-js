// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// Type tests: checked by `tsc` (`bun run test:types`), never executed.
import { expectTypeOf } from 'bun:test';
import {
    type AnyTextItem,
    type CallOptions,
    type CapabilityLimits,
    type CapabilityPreset,
    type CapabilityStage,
    type ClientOptions,
    type ConversionFailure,
    type ConvertedDocument,
    type ConvertedMarkdown,
    createDoclingClient,
    type DoclingClient,
    type DoclingDocument,
    type DoclingOptions,
    type DoclingSettings,
    type DocumentImageMode,
    type DocumentJob,
    type DocumentWarning,
    type ErrorCode,
    type ExtractedImage,
    type ImageRef,
    type ImageSize,
    type ImageWarning,
    isSmallImage,
    type Job,
    type JobRef,
    type JobState,
    type MarkdownImageMode,
    type MarkdownJob,
    type MarkdownWarning,
    type OcrEngine,
    PAGE_IMAGE_SCALE,
    type PageImage,
    type PageImageBox,
    type PageImageWarning,
    type PdfBackend,
    type PictureItem,
    type Pipeline,
    type ProvenanceItem,
    type Result,
    readPngSize,
    type ServerCapabilities,
    type ServerDetails,
    type ServerVersions,
    type ServerWarning,
    toPageImageBox,
    type WithSettings,
} from '../../src/index.js';

declare const client: DoclingClient;
declare const pdf: Uint8Array;
declare const markdownJob: MarkdownJob;
declare const documentJob: DocumentJob;
declare const job: Job;

expectTypeOf(createDoclingClient({ baseUrl: '' })).toEqualTypeOf<DoclingClient>();

// --- Results: `ok` narrows to `data` or `error`.

declare const md: Result<ConvertedMarkdown>;
if (md.ok) {
    expectTypeOf(md.data.markdown).toBeString();
    expectTypeOf(md.data.images).toEqualTypeOf<ExtractedImage[]>();
    expectTypeOf(md.data.images[0]!.bytes).toEqualTypeOf<Uint8Array>();
    expectTypeOf(md.data.warnings).toEqualTypeOf<MarkdownWarning[]>();
    expectTypeOf(md.data.versions).toEqualTypeOf<ServerVersions | null>();
    // @ts-expect-error md results carry no document
    md.data.document;
} else {
    expectTypeOf(md.error.code).toEqualTypeOf<ErrorCode>();
    expectTypeOf(md.error.message).toBeString();
    expectTypeOf(md.error.status).toEqualTypeOf<number | undefined>();
    expectTypeOf(md.error.versions).toEqualTypeOf<ServerVersions | null | undefined>();
    // only conversion_failed carries details
    if (md.error.code === 'conversion_failed') {
        expectTypeOf(md.error.details).toEqualTypeOf<ConversionFailure>();
    } else {
        // @ts-expect-error other codes have no details
        md.error.details;
    }
}
// @ts-expect-error data needs narrowing on `ok` first
md.data;

expectTypeOf<ErrorCode>().toEqualTypeOf<
    'invalid_input' | 'network' | 'aborted' | 'http' | 'not_found' | 'conversion_failed' | 'invalid_response'
>();

declare const doc: Result<ConvertedDocument>;
if (doc.ok) {
    expectTypeOf(doc.data.document).toEqualTypeOf<DoclingDocument>();
    expectTypeOf(doc.data.warnings).toEqualTypeOf<DocumentWarning[]>();
    expectTypeOf(doc.data.pageImages).toEqualTypeOf<PageImage[]>();
    expectTypeOf(doc.data.pageImages[0]!.page).toBeNumber();
    expectTypeOf(doc.data.pageImages[0]!.bytes).toEqualTypeOf<Uint8Array>();
    expectTypeOf(doc.data.versions).toEqualTypeOf<ServerVersions | null>();
    // @ts-expect-error document results carry no md
    doc.data.markdown;
}

// --- Warnings: `code` narrows `details`.

declare const warning: MarkdownWarning;
expectTypeOf(warning.code).toEqualTypeOf<'server' | 'image_not_decoded'>();
if (warning.code === 'server') {
    expectTypeOf(warning.details).toEqualTypeOf<ServerDetails>();
    expectTypeOf(warning.details.page).toEqualTypeOf<number | null>();
} else {
    expectTypeOf(warning).toEqualTypeOf<ImageWarning>();
    expectTypeOf(warning.details).toEqualTypeOf<{ index: number }>();
}
// @ts-expect-error details need narrowing on `code` first
warning.details.page;
// @ts-expect-error document conversions have no image warnings
expectTypeOf<ImageWarning>().toExtend<ConvertedDocument['warnings'][number]>();
// @ts-expect-error md conversions have no page image warnings
expectTypeOf<PageImageWarning>().toExtend<MarkdownWarning>();

declare const documentWarning: DocumentWarning;
expectTypeOf(documentWarning.code).toEqualTypeOf<'server' | 'page_image_not_decoded'>();
if (documentWarning.code === 'page_image_not_decoded') {
    expectTypeOf(documentWarning.details).toEqualTypeOf<{ page: number }>();
} else {
    expectTypeOf(documentWarning).toEqualTypeOf<ServerWarning>();
}

// --- Calls resolve to the matching Result.

expectTypeOf(client.convertMarkdown(pdf)).resolves.toEqualTypeOf<Result<WithSettings<ConvertedMarkdown>>>();
expectTypeOf(client.convertDocument(pdf)).resolves.toEqualTypeOf<Result<WithSettings<ConvertedDocument>>>();
expectTypeOf(client.submitMarkdown(pdf)).resolves.toEqualTypeOf<Result<MarkdownJob>>();
expectTypeOf(client.submitDocument(pdf)).resolves.toEqualTypeOf<Result<DocumentJob>>();
expectTypeOf(client.capabilities()).resolves.toEqualTypeOf<Result<ServerCapabilities>>();
expectTypeOf(client.capabilities({ signal: AbortSignal.timeout(1000) })).resolves.toEqualTypeOf<
    Result<ServerCapabilities>
>();
// @ts-expect-error capabilities() takes only CallOptions
client.capabilities({ ocr: false });

declare const capabilities: ServerCapabilities;
expectTypeOf(capabilities.versions).toEqualTypeOf<ServerVersions>();
expectTypeOf(capabilities.stages).toEqualTypeOf<Record<string, CapabilityStage>>();
expectTypeOf(capabilities.stages.ocr!.presets[0]!).toEqualTypeOf<CapabilityPreset>();
expectTypeOf(capabilities.limits).toEqualTypeOf<CapabilityLimits>();
expectTypeOf(capabilities.features.websocket).toBeBoolean();

declare const settings: DoclingSettings;
expectTypeOf(settings.fromFormats).toEqualTypeOf<'pdf' | 'image'>();
expectTypeOf(settings.toFormats).toEqualTypeOf<'md' | 'json'>();
expectTypeOf(settings.mdCompactTables).toEqualTypeOf<boolean | null>();
expectTypeOf(settings.pageRange).toEqualTypeOf<[from: number, to: number] | null>();

// --- check() is overloaded per job kind; settings on the job are optional for check().

declare const jobRef: JobRef;
expectTypeOf(client.check(markdownJob)).resolves.toEqualTypeOf<Result<JobState<ConvertedMarkdown>>>();
expectTypeOf(client.check(documentJob)).resolves.toEqualTypeOf<Result<JobState<ConvertedDocument>>>();
expectTypeOf(client.check(job)).resolves.toEqualTypeOf<Result<JobState<ConvertedMarkdown | ConvertedDocument>>>();
expectTypeOf(client.check(jobRef)).resolves.toEqualTypeOf<Result<JobState<ConvertedMarkdown | ConvertedDocument>>>();
// a literal job object without settings picks the overload by its `kind`
expectTypeOf(client.check({ kind: 'document', id: 'x' })).resolves.toEqualTypeOf<Result<JobState<ConvertedDocument>>>();
expectTypeOf(client.check({ kind: 'markdown', id: 'x', output: { images: 'none' } })).resolves.toEqualTypeOf<
    Result<JobState<ConvertedMarkdown>>
>();

// `status` narrows the job state: the result only once done, position only while queued; done has no settings.
declare const state: JobState<ConvertedMarkdown>;
if (state.status === 'done') {
    expectTypeOf(state.markdown).toBeString();
    expectTypeOf(state.images).toEqualTypeOf<ExtractedImage[]>();
    // @ts-expect-error check() done state carries no settings (they are on the job)
    state.settings;
}
if (state.status === 'queued') {
    expectTypeOf(state.position).toEqualTypeOf<number | null>();
}
// @ts-expect-error markdown does not exist before the job is done
state.markdown;
declare const documentState: JobState<ConvertedDocument>;
if (documentState.status === 'done') {
    expectTypeOf(documentState.document).toEqualTypeOf<DoclingDocument>();
}

// --- Jobs: `kind` narrows the job, `images` narrows the md output.

if (job.kind === 'markdown') {
    expectTypeOf(job).toEqualTypeOf<MarkdownJob>();
    expectTypeOf(job.settings).toEqualTypeOf<DoclingSettings>();
    if (job.output.images === 'extract') {
        expectTypeOf(job.output.imageOptions.prefix).toBeString();
        expectTypeOf(job.output.imageOptions.omitSmall).toBeBoolean();
    } else {
        // @ts-expect-error image options only with 'extract'
        job.output.imageOptions;
    }
} else {
    expectTypeOf(job).toEqualTypeOf<DocumentJob>();
    expectTypeOf(job.settings).toEqualTypeOf<DoclingSettings>();
    // @ts-expect-error document jobs have no md output
    job.output;
}
// @ts-expect-error check() takes the job object, not only its id
client.check('id');
// @ts-expect-error a md job needs its output
client.check({ kind: 'markdown', id: 'x' });
// @ts-expect-error check() takes no conversion options
client.check(job, { forceOcr: true });

// --- Options are typed: invalid values do not compile.

expectTypeOf<Pipeline>().toEqualTypeOf<'standard' | 'vlm'>();
expectTypeOf<PdfBackend>().toEqualTypeOf<'docling_parse' | 'pypdfium2'>();
expectTypeOf<MarkdownImageMode>().toEqualTypeOf<'none' | 'placeholder' | 'extract'>();
expectTypeOf<DocumentImageMode>().toEqualTypeOf<'embedded' | 'placeholder'>();
expectTypeOf<CallOptions>().toEqualTypeOf<{ signal?: AbortSignal }>();
/** Known engines and custom engine strings both satisfy OcrEngine. */
const knownEngine: OcrEngine = 'rapidocr';
const customEngine: OcrEngine = 'custom-ocr-v3';
expectTypeOf(knownEngine).toExtend<OcrEngine>();
expectTypeOf(customEngine).toExtend<OcrEngine>();

client.convertMarkdown(pdf, {
    headingHierarchy: false,
    formulaEnrichment: false,
    codeEnrichment: true,
    chartExtraction: true,
    pipeline: 'vlm',
    pdfBackend: 'pypdfium2',
    ocr: false,
    forceOcr: true,
    ocrEngine: 'easyocr',
    signal: AbortSignal.timeout(1000),
});
client.convertDocument(pdf, { ocrEngine: 'nemotron-ocr' });
// @ts-expect-error ocrEngine must be a string
client.convertMarkdown(pdf, { ocrEngine: 123 });
createDoclingClient({
    baseUrl: '',
    options: { ocr: false, ocrLang: ['de', 'en'], pageRange: [1, 3], documentTimeout: 60 },
});
createDoclingClient({ baseUrl: '', options: { ocrLang: [] } });
expectTypeOf<ClientOptions>().toMatchTypeOf<DoclingOptions>();
// @ts-expect-error ocrLang is factory-only
client.convertMarkdown(pdf, { ocrLang: ['de'] });
// @ts-expect-error pageRange is factory-only
client.convertDocument(pdf, { pageRange: [2, 2] });
// @ts-expect-error documentTimeout is factory-only
client.submitMarkdown(pdf, { documentTimeout: 60 });
client.convertMarkdown(pdf, { images: 'extract', imageOptions: { prefix: 'out/1234-', omitSmall: false } });
client.convertMarkdown(pdf, { images: 'none' });
client.convertDocument(pdf, { images: 'placeholder' });
client.submitDocument(pdf, { images: 'embedded' });
client.convertDocument(pdf, { pageImages: true });
// @ts-expect-error the image scale is fixed at 2 (144 dpi)
client.convertDocument(pdf, { pageImages: true, imageScale: 1 });
// @ts-expect-error page images exist only in the document output
client.convertMarkdown(pdf, { pageImages: true });
// @ts-expect-error page images are per call only
createDoclingClient({ baseUrl: '', options: { pageImages: true } });
// @ts-expect-error pageRange is a [from, to] tuple
createDoclingClient({ baseUrl: '', options: { pageRange: [1] } });
// @ts-expect-error ocrLang is a list of languages
createDoclingClient({ baseUrl: '', options: { ocrLang: 'de' } });
// @ts-expect-error unknown pipeline
client.convertMarkdown(pdf, { pipeline: 'fast' });
// @ts-expect-error unknown PDF backend
client.convertDocument(pdf, { pdfBackend: 'dlparse_v4' });
// @ts-expect-error 'embedded' is a document image mode
client.convertMarkdown(pdf, { images: 'embedded' });
// @ts-expect-error 'extract' is a md image mode
client.convertDocument(pdf, { images: 'extract' });
// @ts-expect-error documents take no image options
client.submitDocument(pdf, { imageOptions: { prefix: 'x' } });
// @ts-expect-error image options need a prefix
client.convertMarkdown(pdf, { images: 'extract', imageOptions: { omitSmall: true } });
// @ts-expect-error pixel minimums were replaced by omitSmall
client.convertMarkdown(pdf, { images: 'extract', imageOptions: { prefix: 'x', minHeight: 50 } });
// @ts-expect-error table mode is fixed
client.convertMarkdown(pdf, { tableMode: 'fast' });
// @ts-expect-error md repairs were removed
client.convertMarkdown(pdf, { repairs: false });
// @ts-expect-error page numbers were removed
client.submitMarkdown(pdf, { pageNumbers: true });
// @ts-expect-error the input is PDF or image bytes, not a path
client.convertMarkdown('file.pdf');

createDoclingClient({ baseUrl: '', apiKey: 'k', timeoutMs: 1000, fetch, options: { ocr: false } });
// @ts-expect-error image modes are per call only
createDoclingClient({ baseUrl: '', options: { images: 'none' } });
// @ts-expect-error image options are per call only
createDoclingClient({ baseUrl: '', options: { imageOptions: { prefix: 'x' } } });
// @ts-expect-error a signal is per call only
createDoclingClient({ baseUrl: '', options: { signal: AbortSignal.abort() } });
// @ts-expect-error baseUrl is required
createDoclingClient({});

// --- Image helpers.

expectTypeOf(isSmallImage).toEqualTypeOf<(size: ImageSize) => boolean>();
expectTypeOf(readPngSize).toEqualTypeOf<(bytes: Uint8Array) => ImageSize | undefined>();
expectTypeOf(PAGE_IMAGE_SCALE).toBeNumber();
declare const extracted: ExtractedImage;
isSmallImage(extracted);
// @ts-expect-error a size needs width and height
isSmallImage({ width: 1 });

expectTypeOf(toPageImageBox).toBeFunction();
declare const document: DoclingDocument;
declare const provenance: ProvenanceItem;
expectTypeOf(toPageImageBox(document, provenance)).toEqualTypeOf<PageImageBox | undefined>();
declare const pageBox: PageImageBox;
expectTypeOf(pageBox.page).toBeNumber();
expectTypeOf(pageBox.x).toBeNumber();
expectTypeOf(pageBox.y).toBeNumber();
expectTypeOf(pageBox.width).toBeNumber();
expectTypeOf(pageBox.height).toBeNumber();

// --- DoclingDocument: `label` narrows text items.

const text = document.texts[0]!;
expectTypeOf(text).toEqualTypeOf<AnyTextItem>();
expectTypeOf(text.text).toBeString();
expectTypeOf(text.self_ref).toBeString();
if (text.label === 'section_header') {
    expectTypeOf(text.level).toBeNumber();
}
if (text.label === 'list_item') {
    expectTypeOf(text.enumerated).toBeBoolean();
    expectTypeOf(text.marker).toBeString();
}
if (text.label === 'code') {
    expectTypeOf(text.code_language).toBeString();
    expectTypeOf(text.captions[0]!.$ref).toBeString();
}
if (text.label === 'paragraph') {
    // @ts-expect-error plain text items have no level
    text.level;
}
// @ts-expect-error `level` needs narrowing on `label` first
text.level;

const picture: PictureItem = document.pictures[0]!;
expectTypeOf(picture.label).toEqualTypeOf<'picture' | 'chart'>();
// `null` with images: 'placeholder'
expectTypeOf(picture.image).toEqualTypeOf<ImageRef | null>();
if (picture.image !== null) {
    expectTypeOf(picture.image.uri).toBeString();
    isSmallImage(picture.image.size);
}
expectTypeOf(document.body.children[0]!.$ref).toBeString();
expectTypeOf(document.pages['1']!.page_no).toBeNumber();
expectTypeOf(document.tables[0]!.data.grid).toBeArray();

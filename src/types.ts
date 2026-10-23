// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { ErrorCode } from './core/result.js';
import type { DoclingDocument } from './document.js';

// -------------------------------------------------------------------
// --- 1. Result & Error Types
// -------------------------------------------------------------------

/** Identifies failure cause across validation, network, HTTP, and conversion. */
export type { ErrorCode };

/** Discriminated union returned by all client calls; only invalid options throw, before any work starts. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ConvertError };

/** Fields shared by all errors. */
type ErrorBase = {
    /** Human-readable explanation of error cause. */
    message: string;
    /** HTTP status code when error originated from server response. */
    status?: number;
    /**
     * **Server versions captured at time of error**.
     *
     * - set when server answered request (`http`, `not_found`, `conversion_failed`, `invalid_response`)
     * - `null` when server omitted versions or did not answer
     */
    versions?: ServerVersions | null;
};

/**
 * **Failure details returned when `ok` is false**.
 *
 * - `code` identifies the failure cause
 * - `conversion_failed` adds `details` with what the server reported
 */
export type ConvertError = ErrorBase &
    (
        | /** Error other than document processing failure; carries no server details. */
        { code: Exclude<ErrorCode, 'conversion_failed'> }
        /** Document processing failed; `details` holds the server's error items and failure classification. */
        | { code: 'conversion_failed'; details: ConversionFailure }
    );

/**
 * **What the server reported about a failed conversion**.
 *
 * - `errors`: error items of a sync conversion or failed result; empty when none were sent
 * - `failure`: task failure classification (async jobs); `null` when not sent
 */
export type ConversionFailure = {
    errors: ServerError[];
    failure: TaskFailure | null;
};

/** docling's classification of a failed task; each field `null` when not sent. */
export type TaskFailure = {
    /** Failure category, e.g. 'backend_failure', 'capacity', 'timeout', 'inference_failure'. */
    category: string | null;
    /** Lifecycle phase of failure, e.g. 'admission', 'execution'. */
    phase: string | null;
    /** Server's hint whether retrying the same document may succeed. */
    retryable: boolean | null;
};

/** Fields docling sends with each error item; `null` when not sent. */
export type ServerDetails = {
    /** docling component, e.g. `document_backend`, `model`. */
    component: string | null;
    /** docling module or class name, e.g. `DoclingParseV4PageBackend`. */
    module: string | null;
    /** docling failure category (newer docling only), e.g. `backend_failure`. */
    category: string | null;
    /** 1-based PDF page the error belongs to; `null` for document-wide errors. */
    page: number | null;
};

/** Error item reported by the server: docling's message and where it occurred. */
export type ServerError = {
    message: string;
    details: ServerDetails;
};

/**
 * **Package versions as reported by the conversion server**.
 *
 * - docling: every key of `GET /version`, e.g. `docling-serve`, `docling`, `docling-parse`, `docling-ibm-models`
 * - non-string values are dropped
 */
export type ServerVersions = Record<string, string>;

// -------------------------------------------------------------------
// --- 2. Options
// -------------------------------------------------------------------

/**
 * **Bytes of the file to convert; the format is detected by magic bytes**.
 *
 * - PDF (`%PDF-` within the first 1024 bytes)
 * - PNG, JPEG, TIFF and WebP: sent as docling's `image` format, read by layout model and OCR
 * - anything else is `invalid_input`
 */
export type ConvertInput = Uint8Array;

/**
 * Use `ConvertInput`; images are accepted as well.
 * @deprecated
 */
export type PdfInput = ConvertInput;

/** Supported conversion pipeline backend. */
export type Pipeline = 'standard' | 'vlm';

/** PDF text extraction backend used by docling. */
export type PdfBackend = 'docling_parse' | 'pypdfium2';

/**
 * **OCR engine preset sent as `ocr_preset`**.
 *
 * - known engines autocomplete; any other non-empty preset id is accepted and sent as is
 * - installed engines: `stages.ocr.presets` of `client.capabilities()`
 */
export type OcrEngine = 'auto' | 'rapidocr' | 'easyocr' | 'tesseract' | 'tesserocr' | 'ocrmac' | (string & {});

/** docling conversion options; set as factory defaults and/or per call. */
export type DoclingOptions = {
    /** Nests headings by bookmarks, numbering, and font style; without it every heading has level 1. Default `true`. */
    headingHierarchy?: boolean;
    /** Extracts formulas as LaTeX via dedicated model; runs only on formula blocks, so no cost without formulas. Default `true`. */
    formulaEnrichment?: boolean;
    /** Extracts code listings via dedicated model. Slower. Default `false`. */
    codeEnrichment?: boolean;
    /** Extracts charts and plots as data tables via vision model. Slower. Default `false`. */
    chartExtraction?: boolean;
    /** Processing pipeline backend: `'standard'` or `'vlm'`. Default `'standard'`. */
    pipeline?: Pipeline;
    /**
     * **Text extractor docling reads the PDF with**: 'docling_parse' or 'pypdfium2'. Default 'docling_parse'.
     *
     * - 'pypdfium2' reads ligatures and word spaces better, but misses page headers and footers
     */
    pdfBackend?: PdfBackend;
    /** Runs OCR on scanned PDF pages and raster graphics. Default `true`; image input always runs OCR. */
    ocr?: boolean;
    /**
     * **OCRs whole PDF pages and drops their text layer**: for PDFs with broken text. Default `false`.
     *
     * - ignored for image input: it has no text layer, and full-page OCR there merges words (`stepsand`)
     */
    forceOcr?: boolean;
    /** OCR engine preset (`ocr_preset`); an engine the server lacks fails the conversion. Default `'auto'`. */
    ocrEngine?: OcrEngine;
};

/** docling options of the factory: every per-call option plus the factory-only ones, applied to every call. */
export type ClientOptions = DoclingOptions & {
    /** BCP-47 language priority list for OCR (e.g. `['de', 'en']`); empty means engine default. Factory only. */
    ocrLang?: string[];
    /** 1-based inclusive `[from, to]` page range. Default: all pages. Factory only. */
    pageRange?: [from: number, to: number];
    /** Server processing timeout per document in seconds. Default: server default. Factory only. */
    documentTimeout?: number;
};

/** Options accepted by every call. */
export type CallOptions = {
    /** Abort signal to cancel the HTTP request. */
    signal?: AbortSignal;
};

/**
 * **Images in the md**.
 *
 * - `'placeholder'`: `<!-- image -->` where docling found a picture (default)
 * - `'none'`: placeholders removed
 * - `'extract'`: images returned as bytes in `images`, linked in the md as `<prefix><n>.<ext>`; pictures docling
 *   sent without data stay as `<!-- image -->`
 */
export type MarkdownImageMode = 'none' | 'placeholder' | 'extract';

/** Link prefix and filter for `images: 'extract'`. */
export type ImageOptions = {
    /** md link target before `<n>.<ext>`, e.g. `'images/doc1_'`; no whitespace, `(`, `)`, `<` or `>`. */
    prefix: string;
    /** Drops icons, bullets, logos and thin rules by pixel size (`isSmallImage`); PNG only. Default `true`. */
    omitSmall?: boolean;
};

/** Options of `convertMarkdown` and `submitMarkdown`. */
export type MarkdownOptions = DoclingOptions &
    CallOptions & {
        /** Default `'placeholder'`. */
        images?: MarkdownImageMode;
        /** Required with `images: 'extract'`, not allowed otherwise. */
        imageOptions?: ImageOptions;
    };

/**
 * **Picture data in the DoclingDocument**.
 *
 * - `'embedded'`: `pictures[].image.uri` holds a base64 data URI (default)
 * - `'placeholder'`: `pictures[].image` is `null`; picture items with position and captions stay
 */
export type DocumentImageMode = 'embedded' | 'placeholder';

/** Options of `convertDocument` and `submitDocument`. */
export type DocumentOptions = DoclingOptions &
    CallOptions & {
        /** Default `'embedded'`. */
        images?: DocumentImageMode;
        /** Renders every page as an image, returned in `pageImages` (`include_page_images`). Default `false`. */
        pageImages?: boolean;
    };

// -------------------------------------------------------------------
// --- 3. Outputs
// -------------------------------------------------------------------

/** Pixel dimensions of an image. */
export type ImageSize = {
    width: number;
    height: number;
};

/** In-memory image file extracted from the md's embedded data URIs. */
export type ExtractedImage = {
    /** Link target in the md: `<prefix><n>.<ext>`. */
    path: string;
    /** MIME type from the data URI, e.g. `'image/png'`. */
    mimeType: string;
    bytes: Uint8Array;
    /** Width in pixels; `0` for non-PNG formats. */
    width: number;
    /** Height in pixels; `0` for non-PNG formats. */
    height: number;
};

/**
 * **Rendered page image, moved out of `pages[].image` of the DoclingDocument**.
 *
 * - `width`/`height` from the PNG header, else docling's `image.size`; `0` when neither is known
 * - rendered at 144 dpi: pixel size = page size in points × 2; `toPageImageBox` maps bboxes onto it
 */
export type PageImage = {
    /** 1-based PDF page; `1` for image input. */
    page: number;
    /** MIME type from the data URI, e.g. `'image/png'`. */
    mimeType: string;
    width: number;
    height: number;
    /** Render resolution reported by docling; `0` when not sent. */
    dpi: number;
    bytes: Uint8Array;
};

/** Rectangle on a page image in pixels; origin at the top-left corner, unrounded. */
export type PageImageBox = {
    /** 1-based PDF page; matches `PageImage.page`. */
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
};

/** Non-fatal conversion error reported by docling; `message` is docling's text. */
export type ServerWarning = { code: 'server'; message: string; details: ServerDetails };

/** Embedded image with invalid or empty base64; removed from the md. */
export type ImageWarning = {
    code: 'image_not_decoded';
    message: string;
    details: {
        /** 1-based position among all embedded images, in document order. */
        index: number;
    };
};

/** Page image that is not a base64 data URI or has invalid or empty data; missing from `pageImages`, left in `pages[].image`. */
export type PageImageWarning = {
    code: 'page_image_not_decoded';
    message: string;
    details: {
        /** 1-based PDF page. */
        page: number;
    };
};

/** Warning of a md conversion. */
export type MarkdownWarning = ServerWarning | ImageWarning;

/** Warning of a document conversion. */
export type DocumentWarning = ServerWarning | PageImageWarning;

/** md conversion result: docling's md unchanged except for image handling. */
export type ConvertedMarkdown = {
    markdown: string;
    /** Extracted images in document order; empty unless `images: 'extract'`. */
    images: ExtractedImage[];
    warnings: MarkdownWarning[];
    /** Server versions that produced the output; `null` if the server omitted them. */
    versions: ServerVersions | null;
};

/**
 * **Document conversion result: docling's DoclingDocument as sent, without decoded page image data**.
 *
 * - decoded page images are moved to `pageImages` and their `document.pages[].image` becomes `null`
 * - an undecodable page image stays in `document.pages[].image`, with a `page_image_not_decoded` warning
 */
export type ConvertedDocument = {
    document: DoclingDocument;
    /** Page images in page order; empty unless `pageImages: true`. */
    pageImages: PageImage[];
    warnings: DocumentWarning[];
    /** Server versions that produced the output; `null` if the server omitted them. */
    versions: ServerVersions | null;
};

/**
 * **Conversion settings exactly as sent in the multipart request**.
 *
 * - every key is the camelCase name of a docling-serve form field (`ocrPreset` = `ocr_preset`)
 * - `null`: field not sent (md-only fields of json output, unused presets, unset factory options)
 * - `ocrLang`: empty means not sent, i.e. engine default
 * - server-side configuration not covered by request fields (e.g. layout model) is not included
 */
export type DoclingSettings = {
    fromFormats: 'pdf' | 'image';
    toFormats: 'md' | 'json';
    imageExportMode: 'embedded' | 'placeholder';
    includeImages: boolean;
    includePageImages: boolean;
    imagesScale: number;
    mdCompactTables: boolean | null;
    mdPageBreakPlaceholder: string | null;
    doOcr: boolean;
    forceOcr: boolean;
    ocrPreset: string;
    ocrLang: string[];
    pdfBackend: PdfBackend;
    pipeline: Pipeline;
    vlmPipelinePreset: string | null;
    doTableStructure: boolean;
    tableMode: 'accurate';
    tableStructurePreset: string;
    tableCellMatching: boolean;
    doPdfHeadingHierarchy: boolean;
    doFormulaEnrichment: boolean;
    doCodeEnrichment: boolean;
    codeFormulaPreset: string | null;
    doChartExtraction: boolean;
    chartExtractionPreset: string | null;
    doPictureClassification: boolean;
    doPictureDescription: boolean;
    pageRange: [from: number, to: number] | null;
    documentTimeout: number | null;
    abortOnError: boolean;
};

/** Sync conversion result plus the settings sent with its request. */
export type WithSettings<T> = T & {
    settings: DoclingSettings;
};

// -------------------------------------------------------------------
// --- 4. Asynchronous Jobs
// -------------------------------------------------------------------

/** Image handling of a md job, applied when `check()` picks up the result. */
export type MarkdownJobOutput =
    | { images: 'extract'; imageOptions: Required<ImageOptions> }
    | { images: 'none' | 'placeholder' };

/** Handle of a md conversion, returned by `submitMarkdown()`; plain JSON, safe to store. */
export type MarkdownJob = {
    kind: 'markdown';
    /** Server-side task id. */
    id: string;
    output: MarkdownJobOutput;
    /** Settings sent with the submission; `check()` neither needs nor returns them. */
    settings: DoclingSettings;
};

/** Handle of a document conversion, returned by `submitDocument()`; plain JSON, safe to store. */
export type DocumentJob = {
    kind: 'document';
    /** Server-side task id. */
    id: string;
    /** Settings sent with the submission; `check()` neither needs nor returns them. */
    settings: DoclingSettings;
};

/** Any job handle returned by `submit*()`. */
export type Job = MarkdownJob | DocumentJob;

/** Job handle accepted by `check()`; `settings` may be dropped when storing the job. */
export type JobRef = Omit<MarkdownJob, 'settings'> | Omit<DocumentJob, 'settings'>;

/** State of an async job; `done` carries the conversion result. */
export type JobState<T> =
    /** Pending in server queue; `position` is 1-based when reported by server. */
    | { status: 'queued'; position: number | null }
    /** Being processed by the server. */
    | { status: 'running' }
    /** Completed; carries the conversion result. */
    | ({ status: 'done' } & T);

// -------------------------------------------------------------------
// --- 5. Server Capabilities
// -------------------------------------------------------------------

/** Model or engine preset a pipeline stage offers; `id` is the value of the stage's form field. */
export type CapabilityPreset = {
    id: string;
    name: string;
    description: string | null;
    /** Origin, e.g. `'docling'` or `'default'` (server default alias). */
    source: string;
};

/** Pipeline stage (OCR, table structure, VLM, ...) with its form field and installed presets. */
export type CapabilityStage = {
    /** Form field selecting the preset, e.g. `'ocr_preset'`. */
    option: string;
    customConfigOption: string | null;
    /** Preset used when the field is not sent. */
    default: string;
    presets: CapabilityPreset[];
};

/** Server limits; `null` means unlimited or not reported. */
export type CapabilityLimits = {
    maxDocumentTimeout: number | null;
    maxImagesScale: number | null;
    maxSourcesPerRequest: number | null;
    maxNumPages: number | null;
    maxFileSize: number | null;
};

/**
 * **What the docling-serve instance offers (`GET /v1/capabilities`)**.
 *
 * - snake_case keys of the server payload converted to camelCase; `stages` keys stay as sent (e.g. `table_structure`)
 * - missing or mistyped fields become empty lists, `''`, `null` or `false`
 * - diagnostics only: conversions never query it
 */
export type ServerCapabilities = {
    versions: ServerVersions;
    stages: Record<string, CapabilityStage>;
    sources: string[];
    targets: {
        allowed: string[];
        default: string;
    };
    outputFormats: string[];
    imageExportModes: string[];
    limits: CapabilityLimits;
    features: {
        apiKeyRequired: boolean;
        artifactStorage: boolean;
        websocket: boolean;
    };
};

// -------------------------------------------------------------------
// --- 6. Client
// -------------------------------------------------------------------

/** Configuration passed to `createDoclingClient`. */
export type DoclingConfig = {
    /** docling-serve base URL, e.g. `'http://127.0.0.1:5001'`; trailing `/` are removed. */
    baseUrl: string;
    /** Sent as `X-Api-Key` header. */
    apiKey?: string;
    /** Limit per request in ms (not `/version`); on expiry the call resolves with `aborted`. */
    timeoutMs?: number;
    /** Custom fetch implementation for mocking or custom dispatchers. */
    fetch?: typeof fetch;
    /** Defaults for every call; call options override them key by key, except the factory-only ones. */
    options?: ClientOptions;
};

/**
 * **docling-serve client**.
 *
 * - `convert*`: one synchronous request
 * - `submit*` + `check`: async job; the caller stores the job and polls
 */
export type DoclingClient = {
    /** PDF or image to docling's md; images as placeholders, removed or extracted. */
    convertMarkdown(input: ConvertInput, options?: MarkdownOptions): Promise<Result<WithSettings<ConvertedMarkdown>>>;
    /** PDF or image to docling's DoclingDocument. */
    convertDocument(input: ConvertInput, options?: DocumentOptions): Promise<Result<WithSettings<ConvertedDocument>>>;
    /** Starts an async md conversion; the job carries the sent settings. */
    submitMarkdown(input: ConvertInput, options?: MarkdownOptions): Promise<Result<MarkdownJob>>;
    /** Starts an async document conversion; the job carries the sent settings. */
    submitDocument(input: ConvertInput, options?: DocumentOptions): Promise<Result<DocumentJob>>;
    /**
     * **Polls a job; fetches its result once done**.
     *
     * - docling-serve deletes a result `DOCLING_SERVE_RESULT_REMOVAL_DELAY` seconds (default 300) after its first
     *   fetch: a `check` whose result download failed can be repeated within that time, later it returns
     *   `not_found`; persist `done` data, or start docling-serve with `DOCLING_SERVE_SINGLE_USE_RESULTS=false`
     * - `done` carries no settings: they are on the job
     */
    check(job: Omit<MarkdownJob, 'settings'>, options?: CallOptions): Promise<Result<JobState<ConvertedMarkdown>>>;
    check(job: Omit<DocumentJob, 'settings'>, options?: CallOptions): Promise<Result<JobState<ConvertedDocument>>>;
    check(job: JobRef, options?: CallOptions): Promise<Result<JobState<ConvertedMarkdown | ConvertedDocument>>>;
    /** Installed presets, limits and features of the server; on demand only, never used by conversions. */
    capabilities(options?: CallOptions): Promise<Result<ServerCapabilities>>;
};

// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

export type * from './document.js';
export type {
    CallOptions,
    CapabilityLimits,
    CapabilityPreset,
    CapabilityStage,
    ClientOptions,
    ConversionFailure,
    ConvertError,
    ConvertedDocument,
    ConvertedMarkdown,
    ConvertInput,
    DoclingClient,
    DoclingConfig,
    DoclingOptions,
    DoclingSettings,
    DocumentImageMode,
    DocumentJob,
    DocumentOptions,
    DocumentWarning,
    ErrorCode,
    ExtractedImage,
    ImageOptions,
    ImageSize,
    ImageWarning,
    Job,
    JobRef,
    JobState,
    MarkdownImageMode,
    MarkdownJob,
    MarkdownJobOutput,
    MarkdownOptions,
    MarkdownWarning,
    OcrEngine,
    PageImage,
    PageImageBox,
    PageImageWarning,
    PdfBackend,
    PdfInput,
    Pipeline,
    Result,
    ServerCapabilities,
    ServerDetails,
    ServerError,
    ServerVersions,
    ServerWarning,
    TaskFailure,
    WithSettings,
} from './types.js';

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

export { PAGE_IMAGE_SCALE } from './images.js';

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

export { createDoclingClient } from './client.js';
export { isSmallImage, readPngSize, toPageImageBox } from './images.js';

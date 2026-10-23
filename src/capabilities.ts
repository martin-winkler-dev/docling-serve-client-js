// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { ERR, fail, ok } from './core/result.js';
import { isPlainObject } from './core/validate.js';
import type { CapabilityLimits, CapabilityPreset, CapabilityStage, Result, ServerCapabilities } from './types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Loosely read JSON object; every field is checked before use. */
type JsonObject = Record<string, unknown>;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Maps the `GET /v1/capabilities` payload to camelCase `ServerCapabilities`**.
 *
 * - lenient per field: missing or mistyped values become `[]`, `''`, `null` or `false`, so new server fields or
 *   removed ones never fail the call
 * - non-object body: `invalid_response`
 */
export function readCapabilities(body: unknown): Result<ServerCapabilities> {
    if (!isPlainObject(body)) {
        return fail(ERR.INVALID_RESPONSE('Capabilities response is not a JSON object'));
    }
    const targets = objectOf(body.targets);
    const features = objectOf(body.features);
    return ok({
        versions: Object.fromEntries(
            Object.entries(objectOf(body.versions)).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
        ),
        stages: Object.fromEntries(
            Object.entries(objectOf(body.stages)).map(([name, stage]) => [name, readStage(objectOf(stage))]),
        ),
        sources: stringsOf(body.sources),
        targets: { allowed: stringsOf(targets.allowed), default: stringOf(targets.default) },
        outputFormats: stringsOf(body.output_formats),
        imageExportModes: stringsOf(body.image_export_modes),
        limits: readLimits(objectOf(body.limits)),
        features: {
            apiKeyRequired: features.api_key_required === true,
            artifactStorage: features.artifact_storage === true,
            websocket: features.websocket === true,
        },
    });
}

// -------------------------------------------------------------------
// --- 3. Internal Functions
// -------------------------------------------------------------------

/** Pipeline stage; presets without a string `id` are dropped. */
function readStage(stage: JsonObject): CapabilityStage {
    const presets: CapabilityPreset[] = [];
    for (const item of Array.isArray(stage.presets) ? stage.presets : []) {
        const preset = objectOf(item);
        if (typeof preset.id === 'string') {
            presets.push({
                id: preset.id,
                name: stringOf(preset.name),
                description: typeof preset.description === 'string' ? preset.description : null,
                source: stringOf(preset.source),
            });
        }
    }
    return {
        option: stringOf(stage.option),
        customConfigOption: typeof stage.custom_config_option === 'string' ? stage.custom_config_option : null,
        default: stringOf(stage.default),
        presets,
    };
}

/** Server limits; non-numbers become `null`. */
function readLimits(limits: JsonObject): CapabilityLimits {
    return {
        maxDocumentTimeout: numberOf(limits.max_document_timeout),
        maxImagesScale: numberOf(limits.max_images_scale),
        maxSourcesPerRequest: numberOf(limits.max_sources_per_request),
        maxNumPages: numberOf(limits.max_num_pages),
        maxFileSize: numberOf(limits.max_file_size),
    };
}

/** Plain object, or `{}` for anything else. */
function objectOf(value: unknown): JsonObject {
    return isPlainObject(value) ? value : {};
}

/** String entries of an array; `[]` for a non-array. */
function stringsOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** String, or `''` for anything else. */
function stringOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Finite number, or `null` for anything else. */
function numberOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

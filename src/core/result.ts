// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { ConversionFailure, ConvertError, Result } from '../types.js';

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Error code union inferred from `ERR`. */
export type ErrorCode = ReturnType<(typeof ERR)[keyof typeof ERR]>['code'];

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Error factories keyed by domain error code. */
export const ERR = {
    /** Input rejected before request: not a valid PDF `Uint8Array`, or invalid job object. */
    INVALID_INPUT: (message: string) => ({ code: 'invalid_input' as const, message }),
    /** Server unreachable (connection refused, DNS, socket reset). */
    NETWORK: (message: string) => ({ code: 'network' as const, message }),
    /** Caller `AbortSignal` or `timeoutMs` fired (including `AbortSignal.timeout()`). */
    ABORTED: (message: string) => ({ code: 'aborted' as const, message }),
    /** Non-2xx response (bad options, auth, 5xx, sync wait exceeded). */
    HTTP: (status: number, detail: string) => ({ code: 'http' as const, message: `HTTP ${status}: ${detail}`, status }),
    /** Job ID unknown to server: expired, restarted, or nonexistent. */
    NOT_FOUND: (message: string) => ({ code: 'not_found' as const, message, status: 404 }),
    /** Document processing failed (corrupt PDF, model failure); `details` holds what the server reported. */
    CONVERSION_FAILED: (reason: string, details: ConversionFailure) => ({
        code: 'conversion_failed' as const,
        message: `Conversion failed (${reason})`,
        details,
    }),
    /** Server answered 2xx with unexpected response body. */
    INVALID_RESPONSE: (message: string, status?: number) =>
        status === undefined
            ? { code: 'invalid_response' as const, message }
            : { code: 'invalid_response' as const, message, status },
};

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/** Wraps value in `{ ok: true, data }`. */
export function ok<T>(data: T): Result<T> {
    return { ok: true, data };
}

/** Wraps error in `{ ok: false, error }`. */
export function fail<T = never>(error: ConvertError): Result<T> {
    return { ok: false, error };
}

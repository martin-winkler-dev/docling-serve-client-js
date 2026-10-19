// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import type { Result } from '../types.js';
import { ERR, fail, ok } from './result.js';

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** Error code Bun and Node set when a body exceeds the maximum string length. */
const STRING_TOO_LONG = 'ERR_STRING_TOO_LONG';

/** Matches the out-of-memory message of JavaScriptCore (`Out of memory`) and V8 (`... out of memory`). */
const MATCH_OUT_OF_MEMORY = /out of memory/i;

/** Matches whitespace runs collapsed in body snippets. */
const MATCH_WHITESPACE = /\s+/g;

/** Characters of a non-JSON body quoted in the error message. */
const BODY_SNIPPET_LENGTH = 200;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/**
 * **Executes `fetch` and parses the JSON body into a `Result`**.
 *
 * - non-2xx: `http` with FastAPI `detail`; unparsable 2xx body: `invalid_response`
 * - body too large for a string or for memory: `invalid_response`, as a retry fails the same way
 * - aborted signal: `aborted`; anything else thrown: `network`
 */
export async function fetchJson(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Result<unknown>> {
    try {
        const res = await fetchFn(url, init);
        const text = await res.text();
        if (!res.ok) {
            return fail(ERR.HTTP(res.status, errorDetail(text)));
        }
        try {
            return ok(JSON.parse(text));
        } catch {
            return fail(ERR.INVALID_RESPONSE(`Response body is not valid JSON: ${bodySnippet(text)}`, res.status));
        }
    } catch (e) {
        const message = errorMessage(e);
        if (isTooLarge(e)) {
            return fail(ERR.INVALID_RESPONSE(`Response body too large: ${message}`));
        }
        return fail(init.signal?.aborted ? ERR.ABORTED(message) : ERR.NETWORK(message));
    }
}

/** Extracts message, appending `cause.message` if present. */
export function errorMessage(e: unknown): string {
    if (!(e instanceof Error)) {
        return String(e);
    }
    return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message;
}

// -------------------------------------------------------------------
// --- 3. Internal Functions
// -------------------------------------------------------------------

/** Checks whether an error indicates body size exceeded memory or maximum string length. */
function isTooLarge(e: unknown): boolean {
    if (e instanceof RangeError) {
        return true;
    }
    if (!(e instanceof Error)) {
        return false;
    }
    return (e as Error & { code?: unknown }).code === STRING_TOO_LONG || MATCH_OUT_OF_MEMORY.test(e.message);
}

/** First 200 characters of a body with whitespace collapsed; `(empty body)` for a blank one. */
function bodySnippet(text: string): string {
    const collapsed = text.replace(MATCH_WHITESPACE, ' ').trim();
    return collapsed === '' ? '(empty body)' : collapsed.slice(0, BODY_SNIPPET_LENGTH);
}

/** Extracts FastAPI 'detail' from response body, falling back to raw text (up to 500 characters) or 'no response body'. */
function errorDetail(text: string): string {
    try {
        const body: unknown = JSON.parse(text);
        if (body && typeof body === 'object' && 'detail' in body) {
            const { detail } = body;
            return typeof detail === 'string' ? detail : JSON.stringify(detail);
        }
    } catch {
        // Not JSON: fall back to raw text
    }
    return text.slice(0, 500) || 'no response body';
}

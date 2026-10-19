// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Constants
// -------------------------------------------------------------------

/** Bytes at the end of a PDF searched for `startxref`; the trailer sits within the last few hundred bytes. */
const TAIL_LENGTH = 2048;

/** Matches `startxref` with its byte offset (group 1); incremental updates repeat it, the last one counts. */
const MATCH_STARTXREF = /startxref\s+(\d+)/g;

/** Bytes searched for `%PDF-`: a header may start at offsets 0 to 1023, so its 5 bytes end by 1028. */
const HEADER_SEARCH_LENGTH = 1028;

// -------------------------------------------------------------------
// --- 2. Exported Functions
// -------------------------------------------------------------------

/** Matches a `%PDF-` header starting within the first 1024 bytes. */
export function isPdf(bytes: unknown): bytes is Uint8Array {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return false;
    }
    const head = bytes.subarray(0, HEADER_SEARCH_LENGTH);
    for (let i = 0; i + 5 <= head.length; i++) {
        // %PDF-
        if (
            head[i] === 0x25 &&
            head[i + 1] === 0x50 &&
            head[i + 2] === 0x44 &&
            head[i + 3] === 0x46 &&
            head[i + 4] === 0x2d
        ) {
            return true;
        }
    }
    return false;
}

/**
 * **Returns cross-reference offset if PDF is truncated**: last 'startxref' points at or past EOF.
 *
 * - typical for aborted downloads; docling then fails with a vague load error
 * - only the last 2 KB are read, as latin1
 * - returns 'undefined' when offset lies inside file or no 'startxref' found
 */
export function findTruncatedXref(bytes: Uint8Array): number | undefined {
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - TAIL_LENGTH)));
    const last = [...tail.matchAll(MATCH_STARTXREF)].at(-1);
    const offset = last === undefined ? undefined : Number(last[1]);
    return offset !== undefined && offset >= bytes.length ? offset : undefined;
}

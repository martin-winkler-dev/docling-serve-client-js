// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { findTruncatedXref, isPdf } from '../../src/core/pdf.js';

/** Generates minimal PDF bytes prefixed with `prefix`. */
function pdfBytes(prefix = '') {
    return new TextEncoder().encode(`${prefix}%PDF-1.7\n...`);
}

describe('isPdf', () => {
    test('detects PDF magic header at buffer start or within first 1024 bytes', () => {
        expect(isPdf(pdfBytes())).toBe(true);
        expect(isPdf(pdfBytes('junk'))).toBe(true);
        expect(isPdf(Buffer.from(pdfBytes()))).toBe(true);
    });

    test('detects header at byte offset 1023 and rejects header starting at byte 1024', () => {
        expect(isPdf(pdfBytes('x'.repeat(1023)))).toBe(true);
        expect(isPdf(pdfBytes('x'.repeat(1023)).subarray(0, 1028))).toBe(true);
        expect(isPdf(pdfBytes('x'.repeat(1023)).subarray(0, 1027))).toBe(false);
    });

    test('returns false for empty buffers, non-PDF payloads, and non-Uint8Array inputs', () => {
        expect(isPdf(new Uint8Array())).toBe(false);
        expect(isPdf(new TextEncoder().encode('hello'))).toBe(false);
        expect(isPdf(pdfBytes('x'.repeat(1024)))).toBe(false);
        expect(isPdf(pdfBytes().buffer)).toBe(false);
        expect(isPdf('%PDF-')).toBe(false);
        expect(isPdf(null)).toBe(false);
    });
});

/** A PDF of `size` bytes in total whose tail is `tail` (padding before it). */
function pdfWithTail(tail: string, size = 4096): Uint8Array {
    const head = '%PDF-1.7\n';
    return new TextEncoder().encode(head + ' '.repeat(Math.max(0, size - head.length - tail.length)) + tail);
}

describe('findTruncatedXref', () => {
    test('identifies truncated files when startxref offset matches or exceeds file size', () => {
        expect(findTruncatedXref(pdfWithTail('startxref\n5000\n%%EOF\n'))).toBe(5000);
        expect(findTruncatedXref(pdfWithTail('startxref\n4096\n%%EOF\n'))).toBe(4096);
        expect(findTruncatedXref(pdfWithTail('startxref\n4095\n%%EOF\n'))).toBeUndefined();
        expect(findTruncatedXref(pdfWithTail('startxref\n120\n%%EOF\n'))).toBeUndefined();
    });

    test('evaluates only the final startxref entry in documents with incremental updates', () => {
        expect(
            findTruncatedXref(pdfWithTail('startxref\n9999\n%%EOF\nxref\nstartxref\n3000\n%%EOF\n')),
        ).toBeUndefined();
        expect(findTruncatedXref(pdfWithTail('startxref\n100\n%%EOF\nstartxref\n9999\n%%EOF\n'))).toBe(9999);
    });

    test('handles CRLF, CR, whitespace, and trailing garbage after %%EOF', () => {
        expect(findTruncatedXref(pdfWithTail('startxref\r\n7000\r\n%%EOF\r\n'))).toBe(7000);
        expect(findTruncatedXref(pdfWithTail('startxref\r7000\r%%EOF'))).toBe(7000);
        expect(findTruncatedXref(pdfWithTail('startxref  \n  7000 \n%%EOF\n\0\0 garbage'))).toBe(7000);
        expect(findTruncatedXref(pdfWithTail('startxref\r\n100\r\n%%EOF\r\n'))).toBeUndefined();
    });

    test('returns undefined when startxref token is absent or non-numeric', () => {
        expect(findTruncatedXref(pdfWithTail('%%EOF\n'))).toBeUndefined();
        expect(findTruncatedXref(pdfWithTail('startxref\n%%EOF\n'))).toBeUndefined();
        expect(findTruncatedXref(new TextEncoder().encode('%PDF-1.7\n...'))).toBeUndefined();
        expect(findTruncatedXref(new Uint8Array())).toBeUndefined();
    });

    test('inspects only the trailing 2 KB window and ignores earlier startxref tokens', () => {
        expect(findTruncatedXref(pdfWithTail(`startxref\n999999\n${' '.repeat(3000)}`, 8192))).toBeUndefined();
    });

    test('decodes trailing non-ASCII bytes using latin1 encoding without failure', () => {
        const tail = new TextEncoder().encode('startxref\n500\n');
        expect(findTruncatedXref(new Uint8Array([...pdfWithTail('', 100), 0xff, 0xfe, ...tail]))).toBe(500);
    });
});

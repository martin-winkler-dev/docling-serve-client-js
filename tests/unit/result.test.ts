// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { ERR, fail, ok } from '../../src/core/result.js';

describe('ok / fail', () => {
    test('build discriminated results', () => {
        expect(ok(1)).toEqual({ ok: true, data: 1 });
        expect(fail(ERR.NETWORK('x'))).toEqual({ ok: false, error: { code: 'network', message: 'x' } });
    });
});

describe('ERR', () => {
    test('every builder returns its key as lower-case code', () => {
        for (const [key, builder] of Object.entries(ERR)) {
            const build = builder as (...args: unknown[]) => { code: string };
            expect(build(500, 'x').code).toBe(key.toLowerCase());
        }
    });

    test('passes the message through', () => {
        expect(ERR.INVALID_INPUT('a')).toEqual({ code: 'invalid_input', message: 'a' });
        expect(ERR.NETWORK('c')).toEqual({ code: 'network', message: 'c' });
        expect(ERR.ABORTED('d')).toEqual({ code: 'aborted', message: 'd' });
    });

    test('owns fixed message formats and statuses', () => {
        expect(ERR.HTTP(500, 'boom')).toEqual({ code: 'http', message: 'HTTP 500: boom', status: 500 });
        expect(ERR.NOT_FOUND('gone')).toEqual({ code: 'not_found', message: 'gone', status: 404 });
        expect(ERR.CONVERSION_FAILED('bad pdf', { errors: [], failure: null })).toEqual({
            code: 'conversion_failed',
            message: 'Conversion failed (bad pdf)',
            details: { errors: [], failure: null },
        });
    });

    test('INVALID_RESPONSE sets status only when given', () => {
        expect(ERR.INVALID_RESPONSE('x')).toEqual({ code: 'invalid_response', message: 'x' });
        expect('status' in ERR.INVALID_RESPONSE('x')).toBe(false);
        expect(ERR.INVALID_RESPONSE('x', 200)).toEqual({ code: 'invalid_response', message: 'x', status: 200 });
    });

    test('returns a fresh object on every call', () => {
        expect(ERR.INVALID_INPUT('a')).not.toBe(ERR.INVALID_INPUT('a'));
    });
});

// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { fetchJson } from '../../src/core/http.js';

/** Creates a mock fetch answering with the response from `fn`. */
function fetchOf(fn: () => Response | Promise<Response>) {
    async function answer() {
        return fn();
    }
    return answer as unknown as typeof fetch;
}

describe('fetchJson', () => {
    test('parses JSON on 2xx', async () => {
        expect(
            await fetchJson(
                fetchOf(() => Response.json({ a: 1 })),
                'u',
                {},
            ),
        ).toEqual({ ok: true, data: { a: 1 } });
    });

    test('maps non-2xx with FastAPI string detail', async () => {
        const res = await fetchJson(
            fetchOf(() => Response.json({ detail: 'nope' }, { status: 404 })),
            'u',
            {},
        );
        expect(res).toEqual({ ok: false, error: { code: 'http', message: 'HTTP 404: nope', status: 404 } });
    });

    test('maps non-2xx with validation detail list and plain text bodies', async () => {
        const list = await fetchJson(
            fetchOf(() => Response.json({ detail: [{ msg: 'bad' }] }, { status: 422 })),
            'u',
            {},
        );
        expect(!list.ok && list.error.message).toBe('HTTP 422: [{"msg":"bad"}]');
        const text = await fetchJson(
            fetchOf(() => new Response('boom', { status: 500 })),
            'u',
            {},
        );
        expect(!text.ok && text.error.message).toBe('HTTP 500: boom');
        const empty = await fetchJson(
            fetchOf(() => new Response('', { status: 502 })),
            'u',
            {},
        );
        expect(!empty.ok && empty.error.message).toBe('HTTP 502: no response body');
    });

    test('maps invalid JSON on 2xx', async () => {
        const res = await fetchJson(
            fetchOf(() => new Response('<html>')),
            'u',
            {},
        );
        expect(res).toEqual({
            ok: false,
            error: { code: 'invalid_response', message: 'Response body is not valid JSON: <html>', status: 200 },
        });
    });

    test('quotes the first 200 characters of a non-JSON 2xx body, whitespace collapsed', async () => {
        /** Error message for a 200 answer with `body`. */
        async function messageOf(body: string) {
            const res = await fetchJson(
                fetchOf(() => new Response(body)),
                'u',
                {},
            );
            return res.ok ? undefined : res.error.message;
        }
        expect(await messageOf('<html>\n  <body>Login</body>\n</html>')).toBe(
            'Response body is not valid JSON: <html> <body>Login</body> </html>',
        );
        expect(await messageOf(' \n ')).toBe('Response body is not valid JSON: (empty body)');
        expect(await messageOf('')).toBe('Response body is not valid JSON: (empty body)');
        expect(await messageOf(`x${'y'.repeat(300)}`)).toBe(`Response body is not valid JSON: x${'y'.repeat(199)}`);
    });

    test('maps network errors without throwing, including the cause', async () => {
        const net = await fetchJson(
            fetchOf(() => {
                throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });
            }),
            'u',
            {},
        );
        expect(net).toEqual({
            ok: false,
            error: { code: 'network', message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:1' },
        });
        const thrownString = await fetchJson(
            fetchOf(() => {
                // biome-ignore lint/style/useThrowOnlyError: covers non-Error rejections
                throw 'weird';
            }),
            'u',
            {},
        );
        expect(!thrownString.ok && thrownString.error).toEqual({ code: 'network', message: 'weird' });
    });

    test('maps a body too large for a string or for memory to invalid_response', async () => {
        const tooLong = Object.assign(new Error('Cannot create a string longer than 2147483647 characters'), {
            code: 'ERR_STRING_TOO_LONG',
        });
        const thrown = [
            [new RangeError('Out of memory'), 'Out of memory'],
            [tooLong, 'Cannot create a string longer than 2147483647 characters'],
            [new Error('JavaScript heap out of memory'), 'JavaScript heap out of memory'],
        ] as const;
        for (const [error, message] of thrown) {
            const body = {
                ok: true,
                status: 200,
                text() {
                    throw error;
                },
            };
            const res = await fetchJson(
                fetchOf(() => body as unknown as Response),
                'u',
                {},
            );
            expect(res).toEqual({
                ok: false,
                error: { code: 'invalid_response', message: `Response body too large: ${message}` },
            });
        }
    });

    test('maps an aborted signal to aborted, whatever the abort reason', async () => {
        /** Mock fetch that throws immediately if signal was aborted. */
        async function rejectOnAbortFetch(_url: string, init: RequestInit) {
            init.signal?.throwIfAborted();
            return Response.json({});
        }
        const rejectOnAbort = rejectOnAbortFetch as unknown as typeof fetch;
        const timedOut = AbortSignal.timeout(1);
        await Bun.sleep(10);
        const signals = [
            AbortSignal.abort(),
            AbortSignal.abort(new Error('stop')),
            AbortSignal.abort('stop'),
            timedOut,
        ];
        for (const signal of signals) {
            const res = await fetchJson(rejectOnAbort, 'u', { signal });
            expect(!res.ok && res.error.code).toBe('aborted');
        }
    });
});

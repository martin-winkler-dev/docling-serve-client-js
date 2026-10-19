// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// Loads the built package the way consumers do: through its name and the `exports` map (Node self-reference).
import assert from 'node:assert/strict';
import { createDoclingClient, isSmallImage, PAGE_IMAGE_SCALE, readPngSize, toPageImageBox } from 'docling-serve-client';
import pkg from 'docling-serve-client/package.json' with { type: 'json' };

assert.equal(pkg.name, 'docling-serve-client');
assert.equal(PAGE_IMAGE_SCALE, 2);
assert.equal(typeof toPageImageBox, 'function');
assert.equal(toPageImageBox({ pages: {} }, { page_no: 1, bbox: { l: 0, t: 0, r: 10, b: 10 } }), undefined);

assert.equal(typeof createDoclingClient, 'function');
const client = createDoclingClient({ baseUrl: 'http://127.0.0.1:1' });
assert.deepEqual(Object.keys(client).sort(), [
    'check',
    'convertDocument',
    'convertMarkdown',
    'submitDocument',
    'submitMarkdown',
]);
const md = await client.convertMarkdown(new Uint8Array());
assert.equal(md.ok || md.error.code, 'invalid_input');
const doc = await client.convertDocument(new Uint8Array());
assert.equal(doc.ok || doc.error.code, 'invalid_input');
await assert.rejects(client.convertMarkdown(new Uint8Array(), { unknownOption: true }), TypeError);
await assert.rejects(client.convertMarkdown(new Uint8Array(), { images: 'extract' }), TypeError);
await assert.rejects(client.convertDocument(new Uint8Array(), { images: 'extract' }), TypeError);
// A stored job validates; the request then fails.
const job = await client.check({ kind: 'document', id: 'x' });
assert.equal(job.ok || job.error.code, 'network');
const invalidJob = await client.check({ id: 'x' });
assert.equal(invalidJob.ok || invalidJob.error.code, 'invalid_input');
assert.throws(() => createDoclingClient({ baseUrl: 'nope' }), TypeError);
assert.throws(() => createDoclingClient({ baseUrl: 'http://x', options: { images: 'none' } }), TypeError);
assert.equal(isSmallImage({ width: 88, height: 32 }), true);
assert.equal(isSmallImage({ width: 400, height: 300 }), false);
assert.equal(readPngSize(new Uint8Array(4)), undefined);
console.log('smoke.mjs ok');

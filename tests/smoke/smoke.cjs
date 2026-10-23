// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// CommonJS consumers load the ESM build via require(esm) (Node >= 22.12, see `engines`); fails on top-level await.
const assert = require('node:assert/strict');
const {
    PAGE_IMAGE_SCALE,
    createDoclingClient,
    isSmallImage,
    readPngSize,
    toPageImageBox,
} = require('docling-serve-client');
const pkg = require('docling-serve-client/package.json');

assert.equal(pkg.name, 'docling-serve-client');
assert.equal(PAGE_IMAGE_SCALE, 2);
assert.equal(typeof toPageImageBox, 'function');
assert.equal(toPageImageBox({ pages: {} }, { page_no: 1, bbox: { l: 0, t: 0, r: 10, b: 10 } }), undefined);

assert.equal(typeof createDoclingClient, 'function');
const client = createDoclingClient({ baseUrl: 'http://127.0.0.1:1' });
for (const name of [
    'convertMarkdown',
    'convertDocument',
    'submitMarkdown',
    'submitDocument',
    'check',
    'capabilities',
]) {
    assert.equal(typeof client[name], 'function');
}
assert.throws(() => createDoclingClient({ baseUrl: 'nope' }), TypeError);
assert.equal(isSmallImage({ width: 88, height: 32 }), true);
assert.equal(typeof readPngSize, 'function');
assert.equal(readPngSize(new Uint8Array(4)), undefined);
console.log('smoke.cjs ok');

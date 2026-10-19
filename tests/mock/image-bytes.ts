// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// Minimal image headers for tests: enough for size detection, not decodable pictures.

/** PNG signature + IHDR (RGB, 8 bit) + IEND. CRCs are zero: nothing here checks them. */
export function pngBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(8 + 25 + 12);
    const view = new DataView(bytes.buffer);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    view.setUint32(8, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    view.setUint32(16, width);
    view.setUint32(20, height);
    bytes.set([8, 2, 0, 0, 0], 24);
    // IHDR CRC (29) and IEND length (33) stay zero
    bytes.set([0x49, 0x45, 0x4e, 0x44], 37); // IEND
    return bytes;
}

export function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

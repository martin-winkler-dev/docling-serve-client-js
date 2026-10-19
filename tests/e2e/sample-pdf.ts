// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// Builds a small synthetic one-page PDF in memory: numbered headings, text, a bar chart picture and a small badge.
import { deflateSync } from 'node:zlib';

type RgbImage = {
    width: number;
    height: number;
    /** 3 bytes per pixel, rows top to bottom. */
    pixels: Uint8Array;
};

type Rgb = [number, number, number];

const BAR_COLORS: Rgb[] = [
    [52, 101, 164],
    [204, 0, 0],
    [78, 154, 6],
    [245, 121, 0],
    [117, 80, 123],
];

/** Headings and texts of the page; the heading numbers let docling infer the hierarchy. */
export const SAMPLE_TEXT = {
    title: 'Sample Images Report',
    section: '1 Introduction',
    subsection: '1.1 Background',
    results: '2 Results',
};

export function createSamplePdf(): Uint8Array {
    const content = [
        text('F2', 22, 72, 740, SAMPLE_TEXT.title),
        text('F2', 16, 72, 700, SAMPLE_TEXT.section),
        text('F1', 11, 72, 680, 'This synthetic document tests headings and pictures.'),
        text('F2', 13, 72, 650, SAMPLE_TEXT.subsection),
        text('F1', 11, 72, 632, 'The figure below shows a bar chart with five bars.'),
        image('Chart', 72, 390, 300, 225),
        text('F1', 10, 72, 372, 'Figure 1: Bars of a synthetic test chart.'),
        image('Badge', 72, 330, 44, 16),
        text('F2', 16, 72, 290, SAMPLE_TEXT.results),
        text('F1', 11, 72, 270, 'Research & Development results are summarised here.'),
    ].join('\n');
    return buildPdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << ' +
            '/Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Chart 7 0 R /Badge 8 0 R >> >> >>',
        stream('', new TextEncoder().encode(content)),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        imageObject(barChart(400, 300)),
        imageObject(badge(88, 32)),
    ]);
}

/** Joins the objects (numbered from 1) with a cross-reference table. */
function buildPdf(objects: (string | Uint8Array)[]): Uint8Array {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [encoder.encode('%PDF-1.7\n%âã\n')];
    let length = parts[0]?.length ?? 0;
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(length);
        for (const part of [encoder.encode(`${index + 1} 0 obj\n`), toBytes(body), encoder.encode('\nendobj\n')]) {
            parts.push(part);
            length += part.length;
        }
    });
    const xref = [
        'xref',
        `0 ${objects.length + 1}`,
        '0000000000 65535 f ',
        ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
        'trailer',
        `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
        'startxref',
        String(length),
        '%%EOF\n',
    ];
    parts.push(encoder.encode(xref.join('\n')));
    return concat(parts);
}

function stream(dictionary: string, data: Uint8Array): Uint8Array {
    const head = new TextEncoder().encode(`<< ${dictionary} /Length ${data.length} >>\nstream\n`);
    return concat([head, data, new TextEncoder().encode('\nendstream')]);
}

function imageObject({ width, height, pixels }: RgbImage): Uint8Array {
    const dictionary = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`;
    return stream(dictionary, deflateSync(pixels));
}

function text(font: 'F1' | 'F2', size: number, x: number, y: number, value: string): string {
    const escaped = value.replace(/[\\()]/g, (char) => `\\${char}`);
    return `BT /${font} ${size} Tf ${x} ${y} Td (${escaped}) Tj ET`;
}

function image(name: string, x: number, y: number, width: number, height: number): string {
    return `q ${width} 0 0 ${height} ${x} ${y} cm /${name} Do Q`;
}

/** White background, black axes and five colored bars. */
function barChart(width: number, height: number): RgbImage {
    return paint(width, height, (x, y) => {
        if (x === 30 || y === height - 30) {
            return [0, 0, 0];
        }
        const bar = Math.floor((x - 50) / 70);
        const barHeight = [180, 120, 220, 90, 150][bar];
        const insideBar = x > 50 && (x - 50) % 70 < 45 && barHeight !== undefined;
        return insideBar && y < height - 30 && y > height - 30 - barHeight ? (BAR_COLORS[bar] as Rgb) : [255, 255, 255];
    });
}

/** A small two-tone label, like a license badge. */
function badge(width: number, height: number): RgbImage {
    return paint(width, height, (x) => (x < width / 3 ? [80, 80, 80] : [70, 150, 60]));
}

function paint(width: number, height: number, colorAt: (x: number, y: number) => Rgb): RgbImage {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            pixels.set(colorAt(x, y), (y * width + x) * 3);
        }
    }
    return { width, height, pixels };
}

function toBytes(value: string | Uint8Array): Uint8Array {
    return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

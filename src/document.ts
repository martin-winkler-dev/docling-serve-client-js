// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/style/useNamingConvention: mirrors docling-core's snake_case JSON

// -------------------------------------------------------------------
// --- 1. Document
// -------------------------------------------------------------------

/**
 * **DoclingDocument as sent by docling-serve in `json_content`**: schema `1.10.0`, docling-core 2.101.
 *
 * - items live in flat arrays (`texts`, `tables`, ...) and point to each other with `RefItem`s (`#/texts/12`)
 * - reading order: walk `body.children` depth-first; `furniture` holds page headers and footers
 * - the response is only checked for `schema_name` and `body`; deeper fields are typed, not validated
 */
export type DoclingDocument = {
    schema_name: 'DoclingDocument';
    /** Schema version, e.g. `'1.10.0'`. */
    version: string;
    name: string;
    origin: DocumentOrigin | null;
    /** Root of page headers and footers. */
    furniture: GroupItem;
    /** Root of the content in reading order. */
    body: GroupItem;
    groups: (ListGroup | InlineGroup | GroupItem)[];
    texts: AnyTextItem[];
    pictures: PictureItem[];
    tables: TableItem[];
    key_value_items: KeyValueItem[];
    form_items: FormItem[];
    /** Not sent by every docling version. */
    field_regions?: FieldRegionItem[];
    /** Not sent by every docling version. */
    field_items?: FieldItem[];
    /** PDF pages keyed by their 1-based number as string, e.g. `'1'`. */
    pages: Record<string, PageItem>;
};

/** Source file of the document. */
export type DocumentOrigin = {
    mimetype: string;
    binary_hash: number;
    filename: string;
    uri?: string | null;
};

/** One PDF page. */
export type PageItem = {
    size: Size;
    /** Decoded page images become `null` (returned in `pageImages`); undecodable ones stay as sent. */
    image: ImageRef | null;
    page_no: number;
};

// -------------------------------------------------------------------
// --- 2. Shared Parts
// -------------------------------------------------------------------

/** JSON pointer to another item, e.g. `{ $ref: '#/texts/12' }` or `{ $ref: '#/body' }`. */
export type RefItem = { $ref: string };

/**
 * **Pointer to part of an item's text**.
 *
 * - `range`: `[start, end)` in Python code points; slice with `Array.from(text).slice(start, end).join('')`, not
 *   `text.slice` (characters outside the BMP count as 1)
 */
export type FineRef = { $ref: string; range?: [number, number] | null };

/** Layer of an item; only `body` is document content. */
export type ContentLayer = 'body' | 'furniture' | 'background' | 'invisible' | 'notes';

/** Width and height in points (pages) or pixels (images). */
export type Size = { width: number; height: number };

/** Rectangle in PDF points; `coord_origin` differs per item (`BOTTOMLEFT` for items, `TOPLEFT` for table cells). */
export type BoundingBox = {
    l: number;
    t: number;
    r: number;
    b: number;
    coord_origin: 'TOPLEFT' | 'BOTTOMLEFT';
};

/** Where an item sits in the PDF; one entry per page an item covers. */
export type ProvenanceItem = {
    /** 1-based PDF page. */
    page_no: number;
    bbox: BoundingBox;
    /** `[start, end)` span within the item's text, in Python code points: slice via `Array.from(text)`, not `text.slice`. */
    charspan: [number, number];
};

/** Image data; with `images: 'embedded'` `uri` is a `data:<mime>;base64,...` URI. */
export type ImageRef = {
    mimetype: string;
    dpi: number;
    size: Size;
    uri: string;
};

/** Inline text formatting. */
export type Formatting = {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    script: 'baseline' | 'sub' | 'super';
};

/** Media track span (audio/video sources); not used for PDFs. */
export type TrackSource = {
    kind: 'track';
    start_time: number;
    end_time: number;
    identifier?: string | null;
    voice?: string | null;
};

/** Value set by an enrichment model, with its confidence and creator. */
type MetaField = { confidence?: number | null; created_by?: string | null };

/** Enrichment metadata of any item. */
export type BaseMeta = {
    summary?: (MetaField & { text: string }) | null;
    /** ISO 639-1 code, e.g. `'de'`. */
    language?: (MetaField & { code: string }) | null;
    entities?: {
        mentions: (MetaField & {
            text: string;
            orig?: string | null;
            label?: string | null;
            /** `[start, end)` in Python code points: slice via `Array.from(text)`, not `text.slice`. */
            charspan?: [number, number] | null;
        })[];
    } | null;
    keywords?: { values: string[] } | null;
    topics?: { values: string[] } | null;
};

/** Enrichment metadata of tables, code and other floating items. */
export type FloatingMeta = BaseMeta & {
    description?: (MetaField & { text: string }) | null;
};

/** Enrichment metadata of pictures. */
export type PictureMeta = FloatingMeta & {
    classification?: { predictions: (MetaField & { class_name: string })[] } | null;
    molecule?: (MetaField & { smi: string }) | null;
    tabular_chart?: (MetaField & { title?: string | null; chart_data: TableData }) | null;
    code?: (MetaField & { text: string; language?: string | null }) | null;
};

/** Fields every item has. */
type NodeItem = {
    /** Pointer to this item, e.g. `'#/texts/12'`. */
    self_ref: string;
    /** `null` for `body` and `furniture`. */
    parent: RefItem | null;
    children: RefItem[];
    content_layer: ContentLayer;
};

/** Fields of items placed on a page. */
type DocItem = NodeItem & {
    prov: ProvenanceItem[];
    /** Not sent by every docling version. */
    source?: TrackSource[];
    /** Not sent by every docling version. */
    comments?: FineRef[];
};

/** Fields of items with captions, references and footnotes. */
type FloatingFields = {
    /** Caption texts, also listed in `children`. */
    captions: RefItem[];
    references: RefItem[];
    footnotes: RefItem[];
    /** Rendered crop of the item; `null` unless requested. */
    image: ImageRef | null;
};

// -------------------------------------------------------------------
// --- 3. Groups
// -------------------------------------------------------------------

/** Docling's group kinds. */
export type GroupLabel =
    | 'unspecified'
    | 'list'
    | 'ordered_list'
    | 'chapter'
    | 'section'
    | 'sheet'
    | 'slide'
    | 'form_area'
    | 'key_value_area'
    | 'comment_section'
    | 'inline'
    | 'picture_area';

/** Container without own content, e.g. `body`, `furniture` or a key-value area. */
export type GroupItem = NodeItem & {
    meta: BaseMeta | null;
    name: string;
    label: GroupLabel;
};

/** List whose `children` are `ListItem`s; a nested list is a `ListGroup` child of a `ListItem`. */
export type ListGroup = GroupItem & { label: 'list' };

/** Run of texts that belong to one line or paragraph, e.g. with mixed formatting. */
export type InlineGroup = GroupItem & { label: 'inline' };

// -------------------------------------------------------------------
// --- 4. Texts
// -------------------------------------------------------------------

/** Labels of plain `TextItem`s; other text labels have their own item type. */
export type TextLabel =
    | 'caption'
    | 'checkbox_selected'
    | 'checkbox_unselected'
    | 'footnote'
    | 'page_footer'
    | 'page_header'
    | 'paragraph'
    | 'reference'
    | 'text'
    | 'empty_value'
    | 'field_key'
    | 'field_hint'
    | 'marker'
    | 'handwritten_text';

/**
 * **Fields of every text item**.
 *
 * - `orig`: text as read from the PDF; `text`: after docling's processing (formulas: LaTeX or empty)
 */
type TextFields = DocItem & {
    meta: BaseMeta | null;
    orig: string;
    text: string;
    formatting: Formatting | null;
    hyperlink: string | null;
};

/** Paragraph, caption, footnote, page header or footer and other plain text. */
export type TextItem = TextFields & { label: TextLabel };

/** Document title. */
export type TitleItem = TextFields & { label: 'title' };

/** Heading; `level` starts at 1. */
export type SectionHeaderItem = TextFields & { label: 'section_header'; level: number };

/** List entry; `marker` as printed (`'(1)'`, `'-'`, often `''`), `text` may still start with a bullet glyph. */
export type ListItem = TextFields & { label: 'list_item'; enumerated: boolean; marker: string };

/** Code listing; `code_language` is `'unknown'` without code enrichment. */
export type CodeItem = Omit<TextFields, 'meta'> &
    FloatingFields & { label: 'code'; meta: FloatingMeta | null; code_language: string };

/** Formula; `text` is LaTeX with formula enrichment, otherwise empty with the raw characters in `orig`. */
export type FormulaItem = TextFields & { label: 'formula' };

/** Heading of a form field. */
export type FieldHeadingItem = TextFields & { label: 'field_heading'; level: number };

/** Value of a form field. */
export type FieldValueItem = TextFields & { label: 'field_value'; kind: 'read_only' | 'fillable' };

/** Every item of `texts`, told apart by `label`. */
export type AnyTextItem =
    | TitleItem
    | SectionHeaderItem
    | ListItem
    | CodeItem
    | FormulaItem
    | FieldHeadingItem
    | FieldValueItem
    | TextItem;

// -------------------------------------------------------------------
// --- 5. Tables
// -------------------------------------------------------------------

/** Table cell; offsets are 0-based and end-exclusive, spans repeat the cell in `grid`. */
export type TableCell = {
    bbox: BoundingBox | null;
    row_span: number;
    col_span: number;
    start_row_offset_idx: number;
    end_row_offset_idx: number;
    start_col_offset_idx: number;
    end_col_offset_idx: number;
    text: string;
    column_header: boolean;
    row_header: boolean;
    row_section: boolean;
    fillable: boolean;
    /** Set when the cell holds other items (rich cell); its `text` is then a summary. */
    ref?: RefItem;
};

/** Cells of a table; `grid` is the same cells as rows x columns. */
export type TableData = {
    table_cells: TableCell[];
    num_rows: number;
    num_cols: number;
    orientation: 'rot_0' | 'rot_90' | 'rot_180' | 'rot_270';
    /** Computed by docling on export; `num_rows` arrays of `num_cols` cells. */
    grid: TableCell[][];
};

/** Free-text description of a picture or table by a model. */
export type DescriptionAnnotation = { kind: 'description'; text: string; provenance: string };

/** Annotation without a fixed shape. */
export type MiscAnnotation = { kind: 'misc'; content: Record<string, unknown> };

/** Table or table of contents (`document_index`). */
export type TableItem = DocItem &
    FloatingFields & {
        label: 'table' | 'document_index';
        meta: FloatingMeta | null;
        data: TableData;
        annotations: (DescriptionAnnotation | MiscAnnotation)[];
    };

// -------------------------------------------------------------------
// --- 6. Pictures
// -------------------------------------------------------------------

/**
 * **Model output on a picture**: description, classification, molecule or chart data.
 *
 * - chart kinds are filled with `chartExtraction`
 */
export type PictureAnnotation =
    | DescriptionAnnotation
    | MiscAnnotation
    | {
          kind: 'classification';
          provenance: string;
          predicted_classes: { class_name: string; confidence: number }[];
      }
    | {
          kind: 'molecule_data';
          smi: string;
          confidence: number;
          class_name: string;
          segmentation: [number, number][];
          provenance: string;
      }
    | { kind: 'tabular_chart_data'; title: string; chart_data: TableData }
    | (ChartAxes<'line_chart_data'> & { lines: { label: string; values: [number, number][] }[] })
    | (ChartAxes<'bar_chart_data'> & { bars: { label: string; values: number }[] })
    | (ChartAxes<'stacked_bar_chart_data'> & { stacked_bars: { label: string[]; values: [string, number][] }[] })
    | { kind: 'pie_chart_data'; title: string; slices: { label: string; value: number }[] }
    | (ChartAxes<'scatter_chart_data'> & { points: { value: [number, number] }[] });

/** Title and axis labels of a chart annotation. */
type ChartAxes<K extends string> = { kind: K; title: string; x_axis_label: string; y_axis_label: string };

/**
 * **Picture or chart**.
 *
 * - `image`: data URI with `images: 'embedded'`, `null` with `'placeholder'`
 * - `children`: captions and texts docling found inside the picture
 */
export type PictureItem = DocItem &
    FloatingFields & {
        label: 'picture' | 'chart';
        meta: PictureMeta | null;
        annotations: PictureAnnotation[];
    };

// -------------------------------------------------------------------
// --- 7. Forms and Key-Value Regions
// -------------------------------------------------------------------

/** Cell of a key-value or form graph. */
export type GraphCell = {
    label: 'unspecified' | 'key' | 'value' | 'checkbox';
    cell_id: number;
    text: string;
    orig: string;
    prov: ProvenanceItem | null;
    item_ref: RefItem | null;
};

/** Link between two graph cells. */
export type GraphLink = {
    label: 'unspecified' | 'to_value' | 'to_key' | 'to_parent' | 'to_child';
    source_cell_id: number;
    target_cell_id: number;
};

/** Key-value pairs as a graph of cells and links. */
export type GraphData = { cells: GraphCell[]; links: GraphLink[] };

/** Region of key-value pairs. */
export type KeyValueItem = DocItem &
    FloatingFields & { label: 'key_value_region'; meta: FloatingMeta | null; graph: GraphData };

/** Form region. */
export type FormItem = DocItem & FloatingFields & { label: 'form'; meta: FloatingMeta | null; graph: GraphData };

/** Region holding form fields. */
export type FieldRegionItem = DocItem & { label: 'field_region'; meta: BaseMeta | null };

/** One form field. */
export type FieldItem = DocItem & { label: 'field_item'; meta: BaseMeta | null };

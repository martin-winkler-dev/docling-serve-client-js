// Copyright 2026 Martin Winkler
// SPDX-License-Identifier: Apache-2.0

// -------------------------------------------------------------------
// --- 1. Types
// -------------------------------------------------------------------

/** Accepts or rejects one option value. */
export type OptionRule = (value: unknown) => boolean;

// -------------------------------------------------------------------
// --- 2. Constants
// -------------------------------------------------------------------

/** Error message when options argument is provided but is not a plain object. */
export const OPTIONS_OBJECT_EXPECTED = 'Invalid options: expected an object';

// -------------------------------------------------------------------
// --- 3. Exported Functions
// -------------------------------------------------------------------

/**
 * **Checks every key of `input` against its rule**.
 *
 * - unsupported options throw `TypeError` even if their value is `undefined`
 * - `undefined` values for supported options are skipped, as if the key were missing
 * - arrays are copied, so later changes by the caller do not reach the resolved options
 * - `namePrefix` names nested options in messages, e.g. `imageOptions.`
 * @throws `TypeError` on unsupported option or invalid value.
 */
export function validateKeys<T extends object>(
    input: Record<string, unknown>,
    rules: Record<keyof T, OptionRule>,
    namePrefix = '',
): Partial<T> {
    const valid: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input)) {
        const rule: OptionRule | undefined = Object.hasOwn(rules, name) ? rules[name as keyof T] : undefined;
        if (rule === undefined) {
            throw new TypeError(notSupported(`${namePrefix}${name}`));
        }
        if (value === undefined) {
            continue;
        }
        if (!rule(value)) {
            throw new TypeError(invalidValue(`${namePrefix}${name}`));
        }
        valid[name] = Array.isArray(value) ? [...value] : value;
    }
    // Every key was checked against its rule above.
    return valid as Partial<T>;
}

/** Formats error message for an unsupported option. */
export function notSupported(name: string): string {
    return `Option "${name}" is not supported`;
}

/** Formats error message for a rejected option value. */
export function invalidValue(name: string): string {
    return `Invalid value for option "${name}"`;
}

/**
 * **Object literal, `JSON.parse` result or `Object.create(null)`**.
 *
 * - rejects arrays, `Map`, `Date`, class instances and objects from another realm
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Checks whether value is a boolean primitive. */
export function isBoolean(value: unknown): value is boolean {
    return value === true || value === false;
}

/** Type guard checking whether string is included in allowed set. */
export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

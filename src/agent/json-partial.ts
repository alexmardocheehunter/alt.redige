/**
 * Tolerated extraction of string values from a partial JSON payload.
 *
 * The tool arguments arrive as a stream of JSON fragments. To stream the contract
 * into the Canvas while it is being written, we need to read the value of
 * `"markdown"` from an incomplete JSON document.
 */

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

export interface PartialString {
  /** Decoded value (partial when the string is not terminated yet). */
  value: string;
  /** True when the closing quote of the string has been received. */
  complete: boolean;
}

/**
 * Reads the value of `key` in a (possibly incomplete) JSON object.
 * Returns `undefined` when the key is absent or when the value is not a string.
 * When the string is not terminated yet, the decoded partial value is returned
 * and `complete` is false.
 */
export function readPartialString(json: string, key: string): PartialString | undefined {
  const needle = `"${key}"`;
  let index = json.indexOf(needle);

  while (index !== -1) {
    let cursor = index + needle.length;

    while (cursor < json.length && /\s/.test(json[cursor]!)) cursor += 1;
    if (json[cursor] !== ':') {
      index = json.indexOf(needle, index + 1);
      continue;
    }
    cursor += 1;
    while (cursor < json.length && /\s/.test(json[cursor]!)) cursor += 1;
    if (json[cursor] !== '"') return undefined;

    cursor += 1;
    let out = '';

    while (cursor < json.length) {
      const char = json[cursor]!;

      if (char === '\\') {
        const next = json[cursor + 1];
        if (next === undefined) return { value: out, complete: false };
        if (next === 'u') {
          const hex = json.slice(cursor + 2, cursor + 6);
          if (hex.length < 4) return { value: out, complete: false };
          out += String.fromCharCode(Number.parseInt(hex, 16));
          cursor += 6;
          continue;
        }
        out += ESCAPES[next] ?? next;
        cursor += 2;
        continue;
      }

      if (char === '"') return { value: out, complete: true };
      out += char;
      cursor += 1;
    }

    // Unterminated string: return what has been decoded so far.
    return { value: out, complete: false };
  }

  return undefined;
}

/** Reads the value of `key`, ignoring whether the string is complete. */
export function extractPartialString(json: string, key: string): string | undefined {
  return readPartialString(json, key)?.value;
}

/** Reads a boolean value (`replace`) from a partial JSON payload. */
export function extractPartialBoolean(json: string, key: string): boolean | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(json);
  if (!match) return undefined;
  return match[1] === 'true';
}

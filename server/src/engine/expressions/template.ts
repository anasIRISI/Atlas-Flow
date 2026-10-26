import { ExpressionError } from '../errors.js';

export type Segment = { kind: 'text'; value: string } | { kind: 'code'; value: string };

/**
 * Splits "Hello {{ $json.name }}!" into text and code segments.
 * Braces and quotes inside the code are respected, so `{{ {a: "}}"} }}` works.
 */
export function splitTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let textStart = 0;
  let i = 0;
  while (i < template.length) {
    if (template[i] !== '{' || template[i + 1] !== '{') {
      i++;
      continue;
    }
    let j = i + 2;
    let depth = 0;
    let quote: string | null = null;
    let closed = false;
    while (j < template.length) {
      const c = template[j]!;
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0 && template[j + 1] === '}') {
          closed = true;
          break;
        }
        depth = Math.max(0, depth - 1);
      }
      j++;
    }
    if (!closed) {
      throw new ExpressionError('Expression is missing its closing }}', { expression: template });
    }
    if (i > textStart) segments.push({ kind: 'text', value: template.slice(textStart, i) });
    segments.push({ kind: 'code', value: template.slice(i + 2, j) });
    i = j + 2;
    textStart = i;
  }
  if (textStart < template.length) segments.push({ kind: 'text', value: template.slice(textStart) });
  return segments;
}

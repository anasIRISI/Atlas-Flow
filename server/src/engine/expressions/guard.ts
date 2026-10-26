import { parse, type Node } from 'acorn';
import { ExpressionError } from '../errors.js';

/** Names that give access to the host (Node.js) or to code generation: never allowed in expressions. */
const BLOCKED_IDENTIFIERS = new Set([
  'process', 'require', 'module', 'exports', 'global', 'globalThis', 'Function', 'eval', 'Reflect',
  'WebAssembly', 'constructor', '__proto__', 'importScripts', 'Buffer', 'setTimeout', 'setInterval',
]);

/** Property names that walk prototype chains or redefine objects. Also enforced at runtime for obj[key]. */
export const BLOCKED_PROPERTIES = [
  'constructor', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'defineProperty',
  'defineProperties', 'caller', 'callee',
];
const BLOCKED_PROPERTY_SET = new Set(BLOCKED_PROPERTIES);

/** Internal names used by the sandbox; user code may not touch them. */
const INTERNAL_PREFIX = '__ff';

/** Runtime check inserted around computed keys: obj[key] → obj[__ffKey(key)]. */
export const KEY_GUARD = '__ffKey';

type AnyNode = Node & Record<string, unknown>;

function blocked(name: string, code: string): never {
  throw new ExpressionError(`"${name}" is not allowed in expressions`, {
    expression: code.trim(),
    hint: 'Expressions can read workflow data but cannot access the server, the file system or object internals.',
  });
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Parses an expression, rejects dangerous constructs, and returns code where every computed
 * property access is wrapped with a runtime key check. Throws ExpressionError with a clear message.
 */
export function guardExpression(code: string): string {
  let ast: AnyNode;
  try {
    // Wrapped in parentheses so object literals and sequences parse as one expression.
    ast = parse(`(${code}\n)`, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AnyNode;
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/\s*\(\d+:\d+\)$/, '') : String(err);
    throw new ExpressionError(`Invalid expression syntax: ${message}`, { expression: code.trim() });
  }
  const body = ast.body as AnyNode[];
  if (body.length !== 1 || body[0]!.type !== 'ExpressionStatement') {
    throw new ExpressionError('Only a single JavaScript expression is allowed between {{ and }}', { expression: code.trim() });
  }

  const inserts: Array<{ at: number; text: string }> = [];

  const visit = (node: AnyNode, parent: AnyNode | null, key: string | null): void => {
    switch (node.type) {
      case 'Identifier': {
        const name = node.name as string;
        const isPropertyName =
          (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          (parent?.type === 'Property' && key === 'key' && !parent.computed) ||
          (parent?.type === 'MethodDefinition' && key === 'key');
        if (!isPropertyName && (BLOCKED_IDENTIFIERS.has(name) || name.startsWith(INTERNAL_PREFIX))) blocked(name, code);
        break;
      }
      case 'MemberExpression': {
        const property = node.property as AnyNode;
        if (!node.computed && property.type === 'Identifier' && BLOCKED_PROPERTY_SET.has(property.name as string)) {
          blocked(property.name as string, code);
        }
        if (node.computed) {
          if (property.type === 'Literal' && typeof property.value === 'string' && BLOCKED_PROPERTY_SET.has(property.value)) {
            blocked(property.value, code);
          }
          // Offsets are shifted by 1 because of the "(" added above.
          inserts.push({ at: (property.start as number) - 1, text: `${KEY_GUARD}(` }, { at: (property.end as number) - 1, text: ')' });
        }
        break;
      }
      case 'ImportExpression':
      case 'MetaProperty':
        blocked(node.type === 'ImportExpression' ? 'import()' : 'import.meta / new.target', code);
        break;
      case 'Property':
        if (node.computed === false && (node.key as AnyNode).type === 'Identifier' && (node.key as AnyNode).name === '__proto__') {
          blocked('__proto__', code);
        }
        break;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value)) for (const child of value) isNode(child) && visit(child, node, childKey);
      else if (isNode(value)) visit(value, node, childKey);
    }
  };
  visit(ast, null, null);

  if (inserts.length === 0) return code;
  // Apply from the end so earlier offsets stay valid; at equal offsets, closing ")" goes before "__ffKey(".
  inserts.sort((a, b) => b.at - a.at || (a.text === ')' ? 1 : -1));
  let out = code;
  for (const { at, text } of inserts) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

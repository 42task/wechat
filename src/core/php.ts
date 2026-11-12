import { unescape } from 'node:querystring';
import type { Row } from './contracts';

/** PHP trim()'s default character list deliberately does not include NBSP. */
export function phpTrim(value: string): string {
  return value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');
}

/** Explicit PHP integer casts accept a numeric prefix, including exponents. */
export function phpInt(value: unknown): number {
  if (value === null || value === undefined || value === false) return 0;
  if (value === true) return 1;
  if (typeof value === 'object') return Object.keys(value).length ? 1 : 0;
  if (typeof value === 'string') {
    const prefix = /^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(value)?.[0];
    const number = prefix === undefined ? 0 : Number(prefix);
    if (!Number.isFinite(number)) return 0;
    if (prefix !== undefined && /^[ \t\n\r\f\v]*[+-]?\d+$/.test(prefix)) {
      const text = prefix.replace(/^[ \t\n\r\f\v]+/, '');
      const negative = text.startsWith('-');
      const digits = text.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
      if (digits.length > 19) return Number(negative ? -9223372036854775808n : 9223372036854775807n);
      const integer = BigInt((negative ? '-' : '') + digits);
      return Number(integer < -9223372036854775808n ? -9223372036854775808n : integer > 9223372036854775807n ? 9223372036854775807n : integer);
    }
    return Math.trunc(Math.min(Number(9223372036854775807n), Math.max(Number(-9223372036854775808n), number)));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer >= Number(-9223372036854775808n) && integer < Number(9223372036854775807n)
    ? integer : Number(BigInt.asIntN(64, BigInt(integer)));
}

export type PhpNumberType = 'integer' | 'double';

/** PHP's default precision=14 float cast, used by Yii NumberValidator. */
export function phpFloatString(value: number): string {
  if (Number.isNaN(value)) return 'NAN';
  if (!Number.isFinite(value)) return value < 0 ? '-INF' : 'INF';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const [mantissa, power] = Math.abs(value).toExponential(13).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 14) return `${sign}${digits[0]}.${digits.slice(1) || '0'}E${exponent >= 0 ? '+' : ''}${exponent}`;
  const point = exponent + 1;
  return sign + (point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits.padEnd(point, '0') : `${digits.slice(0, point)}.${digits.slice(point)}`);
}

/** Yii integerPattern validation, before ColumnSchema's separate (int) cast. */
export function phpIntegerValid(value: unknown, type?: PhpNumberType): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = typeof value === 'number' ? (type ?? (Number.isInteger(value) ? 'integer' : 'double')) === 'double' ? phpFloatString(value) : String(value) : value;
  // PCRE $ permits one terminal LF, whereas JavaScript $ also permits CR/LS/PS.
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return /^[+-]?\d+$/.exec(normalized)?.[0] === normalized;
}

const sourceOrder = new WeakMap<object, string[]>();
const numberTypes = new WeakMap<object, Map<string, PhpNumberType>>();
const normalizedArrays = new WeakSet<object>();

export function setPhpNumberType(container: object, key: string, type: PhpNumberType): void {
  let types = numberTypes.get(container);
  if (!types) { types = new Map(); numberTypes.set(container, types); }
  types.set(key, type);
}
export function phpNumberType(container: object, key: string): PhpNumberType | undefined {
  return numberTypes.get(container)?.get(key);
}
/** Object spread must not erase PHP's integer/double and array-order metadata. */
export function copyPhpMetadata<T extends object>(source: object, target: T): T {
  const order = sourceOrder.get(source);
  if (order) sourceOrder.set(target, order.filter(key => Object.hasOwn(target, key)));
  for (const [key, type] of numberTypes.get(source) ?? []) if (Object.hasOwn(target, key)) setPhpNumberType(target, key, type);
  if (normalizedArrays.has(source)) normalizedArrays.add(target);
  return target;
}

function phpArray(entries: Array<[string, unknown]>, types = new Map<string, PhpNumberType>()): any {
  const list = entries.every(([key], index) => key === String(index));
  const result: any = list ? entries.map(([, value]) => value) : Object.create(null);
  if (!list) for (const [key, value] of entries) result[key] = value;
  sourceOrder.set(result, entries.map(([key]) => key));
  numberTypes.set(result, types);
  normalizedArrays.add(result);
  return result;
}

/** PHP json_decode(..., true) turns all JSON objects into PHP arrays. */
export function normalizePhpJson(value: any): any {
  if (value === null || typeof value !== 'object' || normalizedArrays.has(value)) return value;
  return phpArray(Object.entries(value).map(([key, nested]) => [key, normalizePhpJson(nested)]));
}

/**
 * Retain original numeric-key insertion order and integer/float lexemes, which
 * JSON.parse would discard before Yii's strict dirty-attribute comparison.
 */
export function parsePhpJson(raw: string, numberType?: (type: PhpNumberType | undefined) => void): any {
  JSON.parse(raw); // Keep native syntax validation before walking valid JSON.
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(raw[offset] ?? '') && offset < raw.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '\\') offset++;
      else if (char === '"') break;
    }
    return JSON.parse(raw.slice(start, offset));
  };
  function value(): { value: any; type?: PhpNumberType } {
    whitespace();
    if (raw[offset] === '{' || raw[offset] === '[') {
      const object = raw[offset++] === '{';
      const closing = object ? '}' : ']';
      const children = new Map<string, { value: any; type?: PhpNumberType }>();
      whitespace();
      while (raw[offset] !== closing) {
        const key = object ? string() : String(children.size);
        if (object) { whitespace(); offset++; }
        children.set(key, value());
        whitespace();
        if (raw[offset] === ',') { offset++; whitespace(); } else break;
      }
      offset++;
      return { value: phpArray([...children].map(([key, item]) => [key, item.value]), new Map([...children].filter(([, item]) => item.type !== undefined).map(([key, item]) => [key, item.type!]))) };
    }
    if (raw[offset] === '"') return { value: string() };
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) if (raw.startsWith(literal, offset)) { offset += literal.length; return { value: parsed }; }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(offset))![0];
    offset += token.length;
    let type: PhpNumberType = /[.eE]/.test(token) ? 'double' : 'integer';
    if (type === 'integer') { const integer = BigInt(token); if (integer < intMin || integer > intMax) type = 'double'; }
    const number = Number(token);
    return { value: type === 'integer' && number === 0 ? 0 : number, type };
  }
  const parsed = value();
  numberType?.(parsed.type);
  return parsed.value;
}

/** Yii recursively sorts string-key PHP arrays, then compares values strictly. */
export function phpValuesEqual(left: any, right: any, leftType?: PhpNumberType, rightType?: PhpNumberType): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    return (leftType ?? (Number.isInteger(left) ? 'integer' : 'double')) === (rightType ?? (Number.isInteger(right) ? 'integer' : 'double')) && left === right;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  const keys = (item: object): string[] => {
    const order = [...sourceOrder.get(item) ?? Object.keys(item)];
    if (order.length && order.every(key => integerKey(key) === null)) order.sort((a, b) => {
      const numeric = /^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\f\v]*$/;
      return numeric.test(a) && numeric.test(b) ? Number(a) - Number(b) : Buffer.compare(Buffer.from(a), Buffer.from(b));
    });
    return order;
  };
  const a = keys(left), b = keys(right);
  return a.length === b.length && a.every((key, index) => key === b[index] && phpValuesEqual(left[key], right[key], phpNumberType(left, key), phpNumberType(right, key)));
}

type Parameters = Map<string, string | Parameters>;
const intMax = 9223372036854775807n;
const intMin = -9223372036854775808n;

function integerKey(key: string): bigint | null {
  if (!/^(?:0|-?[1-9]\d*)$/.test(key)) return null;
  const number = BigInt(key);
  return number >= intMin && number <= intMax ? number : null;
}

function appendKey(values: Parameters): string | null {
  let greatest: bigint | undefined;
  for (const key of values.keys()) {
    const number = integerKey(key);
    if (number !== null && (greatest === undefined || number > greatest)) greatest = number;
  }
  return greatest === intMax ? null : String(greatest === undefined ? 0n : greatest + 1n);
}

function materialize(values: Parameters): unknown {
  const entries = [...values];
  // A null prototype keeps names such as __proto__ ordinary parameters.
  return phpArray(entries.map(([key, value]) => [key, value instanceof Map ? materialize(value) : value]));
}

/**
 * PHP parse_str()/request parameter semantics: last scalar wins, a later array
 * replaces a scalar, and sparse/associative arrays remain distinct from lists.
 * Map also retains insertion order while deciding whether PHP has a list.
 */
export function parsePhpParameters(raw: string | null | undefined): Row {
  const root: Parameters = new Map();
  const decode = (value: string) => unescape(value.replace(/\+/g, ' '));
  for (const pair of (raw ?? '').split('&').slice(0, 1000)) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const value = decode(equals < 0 ? '' : pair.slice(equals + 1));
    const name = decode(equals < 0 ? pair : pair.slice(0, equals)).split('\0', 1)[0].replace(/^ +/, '');
    const bracket = name.indexOf('[');
    let first = bracket < 0 ? name : name.slice(0, bracket);
    const segments: string[] = [];
    if (bracket >= 0 && name.indexOf(']', bracket + 1) < 0) first = name.replace(/\[/g, '_');
    else if (bracket >= 0) {
      let offset = bracket;
      while (name[offset] === '[') {
        const end = name.indexOf(']', offset + 1);
        if (end < 0) break;
        segments.push(name.slice(offset + 1, end));
        offset = end + 1;
      }
    }
    first = first.replace(/[ .]/g, '_');
    if (!first) continue;
    if (segments.length > 64) { root.delete(first); continue; }
    const keys = [first, ...segments];
    let current = root;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] === '' ? appendKey(current) : keys[index];
      if (key === null) break;
      if (index === keys.length - 1) current.set(key, value);
      else {
        let nested = current.get(key);
        if (!(nested instanceof Map)) { nested = new Map(); current.set(key, nested); }
        current = nested;
      }
    }
  }
  return materialize(root) as Row;
}

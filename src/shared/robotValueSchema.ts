import type { RobotValueSchema } from './types';

const SCHEMA_KINDS = new Set(['boolean', 'integer', 'integerString', 'decimalString', 'number', 'string', 'enum', 'array', 'map', 'optional', 'object', 'opaque']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validSchema(value: unknown, depth = 0, budget = { work: 0 }): value is RobotValueSchema {
  if (++budget.work > 4096 || depth > 64 || !record(value) || typeof value.kind !== 'string' || !SCHEMA_KINDS.has(value.kind) || typeof value.valueType !== 'string' || !value.valueType.trim()) return false;
  if (value.enumValues !== undefined && (!Array.isArray(value.enumValues) || !value.enumValues.every(item => ++budget.work <= 4096 && typeof item === 'string'))) return false;
  if (value.element !== undefined && !validSchema(value.element, depth + 1, budget)) return false;
  if (value.value !== undefined && !validSchema(value.value, depth + 1, budget)) return false;
  if (value.fields !== undefined && (!Array.isArray(value.fields) || !value.fields.every(field => record(field)
    && typeof field.name === 'string' && validSchema(field.schema, depth + 1, budget)))) return false;
  if (value.kind === 'enum' && (!Array.isArray(value.enumValues) || !value.enumValues.length)) return false;
  if ((value.kind === 'array' || value.kind === 'optional') && value.element === undefined) return false;
  if (value.kind === 'map' && value.value === undefined) return false;
  if (value.kind === 'object' && !Array.isArray(value.fields)) return false;
  return true;
}

/** Schema agreement is independent of JSON object insertion order. Array order
 * and all retained constraints remain meaningful; exact numeric strings stay
 * strings. The private comparison is bounded and never changes either schema. */
export function robotValueSchemasEqual(left: RobotValueSchema, right: RobotValueSchema): boolean {
  if (!validSchema(left) || !validSchema(right)) return false;
  let work = 0;
  const equal = (a: unknown, b: unknown, depth: number): boolean => {
    if (++work > 4096 || depth > 64) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') {
      return ['string', 'boolean', 'number'].includes(typeof a) && typeof a === typeof b && a === b && (typeof a !== 'number' || Number.isFinite(a));
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index], depth + 1));
    }
    if (!record(a) || !record(b)) return false;
    const keys = Object.keys(a).filter(key => a[key] !== undefined), otherKeys = Object.keys(b).filter(key => b[key] !== undefined);
    return keys.length === otherKeys.length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key], depth + 1));
  };
  return equal(left, right, 0);
}

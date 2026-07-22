/**
 * Minimal structural JSON-schema validator — deliberately dependency-free
 * and deterministic. Covers the subset api.qa derives from OpenAPI response
 * schemas and pinned specs: type / properties / required / items / enum /
 * const. Anything richer is a seam (see DESIGN.md).
 */

import type { MiniSchema } from './types.js'

export interface SchemaViolation {
  path: string
  message: string
}

export function validateSchema(value: unknown, schema: MiniSchema, path = '$'): SchemaViolation[] {
  const out: SchemaViolation[] = []

  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      out.push({ path, message: `expected const ${JSON.stringify(schema.const)}` })
    }
    return out
  }
  if (schema.enum) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      out.push({ path, message: `not in enum ${JSON.stringify(schema.enum)}` })
    }
    return out
  }

  // 3.0 nullable idiom: `{ type: 'string', nullable: true }` accepts a live
  // `null` regardless of the declared scalar `type` — fail OPEN on this
  // idiom BEFORE the type check, since `jsonType(null) === 'null'` would
  // otherwise never match a scalar `type: 'string'`.
  if (schema.nullable === true && value === null) {
    return out
  }

  if (schema.type !== undefined) {
    const actual = jsonType(value)
    // 3.1 / JSON-Schema-2020-12 nullable idiom: `type` may be a SINGLE scalar
    // ('string') OR an ARRAY of scalars (['string', 'null']) — the value is
    // valid if it matches ANY member of the (normalized) set. This is the
    // fail-OPEN fix for the 3.1 nullable false-positive: an array is never
    // `===` a scalar type string, so without normalizing, a conformant
    // `type: ['string', 'null']` field was always flagged wrong-type.
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = types.some(
      (t) =>
        t === actual ||
        (t === 'integer' && actual === 'number' && Number.isInteger(value as number)) ||
        (t === 'number' && actual === 'number'),
    )
    if (!ok) {
      out.push({ path, message: `expected ${types.join(' | ')}, got ${actual}` })
      return out
    }
  }

  if (typeIncludes(schema.type, 'object') || schema.properties || schema.required) {
    const obj = value as Record<string, unknown>
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const key of schema.required ?? []) {
        if (!(key in obj)) out.push({ path: `${path}.${key}`, message: 'required property missing' })
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in obj) out.push(...validateSchema(obj[key], sub, `${path}.${key}`))
      }
    }
  }

  if (typeIncludes(schema.type, 'array') && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => out.push(...validateSchema(item, schema.items!, `${path}[${i}]`)))
  }

  return out
}

/** True when `type` (a scalar, an array of scalars, or absent) names `want`. */
function typeIncludes(type: MiniSchema['type'], want: string): boolean {
  if (type === undefined) return false
  return Array.isArray(type) ? (type as string[]).includes(want) : type === want
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Read a dot-path ('a.b.0.c') out of a JSON value. */
export function readPath(value: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = value
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return { found: false }
    if (Array.isArray(cur)) {
      const idx = Number(part)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false }
      cur = cur[idx]
    } else {
      if (!(part in (cur as Record<string, unknown>))) return { found: false }
      cur = (cur as Record<string, unknown>)[part]
    }
  }
  return { found: true, value: cur }
}

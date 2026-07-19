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

  if (schema.type) {
    const actual = jsonType(value)
    const ok =
      schema.type === actual ||
      (schema.type === 'integer' && actual === 'number' && Number.isInteger(value as number)) ||
      (schema.type === 'number' && actual === 'number')
    if (!ok) {
      out.push({ path, message: `expected ${schema.type}, got ${actual}` })
      return out
    }
  }

  if (schema.type === 'object' || schema.properties || schema.required) {
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

  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, i) => out.push(...validateSchema(item, schema.items!, `${path}[${i}]`)))
  }

  return out
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

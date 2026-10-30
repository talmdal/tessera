// core/storage/documents.ts
//
// Validation shared by backends: documents, ids, collection and index names.
import type { Document, IndexSpec, Json, JsonObject } from '@tessera/types'
import { invalidArgument, invalidDocument } from './errors'
import { isPlainObject, toJson } from './json'

export const RESERVED_FIELDS = ['id', 'rev'] as const

/**
 * Validates a document for insert or replace and returns a clean copy: JSON
 * only, no `$`-prefixed or dotted keys at any depth (they would be
 * ambiguous in filters and updates), `rev` dropped (the engine owns it).
 */
export function normalizeDocument(doc: Document): JsonObject {
  if (!isPlainObject(doc)) throw invalidDocument('a document must be a plain object')
  if (doc.id !== undefined && (typeof doc.id !== 'string' || doc.id === '')) {
    throw invalidDocument('id must be a non-empty string')
  }
  const { rev: _rev, ...rest } = doc
  const clean = toJson(rest) as JsonObject
  checkKeys(clean, '')
  return clean
}

function checkKeys(value: Json, path: string): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkKeys(item, `${path}[${i}]`))
    return
  }
  for (const key of Object.keys(value)) {
    if (key === '') throw invalidDocument(`empty field name${path ? ` in ${path}` : ''}`)
    if (key.startsWith('$')) throw invalidDocument(`field "${key}" starts with $`)
    if (key.includes('.')) throw invalidDocument(`field "${key}" contains a dot`)
    checkKeys(value[key], path ? `${path}.${key}` : key)
  }
}

export function validateCollectionName(name: string): void {
  if (typeof name !== 'string' || name === '' || name.startsWith('$') || name.includes('/')) {
    throw invalidArgument(`"${String(name)}" is not a valid collection name`)
  }
}

export function validateIndexSpec(index: IndexSpec): void {
  if (!isPlainObject(index) || typeof index.name !== 'string' || index.name === '') {
    throw invalidArgument('An index needs a name')
  }
  if (!Array.isArray(index.fields) || index.fields.length === 0 || index.fields.some(f => typeof f !== 'string' || f === '')) {
    throw invalidArgument(`Index "${index.name}" needs at least one field`)
  }
}

export const sameIndex = (a: IndexSpec, b: IndexSpec) =>
  a.name === b.name && Boolean(a.unique) === Boolean(b.unique) &&
  a.fields.length === b.fields.length && a.fields.every((f, i) => f === b.fields[i])

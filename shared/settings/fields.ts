// shared/settings/fields.ts — the fields of a page the shell draws: checking a contributed field against the defaults
// of the namespace it edits, and checking a value against the field. The Options dialog shows the same messages the
// main process refuses a change with.
import type { JsonObject, SettingsField } from '@tessera/types'
import { getAtPath, isValidPath } from './values'

const KINDS = ['boolean', 'number', 'text', 'choice', 'folder'] as const

/**
 * A full path on any platform: `/…` (macOS, Linux), `C:\…` or `C:/…` (Windows), `\\server\share…` (a network share).
 * Here, not `node:path`, because this runs in the renderer too, and a setting saved on one system is read on another.
 */
export const isFullPath = (value: string) => /^(\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(value)

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0
const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/**
 * Why a contributed field can't be used with a namespace whose defaults are `defaults`, or undefined when it can. The
 * default at the field's key must exist and suit the field, so the form never shows something it can't edit.
 */
export function fieldDefinitionProblem(raw: unknown, defaults: JsonObject): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'a field is not an object'
  const f = raw as Record<string, unknown>

  if (!isValidPath(f.key)) return `a field has an invalid key "${String(f.key)}"`
  const where = `field "${f.key}"`
  if (!isText(f.label)) return `${where} is missing a label`
  if (!(KINDS as readonly unknown[]).includes(f.kind)) return `${where} has an unknown kind "${String(f.kind)}"; use ${KINDS.join(', ')}`
  if (f.description !== undefined && typeof f.description !== 'string') return `${where} has an invalid description`

  const initial = getAtPath(defaults, f.key)
  if (initial === undefined) return `${where} has no default: the namespace's defaults have no "${f.key}"`

  switch (f.kind) {
    case 'boolean':
      if (typeof initial !== 'boolean') return `${where} is a checkbox, but its default is not true or false`
      break
    case 'number': {
      if (!isFiniteNumber(initial)) return `${where} is a number, but its default is not a number`
      for (const bound of ['min', 'max'] as const) {
        if (f[bound] !== undefined && !isFiniteNumber(f[bound])) return `${where} has an invalid ${bound}`
      }
      if (f.min !== undefined && f.max !== undefined && (f.min as number) > (f.max as number)) return `${where} has a min above its max`
      if (f.integer !== undefined && typeof f.integer !== 'boolean') return `${where} has an invalid integer flag`
      if (f.unit !== undefined && typeof f.unit !== 'string') return `${where} has an invalid unit`
      break
    }
    case 'text':
      if (typeof initial !== 'string') return `${where} is text, but its default is not a string`
      if (f.placeholder !== undefined && typeof f.placeholder !== 'string') return `${where} has an invalid placeholder`
      if (f.maxLength !== undefined && !(Number.isInteger(f.maxLength) && (f.maxLength as number) > 0)) return `${where} has an invalid maxLength`
      if (f.required !== undefined && typeof f.required !== 'boolean') return `${where} has an invalid required flag`
      break
    case 'folder':
      if (typeof initial !== 'string') return `${where} is a folder, but its default is not a string`
      if (f.placeholder !== undefined && typeof f.placeholder !== 'string') return `${where} has an invalid placeholder`
      break
    case 'choice': {
      if (!Array.isArray(f.options) || f.options.length === 0) return `${where} is a choice with no options`
      const values = new Set<unknown>()
      for (const option of f.options as unknown[]) {
        const o = option as Record<string, unknown> | null
        if (typeof o !== 'object' || o === null || !isText(o.label) || !(typeof o.value === 'string' || isFiniteNumber(o.value))) {
          return `${where} has an option without a label and a string or number value`
        }
        if (o.description !== undefined && typeof o.description !== 'string') return `${where} has an option with an invalid description`
        if (values.has(o.value)) return `${where} has the option ${JSON.stringify(o.value)} twice`
        values.add(o.value)
      }
      if (!values.has(initial)) return `${where} has a default that is not one of its options`
      break
    }
  }
  return undefined
}

/** A copy of a valid field with only the properties its kind has, so nothing else of a plugin's object travels on. */
export function copyField(field: SettingsField): SettingsField {
  const base = { key: field.key, label: field.label, ...(field.description !== undefined && { description: field.description }) }
  switch (field.kind) {
    case 'boolean': return { kind: 'boolean', ...base }
    case 'number': return {
      kind: 'number', ...base,
      ...(field.min !== undefined && { min: field.min }), ...(field.max !== undefined && { max: field.max }),
      ...(field.integer !== undefined && { integer: field.integer }), ...(field.unit !== undefined && { unit: field.unit })
    }
    case 'text': return {
      kind: 'text', ...base,
      ...(field.placeholder !== undefined && { placeholder: field.placeholder }),
      ...(field.maxLength !== undefined && { maxLength: field.maxLength }), ...(field.required !== undefined && { required: field.required })
    }
    case 'choice': return {
      kind: 'choice', ...base,
      options: field.options.map(({ value, label, description }) => ({ value, label, ...(description !== undefined && { description }) }))
    }
    case 'folder': return { kind: 'folder', ...base, ...(field.placeholder !== undefined && { placeholder: field.placeholder }) }
  }
}

const format = (n: number) => String(n)

/** What is wrong with `value` for `field`, in words for the user, or undefined when it is fine. */
export function fieldValueProblem(field: SettingsField, value: unknown): string | undefined {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${field.label}: choose on or off.`
    case 'number': {
      if (!isFiniteNumber(value)) return `${field.label}: enter a number.`
      if (field.integer && !Number.isInteger(value)) return `${field.label}: enter a whole number.`
      const { min, max } = field
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
        if (min !== undefined && max !== undefined) return `${field.label}: enter a number from ${format(min)} to ${format(max)}.`
        return min !== undefined ? `${field.label}: enter ${format(min)} or more.` : `${field.label}: enter ${format(max!)} or less.`
      }
      return undefined
    }
    case 'text':
      if (typeof value !== 'string') return `${field.label}: enter some text.`
      if (field.required && value.trim() === '') return `${field.label}: this can't be empty.`
      if (field.maxLength !== undefined && value.length > field.maxLength) return `${field.label}: use at most ${field.maxLength} characters.`
      return undefined
    case 'choice':
      return field.options.some(option => option.value === value)
        ? undefined
        : `${field.label}: choose one of ${field.options.map(option => option.label).join(', ')}.`
    case 'folder':
      return typeof value === 'string' && (value === '' || isFullPath(value))
        ? undefined
        : `${field.label}: choose a folder with Browse…, or Default.`
  }
}

/** Every problem the fields find in a namespace's value, in field order. */
export function fieldsProblems(fields: readonly SettingsField[], value: JsonObject): string[] {
  return fields.flatMap(field => {
    const problem = fieldValueProblem(field, getAtPath(value, field.key))
    return problem ? [problem] : []
  })
}

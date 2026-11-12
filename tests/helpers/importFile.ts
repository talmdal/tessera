import fs from 'node:fs'
import path from 'node:path'
import { IMPORT_LIMITS, type ImportFile } from '@tessera/import-api'
import { decode } from '../../plugins/import/src/privileged/files'
import { encodeAs, type Sidecar } from '../../scripts/anonymise/encoding'

/** The sample statements in samples/statements, which the tests use so they can't quietly stop working. */
export const SAMPLES = path.resolve(__dirname, '../../samples/statements')

/** An `ImportFile` over bytes, decoding text with the import manager's own decoder (a byte-order mark wins). */
export function importFile(name: string, content: Uint8Array | string, filePath = `/statements/${name}`): ImportFile {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  return {
    name, path: filePath, extension: path.extname(name).slice(1).toLowerCase(), size: bytes.length, bytes,
    head: bytes.subarray(0, IMPORT_LIMITS.sniffBytes),
    text: (encoding?: string) => decode(bytes, encoding)
  }
}

/** A sample statement, as a file. */
export const sample = (name: string) => importFile(name, fs.readFileSync(path.join(SAMPLES, name)), path.join(SAMPLES, name))

/**
 * A fixture file's bytes as the bank sent them. An anonymised real file is kept as UTF-8 text; when the original wasn't
 * (windows-1252, a byte-order mark, CRLF line ends), a sidecar `<file>.meta.json` says how it was, and the bytes are
 * rebuilt from it (scripts/anonymise/encoding.ts). Files without a sidecar are read as they are.
 */
export function fixtureBytes(filePath: string): Uint8Array {
  const bytes = new Uint8Array(fs.readFileSync(filePath))
  const sidecar = `${filePath}.meta.json`
  if (!fs.existsSync(sidecar)) return bytes
  return encodeAs(new TextDecoder('utf-8').decode(bytes), JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Sidecar)
}

/** A fixture file as an `ImportFile`, with its original bytes rebuilt (see `fixtureBytes`). */
export const fixtureFile = (filePath: string) => importFile(path.basename(filePath), fixtureBytes(filePath), filePath)

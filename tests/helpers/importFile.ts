import fs from 'node:fs'
import path from 'node:path'
import { IMPORT_LIMITS, type ImportFile } from '@tessera/import-api'
import { decode } from '../../plugins/import/src/privileged/files'

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

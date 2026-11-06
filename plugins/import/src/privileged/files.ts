// Reading a file for a format plugin: format plugins never open files themselves. The size is checked before
// anything is read, and text is decoded with a byte-order mark taking priority over the encoding the format asks for.
import fs from 'node:fs/promises'
import path from 'node:path'
import { IMPORT_LIMITS, ImportError, type ImportFile } from '@tessera/import-api'

/** What reading needs from the file system; tests pass their own. */
export interface FileReader {
  size(filePath: string): Promise<number>
  read(filePath: string): Promise<Uint8Array>
}

export const nodeReader: FileReader = {
  size: async filePath => (await fs.stat(filePath)).size,
  read: async filePath => new Uint8Array(await fs.readFile(filePath))
}

/**
 * The labels the Encoding Standard gives windows-1252, which it also uses for "latin1", "iso-8859-1" and "ascii".
 * Node's own `TextDecoder` (22.x, so Electron's main process) reads them as ISO-8859-1, turning 0x80–0x9F into
 * control characters rather than € ‘ ’ “ ” – — …, which banks' files use. So windows-1252 is decoded here.
 */
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1',
  'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252'
])

/** windows-1252's 0x80–0x9F; the five bytes it leaves undefined stand for the control characters of the same number. */
const WINDOWS_1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178
]

function decodeWindows1252(bytes: Uint8Array): string {
  let text = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    const chunk = bytes.subarray(start, start + 8192)
    text += String.fromCharCode(...Array.from(chunk, b => b >= 0x80 && b <= 0x9f ? WINDOWS_1252_HIGH[b - 0x80] : b))
  }
  return text
}

/** Text from bytes: a byte-order mark says the encoding; otherwise `encoding` (default UTF-8). */
export function decode(bytes: Uint8Array, encoding = 'utf-8'): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (WINDOWS_1252_LABELS.has(encoding.trim().toLowerCase())) return decodeWindows1252(bytes)
  return new TextDecoder(encoding).decode(bytes)
}

/** A file as an `ImportFile`, or an `ImportError` saying why it can't be read (too large, missing, unreadable). */
export async function readImportFile(filePath: string, reader: FileReader = nodeReader, maxSize: number = IMPORT_LIMITS.maxFileSize): Promise<ImportFile> {
  const name = path.basename(filePath)
  let size: number
  try {
    size = await reader.size(filePath)
  } catch (err) {
    const code = (err as { code?: string })?.code
    throw new ImportError('UNREADABLE', code === 'ENOENT' ? `${name} no longer exists.` : `${name} can't be read: ${(err as Error)?.message ?? err}`)
  }
  if (size > maxSize) {
    throw new ImportError('TOO_LARGE', `${name} is ${(size / 1024 / 1024).toFixed(1)} MB; statements larger than ${maxSize / 1024 / 1024} MB aren't imported.`)
  }
  let bytes: Uint8Array
  try {
    bytes = await reader.read(filePath)
  } catch (err) {
    throw new ImportError('UNREADABLE', `${name} can't be read: ${(err as Error)?.message ?? err}`)
  }
  return {
    name, path: filePath, extension: path.extname(name).slice(1).toLowerCase(), size: bytes.length, bytes,
    head: bytes.subarray(0, IMPORT_LIMITS.sniffBytes),
    text: (encoding?: string) => decode(bytes, encoding)
  }
}

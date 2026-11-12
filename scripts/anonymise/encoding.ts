// How an anonymised file is kept: as UTF-8 text, with a sidecar (<name>.meta.json) saying how the original was
// encoded when that differs, so a test can rebuild the bytes the bank sent. Bytes that aren't UTF-8 don't survive
// every copy (the first Windows run lost a sample's accents), and git may rewrite line ends.
// See docs/import-formats-design.md, "Encodings and line ends".
import { decode } from '../../plugins/import/src/privileged/files'

/** How the original file was written, when it wasn't plain UTF-8 (or ASCII) with '\n' line ends and no BOM. */
export interface Sidecar {
  encoding: string
  bom: boolean
  lineEnd: '\n' | '\r\n' | '\r'
}

/** A file's text and how it was written. */
export interface Decoded {
  text: string
  encoding: string
  bom: boolean
  lineEnd: Sidecar['lineEnd']
}

/** The line end a text uses most. */
export function lineEndOf(text: string): Sidecar['lineEnd'] {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const cr = (text.match(/\r/g)?.length ?? 0) - crlf
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf >= lf && crlf >= cr && crlf > 0 ? '\r\n' : cr > lf ? '\r' : '\n'
}

/** The byte-order mark's encoding, if the bytes start with one. */
function bomOf(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return undefined
}

/**
 * Decodes a file as the import manager would: a byte-order mark wins; otherwise `declared` (the encoding the file
 * says it is in), or, when it says nothing, UTF-8 if the bytes are valid UTF-8 and windows-1252 if not.
 */
export function decodeFile(bytes: Uint8Array, declared?: string): Decoded {
  const bom = bomOf(bytes)
  let encoding = bom ?? declared ?? 'auto'
  if (encoding === 'auto') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = 'utf-8' } catch { encoding = 'windows-1252' }
  }
  const text = decode(bytes, bom ? 'utf-8' : encoding)
  return { text, encoding: encoding.toLowerCase(), bom: bom !== undefined, lineEnd: lineEndOf(text) }
}

const UTF8 = /^(utf-?8|us-ascii|ascii)$/i

/** The sidecar an output needs, or undefined when its UTF-8 text is the original's encoding already. */
export function sidecarFor(decoded: Decoded, output: string): Sidecar | undefined {
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(output)
  const sameBytes = !decoded.bom && decoded.lineEnd === '\n' && (UTF8.test(decoded.encoding) || ascii) && !/^utf-16/i.test(decoded.encoding)
  return sameBytes ? undefined : { encoding: decoded.encoding, bom: decoded.bom, lineEnd: decoded.lineEnd }
}

/** windows-1252 (and the labels the Encoding Standard gives it), character → byte. */
let windows1252: Map<string, number> | undefined
function encode1252(text: string): Uint8Array {
  if (!windows1252) {
    windows1252 = new Map()
    for (let b = 0; b < 256; b++) windows1252.set(decode(Uint8Array.of(b), 'windows-1252'), b)
  }
  return Uint8Array.from(text, ch => {
    const byte = windows1252!.get(ch)
    if (byte === undefined) throw new Error(`“${ch}” can't be written in windows-1252.`)
    return byte
  })
}

/** The bytes of a file written as `sidecar` says: its line ends, its encoding and its byte-order mark. */
export function encodeAs(text: string, sidecar: Sidecar): Uint8Array {
  const lines = text.replace(/\r\n|\r|\n/g, sidecar.lineEnd)
  const encoding = sidecar.encoding.toLowerCase()
  let body: Uint8Array
  let bom: number[] = []
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const little = encoding === 'utf-16le'
    body = new Uint8Array(lines.length * 2)
    for (let i = 0; i < lines.length; i++) {
      const unit = lines.charCodeAt(i)
      body[i * 2] = little ? unit & 0xff : unit >> 8
      body[i * 2 + 1] = little ? unit >> 8 : unit & 0xff
    }
    bom = little ? [0xff, 0xfe] : [0xfe, 0xff]
  } else if (UTF8.test(encoding)) {
    body = new TextEncoder().encode(lines)
    bom = [0xef, 0xbb, 0xbf]
  } else {
    body = encode1252(lines)
  }
  return sidecar.bom ? Uint8Array.from([...bom, ...body]) : body
}

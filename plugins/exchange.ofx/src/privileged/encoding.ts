// Getting an OFX file's bytes into text without mangling them.
//
// OFX 1.x declares `ENCODING` and `CHARSET` in its header, and the common pair is `USASCII` with `CHARSET:1252`
// — which means Windows-1252 and is neither ASCII nor UTF-8. Reading it as UTF-8 turns every accented payee
// into replacement characters, so the declared pair is honoured and Windows-1252 is the fallback. OFX 2.x is
// XML, where the declaration wins and UTF-8 is the default.
import type { ExchangeWarning } from '@tessera/exchange-api'

export type OfxSyntax = 'sgml' | 'xml'

export interface OfxHeader {
  syntax: OfxSyntax
  /** 102, 200, 211… Absent when the file declares none. */
  version?: string
  encoding?: string
  charset?: string
  /** Quicken and QuickBooks files carry this in the body, not the header; see the reader. */
  security?: string
  /** Where the tree starts, as a byte offset. */
  bodyAt: number
}

export interface DecodeResult {
  text: string
  header: OfxHeader
  warnings: ExchangeWarning[]
}

const BOM = [0xef, 0xbb, 0xbf]

/** Bytes as text, one byte per character, so a header can be read before the encoding is known. */
const asLatin1 = (data: Uint8Array) => new TextDecoder('latin1').decode(data)

/** The label `TextDecoder` knows for what an OFX header declares. */
export function codecFor(encoding: string | undefined, charset: string | undefined): string {
  const declared = (encoding ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const page = (charset ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

  if (declared === 'UTF8') return 'utf-8'
  // `NONE` and `1252` both mean the Windows code page; `USASCII` with a code page means the code page, because
  // a file that was truly ASCII would be read identically either way
  if (page === '1252' || page === 'NONE' || page === '') return 'windows-1252'
  if (page === '8859' || page === '88591' || page === 'ISO88591' || page === 'LATIN1') return 'iso-8859-1'
  if (page === 'UTF8') return 'utf-8'
  return 'windows-1252'
}

/** The `KEY:VALUE` block an OFX 1.x file starts with, and where its body begins. */
export function readSgmlHeader(data: Uint8Array): OfxHeader {
  // The header is ASCII, so reading it a byte at a time is safe whatever the body turns out to be
  const head = asLatin1(data.subarray(0, Math.min(data.length, 2048)))
  const fields: Record<string, string> = {}
  let bodyAt = 0

  for (const match of head.matchAll(/([A-Z]+):([^\r\n]*)\r?\n/g)) {
    const at = match.index ?? 0
    if (at > head.indexOf('<')) break
    fields[match[1]] = match[2].trim()
    bodyAt = at + match[0].length
  }

  const angle = head.indexOf('<')
  return {
    syntax: 'sgml',
    ...(fields.VERSION !== undefined && { version: fields.VERSION }),
    ...(fields.ENCODING !== undefined && { encoding: fields.ENCODING }),
    ...(fields.CHARSET !== undefined && { charset: fields.CHARSET }),
    ...(fields.SECURITY !== undefined && { security: fields.SECURITY }),
    bodyAt: angle === -1 ? bodyAt : Math.min(bodyAt === 0 ? angle : bodyAt, angle)
  }
}

/** The XML declaration and the `<?OFX …?>` processing instruction of an OFX 2.x file. */
export function readXmlHeader(head: string): OfxHeader {
  const encoding = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]
  const version = /<\?OFX[^>]*\bVERSION\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]
  const security = /<\?OFX[^>]*\bSECURITY\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]
  return {
    syntax: 'xml',
    ...(version !== undefined && { version }),
    ...(encoding !== undefined && { encoding }),
    ...(security !== undefined && { security }),
    bodyAt: 0
  }
}

/** Whether these bytes look like the XML syntax: a declaration, a `<?OFX` instruction, or a bare `<OFX` tag. */
export function looksLikeXml(head: string): boolean {
  const start = head.replace(/^﻿/, '').trimStart()
  if (start.startsWith('<?xml') || start.startsWith('<?OFX')) return true
  // No `KEY:VALUE` header at all, but a tree: a 2.x file whose declaration was stripped
  return start.startsWith('<OFX') && !/^[A-Z]+:/m.test(head.slice(0, 200))
}

/**
 * Bytes to text, by what the file declares. A byte the chosen codec cannot represent becomes U+FFFD and is
 * reported once — never silently, because a mangled payee is a payee the matcher will not recognise next month.
 */
export function decode(data: Uint8Array): DecodeResult {
  const warnings: ExchangeWarning[] = []
  const bytes = startsWithBom(data) ? data.subarray(BOM.length) : data
  const probe = asLatin1(bytes.subarray(0, 2048))

  const header = looksLikeXml(probe) ? readXmlHeader(probe) : readSgmlHeader(bytes)
  const codec = header.syntax === 'xml'
    ? normaliseXmlCodec(header.encoding)
    : codecFor(header.encoding, header.charset)

  const body = bytes.subarray(header.bodyAt)
  let text: string
  try {
    text = new TextDecoder(codec).decode(body)
  } catch {
    warnings.push({ code: 'encoding.unknown', message: `This file declares the encoding “${codec}”, which Tessera does not know. It was read as Windows-1252.` })
    text = new TextDecoder('windows-1252').decode(body)
  }

  const replaced = countReplacements(text)
  if (replaced > 0) {
    warnings.push({
      code: 'encoding.replaced',
      message: `${replaced} character${replaced === 1 ? '' : 's'} could not be read as ${codec} and ${replaced === 1 ? 'was' : 'were'} replaced. Payees and memos may be wrong.`
    })
  }

  return { text, header, warnings }
}

export const startsWithBom = (data: Uint8Array) =>
  data.length >= 3 && BOM.every((byte, at) => data[at] === byte)

export function normaliseXmlCodec(encoding: string | undefined): string {
  const declared = (encoding ?? 'utf-8').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (declared === 'utf8' || declared === '') return 'utf-8'
  if (declared === 'windows1252' || declared === 'cp1252') return 'windows-1252'
  if (declared === 'iso88591' || declared === 'latin1') return 'iso-8859-1'
  return encoding ?? 'utf-8'
}

function countReplacements(text: string): number {
  let count = 0
  for (let at = text.indexOf('�'); at !== -1; at = text.indexOf('�', at + 1)) count += 1
  return count
}

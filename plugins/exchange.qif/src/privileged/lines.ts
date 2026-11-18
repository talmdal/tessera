// A QIF file as lines, records and blocks. One letter of code and the rest of the line as its value; `^` on its
// own ends a record; a line starting `!` says what the records that follow mean.
import type { ExchangeWarning } from '@tessera/exchange-api'

export interface QifLine {
  code: string
  value: string
  /** 1-based, for a warning the user can act on. */
  line: number
}

export interface QifRecord {
  fields: QifLine[]
  /** The line the record starts on. */
  line: number
}

/** A `!` line and the records under it, in file order. */
export interface QifBlock {
  /** The control line as written, trimmed: `!Type:Bank`, `!Account`, `!Option:AutoSwitch`. */
  control: string
  line: number
  records: QifRecord[]
}

const BOM = '\ufeff'

/** Bytes as text: UTF-8 when the bytes are valid UTF-8, else Windows-1252, which is what Money and Quicken wrote. */
export function decodeQif(data: Uint8Array): { text: string, encoding: 'utf-8' | 'windows-1252' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return { text: text.startsWith(BOM) ? text.slice(1) : text, encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(data), encoding: 'windows-1252' }
  }
}

/**
 * The file as blocks of records. Records before any control line go into a block with an empty control, which
 * the reader treats as a bank account's transactions — some exporters leave the `!Type:` line out.
 */
export function splitQif(text: string, warnings: ExchangeWarning[]): QifBlock[] {
  const blocks: QifBlock[] = []
  let block: QifBlock | undefined
  let record: QifRecord | undefined
  const lines = text.split(/\r\n|\n|\r/)

  for (const [index, raw] of lines.entries()) {
    const line = index + 1
    const body = raw.replace(/\s+$/, '')
    if (body === '') continue

    if (body.startsWith('!')) {
      if (record !== undefined) {
        warnings.push({ code: 'record.malformed', message: 'A record was not ended with ^ before the next section began; it was kept.', source: { line: record.line } })
        block?.records.push(record)
        record = undefined
      }
      block = { control: body.trim(), line, records: [] }
      blocks.push(block)
      continue
    }
    if (block === undefined) {
      block = { control: '', line, records: [] }
      blocks.push(block)
    }
    if (body.trim() === '^') {
      if (record !== undefined) block.records.push(record)
      record = undefined
      continue
    }
    record ??= { fields: [], line }
    record.fields.push({ code: body[0], value: body.slice(1), line })
  }
  if (record !== undefined) {
    warnings.push({ code: 'record.malformed', message: 'The last record was not ended with ^; it was kept.', source: { line: record.line } })
    block?.records.push(record)
  }
  return blocks
}

/** The first field with this code, or undefined. */
export const field = (record: QifRecord, code: string): string | undefined =>
  record.fields.find(f => f.code === code)?.value

/** Every field with this code, in order. */
export const fields = (record: QifRecord, code: string): string[] =>
  record.fields.filter(f => f.code === code).map(f => f.value)

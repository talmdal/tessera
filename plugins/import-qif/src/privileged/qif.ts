// QIF's records, from a file's text: `!` lines open sections (`!Type:Bank`, `!Account`, `!Option:AutoSwitch`), and
// each record is lines of a one-letter code and a value, ended by `^`. Every line end is accepted, blank lines and
// trailing spaces are ignored, a last record may lack its `^`, and a `!` line ends the record before it. Each field
// keeps its line and where its value is in the text, so the anonymiser can rewrite values and leave every other byte.
// Pure. See docs/import-formats-design.md, "Reading records".

export interface QifField {
  /** The one-letter code: 'D', 'T', 'P', 'S', '$'… */
  code: string
  /** The value, without trailing spaces. */
  value: string
  /** From 1. */
  line: number
  /** Where the value is in the text: [start, end). */
  start: number
  end: number
}

export interface QifRecord {
  fields: QifField[]
  /** The record's first line, from 1. */
  line: number
}

export interface QifSection {
  /** The `!` line as written: '!Type:Bank'. Empty for records before any header. */
  header: string
  /** The header compared as QIF readers do: lower case, without spaces ('!type:otha'). */
  name: string
  line: number
  records: QifRecord[]
}

/** A header as it is compared: '!Type:Oth A' → '!type:otha'. */
export const sectionName = (header: string) => header.toLowerCase().replace(/\s+/g, '')

/** The value of a record's first field with `code`. */
export const valueOf = (record: QifRecord, code: string) => record.fields.find(f => f.code === code)?.value

/** Every section of a QIF file's text, in order. */
export function parseQif(text: string): QifSection[] {
  const sections: QifSection[] = []
  let section: QifSection | undefined
  let fields: QifField[] = []
  let recordLine = 0

  const endRecord = () => {
    if (fields.length > 0) {
      if (!section) { section = { header: '', name: '', line: recordLine, records: [] }; sections.push(section) }
      section.records.push({ fields, line: recordLine })
    }
    fields = []
  }

  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g
  let line = 0
  for (let m = pattern.exec(text); m !== null && m.index < text.length; m = pattern.exec(text)) {
    line++
    const raw = m[1]
    const lead = raw.length - raw.trimStart().length
    const content = raw.trim()
    if (content === '') { if (m[0] === '') break; continue }
    if (content.startsWith('!')) {
      endRecord()
      section = { header: content, name: sectionName(content), line, records: [] }
      sections.push(section)
    } else if (content === '^' || content.startsWith('^')) {
      endRecord()
    } else {
      if (fields.length === 0) recordLine = line
      const start = m.index + lead + 1
      const value = raw.slice(lead + 1).trimEnd()
      fields.push({ code: content[0], value, line, start, end: start + value.length })
    }
    if (m[0] === '') break
  }
  endRecord()
  return sections
}

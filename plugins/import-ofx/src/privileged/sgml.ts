// OFX in either dialect, as one tree of tags. OFX 1.x is SGML: aggregates are closed (</STMTTRN>), but elements that
// hold a value are not (<TRNAMT>-84.12). OFX 2.x is XML, where everything is closed. Both are read the same way: an
// element that has received text is a value, and the next tag closes it; a closing tag closes everything still open
// down to the element it names; a closing tag nothing matches is ignored.

export interface OfxNode {
  /** Upper case: OFX tag names are case-insensitive in practice. */
  name: string
  /** The element's value, trimmed, for an element that holds one. */
  text?: string
  /**
   * Where the value is written in the text given to `parseOfx`, trimmed: `text.slice(start, end)` is the value as
   * written, entities and all. For tools that rewrite values in place (the anonymiser, scripts/anonymise/).
   */
  span?: { start: number, end: number }
  children: OfxNode[]
}

export interface OfxDocument {
  /** The OFX 1.x header's fields (OFXHEADER, VERSION, CHARSET…), or the XML declaration's and OFX processing instruction's. */
  header: Record<string, string>
  /** The <OFX> element. */
  root: OfxNode
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/** The header before <OFX>: `KEY:VALUE` lines (1.x), or attributes of `<?xml …?>` and `<?OFX …?>` (2.x). */
function readHeader(text: string): Record<string, string> {
  const header: Record<string, string> = {}
  for (const [, key, value] of text.matchAll(/^\s*([A-Z]+)\s*:\s*(.*?)\s*$/gim)) header[key.toUpperCase()] = value
  for (const [, key, value] of text.matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)) header[key.toUpperCase()] = value
  return header
}

/**
 * The encoding a file's header declares: OFX 2.x's XML declaration, or OFX 1.x's CHARSET (1252 for most banks). UTF-8
 * when it declares none. `head` is the start of the file read as Latin-1, which is safe: every OFX header is ASCII.
 */
export function declaredEncoding(head: string): string {
  const declared = /encoding\s*=\s*"([^"]+)"/i.exec(head)?.[1]
  if (declared) return declared
  const charset = /^\s*CHARSET\s*:\s*(\S+)/im.exec(head)?.[1]?.toUpperCase()
  if (/^(UTF-?8|CSUNICODE)$/.test(charset ?? '')) return 'utf-8'
  if (charset === undefined || charset === 'NONE') return 'utf-8'
  if (/^ISO-?8859-?1$/.test(charset)) return 'latin1'
  return /^\d+$/.test(charset) ? `windows-${charset}` : charset.toLowerCase()
}

/** Reads an OFX file's text, or returns undefined when it has no <OFX> element. */
export function parseOfx(text: string): OfxDocument | undefined {
  const start = text.search(/<OFX>/i)
  if (start === -1) return undefined
  const header = readHeader(text.slice(0, start))

  const root: OfxNode = { name: '#document', children: [] }
  const stack: OfxNode[] = [root]
  const top = () => stack[stack.length - 1]
  /** A value element (one with text) can't contain anything: the next tag closes it. */
  const closeValue = () => { if (stack.length > 1 && top().text !== undefined) stack.pop() }

  const tokens = /<(\/?)([A-Za-z][\w.]*)[^>]*>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|([^<]+)/g
  for (const match of text.slice(start).matchAll(tokens)) {
    const [token, slash, name, content] = match
    if (content !== undefined) {
      const value = decodeEntities(content).trim()
      if (value !== '' && stack.length > 1) {
        const node = top()
        node.text = (node.text ?? '') + value
        const from = start + match.index! + (content.length - content.trimStart().length)
        const to = start + match.index! + content.trimEnd().length
        node.span = { start: node.span?.start ?? from, end: to }
      }
      continue
    }
    if (name === undefined || token.startsWith('<!--') || token.startsWith('<?')) continue
    const tag = name.toUpperCase()
    if (slash === '') {
      closeValue()
      const node: OfxNode = { name: tag, children: [] }
      top().children.push(node)
      if (!token.endsWith('/>')) stack.push(node)
      continue
    }
    // A closing tag: close everything open down to it, if it is open at all
    const at = stack.findLastIndex(node => node.name === tag)
    if (at > 0) stack.length = at
  }

  const ofx = root.children.find(node => node.name === 'OFX')
  return ofx ? { header, root: ofx } : undefined
}

/** Every element named `name` at or below `node`, in document order. */
export function findAll(node: OfxNode, name: string): OfxNode[] {
  const found: OfxNode[] = []
  const walk = (n: OfxNode) => { for (const child of n.children) { if (child.name === name) found.push(child); walk(child) } }
  walk(node)
  return found
}

/** The first element named `name` below `node`. */
export const find = (node: OfxNode, name: string): OfxNode | undefined => findAll(node, name)[0]

/**
 * The value of the first element named `name` below `node`, or undefined when missing or empty. Searching the whole
 * subtree, not just the children, copes with an empty value element (<MEMO> with nothing after it), which SGML can't
 * tell from an aggregate, and so may wrongly contain its next sibling.
 */
export function valueOf(node: OfxNode | undefined, name: string): string | undefined {
  if (!node) return undefined
  const text = find(node, name)?.text
  return text === undefined || text === '' ? undefined : text
}

// One tokeniser for both OFX syntaxes.
//
// OFX 1.x is SGML: leaf tags are never closed, so `<CODE>0<SEVERITY>INFO</STATUS>` is three tags and two
// values. No XML parser can read it. OFX 2.x is well-formed XML — which, to this tokeniser, is simply the case
// where every leaf happens to be closed. Writing one parser rather than two removes the whole class of “works
// in 1.x, subtly different in 2.x” bugs, at the cost of not rejecting malformed XML; for a reader whose job is
// to be forgiving, that is a trade worth making.
//
// The rules, in full:
//   • `<TAG>` followed (ignoring spaces) by `<` opens an element;
//   • `<TAG>` followed by anything else opens a leaf whose value runs to the next `<`;
//   • opening any tag first closes a leaf that is still open — that is what makes unclosed leaves work;
//   • `</TAG>` closes tags until it has closed one named TAG, so it closes a dangling leaf on the way.

export interface OfxNode {
  tag: string
  /** A leaf's text, entity-decoded and trimmed. Undefined for an element. */
  value?: string
  children: OfxNode[]
  /** 1-based, for a warning the user can act on. */
  line: number
}

export interface TokenizeResult {
  root: OfxNode
  /** Tags closed that were never opened, and tags left open at the end. */
  problems: { message: string, line: number }[]
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', apos: '\'', quot: '"', nbsp: ' '
}

/** `&amp;`, `&#38;` and `&#x26;`. An entity nobody recognises is left exactly as it was written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, whole) : whole
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

function safeFromCodePoint(code: number, whole: string): string {
  try {
    return String.fromCodePoint(code)
  } catch { return whole }
}

/** The tag name of `<NAME attr="x">` or `</NAME>`: up to the first space, slash or `>`. */
function nameOf(source: string, from: number): string {
  let at = from
  while (at < source.length && !/[\s/>]/.test(source[at])) at += 1
  return source.slice(from, at).toUpperCase()
}

/** Where `<` next appears at or after `from`, or the end of the text. */
const nextTag = (source: string, from: number) => {
  const at = source.indexOf('<', from)
  return at === -1 ? source.length : at
}

export function tokenize(source: string): TokenizeResult {
  const root: OfxNode = { tag: '#document', children: [], line: 1 }
  const stack: OfxNode[] = [root]
  const problems: { message: string, line: number }[] = []

  // Kept incrementally: counting newlines from the start on every tag would make a large file quadratic
  let line = 1
  let counted = 0
  const lineAt = (index: number) => {
    for (; counted < index && counted < source.length; counted += 1) {
      if (source.charCodeAt(counted) === 10) line += 1
    }
    return line
  }

  /** A leaf is still on the stack only while nothing has followed it. */
  const closeOpenLeaf = () => {
    const top = stack[stack.length - 1]
    if (top !== root && top.value !== undefined) stack.pop()
  }

  let at = source.indexOf('<')
  if (at === -1) return { root, problems }

  while (at < source.length) {
    const next = source[at + 1]

    // `<!-- -->`, `<!DOCTYPE …>`, `<?xml …?>`: not part of the tree
    if (next === '!' || next === '?') {
      const end = source.startsWith('<!--', at) ? source.indexOf('-->', at + 4) + 3 : source.indexOf('>', at) + 1
      at = nextTag(source, end <= 0 ? source.length : end)
      continue
    }

    if (next === '/') {
      const tag = nameOf(source, at + 2)
      const found = [...stack].reverse().findIndex(node => node.tag === tag)
      if (found === -1) {
        problems.push({ message: `</${tag}> closes a tag that was never opened`, line: lineAt(at) })
      } else {
        // Closing an element also closes any leaf left open inside it
        for (let popped = 0; popped <= found; popped += 1) stack.pop()
      }
      at = nextTag(source, source.indexOf('>', at) + 1)
      continue
    }

    if (next === undefined || !/[A-Za-z]/.test(next)) {
      // A stray `<` in a value; nothing useful follows it
      at = nextTag(source, at + 1)
      continue
    }

    const tag = nameOf(source, at + 1)
    const close = source.indexOf('>', at)
    if (close === -1) {
      problems.push({ message: `<${tag} is never finished`, line: lineAt(at) })
      break
    }
    const selfClosing = source[close - 1] === '/'
    const node: OfxNode = { tag, children: [], line: lineAt(at) }

    closeOpenLeaf()
    stack[stack.length - 1].children.push(node)
    if (selfClosing) {
      node.value = ''
      at = nextTag(source, close + 1)
      continue
    }

    const valueEnd = nextTag(source, close + 1)
    const raw = source.slice(close + 1, valueEnd)
    if (raw.trim() === '' && LEAVES.has(tag.toUpperCase())) {
      // A leaf with nothing in it. In the SGML syntax it has no closing tag either — `<NAME>` and then the next
      // field — and taken as an element it adopted every field after it, so the transaction lost its amount
      // and reference and was dropped. In XML its `</NAME>` follows, which closes it all the same.
      node.value = ''
      stack.push(node)
    } else if (raw.trim() === '') {
      // An element: what follows is another tag, not a value
      stack.push(node)
    } else {
      node.value = decodeEntities(raw).trim()
      // Pushed so that `</TAG>` in the XML syntax has something to close; the next opening tag closes it
      stack.push(node)
    }
    at = valueEnd
  }

  for (const node of stack.slice(1)) {
    if (node.value === undefined) problems.push({ message: `<${node.tag}> is never closed`, line: node.line })
  }
  return { root, problems }
}

/**
 * Tags that are always leaves in the OFX specification, within the message sets this reader understands. Only
 * these are taken as an empty leaf when nothing follows them. An unknown tag with nothing after it is still
 * taken as an element, because flattening an aggregate this reader does not know — an investment section,
 * say — would be the worse mistake.
 */
const LEAVES: ReadonlySet<string> = new Set([
  // Transactions
  'TRNTYPE', 'DTPOSTED', 'DTUSER', 'DTAVAIL', 'TRNAMT', 'FITID', 'CORRECTFITID', 'CORRECTACTION', 'SRVRTID',
  'CHECKNUM', 'REFNUM', 'SIC', 'PAYEEID', 'NAME', 'MEMO', 'CURRATE', 'CURSYM',
  // Payee address lines
  'ADDR1', 'ADDR2', 'ADDR3', 'CITY', 'STATE', 'POSTALCODE', 'COUNTRY', 'PHONE',
  // Accounts, lists and balances
  'BANKID', 'BRANCHID', 'ACCTID', 'ACCTTYPE', 'ACCTKEY', 'CURDEF', 'DTSTART', 'DTEND', 'BALAMT', 'DTASOF',
  // Sign-on and status
  'CODE', 'SEVERITY', 'MESSAGE', 'DTSERVER', 'LANGUAGE', 'DTPROFUP', 'DTACCTUP', 'ORG', 'FID', 'TRNUID',
  'INTU.BID', 'INTU.USERID'
])

// ---- Reading the tree ---------------------------------------------------------------------------

/** The first child with this tag, at any depth below `node`, in document order. */
export function find(node: OfxNode | undefined, ...tags: string[]): OfxNode | undefined {
  if (node === undefined) return undefined
  let at: OfxNode | undefined = node
  for (const tag of tags) {
    at = at.children.find(child => child.tag === tag)
    if (at === undefined) return undefined
  }
  return at
}

/** Every descendant with this tag, at any depth. */
export function findAll(node: OfxNode | undefined, tag: string): OfxNode[] {
  if (node === undefined) return []
  const found: OfxNode[] = []
  const visit = (at: OfxNode) => {
    for (const child of at.children) {
      if (child.tag === tag) found.push(child)
      else visit(child)
    }
  }
  visit(node)
  return found
}

/** The first descendant with this tag, at any depth. */
export function findDeep(node: OfxNode | undefined, tag: string): OfxNode | undefined {
  return findAll(node, tag)[0]
}

/** A leaf's text, or undefined when the tag is absent or holds nothing. */
export function text(node: OfxNode | undefined, ...tags: string[]): string | undefined {
  const found = tags.length === 0 ? node : find(node, ...tags)
  const value = found?.value?.trim()
  return value === undefined || value === '' ? undefined : value
}

// The file as a flat stream of tokens that reassembles to exactly the bytes it came from.
//
// `tokenizer.ts` reads an OFX file for *meaning*: a tree, values entity-decoded and trimmed, whitespace gone.
// The anonymiser needs the opposite — the file's own layout, line endings and indentation, so that its output
// has the structure of its input and nothing else — so this is the same grammar read for *layout*. Every
// character of the source lands in exactly one token, and `detokenizeLayout(tokenizeLayout(text)) === text`
// is a property the tests hold over every committed fixture.
//
// A leaf's value is a token of its own, carrying the leaf's tag and the path of elements above it, which is
// what lets a policy be applied by tag. The whitespace around it is kept in `space` tokens, so replacing the
// value never disturbs the layout.

export type LayoutToken =
  /** One `KEY:VALUE` line of an OFX 1.x header, without its line ending. */
  | { kind: 'header', key: string, value: string, raw: string }
  /** `<?xml …?>`, `<?OFX …?>`, a comment, a DOCTYPE: kept as written. */
  | { kind: 'prolog', raw: string }
  /** `<TAG>`, `<TAG attr="x">` or `<TAG/>`. */
  | { kind: 'open', tag: string, raw: string, selfClosing: boolean }
  /** `</TAG>`. */
  | { kind: 'close', tag: string, raw: string }
  /** A leaf's text as written — entities not decoded, surrounding whitespace in the neighbouring `space` tokens. */
  | { kind: 'value', tag: string, path: string[], raw: string }
  /** Text between tags that is not a leaf's value: a stray character, text after a closing tag. */
  | { kind: 'stray', raw: string }
  /** Whitespace and line endings. */
  | { kind: 'space', raw: string }

/** The tag name of `<NAME attr="x">` or `</NAME>`: up to the first space, slash or `>`, upper-cased. */
function nameOf(source: string, from: number): string {
  let at = from
  while (at < source.length && !/[\s/>]/.test(source[at])) at += 1
  return source.slice(from, at).toUpperCase()
}

export function tokenizeLayout(source: string): LayoutToken[] {
  const tokens: LayoutToken[] = []
  const space = (raw: string) => { if (raw !== '') tokens.push({ kind: 'space', raw }) }

  // ---- the header: `KEY:VALUE` lines before the first tag (OFX 1.x), or nothing (2.x)
  const firstTag = source.indexOf('<')
  const headEnd = firstTag === -1 ? source.length : firstTag
  let at = 0
  while (at < headEnd) {
    const lineEnd = source.indexOf('\n', at)
    const end = lineEnd === -1 || lineEnd >= headEnd ? headEnd : lineEnd + 1
    const line = source.slice(at, end)
    const body = line.replace(/\r?\n$/, '')
    const ending = line.slice(body.length)
    const match = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(body)
    if (match !== null) {
      tokens.push({ kind: 'header', key: match[1], value: match[2], raw: body })
    } else if (body.trim() === '') {
      space(body)
    } else {
      tokens.push({ kind: 'stray', raw: body })
    }
    space(ending)
    at = end
  }
  if (firstTag === -1) return tokens

  // ---- the tree
  const stack: { tag: string, leaf: boolean }[] = []
  /** A leaf stays on the stack only until the next tag; an element until its closing tag. */
  const closeOpenLeaf = () => {
    const top = stack[stack.length - 1]
    if (top !== undefined && top.leaf) stack.pop()
  }
  const pathNow = () => stack.filter(entry => !entry.leaf).map(entry => entry.tag)

  /** The text between two tags: leading space, the text itself, trailing space. */
  const between = (from: number, to: number, asValueOf: string | undefined) => {
    const text = source.slice(from, to)
    const leading = text.length - text.trimStart().length
    const trailing = text.length - text.trimEnd().length
    if (text.trim() === '') { space(text); return }
    space(text.slice(0, leading))
    const body = text.slice(leading, text.length - trailing)
    if (asValueOf !== undefined) tokens.push({ kind: 'value', tag: asValueOf, path: pathNow(), raw: body })
    else tokens.push({ kind: 'stray', raw: body })
    space(text.slice(text.length - trailing))
  }

  at = firstTag
  while (at < source.length) {
    const next = source[at + 1]

    if (next === '!' || next === '?') {
      let end = source.startsWith('<!--', at) ? source.indexOf('-->', at + 4) : source.indexOf('>', at)
      end = end === -1 ? source.length : end + (source.startsWith('<!--', at) ? 3 : 1)
      tokens.push({ kind: 'prolog', raw: source.slice(at, end) })
      const following = source.indexOf('<', end)
      between(end, following === -1 ? source.length : following, undefined)
      at = following === -1 ? source.length : following
      continue
    }

    if (next === '/') {
      const tag = nameOf(source, at + 2)
      const close = source.indexOf('>', at)
      const end = close === -1 ? source.length : close + 1
      tokens.push({ kind: 'close', tag, raw: source.slice(at, end) })
      // Closes tags until one named `tag` has gone, a dangling leaf included; a close that matches nothing
      // leaves the stack alone, as the reader does
      const found = [...stack].reverse().findIndex(entry => entry.tag === tag)
      if (found !== -1) stack.splice(stack.length - 1 - found)
      const following = source.indexOf('<', end)
      between(end, following === -1 ? source.length : following, undefined)
      at = following === -1 ? source.length : following
      continue
    }

    if (next === undefined || !/[A-Za-z]/.test(next)) {
      // A stray `<` in a value
      const following = source.indexOf('<', at + 1)
      tokens.push({ kind: 'stray', raw: source.slice(at, following === -1 ? source.length : following) })
      at = following === -1 ? source.length : following
      continue
    }

    const tag = nameOf(source, at + 1)
    const close = source.indexOf('>', at)
    if (close === -1) {
      tokens.push({ kind: 'stray', raw: source.slice(at) })
      break
    }
    const selfClosing = source[close - 1] === '/'
    tokens.push({ kind: 'open', tag, raw: source.slice(at, close + 1), selfClosing })
    closeOpenLeaf()

    const following = source.indexOf('<', close + 1)
    const textEnd = following === -1 ? source.length : following
    if (selfClosing) {
      between(close + 1, textEnd, undefined)
    } else if (source.slice(close + 1, textEnd).trim() === '') {
      // An element: what follows is another tag
      stack.push({ tag, leaf: false })
      between(close + 1, textEnd, undefined)
    } else {
      stack.push({ tag, leaf: true })
      between(close + 1, textEnd, tag)
    }
    at = textEnd
  }
  return tokens
}

/** The tokens back as text: exactly the source they came from, when nothing has been changed. */
export function detokenizeLayout(tokens: readonly LayoutToken[]): string {
  return tokens.map(token => token.raw).join('')
}

/** A value as it is written into a leaf: the characters the grammar reserves, escaped. */
export function escapeValue(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

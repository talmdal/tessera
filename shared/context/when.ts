// shared/context/when.ts
import { ContextKeyValue } from "@tessera/types"
//
// Boolean expressions over context keys, used for command enablement:
//
//   vault.isOpen && vault.isDirty
//   !vault.isReadOnly || (vault.mode == 'admin')
//
// A bare key is true when its value is truthy. `==` and `!=` compare a key
// with a string, number or boolean literal. Operators, loosest first: ||, &&, !


export type WhenExpression =
  | { type: 'key', key: string }
  | { type: 'compare', key: string, op: '==' | '!=', value: ContextKeyValue }
  | { type: 'not', operand: WhenExpression }
  | { type: 'and' | 'or', left: WhenExpression, right: WhenExpression }

type Token =
  | { kind: 'op', text: '||' | '&&' | '==' | '!=' | '!' | '(' | ')' }
  | { kind: 'literal', value: ContextKeyValue }
  | { kind: 'key', text: string }

const TOKEN = /\s*(?:(\|\||&&|==|!=|!|\(|\))|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w.-]*))/y

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  TOKEN.lastIndex = 0

  while (TOKEN.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(TOKEN.lastIndex))) break
    const at = TOKEN.lastIndex
    const match = TOKEN.exec(source)
    if (!match) throw new Error(`unexpected character at ${at}`)

    const [, op, str, num, word] = match
    if (op) tokens.push({ kind: 'op', text: op as Extract<Token, { kind: 'op' }>['text'] })
    else if (str) tokens.push({ kind: 'literal', value: str.slice(1, -1).replace(/\\(.)/g, '$1') })
    else if (num) tokens.push({ kind: 'literal', value: Number(num) })
    else if (word === 'true' || word === 'false') tokens.push({ kind: 'literal', value: word === 'true' })
    else tokens.push({ kind: 'key', text: word })
  }

  return tokens
}

/** Parses an expression. Throws with a description of the problem if it is invalid. */
export function parseWhen(source: string): WhenExpression {
  let tokens: Token[]
  try {
    tokens = tokenize(source)
  } catch (err) {
    throw new Error(`Invalid expression "${source}": ${(err as Error).message}`)
  }

  let pos = 0
  const fail = (message: string): never => { throw new Error(`Invalid expression "${source}": ${message}`) }
  const peekOp = (text: string) => tokens[pos]?.kind === 'op' && (tokens[pos] as { text: string }).text === text

  const parseOr = (): WhenExpression => {
    let left = parseAnd()
    while (peekOp('||')) { pos++; left = { type: 'or', left, right: parseAnd() } }
    return left
  }

  const parseAnd = (): WhenExpression => {
    let left = parseUnary()
    while (peekOp('&&')) { pos++; left = { type: 'and', left, right: parseUnary() } }
    return left
  }

  const parseUnary = (): WhenExpression => {
    if (peekOp('!')) { pos++; return { type: 'not', operand: parseUnary() } }
    if (peekOp('(')) {
      pos++
      const inner = parseOr()
      if (!peekOp(')')) fail('missing ")"')
      pos++
      return inner
    }

    const token = tokens[pos++]
    if (token?.kind !== 'key') return fail(token ? 'expected a context key' : 'unexpected end')

    if (peekOp('==') || peekOp('!=')) {
      const op = (tokens[pos++] as { text: '==' | '!=' }).text
      const value = tokens[pos++]
      if (value?.kind !== 'literal') fail(`expected a value after ${op}`)
      return { type: 'compare', key: token.text, op, value: (value as { value: ContextKeyValue }).value }
    }

    return { type: 'key', key: token.text }
  }

  if (tokens.length === 0) fail('empty')
  const expression = parseOr()
  if (pos < tokens.length) fail('unexpected trailing input')
  return expression
}

export function evaluateWhen(
  expression: WhenExpression,
  get: (key: string) => ContextKeyValue | undefined
): boolean {
  switch (expression.type) {
    case 'key': return Boolean(get(expression.key))
    case 'compare': return (get(expression.key) === expression.value) === (expression.op === '==')
    case 'not': return !evaluateWhen(expression.operand, get)
    case 'and': return evaluateWhen(expression.left, get) && evaluateWhen(expression.right, get)
    case 'or': return evaluateWhen(expression.left, get) || evaluateWhen(expression.right, get)
  }
}

import { describe, it, expect } from 'vitest'
import { ContextKeyValue, evaluateWhen, parseWhen } from '../../shared/context/when'

const evaluate = (source: string, keys: Record<string, ContextKeyValue> = {}) =>
  evaluateWhen(parseWhen(source), key => keys[key])

describe('when expressions', () => {
  it('treats a bare key as its truthiness', () => {
    expect(evaluate('vault.isOpen', { 'vault.isOpen': true })).toBe(true)
    expect(evaluate('vault.isOpen')).toBe(false)
    expect(evaluate('vault.count', { 'vault.count': 0 })).toBe(false)
    expect(evaluate('vault.name', { 'vault.name': 'home' })).toBe(true)
  })

  it('supports !, && and || with && binding tighter than ||', () => {
    const keys = { a: true, b: false, c: true }

    expect(evaluate('!b', keys)).toBe(true)
    expect(evaluate('a && b', keys)).toBe(false)
    expect(evaluate('a && b || c', keys)).toBe(true)
    expect(evaluate('a && (b || c)', keys)).toBe(true)
    expect(evaluate('!(a && c)', keys)).toBe(false)
    expect(evaluate('b || b && c', keys)).toBe(false)
  })

  it('compares keys with string, number and boolean literals', () => {
    const keys = { 'vault.mode': 'admin', 'vault.count': 3, 'vault.readOnly': false }

    expect(evaluate(`vault.mode == 'admin'`, keys)).toBe(true)
    expect(evaluate(`vault.mode != "admin"`, keys)).toBe(false)
    expect(evaluate('vault.count == 3', keys)).toBe(true)
    expect(evaluate('vault.readOnly == false', keys)).toBe(true)
    expect(evaluate(`missing != 'x'`, keys)).toBe(true)
  })

  it('accepts dashed plugin ids and escaped quotes', () => {
    expect(evaluate('bank-import.isRunning', { 'bank-import.isRunning': true })).toBe(true)
    expect(evaluate(`name == 'it\\'s'`, { name: `it's` })).toBe(true)
  })

  it('rejects malformed expressions', () => {
    for (const source of ['', '   ', 'a &&', '&& a', '(a', 'a b', 'a == ', 'a == b', `'x'`, 'a = 1', 'a @ b']) {
      expect(() => parseWhen(source), source).toThrow(/^Invalid expression/)
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  GENERIC_FAMILIES, MAX_FAMILY_NAMES, MAX_FAMILY_NAME_LENGTH, cssFontFamily, familyListProblem, isFontFamilyName
} from '../../shared/fonts/families'
import { FONT_STACK } from '../../shared/fonts/roles'

describe('isFontFamilyName', () => {
  it.each([
    'Inter', 'Segoe UI', 'Segoe UI Variable', 'Noto Sans CJK JP', 'M+ 1p', 'Font Awesome 6 Free', 'Source_Code.Pro',
    'Baskerville Old Face', "Mom's Typewriter", 'Q&A Sans', '思源黑体', 'Times New Roman', 'Cascadia Mono', 'serif'
  ])('accepts %j', name => {
    expect(isFontFamilyName(name)).toBe(true)
  })

  it.each([
    ['a quote that would end the quoted name', 'Arial" ; color: red'],
    ['a declaration ending and a new rule', 'Arial; } body { display: none'],
    ['a block', 'Arial{'],
    ['a url', 'url(https://example.com/x.woff2)'],
    ['a second family smuggled in', 'Arial, Comic Sans MS'],
    ['a backslash escape', 'Ar\\69 al'],
    ['an at-rule', '@import x'],
    ['a comment', 'Arial /* x */'],
    ['a colon', 'a:b'],
    ['angle brackets', '<script>'],
    ['a newline', 'Arial\nx'],
    ['a tab', 'Arial\tx'],
    ['spaces around it', ' Arial'],
    ['nothing', ''],
    ['only spaces', '   '],
    ['too long', 'x'.repeat(MAX_FAMILY_NAME_LENGTH + 1)]
  ])('refuses %s', (_why, name) => {
    expect(isFontFamilyName(name)).toBe(false)
  })

  it('refuses each character that could break out of a quoted name or a declaration, on its own', () => {
    // One at a time, so that letting any single one through fails this test. (An apostrophe is allowed: names are
    // written in double quotes.)
    for (const char of ['"', '\\', ';', '{', '}', '(', ')', ',', ':', '/', '<', '>', '@', '*', '\u0000', '\u007f', '`', '!', '#', '$', '%', '=', '[', ']', '|', '~', '?']) {
      expect({ char, accepted: isFontFamilyName(`Ar${char}ial`) }).toEqual({ char, accepted: false })
    }
  })

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 12, ['Arial'], { name: 'Arial' }]) expect(isFontFamilyName(value)).toBe(false)
  })

  it('accepts a name of the longest length allowed', () => {
    expect(isFontFamilyName('x'.repeat(MAX_FAMILY_NAME_LENGTH))).toBe(true)
  })
})

describe('familyListProblem', () => {
  it('accepts a list of one or more valid names', () => {
    expect(familyListProblem(['Inter'])).toBeUndefined()
    expect(familyListProblem(['Georgia', 'Cambria', 'serif'])).toBeUndefined()
    expect(familyListProblem(Array.from({ length: MAX_FAMILY_NAMES }, (_, i) => `Font ${i}`))).toBeUndefined()
  })

  it('says what is wrong with a list that cannot be used', () => {
    expect(familyListProblem('Inter')).toBe('must be a list of font names')
    expect(familyListProblem(null)).toBe('must be a list of font names')
    expect(familyListProblem([])).toBe('must name at least one font')
    expect(familyListProblem(Array.from({ length: MAX_FAMILY_NAMES + 1 }, (_, i) => `Font ${i}`))).toBe(`names more than ${MAX_FAMILY_NAMES} fonts`)
    expect(familyListProblem(['Inter', 'Arial;}'])).toBe('has "Arial;}", which isn\'t a font name')
    expect(familyListProblem(['Inter', 3])).toBe('has something that isn\'t a font name')
  })
})

describe('cssFontFamily', () => {
  it('quotes every name and ends with the fallback, which is used as it is', () => {
    expect(cssFontFamily(['Inter'], FONT_STACK)).toBe(`"Inter", ${FONT_STACK}`)
    expect(cssFontFamily(['Iosevka Term', 'Cascadia Mono'], 'monospace')).toBe('"Iosevka Term", "Cascadia Mono", monospace')
  })

  it('writes generic families unquoted and in lower case, since quoted they would name a font', () => {
    expect(cssFontFamily(['Georgia', 'Serif'], FONT_STACK)).toBe(`"Georgia", serif, ${FONT_STACK}`)
    for (const generic of GENERIC_FAMILIES) expect(cssFontFamily([generic.toUpperCase()], 'x')).toBe(`${generic}, x`)
  })

  it('gives just the fallback for no names', () => {
    expect(cssFontFamily([], FONT_STACK)).toBe(FONT_STACK)
  })

  it('throws rather than write a name that was not checked', () => {
    expect(() => cssFontFamily(['Arial"; }'], FONT_STACK)).toThrow(/Not a font family name/)
  })
})

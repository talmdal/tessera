import { describe, expect, it } from 'vitest'
import type { FontSettings, ThemeFonts } from '@tessera/types'
import {
  BASE_FONT_SIZE, FONT_ROLES, FONT_ROLE_IDS, FONT_STACK, FONT_WEIGHTS, MONO_STACK, describeThemeFonts, fontRole, fontSpecProblems, isFontRoleId
} from '../../shared/fonts/roles'
import { resolveThemes } from '../../shared/theme/resolveThemes'
import { DEFAULT_FONT_SETTINGS, isChosen, resolveFonts } from '../../shared/fonts/resolveFonts'

/** The user's settings: the defaults with some roles changed. */
function settings(roles: { [K in keyof FontSettings['roles']]?: Partial<FontSettings['roles'][K]> } = {}, useThemeFonts = true): FontSettings {
  const merged = Object.fromEntries(Object.entries(DEFAULT_FONT_SETTINGS.roles).map(([id, values]) =>
    [id, { ...values, ...(roles as Record<string, object>)[id] }]))
  return { useThemeFonts, roles: merged as FontSettings['roles'] }
}

describe('the font roles', () => {
  it('are the six kinds of text, in the order the Fonts page lists them', () => {
    expect(FONT_ROLE_IDS).toEqual(['ui', 'heading', 'small', 'table', 'numeric', 'monospace'])
    expect(FONT_ROLES.map(r => r.label)).toEqual([
      'Interface text', 'Headings', 'Small text', 'Tables and registers', 'Amounts and figures', 'Fixed-width text'
    ])
    expect(isFontRoleId('table')).toBe(true)
    expect(isFontRoleId('register')).toBe(false)
    expect(() => fontRole('register' as never)).toThrow(/Unknown font role/)
  })

  it('let each role be set only where that means something', () => {
    expect(Object.fromEntries(FONT_ROLES.map(r => [r.id, r.facets]))).toEqual({
      ui: ['family', 'size', 'weight'],
      heading: ['family', 'weight'],
      small: ['family', 'size'],
      table: ['family', 'size'],
      numeric: ['family'],
      monospace: ['family', 'size']
    })
  })

  it('have a size range exactly when they have a size, and a theme may choose only within what the user may', () => {
    for (const role of FONT_ROLES) {
      expect(role.size !== undefined).toBe(role.facets.includes('size'))
      if (!role.size) continue
      expect(role.size.theme.min).toBeGreaterThanOrEqual(role.size.user.min)
      expect(role.size.theme.max).toBeLessThanOrEqual(role.size.user.max)
      expect(role.size.user.min).toBeLessThan(role.size.user.max)
    }
    expect(fontRole('ui').size).toMatchObject({ user: { min: 11, max: 24 }, theme: { min: 12, max: 16 } })
  })

  it('have default settings that list each role with its own facets, all Automatic, and theme fonts on', () => {
    expect(DEFAULT_FONT_SETTINGS.useThemeFonts).toBe(true)
    for (const role of FONT_ROLES) {
      expect(Object.keys(DEFAULT_FONT_SETTINGS.roles[role.id]).sort()).toEqual([...role.facets].sort())
      expect(Object.values(DEFAULT_FONT_SETTINGS.roles[role.id]).every(v => v === null)).toBe(true)
    }
    expect(Object.isFrozen(DEFAULT_FONT_SETTINGS.roles.ui)).toBe(true)
  })

  it('offer four weights', () => {
    expect(FONT_WEIGHTS.map(w => `${w.weight} ${w.label}`)).toEqual(['400 Regular', '500 Medium', '600 Semibold', '700 Bold'])
  })
})

describe('fontSpecProblems', () => {
  it('accepts what the role allows, and Automatic (null or absent)', () => {
    expect(fontSpecProblems('ui', { family: ['Inter'], size: 15, weight: 500 }, 'user')).toEqual([])
    expect(fontSpecProblems('heading', { family: ['Georgia', 'serif'], weight: 600 }, 'theme')).toEqual([])
    expect(fontSpecProblems('numeric', { family: null }, 'user')).toEqual([])
    expect(fontSpecProblems('table', {}, 'theme')).toEqual([])
  })

  it('gives the theme a narrower size range than the user', () => {
    expect(fontSpecProblems('ui', { size: 20 }, 'user')).toEqual([])
    expect(fontSpecProblems('ui', { size: 20 }, 'theme')).toEqual(['Interface text: choose a size from 12 to 16 px.'])
    expect(fontSpecProblems('small', { size: 9 }, 'theme')).toEqual(['Small text: choose a size from 10 to 14 px.'])
    expect(fontSpecProblems('small', { size: 9 }, 'user')).toEqual([])
  })

  it('refuses sizes that are not whole pixels in range', () => {
    for (const size of [10, 25, 13.5, '13', NaN, Infinity]) {
      expect(fontSpecProblems('ui', { size }, 'user')).toEqual(['Interface text: choose a size from 11 to 24 px.'])
    }
  })

  it('refuses a facet the role does not have, and anything that is not a facet', () => {
    expect(fontSpecProblems('numeric', { size: 14 }, 'user')).toEqual(["Amounts and figures: its size can't be set."])
    expect(fontSpecProblems('heading', { size: 20 }, 'theme')).toEqual(["Headings: its size can't be set."])
    expect(fontSpecProblems('table', { weight: 700 }, 'user')).toEqual(["Tables and registers: its weight can't be set."])
    expect(fontSpecProblems('ui', { colour: 'red' }, 'theme')).toEqual(['Interface text: "colour" isn\'t something a font has.'])
  })

  it('refuses weights that are not offered, and families that cannot be used', () => {
    expect(fontSpecProblems('ui', { weight: 450 }, 'user')).toEqual(['Interface text: choose Regular, Medium, Semibold or Bold.'])
    expect(fontSpecProblems('ui', { weight: 'bold' }, 'user')).toEqual(['Interface text: choose Regular, Medium, Semibold or Bold.'])
    expect(fontSpecProblems('ui', { family: 'Inter' }, 'user')).toEqual(['Interface text: the font must be a list of font names.'])
    expect(fontSpecProblems('monospace', { family: ['x;}'] }, 'theme')).toEqual(['Fixed-width text: the font has "x;}", which isn\'t a font name.'])
  })

  it('reports every problem, and refuses what is not an object', () => {
    expect(fontSpecProblems('ui', { size: 99, weight: 1 }, 'user')).toHaveLength(2)
    expect(fontSpecProblems('ui', ['Inter'], 'user')).toEqual(['Interface text: must be an object.'])
    expect(fontSpecProblems('ui', null, 'user')).toEqual(['Interface text: must be an object.'])
  })
})

describe('resolveFonts', () => {
  it("gives the shell's own fonts when nobody sets any: what the shell drew before font roles", () => {
    const fonts = resolveFonts()

    expect(fonts.ui).toEqual({
      id: 'ui', fontFamily: FONT_STACK, primary: undefined, size: BASE_FONT_SIZE, weight: 400,
      sources: { family: 'shell', size: 'shell', weight: 'shell' }
    })
    expect(fonts.heading).toMatchObject({ fontFamily: FONT_STACK, weight: undefined, sources: { family: 'inherited', weight: 'shell' } })
    // MUI's caption is 12/14 of its body size
    expect(fonts.small).toMatchObject({ fontFamily: FONT_STACK, size: 11.14, sources: { family: 'inherited', size: 'inherited' } })
    expect(fonts.table).toMatchObject({ fontFamily: FONT_STACK, size: 13, sources: { family: 'inherited', size: 'inherited' } })
    expect(fonts.numeric).toEqual({ id: 'numeric', fontFamily: undefined, primary: undefined, sources: { family: 'inherited' } })
    expect(fonts.monospace).toMatchObject({ fontFamily: MONO_STACK, size: 13, sources: { family: 'shell', size: 'inherited' } })
    expect(Object.values(fonts).flatMap(r => Object.values(r.sources)).some(isChosen)).toBe(false)
  })

  it("resolves the design note's worked example", () => {
    // docs/font-roles-design.md#resolution-who-wins
    const sunrise: ThemeFonts = { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } }
    const user = settings({ ui: { family: ['Inter'] }, table: { size: 15 }, numeric: { family: ['Cascadia Mono'] } })
    const inter = `"Inter", ${FONT_STACK}`

    const fonts = resolveFonts(user, sunrise)

    expect(fonts.ui).toMatchObject({ fontFamily: inter, primary: 'Inter', size: 14, weight: 400, sources: { family: 'user', size: 'theme', weight: 'shell' } })
    // The theme set headings explicitly, so they stay Georgia although the user changed Interface text
    expect(fonts.heading).toMatchObject({ fontFamily: `"Georgia", serif, ${inter}`, primary: 'Georgia', sources: { family: 'theme' } })
    expect(fonts.small).toMatchObject({ fontFamily: inter, primary: 'Inter', size: 12, sources: { family: 'inherited', size: 'inherited' } })
    expect(fonts.table).toMatchObject({ fontFamily: inter, size: 15, sources: { family: 'inherited', size: 'user' } })
    expect(fonts.numeric).toMatchObject({ fontFamily: `"Cascadia Mono", ${inter}`, primary: 'Cascadia Mono', sources: { family: 'user' } })
    expect(fonts.monospace).toMatchObject({ fontFamily: MONO_STACK, size: 14, sources: { family: 'shell', size: 'inherited' } })
  })

  it('resolves a contributed theme, once the shell has checked it, the same way', () => {
    const { themes, diagnostics } = resolveThemes([{ contributor: 'p', impl: {
      id: 'p.sunrise', label: 'Sunrise', light: {}, fonts: { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } }
    } }])
    expect(diagnostics).toEqual([])

    const fonts = resolveFonts(settings({ ui: { family: ['Inter'] } }), themes[1].fonts)

    expect(fonts.heading).toMatchObject({ primary: 'Georgia', sources: { family: 'theme' } })
    expect(fonts.ui).toMatchObject({ primary: 'Inter', size: 14, sources: { family: 'user', size: 'theme' } })
  })

  it('describes what a theme sets, role by role, for the pages that choose themes and fonts', () => {
    expect(describeThemeFonts(undefined)).toEqual([])
    expect(describeThemeFonts({})).toEqual([])
    expect(describeThemeFonts({ numeric: { family: ['Cascadia Mono'] }, heading: { family: ['Georgia', 'serif'], weight: 600 }, ui: { size: 14 } }))
      .toEqual(['Interface text (14 px)', 'Headings (Georgia, Semibold)', 'Amounts and figures (Cascadia Mono)'])
    // Something a theme couldn't have passed is left out
    expect(describeThemeFonts({ ui: { size: 30 } })).toEqual([])
  })

  it('ignores the theme entirely when the user turned theme fonts off', () => {
    const sunrise: ThemeFonts = { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } }

    const fonts = resolveFonts(settings({ ui: { family: ['Inter'] } }, false), sunrise)

    expect(fonts.ui).toMatchObject({ size: 13, sources: { size: 'shell' } })
    expect(fonts.heading).toMatchObject({ fontFamily: `"Inter", ${FONT_STACK}`, sources: { family: 'inherited' } })
  })

  it("lets the user's choice beat the theme's, role by role and facet by facet", () => {
    const theme: ThemeFonts = { ui: { family: ['Georgia'], size: 15, weight: 500 } }

    const fonts = resolveFonts(settings({ ui: { size: 18 } }), theme)

    expect(fonts.ui).toMatchObject({ primary: 'Georgia', size: 18, weight: 500, sources: { family: 'theme', size: 'user', weight: 'theme' } })
  })

  it('scales the automatic sizes with the interface size', () => {
    const fonts = resolveFonts(settings({ ui: { size: 20 } }))

    expect(fonts.small.size).toBe(17.14)
    expect(fonts.table.size).toBe(20)
    expect(fonts.monospace.size).toBe(20)
  })

  it('uses weights for Headings and Interface text when set', () => {
    const fonts = resolveFonts(settings({ ui: { weight: 500 }, heading: { weight: 700 } }))

    expect(fonts.ui).toMatchObject({ weight: 500, sources: { weight: 'user' } })
    expect(fonts.heading).toMatchObject({ weight: 700, sources: { weight: 'user' } })
  })

  it('falls back from a chosen fixed-width font to the fixed-width stack, not the interface font', () => {
    expect(resolveFonts(settings({ monospace: { family: ['Iosevka'] } })).monospace.fontFamily).toBe(`"Iosevka", ${MONO_STACK}`)
  })

  it('ignores values that would not pass the checks, so nothing unchecked reaches a stylesheet', () => {
    const hostile = settings({
      ui: { family: ['Arial; } body { display: none'], size: 99, weight: 450 as never },
      numeric: { family: 'Inter' as never }
    })
    const theme = { table: { size: 30 }, heading: { family: ['x"y'] }, small: { size: 13.5 } } as ThemeFonts

    expect(resolveFonts(hostile, theme)).toEqual(resolveFonts())
  })

  it("holds a theme to a theme's range, and the user to the user's", () => {
    expect(resolveFonts(settings(), { ui: { size: 20 } }).ui).toMatchObject({ size: 13, sources: { size: 'shell' } })
    expect(resolveFonts(settings({ ui: { size: 20 } })).ui).toMatchObject({ size: 20, sources: { size: 'user' } })
  })

  it('ignores facets a role does not have, roles it does not know, and settings of the wrong shape', () => {
    const odd = { useThemeFonts: true, roles: { numeric: { family: null, size: 20 }, register: { size: 15 } } } as unknown as FontSettings

    expect(resolveFonts(odd, { heading: { size: 30 } } as ThemeFonts)).toEqual(resolveFonts())
    expect(resolveFonts({} as FontSettings)).toEqual(resolveFonts())
  })
})

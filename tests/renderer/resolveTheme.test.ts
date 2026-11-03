import { describe, it, expect } from 'vitest'
import type { ThemeDescriptor } from '@tessera/types'
import { BUILT_IN, createThemeResolver, resolveTheme } from '../../shell/renderer/theme/resolveTheme'

const descriptor = (extra: Partial<ThemeDescriptor> = {}): ThemeDescriptor =>
  ({ id: 'p.x', label: 'X', pluginId: 'p', schemes: ['dark'], dark: { palette: { primary: { main: '#ff7518' } } }, ...extra })

describe('resolveTheme', () => {
  it('builds the descriptor\'s scheme over the shell\'s base', () => {
    const { theme, themeId, problem } = resolveTheme(descriptor({ common: { shape: { borderRadius: 9 } } }), 'dark')
    expect(problem).toBeUndefined()
    expect(themeId).toBe('p.x')
    expect(theme.palette.mode).toBe('dark')
    expect(theme.palette.primary.main).toBe('#ff7518')
    expect(theme.shape.borderRadius).toBe(9)
    expect(theme.typography.fontSize).toBe(13)                 // the base is still there
    expect(theme.tessera.finance.credit).toBe(theme.palette.success.main)
  })

  it('uses the scheme a theme has when asked for the one it lacks, in the requested mode', () => {
    const { theme } = resolveTheme(descriptor(), 'light')
    expect(theme.palette.mode).toBe('light')
    expect(theme.palette.primary.main).toBe('#ff7518')
  })

  it('is the shell\'s theme when there is no descriptor', () => {
    const { theme, themeId } = resolveTheme(undefined, 'light')
    expect(themeId).toBe('shell.default')
    expect(theme.palette.mode).toBe('light')
    expect(resolveTheme(BUILT_IN, 'dark').themeId).toBe('shell.default')
  })

  it('falls back to the shell\'s theme, naming the problem, when the options cannot be built', () => {
    const broken = descriptor({ dark: { palette: { primary: { main: 'not a colour' } } } })
    const { theme, themeId, problem } = resolveTheme(broken, 'dark')
    expect(themeId).toBe('shell.default')
    expect(problem).toMatch(/Theme "X" \(p\) could not be used/)
    expect(theme.palette.mode).toBe('dark')
  })

  it('falls back when text would be unreadable on the background, or the type size is absurd', () => {
    const invisible = descriptor({ dark: { palette: { background: { default: '#202020' }, text: { primary: '#242424' } } } })
    expect(resolveTheme(invisible, 'dark')).toMatchObject({ themeId: 'shell.default', problem: expect.stringMatching(/unreadable/) })
    const huge = descriptor({ common: { typography: { fontSize: 200 } } })
    expect(resolveTheme(huge, 'dark')).toMatchObject({ themeId: 'shell.default', problem: expect.stringMatching(/font size 200/) })
  })
})

describe('createThemeResolver', () => {
  it('returns the same built theme for the same descriptor and scheme, and a new one when either changes', () => {
    const resolve = createThemeResolver()
    const a = resolve(descriptor(), 'dark')
    expect(resolve(descriptor(), 'dark')).toBe(a)                       // a structurally equal descriptor hits
    expect(resolve(descriptor(), 'light')).not.toBe(a)
    expect(resolve(descriptor({ label: 'Y' }), 'dark')).not.toBe(a)
    expect(resolve(undefined, 'dark')).toBe(resolve(undefined, 'dark'))
  })

  it('forgets the oldest beyond its capacity', () => {
    const resolve = createThemeResolver(2)
    const a = resolve(descriptor({ id: 'a' }), 'dark')
    resolve(descriptor({ id: 'b' }), 'dark')
    resolve(descriptor({ id: 'c' }), 'dark')
    expect(resolve(descriptor({ id: 'a' }), 'dark')).not.toBe(a)
  })
})

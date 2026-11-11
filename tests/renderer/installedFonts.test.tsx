import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FONTS_FAMILIES } from '../../shared/fonts/types'
import { InstalledFontsProvider, createIpcFontSource, useInstalledFonts } from '../../shell/renderer/fonts/InstalledFonts'

function Probe({ id = 'p' }: { id?: string }) {
  const fonts = useInstalledFonts()
  return <span data-testid={id}>{fonts.loading ? 'loading' : `${fonts.complete}:${fonts.families.join(',')}`}</span>
}

describe('the installed fonts in a window', () => {
  it('asks the main process for them only when a page wants them, and once however many ask', async () => {
    const families = vi.fn(async () => ({ families: ['Inter'], complete: true }))
    const { rerender } = render(<InstalledFontsProvider source={{ families }}><span /></InstalledFontsProvider>)
    expect(families).not.toHaveBeenCalled()

    rerender(<InstalledFontsProvider source={{ families }}><Probe id="a" /><Probe id="b" /></InstalledFontsProvider>)
    expect(screen.getByTestId('a')).toHaveTextContent('loading')
    await act(async () => {})

    expect(screen.getByTestId('a')).toHaveTextContent('true:Inter')
    expect(screen.getByTestId('b')).toHaveTextContent('true:Inter')
    expect(families).toHaveBeenCalledTimes(1)
  })

  it('treats a failed request as "not available"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<InstalledFontsProvider source={{ families: async () => { throw new Error('gone') } }}><Probe /></InstalledFontsProvider>)
    await act(async () => {})

    expect(screen.getByTestId('p')).toHaveTextContent('false:')
    vi.mocked(console.error).mockRestore()
  })

  it('is "not available", and not loading, outside a provider', () => {
    render(<Probe />)
    expect(screen.getByTestId('p')).toHaveTextContent('false:')
  })

  it('asks over shell:fonts.families', async () => {
    const invoke = vi.fn(async () => ({ families: [], complete: false }))
    await createIpcFontSource({ invoke } as any).families()
    expect(invoke).toHaveBeenCalledWith(FONTS_FAMILIES)
  })
})

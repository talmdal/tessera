import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredIcon } from '@tessera/types'
import { Icon } from '@tessera/ui'
import { MAX_ICON_BYTES, loadIconSource, resetIconSources } from '../../tessera-ui/iconSource'
import { IconRegistryProvider } from '../../tessera-ui/internal'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'
const bank: RegisteredIcon = { id: 'p.bank', url: 'tessera-plugin://p/icons/bank.svg', pluginId: 'p' }

const response = (body: string, status = 200) => new Response(body, { status })

function setup(fetcher: (url: string) => Promise<Response> = async () => response(SVG)) {
  const fetchMock = vi.fn(fetcher)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const drawn = (name: string) => document.querySelector(`[data-icon="${name}"]`)

describe('Icon: standard icons', () => {
  it('draws a Material SVG icon, hidden from assistive technology', () => {
    const { container } = render(<Icon name="Save" />)

    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-icon')).toBe('Save')
    expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('takes the props an SVG icon takes', () => {
    const { container } = render(<Icon name="Home" fontSize="small" color="primary" titleAccess="Home page" className="mine" />)

    const svg = container.querySelector('svg')!
    expect(svg).toHaveClass('MuiSvgIcon-fontSizeSmall', 'MuiSvgIcon-colorPrimary', 'mine')
    expect(screen.getByTitle('Home page')).toBeInTheDocument()
    expect(svg.getAttribute('aria-hidden')).toBeNull()
  })

  it('needs no registry and fetches nothing', () => {
    const fetchMock = setup()

    render(<Icon name="Close" />)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Icon: registered icons', () => {
  beforeEach(() => {
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:icon-${++n}`)
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    resetIconSources()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const withRegistry = (ui: ReactNode, icons: RegisteredIcon[] = [bank]) =>
    <IconRegistryProvider icons={icons}>{ui}</IconRegistryProvider>

  it('fetches the file only when the icon is first drawn, and paints it through a mask once it has loaded', async () => {
    const fetchMock = setup()
    const icons = [bank, { id: 'p.never', url: 'tessera-plugin://p/never.svg', pluginId: 'p' }]

    render(withRegistry(<Icon name="p.bank" />, icons))

    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('tessera-plugin://p/icons/bank.svg')
    // The icon nobody drew was never requested
    expect(fetchMock).not.toHaveBeenCalledWith('tessera-plugin://p/never.svg')
  })

  it('shows the fallback text at the icon size while it loads, then nothing', async () => {
    let finish!: (r: Response) => void
    setup(() => new Promise(resolve => { finish = resolve }))

    render(withRegistry(<Icon name="p.bank" fallback="bank" fontSize="small" />))

    expect(drawn('p.bank')).toHaveTextContent('B')
    await act(async () => { finish(response(SVG)) })
    await waitFor(() => expect(drawn('p.bank')).toHaveTextContent(''))
  })

  it('draws it again without waiting once it is cached, and fetches once for any number of icons', async () => {
    const fetchMock = setup()
    const { rerender } = render(withRegistry(<><Icon name="p.bank" /><Icon name="p.bank" /></>))
    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))

    rerender(withRegistry(<Icon name="p.bank" fallback="bank" />))

    // Synchronously the loaded icon, not the placeholder letter
    expect(drawn('p.bank')).toHaveTextContent('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one request between icons drawn at the same moment', async () => {
    const fetchMock = setup()

    render(withRegistry(<><Icon name="p.bank" /><Icon name="p.bank" /><Icon name="p.bank" /></>))

    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows the fallback for an id nobody registered, without fetching', () => {
    const fetchMock = setup()

    render(withRegistry(<Icon name="p.unknown" fallback="unknown" />))

    expect(drawn('p.unknown')).toHaveTextContent('U')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows an icon registered after it was first drawn', async () => {
    setup()
    const { rerender } = render(withRegistry(<Icon name="p.bank" fallback="bank" />, []))
    expect(drawn('p.bank')).toHaveTextContent('B')

    rerender(withRegistry(<Icon name="p.bank" fallback="bank" />, [bank]))

    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))
  })

  it('draws a file URL directly, as a bar item or view whose icon was a ./file does', async () => {
    const fetchMock = setup()

    render(<Icon name="tessera-plugin://p/icons/direct.svg" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('tessera-plugin://p/icons/direct.svg'))
  })

  it.each([
    ['a missing file', () => response('nope', 404), 'HTTP 404'],
    ['something that is not an SVG', () => response('<html></html>'), 'not an SVG'],
    ['a file that is far too large', () => response(SVG + ' '.repeat(MAX_ICON_BYTES)), 'too large'],
    ['a network error', () => { throw new Error('offline') }, 'offline']
  ])('keeps the fallback for %s, says why once, and does not ask again', async (_name, answer, reason) => {
    const fetchMock = setup(async () => answer())
    const { unmount } = render(withRegistry(<Icon name="p.bank" fallback="bank" />))

    await waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(reason)))
    unmount()
    render(withRegistry(<Icon name="p.bank" fallback="bank" />))
    await act(async () => { await Promise.resolve() })

    expect(drawn('p.bank')).toHaveTextContent('B')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('is monochrome and follows the text colour unless given a palette colour', async () => {
    setup()
    render(withRegistry(<><Icon name="p.bank" /><Icon name="p.bank" color="primary" /></>))

    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))
    expect(document.head.innerHTML).toMatch(/background-color:\s*currentcolor/i)
  })

  it('is hidden from assistive technology unless given a title', async () => {
    setup()
    render(withRegistry(<><Icon name="p.bank" /><Icon name="p.bank" titleAccess="Bank" /></>))
    // Checked on the loaded icon, which is what the user ends up with
    await waitFor(() => expect(document.head.innerHTML).toContain('blob:icon-1'))

    const [plain, titled] = [...document.querySelectorAll('[data-icon="p.bank"]')]
    expect(plain.getAttribute('aria-hidden')).toBe('true')
    expect(titled.getAttribute('role')).toBe('img')
    expect(titled.getAttribute('aria-label')).toBe('Bank')
  })
})

describe('loadIconSource', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => resetIconSources())

  it('never inserts the text into the page: it only ever becomes an object URL for an image', async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned = true</script></svg>'

    const source = await loadIconSource('tessera-plugin://p/a.svg', async () => response(hostile))

    expect(source).toBe('blob:x')
    expect((window as any).__pwned).toBeUndefined()
    expect(document.body.innerHTML).not.toContain('__pwned')
  })

  it('revokes what it created when reset', async () => {
    await loadIconSource('tessera-plugin://p/a.svg', async () => response(SVG))

    resetIconSources()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})

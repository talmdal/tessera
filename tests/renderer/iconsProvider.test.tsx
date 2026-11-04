import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredIcon } from '@tessera/types'
import { Icon } from '@tessera/ui'
import { ICONS_CHANGED, ICONS_LIST_CHANNEL } from '../../shared/layout/types'
import { resetIconSources } from '../../tessera-ui/iconSource'
import { IconsProvider } from '../../shell/renderer/icons/IconsProvider'
import { createFakeRemote } from '../helpers/fakeBridge'

const bank: RegisteredIcon = { id: 'p.bank', url: 'tessera-plugin://p/bank.svg', pluginId: 'p' }
const card: RegisteredIcon = { id: 'p.card', url: 'tessera-plugin://p/card.svg', pluginId: 'p' }
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'

describe('IconsProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:icon-${++n}`)
    URL.revokeObjectURL = vi.fn()
    fetchMock = vi.fn(async () => new Response(SVG))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    resetIconSources()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lets the icons below draw what plugins registered, fetching only what is drawn', async () => {
    const { bridge } = createFakeRemote({ [ICONS_LIST_CHANNEL]: () => [bank, card] })

    render(<IconsProvider bridge={bridge}><Icon name="p.bank" /></IconsProvider>)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(bank.url))
    expect(fetchMock).not.toHaveBeenCalledWith(card.url)
  })

  it('shows the fallback until the list arrives', async () => {
    const { bridge, resolve } = createFakeRemote({ [ICONS_LIST_CHANNEL]: 'deferred' })
    render(<IconsProvider bridge={bridge}><Icon name="p.bank" fallback="bank" /></IconsProvider>)
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => { resolve(ICONS_LIST_CHANNEL, [bank]) })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('asks again when the main process says the icons changed', async () => {
    let list: RegisteredIcon[] = []
    const { bridge, emit } = createFakeRemote({ [ICONS_LIST_CHANNEL]: () => list })
    render(<IconsProvider bridge={bridge}><Icon name="p.bank" /></IconsProvider>)
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1))
    expect(fetchMock).not.toHaveBeenCalled()

    list = [bank]
    act(() => emit(ICONS_CHANGED))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(bank.url))
  })

  it('keeps the newest list when an older answer arrives late', async () => {
    const answers: ((list: RegisteredIcon[]) => void)[] = []
    const bridge = {
      invoke: vi.fn(() => new Promise(resolve => { answers.push(resolve as never) })),
      on: vi.fn((_name: string, listener: () => void) => { reload = listener; return () => {} })
    } as any
    let reload!: () => void
    render(<IconsProvider bridge={bridge}><Icon name="p.bank" /><Icon name="p.card" /></IconsProvider>)
    act(() => reload())

    await act(async () => { answers[1]([bank, card]) })
    await act(async () => { answers[0]([]) })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(card.url))
  })

  it('logs, and keeps drawing standard icons, when the list cannot be fetched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { bridge } = createFakeRemote({})

    const { container } = render(<IconsProvider bridge={bridge}><Icon name="Save" /></IconsProvider>)

    await waitFor(() => expect(error).toHaveBeenCalledWith('[icons] Failed to list the registered icons', expect.any(Error)))
    expect(container.querySelector('svg[data-icon="Save"]')).toBeInTheDocument()
  })

  it('stops listening when it goes away', () => {
    const stop = vi.fn()
    const bridge = { invoke: vi.fn(async () => []), on: vi.fn(() => stop) } as any

    render(<IconsProvider bridge={bridge}><span>x</span></IconsProvider>).unmount()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('x')).toBeNull()
  })
})

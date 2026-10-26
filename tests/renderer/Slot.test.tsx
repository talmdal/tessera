import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { ViewLoader, ViewSource } from '../../shell/renderer/views/ports'
import { Slot, ViewsProvider } from '../../shell/renderer/views/ViewsProvider'

const view = (id: string, slot = 'shell.main'): ViewDescriptor =>
  ({ id, title: `Title ${id}`, slot, module: './V', pluginId: 'p', remoteEntry: 'x' })

const sourceOf = (views: ViewDescriptor[]): ViewSource => ({ listViews: async () => views })

const loaderOf = (components: Record<string, ComponentType>): ViewLoader => ({
  load: async v => {
    const component = components[v.id]
    if (!component) throw new Error(`no component for ${v.id}`)
    return component
  }
})

function renderSlot(source: ViewSource, loader: ViewLoader) {
  return render(
    <ViewsProvider source={source} loader={loader}>
      <Slot id="shell.main" fallback={<p>Nothing here</p>} />
    </ViewsProvider>
  )
}

describe('Slot', () => {
  it('shows the fallback when no views target the slot', async () => {
    renderSlot(sourceOf([view('other', 'elsewhere')]), loaderOf({}))

    expect(await screen.findByText('Nothing here')).toBeInTheDocument()
  })

  it('renders the slot\'s views in order and does not load views for other slots', async () => {
    const loader = loaderOf({ a: () => <p>View A</p>, b: () => <p>View B</p> })
    const load = vi.spyOn(loader, 'load')

    renderSlot(sourceOf([view('a'), view('other', 'elsewhere'), view('b')]), loader)

    const sections = await screen.findAllByRole('region')
    expect(sections.map(s => s.getAttribute('data-view-id'))).toEqual(['a', 'b'])
    expect(await screen.findByText('View A')).toBeInTheDocument()
    expect(await screen.findByText('View B')).toBeInTheDocument()
    expect(load.mock.calls.map(([v]) => v.id)).toEqual(['a', 'b'])
  })

  it('isolates a view that fails to load or render', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Broken = () => { throw new Error('render failure') }

    renderSlot(sourceOf([view('missing'), view('broken'), view('ok')]), loaderOf({ broken: Broken, ok: () => <p>Still here</p> }))

    expect(await screen.findByText('Still here')).toBeInTheDocument()
    expect(await screen.findByText('Title missing could not be displayed.')).toBeInTheDocument()
    expect(await screen.findByText('Title broken could not be displayed.')).toBeInTheDocument()
    error.mockRestore()
  })

  it('falls back to an empty slot when listing views fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderSlot({ listViews: () => Promise.reject(new Error('ipc down')) }, loaderOf({}))

    expect(await screen.findByText('Nothing here')).toBeInTheDocument()
    expect(error).toHaveBeenCalledWith('[views] Failed to list views', expect.any(Error))
    error.mockRestore()
  })

  it('requires a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Slot id="shell.main" />)).toThrow('<Slot> must be rendered inside <ViewsProvider>')
    vi.mocked(console.error).mockRestore()
  })
})

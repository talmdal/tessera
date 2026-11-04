import { describe, expect, it, vi } from 'vitest'
import { DialogService } from '../../core/dialogs/DialogService'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import { EventHubImpl } from '../../core/ipc/EventHub'
import { DIALOGS_EXTENSION_POINT, DIALOG_OPEN, DialogOpen } from '../../shared/dialogs/types'

function setup(options: { target?: number | undefined } = { target: 1 }) {
  const extensions = new ExtensionRegistryImpl()
  const events = new EventHubImpl()
  const log = { warn: vi.fn() }
  let target = options.target
  const service = new DialogService(extensions, events, {
    remoteEntryFor: id => `tessera-plugin://${id}/remoteEntry.js`,
    targetWindow: () => target,
    log
  })
  const sent: DialogOpen[] = []
  events.subscribe(event => { if (event.name === DIALOG_OPEN) sent.push(event.data as DialogOpen) })
  extensions.contribute('book', DIALOGS_EXTENSION_POINT, 'book.dialog.new', { id: 'book.dialog.new', title: 'New Book', module: './NewBookDialog' })

  /** Lets a show() promise settle (or not) before checking it. */
  const settled = async <T>(promise: Promise<T>) => {
    let state: { value?: T, done: boolean } = { done: false }
    promise.then(value => { state = { value, done: true } }, () => { state = { done: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    return state
  }
  return { extensions, service, sent, log, settled, setTarget: (id: number | undefined) => { target = id } }
}

describe('DialogService', () => {
  it("sends a request to the target window once it is ready, and resolves with the window's answer", async () => {
    const { service, sent } = setup()
    service.rendererReady(1)

    const shown = service.show('book.dialog.new', { parentId: null })

    expect(sent).toEqual([{
      windowId: 1, requestId: expect.any(String), title: 'New Book', input: { parentId: null },
      dialog: { id: 'book.dialog.new', title: 'New Book', module: './NewBookDialog', size: 'sm', pluginId: 'book', remoteEntry: 'tessera-plugin://book/remoteEntry.js' }
    }])
    service.close(1, { requestId: sent[0].requestId, result: { kind: 'file', name: 'Home' } })
    await expect(shown).resolves.toEqual({ kind: 'file', name: 'Home' })
    expect(service.openRequests()).toEqual([])
  })

  it('resolves undefined when the dialog is cancelled (closed without a result)', async () => {
    const { service, sent } = setup()
    service.rendererReady(1)
    const shown = service.show('book.dialog.new')
    service.close(1, { requestId: sent[0].requestId })
    await expect(shown).resolves.toBeUndefined()
  })

  it("holds a request until its window's renderer is ready, since an event sent earlier would be lost", async () => {
    const { service, sent, settled } = setup()
    const shown = service.show('book.dialog.new')
    expect(sent).toEqual([])
    expect((await settled(shown)).done).toBe(false)

    service.rendererReady(1)
    expect(sent).toHaveLength(1)
  })

  it('sends open requests again when a window becomes ready again (its page reloaded), oldest first', () => {
    const { service, sent } = setup()
    service.rendererReady(1)
    service.show('book.dialog.new', 'first')
    service.show('book.dialog.new', 'second')
    sent.length = 0

    service.rendererReady(1)

    expect(sent.map(m => m.input)).toEqual(['first', 'second'])
  })

  it('goes to the window asked for, else the target window, and uses the title asked for', () => {
    const { service, sent } = setup({ target: 1 })
    service.rendererReady(1)
    service.rendererReady(2)

    service.show('book.dialog.new', undefined, { windowId: 2, title: 'New Sub-Book' })
    service.show('book.dialog.new')

    expect(sent.map(m => [m.windowId, m.title])).toEqual([[2, 'New Sub-Book'], [1, 'New Book']])
    expect('input' in sent[1]).toBe(false)
  })

  it('accepts an answer only from the window the dialog was sent to', async () => {
    const { service, sent, settled } = setup()
    service.rendererReady(1)
    const shown = service.show('book.dialog.new')

    expect(() => service.close(2, { requestId: sent[0].requestId, result: 'forged' })).toThrow('belongs to another window')
    expect(() => service.close(undefined, { requestId: sent[0].requestId })).toThrow('belongs to another window')
    expect((await settled(shown)).done).toBe(false)
    expect(() => service.close(1, { requestId: 'nope' })).toThrow('Unknown dialog request: nope')
    expect(() => service.close(1, undefined as any)).toThrow('Unknown dialog request')
  })

  it('answers a request only once', async () => {
    const { service, sent } = setup()
    service.rendererReady(1)
    const shown = service.show('book.dialog.new')
    service.close(1, { requestId: sent[0].requestId, result: 1 })
    expect(() => service.close(1, { requestId: sent[0].requestId, result: 2 })).toThrow('Unknown dialog request')
    await expect(shown).resolves.toBe(1)
  })

  it('resolves undefined, and logs, when the window reports that the dialog could not be shown', async () => {
    const { service, sent, log } = setup()
    service.rendererReady(1)
    const shown = service.show('book.dialog.new')
    service.close(1, { requestId: sent[0].requestId, error: 'module not found' })
    await expect(shown).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"book.dialog.new" could not be shown in window 1: module not found'))
  })

  it("resolves a closed window's requests undefined and leaves other windows' alone", async () => {
    const { service, sent, settled } = setup()
    service.rendererReady(1)
    service.rendererReady(2)
    const one = service.show('book.dialog.new', undefined, { windowId: 1 })
    const two = service.show('book.dialog.new', undefined, { windowId: 2 })

    service.windowClosed(1)

    await expect(one).resolves.toBeUndefined()
    expect((await settled(two)).done).toBe(false)
    expect(service.openRequests().map(m => m.windowId)).toEqual([2])
    // A window that closed is no longer ready: a new request for it waits
    sent.length = 0
    service.show('book.dialog.new', undefined, { windowId: 1 })
    expect(sent).toEqual([])
  })

  it('rejects a dialog nobody contributed, and a request when there is no window', async () => {
    const { service, setTarget } = setup()
    await expect(service.show('book.dialog.ghost')).rejects.toThrow('Unknown dialog "book.dialog.ghost"')
    setTarget(undefined)
    await expect(service.show('book.dialog.new')).rejects.toThrow('There is no window')
  })

  it('sees dialogs contributed after it was created, and warns about invalid ones', () => {
    const { service, extensions, log } = setup()
    extensions.contribute('budget', DIALOGS_EXTENSION_POINT, 'budget.edit', { id: 'budget.edit', title: 'Edit', module: './Edit', size: 'md' })
    extensions.contribute('budget', DIALOGS_EXTENSION_POINT, 'bad', { id: 'book.steal', title: 'x', module: './X' })

    expect(service.list().map(d => d.id)).toEqual(['book.dialog.new', 'budget.edit'])
    expect(log.warn).toHaveBeenCalledWith('[dialogs] Dialog "book.steal" ignored: its id must start with "budget."')
  })
})

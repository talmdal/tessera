import { describe, it, expect, vi } from 'vitest'
import { AppLifecycleImpl } from '../../core/lifecycle/AppLifecycle'
import { QuitChoice, QuitEvent, QuitOptions, installQuitHandling } from '../../shell/main/lifecycle/quit'
import { createLogger } from '../helpers/runtime'

function setup(deactivateAll: () => Promise<void> = async () => {}, options: QuitOptions & { shutdownTimeoutMs?: number } = {}) {
  let beforeQuitListener!: (event: QuitEvent) => void
  let systemListener!: (event?: QuitEvent) => void
  const app = { on: vi.fn((_event: 'before-quit', fn: typeof beforeQuitListener) => { beforeQuitListener = fn }), quit: vi.fn() }
  const log = createLogger()
  const lifecycle = new AppLifecycleImpl({ log, ...(options.shutdownTimeoutMs !== undefined && { shutdownTimeoutMs: options.shutdownTimeoutMs }) })
  const deactivate = vi.fn(deactivateAll)
  const handling = installQuitHandling(app, lifecycle, { deactivateAll: deactivate }, log, [listener => { systemListener = listener }], options)

  const fire = (listener: (event: QuitEvent) => void) => {
    const event = { preventDefault: vi.fn() }
    listener(event)
    return event
  }
  return {
    app, lifecycle, log, deactivate, beforeQuit: () => fire(beforeQuitListener), shutdown: () => fire(systemListener),
    /** The last window's close event. */
    closeLastWindow: () => fire(handling.closingLastWindow)
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('quit handling', () => {
  it('cancels the first quit, runs the shutdown, then quits for real', async () => {
    const { app, beforeQuit } = setup()

    expect(beforeQuit().preventDefault).toHaveBeenCalled()
    await settle()
    expect(app.quit).toHaveBeenCalledTimes(1)

    expect(beforeQuit().preventDefault).not.toHaveBeenCalled()   // the quit we triggered ourselves
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('ignores further quit requests while the shutdown is running', async () => {
    let finish!: () => void
    const { app, beforeQuit } = setup(() => new Promise<void>(resolve => { finish = resolve }))

    beforeQuit()
    expect(beforeQuit().preventDefault).toHaveBeenCalled()

    await settle()    // let the shutdown reach deactivateAll
    finish()
    await settle()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('keeps running when a listener vetoes, and accepts a later quit', async () => {
    const { app, lifecycle, beforeQuit } = setup()
    let asked = 0
    lifecycle.onShuttingDown(event => { if (++asked === 1) event.veto('unsaved') })

    beforeQuit()
    await settle()
    expect(app.quit).not.toHaveBeenCalled()

    beforeQuit()
    await settle()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('still quits if the shutdown itself throws', async () => {
    const { app, log, beforeQuit } = setup(async () => { throw new Error('broken') })

    beforeQuit()
    await settle()

    expect(log.error).toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(beforeQuit().preventDefault).not.toHaveBeenCalled()
  })

  it('treats an OS shutdown as a system shutdown that cannot be vetoed', async () => {
    const { app, lifecycle, shutdown } = setup()
    const reasons: string[] = []
    lifecycle.onShuttingDown(event => { reasons.push(event.reason); event.veto() })

    expect(shutdown().preventDefault).toHaveBeenCalled()
    await settle()

    expect(reasons).toEqual(['system'])
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})

describe('quitting in two passes', () => {
  /** The user's answers to "Tessera can't close yet", in order, and what they were shown. */
  function answers(...choices: QuitChoice[]) {
    const shown: string[][] = []
    return { shown, ask: vi.fn(async (reasons: string[]) => { shown.push(reasons); return choices.shift() ?? 'cancel' }) }
  }
  /** Waits until nothing is pending, however many turns that takes. */
  const idle = async () => { for (let i = 0; i < 10; i++) await settle() }

  it('asks "can we close?" first, newest listener first, then shuts down', async () => {
    const { app, lifecycle, beforeQuit } = setup()
    const order: string[] = []
    lifecycle.onWillQuit(() => { order.push('ledger (activated first)') })
    lifecycle.onWillQuit(async () => { order.push('import (depends on the ledger)') })
    lifecycle.onShuttingDown(() => { order.push('shutting down') })

    beforeQuit()
    await idle()

    expect(order).toEqual(['import (depends on the ledger)', 'ledger (activated first)', 'shutting down'])
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('keeps running, nothing shut down, when the user cancels; and asks again at the next quit', async () => {
    const user = answers('cancel', 'quit')
    const { app, lifecycle, deactivate, beforeQuit } = setup(undefined, { ask: user.ask })
    const shutting = vi.fn()
    lifecycle.onWillQuit(() => '“Importing statements” is still running.')
    lifecycle.onShuttingDown(shutting)

    expect(beforeQuit().preventDefault).toHaveBeenCalled()
    await idle()
    expect(user.shown).toEqual([['“Importing statements” is still running.']])
    expect([shutting.mock.calls.length, deactivate.mock.calls.length, app.quit.mock.calls.length]).toEqual([0, 0, 0])
    expect(lifecycle.phase).toBe('starting')

    beforeQuit()
    await idle()
    expect(user.shown).toHaveLength(2)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('asks pass 1 again on Retry, and goes on once nothing stands in the way', async () => {
    const user = answers('retry')
    const { app, lifecycle, beforeQuit } = setup(undefined, { ask: user.ask })
    let running = true
    lifecycle.onWillQuit(() => running ? 'The backup drive isn’t there.' : undefined)
    user.ask.mockImplementationOnce(async reasons => { user.shown.push(reasons); running = false; return 'retry' })

    beforeQuit()
    await idle()
    expect(user.shown).toEqual([['The backup drive isn’t there.']])
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('cancels the open dialogs before pass 2, on Quit Anyway', async () => {
    const order: string[] = []
    const { app, lifecycle, beforeQuit } = setup(undefined, { ask: async () => 'quit', cancelDialogs: () => { order.push('dialogs cancelled') } })
    lifecycle.onWillQuit(() => 'busy')
    lifecycle.onShuttingDown(() => { order.push('shutting down') })
    beforeQuit()
    await idle()
    expect(order).toEqual(['dialogs cancelled', 'shutting down'])
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('gives pass 1 all the time it needs: it isn\'t under the shutdown\'s time limit', async () => {
    const { app, lifecycle, beforeQuit } = setup(undefined, { ask: async () => 'cancel', shutdownTimeoutMs: 20 })
    lifecycle.onWillQuit(async () => { await new Promise(r => setTimeout(r, 80)); return 'The backup failed.' })
    beforeQuit()
    await new Promise(r => setTimeout(r, 150))
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('asks while the last window is still open: Cancel keeps it, and going ahead quits with pass 1 done', async () => {
    const user = answers('cancel', 'quit')
    const { app, lifecycle, beforeQuit, closeLastWindow } = setup(undefined, { ask: user.ask })
    let asked = 0
    lifecycle.onWillQuit(() => { asked++; return 'busy' })

    expect(closeLastWindow().preventDefault).toHaveBeenCalled()
    await idle()
    expect(app.quit).not.toHaveBeenCalled()

    closeLastWindow()
    await idle()
    expect(app.quit).toHaveBeenCalledTimes(1)
    // The quit that follows goes straight to pass 2
    beforeQuit()
    await idle()
    expect(asked).toBe(2)
    expect(app.quit).toHaveBeenCalledTimes(2)
    // And the windows close with it
    expect(closeLastWindow().preventDefault).not.toHaveBeenCalled()
  })

  it('skips pass 1 for an OS shutdown, and takes over from one waiting on the user', async () => {
    let answer!: (choice: QuitChoice) => void
    const { app, lifecycle, beforeQuit, shutdown } = setup(undefined, { ask: () => new Promise(resolve => { answer = resolve }) })
    const reasons: string[] = []
    lifecycle.onWillQuit(() => 'busy')
    lifecycle.onShuttingDown(event => { reasons.push(event.reason) })

    beforeQuit()
    await idle()
    shutdown()
    await idle()
    expect(reasons).toEqual(['system'])
    expect(app.quit).toHaveBeenCalledTimes(1)
    answer('cancel')                                   // too late: the OS shut down
    await idle()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('logs a pass 1 listener that throws, and counts it as no reason', async () => {
    const { app, lifecycle, log, beforeQuit } = setup(undefined, { ask: async () => 'cancel' })
    lifecycle.onWillQuit(() => { throw new Error('broken') })
    beforeQuit()
    await idle()
    expect(log.error).toHaveBeenCalledWith('[lifecycle] An onWillQuit listener failed', expect.any(Error))
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})

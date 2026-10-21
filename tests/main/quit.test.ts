import { describe, it, expect, vi } from 'vitest'
import { AppLifecycleImpl } from '../../core/lifecycle/AppLifecycle'
import { QuitEvent, installQuitHandling } from '../../shell/main/lifecycle/quit'
import { createLogger } from '../helpers/runtime'

function setup(deactivateAll: () => Promise<void> = async () => {}) {
  let beforeQuitListener!: (event: QuitEvent) => void
  let systemListener!: (event?: QuitEvent) => void
  const app = { on: vi.fn((_event: 'before-quit', fn: typeof beforeQuitListener) => { beforeQuitListener = fn }), quit: vi.fn() }
  const lifecycle = new AppLifecycleImpl()
  const log = createLogger()
  installQuitHandling(app, lifecycle, { deactivateAll: vi.fn(deactivateAll) }, log, [listener => { systemListener = listener }])

  const fire = (listener: (event: QuitEvent) => void) => {
    const event = { preventDefault: vi.fn() }
    listener(event)
    return event
  }
  return { app, lifecycle, log, beforeQuit: () => fire(beforeQuitListener), shutdown: () => fire(systemListener) }
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

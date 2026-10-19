import { describe, it, expect, vi } from 'vitest'
import { installQuitHandling } from '../../shell/main/lifecycle/quit'
import { createLogger } from '../helpers/runtime'

function setup(shutdown: () => Promise<boolean>) {
  let listener!: (event: { preventDefault(): void }) => void
  const app = { on: vi.fn((_event: 'before-quit', fn: typeof listener) => { listener = fn }), quit: vi.fn() }
  const log = createLogger()
  installQuitHandling(app, shutdown, log)

  const beforeQuit = () => {
    const event = { preventDefault: vi.fn() }
    listener(event)
    return event
  }
  return { app, log, beforeQuit }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('quit handling', () => {
  it('cancels the first quit, runs the shutdown, then quits for real', async () => {
    const shutdown = vi.fn(async () => true)
    const { app, beforeQuit } = setup(shutdown)

    const first = beforeQuit()
    expect(first.preventDefault).toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
    await settle()
    expect(app.quit).toHaveBeenCalledTimes(1)

    const second = beforeQuit()          // the quit we triggered ourselves
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('ignores further quit requests while the shutdown is running', async () => {
    let finish!: (completed: boolean) => void
    const shutdown = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { app, beforeQuit } = setup(shutdown)

    beforeQuit()
    const again = beforeQuit()
    expect(again.preventDefault).toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)

    finish(true)
    await settle()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('keeps running when the shutdown is vetoed, and accepts a later quit', async () => {
    const shutdown = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { app, beforeQuit } = setup(shutdown)

    beforeQuit()
    await settle()
    expect(app.quit).not.toHaveBeenCalled()

    beforeQuit()
    await settle()
    expect(shutdown).toHaveBeenCalledTimes(2)
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
})

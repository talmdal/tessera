import { describe, it, expect, vi, afterEach } from 'vitest'
import { powerMonitor } from 'electron'
import shutdownHandler from '@paymoapp/electron-shutdown-handler'
import { osShutdownSources } from '../../shell/main/lifecycle/systemShutdown'

const realPlatform = process.platform
const setPlatform = (platform: string) => Object.defineProperty(process, 'platform', { value: platform })

afterEach(() => {
  setPlatform(realPlatform)
  vi.clearAllMocks()
})

const window = (handle = Buffer.from('hwnd')) => ({ getNativeWindowHandle: vi.fn(() => handle) }) as any

describe('osShutdownSources', () => {
  it('uses only powerMonitor off Windows, and never touches the native handler', () => {
    setPlatform('linux')

    const sources = osShutdownSources(window())
    const listener = vi.fn()
    sources.forEach(subscribe => subscribe(listener))

    expect(sources).toHaveLength(1)
    expect(shutdownHandler.setWindowHandle).not.toHaveBeenCalled()
    expect(shutdownHandler.on).not.toHaveBeenCalled()

    const event = { preventDefault: vi.fn() }
    vi.mocked(powerMonitor.on).mock.calls[0][1](event)
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('on Windows gives the native handler the window handle before it listens', () => {
    setPlatform('win32')
    const handle = Buffer.from('hwnd')

    const sources = osShutdownSources(window(handle))
    expect(sources).toHaveLength(2)
    expect(shutdownHandler.setWindowHandle).toHaveBeenCalledWith(handle)
    expect(shutdownHandler.on).not.toHaveBeenCalled()    // the native hook needs the handle first

    sources[1](vi.fn())
    expect(shutdownHandler.on).toHaveBeenCalledWith('shutdown', expect.any(Function))
    expect(vi.mocked(shutdownHandler.setWindowHandle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(shutdownHandler.on).mock.invocationCallOrder[0])
  })

  it('on Windows, delaying the shutdown blocks it with a reason', () => {
    setPlatform('win32')
    const listener = vi.fn()
    osShutdownSources(window())[1](listener)

    vi.mocked(shutdownHandler.on).mock.calls[0][1]()
    const event = listener.mock.calls[0][0]
    expect(shutdownHandler.blockShutdown).not.toHaveBeenCalled()

    event.preventDefault()
    expect(shutdownHandler.blockShutdown).toHaveBeenCalledWith(expect.stringContaining('saving'))
  })
})

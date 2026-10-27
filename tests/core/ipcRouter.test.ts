import { describe, it, expect } from 'vitest'
import { IpcRouterImpl } from '../../core/ipc/IpcRouter'
import { createLogger } from '../helpers/runtime'

describe('IpcRouter', () => {
  it('dispatches to the handler for the channel, passing data and correlation id', async () => {
    const router = new IpcRouterImpl()
    router.register('p:echo', async msg => msg)

    await expect(router.dispatch({ channel: 'p:echo', data: 42, correlationId: 'c1' })).resolves.toEqual({
      ok: true,
      data: { channel: 'p:echo', data: 42, correlationId: 'c1' },
      correlationId: 'c1'
    })
  })

  it('passes the adapter-supplied sender to the handler', async () => {
    const router = new IpcRouterImpl()
    router.register('p:who', async msg => msg.sender?.windowId ?? 'nobody')

    await expect(router.dispatch({ channel: 'p:who' }, { windowId: 7 })).resolves.toMatchObject({ ok: true, data: 7 })
    await expect(router.dispatch({ channel: 'p:who' })).resolves.toMatchObject({ ok: true, data: 'nobody' })
  })

  it('reaches handlers registered after dispatching started', async () => {
    const router = new IpcRouterImpl()
    expect((await router.dispatch({ channel: 'p:late' })).ok).toBe(false)

    router.register('p:late', () => 'here')
    await expect(router.dispatch({ channel: 'p:late' })).resolves.toMatchObject({ ok: true, data: 'here' })
  })

  it('returns error envelopes for bad requests, missing handlers and handler failures', async () => {
    const log = createLogger()
    const router = new IpcRouterImpl(log)
    router.register('p:boom', () => { throw new Error('kaboom') })

    await expect(router.dispatch(null)).resolves.toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
    await expect(router.dispatch({ channel: 'p:none' })).resolves.toMatchObject({ ok: false, error: { code: 'NO_HANDLER' } })
    await expect(router.dispatch({ channel: 'p:boom' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'HANDLER_ERROR', message: 'kaboom' }
    })
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('rejects duplicate channels and frees the channel on dispose', () => {
    const router = new IpcRouterImpl()
    const registration = router.register('p:x', () => 1)

    expect(() => router.register('p:x', () => 2)).toThrow('IPC channel already registered: p:x')
    registration.dispose()
    expect(router.has('p:x')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { channelFor, isIpcEvent, isIpcRequest } from '../../shared/ipc'

describe('IPC contract', () => {
  it('namespaces channels by plugin id', () => {
    expect(channelFor('finance', 'accounts.list')).toBe('finance:accounts.list')
  })

  it('accepts well-formed requests', () => {
    expect(isIpcRequest({ channel: 'a:b' })).toBe(true)
    expect(isIpcRequest({ channel: 'a:b', data: 1, correlationId: 'c1' })).toBe(true)
  })

  it('rejects malformed requests', () => {
    expect(isIpcRequest(undefined)).toBe(false)
    expect(isIpcRequest('a:b')).toBe(false)
    expect(isIpcRequest({ channel: '' })).toBe(false)
    expect(isIpcRequest({ channel: 'a:b', correlationId: 7 })).toBe(false)
  })

  it('recognises push events by their name', () => {
    expect(isIpcEvent({ name: 'vault:opened' })).toBe(true)
    expect(isIpcEvent({ name: 'vault:opened', data: { n: 1 } })).toBe(true)
    expect(isIpcEvent({ name: '' })).toBe(false)
    expect(isIpcEvent({ data: 1 })).toBe(false)
    expect(isIpcEvent(null)).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createFontCatalogue } from '../../shell/main/fonts/fontCatalogue'
import { createLogger } from '../helpers/runtime'

const port = (answer: () => Promise<string[]>) => ({ listFamilies: vi.fn(answer) })

describe('the installed-font catalogue', () => {
  it('sorts the families, keeps each once whatever its case, and drops names the shell would refuse', async () => {
    const catalogue = createFontCatalogue(port(async () => ['Segoe UI', 'arial', 'Arial', ' Consolas ', 'Bad;Name', '', 'Cascadia Mono', 'ARIAL']))

    await expect(catalogue.families()).resolves.toEqual({ families: ['arial', 'Cascadia Mono', 'Consolas', 'Segoe UI'], complete: true })
  })

  it('lists once, the first time it is asked, and keeps the answer for the session', async () => {
    const listing = port(async () => ['Inter'])
    const catalogue = createFontCatalogue(listing)
    expect(listing.listFamilies).not.toHaveBeenCalled()

    const [first, second] = await Promise.all([catalogue.families(), catalogue.families()])
    await catalogue.families()

    expect(first).toEqual({ families: ['Inter'], complete: true })
    expect(second).toBe(first)
    expect(listing.listFamilies).toHaveBeenCalledTimes(1)
  })

  it('answers "not available", logged once, when listing fails', async () => {
    const log = createLogger()
    const catalogue = createFontCatalogue(port(async () => { throw new Error('no permission') }), { log })

    await expect(catalogue.families()).resolves.toEqual({ families: [], complete: false })
    await catalogue.families()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no permission'))
  })

  it('answers "not available" for an empty list, which is what the platform answers when listing is not permitted', async () => {
    const log = createLogger()

    await expect(createFontCatalogue(port(async () => []), { log }).families()).resolves.toEqual({ families: [], complete: false })
    await expect(createFontCatalogue(port(async () => ['Bad;Name']), { log }).families()).resolves.toEqual({ families: [], complete: false })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No installed fonts were listed'))
  })

  it('gives up after its time limit', async () => {
    vi.useFakeTimers()
    try {
      const log = createLogger()
      const answer = createFontCatalogue(port(() => new Promise(() => {})), { timeoutMs: 5000, log }).families()

      await vi.advanceTimersByTimeAsync(5000)

      await expect(answer).resolves.toEqual({ families: [], complete: false })
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no answer within 5000 ms'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers "not available" for an answer that is not a list', async () => {
    await expect(createFontCatalogue(port(async () => 'Inter' as never)).families()).resolves.toEqual({ families: [], complete: false })
  })
})

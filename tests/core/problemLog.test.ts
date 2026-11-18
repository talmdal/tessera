// The problem log: what the framework and its plugins warned about, kept so the user can see it.
import { describe, expect, it, vi } from 'vitest'
import { NOTIFY_DELAY_MS, ProblemLog, recordingLogger } from '../../core/problems/ProblemLog'

/** A log whose notifications run when `flush` is called, so a test can see what one burst announces. */
function manual(options: { limit?: number } = {}) {
  const queued: (() => void)[] = []
  let tick = 0
  const problems = new ProblemLog({
    ...options,
    now: () => `2026-11-17T10:00:0${tick++}.000Z`,
    defer: work => { queued.push(work) }
  })
  const flush = () => { for (const work of queued.splice(0)) work() }
  return { problems, flush }
}

describe('recording', () => {
  it('takes the source from the message’s [prefix], and keeps the rest as the message', () => {
    const { problems } = manual()
    problems.record('warning', '[plugins] Skipping "budget": required service "ledger.session" is not available')
    expect(problems.list()).toEqual([expect.objectContaining({
      level: 'warning', source: 'plugins', message: 'Skipping "budget": required service "ledger.session" is not available', count: 1
    })])
  })

  it('calls a message with no prefix the shell’s', () => {
    const { problems } = manual()
    problems.record('error', 'Something broke')
    expect(problems.list()[0]).toMatchObject({ source: 'shell', message: 'Something broke' })
  })

  it('keeps an error’s stack as the detail', () => {
    const { problems } = manual()
    const failure = new Error('boom')
    problems.record('error', '[exchange] The import failed', failure)
    expect(problems.list()[0].detail).toBe(failure.stack)
  })

  it('counts a problem repeated back to back instead of listing it again', () => {
    const { problems } = manual()
    problems.record('warning', '[views] View "x" ignored')
    problems.record('warning', '[views] View "x" ignored')
    problems.record('warning', '[views] View "y" ignored')
    expect(problems.list().map(p => [p.message, p.count])).toEqual([['View "x" ignored', 2], ['View "y" ignored', 1]])
  })

  it('keeps only the most recent, so a noisy loop cannot grow it without bound', () => {
    const { problems } = manual({ limit: 3 })
    for (let i = 0; i < 5; i++) problems.record('warning', `number ${i}`)
    expect(problems.list().map(p => p.message)).toEqual(['number 2', 'number 3', 'number 4'])
  })

  it('totals the errors and the warnings', () => {
    const { problems } = manual()
    problems.record('warning', 'a')
    problems.record('error', 'b')
    problems.record('warning', 'c')
    expect(problems.summary()).toEqual({ total: 3, errors: 1, warnings: 2 })
  })

  it('forgets everything when cleared', () => {
    const { problems } = manual()
    problems.record('warning', 'a')
    problems.clear()
    expect(problems.list()).toEqual([])
  })
})

describe('announcing changes', () => {
  it('announces a burst once, with the totals after it', () => {
    const { problems, flush } = manual()
    const heard = vi.fn()
    problems.onDidChange(heard)
    problems.record('warning', 'a')
    problems.record('error', 'b')
    flush()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith({ total: 2, errors: 1, warnings: 1 })
  })

  it('keeps a listener that logs to one line with a count, announced once per round', () => {
    const { problems, flush } = manual()
    const heard = vi.fn(() => { problems.record('error', '[events] Could not send to a window') })
    problems.onDidChange(heard)
    problems.record('warning', 'a')
    for (let round = 0; round < 5; round++) flush()

    // Each round is one delayed announcement, never a tight loop; and the list does not grow
    expect(heard).toHaveBeenCalledTimes(5)
    expect(problems.list().map(p => [p.message, p.count])).toEqual([['a', 1], ['Could not send to a window', 5]])
  })

  it('waits a moment before announcing, by default', () => {
    vi.useFakeTimers()
    try {
      const problems = new ProblemLog()
      const heard = vi.fn()
      problems.onDidChange(heard)
      problems.record('warning', 'a')
      expect(heard).not.toHaveBeenCalled()
      vi.advanceTimersByTime(NOTIFY_DELAY_MS)
      expect(heard).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('says nothing when clearing an empty log', () => {
    const { problems, flush } = manual()
    const heard = vi.fn()
    problems.onDidChange(heard)
    problems.clear()
    flush()
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('the recording logger', () => {
  it('passes everything on, and records the warnings and errors', () => {
    const { problems } = manual()
    const inner = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const log = recordingLogger(inner, problems)
    const failure = new Error('nope')

    log.info('[plugins] activated')
    log.warn('[plugins] Skipping x')
    log.error('[plugins] Failed to activate "y"', failure)

    expect(inner.info).toHaveBeenCalledWith('[plugins] activated')
    expect(inner.warn).toHaveBeenCalledWith('[plugins] Skipping x')
    expect(inner.error).toHaveBeenCalledWith('[plugins] Failed to activate "y"', failure)
    expect(problems.list().map(p => [p.level, p.message])).toEqual([
      ['warning', 'Skipping x'],
      ['error', 'Failed to activate "y"']
    ])
  })
})

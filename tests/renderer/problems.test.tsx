// The Problems dialog, and how a window reports its own errors to it.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROBLEMS_CHANGED, PROBLEMS_CLEAR, PROBLEMS_DIALOG_MODULE, PROBLEMS_LIST, PROBLEMS_REPORT, type ProblemEntry
} from '../../shared/problems/types'
import { BUILT_IN_DIALOGS } from '../../shell/renderer/dialogs/builtIns'
import { asText, ProblemsDialog } from '../../shell/renderer/dialogs/ProblemsDialog'
import { reportCaught, reportWindowErrors } from '../../shell/renderer/problems/reportWindowErrors'
import { createFakeRemote } from '../helpers/fakeBridge'

const problem = (over: Partial<ProblemEntry> = {}): ProblemEntry => ({
  id: 1, time: '2026-11-17T10:00:00.000Z', level: 'warning', source: 'plugins',
  message: 'Skipping "budget": requires service "ledger.session", which no plugin provides', count: 1, ...over
})

afterEach(() => { delete (window as any).api; vi.restoreAllMocks() })

describe('the Problems dialog', () => {
  function setup(listed: ProblemEntry[]) {
    let current = listed
    const remote = createFakeRemote({
      [PROBLEMS_LIST]: () => current,
      [PROBLEMS_CLEAR]: () => { current = [] }
    })
    ;(window as any).api = remote.bridge
    const close = vi.fn()
    render(<ProblemsDialog input={undefined} close={close} setBusy={() => {}} />)
    return { ...remote, close, set: (next: ProblemEntry[]) => { current = next } }
  }

  it('is one of the shell’s own dialogs', () => {
    expect(BUILT_IN_DIALOGS[PROBLEMS_DIALOG_MODULE]).toBe(ProblemsDialog)
  })

  it('lists what was reported, newest first, with who reported it', async () => {
    setup([problem({ id: 1, message: 'older' }), problem({ id: 2, level: 'error', source: 'exchange', message: 'newer' })])
    await screen.findByText('newer')
    const shown = [...document.querySelectorAll('[data-problem]')]
    expect(shown.map(el => el.getAttribute('data-problem'))).toEqual(['error', 'warning'])
    expect(shown[0].textContent).toContain('exchange')
  })

  it('says so when there is nothing to show', async () => {
    setup([])
    expect(await screen.findByText('No problems have been reported.')).toBeInTheDocument()
  })

  it('shows an error’s details when asked', async () => {
    setup([problem({ level: 'error', detail: 'Error: boom\n    at activate (index.js:3)' })])
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(await screen.findByText(/at activate \(index\.js:3\)/)).toBeVisible()
  })

  it('follows the log while it is open', async () => {
    const b = setup([problem({ message: 'first' })])
    await screen.findByText('first')
    b.set([problem({ message: 'first' }), problem({ id: 2, message: 'second' })])
    act(() => b.emit(PROBLEMS_CHANGED, { total: 2, errors: 0, warnings: 2 }))
    expect(await screen.findByText('second')).toBeInTheDocument()
  })

  it('clears the log', async () => {
    const b = setup([problem()])
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }))
    expect(b.bridge.invoke).toHaveBeenCalledWith(PROBLEMS_CLEAR)
    expect(await screen.findByText('No problems have been reported.')).toBeInTheDocument()
  })

  it('writes a problem out as one would paste it into a bug report', () => {
    expect(asText(problem({ count: 3, detail: 'stack' })))
      .toBe('2026-11-17T10:00:00.000Z WARNING [plugins] Skipping "budget": requires service "ledger.session", which no plugin provides (×3)\nstack')
  })
})

describe('a window’s own errors', () => {
  const fire = (type: string, init: Record<string, unknown>) => {
    const event = new Event(type)
    Object.assign(event, init)
    window.dispatchEvent(event)
  }

  it('reports an uncaught error and an unhandled rejection to the main process', async () => {
    const invoke = vi.fn(async () => undefined) as any
    const stop = reportWindowErrors(window, { invoke })
    try {
      fire('error', { error: new Error('x is undefined'), message: 'x is undefined' })
      fire('unhandledrejection', { reason: new Error('no reply') })
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
      expect(invoke).toHaveBeenCalledWith(PROBLEMS_REPORT, expect.objectContaining({ level: 'error', message: 'Uncaught error: x is undefined' }))
      expect(invoke).toHaveBeenCalledWith(PROBLEMS_REPORT, expect.objectContaining({ message: 'Unhandled rejection: no reply' }))
    } finally { stop() }
  })

  it('stops after a burst, so an error thrown on every frame cannot flood the log', async () => {
    const invoke = vi.fn(async () => undefined) as any
    const stop = reportWindowErrors(window, { invoke }, () => 1_000)
    try {
      for (let i = 0; i < 50; i++) fire('error', { error: new Error(`again ${i}`) })
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(20))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(invoke).toHaveBeenCalledTimes(20)
    } finally { stop() }
  })

  it('stops listening when asked', async () => {
    const invoke = vi.fn(async () => undefined) as any
    reportWindowErrors(window, { invoke })()
    fire('error', { message: 'after' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports what an error boundary caught, with the component stack', async () => {
    const invoke = vi.fn(async () => undefined) as any
    ;(window as any).api = { invoke }
    reportCaught('View "Import" could not be displayed', new Error('bad render'), '\n    in ReviewView')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(PROBLEMS_REPORT, expect.objectContaining({
      level: 'error', message: 'View "Import" could not be displayed: bad render', detail: expect.stringContaining('in ReviewView')
    })))
  })

  it('does not throw when the bridge cannot take the report', () => {
    ;(window as any).api = { invoke: () => { throw new Error('gone') } }
    expect(() => reportCaught('x', new Error('y'))).not.toThrow()
  })
})

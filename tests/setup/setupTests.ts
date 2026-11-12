// MUST be first
import './mockElectron'

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, beforeEach } from 'vitest'
import { checkSingleTestingLibraryDom } from './singleDomCopy'

// Before anything else: with two copies of @testing-library/dom, React tests fail with act(...) errors that hide the
// cause (see singleDomCopy.ts). Checked once per worker.
const checked = globalThis as typeof globalThis & { __singleDomChecked?: boolean }
if (!checked.__singleDomChecked) {
  checkSingleTestingLibraryDom()
  checked.__singleDomChecked = true
}

// This file runs before every test file, including when files share a worker (isolate: false), where modules are
// imported once per worker. So nothing here may rely on running only once, or on another module's import having
// registered something for this file.

// React warns "An update to X inside a test was not wrapped in act(...)" when a component changes state after the
// test stopped waiting for it: typically a click starts an IPC request, the test asserts at once, and the reply
// updates the component later. The assertion then checked the UI before it settled, and whether the warning appears
// depends on timing, so it comes and goes between machines and runs. Rather than let it scroll past as noise, the test
// that caused it fails, naming the component; wait for what the user would see (findBy…, waitFor) to fix it.
// console.error is patched once per worker, and the warnings are kept on globalThis, so every file sees the same list.
const state = globalThis as typeof globalThis & { __actWarnings?: string[] }
const actWarnings = (state.__actWarnings ??= [])
const PATCHED = Symbol.for('tessera.tests.actCheck')
if (!(console.error as unknown as Record<symbol, boolean>)[PATCHED]) {
  const consoleError = console.error.bind(console)
  const patched = (...args: unknown[]) => {
    // React formats its warnings printf-style: 'An update to %s inside a test…', 'MoveDialog'
    const [format, ...rest] = args
    const text = typeof format === 'string' ? format.replace(/%s/g, () => String(rest.shift())) : args.map(String).join(' ')
    if (text.includes('not wrapped in act(')) {
      actWarnings.push(/An update to (\w+)/.exec(text)?.[1] ?? 'a component')
      return
    }
    consoleError(...args)
  }
  Object.assign(patched, { [PATCHED]: true })
  console.error = patched
}

// Hooks run last-registered first, so this check runs after the cleanup below: an update from a component that was
// still mounted is caught here, and one from an unmounted component can't be blamed on the next test.
afterEach(() => {
  if (actWarnings.length === 0) return
  const components = [...new Set(actWarnings)].join(', ')
  actWarnings.length = 0
  throw new Error(`React state updated outside act(...) in ${components}: the test didn't wait for the UI to settle. ` +
    'Await what the user would see (findBy…, waitFor) after the action that started the update.')
})

// Tell React it runs in tests, so it warns about updates outside act(...) (which the check above turns into failures).
// Testing Library sets this in a beforeAll registered when it is first imported, and puts it back in an afterAll: in a
// shared worker that happens only for the first file, and every later file ran with React's act checks switched off.
beforeAll(() => {
  if (typeof document !== 'undefined') (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

// Unmount what each test rendered. Testing Library does this by itself only in the first file of a worker that imports
// it: its afterEach is registered when the module is first evaluated, and a shared worker evaluates it once. Later files
// would then find the previous test's dialogs still in the page. Loaded only where there is a DOM.
//
// Then put `window.api` back as it was before the test: the fake privileged side a test put there goes, and one that was
// there already (the preload's own, exposed once for its whole file) stays. Only after unmounting: unmounting runs a
// component's effect cleanups and any effects still pending, and they may still call it. A test file's own afterEach
// runs before this one (hooks run last-registered first), so a file that deleted `window.api` itself made a dialog whose
// effect was still pending throw "Cannot read properties of undefined (reading 'invoke')", on machines where the effect
// came late. Files leave it to this (tests/setup/bridgeCleanup.test.tsx).
let bridgeBefore: { had: boolean, api: unknown } = { had: false, api: undefined }
beforeEach(() => {
  if (typeof window === 'undefined') return
  bridgeBefore = { had: 'api' in window, api: (window as { api?: unknown }).api }
})
afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  const bridge = window as { api?: unknown }
  if (bridgeBefore.had) bridge.api = bridgeBefore.api
  else delete bridge.api
})

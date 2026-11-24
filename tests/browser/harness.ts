// Tests in a real browser: a page bundled from the components under test (with React, MUI and the shell's theme, as
// the app bundles them), opened in headless Chromium. For what jsdom can't show: layout, SVG drawn by a chart library,
// painted frames, IntersectionObserver. Run by Vitest in Node, like any test file.
//
// A Chromium is found, in order: TESSERA_CHROMIUM (a path to a Chromium or Chrome executable); Playwright's own
// browser for this playwright-core; the newest Chromium in PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright. None
// found, `browserProblem` says why, and the tests `describe.skipIf(...)` rather than fail: a machine without a browser
// (CI without one installed) still runs everything else. `npx playwright install chromium` installs one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const repo = path.resolve(__dirname, '../..')

type Chromium = typeof import('playwright-core')['chromium']
type Browser = Awaited<ReturnType<Chromium['launch']>>
export type Page = Awaited<ReturnType<Browser['newPage']>>

/** The newest Chromium (or its headless shell) in a folder of Playwright's browsers. */
function newestIn(folder: string): string | undefined {
  if (!fs.existsSync(folder)) return undefined
  const candidates = fs.readdirSync(folder)
    .filter(name => /^chromium(_headless_shell)?-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()) || (a.includes('headless') ? -1 : 1))
  for (const name of candidates) {
    for (const file of ['chrome-linux/headless_shell', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell',
      'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const full = path.join(folder, name, file)
      if (fs.existsSync(full)) return full
    }
  }
  return undefined
}

/** Where a Chromium is, and the library that drives it; or why there is none. */
async function locate(): Promise<{ chromium: Chromium, executablePath: string } | { problem: string }> {
  let chromium: Chromium
  try {
    chromium = (await import('playwright-core')).chromium
  } catch {
    return { problem: 'playwright-core isn’t installed (npm install)' }
  }
  const fromEnv = process.env.TESSERA_CHROMIUM
  if (fromEnv) return fs.existsSync(fromEnv) ? { chromium, executablePath: fromEnv } : { problem: `TESSERA_CHROMIUM names ${fromEnv}, which isn’t there` }
  try {
    const own = chromium.executablePath()
    if (own && fs.existsSync(own)) return { chromium, executablePath: own }
  } catch { /* not installed for this version */ }
  const folders = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')]
  for (const folder of folders) {
    const found = folder ? newestIn(folder) : undefined
    if (found) return { chromium, executablePath: found }
  }
  return { problem: 'no Chromium found: set TESSERA_CHROMIUM, or run `npx playwright install chromium`' }
}

const located = await locate()

/** Why the browser tests can't run here, or undefined when they can. Said once, so a skipped run says why. */
export const browserProblem: string | undefined = 'problem' in located ? located.problem : undefined
if (browserProblem) console.warn(`[browser tests] Skipped: ${browserProblem}`)

/** Launches the browser: one per test file. */
export async function launch(): Promise<Browser> {
  if ('problem' in located) throw new Error(located.problem)
  return located.chromium.launch({ executablePath: located.executablePath, args: ['--font-render-hinting=none'] })
}

const ALIASES: Record<string, string> = {
  // The charts' entry before @tessera/ui's, which would otherwise match it as a prefix
  '@tessera/ui/charts': 'tessera-ui/charts/index.ts',
  '@tessera/ui': 'tessera-ui/index.ts',
  '@tessera/types': 'tessera-types/index.ts',
  '@tessera/ledger-api': 'packages/ledger-api/index.ts',
  '@tessera/accounts-api': 'packages/accounts-api/index.ts',
  '@tessera/budget-api': 'packages/budget-api/index.ts',
  '@tessera/reports-api': 'packages/reports-api/index.ts'
}

/**
 * Bundles `entry` (a .tsx that puts what it tests on `window`) into an HTML page in a folder of its own, and returns the
 * page's URL. React in production mode, as the app ships it.
 */
export async function bundle(entry: string): Promise<string> {
  const esbuild = await import('esbuild')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-browser-'))
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'iife', jsx: 'automatic', outfile: path.join(out, 'page.js'), logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' }, target: 'chrome120',
    alias: Object.fromEntries(Object.entries(ALIASES).map(([name, file]) => [name, path.join(repo, file)])),
    nodePaths: [path.join(repo, 'node_modules')]
  })
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script src="page.js"></script></body></html>')
  return pathToFileURL(path.join(out, 'index.html')).href
}

/** A page of `url`, collecting what went wrong in it: uncaught errors and console errors. */
export async function open(browser: Browser, url: string, viewport = { width: 1000, height: 700 }) {
  const page = await browser.newPage({ viewport })
  const problems: string[] = []
  page.on('pageerror', err => problems.push(`page error: ${err.message}`))
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`) })
  await page.goto(url)
  return { page, problems }
}

/**
 * Saves a screenshot of the page for a person to look at, when TESSERA_SCREENSHOTS names a folder: the tests check what
 * can be checked in numbers; how it looks is checked by eye.
 */
export async function screenshot(page: Page, name: string) {
  const folder = process.env.TESSERA_SCREENSHOTS
  if (!folder) return
  fs.mkdirSync(folder, { recursive: true })
  await page.screenshot({ path: path.join(folder, `${name}.png`), fullPage: true })
}

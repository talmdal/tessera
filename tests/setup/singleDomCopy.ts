// user-event dispatches its clicks and keystrokes through @testing-library/dom, which @testing-library/react configures
// to wrap every event in React's act(...). That only works if both packages load the same copy of it. When npm installs
// two, user-event's events skip act(), and dozens of tests fail with "React state updated outside act(...)" in MUI's
// ForwardRef and Transition, which says nothing about the real cause. This check says it instead.
// It happened with React Testing Library 14, which bundled its own 9.x while user-event and jest-dom took 10.x. Since
// 16, React Testing Library takes @testing-library/dom as a peer dependency, and package.json names the one version
// all three share, so a plain `npm install` makes one copy. The check stays, for the next upgrade.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The folder of the installed package `name`, found from the file it resolves to (searching from `paths`, as the package
 * there would). Walking up from the entry works even for packages whose exports hide their package.json.
 */
function packageFolder(name: string, paths?: string[]): string {
  const marker = path.join('node_modules', ...name.split('/'))
  let dir = path.dirname(require.resolve(name, paths ? { paths } : undefined))
  while (!dir.endsWith(marker)) {
    const up = path.dirname(dir)
    if (up === dir) throw new Error(`Can't find the folder of ${name}`)
    dir = up
  }
  return dir
}

/** The copy of `dependency` that `from` loads: resolved from inside `from`'s own folder. */
const copyLoadedBy = (from: string, dependency: string) => packageFolder(dependency, [packageFolder(from)])

/** Throws, naming both copies and the fix, when user-event and React Testing Library would load different copies. */
export function checkSingleTestingLibraryDom(): void {
  const forUserEvent = copyLoadedBy('@testing-library/user-event', '@testing-library/dom')
  const forReact = copyLoadedBy('@testing-library/react', '@testing-library/dom')
  if (forUserEvent === forReact) return
  throw new Error([
    'Two copies of @testing-library/dom are installed, so user-event\'s clicks and keystrokes are not wrapped in act(...)',
    'and React tests fail with "state updated outside act(...)".',
    `  user-event loads:               ${forUserEvent}`,
    `  @testing-library/react loads:   ${forReact}`,
    'package.json names the version they share, so run `npm install` (or `npm dedupe`) to install one copy; if that',
    'doesn\'t help, one of them now needs a different version: align @testing-library/dom with their peer dependencies.'
  ].join('\n'))
}

// The standard icon set is two lists that must agree: the names the main process validates against (in
// @tessera/types), and the components the renderer draws (tessera-ui/standardIcons.ts). Both must exist in
// the installed icon package.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ICON_NAMES, isIconName } from '@tessera/types'
import { STANDARD_ICONS } from '../../tessera-ui/standardIcons'

const iconsPackage = path.resolve(__dirname, '../../node_modules/@mui/icons-material')

describe('the standard icon set', () => {
  it('has a component for every name, and no component without a name', () => {
    expect(Object.keys(STANDARD_ICONS).sort()).toEqual([...ICON_NAMES].sort())
    for (const name of ICON_NAMES) expect(STANDARD_ICONS[name], name).toBeTruthy()
  })

  it('names only icons that exist in @mui/icons-material', () => {
    for (const name of ICON_NAMES) expect(fs.existsSync(path.join(iconsPackage, `${name}.js`)), name).toBe(true)
  })

  it('lists each name once, in PascalCase like the package', () => {
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
    for (const name of ICON_NAMES) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/)
  })

  it('does not take a registered id for a standard name', () => {
    expect(isIconName('Save')).toBe(true)
    expect(isIconName('accounts.bank')).toBe(false)
    expect(isIconName('')).toBe(false)
  })

  it('imports each icon by path, never from the package root', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../tessera-ui/standardIcons.ts'), 'utf8')
    expect(source).not.toMatch(/from '@mui\/icons-material'/)
  })
})

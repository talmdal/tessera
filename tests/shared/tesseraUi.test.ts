// @tessera/ui is a curated facade: its surface is a deliberate list, not whatever MUI happens to export.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as ui from '@tessera/ui'

const root = path.resolve(__dirname, '../../tessera-ui')

describe('@tessera/ui', () => {
  it('exports exactly the curated components and helpers', () => {
    expect(Object.keys(ui).sort()).toEqual([
      'Alert', 'Autocomplete', 'Box', 'Button', 'Checkbox', 'CircularProgress', 'Collapse', 'Dialog', 'DialogActions',
      'DialogContent', 'DialogTitle', 'Divider', 'FormControl', 'FormControlLabel', 'FormHelperText', 'FormLabel', 'Icon',
      'IconButton', 'InputAdornment', 'List', 'ListItemButton', 'ListItemIcon', 'ListItemText', 'Menu', 'MenuItem',
      'Paper', 'Radio', 'RadioGroup', 'Stack', 'TESSERA_UI_VERSION', 'Tab', 'Table', 'TableBody', 'TableCell',
      'TableContainer', 'TableHead', 'TableRow', 'Tabs', 'TextField', 'ToggleButton', 'ToggleButtonGroup', 'Toolbar',
      'Tooltip', 'Typography', 'createSvgIcon', 'useTheme', 'useThemeState'
    ])
  })

  it('never re-exports MUI wholesale', () => {
    const source = fs.readFileSync(path.join(root, 'index.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*export\s+\*/m)
  })

  it("declares the version the shell and the plugin build share", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(ui.TESSERA_UI_VERSION).toBe(version)
  })
})

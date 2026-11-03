// tessera-ui/icons.ts — the shell's icon set: one Material icon per name in shared/layout/icons.ts.
//
// The names are what the main process validates contributions against; this
// is where each name gets its glyph. To add an icon, add its name there and
// its import here (tests/ui/icons.test.tsx checks the two lists agree). Icons
// are imported by path so only these are bundled, not the whole package.
import type { ComponentType } from 'react'
import type { SvgIconProps } from '@mui/material'
import AccountBalance from '@mui/icons-material/AccountBalance'
import Add from '@mui/icons-material/Add'
import CalendarToday from '@mui/icons-material/CalendarToday'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import Circle from '@mui/icons-material/Circle'
import Close from '@mui/icons-material/Close'
import ExpandLess from '@mui/icons-material/ExpandLess'
import ExpandMore from '@mui/icons-material/ExpandMore'
import Home from '@mui/icons-material/Home'
import Info from '@mui/icons-material/Info'
import List from '@mui/icons-material/List'
import Save from '@mui/icons-material/Save'
import Search from '@mui/icons-material/Search'
import type { IconName } from '../shared/layout/icons'

export const ICONS: Record<IconName, ComponentType<SvgIconProps>> = {
  AccountBalance,
  Add,
  CalendarToday,
  ChevronLeft,
  ChevronRight,
  Circle,
  Close,
  ExpandLess,
  ExpandMore,
  Home,
  Info,
  List,
  Save,
  Search
}

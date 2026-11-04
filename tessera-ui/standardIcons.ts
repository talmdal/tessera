// The shell's standard icons: the components behind the names in @tessera/types. Each is imported by path,
// never from the package's root, which would pull in thousands of modules.
import type { SvgIcon } from '@mui/material'
import type { IconName } from '@tessera/types'
import Add from '@mui/icons-material/Add'
import AccountBalance from '@mui/icons-material/AccountBalance'
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

export const STANDARD_ICONS: Record<IconName, typeof SvgIcon> = {
  Add, AccountBalance, CalendarToday, ChevronLeft, ChevronRight, Circle, Close, ExpandLess, ExpandMore,
  Home, Info, List, Save, Search
}

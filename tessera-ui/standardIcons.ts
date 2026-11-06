// The shell's standard icons: the components behind the names in @tessera/types. Each is imported by path,
// never from the package's root, which would pull in thousands of modules.
import type { SvgIcon } from '@mui/material'
import type { IconName } from '@tessera/types'
import Add from '@mui/icons-material/Add'
import AccountBalance from '@mui/icons-material/AccountBalance'
import Block from '@mui/icons-material/Block'
import CalendarToday from '@mui/icons-material/CalendarToday'
import Check from '@mui/icons-material/Check'
import ChevronLeft from '@mui/icons-material/ChevronLeft'
import ChevronRight from '@mui/icons-material/ChevronRight'
import Circle from '@mui/icons-material/Circle'
import Close from '@mui/icons-material/Close'
import CompareArrows from '@mui/icons-material/CompareArrows'
import CreditCard from '@mui/icons-material/CreditCard'
import Delete from '@mui/icons-material/Delete'
import Edit from '@mui/icons-material/Edit'
import ErrorIcon from '@mui/icons-material/Error'
import ExpandLess from '@mui/icons-material/ExpandLess'
import ExpandMore from '@mui/icons-material/ExpandMore'
import Folder from '@mui/icons-material/Folder'
import Home from '@mui/icons-material/Home'
import Info from '@mui/icons-material/Info'
import List from '@mui/icons-material/List'
import MoreVert from '@mui/icons-material/MoreVert'
import NewReleases from '@mui/icons-material/NewReleases'
import Save from '@mui/icons-material/Save'
import Savings from '@mui/icons-material/Savings'
import Search from '@mui/icons-material/Search'
import ShowChart from '@mui/icons-material/ShowChart'
import Undo from '@mui/icons-material/Undo'
import UploadFile from '@mui/icons-material/UploadFile'
import Warning from '@mui/icons-material/Warning'

export const STANDARD_ICONS: Record<IconName, typeof SvgIcon> = {
  Add, AccountBalance, Block, CalendarToday, Check, ChevronLeft, ChevronRight, Circle, Close, CompareArrows, CreditCard,
  Delete, Edit,
  // `Error` would shadow the global Error constructor in this module
  Error: ErrorIcon,
  ExpandLess, ExpandMore, Folder, Home, Info, List, MoreVert, NewReleases, Save, Savings, Search, ShowChart, Undo,
  UploadFile, Warning
}

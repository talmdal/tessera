// @tessera/ui — the components, styling and theme access plugin views may use, alongside @tessera/types.
//
// This is a curated facade over Material UI: MUI, Emotion and the icon package are the shell's private
// dependencies, so plugins never import them (the plugin build rejects it) and the shell can upgrade
// or reshape them behind this file. Add an export when a view needs it; do not `export *` from MUI.
//
// At run time the shell supplies the one instance of this module to every plugin as a Module Federation
// singleton, so a plugin's components share the shell's theme and style cache.

// The typography variants of the font roles (`numeric`, `monospace`), in MUI's types. Types only.
import './typography'

export {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
  useTheme
} from '@mui/material'

export type {
  AutocompleteProps,
  MenuProps,
  TextFieldProps,
  Theme,
  TooltipProps
} from '@mui/material'

// Build a component from path data, for an icon a plugin ships inside its view code.
export { createSvgIcon } from '@mui/material/utils'

export { Icon } from './Icon'
export type { IconProps } from './Icon'
export { useThemeState } from './themeState'
export { useFontRoles } from './fontRoles'

export { TESSERA_UI_VERSION } from './version'

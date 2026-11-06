// The shell's standard icon set. Names are Material icon names (as in @mui/icons-material), so the main
// process can validate contributions against them without importing any component. The components live in
// tessera-ui/standardIcons.ts, and a test keeps the two in step and checks each name exists in the package.

export const ICON_NAMES = [
  'Add', 'AccountBalance', 'Block', 'CalendarToday', 'Check', 'ChevronLeft', 'ChevronRight', 'Circle', 'Close',
  'CompareArrows', 'CreditCard', 'Delete', 'Edit', 'Error', 'ExpandLess', 'ExpandMore', 'Folder', 'Home', 'Info', 'List',
  'MoreVert', 'NewReleases', 'Save', 'Savings', 'Search', 'ShowChart', 'Undo', 'UploadFile', 'Warning'
] as const

export type IconName = typeof ICON_NAMES[number]

export function isIconName(value: string): value is IconName {
  return (ICON_NAMES as readonly string[]).includes(value)
}

/** An icon a plugin registered through `shell.icons`, with the URL of its file. */
export interface RegisteredIcon {
  /** `<pluginId>.<name>`. */
  id: string
  /** Where the renderer fetches the SVG from, the first time the icon is drawn. */
  url: string
  pluginId: string
}

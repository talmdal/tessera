// shell/renderer/layout/iconGlyphs.ts — the shell's icon set: Material icon paths on a 24px grid.
// The names are in shared/layout/icons.ts, which the main process validates contributions against.
import type { IconName } from '../../../shared/layout/icons'

export const ICON_GLYPHS: Record<IconName, string> = {
  Add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  AccountBalance: 'M4 10v7h3v-7H4zm6 0v7h3v-7h-3zM2 22h19v-3H2v3zm14-12v7h3v-7h-3zm-4.5-9L2 6v2h19V6l-9.5-5z',
  CalendarToday: 'M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z',
  ChevronLeft: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  ChevronRight: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  Circle: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2z',
  Close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  ExpandLess: 'm12 8-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
  ExpandMore: 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z',
  Home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  Info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  List: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  Save: 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z',
  Search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'
}

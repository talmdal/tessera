// shell/renderer/layout/iconGlyphs.ts
//
// The glyphs of the shell's built-in icon set (16×16 viewBox, filled with
// currentColor). The names live in shared/layout/icons.ts so the main process
// can validate contributions; keep the two in step.

export const ICON_GLYPHS: Record<string, string> = {
  // A wallet/card stack
  'accounts': 'M2 4h12v2H2V4zm0 3h12v5H2V7zm1.5 2h4v1h-4V9z',
  // A month grid
  'calendar': 'M3 3h10v2H3V3zm0 3h10v7H3V6zm2 2h2v2H5V8zm4 0h2v2H9V8z',
  // Rising bars
  'chart': 'M3 9h2v4H3V9zm4-3h2v7H7V6zm4-3h2v10h-2V3z',
  'chevron-down': 'M3.6 5.5 8 9.9l4.4-4.4 1.1 1.1L8 12.1 2.5 6.6l1.1-1.1z',
  'chevron-left': 'M10.5 3.6 6.1 8l4.4 4.4-1.1 1.1L3.9 8l5.5-5.5 1.1 1.1z',
  'chevron-right': 'M5.5 3.6 9.9 8l-4.4 4.4 1.1 1.1L12.1 8 6.6 2.5 5.5 3.6z',
  'chevron-up': 'M3.6 10.5 8 6.1l4.4 4.4 1.1-1.1L8 3.9 2.5 9.4l1.1 1.1z',
  'circle-filled': 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  // A cog, simplified
  'gear': 'M7 2h2l.4 1.7 1.5.9 1.7-.5 1 1.7-1.3 1.2v1.8l1.3 1.2-1 1.7-1.7-.5-1.5.9L9 14H7l-.4-1.7-1.5-.9-1.7.5-1-1.7 1.3-1.2V7.2L2.4 6l1-1.7 1.7.5 1.5-.9L7 2zm1 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  'home': 'M8 2.5 14 8h-2v5H9.5V9.5h-3V13H4V8H2l6-5.5z',
  'info': 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm-.75 5h1.5v5h-1.5V7zM8 4.25A.9.9 0 1 1 8 6a.9.9 0 0 1 0-1.75z',
  // Three lines with bullets
  'list-flat': 'M3 3.5h2v2H3v-2zm3 .5h7v1H6V4zM3 7h2v2H3V7zm3 .5h7v1H6v-1zM3 10.5h2v2H3v-2zm3 .5h7v1H6v-1z',
  // A terminal-ish panel
  'output': 'M2 3h12v10H2V3zm1.5 1.5v7h9v-7h-9zM4.5 6 6 7.5 4.5 9l.8.8L7.5 7.5 5.3 5.2l-.8.8zM8 9h3v1H8V9z',
  // A floppy disk
  'save': 'M3 3h8l2 2v8H3V3zm2 1v3h5V4H5zm0 5v3h6V9H5z',
  'search': 'M7 3a4 4 0 0 1 3.2 6.4l3 3-1 1-3-3A4 4 0 1 1 7 3zm0 1.5A2.5 2.5 0 1 0 7 9.5 2.5 2.5 0 0 0 7 4.5z',
  'warning': 'M8 2.5 14.5 13h-13L8 2.5zM7.25 6.5h1.5v3.5h-1.5V6.5zm.75 4.5a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z'
}

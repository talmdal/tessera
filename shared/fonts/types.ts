// shared/fonts/types.ts — ids and the wire contract for fonts: the list of installed fonts the Fonts page offers.
import { channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

/** Request (renderer → main) → `InstalledFonts`: the font families installed on this computer. */
export const FONTS_FAMILIES = channelFor(SHELL_CONTRIBUTOR_ID, 'fonts.families')

/** The font families installed on this computer, as the Fonts page offers them. */
export interface InstalledFonts {
  /** Sorted, each name once (compared without case), and only names the shell accepts as font names. */
  families: string[]
  /**
   * True when the list is what the computer has. False when it couldn't be listed (or came back empty): the page then
   * offers only what can be typed, and never says a font isn't installed.
   */
  complete: boolean
}

/** Commands the shell registers for fonts. */
export const FONT_COMMANDS = {
  /** Opens the Options dialog at its Fonts page. */
  choose: 'shell.fonts.choose'
} as const

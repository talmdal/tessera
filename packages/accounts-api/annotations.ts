// The `accounts.register.annotations` extension point: a plugin marks register rows and gives them buttons, as
// `accounts.reconcile.actions` adds menu options. The register draws everything itself; a plugin supplies data (through
// a `RegisterAnnotator` service) and handles its commands. The import manager uses it for the bank lines to review,
// with Accept and Change… on each row. See docs/import-manager-design.md, "Reviewing in the register".
import type { Event } from '@tessera/types'

/** Extension point for `RegisterAnnotationsContribution`s. */
export const REGISTER_ANNOTATIONS_POINT = 'accounts.register.annotations'

/** How long an annotator has to answer before the register loads without its marks. */
export const ANNOTATE_TIMEOUT_MS = 2000

/**
 * Contributed as plain data: `context.extensions.contribute(pluginId, REGISTER_ANNOTATIONS_POINT, id, contribution)`.
 * Behaviour lives in the service it names, and in the commands its actions run.
 */
export interface RegisterAnnotationsContribution {
  /** `<pluginId>.<name>`, e.g. 'import.review'. */
  id: string
  /** The service implementing `RegisterAnnotator`, e.g. 'import.annotator'. */
  service: string
  /** Lower first. When two contributors mark one row, the first draws its second line and buttons. Default 0. */
  order?: number
}

/** The service behind a contribution. */
export interface RegisterAnnotator {
  /** The marks for one account's rows. Asked when the register loads; must answer within `ANNOTATE_TIMEOUT_MS`. */
  annotate(accountId: string): Promise<AccountAnnotations>
  /** Fires when marks change for reasons `accounts.onDidChange` doesn't cover; the registers listed reload. */
  readonly onDidChange: Event<{ accounts: string[] }>
}

export interface AccountAnnotations {
  rows: RowAnnotation[]
  /**
   * Shown above the table while any of this annotator's rows has `review: true`, or while `outstanding` is above
   * zero: things to review that aren't rows in the register (a bank line that lost its transaction, say).
   */
  summary?: { message: string, actions: AnnotationAction[], outstanding?: number }
}

export const ANNOTATION_TONES = ['info', 'warning', 'success'] as const
export type AnnotationTone = typeof ANNOTATION_TONES[number]

export interface RowAnnotation {
  transactionId: string
  /** Needs the user: counted in the review bar, visited by Next (F8), and marked with a bar at the row's left edge. */
  review: boolean
  /** The colour of the left-edge bar and of emphasised parts: the theme's palette colour of that name. */
  tone: AnnotationTone
  /** The second line under the row; none when there are no parts. Parts with `emphasis` are drawn in the tone. */
  detail: { icon?: string, parts: { text: string, emphasis?: boolean }[] }
  /** At most two with placement 'button' are drawn as buttons; the rest go to the row's context menu. */
  actions: AnnotationAction[]
}

export interface AnnotationAction {
  id: string
  /** 'Accept', 'Change…'. */
  label: string
  /** A shell icon name, or an icon a plugin registered. */
  icon?: string
  tooltip?: string
  placement: 'button' | 'menu'
  /** Run through `shell:commands.execute` with `args` as its only argument. */
  command: string
  /** Structured-cloneable. */
  args: unknown
}

/**
 * A row's marks as the register draws them, once `accounts` has merged every annotator's: the first (by order) gives
 * the tone, the second line and up to two buttons; every other action, its own or another annotator's, is in `menu`.
 */
export interface ResolvedRowAnnotation {
  transactionId: string
  /** Any annotator says the row needs the user. */
  review: boolean
  tone: AnnotationTone
  detail: RowAnnotation['detail']
  buttons: AnnotationAction[]
  menu: AnnotationAction[]
}

/** Every mark for one register, in register order, with the summaries to show above the table. */
export interface RegisterAnnotations {
  rows: ResolvedRowAnnotation[]
  /** One per annotator that has a summary and a row to review (or something `outstanding`), in order. */
  summaries: { contributor: string, message: string, actions: AnnotationAction[] }[]
}

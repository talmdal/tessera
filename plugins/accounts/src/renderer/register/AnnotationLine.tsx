// The marks other plugins put on register rows (accounts.register.annotations): the bar at a row's left edge, and the
// second line under it, where the parts a plugin wants noticed (the bank's different amount, say) are in its tone.
// Colours come from the theme's palette, never literals, so they follow light and dark themes.
import type { MouseEvent } from 'react'
import type { AnnotationTone, ResolvedRowAnnotation } from '@tessera/accounts-api'
import { Box, Icon, TableCell, TableRow, type Theme } from '@tessera/ui'

/** The `sx` that marks a row needing review with a bar in its tone along its first cell. */
export function reviewBar(tone: AnnotationTone) {
  return { '& > td:first-of-type': { boxShadow: (theme: Theme) => `inset 3px 0 0 ${theme.palette[tone].main}` } }
}

/** The id of a row's second line, which describes the row to assistive technology. */
export const annotationId = (transactionId: string) => `annotation-${transactionId}`

/** The second line under an annotated row. Clicking it selects the row it belongs to. */
export function AnnotationLine({ mark, columns, selected, onSelect, onContextMenu }: {
  mark: ResolvedRowAnnotation
  /** How many columns the table has: the line spans all but the status column. */
  columns: number
  selected: boolean
  onSelect(): void
  onContextMenu(event: MouseEvent): void
}) {
  const { detail, tone } = mark
  return (
    <TableRow
      selected={selected} onClick={onSelect} onContextMenu={onContextMenu} data-annotation={mark.transactionId}
      sx={{ cursor: 'default', '& > td': { pt: 0, color: 'text.secondary' }, ...(mark.review ? reviewBar(tone) : {}) }}
    >
      <TableCell />
      <TableCell colSpan={columns - 1} id={annotationId(mark.transactionId)} sx={{ whiteSpace: 'normal' }}>
        {detail.icon && <Icon name={detail.icon} fontSize="inherit" color={tone} sx={{ verticalAlign: 'text-bottom', mr: 0.5 }} />}
        {detail.parts.map((part, i) => part.emphasis
          ? <Box component="strong" key={i} sx={{ color: `${tone}.main`, fontWeight: 600 }}>{part.text}</Box>
          : <span key={i}>{part.text}</span>)}
      </TableCell>
    </TableRow>
  )
}

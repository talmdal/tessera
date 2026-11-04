import type { ReactNode } from 'react'
import { CircularProgress, Stack, Typography } from '@tessera/ui'

/** A small "loading" line: a spinner and a message. The spinner is decorative, so the message is what is announced. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: 'center' }}>
      <CircularProgress size={14} aria-hidden role="presentation" />
      <Typography variant="body2" color="text.secondary">{children}</Typography>
    </Stack>
  )
}

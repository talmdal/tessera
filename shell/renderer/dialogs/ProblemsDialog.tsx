// shell/renderer/dialogs/ProblemsDialog.tsx — the shell's own dialog behind Help ▸ Show Problems… and the status
// bar's problem count: the warnings and errors the framework and its plugins reported, newest first.
import { useCallback, useEffect, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  Box, Button, Chip, Collapse, DialogActions, DialogContent, Icon, Stack, Typography
} from '@tessera/ui'
import {
  PROBLEMS_CHANGED, PROBLEMS_CLEAR, PROBLEMS_LIST, type ProblemEntry
} from '../../../shared/problems/types'

const time = (iso: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString()
}

/** One problem as plain text, for Copy: what someone reporting a bug would paste. */
export const asText = (problem: ProblemEntry) =>
  `${problem.time} ${problem.level.toUpperCase()} [${problem.source}] ${problem.message}` +
  (problem.count > 1 ? ` (×${problem.count})` : '') +
  (problem.detail === undefined ? '' : `\n${problem.detail}`)

export function ProblemsDialog({ close }: DialogProps<unknown, void>) {
  const [problems, setProblems] = useState<ProblemEntry[]>()
  const [open, setOpen] = useState<number>()

  const load = useCallback(() => {
    window.api.invoke<ProblemEntry[]>(PROBLEMS_LIST).then(
      found => setProblems(found ?? []),
      () => setProblems([]))
  }, [])

  // Subscribed before asking, so a problem reported in between is not missed
  useEffect(() => {
    const stop = window.api.on(PROBLEMS_CHANGED, () => load())
    load()
    return stop
  }, [load])

  const newestFirst = [...(problems ?? [])].reverse()

  const copy = () => {
    void navigator.clipboard?.writeText((problems ?? []).map(asText).join('\n\n')).catch(() => undefined)
  }

  return (
    <>
      <DialogContent dividers sx={{ minHeight: 240 }}>
        {problems !== undefined && problems.length === 0 && (
          <Typography color="text.secondary" data-problems="none">No problems have been reported.</Typography>
        )}
        <Stack spacing={0.5}>
          {newestFirst.map(problem => (
            <Box key={problem.id} data-problem={problem.level}
              sx={{ borderBottom: 1, borderColor: 'divider', pb: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <Icon name={problem.level === 'error' ? 'Error' : 'Warning'} fontSize="small"
                  color={problem.level === 'error' ? 'error' : 'warning'} titleAccess={problem.level === 'error' ? 'Error' : 'Warning'} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{problem.message}</Typography>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary">{time(problem.time)}</Typography>
                    <Chip size="small" variant="outlined" label={problem.source} />
                    {problem.count > 1 && <Typography variant="caption" color="text.secondary">×{problem.count}</Typography>}
                    {problem.detail !== undefined && (
                      <Button size="small" variant="text" sx={{ minWidth: 0, px: 0.5 }}
                        onClick={() => setOpen(was => was === problem.id ? undefined : problem.id)}
                        aria-expanded={open === problem.id}>
                        {open === problem.id ? 'Hide details' : 'Details'}
                      </Button>
                    )}
                  </Stack>
                  {problem.detail !== undefined && (
                    <Collapse in={open === problem.id}>
                      <Box component="pre" sx={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', m: 0, mt: 0.5, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
                        {problem.detail}
                      </Box>
                    </Collapse>
                  )}
                </Box>
              </Stack>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={copy} disabled={!problems?.length}>Copy</Button>
        <Button onClick={() => { void window.api.invoke(PROBLEMS_CLEAR).then(load, () => undefined) }} disabled={!problems?.length}>Clear</Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => close()}>Close</Button>
      </DialogActions>
    </>
  )
}

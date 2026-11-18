// The book's payee rules: what each turns into what, in the order they are tried.
//
// Order is the whole of the semantics — the first rule that fires wins — so it is the one thing the list makes
// unmissable: rules are numbered, moved with the arrows, and a rule that can never fire because an earlier one
// already catches everything it would is worth seeing next to the one that shadows it.
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import {
  payeeRuleProblem,
  type NewPayeeRule, type PayeeRule, type PayeeRuleMatchKind, type RulesDialogInput, type RulesDialogResult
} from '@tessera/exchange-api'
import {
  Box, Button, Checkbox, Chip, DialogActions, DialogContent, Icon, IconButton, MenuItem, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, Tooltip, Typography
} from '@tessera/ui'

/** A rule being edited: either one the book already has, or one typed here and not yet saved. */
type Editable = (NewPayeeRule | PayeeRule) & { key: string }

const KINDS: { value: PayeeRuleMatchKind, label: string }[] = [
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'equals', label: 'is exactly' },
  { value: 'regex', label: 'matches pattern' }
]

const NONE = '::none::'

export default function RulesDialog({ input, close }: DialogProps<RulesDialogInput, RulesDialogResult>) {
  const [rules, setRules] = useState<Editable[]>(() =>
    [...input.rules].sort((a, b) => a.order - b.order).map((rule, at) => ({ ...rule, key: `r${at}` })))
  const [nextKey, setNextKey] = useState(rules.length)

  const patch = (key: string, change: Partial<Editable>) =>
    setRules(all => all.map(rule => rule.key === key ? { ...rule, ...change } : rule))

  const move = (at: number, by: number) => setRules(all => {
    const to = at + by
    if (to < 0 || to >= all.length) return all
    const next = [...all]
    ;[next[at], next[to]] = [next[to], next[at]]
    return next
  })

  const add = () => {
    setRules(all => [...all, {
      key: `n${nextKey}`, order: all.length, enabled: true,
      match: { kind: 'contains', value: '', ignoreCase: true }, payee: ''
    }])
    setNextKey(n => n + 1)
  }

  /**
   * A rule with nothing to match on or nothing to rename to is unfinished, and dropped on save. One that is
   * finished but wrong — a pattern that does not compile — is a mistake to show, not drop: it holds Save, since
   * the service runs the same check and would refuse the whole list, losing every other edit with it.
   */
  const usable = (rule: Editable) => rule.match.value.trim() !== '' && rule.payee.trim() !== ''
  const incomplete = rules.filter(rule => !usable(rule)).length
  const problemOf = (rule: Editable) => usable(rule) ? payeeRuleProblem(rule) : undefined
  const broken = rules.filter(rule => problemOf(rule) !== undefined).length

  const save = () => close({
    // Renumbered from the position: the list the user sees *is* the order, so nothing else can disagree.
    rules: rules.filter(usable).map(({ key: _key, ...rule }, at) => ({ ...rule, order: at }))
  })

  return (
    <>
      <DialogContent dividers sx={{ p: 0 }}>
        <Table size="small" stickyHeader aria-label="Payee rules">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 40 }}>On</TableCell>
              <TableCell sx={{ width: 150 }}>When the payee</TableCell>
              <TableCell>this text</TableCell>
              <TableCell sx={{ width: 180 }}>rename it to</TableCell>
              <TableCell sx={{ width: 150 }}>category</TableCell>
              <TableCell sx={{ width: 140 }}>in</TableCell>
              <TableCell sx={{ width: 96 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {rules.map((rule, at) => (
              <TableRow key={rule.key} sx={{ opacity: rule.enabled ? 1 : 0.55 }}>
                <TableCell>
                  <Checkbox size="small" checked={rule.enabled}
                    slotProps={{ input: { 'aria-label': `Rule ${at + 1} on` } }}
                    onChange={event => patch(rule.key, { enabled: event.target.checked })} />
                </TableCell>
                <TableCell>
                  <TextField size="small" select fullWidth variant="standard" value={rule.match.kind}
                    slotProps={{ htmlInput: { 'aria-label': `Rule ${at + 1} test` } }}
                    onChange={event => patch(rule.key, {
                      match: { ...rule.match, kind: event.target.value as PayeeRuleMatchKind }
                    })}>
                    {KINDS.map(kind => <MenuItem key={kind.value} value={kind.value}>{kind.label}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell>
                  <TextField size="small" fullWidth variant="standard" value={rule.match.value}
                    error={problemOf(rule)?.field === 'match'}
                    title={problemOf(rule)?.message}
                    placeholder="SQ *THE DAILY GRIND"
                    slotProps={{ htmlInput: { 'aria-label': `Rule ${at + 1} text` } }}
                    onChange={event => patch(rule.key, { match: { ...rule.match, value: event.target.value } })} />
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <TextField size="small" fullWidth variant="standard" value={rule.payee}
                      placeholder="The Daily Grind"
                      slotProps={{ htmlInput: { 'aria-label': `Rule ${at + 1} payee` } }}
                      onChange={event => patch(rule.key, { payee: event.target.value })} />
                    {rule.learned === true && (
                      <Tooltip title="Written by “Always rename this”">
                        <Chip size="small" label="learned" variant="outlined" />
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <TextField size="small" select fullWidth variant="standard"
                    value={rule.categoryId ?? NONE}
                    slotProps={{ htmlInput: { 'aria-label': `Rule ${at + 1} category` } }}
                    onChange={event => patch(rule.key, {
                      categoryId: event.target.value === NONE ? undefined : event.target.value
                    })}>
                    <MenuItem value={NONE}><em>leave it</em></MenuItem>
                    {input.categories.map(c => <MenuItem key={c.id} value={c.id}>{c.label}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell>
                  <TextField size="small" select fullWidth variant="standard"
                    value={rule.accountId ?? NONE}
                    slotProps={{ htmlInput: { 'aria-label': `Rule ${at + 1} account` } }}
                    onChange={event => patch(rule.key, {
                      accountId: event.target.value === NONE ? undefined : event.target.value
                    })}>
                    <MenuItem value={NONE}><em>every account</em></MenuItem>
                    {input.accounts.map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" aria-label={`Move rule ${at + 1} up`} disabled={at === 0}
                    onClick={() => move(at, -1)}><Icon name="ExpandLess" /></IconButton>
                  <IconButton size="small" aria-label={`Move rule ${at + 1} down`} disabled={at === rules.length - 1}
                    onClick={() => move(at, 1)}><Icon name="ExpandMore" /></IconButton>
                  <IconButton size="small" aria-label={`Delete rule ${at + 1}`}
                    onClick={() => setRules(all => all.filter(r => r.key !== rule.key))}><Icon name="Delete" /></IconButton>
                </TableCell>
              </TableRow>
            ))}
            {rules.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                    No rules yet. Rules turn a bank’s text — `SQ *THE DAILY GRIND 4471` — into the name you use,
                    before Tessera looks for a matching transaction.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Box sx={{ pl: 1 }}>
          <Button onClick={add} data-add-rule>Add Rule</Button>
          {broken > 0 && (
            <Typography variant="caption" color="error" sx={{ ml: 1 }}>
              {broken === 1 ? 'A rule has' : `${broken} rules have`} a pattern that is not valid.
            </Typography>
          )}
          {incomplete > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              {incomplete} unfinished {incomplete === 1 ? 'rule' : 'rules'} will be dropped.
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1}>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={broken > 0} data-rules-ok>Save</Button>
        </Stack>
      </DialogActions>
    </>
  )
}

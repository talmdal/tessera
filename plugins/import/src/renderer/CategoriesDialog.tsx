// Categories from the File: a file gives categories for its new transactions, and the ledger has them. They are used
// only if the user says so, and the answer is kept for the file's source: a Money export's categories are the user's
// own, a bank's usually aren't. Nothing is chosen to begin with. Opened again from the import summary (Change…), it
// starts from the answer kept, and unticking Remember forgets it.
// See docs/import-formats-design.md, "Category hints".
import { FormEvent, useState } from 'react'
import type { DialogProps } from '@tessera/types'
import type { CategoriesDialogInput, CategoriesDialogResult, CategorySource } from '@tessera/import-api'
import {
  Box, Button, Checkbox, DialogActions, DialogContent, FormControlLabel, Radio, RadioGroup, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Typography
} from '@tessera/ui'
import { count } from './display'

/** What the file offers, in a sentence or two. */
export function describeOffer({ fileName, offered, differing }: CategoriesDialogInput): string {
  const offer = offered === 1
    ? `${fileName} gives a category for one of its new transactions, and your ledger has it.`
    : `${fileName} gives a category for ${count(offered, 'new transaction')}, and your ledger has them.`
  if (differing === 0) return offer
  if (offered === 1) return `${offer} You usually use a different category for its payee.`
  return `${offer} For ${differing === offered ? 'all of them' : `${differing.toLocaleString()} of them`}, you usually use a different category for the payee.`
}

function Choice({ title, detail }: { title: string, detail: string }) {
  return (
    <Stack sx={{ pt: 0.75 }}>
      <Typography>{title}</Typography>
      <Typography variant="body2" color="text.secondary">{detail}</Typography>
    </Stack>
  )
}

export default function CategoriesDialog({ input, close }: DialogProps<CategoriesDialogInput, CategoriesDialogResult>) {
  const changing = input.current !== undefined
  const [source, setSource] = useState<CategorySource | ''>(input.current ?? '')
  const [remember, setRemember] = useState(true)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (source !== '') close({ source, remember })
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>{describeOffer(input)}</Typography>

          {input.examples.length > 0 && (
            <Table size="small" aria-label="Categories in the file">
              <TableHead>
                <TableRow>
                  <TableCell>Payee</TableCell>
                  <TableCell>The file says</TableCell>
                  <TableCell>You usually use</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {input.examples.map(example => (
                  <TableRow key={example.payee}>
                    <TableCell>{example.payee}</TableCell>
                    <TableCell>{example.file}</TableCell>
                    <TableCell sx={{ color: example.usual === undefined ? 'text.secondary' : undefined }}>{example.usual ?? 'Nothing yet'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Box>
            <Typography id="categories-question">For new transactions, use:</Typography>
            <RadioGroup aria-labelledby="categories-question" value={source} onChange={event => setSource(event.target.value as CategorySource)}>
              <FormControlLabel value="file" control={<Radio size="small" />} sx={{ alignItems: 'flex-start' }}
                label={<Choice title="The file’s categories" detail="Where the file gives one your ledger has; otherwise the payee’s usual category." />} />
              <FormControlLabel value="payee" control={<Radio size="small" />} sx={{ alignItems: 'flex-start' }}
                label={<Choice title="My usual category for each payee" detail="The file’s categories aren’t used." />} />
            </RadioGroup>
          </Box>

          <FormControlLabel
            control={<Checkbox size="small" checked={remember} onChange={event => setRemember(event.target.checked)} />}
            label={`Remember this for files from “${input.sourceLabel}”`} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>{changing ? 'Cancel' : 'Cancel Import'}</Button>
        <Button type="submit" variant="contained" disabled={source === ''}>{changing ? 'Save' : 'Continue'}</Button>
      </DialogActions>
    </form>
  )
}

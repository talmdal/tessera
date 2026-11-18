// A question a reader raised that nothing saved could answer — a QIF file's date order, the currency of a
// file that names none — and the one the import flow asks when a file holds several accounts. One dialog, by
// the question's kind: a choice is a list with a radio beside each option; a currency is three letters.
import { useState } from 'react'
import type { DialogProps, Json } from '@tessera/types'
import type { QuestionDialogInput } from '@tessera/exchange-api'
import {
  Button, DialogActions, DialogContent, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography
} from '@tessera/ui'

export default function QuestionDialog({ input, close }: DialogProps<QuestionDialogInput, Json>) {
  const { question } = input
  const [choice, setChoice] = useState<string>(() =>
    question.kind === 'choice' ? indexOfSuggested(question) : '')
  const [text, setText] = useState<string>(() =>
    question.kind === 'currency' ? (question.suggested ?? '') : '')

  if (question.kind === 'choice') {
    const chosen = choice === '' ? undefined : question.options[Number(choice)]
    return (
      <>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h2">{question.title}</Typography>
          {question.detail && <Typography variant="body2" color="text.secondary">{question.detail}</Typography>}
          <RadioGroup value={choice} onChange={event => setChoice(event.target.value)} aria-label={question.title}>
            {question.options.map((option, at) => (
              <FormControlLabel key={at} value={String(at)} control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">{option.label}</Typography>
                    {option.detail && <Typography variant="caption" color="text.secondary">{option.detail}</Typography>}
                  </Stack>
                } />
            ))}
          </RadioGroup>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="contained" disabled={chosen === undefined} onClick={() => chosen && close(chosen.value)} data-question-ok>OK</Button>
        </DialogActions>
      </>
    )
  }

  if (question.kind === 'currency') {
    const valid = /^[A-Za-z]{3}$/.test(text.trim())
    return (
      <>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="subtitle1" component="h2">{question.title}</Typography>
          {question.detail && <Typography variant="body2" color="text.secondary">{question.detail}</Typography>}
          <TextField size="small" label="Currency" value={text} autoFocus
            onChange={event => setText(event.target.value.toUpperCase())}
            helperText="The three-letter code: CAD, USD, EUR"
            slotProps={{ htmlInput: { 'aria-label': 'Currency', maxLength: 3 } }}
            onKeyDown={event => { if (event.key === 'Enter' && valid) close(text.trim().toUpperCase()) }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="contained" disabled={!valid} onClick={() => close(text.trim().toUpperCase())} data-question-ok>OK</Button>
        </DialogActions>
      </>
    )
  }

  // A CSV profile or an account question is answered elsewhere; nothing here can
  return (
    <>
      <DialogContent dividers>
        <Typography variant="subtitle1" component="h2">{question.title}</Typography>
        <Typography variant="body2" color="text.secondary">This question cannot be answered here yet.</Typography>
      </DialogContent>
      <DialogActions><Button onClick={() => close()}>Cancel</Button></DialogActions>
    </>
  )
}

function indexOfSuggested(question: Extract<QuestionDialogInput['question'], { kind: 'choice' }>): string {
  const at = question.options.findIndex(option => option.value === question.suggested)
  return at === -1 ? '' : String(at)
}

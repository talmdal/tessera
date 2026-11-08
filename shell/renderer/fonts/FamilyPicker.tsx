// shell/renderer/fonts/FamilyPicker.tsx — choosing a font family for a role: Automatic, one of the system's generic
// families, an installed font (each drawn in its own face), or a name typed in.
import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { Autocomplete, TextField } from '@tessera/ui'
import { familyListProblem } from '../../../shared/fonts/families'
import type { InstalledFonts } from '../../../shared/fonts/types'

/** An entry in the list: Automatic (no family of the role's own), a generic family, or an installed font. */
interface FamilyOption {
  group: 'Automatic' | 'System fonts' | 'Installed on this computer'
  label: string
  names: string[] | null
}

/** The system's generic families, by what they are, not their CSS name. */
const GENERIC_OPTIONS: FamilyOption[] = [
  { group: 'System fonts', label: 'System interface font (system-ui)', names: ['system-ui'] },
  { group: 'System fonts', label: 'System sans-serif (sans-serif)', names: ['sans-serif'] },
  { group: 'System fonts', label: 'System serif (serif)', names: ['serif'] },
  { group: 'System fonts', label: 'System fixed-width (monospace)', names: ['monospace'] }
]

/** How a family list reads in the box: its names, most wanted first. A name with a comma can't exist (see NAME). */
export const familyText = (names: readonly string[] | null) => names ? names.join(', ') : ''

/**
 * What was typed, read as a family list: blank is Automatic (`null`); otherwise names separated by commas, each of
 * which must pass the shell's name rule.
 */
export function readFamilyText(text: string): { names: string[] | null, problem?: string } {
  if (text.trim() === '') return { names: null }
  const names = text.split(',').map(name => name.trim()).filter(Boolean)
  const problem = familyListProblem(names)
  return problem ? { names: null, problem: `This ${problem}.` } : { names }
}

const sameNames = (a: readonly string[] | null, b: readonly string[] | null) => familyText(a) === familyText(b)

export interface FamilyPickerProps {
  /** Names the box, for assistive technology and the label above it. */
  label: string
  value: string[] | null
  /** What Automatic gives now, and why: "Inter (follows Interface text)". */
  automatic: string
  installed: InstalledFonts
  disabled?: boolean
  onChange(next: string[] | null): void
  /** False while what is typed isn't a family list the shell would accept. */
  onValidityChange(valid: boolean): void
  /** Ids of elements that describe the box (the role's sources line). */
  describedBy?: string
}

/**
 * The font of one role. Choosing from the list or typing both change the draft at once (the dialog applies it on OK
 * or Apply); what is typed is checked against the shell's name rule as it is typed, and a name that fails it marks
 * the box and makes the page invalid.
 */
export function FamilyPicker({ label, value, automatic, installed, disabled, onChange, onValidityChange, describedBy }: FamilyPickerProps) {
  const [text, setText] = useState(familyText(value))
  const [problem, setProblem] = useState<string | undefined>()
  /** True after the user typed, until a family is chosen from the list: only then does the list filter. */
  const [typing, setTyping] = useState(false)

  // A value changed from outside (Reset, Restore Defaults, another window) replaces what was typed
  const shown = useRef(value)
  useEffect(() => {
    if (sameNames(shown.current, value)) return
    shown.current = value
    setText(familyText(value))
    setProblem(undefined)
    setTyping(false)
  }, [value])

  useEffect(() => { onValidityChange(problem === undefined) }, [problem, onValidityChange])

  const commit = (names: string[] | null) => {
    shown.current = names
    if (!sameNames(names, value)) onChange(names)
  }

  const type = (typed: string) => {
    setText(typed)
    setTyping(true)
    const read = readFamilyText(typed)
    setProblem(read.problem)
    if (!read.problem) commit(read.names)
  }

  const options: FamilyOption[] = [
    { group: 'Automatic', label: `Automatic: ${automatic}`, names: null },
    ...GENERIC_OPTIONS,
    ...installed.families.map(name => ({ group: 'Installed on this computer' as const, label: name, names: [name] }))
  ]

  return (
    <Autocomplete<FamilyOption, false, false, true>
      freeSolo
      options={options}
      groupBy={option => option.group}
      getOptionLabel={option => typeof option === 'string' ? option : familyText(option.names)}
      // Opened, the list shows everything; once the user types, the fonts whose names contain what is typed (Automatic
      // stays, so it is always one choice away)
      filterOptions={all => {
        const query = text.trim().toLowerCase()
        return !typing || query === '' ? all : all.filter(o => o.names === null || o.label.toLowerCase().includes(query))
      }}
      value={null}
      inputValue={text}
      onInputChange={(_event, typed, reason) => { if (reason === 'input' || reason === 'clear') type(typed) }}
      onChange={(_event, chosen) => {
        if (chosen === null) return
        if (typeof chosen === 'string') { type(chosen); return }
        setText(familyText(chosen.names))
        setProblem(undefined)
        setTyping(false)
        commit(chosen.names)
      }}
      disabled={disabled}
      renderOption={({ key, ...props }, option) => (
        <FamilyOptionItem key={key} props={props} option={option} />
      )}
      renderInput={params => (
        <TextField {...params} label={label} placeholder={`Automatic: ${automatic}`}
          error={problem !== undefined} helperText={problem}
          slotProps={{ ...params.slotProps, inputLabel: { ...params.slotProps.inputLabel, shrink: true }, htmlInput: { ...params.slotProps.htmlInput, 'aria-describedby': describedBy } }} />
      )}
    />
  )
}

/**
 * An option in the list. An installed font is drawn in its own face, but only once it is on screen: drawing a
 * thousand faces at once made opening the list take seconds (docs/font-roles-design.md#phase-0-results).
 */
function FamilyOptionItem({ props, option }: { props: HTMLAttributes<HTMLLIElement>, option: FamilyOption }) {
  const ref = useRef<HTMLLIElement>(null)
  const ownFace = option.group === 'Installed on this computer'
  const [seen, setSeen] = useState(() => ownFace && typeof IntersectionObserver === 'undefined')
  // The system's generic families cost nothing to draw: each in itself, at once
  const generic = option.group === 'System fonts' ? option.names![0] : undefined
  useEffect(() => {
    const element = ref.current
    if (!ownFace || seen || !element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setSeen(true); observer.disconnect() } })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ownFace, seen])
  // The name is a font family the shell accepts (the list only holds those), so it is safe in a style attribute
  const face = generic ?? (seen ? `"${option.label}", system-ui, sans-serif` : undefined)
  return <li ref={ref} {...props} data-family={option.names?.join(', ') ?? 'automatic'} style={face ? { fontFamily: face } : undefined}>{option.label}</li>
}

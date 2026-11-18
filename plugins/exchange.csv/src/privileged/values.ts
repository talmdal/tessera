// CSV's dates and amounts live in `@tessera/exchange-api`, not here, because the mapping dialog's live preview
// has to call the very same functions this reader does — a preview that could disagree with the import it is
// predicting would be worse than no preview at all. Re-exported so this plugin's own modules and tests read
// naturally; there is no second copy of the arithmetic.
export { expandYear, parseCsvAmount, parseCsvDate, type AmountResult } from '@tessera/exchange-api'

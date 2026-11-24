// @tessera/ui/charts: the charts plugins may draw, in the theme's chart palette and font roles. A second entry of
// @tessera/ui, shared with plugins by the shell as its own singleton and loaded the first time a view imports it, so
// the window's start-up doesn't pay for charts (docs/reporting-design.md, "Reports and @tessera/ui"). Curated: no MUI X
// export reaches a plugin, so what draws the charts can change without any plugin changing.
import '../palette'

export { Chart } from './Chart'
export type { ChartKind, ChartProps, ChartSeries } from './Chart'

/** The version of @tessera/ui this entry belongs to. */
export { TESSERA_UI_VERSION } from '../version'

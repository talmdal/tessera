// The chart page: `window.render(props, mode, theme?)` draws `Chart` in the shell's own theme (or another) and answers
// what the browser drew: the colours of the series' shapes, the text's colour and font, and the label.
import { createRoot, type Root } from 'react-dom/client'
import { CssBaseline, ThemeProvider } from '@mui/material'
import type { ThemeDescriptor } from '@tessera/types'
import { Chart, type ChartProps } from '@tessera/ui/charts'
import { createShellTheme } from '../../../shell/renderer/theme/createShellTheme'
import { DEFAULT_THEME } from '../../../shared/theme/types'

let root: Root | undefined
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** What the test passes: a function can't cross into the page, so `format: 'money'` stands for one formatting cents. */
type PageProps = Omit<ChartProps, 'format'> & { format?: 'money' }

declare global { interface Window { render(props: PageProps, mode: 'light' | 'dark', theme?: ThemeDescriptor): Promise<unknown> } }

const money = (value: number) => `$${(value / 100).toFixed(2)}`

window.render = async ({ format, ...rest }, mode, descriptor = DEFAULT_THEME) => {
  const props: ChartProps = { ...rest, ...(format === 'money' && { format: money }) }
  root?.unmount()
  const element = document.getElementById('root')!
  root = createRoot(element)
  const theme = createShellTheme(descriptor, mode)
  document.body.style.background = theme.palette.background.paper
  const started = performance.now()
  root.render(<ThemeProvider theme={theme}><CssBaseline /><div style={{ width: 900, padding: 16 }}><Chart {...props} /></div></ThemeProvider>)
  for (let i = 0; i < 200 && !element.querySelector('svg path, svg rect'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  await frame()
  const ms = performance.now() - started
  const figure = element.querySelector('[role="figure"]')
  const colors = (selector: string, attribute: 'fill' | 'stroke') =>
    [...new Set([...element.querySelectorAll(selector)].map(e => getComputedStyle(e)[attribute]).filter(c => c && c !== 'none' && c !== 'rgba(0, 0, 0, 0)'))]
  const tick = element.querySelector('.MuiChartsAxis-tickLabel') as Element | null
  const legend = element.querySelector('.MuiChartsLegend-label') as Element | null
  return {
    ms,
    label: figure?.getAttribute('aria-label'),
    kind: figure?.getAttribute('data-chart'),
    bars: element.querySelectorAll('.MuiBarChart-element').length,
    barColors: colors('.MuiBarChart-element', 'fill'),
    lines: element.querySelectorAll('.MuiLineChart-line').length,
    lineColors: colors('.MuiLineChart-line', 'stroke'),
    areaColors: colors('.MuiLineChart-area', 'fill'),
    slices: element.querySelectorAll('.MuiPieChart-arc').length,
    sliceColors: colors('.MuiPieChart-arc', 'fill'),
    ticks: [...element.querySelectorAll('.MuiChartsAxis-tickLabel')].map(e => e.textContent),
    legendText: [...element.querySelectorAll('.MuiChartsLegend-label')].map(e => e.textContent),
    tickFill: tick ? getComputedStyle(tick).fill : undefined,
    tickFont: tick ? getComputedStyle(tick).fontFamily : undefined,
    legendFont: legend ? getComputedStyle(legend).fontFamily : undefined,
    theme: { textSecondary: theme.palette.text.secondary, caption: theme.typography.caption.fontFamily, chart: theme.palette.chart, success: theme.palette.success.main, error: theme.palette.error.main, text: theme.palette.text.primary }
  }
}

// A result's chart, as @tessera/ui/charts draws it: its kind, categories and series, each series in the colour of
// what it means (money in, money out, the net over them) or the palette's next, figures formatted from minor units,
// and the chart told in words for screen readers. Nothing is added up here: the series are the engine's.
import type { ReportResult, ResultChart } from '@tessera/reports-api'
import { axisAmount, money, percent } from './display'

/** What @tessera/ui/charts's `Chart` takes, less its functions (made by the view): so this stays plain data. */
export interface ChartModel {
  kind: ResultChart['kind']
  categories: string[]
  series: { key: string, label: string, values: (number | null)[], as?: 'bar' | 'line', stack?: string, tone?: 'positive' | 'negative' | 'emphasis' }[]
  horizontal: boolean
  label: string
}

/** Series whose colour says what they are: money in and what is owned, money out and what is owed. */
const POSITIVE = new Set(['income', 'transferIn', 'moneyIn', 'asset'])
const NEGATIVE = new Set(['expense', 'transferOut', 'moneyOut', 'liability'])

export function toneOf(series: Pick<ResultChart['series'][number], 'key' | 'as'>, kind: ResultChart['kind']): ChartModel['series'][number]['tone'] {
  if (POSITIVE.has(series.key)) return 'positive'
  if (NEGATIVE.has(series.key)) return 'negative'
  // A net or total drawn over bars: in the text colour, so it stands apart from every series
  const bars = kind === 'bar' || kind === 'groupedBar' || kind === 'stackedBar'
  if (bars && series.as === 'line' && (series.key === 'total' || series.key.startsWith('net:'))) return 'emphasis'
  return undefined
}

const KIND_WORDS: Record<ResultChart['kind'], string> = {
  bar: 'bar chart', groupedBar: 'bar chart', stackedBar: 'stacked bar chart', line: 'line chart', area: 'area chart', donut: 'donut chart'
}

/** The most figures a label reads out: past it, the label says how many more there are. */
const SPOKEN_MAX = 12

/**
 * The chart in words: "Spending by Category, donut chart: Housing 45.2 %, Food 24.2 %, …"; for series over time, each
 * series' latest figure. Every figure is also in the table; this is so the chart itself isn't silent.
 */
export function chartLabel(result: Pick<ReportResult, 'title' | 'currency'>, chart: ResultChart): string {
  const say = (value: number | null) => value === null ? 'none' : chart.unit === 'count' ? value.toLocaleString() : money(value, result.currency)
  let parts: string[]
  if (chart.kind === 'donut') {
    const values = chart.series[0]?.values ?? []
    const whole = values.reduce<number>((a, v) => a + (v !== null && v > 0 ? v : 0), 0)
    parts = chart.categories.map((c, i) => {
      const v = values[i] ?? null
      return whole > 0 && v !== null && v > 0 ? `${c} ${percent(Math.trunc(v * 10000 / whole))}` : `${c} ${say(v)}`
    })
  } else if (chart.series.length === 1) {
    parts = chart.categories.map((c, i) => `${c} ${say(chart.series[0].values[i] ?? null)}`)
  } else {
    const last = chart.categories.length - 1
    parts = chart.series.map(s => `${s.label} ${say(s.values[last] ?? null)}${last >= 0 ? ` in ${chart.categories[last]}` : ''}`)
  }
  const spoken = parts.slice(0, SPOKEN_MAX)
  if (parts.length > SPOKEN_MAX) spoken.push(`and ${parts.length - SPOKEN_MAX} more`)
  return `${result.title}, ${KIND_WORDS[chart.kind]}: ${spoken.join(', ')}`
}

export function chartModel(result: ReportResult): ChartModel | undefined {
  const chart = result.chart
  if (!chart || chart.categories.length === 0 || chart.series.length === 0) return undefined
  return {
    kind: chart.kind,
    categories: [...chart.categories],
    series: chart.series.map(s => {
      const tone = toneOf(s, chart.kind)
      return { key: s.key, label: s.label, values: [...s.values], ...(s.as && { as: s.as }), ...(s.stack && { stack: s.stack }), ...(tone && { tone }) }
    }),
    horizontal: chart.horizontal === true,
    label: chartLabel(result, chart)
  }
}

/** How the chart's figures read: in its tooltips, and on its value axis, in short. */
export function chartFormats(result: Pick<ReportResult, 'currency'>, unit: ResultChart['unit']) {
  return unit === 'count'
    ? { format: (v: number) => v.toLocaleString(), formatAxis: (v: number) => v.toLocaleString() }
    : { format: (v: number) => money(v, result.currency), formatAxis: (v: number) => axisAmount(v, result.currency) }
}

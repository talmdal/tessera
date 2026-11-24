// A chart, as every plugin draws one: bars (grouped or stacked), lines, areas, bars with a line over them, or a donut,
// in the theme's chart palette and font roles, with a tooltip, a legend and a label for screen readers. Drawn with MUI X
// Charts (its free MIT package), which no plugin imports: this is the one way in, so what draws the charts can change
// without any plugin changing. See docs/reporting-design.md, "Charts".
import { useMemo } from 'react'
import { Box, useTheme, type Theme } from '@mui/material'
import { BarPlot } from '@mui/x-charts/BarChart'
import { ChartsAxisHighlight } from '@mui/x-charts/ChartsAxisHighlight'
import { ChartsDataProvider } from '@mui/x-charts/ChartsDataProvider'
import { ChartsGrid } from '@mui/x-charts/ChartsGrid'
import { ChartsLegend } from '@mui/x-charts/ChartsLegend'
import { ChartsSurface } from '@mui/x-charts/ChartsSurface'
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip'
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper'
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis'
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis'
import { AreaPlot, LinePlot, MarkPlot } from '@mui/x-charts/LineChart'
import { PieChart } from '@mui/x-charts/PieChart'

export type ChartKind = 'bar' | 'stackedBar' | 'groupedBar' | 'line' | 'area' | 'donut'

export interface ChartSeries {
  key: string
  label: string
  /** One per category; null leaves a gap. In the caller's units (minor units, for money): `format` says how they read. */
  values: (number | null)[]
  /** Over a chart of bars, a series drawn as a line instead (the net, a total). */
  as?: 'bar' | 'line'
  /** Series with the same stack are stacked (a stacked bar or area chart). */
  stack?: string
  /**
   * What the series means, when it has a colour of its own: money in ('positive', the theme's success colour), money out
   * ('negative', its error colour), or a total drawn over the rest ('emphasis', the text colour). Else the palette's
   * next colour.
   */
  tone?: 'positive' | 'negative' | 'emphasis'
}

export interface ChartProps {
  kind: ChartKind
  /** The x axis (bars and lines), the y axis (horizontal bars), or the slices (a donut). */
  categories: string[]
  series: ChartSeries[]
  /** Bars along the y axis, for long labels (payees). */
  horizontal?: boolean
  /** How a value reads, in a tooltip and on the value axis: "$1,234.50". Default: the number as it is. */
  format?: (value: number) => string
  /** The value axis's ticks, if they should read shorter than `format` ("$1.2k"). Default: `format`. */
  formatAxis?: (value: number) => string
  /** What the chart shows, in words, for screen readers: "Spending by Category, donut chart: Housing 45.2 %, …". */
  label: string
  /** Pixels. The width is the container's. */
  height?: number
}

/** The colour each series is drawn in: its tone's, or the palette's next. */
function seriesColors(series: readonly ChartSeries[], theme: Theme): string[] {
  const palette = theme.palette.chart ?? []
  let next = 0
  return series.map(s => s.tone === 'positive' ? theme.palette.success.main
    : s.tone === 'negative' ? theme.palette.error.main
      : s.tone === 'emphasis' ? theme.palette.text.primary
        : palette[next++ % Math.max(1, palette.length)] ?? theme.palette.primary.main)
}

export function Chart({ kind, categories, series, horizontal = false, format, formatAxis, label, height = 280 }: ChartProps) {
  const theme = useTheme<Theme>()
  const show = format ?? ((value: number) => String(value))
  const colors = useMemo(() => seriesColors(series, theme), [series, theme])
  // Text in the font roles: axes and the legend in Small text, the figures in Amounts and figures
  const small = { fontFamily: theme.typography.caption.fontFamily, fontSize: theme.typography.caption.fontSize, fill: theme.palette.text.secondary }

  if (kind === 'donut') {
    const slices = categories.flatMap((category, i) => {
      const value = series[0]?.values[i]
      // A slice is a share of a whole: nothing, or less than nothing, has none
      return value !== null && value !== undefined && value > 0
        ? [{ id: i, label: category, value, color: theme.palette.chart?.[i % (theme.palette.chart?.length || 1)] ?? theme.palette.primary.main }]
        : []
    })
    return (
      <Box role="figure" aria-label={label} data-chart="donut" sx={{ width: '100%', '& text': { fontFamily: small.fontFamily } }}>
        <PieChart
          height={height}
          skipAnimation
          series={[{ data: slices, innerRadius: '55%', outerRadius: '90%', paddingAngle: 0.5, valueFormatter: item => show(item.value) }]}
          slotProps={{ legend: { direction: 'vertical', position: { vertical: 'middle', horizontal: 'end' } } }}
        />
      </Box>
    )
  }

  const bars = kind === 'bar' || kind === 'stackedBar' || kind === 'groupedBar'
  const stacked = kind === 'stackedBar' || kind === 'area'
  const mui = series.map((s, i) => {
    const asLine = !bars || s.as === 'line'
    const common = {
      id: s.key, label: s.label, data: s.values, color: colors[i],
      valueFormatter: (value: number | null) => value === null ? '—' : show(value),
      ...(stacked && s.as !== 'line' && { stack: s.stack ?? 'all' })
    }
    return asLine
      // Straight from point to point: a curve between two months would show figures that never were
      ? { ...common, type: 'line' as const, curve: 'linear' as const, showMark: false, connectNulls: false, ...(kind === 'area' && s.as !== 'line' && { area: true }) }
      : { ...common, type: 'bar' as const, ...(horizontal && { layout: 'horizontal' as const }) }
  })
  const band = { id: 'categories', scaleType: 'band' as const, data: categories, tickLabelStyle: small }
  const values = { id: 'values', valueFormatter: (value: number) => (formatAxis ?? show)(value), tickLabelStyle: small }
  // The axis down the side is as wide as its labels: amounts, or (horizontal bars) payees and categories
  const side = { width: 'auto' as const }
  const hasBars = mui.some(s => s.type === 'bar')
  const hasLines = mui.some(s => s.type === 'line')
  // Lines alone run point to point; with bars, they run through the bars' middles
  const categoryAxis = hasBars ? band : { ...band, scaleType: 'point' as const }

  return (
    <Box role="figure" aria-label={label} data-chart={kind} sx={{ width: '100%', '& .MuiChartsLegend-label': { fontFamily: small.fontFamily, fontSize: small.fontSize } }}>
      <ChartsDataProvider
        series={mui}
        xAxis={[horizontal ? values : categoryAxis]}
        yAxis={[{ ...(horizontal ? categoryAxis : values), ...side }]}
        height={height}
        skipAnimation
      >
        <ChartsWrapper legendPosition={{ vertical: 'top', horizontal: 'start' }} hideLegend={series.length < 2}>
          {series.length > 1 && <ChartsLegend />}
          <ChartsSurface>
            <ChartsGrid {...(horizontal ? { vertical: true } : { horizontal: true })} />
            {hasBars && <BarPlot />}
            {hasLines && <AreaPlot />}
            {hasLines && <LinePlot />}
            {hasLines && <MarkPlot />}
            <ChartsAxisHighlight {...(horizontal ? { y: 'band' as const } : { x: hasBars ? 'band' as const : 'line' as const })} />
            <ChartsXAxis />
            <ChartsYAxis />
          </ChartsSurface>
          <ChartsTooltip />
        </ChartsWrapper>
      </ChartsDataProvider>
    </Box>
  )
}

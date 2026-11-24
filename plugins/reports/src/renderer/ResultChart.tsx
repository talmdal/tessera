// A result's chart, drawn by @tessera/ui/charts. The view loads this module lazily, so the charts' entry (MUI X Charts)
// is loaded the first time a chart is drawn, not when the window opens.
import { Chart } from '@tessera/ui/charts'
import type { ReportResult } from '@tessera/reports-api'
import { chartFormats, type ChartModel } from './chartModel'

export default function ResultChart({ model, result, height }: { model: ChartModel, result: ReportResult, height?: number }) {
  const formats = chartFormats(result, result.chart?.unit ?? 'money')
  return (
    <Chart
      kind={model.kind} categories={model.categories} series={model.series} horizontal={model.horizontal} label={model.label}
      format={formats.format} formatAxis={formats.formatAxis} {...(height !== undefined && { height })}
    />
  )
}

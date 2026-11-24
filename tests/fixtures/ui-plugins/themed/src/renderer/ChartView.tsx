import { Chart } from '@tessera/ui/charts'
import { TESSERA_UI_VERSION } from '@tessera/ui'

/** A view drawing a chart, the way a plugin should: from @tessera/ui/charts, which the shell shares. */
export default function ChartView() {
  return (
    <div data-testid="chart-view" data-version={TESSERA_UI_VERSION}>
      <Chart kind="bar" categories={['Jan', 'Feb']} series={[{ key: 'a', label: 'Spending', values: [100, 200] }]} label="Spending, bar chart" />
    </div>
  )
}

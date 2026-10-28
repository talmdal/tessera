// plugins/layout.sample/src/renderer/Detail.tsx
//
// The second main-area page. The privileged side reveals it after a ping, so
// the content area visibly changes in response to a bar's button.
import { COMMANDS } from '../shared'
import { useTestLayoutState } from './useTestLayoutState'

export default function Detail() {
  const state = useTestLayoutState()
  const last = state?.last

  // Going back runs one of the plugin's own commands, which reveals the dashboard.
  const back = () => {
    window.api.invoke('shell:commands.execute', { id: COMMANDS.showDashboard })
      .catch(err => console.error('[layout-sample] could not show the dashboard', err))
  }

  return (
    <div data-sample-page="detail">
      <h1>Ping received</h1>
      {last
        ? <p>
            The <strong data-sample-last-side>{last.side}</strong> bar's button was pressed at{' '}
            <time dateTime={new Date(last.at).toISOString()}>{new Date(last.at).toLocaleTimeString()}</time>.
            That bar has been pressed <strong>{state!.counts[last.side]}</strong>{' '}
            {state!.counts[last.side] === 1 ? 'time' : 'times'}; {state!.total} in all.
          </p>
        : <p>No bar has been pressed yet.</p>}
      <p>
        <button type="button" onClick={back}>Back to the dashboard</button>
      </p>
    </div>
  )
}
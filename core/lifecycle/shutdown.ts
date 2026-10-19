// core/lifecycle/shutdown.ts
import { AppLifecycle, ShutdownReason } from './AppLifecycle'

/**
 * The shutdown sequence: ShuttingDown listeners, then every plugin's
 * deactivation (dependents before providers), then ShutDown.
 * Resolves `false`, with nothing deactivated, if a listener vetoed.
 */
export async function shutdownApp(
  lifecycle: AppLifecycle,
  plugins: { deactivateAll(): Promise<void> },
  reason: ShutdownReason = 'user'
): Promise<boolean> {
  if (!(await lifecycle.requestShutdown(reason))) return false

  await plugins.deactivateAll()
  await lifecycle.markShutDown()
  return true
}

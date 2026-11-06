import { act } from '@testing-library/react'

/**
 * Lets whatever the UI has started finish inside act(...): replies to requests a fake bridge has already answered (a
 * component's load when it mounts, say) and the renders they cause. Without it, a test that ends straight after
 * rendering leaves that update to land after it, outside act, and tests/setup/setupTests.ts fails the test.
 *
 * Use it when there is nothing visible to wait for, such as a load whose answer matches what is already drawn. When
 * the update changes what the user sees, wait for that instead (findBy…, waitFor): it says what the test expects.
 * It waits one macrotask, so it doesn't work under fake timers.
 */
export async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

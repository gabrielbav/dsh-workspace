/** Ask the stack's plugin whether a session's code folder holds work that was not pushed. */

/** The address the stack offers; a harness without the stack's plugin answers 404. */
export const UNPUSHED_PATH = '/agentic-stack-assets/code/unpushed'

/** How long the dialog waits for the answer; the stack itself answers within 5 seconds. */
const WAIT_MS = 6000

/**
 * @param sessionId Session the dialog is about.
 * @param ask The page's `fetch`, or a test's own.
 * @returns true only when the stack answered `warn: true`; any other answer or failure is false.
 */
export async function hasUnpushedWork(sessionId: string, ask: typeof fetch = (...args) => fetch(...args)): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, WAIT_MS)
  try {
    const response = await ask(`${UNPUSHED_PATH}?session=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', signal: abort.signal })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && (body as { warn?: unknown }).warn === true
  } catch (error) {
    void error
    return false
  } finally {
    clearTimeout(timer)
  }
}

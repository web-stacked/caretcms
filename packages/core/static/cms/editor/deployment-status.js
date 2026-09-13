/** @typedef {'saving' | 'idle' | 'error'} ToolbarStatusState */
/**
 * @typedef {object} DeploymentStatusResponse
 * @property {boolean} configured
 * @property {'deploying' | 'live' | 'failed' | 'unknown'} state
 * @property {unknown} [target]
 * @property {unknown} [buildId]
 */

/**
 * Poll the authenticated deployment route and translate provider states into
 * the toolbar's small status surface.
 *
 * @param {{
 *   fetchStatus: () => Promise<Response>,
 *   setStatus: (state: ToolbarStatusState, text: string) => void,
 *   setBuildId: (buildId: string | null) => void,
 *   pollDelayMs?: number,
 *   setTimer?: (callback: () => void, delay: number) => number,
 *   clearTimer?: (timer: number) => void,
 * }} options
 */
export function createDeploymentStatusPoller(options) {
  const pollDelayMs = options.pollDelayMs ?? 1000;
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  let timer = 0;

  function stop() {
    if (timer) clearTimer(timer);
    timer = 0;
  }

  function schedule() {
    stop();
    timer = setTimer(() => { void refresh(); }, pollDelayMs);
  }

  async function refresh() {
    try {
      const response = await options.fetchStatus();
      if (!response.ok) return;
      const data = /** @type {DeploymentStatusResponse} */ (await response.json());
      if (!data.configured || !data.target) return;
      options.setBuildId(typeof data.buildId === 'string' ? data.buildId : null);
      if (data.state === 'deploying') {
        options.setStatus('saving', 'Deploying…');
        schedule();
      } else if (data.state === 'live') {
        stop();
        options.setStatus('idle', 'Live');
      } else if (data.state === 'failed') {
        stop();
        options.setStatus('error', 'Deploy failed');
      } else {
        stop();
        options.setStatus('error', 'Deploy status unknown');
      }
    } catch {
      // A transient status lookup must not turn a successful content save into
      // an error. A reload or a scheduled in-flight check can retry later.
    }
  }

  return { refresh, schedule, stop };
}

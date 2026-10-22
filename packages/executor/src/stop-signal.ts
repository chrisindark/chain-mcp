/** A per-request stop signal with a total time budget. */
export interface StopSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Combines the caller's cancellation with a total timeout.
 *
 * The timer is unref'd so a pending budget cannot keep the process alive.
 */
export function createStopSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): StopSignal {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = (): void => controller.abort(parent?.reason);
  if (parent !== undefined) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Upstream timeout"));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

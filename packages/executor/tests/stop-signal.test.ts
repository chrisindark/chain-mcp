import { describe, expect, it } from "vitest";

import { createStopSignal } from "../src/stop-signal.js";

describe("createStopSignal", () => {
  it("aborts and reports timedOut when the budget elapses", async () => {
    const stop = createStopSignal(undefined, 15);
    expect(stop.timedOut()).toBe(false);
    expect(stop.signal.aborted).toBe(false);

    await new Promise<void>((resolve) => {
      stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(stop.timedOut()).toBe(true);
    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(Error);
    stop.dispose();
  });

  it("propagates parent cancellation without marking a timeout", () => {
    const parent = new AbortController();
    const stop = createStopSignal(parent.signal, 10_000);
    const reason = new Error("caller cancelled");
    parent.abort(reason);

    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBe(reason);
    expect(stop.timedOut()).toBe(false);
    stop.dispose();
  });

  it("starts already aborted for a pre-aborted parent", () => {
    const parent = new AbortController();
    parent.abort();
    const stop = createStopSignal(parent.signal, 10_000);

    expect(stop.signal.aborted).toBe(true);
    expect(stop.timedOut()).toBe(false);
    stop.dispose();
  });

  it("dispose cancels the pending budget and detaches the parent", async () => {
    const parent = new AbortController();
    const stop = createStopSignal(parent.signal, 15);
    stop.dispose();

    parent.abort();
    expect(stop.signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stop.signal.aborted).toBe(false);
    expect(stop.timedOut()).toBe(false);
  });
});

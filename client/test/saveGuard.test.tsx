import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSaveGuard } from "../src/hooks/useSaveGuard";

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSaveGuard", () => {
  it("drops a second save while the first is still in flight", async () => {
    const gate = deferred<void>();
    const submit = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useSaveGuard());

    // Both taps happen before the first request comes back — the case a
    // `saving` state alone does not cover, because neither tap has re-rendered.
    act(() => {
      void result.current.save({ amount: 120 }, submit);
      void result.current.save({ amount: 120 }, submit);
    });

    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it("reports saving while in flight and stops when it lands", async () => {
    const gate = deferred<void>();
    const { result } = renderHook(() => useSaveGuard());

    act(() => {
      void result.current.save({ amount: 120 }, () => gate.promise);
    });
    await waitFor(() => expect(result.current.saving).toBe(true));

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(result.current.saving).toBe(false));
  });

  it("reuses the key when the same payload is retried after a failure", async () => {
    const keys: string[] = [];
    const { result } = renderHook(() => useSaveGuard());

    await act(async () => {
      await result.current.save({ amount: 120 }, async (key) => {
        keys.push(key);
        throw new Error("network");
      }).catch(() => {});
    });
    await act(async () => {
      await result.current.save({ amount: 120 }, async (key) => {
        keys.push(key);
      });
    });

    // The retry is the same save, so the server must be able to recognise it
    // as one and answer with the row the first attempt may already have made.
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("issues a new key when the payload changes after a failure", async () => {
    const keys: string[] = [];
    const { result } = renderHook(() => useSaveGuard());

    await act(async () => {
      await result.current.save({ amount: 120 }, async (key) => {
        keys.push(key);
        throw new Error("network");
      }).catch(() => {});
    });
    await act(async () => {
      await result.current.save({ amount: 150 }, async (key) => {
        keys.push(key);
      });
    });

    // A correction typed after the error is a different entry. Deduplicating it
    // against the first attempt would answer with the uncorrected row.
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("issues a new key for the next save after one succeeds", async () => {
    const keys: string[] = [];
    const { result } = renderHook(() => useSaveGuard());

    // Identical payloads, logged twice on purpose — two 120ml bottles.
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await result.current.save({ amount: 120 }, async (key) => {
          keys.push(key);
        });
      });
    }

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("releases the lock after a failed save", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useSaveGuard());

    await act(async () => {
      await result.current.save({ a: 1 }, submit).catch(() => {});
    });
    await act(async () => {
      await result.current.save({ a: 1 }, submit);
    });

    expect(submit).toHaveBeenCalledTimes(2);
    expect(result.current.saving).toBe(false);
  });
});

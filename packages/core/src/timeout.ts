interface TimerHost {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

function timers(): TimerHost {
  return globalThis as unknown as TimerHost;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const host = timers();
  return new Promise((resolve, reject) => {
    const timer = host.setTimeout(() => {
      reject(new Error("detector_timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        host.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        host.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("detector_failed"));
      },
    );
  });
}

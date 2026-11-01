export interface RateObservation {
  readonly key: string;
  readonly nowMs: number;
  readonly windowMs: number;
}

/**
 * Sliding counts for one isolate. `null` means this observation was
 * skipped because the window is over its key budget.
 */
export interface RateWindow {
  observe(input: RateObservation): Promise<number | null>;
}

interface Bucket {
  samples: number[];
  windowMs: number;
}

const maxWindowMs = 300_000;

export function createMemoryRateWindow(options?: {
  readonly maxKeys?: number;
  readonly maxSamples?: number;
}): RateWindow {
  const maxKeys = options?.maxKeys ?? 256;
  const maxSamples = options?.maxSamples ?? 32;
  const buckets = new Map<string, Bucket>();
  return {
    async observe(input) {
      if (
        input.key.length === 0 ||
        !Number.isFinite(input.nowMs) ||
        !Number.isFinite(input.windowMs) ||
        input.windowMs <= 0
      ) {
        return null;
      }
      const windowMs = Math.min(input.windowMs, maxWindowMs);
      let bucket = buckets.get(input.key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          sweep(buckets, input.nowMs);
        }
        if (buckets.size >= maxKeys) {
          return null;
        }
        bucket = { samples: [], windowMs };
        buckets.set(input.key, bucket);
      }
      bucket.windowMs = windowMs;
      const cutoff = input.nowMs - windowMs;
      let index = 0;
      while (index < bucket.samples.length) {
        const sample = bucket.samples[index];
        if (sample === undefined || sample >= cutoff) {
          break;
        }
        index += 1;
      }
      if (index > 0) {
        bucket.samples.splice(0, index);
      }
      if (bucket.samples.length >= maxSamples) {
        bucket.samples.shift();
      }
      bucket.samples.push(input.nowMs);
      return bucket.samples.length;
    },
  };
}

function sweep(buckets: Map<string, Bucket>, nowMs: number): void {
  for (const [key, bucket] of buckets) {
    const newest = bucket.samples[bucket.samples.length - 1];
    if (newest === undefined || newest < nowMs - bucket.windowMs) {
      buckets.delete(key);
    }
  }
}

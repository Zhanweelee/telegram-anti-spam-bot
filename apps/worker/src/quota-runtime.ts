import { createMemoryQuotaStore } from "@tasb/cloud";

/** Free-quota counters for this isolate. A restart clears them. */
export const workerQuota = createMemoryQuotaStore();

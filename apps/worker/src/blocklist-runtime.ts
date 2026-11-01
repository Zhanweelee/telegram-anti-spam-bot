import { createMemoryBlocklistStore } from "@tasb/adapter-memory";

/** Shared identifiers for this isolate. A restart drops them. Opt-in starts off. */
export const workerBlocklist = createMemoryBlocklistStore();

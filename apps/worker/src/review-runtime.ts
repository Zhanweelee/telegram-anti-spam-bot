import { createMemoryReviewQueue } from "@tasb/adapter-memory";

/** Appeal samples for this isolate. A restart drops them when D1 is absent. */
export const workerReview = createMemoryReviewQueue();

import { createMemoryRateWindow } from "@tasb/detector-rate";

/** Isolate-local flood and repeat counts. A restart forgets the window. */
export const workerRateWindow = createMemoryRateWindow();

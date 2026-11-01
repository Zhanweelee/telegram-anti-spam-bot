export interface Clock {
  nowIso(): string;
}

export function createFixedClock(iso: string): Clock {
  return {
    nowIso: () => iso,
  };
}

export function createSystemClock(): Clock {
  return {
    nowIso: () => new Date().toISOString(),
  };
}

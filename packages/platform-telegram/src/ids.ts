export function telegramId(value: string): string | number {
  if (/^-?\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) {
      return numeric;
    }
  }
  return value;
}

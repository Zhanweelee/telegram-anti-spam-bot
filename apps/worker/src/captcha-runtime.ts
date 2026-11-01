import { createMemoryCaptchaStore } from "@tasb/adapter-memory";

export const workerCaptcha = createMemoryCaptchaStore();

export function createCaptchaNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

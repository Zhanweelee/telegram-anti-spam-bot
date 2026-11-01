/** Vitest stand-in for `cloudflare:workers`. Wrangler still loads the real module. */
export class DurableObject {
  constructor(
    protected ctx: unknown,
    protected env: unknown,
  ) {}
}

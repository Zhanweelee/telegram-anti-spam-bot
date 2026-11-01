interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(url: string | URL, base?: string | URL);
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): StatementSync;
  }
  export class StatementSync {
    all(...params: readonly (string | number | null)[]): unknown[];
    run(...params: readonly (string | number | null)[]): unknown;
  }
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}

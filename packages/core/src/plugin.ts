import { z } from "zod";
import type { Decision, DetectorHit } from "./decision.js";
import type { Event } from "./event.js";
import type { Logger } from "./logger.js";
import type { ModerationPort } from "./ports.js";

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export interface CancelSignal {
  readonly aborted: boolean;
}

export interface DetectContext {
  readonly event: Event;
  readonly signal: CancelSignal;
  readonly logger: Logger;
}

export interface Detector {
  readonly kind: "detector";
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly configSchema: z.ZodType;
  detect(ctx: DetectContext): Promise<DetectorHit | null>;
}

export interface ActionContext {
  readonly event: Event;
  readonly decision: Decision;
  readonly dryRun: boolean;
  readonly moderator: ModerationPort;
  readonly logger: Logger;
  readonly signal: CancelSignal;
}

export const actionStatuses = ["executed", "skipped", "failed"] as const;

export interface ActionResult {
  readonly actionId: string;
  readonly status: (typeof actionStatuses)[number];
  readonly detail?: string;
}

export interface Action {
  readonly kind: "action";
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly configSchema: z.ZodType;
  execute(ctx: ActionContext): Promise<ActionResult>;
}

export interface DetectorDefinition<TConfig> {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly configSchema: z.ZodType<TConfig>;
  readonly config: TConfig;
  detect(ctx: DetectContext, config: TConfig): Promise<DetectorHit | null>;
}

export interface ActionDefinition<TConfig> {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly configSchema: z.ZodType<TConfig>;
  readonly config: TConfig;
  execute(ctx: ActionContext, config: TConfig): Promise<ActionResult>;
}

function parsePluginMeta(
  id: string,
  version: string,
): { id: string; version: string } {
  return {
    id: pluginIdSchema.parse(id),
    version: versionSchema.parse(version),
  };
}

export function defineDetector<TConfig>(
  definition: DetectorDefinition<TConfig>,
): Detector {
  const meta = parsePluginMeta(definition.id, definition.version);
  const config = definition.configSchema.parse(definition.config);
  return {
    kind: "detector",
    id: meta.id,
    version: meta.version,
    capabilities: definition.capabilities,
    configSchema: definition.configSchema,
    detect(ctx) {
      return definition.detect(ctx, config);
    },
  };
}

export function defineAction<TConfig>(
  definition: ActionDefinition<TConfig>,
): Action {
  const meta = parsePluginMeta(definition.id, definition.version);
  const config = definition.configSchema.parse(definition.config);
  return {
    kind: "action",
    id: meta.id,
    version: meta.version,
    capabilities: definition.capabilities,
    configSchema: definition.configSchema,
    execute(ctx) {
      return definition.execute(ctx, config);
    },
  };
}

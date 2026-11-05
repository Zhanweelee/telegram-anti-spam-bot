import type { Clock } from "./clock.js";
import {
  type Decision,
  type DecisionAction,
  type DetectorHit,
  detectorHitSchema,
  moreSevere,
  type TextPlace,
} from "./decision.js";
import { PipelineConfigError, RawContentError } from "./errors.js";
import { type Event, parseEvent } from "./event.js";
import type { Evidence } from "./evidence.js";
import { type Logger, wrapLogger } from "./logger.js";
import type { Action, ActionResult, CancelSignal, Detector } from "./plugin.js";
import {
  type ModerationPort,
  parseAuditRecord,
  type Storage,
} from "./ports.js";
import {
  type ExemptReason,
  type PrefilterPolicy,
  prefilter,
  prefilterPolicySchema,
} from "./prefilter.js";
import { assertNoRawContent, redactExactText } from "./privacy.js";
import {
  aggregateScores,
  matchesWhen,
  type Rule,
  type RuleSet,
  type RuleWhen,
  ruleSetSchema,
} from "./rule.js";
import { withTimeout } from "./timeout.js";

export const DEFAULT_DETECTOR_TIMEOUT_MS = 50;

export type FailureMode = "open" | "closed";

export interface DetectorError {
  readonly detectorId: string;
  readonly code:
    | "detector_failed"
    | "detector_timeout"
    | "detector_invalid_hit";
}

export interface PipelineResult {
  readonly eventId: string;
  readonly outcome: "exempt" | "decided";
  readonly exemptReason?: ExemptReason;
  readonly hits: readonly DetectorHit[];
  readonly detectorErrors: readonly DetectorError[];
  readonly decision: Decision;
  readonly actionResults: readonly ActionResult[];
  readonly dryRun: boolean;
}

export interface RunPipelineInput {
  readonly event: Event;
  readonly rules: RuleSet;
  readonly policy: PrefilterPolicy;
  readonly detectors: readonly Detector[];
  readonly actions: readonly Action[];
  readonly storage: Storage;
  readonly moderator: ModerationPort;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly dryRun?: boolean;
  readonly failureMode?: FailureMode;
  readonly detectorTimeoutMs?: number;
}

const allowDecision: Decision = {
  action: "allow",
  ruleIds: [],
  score: 0,
  reasons: [],
  evidence: [],
};

export async function runPipeline(
  input: RunPipelineInput,
): Promise<PipelineResult> {
  const event = parseEvent(input.event);
  const rules = ruleSetSchema.parse(input.rules);
  const policy = prefilterPolicySchema.parse(input.policy);
  const dryRun = input.dryRun ?? false;
  const failureMode = input.failureMode ?? "open";
  const timeoutMs = input.detectorTimeoutMs ?? DEFAULT_DETECTOR_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    throw new PipelineConfigError("invalid_detector_timeout");
  }
  assertUnique(
    input.detectors.map((detector) => detector.id),
    "duplicate_detector",
  );
  assertUnique(
    input.actions.map((action) => action.id),
    "duplicate_action",
  );

  const logger = wrapLogger(input.logger);
  const clock = input.clock ?? { nowIso: () => new Date().toISOString() };
  const rawTexts = eventTexts(event);

  const exemption = prefilter(event, policy);
  if (exemption) {
    logger.info("pipeline_exempt", {
      eventId: event.id,
      tenantId: event.tenantId,
      chatId: event.chatId,
      reason: exemption,
    });
    return {
      eventId: event.id,
      outcome: "exempt",
      exemptReason: exemption,
      hits: [],
      detectorErrors: [],
      decision: allowDecision,
      actionResults: [],
      dryRun,
    };
  }

  const activeRules = rules.rules.filter(
    (rule) => rule.enabled && matchesWhen(rule.when, event),
  );
  const neededIds = uniqueIds(
    activeRules.flatMap((rule) => [...rule.detectorIds]),
  );
  const detectorsById = new Map(
    input.detectors.map((detector) => [detector.id, detector]),
  );
  for (const detectorId of neededIds) {
    if (!detectorsById.has(detectorId)) {
      logger.warn("missing_detector", { detectorId, eventId: event.id });
    }
  }

  const settled = await Promise.all(
    neededIds.map(async (detectorId) => {
      const detector = detectorsById.get(detectorId);
      if (!detector) {
        return { hit: null, error: null };
      }
      return runDetector(detector, event, logger, timeoutMs, failureMode);
    }),
  );

  const hits: DetectorHit[] = [];
  const detectorErrors: DetectorError[] = [];
  for (const item of settled) {
    if (item.error) {
      detectorErrors.push(item.error);
    }
    if (item.hit) {
      hits.push(redactHit(item.hit, rawTexts));
    }
  }
  const hitsById = new Map(hits.map((hit) => [hit.detectorId, hit]));

  const fired: { rule: Rule; score: number }[] = [];
  for (const rule of activeRules) {
    const scores = rule.detectorIds.map((detectorId) =>
      scoreFor(rule, hitsById.get(detectorId)),
    );
    const score = aggregateScores(rules.aggregate, scores);
    if (score >= rule.threshold) {
      fired.push({ rule, score });
    }
  }

  const decision = buildDecision(fired, hitsById);
  const planned = plannedActionIds(fired.map((item) => item.rule));
  const duplicate =
    !dryRun &&
    decision.action !== "allow" &&
    !(await claimDecision({
      event,
      decision,
      storage: input.storage,
      logger,
      createdAt: clock.nowIso(),
      rawTexts,
    }));
  const actionResults = duplicate
    ? planned.map((actionId) => ({
        actionId,
        status: "skipped" as const,
        detail: "duplicate",
      }))
    : await executeActions({
        planned,
        actions: input.actions,
        event,
        decision,
        dryRun,
        moderator: input.moderator,
        logger,
      });

  logger.info("pipeline_completed", {
    eventId: event.id,
    tenantId: event.tenantId,
    chatId: event.chatId,
    action: decision.action,
    score: decision.score,
    dryRun,
    ...(duplicate ? { duplicate: true } : {}),
  });

  return {
    eventId: event.id,
    outcome: "decided",
    hits,
    detectorErrors,
    decision,
    actionResults,
    dryRun,
  };
}

function assertUnique(
  ids: readonly string[],
  code: "duplicate_detector" | "duplicate_action",
): void {
  if (new Set(ids).size !== ids.length) {
    throw new PipelineConfigError(code);
  }
}

function scoreFor(rule: Rule, hit: DetectorHit | undefined): number {
  if (!hit) {
    return 0;
  }
  const place = sideTextPlace(rule.when);
  if (place !== undefined && hit.places !== undefined) {
    return hit.places.includes(place) ? hit.score : 0;
  }
  return hit.score;
}

function sideTextPlace(when: RuleWhen | undefined): TextPlace | undefined {
  if (!when) {
    return undefined;
  }
  if ("senderTag" in when) {
    return "senderTag";
  }
  if ("buttonText" in when) {
    return "buttonText";
  }
  if ("authorSignature" in when) {
    return "authorSignature";
  }
  if ("mirrorSignature" in when) {
    return "mirrorSignature";
  }
  if ("pollOption" in when) {
    return "pollOption";
  }
  if ("checklistTask" in when) {
    return "checklistTask";
  }
  if ("mediaName" in when) {
    return "mediaName";
  }
  if ("performer" in when) {
    return "performer";
  }
  if ("gameText" in when) {
    return "gameText";
  }
  if ("invoiceText" in when) {
    return "invoiceText";
  }
  if ("venueAddress" in when) {
    return "venueAddress";
  }
  if ("pollExplanation" in when) {
    return "pollExplanation";
  }
  if ("pollQuestion" in when) {
    return "pollQuestion";
  }
  if ("prizeText" in when) {
    return "prizeText";
  }
  if ("checklistTitle" in when) {
    return "checklistTitle";
  }
  if ("gameTitle" in when) {
    return "gameTitle";
  }
  if ("invoiceTitle" in when) {
    return "invoiceTitle";
  }
  if ("venueTitle" in when) {
    return "venueTitle";
  }
  if ("webAppButtonText" in when) {
    return "webAppButtonText";
  }
  if ("quoteText" in when) {
    return "quoteText";
  }
  if ("giftText" in when) {
    return "giftText";
  }
  if ("giftLabel" in when) {
    return "giftLabel";
  }
  if ("topicName" in when) {
    return "topicName";
  }
  if ("declineComment" in when) {
    return "declineComment";
  }
  if ("addedText" in when) {
    return "addedText";
  }
  if ("hiddenName" in when) {
    return "hiddenName";
  }
  if ("memberName" in when) {
    return "memberName";
  }
  if ("sharedName" in when) {
    return "sharedName";
  }
  if ("managedName" in when) {
    return "managedName";
  }
  if ("accessName" in when) {
    return "accessName";
  }
  if ("gameFile" in when) {
    return "gameFile";
  }
  if ("audioFile" in when) {
    return "audioFile";
  }
  if ("paidFile" in when) {
    return "paidFile";
  }
  if ("richName" in when) {
    return "richName";
  }
  if ("pollMedia" in when) {
    return "pollMedia";
  }
  if ("pollDescription" in when) {
    return "pollDescription";
  }
  if ("richText" in when) {
    return "richText";
  }
  if ("richButton" in when) {
    return "richButton";
  }
  return undefined;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function runDetector(
  detector: Detector,
  event: Event,
  logger: Logger,
  timeoutMs: number,
  failureMode: FailureMode,
): Promise<{ hit: DetectorHit | null; error: DetectorError | null }> {
  const cancel = createCancelSource();
  const killer = readTimers().setTimeout(() => cancel.abort(), timeoutMs);
  try {
    const raw = await withTimeout(
      detector.detect({ event, logger, signal: cancel.signal }),
      timeoutMs,
    );
    if (raw === null) {
      return { hit: null, error: null };
    }
    const parsed = detectorHitSchema.safeParse(raw);
    if (!parsed.success || parsed.data.detectorId !== detector.id) {
      return failedDetector(
        detector.id,
        "detector_invalid_hit",
        failureMode,
        logger,
        event,
      );
    }
    return { hit: parsed.data, error: null };
  } catch (error) {
    const code =
      error instanceof Error && error.message === "detector_timeout"
        ? "detector_timeout"
        : "detector_failed";
    return failedDetector(detector.id, code, failureMode, logger, event);
  } finally {
    readTimers().clearTimeout(killer);
  }
}

function createCancelSource(): { signal: CancelSignal; abort(): void } {
  let aborted = false;
  return {
    signal: {
      get aborted() {
        return aborted;
      },
    },
    abort() {
      aborted = true;
    },
  };
}

function readTimers(): {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
} {
  return globalThis as unknown as {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

function failedDetector(
  detectorId: string,
  code: DetectorError["code"],
  failureMode: FailureMode,
  logger: Logger,
  event: Event,
): { hit: DetectorHit | null; error: DetectorError } {
  logger.warn("detector_error", {
    detectorId,
    code,
    tenantId: event.tenantId,
    chatId: event.chatId,
  });
  const error = { detectorId, code };
  if (failureMode === "closed") {
    return {
      error,
      hit: {
        detectorId,
        score: 1,
        reasons: [code],
        evidence: [{ kind: "feature", summary: code }],
      },
    };
  }
  return { hit: null, error };
}

function eventTexts(event: Event): readonly string[] {
  const candidates = [
    event.message?.text,
    event.message?.senderTag,
    event.message?.buttonText,
    event.message?.authorSignature,
    event.message?.mirrorSignature,
    event.message?.pollOption,
    event.message?.checklistTask,
    event.message?.mediaName,
    event.message?.performer,
    event.message?.gameText,
    event.message?.invoiceText,
    event.message?.venueAddress,
    event.message?.pollExplanation,
    event.message?.pollQuestion,
    event.message?.prizeText,
    event.message?.checklistTitle,
    event.message?.gameTitle,
    event.message?.invoiceTitle,
    event.message?.venueTitle,
    event.message?.webAppButtonText,
    event.message?.quoteText,
    event.message?.giftText,
    event.message?.giftLabel,
    event.message?.topicName,
    event.message?.declineComment,
    event.message?.addedText,
    event.message?.hiddenName,
    event.message?.memberName,
    event.message?.sharedName,
    event.message?.managedName,
    event.message?.accessName,
    event.message?.gameFile,
    event.message?.audioFile,
    event.message?.paidFile,
    event.message?.richName,
    event.message?.pollMedia,
    event.message?.pollDescription,
    event.message?.richText,
    event.message?.richButton,
    event.profile?.text,
  ];
  const texts: string[] = [];
  for (const value of candidates) {
    if (value && value.length > 0 && !texts.includes(value)) {
      texts.push(value);
    }
  }
  return texts;
}

function redactHit(hit: DetectorHit, rawTexts: readonly string[]): DetectorHit {
  return {
    ...hit,
    reasons: hit.reasons.map((reason) => redactTexts(reason, rawTexts)),
    evidence: hit.evidence.map((item) => ({
      kind: item.kind,
      summary: redactTexts(item.summary, rawTexts),
    })),
  };
}

function redactTexts(value: string, rawTexts: readonly string[]): string {
  return rawTexts.reduce(
    (current, text) => redactExactText(current, text),
    value,
  );
}

function buildDecision(
  fired: readonly { rule: Rule; score: number }[],
  hitsById: ReadonlyMap<string, DetectorHit>,
): Decision {
  if (fired.length === 0) {
    return allowDecision;
  }
  let action: DecisionAction = "allow";
  let score = 0;
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  const evidence: Evidence[] = [];
  const seenReasons = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const item of fired) {
    ruleIds.push(item.rule.id);
    score = Math.max(score, item.score);
    for (const actionId of item.rule.actions) {
      action = moreSevere(action, actionId);
    }
    for (const detectorId of item.rule.detectorIds) {
      const hit = hitsById.get(detectorId);
      if (!hit) {
        continue;
      }
      for (const reason of hit.reasons) {
        if (seenReasons.has(reason)) {
          continue;
        }
        seenReasons.add(reason);
        reasons.push(reason);
      }
      for (const itemEvidence of hit.evidence) {
        const key = `${itemEvidence.kind}:${itemEvidence.summary}`;
        if (seenEvidence.has(key)) {
          continue;
        }
        seenEvidence.add(key);
        evidence.push(itemEvidence);
      }
    }
  }
  return { action, ruleIds, score, reasons, evidence };
}

function plannedActionIds(rules: readonly Rule[]): string[] {
  return uniqueIds(rules.flatMap((rule) => [...rule.actions]));
}

async function claimDecision(input: {
  event: Event;
  decision: Decision;
  storage: Storage;
  logger: Logger;
  createdAt: string;
  rawTexts: readonly string[];
}): Promise<boolean> {
  try {
    const record = parseAuditRecord({
      tenantId: input.event.tenantId,
      chatId: input.event.chatId,
      eventId: input.event.id,
      ...(input.event.message
        ? {
            messageId: input.event.message.id,
            textSha256: input.event.message.textSha256,
          }
        : input.event.profile
          ? { textSha256: input.event.profile.textSha256 }
          : {}),
      action: input.decision.action,
      score: input.decision.score,
      reasons: input.decision.reasons,
      evidence: input.decision.evidence,
      ruleIds: input.decision.ruleIds,
      createdAt: input.createdAt,
    });
    for (const text of input.rawTexts) {
      assertNoRawContent(record, text);
    }
    const claimed = await input.storage.claimAudit(record);
    if (!claimed) {
      input.logger.info("audit_duplicate", {
        eventId: input.event.id,
        tenantId: input.event.tenantId,
        chatId: input.event.chatId,
      });
    }
    return claimed;
  } catch (error) {
    input.logger.error("audit_claim_failed", {
      eventId: input.event.id,
      tenantId: input.event.tenantId,
      chatId: input.event.chatId,
      code:
        error instanceof RawContentError
          ? "raw_content_rejected"
          : "storage_failed",
    });
    return true;
  }
}

async function executeActions(input: {
  planned: readonly string[];
  actions: readonly Action[];
  event: Event;
  decision: Decision;
  dryRun: boolean;
  moderator: ModerationPort;
  logger: Logger;
}): Promise<ActionResult[]> {
  const actionsById = new Map(
    input.actions.map((action) => [action.id, action]),
  );
  const results: ActionResult[] = [];
  for (const actionId of input.planned) {
    if (input.dryRun) {
      results.push({ actionId, status: "skipped", detail: "dry_run" });
      continue;
    }
    const action = actionsById.get(actionId);
    if (!action) {
      input.logger.warn("missing_action", {
        actionId,
        eventId: input.event.id,
      });
      results.push({ actionId, status: "failed", detail: "missing_action" });
      continue;
    }
    try {
      results.push(
        await action.execute({
          event: input.event,
          decision: input.decision,
          dryRun: false,
          moderator: input.moderator,
          logger: input.logger,
          signal: { aborted: false },
        }),
      );
    } catch {
      input.logger.error("action_failed", {
        actionId,
        eventId: input.event.id,
      });
      results.push({ actionId, status: "failed", detail: "action_failed" });
    }
  }
  return results;
}

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const idSchema = z.string().min(1).max(128);

export const eventKinds = ["message", "chat_member", "command"] as const;
export const eventKindSchema = z.enum(eventKinds);

export const messageSchema = z.strictObject({
  id: idSchema,
  text: z.string().max(4096),
  textSha256: sha256Schema,
});

export const actorSchema = z.strictObject({
  id: idSchema,
  isAdmin: z.boolean(),
});

export const eventSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  chatId: idSchema,
  kind: eventKindSchema,
  occurredAt: isoSchema,
  actor: actorSchema,
  message: messageSchema.optional(),
});

export type EventKind = z.output<typeof eventKindSchema>;
export type MessageContent = z.output<typeof messageSchema>;
export type Actor = z.output<typeof actorSchema>;
export type Event = z.output<typeof eventSchema>;

export function parseEvent(input: unknown): Event {
  return eventSchema.parse(input);
}

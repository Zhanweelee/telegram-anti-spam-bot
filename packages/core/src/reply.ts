export interface ReplyMessage {
  readonly tenantId: string;
  readonly chatId: string;
  readonly text: string;
}

/** Sends an operator reply. Implementations must not log `text` or tokens. */
export interface ReplyPort {
  send(message: ReplyMessage): Promise<void>;
}

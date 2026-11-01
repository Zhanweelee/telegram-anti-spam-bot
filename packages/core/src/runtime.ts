/** Per-chat switches that are not prefilter policy and not rules. */
export interface RuntimeStore {
  getDryRun(tenantId: string, chatId: string): Promise<boolean>;
  setDryRun(tenantId: string, chatId: string, enabled: boolean): Promise<void>;
}

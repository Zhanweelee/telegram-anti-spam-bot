/** One rule's enabled flag for a single chat. Unknown ids are ignored later. */
export interface RuleSwitch {
  readonly ruleId: string;
  readonly enabled: boolean;
}

/** Per-chat switches that are not prefilter policy and not rules. */
export interface RuntimeStore {
  getDryRun(tenantId: string, chatId: string): Promise<boolean>;
  setDryRun(tenantId: string, chatId: string, enabled: boolean): Promise<void>;
  listRuleSwitches(
    tenantId: string,
    chatId: string,
  ): Promise<readonly RuleSwitch[]>;
  /**
   * Returns false when a new chat or a new rule id would exceed the cap.
   * Updating an id that is already stored still succeeds.
   */
  setRuleSwitch(
    tenantId: string,
    chatId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<boolean>;
  clearRuleSwitch(
    tenantId: string,
    chatId: string,
    ruleId: string,
  ): Promise<void>;
}

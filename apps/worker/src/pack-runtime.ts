import {
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
} from "@tasb/core";
import { filePackSource } from "./rules.js";

export const workerRulePacks = {
  store: createMemoryRuleSubscriptionStore(),
  archive: createMemoryRulePackArchive(),
  source: filePackSource(),
};

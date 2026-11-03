import {
  createD1CaptchaStore,
  createD1ReviewQueue,
  createD1Storage,
  createKvBlocklistStore,
  createKvChatDirectory,
  createKvPolicyStore,
  createKvRulePackArchive,
  createKvRuleSubscriptionStore,
  createKvRuntimeStore,
  type SqlDatabase,
  type SqlPrepared,
  type StringStore,
} from "@tasb/adapter-cloudflare";
import type {
  BlocklistStore,
  CaptchaStore,
  ChatDirectory,
  PolicyStore,
  ReviewQueue,
  RulePackArchive,
  RuleSubscriptionStore,
  RuntimeStore,
  Storage,
} from "@tasb/core";
import { workerBlocklist } from "./blocklist-runtime.js";
import { workerCaptcha } from "./captcha-runtime.js";
import { workerChats } from "./chat-runtime.js";
import { workerRulePacks } from "./pack-runtime.js";
import { workerReview } from "./review-runtime.js";
import { workerPolicyStore, workerRuntime, workerStorage } from "./screen.js";

export interface StoreSlot {
  storage?: Storage;
  policyStore?: PolicyStore;
  review?: ReviewQueue;
  runtime?: RuntimeStore;
  chats?: ChatDirectory;
  subscriptions?: RuleSubscriptionStore;
  archive?: RulePackArchive;
  blocklist?: BlocklistStore;
  captcha?: CaptchaStore;
  kv?: KVNamespace;
}

const isolateSlot: StoreSlot = {};

export function resolveStores(
  env: { DB?: D1Database; POLICY_KV?: KVNamespace },
  slot: StoreSlot = isolateSlot,
): {
  readonly storage: Storage;
  readonly policyStore: PolicyStore;
  readonly review: ReviewQueue;
  readonly runtime: RuntimeStore;
  readonly chats: ChatDirectory;
  readonly subscriptions: RuleSubscriptionStore;
  readonly archive: RulePackArchive;
  readonly blocklist: BlocklistStore;
  readonly captcha: CaptchaStore;
} {
  if (env.DB !== undefined && slot.storage === undefined) {
    const sql = adaptD1(env.DB);
    slot.storage = createD1Storage(sql);
    slot.review = createD1ReviewQueue(sql);
    slot.captcha = createD1CaptchaStore(sql);
  }
  if (env.POLICY_KV !== undefined && slot.kv !== env.POLICY_KV) {
    const kv = adaptKv(env.POLICY_KV);
    slot.kv = env.POLICY_KV;
    slot.policyStore = createKvPolicyStore(kv);
    slot.runtime = createKvRuntimeStore(kv);
    slot.chats = createKvChatDirectory(kv);
    slot.subscriptions = createKvRuleSubscriptionStore(kv);
    slot.archive = createKvRulePackArchive(kv);
    slot.blocklist = createKvBlocklistStore(kv);
  }
  return {
    storage:
      env.DB !== undefined && slot.storage !== undefined
        ? slot.storage
        : workerStorage,
    policyStore:
      env.POLICY_KV !== undefined && slot.policyStore !== undefined
        ? slot.policyStore
        : workerPolicyStore,
    review:
      env.DB !== undefined && slot.review !== undefined
        ? slot.review
        : workerReview,
    runtime:
      env.POLICY_KV !== undefined && slot.runtime !== undefined
        ? slot.runtime
        : workerRuntime,
    chats:
      env.POLICY_KV !== undefined && slot.chats !== undefined
        ? slot.chats
        : workerChats,
    subscriptions:
      env.POLICY_KV !== undefined && slot.subscriptions !== undefined
        ? slot.subscriptions
        : workerRulePacks.store,
    archive:
      env.POLICY_KV !== undefined && slot.archive !== undefined
        ? slot.archive
        : workerRulePacks.archive,
    blocklist:
      env.POLICY_KV !== undefined && slot.blocklist !== undefined
        ? slot.blocklist
        : workerBlocklist,
    captcha:
      env.DB !== undefined && slot.captcha !== undefined
        ? slot.captcha
        : workerCaptcha,
  };
}

const nativeStatements = new WeakMap<SqlPrepared, D1PreparedStatement>();

export function adaptD1(db: D1Database): SqlDatabase {
  return {
    prepare(sql) {
      return wrapStatement(db.prepare(sql));
    },
    batch(statements) {
      return db.batch(statements.map(nativeStatement));
    },
  };
}

function wrapStatement(statement: D1PreparedStatement): SqlPrepared {
  const prepared: SqlPrepared = {
    bind(...values) {
      return wrapStatement(statement.bind(...values));
    },
    all() {
      return statement.all();
    },
    run() {
      return statement.run();
    },
  };
  nativeStatements.set(prepared, statement);
  return prepared;
}

function nativeStatement(statement: SqlPrepared): D1PreparedStatement {
  const native = nativeStatements.get(statement);
  if (!native) {
    throw new Error("d1_batch_statement");
  }
  return native;
}

export function adaptKv(kv: KVNamespace): StringStore {
  return {
    get(key) {
      return kv.get(key, "text");
    },
    put(key, value) {
      return kv.put(key, value);
    },
  };
}

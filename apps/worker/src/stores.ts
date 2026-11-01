import {
  createD1ReviewQueue,
  createD1Storage,
  createKvPolicyStore,
  createKvRuntimeStore,
  type SqlDatabase,
  type SqlPrepared,
  type StringStore,
} from "@tasb/adapter-cloudflare";
import type {
  PolicyStore,
  ReviewQueue,
  RuntimeStore,
  Storage,
} from "@tasb/core";
import { workerReview } from "./review-runtime.js";
import { workerPolicyStore, workerRuntime, workerStorage } from "./screen.js";

export interface StoreSlot {
  storage?: Storage;
  policyStore?: PolicyStore;
  review?: ReviewQueue;
  runtime?: RuntimeStore;
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
} {
  if (env.DB !== undefined && slot.storage === undefined) {
    const sql = adaptD1(env.DB);
    slot.storage = createD1Storage(sql);
    slot.review = createD1ReviewQueue(sql);
  }
  if (env.POLICY_KV !== undefined && slot.policyStore === undefined) {
    const kv = adaptKv(env.POLICY_KV);
    slot.policyStore = createKvPolicyStore(kv);
    slot.runtime = createKvRuntimeStore(kv);
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
  };
}

export function adaptD1(db: D1Database): SqlDatabase {
  return {
    prepare(sql) {
      return wrapStatement(db.prepare(sql));
    },
  };
}

function wrapStatement(statement: D1PreparedStatement): SqlPrepared {
  return {
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

import {
  createD1Storage,
  createKvPolicyStore,
  type SqlDatabase,
  type SqlPrepared,
  type StringStore,
} from "@tasb/adapter-cloudflare";
import type { PolicyStore, Storage } from "@tasb/core";
import { workerPolicyStore, workerStorage } from "./screen.js";

export interface StoreSlot {
  storage?: Storage;
  policyStore?: PolicyStore;
}

const isolateSlot: StoreSlot = {};

export function resolveStores(
  env: { DB?: D1Database; POLICY_KV?: KVNamespace },
  slot: StoreSlot = isolateSlot,
): { readonly storage: Storage; readonly policyStore: PolicyStore } {
  if (env.DB !== undefined && slot.storage === undefined) {
    slot.storage = createD1Storage(adaptD1(env.DB));
  }
  if (env.POLICY_KV !== undefined && slot.policyStore === undefined) {
    slot.policyStore = createKvPolicyStore(adaptKv(env.POLICY_KV));
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

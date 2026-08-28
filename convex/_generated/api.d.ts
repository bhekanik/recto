/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as accountGuard from "../accountGuard.js";
import type * as accountPurge from "../accountPurge.js";
import type * as ai_langsmithSmoke from "../ai/langsmithSmoke.js";
import type * as crons from "../crons.js";
import type * as docNodes from "../docNodes.js";
import type * as documents from "../documents.js";
import type * as embeddings from "../embeddings.js";
import type * as export_ from "../export.js";
import type * as files from "../files.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as retention from "../retention.js";
import type * as review from "../review.js";
import type * as settings from "../settings.js";
import type * as storageTokens from "../storageTokens.js";
import type * as versions from "../versions.js";
import type * as workspaces from "../workspaces.js";
import type * as writingStats from "../writingStats.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  accountGuard: typeof accountGuard;
  accountPurge: typeof accountPurge;
  "ai/langsmithSmoke": typeof ai_langsmithSmoke;
  crons: typeof crons;
  docNodes: typeof docNodes;
  documents: typeof documents;
  embeddings: typeof embeddings;
  export: typeof export_;
  files: typeof files;
  history: typeof history;
  http: typeof http;
  migrations: typeof migrations;
  retention: typeof retention;
  review: typeof review;
  settings: typeof settings;
  storageTokens: typeof storageTokens;
  versions: typeof versions;
  workspaces: typeof workspaces;
  writingStats: typeof writingStats;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as docNodes from "../docNodes.js";
import type * as documents from "../documents.js";
import type * as history from "../history.js";
import type * as retention from "../retention.js";
import type * as versions from "../versions.js";
import type * as workspaces from "../workspaces.js";
import type * as writingStats from "../writingStats.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  docNodes: typeof docNodes;
  documents: typeof documents;
  history: typeof history;
  retention: typeof retention;
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

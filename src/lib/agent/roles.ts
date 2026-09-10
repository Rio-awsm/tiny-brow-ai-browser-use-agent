import type { ProviderConfig } from "@/lib/provider";

/**
 * The three jobs a run needs doing, after Nanobrowser's split.
 *
 * They are separated because they want different models. Navigation is a
 * hundred cheap calls where latency is the whole cost; planning is one call
 * where being right matters more than being quick; validation is a tiny call
 * that has to be honest about work it did not do.
 */
export type RoleName = "navigator" | "planner" | "validator";

export const ROLES: RoleName[] = ["navigator", "planner", "validator"];

/**
 * What a role changes about the base config.
 *
 * A route is nothing but `(provider, model, extraParams)` — the same triple the
 * provider layer already speaks — so a role can point at a different endpoint
 * entirely: the navigator local and the planner hosted, in one run.
 */
export interface Route {
  /** Off means this role uses the single configured provider. */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraParams: Record<string, unknown>;
  maxTokens?: number;
}

export type Routes = Partial<Record<RoleName, Route>>;

export const EMPTY_ROUTE: Route = {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "",
  extraParams: {},
};

/**
 * Falls back field by field rather than all or nothing, so pointing a role at
 * one more capable model on the same endpoint costs typing a model name and
 * nothing else.
 */
export function configFor(base: ProviderConfig, routes: Routes, role: RoleName): ProviderConfig {
  const route = routes[role];
  if (!route?.enabled) return base;

  const sameEndpoint = !route.baseUrl || route.baseUrl === base.baseUrl;
  return {
    ...base,
    baseUrl: route.baseUrl || base.baseUrl,
    // A key belongs to an endpoint. Carrying the base key to a different one
    // would leak it to a host the user did not put it in for.
    apiKey: route.apiKey || (sameEndpoint ? base.apiKey : ""),
    model: route.model || base.model,
    extraParams: { ...base.extraParams, ...route.extraParams },
    maxTokens: route.maxTokens ?? base.maxTokens,
  };
}

/** One line per role for the transcript, naming only what actually differs. */
export function describeRoutes(base: ProviderConfig, routes: Routes): string[] {
  return ROLES.filter((role) => routes[role]?.enabled).map((role) => {
    const config = configFor(base, routes, role);
    const where = config.baseUrl === base.baseUrl ? "" : ` @ ${hostOf(config.baseUrl)}`;
    return `${role}: ${config.model}${where}`;
  });
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

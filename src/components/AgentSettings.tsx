import { useState } from "react";
import { ChevronDown, Compass, Map, ShieldCheck } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EMPTY_ROUTE, ROLES, type RoleName, type Route } from "@/lib/agent/roles";
import type { AgentSettings } from "@/lib/settings";
import type { ProviderConfig } from "@/lib/provider";

interface Props {
  agent: AgentSettings;
  base: ProviderConfig;
  onChange: (next: AgentSettings) => void;
}

const ROLE_COPY: Record<RoleName, { title: string; icon: typeof Compass; hint: string }> = {
  navigator: {
    title: "Navigator",
    icon: Compass,
    hint: "One call per step. Cheap and fast matters more than clever.",
  },
  planner: {
    title: "Planner",
    icon: Map,
    hint: "Writes the plan once, and again if the run gets stuck. Worth a stronger model.",
  },
  validator: {
    title: "Validator",
    icon: ShieldCheck,
    hint: "Checks the final answer. Tiny prompt, so almost any model will do.",
  },
};

/**
 * The parts of a run the user can change without touching a config file.
 *
 * Roles are separate here because they are separate in the loop: a route is a
 * base URL, a key and a model, so the navigator can run on a local model and
 * the planner on a hosted one in the same run.
 */
export function AgentSettingsSection({ agent, base, onChange }: Props) {
  const [openRoles, setOpenRoles] = useState(false);
  const [openFirewall, setOpenFirewall] = useState(false);

  const setRoute = (role: RoleName, patch: Partial<Route>) => {
    const current = agent.routes[role] ?? EMPTY_ROUTE;
    onChange({ ...agent, routes: { ...agent.routes, [role]: { ...current, ...patch } } });
  };

  return (
    <div className="flex flex-col gap-3.5 rounded-lg border border-border bg-card p-2.5">
      <SwitchRow
        label="Plan before starting"
        hint="Two extra calls a run. It is what carries an order of operations across a change of site."
        checked={agent.plan}
        onCheckedChange={(plan) => onChange({ ...agent, plan })}
      />
      <SwitchRow
        label="Check the answer"
        hint="A second, independent call decides whether the answer really satisfies the task."
        checked={agent.validate}
        onCheckedChange={(validate) => onChange({ ...agent, validate })}
      />

      <Disclosure
        open={openRoles}
        onToggle={() => setOpenRoles((v) => !v)}
        label="Use a different model per role"
        summary={
          ROLES.filter((r) => agent.routes[r]?.enabled).length === 0
            ? "All three roles use the model above"
            : ROLES.filter((r) => agent.routes[r]?.enabled)
                .map((r) => `${r}: ${agent.routes[r]?.model || base.model}`)
                .join(" · ")
        }
      >
        {ROLES.map((role) => {
          const route = agent.routes[role] ?? EMPTY_ROUTE;
          const { title, icon: Icon, hint } = ROLE_COPY[role];
          return (
            <div key={role} className="rounded-lg border border-border/70 bg-background/50 p-2">
              <SwitchRow
                label={title}
                hint={hint}
                checked={route.enabled}
                onCheckedChange={(enabled) => setRoute(role, { enabled })}
              />
              {route.enabled && (
                <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2">
                  <Field label="Model" hint={`blank uses ${base.model || "the model above"}`}>
                    <Input
                      value={route.model}
                      placeholder={base.model}
                      onChange={(e) => setRoute(role, { model: e.target.value })}
                    />
                  </Field>
                  <Field label="Base URL" hint="blank uses the same endpoint">
                    <Input
                      value={route.baseUrl}
                      placeholder={base.baseUrl}
                      onChange={(e) => setRoute(role, { baseUrl: e.target.value })}
                    />
                  </Field>
                  {route.baseUrl && route.baseUrl !== base.baseUrl && (
                    <Field label="API key" hint="this endpoint's own key">
                      <Input
                        type="password"
                        value={route.apiKey}
                        placeholder="leave blank if it needs none"
                        onChange={(e) => setRoute(role, { apiKey: e.target.value })}
                      />
                    </Field>
                  )}
                  <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Icon className="size-3 shrink-0" />
                    {route.baseUrl && route.baseUrl !== base.baseUrl
                      ? "Runs on a different endpoint to the others."
                      : "Runs on the same endpoint, different model."}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </Disclosure>

      <Disclosure
        open={openFirewall}
        onToggle={() => setOpenFirewall((v) => !v)}
        label="Limit where Tiny can go"
        summary={
          agent.firewall.enabled
            ? `${agent.firewall.allow.length || "any"} allowed · ${agent.firewall.deny.length} blocked`
            : "Off — Tiny can visit any site the task leads to"
        }
      >
        <SwitchRow
          label="Enforce the list"
          hint="A task about groceries has no business on your email."
          checked={agent.firewall.enabled}
          onCheckedChange={(enabled) =>
            onChange({ ...agent, firewall: { ...agent.firewall, enabled } })
          }
        />
        <Field label="Allowed sites" hint="one per line, e.g. *.amazon.in — blank means anywhere">
          <Input
            value={agent.firewall.allow.join(", ")}
            placeholder="*.amazon.in, *.flipkart.com"
            onChange={(e) =>
              onChange({ ...agent, firewall: { ...agent.firewall, allow: splitHosts(e.target.value) } })
            }
          />
        </Field>
        <Field label="Never allowed" hint="wins over the allowed list">
          <Input
            value={agent.firewall.deny.join(", ")}
            placeholder="mail.google.com, *.mybank.com"
            onChange={(e) =>
              onChange({ ...agent, firewall: { ...agent.firewall, deny: splitHosts(e.target.value) } })
            }
          />
        </Field>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Sign-in pages, password and card fields, and anything that reads as paying,
          ordering or deleting are gated whatever this says — those are in code, not here.
        </p>
      </Disclosure>
    </div>
  );
}

interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  label: string;
  summary: string;
  children: React.ReactNode;
}

function Disclosure({ open, onToggle, label, summary, children }: DisclosureProps) {
  return (
    <div className="border-t border-border/60 pt-3">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-1.5 text-left transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={cn("mt-px size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
        <span className="min-w-0">
          <span className="block text-[11px] font-medium">{label}</span>
          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{summary}</span>
        </span>
      </button>
      {open && <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}

const splitHosts = (text: string) =>
  text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

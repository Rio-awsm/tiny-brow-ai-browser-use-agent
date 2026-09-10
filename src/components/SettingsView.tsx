import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Loader2,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { AgentSettingsSection } from "@/components/AgentSettings";
import { SwitchRow } from "@/components/ui/switch";
import { DEFAULT_BRIDGE } from "@/lib/bench";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CONFIG,
  PRESETS,
  hasHostPermission,
  presetById,
  requestHostPermission,
  saveConfig,
  testConnection,
  validateConfig,
  type ProbeResult,
  type ProviderConfig,
} from "@/lib/provider";
import { saveAgentSettings, type AgentSettings } from "@/lib/settings";

interface Props {
  config: ProviderConfig;
  agent: AgentSettings;
  onClose: () => void;
  onSaved: (config: ProviderConfig, agent: AgentSettings) => void;
  /** The scoring harness connection — a developer control, not a browsing one. */
  benchOn: boolean;
  onToggleBench: () => void;
}

export function SettingsView({ config, agent, onClose, onSaved, benchOn, onToggleBench }: Props) {
  const [draft, setDraft] = useState<ProviderConfig>(config);
  const [agentDraft, setAgentDraft] = useState<AgentSettings>(agent);
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [extraText, setExtraText] = useState(() => stringify(config.extraParams));
  const [extraError, setExtraError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [permitted, setPermitted] = useState<boolean | null>(null);

  const preset = presetById(draft.preset);
  const problems = useMemo(() => validateConfig(draft), [draft]);
  const problemFor = (field: string) => problems.find((p) => p.field === field)?.message;

  useEffect(() => {
    if (!draft.baseUrl) {
      setPermitted(null);
      return;
    }
    void hasHostPermission(draft.baseUrl).then(setPermitted);
  }, [draft.baseUrl]);

  const choosePreset = (id: string) => {
    const next = presetById(id);
    setDraft((d) => ({
      ...d,
      preset: id,
      // Only overwrite what the preset actually knows; a typed key survives a
      // change of mind about the provider.
      baseUrl: next?.baseUrl || (id === "custom" ? d.baseUrl : ""),
      model: next?.models[0] ?? "",
      extraParams: next?.extraParams ?? {},
    }));
    setExtraText(stringify(next?.extraParams ?? {}));
    setProbe(null);
  };

  const parseExtra = (text: string) => {
    setExtraText(text);
    if (!text.trim()) {
      setExtraError(null);
      setDraft((d) => ({ ...d, extraParams: {} }));
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setExtraError("Must be a JSON object");
        return;
      }
      setExtraError(null);
      setDraft((d) => ({ ...d, extraParams: parsed as Record<string, unknown> }));
    } catch {
      setExtraError("Not valid JSON");
    }
  };

  const save = async () => {
    setBusy("save");
    // Permission is requested here because this click is the user gesture Chrome
    // requires, and because the endpoint is only known now.
    const granted = (await hasHostPermission(draft.baseUrl)) || (await requestHostPermission(draft.baseUrl));
    setPermitted(granted);

    if (granted) {
      await saveConfig(draft);
      await saveAgentSettings(agentDraft);
      onSaved(draft, agentDraft);
    }
    setBusy(null);
  };

  const test = async () => {
    setBusy("test");
    setProbe(null);
    setProbe(await testConnection(draft));
    setBusy(null);
  };

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(config) ||
    JSON.stringify(agentDraft) !== JSON.stringify(agent);
  const blocked = problems.length > 0 || extraError !== null;

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="icon" onClick={onClose}>
          <ArrowLeft />
        </Button>
        <span className="text-[13px] font-semibold tracking-tight">Model</span>
        {dirty && (
          <span className="rounded-full bg-warning/12 px-1.5 py-0.5 text-[9px] font-medium text-warning">
            unsaved
          </span>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3.5 p-3">
          <Field label="Provider" hint="a preset, or bring your own">
            <Select value={draft.preset} onValueChange={choosePreset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {preset?.note && (
            <p className="flex items-start gap-1.5 rounded-lg border border-border bg-secondary/40 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              <Info className="mt-px size-3 shrink-0" />
              <span>
                {preset.note}
                {preset.docsUrl && (
                  <a
                    href={preset.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    docs <ExternalLink className="size-2.5" />
                  </a>
                )}
              </span>
            </p>
          )}

          <Field label="Base URL" hint="/chat/completions is appended" error={problemFor("baseUrl")}>
            <Input
              value={draft.baseUrl}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              onChange={(e) => {
                setDraft((d) => ({ ...d, baseUrl: e.target.value.trim() }));
                setProbe(null);
              }}
            />
          </Field>

          <Field
            label="API key"
            hint={preset?.needsKey === false ? "optional for local" : preset?.keyHint}
            error={problemFor("apiKey")}
          >
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={draft.apiKey}
                spellCheck={false}
                autoComplete="off"
                placeholder={preset?.keyHint ?? "paste your key"}
                className="pr-8"
                onChange={(e) => {
                  setDraft((d) => ({ ...d, apiKey: e.target.value.trim() }));
                  setProbe(null);
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </Field>

          <p className="flex items-start gap-1.5 rounded-lg border border-primary/20 bg-primary/8 px-2 py-1.5 text-[10px] leading-relaxed text-primary">
            <ShieldCheck className="mt-px size-3 shrink-0" />
            Stored in this browser only, and sent to the endpoint above and nowhere else.
          </p>

          <Field label="Model" error={problemFor("model")}>
            <Input
              value={draft.model}
              spellCheck={false}
              list="tiny-models"
              placeholder={preset?.models[0] ?? "model name"}
              onChange={(e) => {
                setDraft((d) => ({ ...d, model: e.target.value.trim() }));
                setProbe(null);
              }}
            />
            <datalist id="tiny-models">
              {preset?.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>

          {preset && preset.models.length > 0 && (
            <div className="-mt-1.5 flex flex-wrap gap-1">
              {preset.models.map((m) => (
                <button
                  key={m}
                  onClick={() => setDraft((d) => ({ ...d, model: m }))}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                    draft.model === m
                      ? "border-primary/40 bg-primary/12 text-primary"
                      : "border-border bg-secondary/50 text-muted-foreground hover:bg-accent",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          <Field label="Step cap" hint="a run stops here rather than looping forever">
            <Input
              type="number"
              min={1}
              max={200}
              value={agentDraft.stepCap}
              onChange={(e) =>
                setAgentDraft((a) => ({ ...a, stepCap: Number(e.target.value) || 1 }))
              }
            />
          </Field>

          <AgentSettingsSection agent={agentDraft} base={draft} onChange={setAgentDraft} />

          <div className="rounded-lg border border-border bg-card p-2.5">
            <SwitchRow
              label="Connect to the scoring harness"
              hint={`Polls ${DEFAULT_BRIDGE} for tasks and runs them unattended. Only needed to score the suite.`}
              checked={benchOn}
              onCheckedChange={onToggleBench}
            />
          </div>

          <button
            onClick={() => setAdvanced((v) => !v)}
            className="flex items-center gap-1 self-start text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("size-3 transition-transform", advanced && "rotate-180")} />
            Advanced
          </button>

          {advanced && (
            <div className="flex flex-col gap-3.5 rounded-lg border border-border bg-card p-2.5">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Max tokens">
                  <Input
                    type="number"
                    min={128}
                    value={draft.maxTokens}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, maxTokens: Number(e.target.value) || 0 }))
                    }
                  />
                </Field>
                <Field label="Temperature">
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={draft.temperature}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, temperature: Number(e.target.value) || 0 }))
                    }
                  />
                </Field>
              </div>
              <p className="-mt-2 text-[10px] leading-relaxed text-muted-foreground">
                Keep max tokens generous. On a reasoning model the reasoning is generated
                before the answer, so a tight budget returns an empty response.
              </p>

              <Field
                label="Extra parameters"
                hint="merged into the request body"
                error={extraError ?? undefined}
              >
                <Textarea
                  value={extraText}
                  rows={4}
                  spellCheck={false}
                  className="font-mono text-[10px]"
                  onChange={(e) => parseExtra(e.target.value)}
                />
              </Field>
              <p className="-mt-2 text-[10px] leading-relaxed text-muted-foreground">
                For provider-specific options that are not portable, like Groq's
                <code className="mx-1 rounded bg-secondary px-1">reasoning_effort</code>
                or OpenRouter's
                <code className="mx-1 rounded bg-secondary px-1">require_parameters</code>.
              </p>
            </div>
          )}

          {probe && <ProbeCard probe={probe} />}

          {permitted === false && draft.baseUrl && (
            <p className="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/8 px-2 py-1.5 text-[10px] leading-relaxed text-warning">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              Saving will ask Chrome for permission to reach this origin.
            </p>
          )}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-2 border-t border-border p-2.5">
        <Button variant="primary" onClick={() => void save()} disabled={blocked || busy !== null}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          Save
        </Button>
        <Button variant="outline" onClick={() => void test()} disabled={blocked || busy !== null}>
          {busy === "test" ? <Loader2 className="animate-spin" /> : <Zap />}
          Test connection
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            setDraft({ ...DEFAULT_CONFIG });
            setExtraText("{}");
            setProbe(null);
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

function ProbeCard({ probe }: { probe: ProbeResult }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2",
        probe.ok
          ? "border-primary/25 bg-primary/8"
          : "border-destructive/25 bg-destructive/8",
      )}
    >
      <div className="flex items-start gap-1.5">
        {probe.ok ? (
          <Check className="mt-0.5 size-3 shrink-0 text-primary" />
        ) : (
          <TriangleAlert className="mt-0.5 size-3 shrink-0 text-destructive" />
        )}
        <span
          className={cn(
            "text-[11px] font-medium leading-relaxed",
            probe.ok ? "text-primary" : "text-destructive",
          )}
        >
          {probe.headline}
        </span>
      </div>

      {probe.detail && (
        <p className="mt-1 break-words pl-4.5 font-mono text-[9.5px] leading-relaxed text-muted-foreground">
          {probe.detail}
        </p>
      )}

      {probe.ok && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-4.5 font-mono text-[9px] tabular-nums text-muted-foreground">
          <span>{probe.requestMs} ms</span>
          <span>
            {probe.promptTokens}p / {probe.completionTokens}c tokens
          </span>
          {probe.model && <span>{probe.model}</span>}
          {probe.remainingTokens !== undefined && (
            <span>{probe.remainingTokens} tokens left this minute</span>
          )}
        </div>
      )}
    </div>
  );
}

const stringify = (value: Record<string, unknown>) =>
  Object.keys(value).length ? JSON.stringify(value, null, 2) : "{}";

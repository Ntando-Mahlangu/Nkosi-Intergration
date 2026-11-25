import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useAuth, useToast } from "../../lib/app-state";
import { Button, Card, Checkbox, ErrorState, FormError, Loading, SelectInput, TextInput, Callout } from "../../components/ui";
import { errFields } from "./shared";

interface Settings {
  "org.name": string; "org.short_name": string; "org.timezone": string; "org.currency": string; "ai.enabled": boolean;
  "projects.default_progress_method": string;
  "projects.health_rules": { overdueMilestoneDays: number; blockedTasksForAttention: number; staleUpdateDays: number };
  "notifications.reminder_days_before_due": number; "fakawe.default_audience": string;
}

const TIMEZONES = ["Africa/Johannesburg", "Africa/Harare", "Africa/Lagos", "Africa/Nairobi", "Africa/Cairo", "Europe/London", "Europe/Amsterdam", "America/New_York", "UTC"];

export default function SettingsTab() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Settings>("/admin/settings");
  const [f, setF] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !f) return <Loading />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF({ ...f, [k]: v });
  const rules = f["projects.health_rules"];
  const setRule = (k: keyof typeof rules, v: string) => set("projects.health_rules", { ...rules, [k]: Number(v) });

  const save = async () => {
    setBusy(true);
    setFormError("");
    try {
      const saved = await api.patch<Settings>("/admin/settings", f);
      setF(saved);
      setErrors({});
      toast.success("Settings saved");
      refresh();
    } catch (e) {
      const x = errFields(e);
      setFormError(x.message);
      setErrors(x.fields);
    } finally {
      setBusy(false);
    }
  };
  const tzOptions = [...new Set([f["org.timezone"], ...TIMEZONES])].map((t) => ({ value: t, label: t }));

  return (
    <div className="stack">
      <FormError message={formError} />
      <Card title="Organisation">
        <div className="form-grid">
          <TextInput label="Organisation name" required value={f["org.name"]} onChange={(v) => set("org.name", v)} error={errors["org.name"]} />
          <TextInput label="Short name" required value={f["org.short_name"]} onChange={(v) => set("org.short_name", v)} error={errors["org.short_name"]} />
          <SelectInput label="Timezone" value={f["org.timezone"]} onChange={(v) => set("org.timezone", v)} options={tzOptions} error={errors["org.timezone"]} hint="Used for 'today', due dates and scheduled reminders." />
          <TextInput label="Currency (ISO code)" value={f["org.currency"]} onChange={(v) => set("org.currency", v.toUpperCase())} maxLength={3} error={errors["org.currency"]} />
        </div>
      </Card>
      <Card title="AI assistance">
        <Checkbox label="Enable AI-assisted features (meeting summaries, action extraction, report drafting, knowledge answers)" checked={f["ai.enabled"]} onChange={(v) => set("ai.enabled", v)} />
        <Callout tone={me?.ai.configured ? "ai" : "warn"} icon="sparkles">
          {me?.ai.configured
            ? "An AI provider key is configured on the server. AI output is always a suggestion that people review before it becomes a record."
            : "No AI provider key is configured on the server (ANTHROPIC_API_KEY). With AI enabled but unconfigured, features fall back to clearly labelled rule-based extraction."}
          {" "}When disabled, the rule-based fallback is used everywhere.
        </Callout>
      </Card>
      <Card title="Projects">
        <SelectInput label="Default progress method for new projects" value={f["projects.default_progress_method"]} onChange={(v) => set("projects.default_progress_method", v)} options={[
          { value: "milestones", label: "Milestone completion" }, { value: "deliverables", label: "Deliverable completion" }, { value: "tasks", label: "Task completion" },
          { value: "manual", label: "Owner-reported progress" }, { value: "weighted", label: "Weighted milestones and deliverables" },
        ]} />
        <h3 className="mb-1">Health suggestion rules</h3>
        <p className="small muted">Health is set by project owners. These transparent rules only drive the <em>suggested</em> health and its explanation.</p>
        <div className="form-grid">
          <TextInput label="Milestone overdue after (days past target)" type="number" min={0} value={rules.overdueMilestoneDays} onChange={(v) => setRule("overdueMilestoneDays", v)} error={errors["projects.health_rules.overdueMilestoneDays"]} />
          <TextInput label="Blocked tasks that need attention" type="number" min={1} value={rules.blockedTasksForAttention} onChange={(v) => setRule("blockedTasksForAttention", v)} error={errors["projects.health_rules.blockedTasksForAttention"]} />
          <TextInput label="Flag when no project update for (days)" type="number" min={1} value={rules.staleUpdateDays} onChange={(v) => setRule("staleUpdateDays", v)} error={errors["projects.health_rules.staleUpdateDays"]} />
        </div>
      </Card>
      <Card title="Notifications & reporting">
        <div className="form-grid">
          <TextInput label="Remind assignees this many days before due" type="number" min={0} max={14} value={f["notifications.reminder_days_before_due"]} onChange={(v) => set("notifications.reminder_days_before_due", Number(v))} error={errors["notifications.reminder_days_before_due"]} />
          <SelectInput label="Default Fakawe audience" value={f["fakawe.default_audience"]} onChange={(v) => set("fakawe.default_audience", v)} options={[{ value: "management", label: "Management only" }, { value: "all_staff", label: "All staff (after approval)" }]} />
        </div>
        <p className="small muted">Email notifications are not configured — notifications are delivered in-app. See Integrations.</p>
      </Card>
      <div className="form-actions">
        <Button onClick={() => data && setF(data)}>Discard changes</Button>
        <Button variant="primary" loading={busy} onClick={save}>Save settings</Button>
      </div>
    </div>
  );
}

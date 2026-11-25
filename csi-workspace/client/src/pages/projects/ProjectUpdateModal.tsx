import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { useForm } from "../../lib/hooks";
import { Button, Callout, FormError, Modal, SelectInput, TextArea, TextInput } from "../../components/ui";
import { ProjectSelect } from "../../components/records";
import { HEALTH_OPTIONS } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  /** Manager context for the fixed project (when projectId given). */
  canManage?: boolean;
  manualProgress?: boolean;
  onSaved?: (projectId: string) => void;
}

/** "Post project update" — used from the project page and from the global quick action (?update=1). */
export function ProjectUpdateModal({ open, onClose, projectId, canManage, manualProgress, onSaved }: Props) {
  const toast = useToast();
  const { me } = useAuth();
  const { lookups } = useLookups();
  const [chosen, setChosen] = useState(projectId ?? "");
  const f = useForm({ summary: "", achievements: "", next_steps: "", blockers: "", health: "", progress: "", period_start: "", period_end: "" });
  useEffect(() => {
    if (open) {
      setChosen(projectId ?? "");
      f.setValues({ summary: "", achievements: "", next_steps: "", blockers: "", health: "", progress: "", period_start: "", period_end: "" });
      f.setErrors({});
      f.setFormError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const lp = lookups?.projects.find((p) => p.id === chosen);
  const isManager = projectId ? !!canManage : !!lp && (lp.owner_id === me?.user.id || lp.my_role === "owner" || lp.my_role === "manager");
  const contributable = (lookups?.projects ?? []).filter((p) => p.owner_id === me?.user.id || (p.my_role && p.my_role !== "viewer"));

  const save = () =>
    f.submit(
      async (v) => {
        await api.post(`/projects/${chosen}/updates`, {
          summary: v.summary,
          achievements: v.achievements,
          next_steps: v.next_steps,
          blockers: v.blockers,
          health: v.health || null,
          progress: v.progress === "" ? null : Number(v.progress),
          period_start: v.period_start || null,
          period_end: v.period_end || null,
        });
        toast.success("Project update posted");
        onSaved?.(chosen);
        onClose();
      },
      (v) => {
        const e: Record<string, string> = {};
        if (!chosen) e.project = "Choose a project.";
        if (!v.summary.trim()) e.summary = "Write a short summary.";
        if (v.progress !== "" && (Number(v.progress) < 0 || Number(v.progress) > 100 || !Number.isInteger(Number(v.progress)))) e.progress = "Enter a whole number from 0 to 100.";
        if (v.period_start && v.period_end && v.period_end < v.period_start) e.period_end = "Must be on or after the start.";
        return e;
      },
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Post project update"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={f.submitting}>
            Post update
          </Button>
        </>
      }
    >
      <FormError message={f.formError} />
      {!projectId &&
        (contributable.length ? (
          <ProjectSelect label="Project" required value={chosen} onChange={setChosen} onlyContributable placeholder="Choose one of your projects…" error={f.errors.project} />
        ) : (
          <Callout tone="warn" icon="info">You are not a contributing member of any project yet, so there is nothing to update.</Callout>
        ))}
      <TextArea label="Summary" required rows={3} value={f.values.summary} onChange={(v) => f.set("summary", v)} error={f.errors.summary} placeholder="What has happened since the last update?" />
      <div className="form-grid">
        <TextArea label="Achievements" rows={2} value={f.values.achievements} onChange={(v) => f.set("achievements", v)} />
        <TextArea label="Next steps" rows={2} value={f.values.next_steps} onChange={(v) => f.set("next_steps", v)} />
        <TextArea label="Blockers" rows={2} className="full" value={f.values.blockers} onChange={(v) => f.set("blockers", v)} />
        <SelectInput
          label="Health"
          value={f.values.health}
          onChange={(v) => f.set("health", v)}
          options={HEALTH_OPTIONS}
          placeholder="No change"
          hint={isManager ? "Updates the project's official health." : "Recorded with your update; the owner sets official health."}
        />
        {(projectId ? manualProgress : true) && (
          <TextInput
            label="Progress (%)"
            type="number"
            min={0}
            max={100}
            value={f.values.progress}
            onChange={(v) => f.set("progress", v)}
            error={f.errors.progress}
            hint={isManager ? "Used when the project reports progress manually." : "Recorded with your update."}
          />
        )}
        <TextInput label="Period start" type="date" value={f.values.period_start} onChange={(v) => f.set("period_start", v)} />
        <TextInput label="Period end" type="date" value={f.values.period_end} onChange={(v) => f.set("period_end", v)} error={f.errors.period_end} />
      </div>
    </Modal>
  );
}

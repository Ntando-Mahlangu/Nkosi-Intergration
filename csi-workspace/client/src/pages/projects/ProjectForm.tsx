import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { Button, Card, ErrorState, FormError, Loading, PageHeader, SelectInput, TextArea, TextInput, Callout } from "../../components/ui";
import { UserSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import { HEALTH_OPTIONS, PRIORITY_OPTIONS, PROGRESS_METHODS, STATUS_OPTIONS, VISIBILITY_OPTIONS, type ProjectDetail } from "./types";

const EMPTY = {
  name: "", code: "", description: "", purpose: "", objectives: [""] as string[], intended_outcomes: "", scope: "", stakeholders: "", reporting_requirements: "",
  category: "", programme_id: "", owner_id: "", team_id: "", status: "planning", health: "on_track", health_note: "", priority: "normal", start_date: "", target_date: "",
  budget_amount: "", budget_currency: "ZAR", budget_notes: "", progress_method: "milestones", manual_progress: "", visibility: "organisation", drive_folder_url: "",
  members: [] as { user_id: string; role: string }[],
  milestones: [] as { title: string; target_date: string }[],
  deliverables: [] as { name: string; due_date: string }[],
};
type FormValues = typeof EMPTY;

export default function ProjectForm() {
  const { id } = useParams();
  const editing = !!id;
  const { data, error, loading, reload } = useApi<ProjectDetail>(editing ? `/projects/${id}` : null);
  if (editing && error) return <ErrorState error={error} onRetry={reload} />;
  if (editing && (loading || !data)) return <Loading />;
  return <ProjectFormInner project={editing ? data : null} />;
}

function ProjectFormInner({ project }: { project: ProjectDetail | null }) {
  const nav = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const { lookups, reload: reloadLookups } = useLookups();
  const f = useForm<FormValues>({ ...EMPTY, owner_id: me?.user.id ?? "", team_id: me?.user.team_id ?? "" });
  const [newMember, setNewMember] = useState({ user_id: "", role: "member" });

  useEffect(() => {
    if (!project) return;
    f.setValues({
      ...EMPTY,
      name: project.name, code: project.code ?? "", description: project.description, purpose: project.purpose,
      objectives: project.objectives ? project.objectives.split("\n").filter(Boolean) : [""],
      intended_outcomes: project.intended_outcomes, scope: project.scope, stakeholders: project.stakeholders, reporting_requirements: project.reporting_requirements,
      category: project.category, programme_id: project.programme_id ?? "", owner_id: project.owner_id ?? "", team_id: project.team_id ?? "", status: project.status,
      health: project.health, health_note: project.health_note, priority: project.priority, start_date: project.start_date ?? "", target_date: project.target_date ?? "",
      budget_amount: project.budget_amount != null ? String(project.budget_amount) : "", budget_currency: project.budget_currency ?? "ZAR", budget_notes: project.budget_notes ?? "",
      progress_method: project.progress_method, manual_progress: project.manual_progress != null ? String(project.manual_progress) : "", visibility: project.visibility, drive_folder_url: project.drive_folder_url,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const v = f.values;
  const showBudget = !project || project.permissions.can_view_budget;
  const categories = lookups?.taxonomies.project_category ?? [];

  const validate = (x: FormValues) => {
    const e: Record<string, string> = {};
    if (!x.name.trim()) e.name = "Give the project a name.";
    if (x.start_date && x.target_date && x.target_date < x.start_date) e.target_date = "Must be on or after the start date.";
    if (x.budget_amount && (isNaN(Number(x.budget_amount)) || Number(x.budget_amount) < 0)) e.budget_amount = "Enter a positive amount.";
    if (x.manual_progress && (isNaN(Number(x.manual_progress)) || Number(x.manual_progress) < 0 || Number(x.manual_progress) > 100)) e.manual_progress = "0–100.";
    if (x.drive_folder_url && !/^https?:\/\//i.test(x.drive_folder_url)) e.drive_folder_url = "Use a full URL starting with https://";
    x.milestones.forEach((m, i) => { if (!m.title.trim()) e[`milestones.${i}.title`] = "Title required."; });
    x.deliverables.forEach((m, i) => { if (!m.name.trim()) e[`deliverables.${i}.name`] = "Name required."; });
    return e;
  };

  const save = () =>
    f.submit(async (x) => {
      const body: Record<string, unknown> = {
        name: x.name, code: x.code, description: x.description, purpose: x.purpose, objectives: x.objectives.map((o) => o.trim()).filter(Boolean).join("\n"),
        intended_outcomes: x.intended_outcomes, scope: x.scope, stakeholders: x.stakeholders, reporting_requirements: x.reporting_requirements, category: x.category,
        programme_id: x.programme_id || null, owner_id: x.owner_id || null, team_id: x.team_id || null, status: x.status, priority: x.priority,
        start_date: x.start_date || null, target_date: x.target_date || null, progress_method: x.progress_method,
        manual_progress: x.manual_progress === "" ? null : Number(x.manual_progress), visibility: x.visibility, drive_folder_url: x.drive_folder_url,
      };
      if (showBudget) Object.assign(body, { budget_amount: x.budget_amount === "" ? null : Number(x.budget_amount), budget_currency: x.budget_currency, budget_notes: x.budget_notes });
      if (project) {
        Object.assign(body, { health: x.health, health_note: x.health_note });
        await api.patch(`/projects/${project.id}`, body);
        toast.success("Project saved");
        reloadLookups();
        nav(`/projects/${project.id}`);
      } else {
        Object.assign(body, {
          members: x.members,
          milestones: x.milestones.map((m) => ({ title: m.title, target_date: m.target_date || null })),
          deliverables: x.deliverables.map((d) => ({ name: d.name, due_date: d.due_date || null })),
        });
        const r = await api.post<{ id: string }>("/projects", body);
        toast.success("Project created");
        reloadLookups();
        nav(`/projects/${r.id}`);
      }
    }, validate);

  if (!project && !can("project.create")) return <ErrorState error="You do not have permission to create projects. Ask an administrator or a project manager." />;

  const listEditor = <K extends "milestones" | "deliverables">(key: K, labelKey: K extends "milestones" ? "title" : "name", dateKey: K extends "milestones" ? "target_date" : "due_date", singular: string) => {
    const rows = v[key] as Record<string, string>[];
    const setRow = (i: number, k: string, val: string) => f.set(key, rows.map((r, j) => (j === i ? { ...r, [k]: val } : r)) as FormValues[K]);
    return (
      <fieldset>
        <legend>Initial {key}</legend>
        {rows.map((r, i) => (
          <div className="row prj-list-row" key={i}>
            <TextInput label={`${singular} ${i + 1}`} value={r[labelKey]} onChange={(val) => setRow(i, labelKey, val)} error={f.errors[`${key}.${i}.${labelKey}`]} className="spacer" />
            <TextInput label={key === "milestones" ? "Target date" : "Due date"} type="date" value={r[dateKey]} onChange={(val) => setRow(i, dateKey, val)} />
            <Button variant="ghost" size="sm" aria-label={`Remove ${singular} ${i + 1}`} onClick={() => f.set(key, rows.filter((_, j) => j !== i) as FormValues[K])}>
              <Icon name="trash" size={14} />
            </Button>
          </div>
        ))}
        <Button size="sm" icon="plus" onClick={() => f.set(key, [...rows, { [labelKey]: "", [dateKey]: "" }] as FormValues[K])}>
          Add {singular.toLowerCase()}
        </Button>
      </fieldset>
    );
  };

  return (
    <>
      <PageHeader
        title={project ? `Edit ${project.name}` : "New project"}
        breadcrumbs={[{ label: "Projects", to: "/projects" }, ...(project ? [{ label: project.name, to: `/projects/${project.id}` }] : []), { label: project ? "Edit" : "New" }]}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
        className="stack"
      >
        <FormError message={f.formError} />
        <Card title="Basics">
          <div className="form-grid">
            <TextInput label="Project name" required value={v.name} onChange={(x) => f.set("name", x)} error={f.errors.name} className="full" />
            <TextInput label="Short code" value={v.code} onChange={(x) => f.set("code", x.toUpperCase())} error={f.errors.code} hint="Optional, e.g. UNM" maxLength={12} />
            <SelectInput label="Category" value={v.category} onChange={(x) => f.set("category", x)} options={categories.map((c) => ({ value: c, label: c }))} placeholder="Choose…" />
            <TextArea label="Description" className="full" rows={3} value={v.description} onChange={(x) => f.set("description", x)} />
            <TextArea label="Purpose" className="full" rows={2} value={v.purpose} onChange={(x) => f.set("purpose", x)} />
          </div>
          <fieldset>
            <legend>Objectives</legend>
            {v.objectives.map((o, i) => (
              <div className="row prj-list-row" key={i}>
                <TextInput label={`Objective ${i + 1}`} value={o} onChange={(x) => f.set("objectives", v.objectives.map((y, j) => (j === i ? x : y)))} className="spacer" />
                <Button variant="ghost" size="sm" aria-label={`Remove objective ${i + 1}`} onClick={() => f.set("objectives", v.objectives.filter((_, j) => j !== i))} disabled={v.objectives.length === 1}>
                  <Icon name="trash" size={14} />
                </Button>
              </div>
            ))}
            <Button size="sm" icon="plus" onClick={() => f.set("objectives", [...v.objectives, ""])}>
              Add objective
            </Button>
          </fieldset>
          <div className="form-grid">
            <TextArea label="Intended outcomes" rows={2} value={v.intended_outcomes} onChange={(x) => f.set("intended_outcomes", x)} />
            <TextArea label="Scope" rows={2} value={v.scope} onChange={(x) => f.set("scope", x)} />
            <TextArea label="Stakeholders" rows={2} value={v.stakeholders} onChange={(x) => f.set("stakeholders", x)} />
            <TextArea label="Reporting requirements" rows={2} value={v.reporting_requirements} onChange={(x) => f.set("reporting_requirements", x)} />
          </div>
        </Card>

        <Card title="People & structure">
          <div className="form-grid">
            <UserSelect label="Project owner" value={v.owner_id} onChange={(x) => f.set("owner_id", x)} error={f.errors.owner_id} hint={project ? "Changing the owner makes the current owner a manager." : undefined} />
            <SelectInput label="Team" value={v.team_id} onChange={(x) => f.set("team_id", x)} options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="No team" />
            <SelectInput label="Programme" value={v.programme_id} onChange={(x) => f.set("programme_id", x)} options={(lookups?.programmes ?? []).map((t) => ({ value: t.id, label: t.name }))} placeholder="No programme" error={f.errors.programme_id} />
          </div>
          {!project && (
            <fieldset>
              <legend>Team members</legend>
              {v.members.length > 0 && (
                <ul className="stack-sm" style={{ listStyle: "none", padding: 0 }}>
                  {v.members.map((m, i) => (
                    <li className="row small" key={m.user_id}>
                      <strong>{lookups?.users.find((u) => u.id === m.user_id)?.name}</strong>
                      <span className="muted">{m.role}</span>
                      <Button variant="ghost" size="sm" onClick={() => f.set("members", v.members.filter((_, j) => j !== i))} aria-label="Remove member">
                        <Icon name="x" size={14} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row prj-list-row">
                <UserSelect label="Add person" value={newMember.user_id} onChange={(x) => setNewMember({ ...newMember, user_id: x })} filter={(u) => u.id !== v.owner_id && !v.members.some((m) => m.user_id === u.id)} className="spacer" />
                <SelectInput label="Role" value={newMember.role} onChange={(x) => setNewMember({ ...newMember, role: x })} options={[{ value: "manager", label: "Manager" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} />
                <Button size="sm" icon="plus" disabled={!newMember.user_id} onClick={() => { f.set("members", [...v.members, newMember]); setNewMember({ user_id: "", role: "member" }); }}>
                  Add
                </Button>
              </div>
            </fieldset>
          )}
        </Card>

        <Card title="Plan & status">
          <div className="form-grid">
            <SelectInput label="Status" value={v.status} onChange={(x) => f.set("status", x)} options={STATUS_OPTIONS} />
            <SelectInput label="Priority" value={v.priority} onChange={(x) => f.set("priority", x)} options={PRIORITY_OPTIONS} />
            {project && (
              <>
                <SelectInput label="Health" value={v.health} onChange={(x) => f.set("health", x)} options={HEALTH_OPTIONS} hint={`Suggested from project data: ${project.health_suggestion.suggested.replace(/_/g, " ")}`} />
                <TextInput label="Health note" value={v.health_note} onChange={(x) => f.set("health_note", x)} hint="Explain the health rating for readers." />
              </>
            )}
            <TextInput label="Start date" type="date" value={v.start_date} onChange={(x) => f.set("start_date", x)} />
            <TextInput label="Target end date" type="date" value={v.target_date} onChange={(x) => f.set("target_date", x)} error={f.errors.target_date} />
            <SelectInput label="Progress method" value={v.progress_method} onChange={(x) => f.set("progress_method", x)} options={PROGRESS_METHODS.map((p) => ({ value: p.value, label: p.label }))} hint={PROGRESS_METHODS.find((p) => p.value === v.progress_method)?.explain} />
            {v.progress_method === "manual" && (
              <TextInput label="Reported progress (%)" type="number" min={0} max={100} value={v.manual_progress} onChange={(x) => f.set("manual_progress", x)} error={f.errors.manual_progress} />
            )}
          </div>
          {!project && (
            <>
              {listEditor("milestones", "title", "target_date", "Milestone")}
              {listEditor("deliverables", "name", "due_date", "Deliverable")}
            </>
          )}
        </Card>

        {showBudget && (
          <Card title="Budget">
            <p className="muted small">Visible only to project owners/managers and management.</p>
            <div className="form-grid">
              <TextInput label="Budget amount" type="number" min={0} value={v.budget_amount} onChange={(x) => f.set("budget_amount", x)} error={f.errors.budget_amount} />
              <TextInput label="Currency" value={v.budget_currency} onChange={(x) => f.set("budget_currency", x.toUpperCase())} maxLength={3} />
              <TextArea label="Budget notes" className="full" rows={2} value={v.budget_notes} onChange={(x) => f.set("budget_notes", x)} />
            </div>
          </Card>
        )}

        <Card title="Access & documents">
          <fieldset>
            <legend>Who can see this project?</legend>
            {VISIBILITY_OPTIONS.map((o) => (
              <label className="check prj-radio" key={o.value}>
                <input type="radio" name="visibility" value={o.value} checked={v.visibility === o.value} onChange={() => f.set("visibility", o.value)} />
                <span>
                  <strong>{o.label}</strong> — <span className="muted">{o.explain}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {v.visibility === "restricted" && <Callout tone="warn" icon="lock">Restricted projects are excluded from search, reports and exports for non-members.</Callout>}
          <TextInput label="Project folder (Google Drive or other link)" type="url" placeholder="https://drive.google.com/drive/folders/…" value={v.drive_folder_url} onChange={(x) => f.set("drive_folder_url", x)} error={f.errors.drive_folder_url} className="mt-2" />
        </Card>

        <div className="form-actions">
          <Button onClick={() => nav(project ? `/projects/${project.id}` : "/projects")}>Cancel</Button>
          <Button type="submit" variant="primary" loading={f.submitting}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </div>
      </form>
    </>
  );
}

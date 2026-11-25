import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm } from "../../lib/hooks";
import { useLookups, useToast } from "../../lib/app-state";
import { fmtDate, humanize } from "../../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, FormError, Loading, Modal, PageHeader, ProgressBar, RichText, SelectInput, StatusBadge, TextArea, TextInput } from "../../components/ui";
import { UserSelect } from "../../components/records";
import type { Progress } from "./types";

interface Programme { id: string; name: string; description: string; owner_id: string | null; owner_name: string | null; status: string; project_count: number; by_status: Record<string, number>; by_health: Record<string, number> }
interface ProgrammeDetail extends Programme {
  projects: { id: string; name: string; code: string | null; status: string; health: string; priority: string; target_date: string | null; owner_name: string | null; progress: Progress }[];
  can_manage: boolean;
}
const STATUS_TONE: Record<string, "ok" | "warn" | "neutral"> = { active: "ok", paused: "warn", closed: "neutral" };

function HealthMix({ by }: { by: Record<string, number> }) {
  const entries = Object.entries(by);
  if (!entries.length) return <span className="muted small">No visible projects</span>;
  return <span className="row">{entries.map(([k, n]) => <span key={k} className="row" style={{ gap: 4 }}><StatusBadge kind="health" value={k} /><span className="small">×{n}</span></span>)}</span>;
}

export function ProgrammesList() {
  const { data, error, loading, reload } = useApi<{ items: Programme[]; can_manage: boolean }>("/programmes");
  const [editing, setEditing] = useState<Programme | "new" | null>(null);
  return (
    <>
      <PageHeader
        title="Programmes"
        subtitle="Programmes group related projects. Counts include only projects you can see."
        breadcrumbs={[{ label: "Projects", to: "/projects" }, { label: "Programmes" }]}
        actions={data?.can_manage && <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New programme</Button>}
      />
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data?.items.length ? (
        <Card><EmptyState icon="layers" title="No programmes yet" /></Card>
      ) : (
        <div className="grid grid-3">
          {data.items.map((g) => (
            <div className="card card-pad stack-sm" key={g.id}>
              <div className="row-between">
                <h3><Link to={`/projects/programmes/${g.id}`}>{g.name}</Link></h3>
                <Badge tone={STATUS_TONE[g.status] ?? "neutral"}>{humanize(g.status)}</Badge>
              </div>
              <div className="small muted">Owner: {g.owner_name ?? "—"} · {g.project_count} project{g.project_count === 1 ? "" : "s"}</div>
              {g.description && <p className="small">{g.description}</p>}
              <HealthMix by={g.by_health} />
            </div>
          ))}
        </div>
      )}
      {editing && <ProgrammeModal programme={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

export function ProgrammeView() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<ProgrammeDetail>(`/programmes/${id}`);
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  return (
    <>
      <PageHeader
        title={data.name}
        subtitle={<span className="row"><Badge tone={STATUS_TONE[data.status] ?? "neutral"}>{humanize(data.status)}</Badge><span className="muted small">Owner: {data.owner_name ?? "—"}</span></span>}
        breadcrumbs={[{ label: "Projects", to: "/projects" }, { label: "Programmes", to: "/projects/programmes" }, { label: data.name }]}
        actions={data.can_manage && <Button icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
      />
      <div className="stack">
        {data.description && <Card><RichText text={data.description} /></Card>}
        <Card title="Aggregate status"><div className="stack-sm"><div className="row small"><strong>Status:</strong>{Object.entries(data.by_status).map(([k, n]) => <span key={k} className="row" style={{ gap: 4 }}><StatusBadge kind="project" value={k} />×{n}</span>)}</div><div className="row small"><strong>Health:</strong><HealthMix by={data.by_health} /></div></div></Card>
        <Card title={`Projects (${data.projects.length})`} pad={false}>
          {!data.projects.length ? <EmptyState icon="folder" title="No visible projects in this programme" /> : (
            <div className="table-wrap">
              <table className="table table-stack">
                <thead><tr><th>Project</th><th>Owner</th><th>Status</th><th>Health</th><th>Progress</th><th>Target</th></tr></thead>
                <tbody>
                  {data.projects.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Project"><Link to={`/projects/${p.id}`} className="strong">{p.name}</Link></td>
                      <td data-label="Owner">{p.owner_name ?? "—"}</td>
                      <td data-label="Status"><StatusBadge kind="project" value={p.status} /></td>
                      <td data-label="Health"><StatusBadge kind="health" value={p.health} /></td>
                      <td data-label="Progress" title={p.progress.explanation} style={{ minWidth: 120 }}><ProgressBar value={p.progress.value} label="" /></td>
                      <td data-label="Target">{fmtDate(p.target_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {editing && <ProgrammeModal programme={data} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </>
  );
}

function ProgrammeModal({ programme, onClose, onSaved }: { programme: Programme | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { reload: reloadLookups } = useLookups();
  const f = useForm({ name: programme?.name ?? "", description: programme?.description ?? "", owner_id: programme?.owner_id ?? "", status: programme?.status ?? "active" });
  const save = () =>
    f.submit(
      async (x) => {
        const body = { ...x, owner_id: x.owner_id || null };
        if (programme) await api.patch(`/programmes/${programme.id}`, body);
        else await api.post("/programmes", body);
        toast.success("Programme saved");
        reloadLookups();
        onSaved();
      },
      (x): Record<string, string> => (x.name.trim() ? {} : { name: "Give the programme a name." }),
    );
  return (
    <Modal open onClose={onClose} title={programme ? "Edit programme" : "New programme"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={f.submitting}>Save</Button></>}>
      <FormError message={f.formError} />
      <TextInput label="Name" required value={f.values.name} onChange={(x) => f.set("name", x)} error={f.errors.name} />
      <TextArea label="Description" rows={3} value={f.values.description} onChange={(x) => f.set("description", x)} />
      <UserSelect label="Owner" value={f.values.owner_id} onChange={(x) => f.set("owner_id", x)} />
      <SelectInput label="Status" value={f.values.status} onChange={(x) => f.set("status", x)} options={[{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "closed", label: "Closed" }]} />
    </Modal>
  );
}

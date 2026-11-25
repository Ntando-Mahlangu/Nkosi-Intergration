import { useState } from "react";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useLookups, useToast } from "../../lib/app-state";
import { Badge, Button, Card, ErrorState, Loading } from "../../components/ui";
import { errFields } from "./shared";

interface Term { id: string; label: string; active: number; sort_order: number }
interface Tax { key: string; label: string; terms: Term[] }

export default function TaxonomiesTab() {
  const { data, error, loading, reload } = useApi<{ taxonomies: Tax[] }>("/admin/taxonomies");
  const { reload: reloadLookups } = useLookups();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const after = () => {
    reload();
    reloadLookups();
  };
  return (
    <div className="stack">
      <p className="muted small">Categories and types used across modules. Deactivated terms stay on existing records but are no longer offered for new ones.</p>
      <div className="grid grid-2">
        {data?.taxonomies.map((t) => <TaxCard key={t.key} tax={t} onChanged={after} />)}
      </div>
    </div>
  );
}

function TaxCard({ tax, onChanged }: { tax: Tax; onChanged: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      onChanged();
    } catch (e) {
      toast.error(errFields(e).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => label.trim() && call(() => api.post(`/admin/taxonomies/${tax.key}`, { label: label.trim() }), "Term added").then(() => setLabel(""));
  return (
    <Card title={tax.label}>
      <div>
        {tax.terms.map((t, i) => (
          <div key={t.id} className={`adm-term ${t.active ? "" : "inactive"}`}>
            {editing === t.id ? (
              <form className="row adm-term-label" onSubmit={(e) => { e.preventDefault(); call(() => api.patch(`/admin/taxonomy-terms/${t.id}`, { label: editLabel }), "Renamed").then(() => setEditing(null)); }}>
                <input className="input" aria-label="Term label" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} autoFocus style={{ flex: 1 }} />
                <Button size="sm" type="submit" variant="primary" disabled={!editLabel.trim()}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <span className="adm-term-label small">{t.label} {!t.active && <Badge>Inactive</Badge>}</span>
                <button className="btn btn-ghost btn-sm" disabled={busy || i === 0} aria-label={`Move ${t.label} up`} onClick={() => call(() => api.patch(`/admin/taxonomy-terms/${t.id}`, { move: "up" }))}>↑</button>
                <button className="btn btn-ghost btn-sm" disabled={busy || i === tax.terms.length - 1} aria-label={`Move ${t.label} down`} onClick={() => call(() => api.patch(`/admin/taxonomy-terms/${t.id}`, { move: "down" }))}>↓</button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(t.id); setEditLabel(t.label); }}>Rename</Button>
                <Button size="sm" variant="ghost" onClick={() => call(() => api.patch(`/admin/taxonomy-terms/${t.id}`, { active: !t.active }), t.active ? "Deactivated" : "Reactivated")}>{t.active ? "Deactivate" : "Activate"}</Button>
              </>
            )}
          </div>
        ))}
      </div>
      <form className="row mt-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="New term" aria-label={`New ${tax.label} term`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        <Button type="submit" size="sm" icon="plus" disabled={!label.trim()} loading={busy}>Add</Button>
      </form>
    </Card>
  );
}

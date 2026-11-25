import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useLookups, useToast } from "../../lib/app-state";
import { AIBadge, Badge, Button, Callout, Card, EmptyState, ErrorState, Loading, PageHeader, SelectInput, StatusBadge, TextArea, TextInput } from "../../components/ui";
import { UserSelect, recordPath } from "../../components/records";
import { Icon } from "../../components/Icon";
import { plural } from "../../lib/format";
import type { Participant, Suggestion } from "./types";

interface ReviewResponse { items: Suggestion[]; participants: Participant[]; project_id: string | null; meeting_title: string; meeting_status: string }

const GROUPS: { kind: string[]; title: string; help: string }[] = [
  { kind: ["summary"], title: "Summary", help: "Accepting sets the meeting's summary. You can edit it first." },
  { kind: ["decision"], title: "Decisions", help: "Only accept items that were actually decided — not proposals or options." },
  { kind: ["action"], title: "Action items", help: "Accepted actions assigned to someone else are sent to them as suggestions they must confirm." },
  { kind: ["risk", "blocker"], title: "Risks & blockers", help: "Accepted items are added to the project's risk register." },
  { kind: ["project_update"], title: "Project update", help: "Posts an update to the project (project owners/managers only)." },
  { kind: ["knowledge"], title: "Knowledge suggestions", help: "Accepted items become knowledge drafts submitted for review." },
  { kind: ["follow_up_question"], title: "Follow-up questions", help: "Accepted questions are added to the meeting's follow-up points." },
];

const CONF_TONE = { high: "ok", medium: "warn", low: "danger" } as const;

export default function MeetingReview() {
  const { id } = useParams();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<ReviewResponse>(`/meetings/${id}/suggestions`);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string>("");

  const pending = useMemo(() => (data?.items ?? []).filter((s) => s.status === "pending"), [data]);
  const engine = data?.items[0]?.engine;

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;

  const setEdit = (sid: string, k: string, v: unknown) => setEdits((e) => ({ ...e, [sid]: { ...(e[sid] ?? {}), [k]: v } }));
  const val = (s: Suggestion, k: string, fallback: unknown) => (edits[s.id] && k in edits[s.id] ? edits[s.id][k] : fallback);

  const act = async (s: Suggestion, action: "accept" | "reject") => {
    setBusy(s.id);
    setErrors((e) => ({ ...e, [s.id]: "" }));
    try {
      if (action === "accept") await api.post(`/meetings/${id}/suggestions/${s.id}/accept`, edits[s.id] ?? {});
      else await api.post(`/meetings/${id}/suggestions/${s.id}/reject`);
      toast.success(action === "accept" ? "Accepted" : "Rejected");
      setSelected((sel) => { const n = new Set(sel); n.delete(s.id); return n; });
      await reload();
    } catch (e) {
      setErrors((x) => ({ ...x, [s.id]: (e as Error).message }));
    } finally {
      setBusy("");
    }
  };

  const bulk = async (action: "accept" | "reject") => {
    const ids = [...selected];
    if (!ids.length) return;
    // Edited suggestions are accepted individually so their edits are kept.
    setBusy("bulk");
    try {
      let ok = 0;
      const failures: string[] = [];
      const editedIds = action === "accept" ? ids.filter((x) => edits[x] && Object.keys(edits[x]).length) : [];
      for (const sid of editedIds) {
        try { await api.post(`/meetings/${id}/suggestions/${sid}/accept`, edits[sid]); ok++; } catch (e) { failures.push((e as Error).message); setErrors((x) => ({ ...x, [sid]: (e as Error).message })); }
      }
      const rest = ids.filter((x) => !editedIds.includes(x));
      if (rest.length) {
        const r = await api.post<{ results: { id: string; ok: boolean; error?: string }[] }>(`/meetings/${id}/suggestions/bulk`, { ids: rest, action });
        for (const x of r.results) {
          if (x.ok) ok++;
          else { failures.push(x.error ?? "Failed"); setErrors((e) => ({ ...e, [x.id]: x.error ?? "Failed" })); }
        }
      }
      if (ok) toast.success(`${plural(ok, "suggestion")} ${action === "accept" ? "accepted" : "rejected"}`);
      if (failures.length) toast.error(`${plural(failures.length, "item")} could not be ${action}ed — see the messages below.`);
      setSelected(new Set());
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const sendFeedback = async (rating: "helpful" | "not_helpful") => {
    try {
      await api.post("/ai/feedback", { feature: "meeting_analysis", reference_id: id, rating });
      setFeedback(rating);
      toast.success("Thanks for the feedback");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const participantIds = new Set(data.participants.filter((p) => p.user_id).map((p) => p.user_id!));

  const renderFields = (s: Suggestion) => {
    const p = s.payload;
    const disabled = s.status !== "pending";
    switch (s.kind) {
      case "action":
        return (
          <div className="mtg-sug-grid">
            <TextInput label="Action" value={String(val(s, "title", p.title ?? ""))} onChange={(v) => setEdit(s.id, "title", v)} disabled={disabled} />
            <UserSelect
              label="Owner"
              value={String(val(s, "owner_id", p.owner_id ?? "") ?? "")}
              onChange={(v) => setEdit(s.id, "owner_id", v)}
              placeholder="No owner identified"
              hint={p.owner_name && !p.owner_id ? `Notes mention “${p.owner_name}” — could not match a CSI user` : participantIds.size ? "Participants listed first in the meeting record." : undefined}
            />
            <TextInput label="Due date" type="date" value={String(val(s, "due_date", p.due_date ?? "") ?? "")} onChange={(v) => setEdit(s.id, "due_date", v)} disabled={disabled} hint={p.due_date_basis ? `From “${p.due_date_basis}”` : "No deadline stated"} />
          </div>
        );
      case "decision":
        return (
          <>
            <TextInput label="Decision" value={String(val(s, "title", p.title ?? ""))} onChange={(v) => setEdit(s.id, "title", v)} disabled={disabled} />
          </>
        );
      case "risk":
      case "blocker":
        return (
          <div className="mtg-sug-grid">
            <TextInput label={s.kind === "blocker" ? "Blocker" : "Risk"} value={String(val(s, "title", p.title ?? ""))} onChange={(v) => setEdit(s.id, "title", v)} disabled={disabled} />
            <SelectInput
              label="Severity"
              value={String(val(s, "severity", s.kind === "blocker" ? "high" : "medium"))}
              onChange={(v) => setEdit(s.id, "severity", v)}
              options={["low", "medium", "high", "critical"].map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }))}
              disabled={disabled}
            />
            <UserSelect label="Owner" value={String(val(s, "owner_id", "") ?? "")} onChange={(v) => setEdit(s.id, "owner_id", v)} placeholder="No owner identified" />
          </div>
        );
      case "knowledge":
        return (
          <>
            <TextInput label="Title" value={String(val(s, "title", p.title ?? ""))} onChange={(v) => setEdit(s.id, "title", v)} disabled={disabled} />
            <TextArea label="Insight" rows={2} value={String(val(s, "text", p.insight ?? ""))} onChange={(v) => setEdit(s.id, "text", v)} disabled={disabled} />
          </>
        );
      default:
        return <TextArea label={s.kind === "summary" ? "Summary" : s.kind === "project_update" ? "Update" : "Question"} rows={s.kind === "summary" ? 4 : 2} value={String(val(s, "text", p.text ?? ""))} onChange={(v) => setEdit(s.id, "text", v)} disabled={disabled} />;
    }
  };

  return (
    <>
      <PageHeader
        title="Review suggestions"
        subtitle={<Link to={`/meetings/${id}`}>{data.meeting_title}</Link>}
        breadcrumbs={[{ label: "Meetings", to: "/meetings" }, { label: data.meeting_title, to: `/meetings/${id}` }, { label: "Review" }]}
        actions={
          pending.length > 0 && (
            <>
              <Button size="sm" onClick={() => setSelected(selected.size === pending.length ? new Set() : new Set(pending.map((s) => s.id)))}>
                {selected.size === pending.length ? "Clear selection" : "Select all pending"}
              </Button>
              <Button size="sm" variant="danger" disabled={!selected.size} loading={busy === "bulk"} onClick={() => bulk("reject")}>Reject selected</Button>
              <Button size="sm" variant="primary" icon="check" disabled={!selected.size} loading={busy === "bulk"} onClick={() => bulk("accept")}>Accept selected ({selected.size})</Button>
            </>
          )
        }
      />
      <div className="stack mb-3">
        <Callout tone="ai" icon="sparkles">
          <div className="row mb-1"><strong>These are suggestions, not records.</strong>{engine && <AIBadge engine={engine} />}</div>
          Nothing is assigned, decided or added to a project until you accept it. Owners and deadlines are only filled in when the notes state them. People you assign must confirm their actions before they become responsibilities.
        </Callout>
        {!data.project_id && <Callout tone="warn" icon="info">This meeting isn't linked to a project, so risks and project updates can't be accepted. Link a project by editing the meeting.</Callout>}
      </div>

      {!data.items.length ? (
        <div className="card"><EmptyState icon="sparkles" title="No suggestions yet">Submit notes and choose “Extract actions & decisions” on the meeting page.</EmptyState></div>
      ) : (
        GROUPS.map((g) => {
          const items = data.items.filter((s) => g.kind.includes(s.kind));
          if (!items.length) return null;
          return (
            <section className="section" key={g.title} aria-labelledby={`grp-${g.kind[0]}`}>
              <div className="section-head">
                <h2 id={`grp-${g.kind[0]}`}>{g.title} <span className="muted small">({items.filter((i) => i.status === "pending").length} pending)</span></h2>
                <span className="meta">{g.help}</span>
              </div>
              <div className="stack">
                {items.map((s) => {
                  const p = s.payload;
                  const done = s.status !== "pending";
                  const conf = p.confidence;
                  return (
                    <div className={`mtg-sug ${selected.has(s.id) ? "selected" : ""} ${done ? "done" : ""}`} key={s.id}>
                      <div className="mtg-sug-head">
                        {!done && (
                          <label className="check" style={{ marginTop: 2 }}>
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={(e) => setSelected((sel) => { const n = new Set(sel); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })}
                              aria-label={`Select ${p.title ?? p.text ?? s.kind}`}
                            />
                          </label>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="row mb-1">
                            {s.kind === "blocker" && <Badge tone="danger" icon="ban">Blocker</Badge>}
                            {conf && <Badge tone={CONF_TONE[conf]} title="How clearly the notes support this item">{conf[0].toUpperCase() + conf.slice(1)} confidence</Badge>}
                            <StatusBadge kind="suggestion" value={s.status} />
                            {done && s.resulting_type && s.resulting_id && recordPath(s.resulting_type, s.resulting_id) !== "#" && (
                              <Link className="small" to={recordPath(s.resulting_type, s.resulting_id)}>Open created {s.resulting_type}</Link>
                            )}
                            {done && s.reviewer_name && <span className="tiny muted">by {s.reviewer_name}</span>}
                          </div>
                          {renderFields(s)}
                          {p.evidence && (
                            <div className="evidence mt-1">
                              <span className="tiny strong">Source text: </span>“{String(p.evidence)}”
                            </div>
                          )}
                          {s.kind === "summary" && Array.isArray(p.key_topics) && p.key_topics.length > 0 && <div className="tiny muted mt-1">Topics: {p.key_topics.join("; ")}</div>}
                          {errors[s.id] && <div className="form-error mt-1" role="alert">{errors[s.id]}</div>}
                        </div>
                      </div>
                      {!done && (
                        <div className="row mt-1" style={{ justifyContent: "flex-end" }}>
                          <Button size="sm" variant="ghost" icon="x" loading={busy === s.id} onClick={() => act(s, "reject")}>Reject</Button>
                          <Button size="sm" variant="primary" icon="check" loading={busy === s.id} onClick={() => act(s, "accept")}>
                            {edits[s.id] && Object.keys(edits[s.id]).length ? "Accept with edits" : "Accept"}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {data.items.length > 0 && (
        <Card>
          <div className="row-between">
            <span className="small">Were these suggestions useful?</span>
            {feedback ? (
              <span className="small muted"><Icon name="check" size={14} /> Feedback recorded</span>
            ) : (
              <div className="row">
                <Button size="sm" icon="thumbsUp" onClick={() => sendFeedback("helpful")}>Helpful</Button>
                <Button size="sm" icon="thumbsDown" onClick={() => sendFeedback("not_helpful")}>Not helpful</Button>
              </div>
            )}
          </div>
          {pending.length === 0 && (
            <div className="mt-2">
              <Callout tone="ok" icon="checkCircle">All suggestions reviewed. <Link to={`/meetings/${id}`}>Return to the meeting</Link> to approve the record.</Callout>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useApi, useForm, localToday } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { Button, Callout, Card, Checkbox, ErrorState, FormError, Loading, PageHeader, SelectInput, Segmented, TextArea, TextInput } from "../../components/ui";
import { ProjectSelect } from "../../components/records";
import { Icon } from "../../components/Icon";
import type { MeetingDetailResponse } from "./types";

type Mode = "structured" | "freeform";

interface Values extends Record<string, unknown> {
  title: string;
  meeting_type: string;
  meeting_date: string;
  start_time: string;
  end_time: string;
  project_id: string;
  purpose: string;
  location: string;
  meeting_link: string;
  confidential: boolean;
  preparation_required: boolean;
  preparation_notes: string;
  follow_up_date: string;
  // structured notes
  discussion: string;
  decisions: string;
  actions: string;
  risks: string;
  follow_ups: string;
  // free-form / imported
  notes: string;
  transcript: string;
  transcript_source: string;
}

const EMPTY: Values = {
  title: "", meeting_type: "", meeting_date: localToday(), start_time: "", end_time: "", project_id: "", purpose: "", location: "", meeting_link: "",
  confidential: false, preparation_required: false, preparation_notes: "", follow_up_date: "",
  discussion: "", decisions: "", actions: "", risks: "", follow_ups: "", notes: "", transcript: "", transcript_source: "",
};

const bullets = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^[-*•]/.test(l) ? l : `- ${l}`))
    .join("\n");

/** Compose structured fields into notes using the section headers the extractor recognises. */
function composeNotes(v: Values): string {
  const parts: string[] = [];
  if (v.discussion.trim()) parts.push(`Discussion:\n${bullets(v.discussion)}`);
  if (v.decisions.trim()) parts.push(`Decisions:\n${bullets(v.decisions)}`);
  if (v.actions.trim()) parts.push(`Actions:\n${bullets(v.actions)}`);
  if (v.risks.trim()) parts.push(`Risks and blockers:\n${bullets(v.risks)}`);
  if (v.follow_ups.trim()) parts.push(`Follow-ups:\n${bullets(v.follow_ups)}`);
  return parts.join("\n\n");
}

export default function MeetingForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const { lookups } = useLookups();
  const existing = useApi<MeetingDetailResponse>(editing ? `/meetings/${id}` : null);
  const f = useForm<Values>(EMPTY);
  const [mode, setMode] = useState<Mode>("structured");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [externals, setExternals] = useState<{ name: string; org: string }[]>([]);
  const [extDraft, setExtDraft] = useState({ name: "", org: "" });
  const [pick, setPick] = useState("");
  const [importAs, setImportAs] = useState<"notes" | "transcript">("notes");
  const [importedFrom, setImportedFrom] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!existing.data) return;
    const m = existing.data.meeting;
    f.setValues({
      ...EMPTY,
      title: m.title, meeting_type: m.meeting_type, meeting_date: m.meeting_date, start_time: m.start_time ?? "", end_time: m.end_time ?? "",
      project_id: m.project_id ?? "", purpose: m.purpose, location: m.location, meeting_link: m.meeting_link, confidential: !!m.confidential,
      preparation_required: !!m.preparation_required, preparation_notes: m.preparation_notes, follow_up_date: m.follow_up_date ?? "",
      notes: m.notes, transcript: m.transcript, transcript_source: m.transcript_source,
    });
    setUserIds(existing.data.participants.filter((p) => p.user_id).map((p) => p.user_id!));
    setExternals(existing.data.participants.filter((p) => !p.user_id).map((p) => ({ name: p.external_name, org: p.external_org })));
    setMode("freeform");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data]);

  useEffect(() => {
    if (!editing && me && !userIds.length) setUserIds([me.user.id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const types = lookups?.taxonomies.meeting_type ?? [];
  const users = lookups?.users ?? [];
  const isPast = f.values.meeting_date < localToday();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|vtt|srt)$/i.test(file.name)) return toast.error("Upload a .txt, .md, .vtt or .srt file.");
    if (file.size > 2_000_000) return toast.error("That file is too large (max 2 MB).");
    const text = await file.text();
    const cleaned = /\.(vtt|srt)$/i.test(file.name)
      ? text
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
          .join("\n")
      : text;
    if (importAs === "transcript") {
      f.set("transcript", cleaned);
      f.set("transcript_source", `uploaded:${file.name}`);
    } else f.set("notes", (f.values.notes ? f.values.notes + "\n\n" : "") + cleaned);
    setImportedFrom(file.name);
    toast.info(`Imported ${file.name} as ${importAs}. Review it before saving.`);
    if (fileRef.current) fileRef.current.value = "";
  };

  const validate = (v: Values) => {
    const e: Record<string, string> = {};
    if (!v.title.trim()) e.title = "Give the meeting a title.";
    if (!v.meeting_date) e.meeting_date = "Choose a date.";
    if (v.start_time && v.end_time && v.end_time < v.start_time) e.end_time = "End time must be after the start time.";
    if (v.meeting_link && !/^https?:\/\//i.test(v.meeting_link)) e.meeting_link = "Use a full URL starting with https://";
    return e;
  };

  const save = () =>
    f.submit(async (v) => {
      const structured = mode === "structured" ? composeNotes(v) : "";
      const notes = mode === "structured" ? [structured, v.notes].filter((s) => s.trim()).join("\n\n") : v.notes;
      const body = {
        title: v.title, meeting_type: v.meeting_type || "Internal planning", meeting_date: v.meeting_date, start_time: v.start_time, end_time: v.end_time,
        project_id: v.project_id, purpose: v.purpose, location: v.location, meeting_link: v.meeting_link, confidential: v.confidential,
        preparation_required: v.preparation_required, preparation_notes: v.preparation_notes, follow_up_date: v.follow_up_date,
        participants: { user_ids: userIds, external: externals },
      };
      if (editing) {
        await api.patch(`/meetings/${id}`, body);
        const m = existing.data!.meeting;
        if ((notes !== m.notes || v.transcript !== m.transcript) && m.status !== "approved" && (notes.trim() || v.transcript.trim())) {
          await api.post(`/meetings/${id}/notes`, { notes, transcript: v.transcript, transcript_source: v.transcript_source });
        }
        toast.success("Meeting updated");
        nav(`/meetings/${id}`);
      } else {
        const r = await api.post<{ id: string }>("/meetings", { ...body, notes, transcript: v.transcript, transcript_source: v.transcript_source });
        toast.success("Meeting saved");
        nav(`/meetings/${r.id}`);
      }
    }, validate);

  if (editing && existing.error) return <ErrorState error={existing.error} />;
  if (editing && !existing.data) return <Loading />;
  const approved = existing.data?.meeting.status === "approved";

  return (
    <>
      <PageHeader
        title={editing ? "Edit meeting" : "New meeting"}
        subtitle={editing ? existing.data?.meeting.title : "Schedule a meeting or record notes from one that has happened."}
        breadcrumbs={[{ label: "Meetings", to: "/meetings" }, ...(editing ? [{ label: existing.data!.meeting.title, to: `/meetings/${id}` }] : []), { label: editing ? "Edit" : "New" }]}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
        className="stack"
        style={{ maxWidth: 900 }}
      >
        <FormError message={f.formError} />
        <Card title="Meeting details">
          <div className="form-grid">
            <TextInput className="full" label="Title" required value={f.values.title} onChange={(v) => f.set("title", v)} error={f.errors.title} />
            <SelectInput label="Meeting type" value={f.values.meeting_type} onChange={(v) => f.set("meeting_type", v)} placeholder="Choose a type…" options={types.map((t) => ({ value: t, label: t }))} error={f.errors.meeting_type} />
            <ProjectSelect value={f.values.project_id} onChange={(v) => f.set("project_id", v)} error={f.errors.project_id} hint="Linking a project lets approved actions, decisions and risks flow into it." />
            <TextInput label="Date" type="date" required value={f.values.meeting_date} onChange={(v) => f.set("meeting_date", v)} error={f.errors.meeting_date} />
            <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
              <TextInput label="Start" type="time" value={f.values.start_time} onChange={(v) => f.set("start_time", v)} error={f.errors.start_time} />
              <TextInput label="End" type="time" value={f.values.end_time} onChange={(v) => f.set("end_time", v)} error={f.errors.end_time} />
            </div>
            <TextInput label="Location" value={f.values.location} onChange={(v) => f.set("location", v)} placeholder="Room, venue or ‘Online’" />
            <TextInput label="Meeting link" type="url" value={f.values.meeting_link} onChange={(v) => f.set("meeting_link", v)} error={f.errors.meeting_link} placeholder="https://meet.google.com/…" />
            <TextArea className="full" label="Purpose" rows={2} value={f.values.purpose} onChange={(v) => f.set("purpose", v)} />
            <TextInput label="Follow-up date" type="date" value={f.values.follow_up_date} onChange={(v) => f.set("follow_up_date", v)} error={f.errors.follow_up_date} />
            <div>
              <Checkbox label="Confidential (visible to participants only)" checked={f.values.confidential} onChange={(v) => f.set("confidential", v)} />
              <Checkbox label="Preparation required" checked={f.values.preparation_required} onChange={(v) => f.set("preparation_required", v)} />
            </div>
            {f.values.preparation_required && <TextArea className="full" label="Preparation notes" rows={2} value={f.values.preparation_notes} onChange={(v) => f.set("preparation_notes", v)} />}
          </div>
        </Card>

        <Card title="Participants">
          <div className="mtg-picker mb-2" aria-label="Selected participants">
            {userIds.map((uid) => (
              <span className="mtg-chip" key={uid}>
                {users.find((u) => u.id === uid)?.name ?? "Unknown"}
                <button type="button" aria-label={`Remove ${users.find((u) => u.id === uid)?.name ?? "participant"}`} onClick={() => setUserIds(userIds.filter((x) => x !== uid))}>×</button>
              </span>
            ))}
            {externals.map((e, i) => (
              <span className="mtg-chip" key={`ext-${i}`}>
                {e.name}{e.org ? ` (${e.org})` : ""} <span className="tiny muted">external</span>
                <button type="button" aria-label={`Remove ${e.name}`} onClick={() => setExternals(externals.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {!userIds.length && !externals.length && <span className="muted small">No participants yet.</span>}
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <SelectInput
                label="Add a CSI participant"
                value={pick}
                onChange={(v) => {
                  if (v && !userIds.includes(v)) setUserIds([...userIds, v]);
                  setPick("");
                }}
                placeholder="Choose a person…"
                options={users.filter((u) => !userIds.includes(u.id)).map((u) => ({ value: u.id, label: u.name }))}
              />
            </div>
          </div>
          <div className="mtg-ext-row">
            <TextInput label="External participant name" value={extDraft.name} onChange={(v) => setExtDraft({ ...extDraft, name: v })} />
            <TextInput label="Organisation" value={extDraft.org} onChange={(v) => setExtDraft({ ...extDraft, org: v })} />
            <Button
              className="mb-2"
              icon="plus"
              disabled={!extDraft.name.trim()}
              onClick={() => {
                setExternals([...externals, { name: extDraft.name.trim(), org: extDraft.org.trim() }]);
                setExtDraft({ name: "", org: "" });
              }}
            >
              Add
            </Button>
          </div>
        </Card>

        {approved ? (
          <Callout tone="accent" icon="lock">This meeting record is approved, so its notes can't be changed. Reopen it from the meeting page if a correction is needed.</Callout>
        ) : (
          <Card title={isPast || editing ? "Meeting notes" : "Notes (optional — add after the meeting)"}>
            <div className="mtg-mode">
              <Segmented<Mode>
                label="Notes entry mode"
                value={mode}
                onChange={setMode}
                options={[
                  { key: "structured", label: "Structured form" },
                  { key: "freeform", label: "Paste or upload notes" },
                ]}
              />
            </div>
            {mode === "structured" ? (
              <>
                <p className="small muted">One item per line. Write actions as “Name to do something by date” so owners and deadlines can be recognised — nothing is assigned until you review it.</p>
                <TextArea label="Key discussions" rows={3} value={f.values.discussion} onChange={(v) => f.set("discussion", v)} />
                <TextArea label="Decisions" rows={2} value={f.values.decisions} onChange={(v) => f.set("decisions", v)} placeholder="e.g. Pilot cohort capped at 12 participants" />
                <TextArea label="Action items" rows={3} value={f.values.actions} onChange={(v) => f.set("actions", v)} placeholder="e.g. Lerato to draft the invitation pack by 2026-12-04" />
                <TextArea label="Risks and blockers" rows={2} value={f.values.risks} onChange={(v) => f.set("risks", v)} />
                <TextArea label="Follow-up requirements" rows={2} value={f.values.follow_ups} onChange={(v) => f.set("follow_ups", v)} />
                {f.values.notes && <TextArea label="Additional free-form notes" rows={4} value={f.values.notes} onChange={(v) => f.set("notes", v)} />}
              </>
            ) : (
              <>
                <TextArea label="Notes" rows={10} value={f.values.notes} onChange={(v) => f.set("notes", v)} hint="Paste notes as written. Markers like “Action:”, “Decision:” and “Risk:” help extraction." />
                <div className="row mb-2" style={{ alignItems: "flex-end" }}>
                  <SelectInput label="Import file as" value={importAs} onChange={(v) => setImportAs(v as "notes" | "transcript")} options={[{ value: "notes", label: "Meeting notes" }, { value: "transcript", label: "Transcript" }]} />
                  <div className="field">
                    <input ref={fileRef} type="file" accept=".txt,.md,.vtt,.srt,text/plain,text/markdown" className="sr-only" id="mtg-file" onChange={(e) => onFile(e.target.files?.[0])} />
                    <label htmlFor="mtg-file" className="btn">
                      <Icon name="upload" size={16} /> Upload .txt / .md / .vtt / .srt
                    </label>
                  </div>
                </div>
                {importedFrom && <Callout tone="warn" icon="info">Imported content from <strong>{importedFrom}</strong>. It is stored as submitted text and kept separate from the approved meeting record.</Callout>}
                <TextArea
                  label="Transcript (imported, if authorised)"
                  rows={6}
                  value={f.values.transcript}
                  onChange={(v) => {
                    f.set("transcript", v);
                    if (!f.values.transcript_source) f.set("transcript_source", "pasted");
                  }}
                  hint="Only add transcripts where recording/transcription was authorised by participants."
                />
              </>
            )}
          </Card>
        )}

        <div className="form-actions">
          <Button onClick={() => nav(editing ? `/meetings/${id}` : "/meetings")}>Cancel</Button>
          <Button type="submit" variant="primary" loading={f.submitting}>
            {editing ? "Save changes" : "Save meeting"}
          </Button>
        </div>
      </form>
    </>
  );
}

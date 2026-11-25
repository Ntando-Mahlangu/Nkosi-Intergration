import { useEffect } from "react";
import { api } from "../../lib/api";
import { useForm } from "../../lib/hooks";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { options } from "../../lib/status";
import { Button, Checkbox, FormError, Modal, SelectInput, TextArea, TextInput } from "../../components/ui";
import { UserSelect } from "../../components/records";

export interface Opportunity {
  id: string;
  name: string;
  opportunity_type: string;
  description: string;
  organisation: string;
  contact_name: string;
  contact_email: string;
  source: string;
  date_identified: string;
  strategic_relevance: string;
  potential_value: string;
  estimated_value: number | null;
  probability: number | null;
  owner_id: string | null;
  owner_name: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  next_action: string;
  follow_up_date: string | null;
  stage: string;
  notes: string;
  confidential: number;
  updated_at: string;
}

type FormValues = {
  name: string; opportunity_type: string; description: string; organisation: string; contact_name: string; contact_email: string;
  source: string; strategic_relevance: string; potential_value: string; estimated_value: string; probability: string;
  owner_id: string; next_action: string; follow_up_date: string; stage: string; notes: string; confidential: boolean;
};

const empty = (ownerId: string): FormValues => ({
  name: "", opportunity_type: "Business development", description: "", organisation: "", contact_name: "", contact_email: "",
  source: "", strategic_relevance: "medium", potential_value: "", estimated_value: "", probability: "", owner_id: ownerId,
  next_action: "", follow_up_date: "", stage: "identified", notes: "", confidential: false,
});

export function OpportunityFormModal({ open, onClose, onSaved, existing }: { open: boolean; onClose: () => void; onSaved: (o: Opportunity) => void; existing?: Opportunity | null }) {
  const { me, can } = useAuth();
  const { lookups } = useLookups();
  const toast = useToast();
  const f = useForm<FormValues>(empty(me?.user.id ?? ""));
  const canAssign = can("opportunity.manage") || can("management.view");

  useEffect(() => {
    if (!open) return;
    if (existing) {
      f.setValues({
        name: existing.name, opportunity_type: existing.opportunity_type, description: existing.description, organisation: existing.organisation,
        contact_name: existing.contact_name, contact_email: existing.contact_email, source: existing.source, strategic_relevance: existing.strategic_relevance,
        potential_value: existing.potential_value, estimated_value: existing.estimated_value?.toString() ?? "", probability: existing.probability?.toString() ?? "",
        owner_id: existing.owner_id ?? "", next_action: existing.next_action, follow_up_date: existing.follow_up_date ?? "", stage: existing.stage,
        notes: existing.notes, confidential: !!existing.confidential,
      });
    } else f.setValues(empty(me?.user.id ?? ""));
    f.setErrors({});
    f.setFormError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing?.id]);

  const types = lookups?.taxonomies.opportunity_type ?? ["Business development", "Other"];
  const validate = (v: FormValues) => {
    const e: Record<string, string> = {};
    if (!v.name.trim()) e.name = "Give the opportunity a name.";
    if (v.estimated_value && (Number.isNaN(Number(v.estimated_value)) || Number(v.estimated_value) < 0)) e.estimated_value = "Enter a positive number.";
    if (v.probability && (!/^\d+$/.test(v.probability) || Number(v.probability) > 100)) e.probability = "Enter a whole number between 0 and 100.";
    if (v.contact_email && !/^\S+@\S+\.\S+$/.test(v.contact_email)) e.contact_email = "Enter a valid email.";
    return e;
  };

  const save = () =>
    f.submit(async (v) => {
      const body: Record<string, unknown> = {
        ...v,
        estimated_value: v.estimated_value === "" ? null : Number(v.estimated_value),
        probability: v.probability === "" ? null : Number(v.probability),
        follow_up_date: v.follow_up_date || null,
        owner_id: v.owner_id || null,
      };
      if (existing) delete body.stage;
      const saved = existing ? await api.patch<Opportunity>(`/opportunities/${existing.id}`, body) : await api.post<Opportunity>("/opportunities", body);
      toast.success(existing ? "Opportunity updated" : "Opportunity added to the pipeline");
      onSaved(saved);
    }, validate);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={existing ? "Edit opportunity" : "New opportunity"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={f.submitting}>
            {existing ? "Save changes" : "Add opportunity"}
          </Button>
        </>
      }
    >
      <FormError message={f.formError} />
      <div className="form-grid">
        <TextInput className="full" label="Opportunity name" required value={f.values.name} onChange={(v) => f.set("name", v)} error={f.errors.name} />
        <SelectInput label="Type" value={f.values.opportunity_type} onChange={(v) => f.set("opportunity_type", v)} options={types.map((t) => ({ value: t, label: t }))} />
        {!existing && <SelectInput label="Stage" value={f.values.stage} onChange={(v) => f.set("stage", v)} options={options("opportunity")} />}
        <TextInput label="Organisation" value={f.values.organisation} onChange={(v) => f.set("organisation", v)} />
        <TextInput label="Contact name" value={f.values.contact_name} onChange={(v) => f.set("contact_name", v)} />
        <TextInput label="Contact email" type="email" value={f.values.contact_email} onChange={(v) => f.set("contact_email", v)} error={f.errors.contact_email} />
        <TextInput label="Source" value={f.values.source} onChange={(v) => f.set("source", v)} hint="How did this come to CSI? e.g. referral, event, meeting" />
        <SelectInput label="Strategic relevance" value={f.values.strategic_relevance} onChange={(v) => f.set("strategic_relevance", v)} options={[{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }]} />
        {canAssign ? (
          <UserSelect label="Owner" value={f.values.owner_id} onChange={(v) => f.set("owner_id", v)} error={f.errors.owner_id} />
        ) : (
          <div className="field">
            <span className="label">Owner</span>
            <span className="small muted">You will own opportunities you submit. A pipeline manager can reassign it later.</span>
          </div>
        )}
        <TextInput label="Potential value (description)" value={f.values.potential_value} onChange={(v) => f.set("potential_value", v)} hint="Optional — e.g. multi-year programme, strategic access" />
        <TextInput label="Estimated value (ZAR)" inputMode="decimal" value={f.values.estimated_value} onChange={(v) => f.set("estimated_value", v)} error={f.errors.estimated_value} hint="Leave blank if unknown" />
        <TextInput label="Probability (%)" inputMode="numeric" value={f.values.probability} onChange={(v) => f.set("probability", v)} error={f.errors.probability} hint="Leave blank if not assessed" />
        <TextInput label="Next action" value={f.values.next_action} onChange={(v) => f.set("next_action", v)} />
        <TextInput label="Follow-up date" type="date" value={f.values.follow_up_date} onChange={(v) => f.set("follow_up_date", v)} error={f.errors.follow_up_date} />
        <TextArea className="full" label="Description" value={f.values.description} onChange={(v) => f.set("description", v)} rows={3} />
        <TextArea className="full" label="Notes" value={f.values.notes} onChange={(v) => f.set("notes", v)} rows={2} />
        <div className="full">
          <Checkbox label="Confidential" checked={f.values.confidential} onChange={(v) => f.set("confidential", v)} hint="Only the owner, creator and management can see confidential opportunities." />
        </div>
      </div>
    </Modal>
  );
}

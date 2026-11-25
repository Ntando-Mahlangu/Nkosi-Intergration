/**
 * Create / edit task dialog. Reused by Workspace, Tasks, Projects and Meetings.
 * The assignee picker only offers other people when the user may assign to them
 * (task.assign_any, or manager of the chosen project); the server enforces the same rule.
 */
import { useEffect, useMemo } from "react";
import { api } from "../../lib/api";
import { useAuth, useLookups, useToast } from "../../lib/app-state";
import { useForm } from "../../lib/hooks";
import { Button, Checkbox, FormError, Modal, SelectInput, TextArea, TextInput } from "../../components/ui";
import { ProjectSelect, UserSelect } from "../../components/records";

type Defaults = Partial<{ project_id: string; meeting_id: string; deliverable_id: string; milestone_id: string; assignee_id: string; source: string; title: string; due_date: string }>;

export interface EditableTask {
  id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  project_id: string | null;
  priority: string;
  due_date: string | null;
  review_required: boolean;
  reviewer_id: string | null;
  is_personal: boolean;
  tags: string;
}

interface FormValues extends Record<string, unknown> {
  title: string;
  description: string;
  assignee_id: string;
  project_id: string;
  priority: string;
  due_date: string;
  review_required: boolean;
  reviewer_id: string;
  is_personal: boolean;
  tags: string;
}

export function TaskFormModal({ open, onClose, onSaved, defaults, task }: { open: boolean; onClose: () => void; onSaved?: (task: { id: string }) => void; defaults?: Defaults; task?: EditableTask }) {
  const { me, can } = useAuth();
  const { lookups } = useLookups();
  const toast = useToast();
  const initial = (): FormValues => ({
    title: task?.title ?? defaults?.title ?? "",
    description: task?.description ?? "",
    assignee_id: task?.assignee_id ?? defaults?.assignee_id ?? me?.user.id ?? "",
    project_id: task?.project_id ?? defaults?.project_id ?? "",
    priority: task?.priority ?? "normal",
    due_date: task?.due_date ?? defaults?.due_date ?? "",
    review_required: task?.review_required ?? false,
    reviewer_id: task?.reviewer_id ?? "",
    is_personal: task?.is_personal ?? false,
    tags: task?.tags ?? "",
  });
  const f = useForm<FormValues>(initial());
  useEffect(() => {
    if (open) {
      f.setValues(initial());
      f.setErrors({});
      f.setFormError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  const v = f.values;
  const project = lookups?.projects.find((p) => p.id === v.project_id);
  const managesProject = !!project && (project.owner_id === me?.user.id || project.my_role === "owner" || project.my_role === "manager");
  const canAssignOthers = can("task.assign_any") || managesProject;
  const meId = me?.user.id;

  // If the user loses the right to assign others (e.g. changed project), fall back to themselves.
  useEffect(() => {
    if (!task && !canAssignOthers && v.assignee_id && v.assignee_id !== meId) f.set("assignee_id", meId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAssignOthers]);

  const projectLocked = !!task || !!defaults?.project_id || !!defaults?.deliverable_id;
  const usersFilter = useMemo(() => (canAssignOthers ? undefined : (u: { id: string }) => u.id === meId || u.id === task?.assignee_id), [canAssignOthers, meId, task?.assignee_id]);

  const validate = (x: FormValues) => {
    const e: Record<string, string> = {};
    if (!x.title.trim()) e.title = "Give the task a title.";
    if (x.title.length > 300) e.title = "Keep the title under 300 characters.";
    if (x.review_required && !x.reviewer_id && !x.project_id) e.reviewer_id = "Choose a reviewer.";
    if (x.reviewer_id && x.reviewer_id === x.assignee_id) e.reviewer_id = "Choose someone other than the assignee.";
    return e;
  };

  const save = () =>
    f.submit(async (x) => {
      const body: Record<string, unknown> = {
        title: x.title.trim(),
        description: x.description,
        assignee_id: x.assignee_id || null,
        priority: x.priority,
        due_date: x.due_date || null,
        review_required: x.review_required,
        reviewer_id: x.review_required ? x.reviewer_id || null : null,
        tags: x.tags,
      };
      let saved: { id: string };
      if (task) {
        if (!task.project_id) body.is_personal = x.is_personal;
        saved = await api.patch<{ id: string }>(`/tasks/${task.id}`, body);
        toast.success("Task updated");
      } else {
        Object.assign(body, {
          project_id: x.project_id || null,
          meeting_id: defaults?.meeting_id ?? null,
          deliverable_id: defaults?.deliverable_id ?? null,
          milestone_id: defaults?.milestone_id ?? null,
          source: defaults?.source,
          is_personal: !x.project_id && x.is_personal,
        });
        saved = await api.post<{ id: string }>("/tasks", body);
        toast.success(x.assignee_id && x.assignee_id !== meId ? "Task created and assigned" : "Task added");
      }
      onSaved?.(saved);
      onClose();
      return saved;
    }, validate);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={task ? "Edit task" : "Add task"}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={f.submitting}>
            {task ? "Save changes" : "Add task"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        noValidate
      >
        <FormError message={f.formError} />
        <TextInput label="Title" required value={v.title} onChange={(x) => f.set("title", x)} error={f.errors.title} placeholder="What needs to be done?" maxLength={300} />
        <TextArea label="Description" rows={3} value={v.description} onChange={(x) => f.set("description", x)} error={f.errors.description} placeholder="Context, links, acceptance notes…" />
        <div className="form-grid">
          {!projectLocked ? (
            <ProjectSelect value={v.project_id} onChange={(x) => f.set("project_id", x)} error={f.errors.project_id} onlyContributable hint="Only projects you contribute to are listed." />
          ) : (
            <TextInput label="Project" value={project?.name ?? (v.project_id ? "Linked project" : "No project")} onChange={() => undefined} disabled />
          )}
          <UserSelect
            label="Assignee"
            value={v.assignee_id}
            onChange={(x) => f.set("assignee_id", x)}
            error={f.errors.assignee_id}
            placeholder="Select a person…"
            filter={usersFilter}
            hint={canAssignOthers ? undefined : "You can assign tasks to others in projects you manage."}
          />
          <TextInput label="Due date" type="date" value={v.due_date} onChange={(x) => f.set("due_date", x)} error={f.errors.due_date} />
          <SelectInput
            label="Priority"
            value={v.priority}
            onChange={(x) => f.set("priority", x)}
            options={[
              { value: "low", label: "Low" },
              { value: "normal", label: "Normal" },
              { value: "high", label: "High" },
              { value: "urgent", label: "Urgent" },
            ]}
          />
          <div className="full">
            <Checkbox label="Requires review before it can be completed" checked={v.review_required} onChange={(x) => f.set("review_required", x)} />
          </div>
          {v.review_required && (
            <UserSelect
              label="Reviewer"
              value={v.reviewer_id}
              onChange={(x) => f.set("reviewer_id", x)}
              error={f.errors.reviewer_id}
              placeholder={v.project_id ? "Project owner (default)" : "Select a reviewer…"}
              filter={(u) => u.id !== v.assignee_id}
            />
          )}
          <TextInput label="Tags" value={v.tags} onChange={(x) => f.set("tags", x)} hint="Comma separated, e.g. research, urgent-client" className={v.review_required ? "" : "full"} />
          {!v.project_id && (!task || !task.project_id) && (
            <div className="full">
              <Checkbox label="Personal task (private to me and the assignee)" checked={v.is_personal} onChange={(x) => f.set("is_personal", x)} hint="Personal tasks never appear to managers or administrators." />
            </div>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

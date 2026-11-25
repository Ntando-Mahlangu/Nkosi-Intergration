import { useState } from "react";
import { Button, Callout, Modal } from "../../components/ui";
import { useToast } from "../../lib/app-state";

/** Shows a one-time temporary password with copy button. Closing discards it permanently. */
export function SecretModal({ open, title, who, secret, onClose }: { open: boolean; title: string; who: string; secret: string | null; onClose: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? "");
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed — select the text and copy it manually.");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<Button variant="primary" onClick={onClose}>I have shared it securely</Button>}>
      <p>Temporary password for <strong>{who}</strong>:</p>
      <div className="adm-secret" aria-label="Temporary password">{secret}</div>
      <div className="row mt-2">
        <Button icon="file" size="sm" onClick={copy}>{copied ? "Copied" : "Copy password"}</Button>
      </div>
      <div className="mt-2">
        <Callout tone="warn" icon="lock">
          This password is shown <strong>only once</strong> and is not stored in readable form. Share it through a secure channel (not email). The person must choose a new password at first sign-in.
        </Callout>
      </div>
    </Modal>
  );
}

export function errFields(e: unknown): { message: string; fields: Record<string, string> } {
  const x = e as { message?: string; fields?: Record<string, string> };
  return { message: x.message ?? "Something went wrong.", fields: x.fields ?? {} };
}

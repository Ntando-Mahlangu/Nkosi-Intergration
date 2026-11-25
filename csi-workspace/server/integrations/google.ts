/**
 * Google Workspace integration layer.
 *
 * Implemented: OpenID Connect sign-in (authorization-code flow, server-side token exchange,
 * ID-token claims fetched from Google's tokeninfo endpoint over TLS).
 *
 * Not yet implemented (require OAuth consent-screen scopes + admin approval in CSI's Google
 * Workspace): Drive file picker/metadata sync, Docs generation, Calendar sync, Gmail scanning.
 * Those features degrade to secure document links / manual entry; see `integrationStatus()`.
 */
import type { AppConfig } from "../lib/context.js";

export const googleConfigured = (c: AppConfig) => !!(c.google.clientId && c.google.clientSecret);

const redirectUri = (c: AppConfig) => `${c.publicUrl.replace(/\/$/, "")}/auth/google/callback`;

export function googleAuthUrl(c: AppConfig, state: string): string {
  const p = new URLSearchParams({
    client_id: c.google.clientId,
    redirect_uri: redirectUri(c),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  if (c.google.allowedDomain) p.set("hd", c.google.allowedDomain);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function googleExchange(c: AppConfig, code: string): Promise<{ email: string; name: string; hd?: string }> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.google.clientId, client_secret: c.google.clientSecret, redirect_uri: redirectUri(c), grant_type: "authorization_code" }),
  });
  if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`);
  const tok = (await tokenRes.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error("no id_token");
  // Validate the ID token with Google (checks signature + expiry server-side).
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tok.id_token)}`);
  if (!infoRes.ok) throw new Error(`tokeninfo ${infoRes.status}`);
  const info = (await infoRes.json()) as { aud?: string; email?: string; email_verified?: string; name?: string; hd?: string; iss?: string };
  if (info.aud !== c.google.clientId) throw new Error("aud mismatch");
  if (!info.iss || !/accounts\.google\.com$/.test(info.iss)) throw new Error("iss mismatch");
  if (info.email_verified !== "true" || !info.email) throw new Error("email not verified");
  return { email: info.email, name: info.name ?? info.email, hd: info.hd };
}

export interface IntegrationStatus {
  key: string;
  name: string;
  status: "connected" | "configured" | "not_configured" | "planned";
  detail: string;
  fallback: string;
}

export function integrationStatus(c: AppConfig): IntegrationStatus[] {
  const g = googleConfigured(c);
  return [
    {
      key: "google_signin",
      name: "Google Workspace sign-in",
      status: g ? "configured" : "not_configured",
      detail: g
        ? `OIDC client configured${c.google.allowedDomain ? ` (restricted to ${c.google.allowedDomain})` : " (no domain restriction — set GOOGLE_ALLOWED_DOMAIN)"}. Users must still be provisioned by an administrator.`
        : "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_ALLOWED_DOMAIN to enable.",
      fallback: "Email + password sign-in (scrypt-hashed passwords, server-side sessions).",
    },
    {
      key: "anthropic",
      name: "AI assistant (Claude)",
      status: c.anthropicApiKey ? "configured" : "not_configured",
      detail: c.anthropicApiKey ? `Model: ${c.aiModel}. Outputs are always suggestions requiring human review.` : "Set ANTHROPIC_API_KEY to enable AI summarisation, extraction and drafting.",
      fallback: "Rule-based extraction (clearly labelled), template-based report drafting, keyword search.",
    },
    {
      key: "google_drive",
      name: "Google Drive",
      status: "planned",
      detail: "Requires Drive API scope (drive.metadata.readonly) approved by CSI's Workspace admin.",
      fallback: "Paste Drive/Docs/Sheets links on any record; links are typed and validated.",
    },
    {
      key: "google_docs",
      name: "Google Docs generation",
      status: "planned",
      detail: "Requires Docs API scope (documents) and a service account or per-user consent.",
      fallback: "Reports export to print-ready PDF (via browser), HTML and Markdown — paste into Docs.",
    },
    {
      key: "google_calendar",
      name: "Google Calendar",
      status: "planned",
      detail: "Requires calendar.readonly scope. Meetings can store a calendar event id today.",
      fallback: "Meetings are created in CSI Workspace with date/time and meeting link.",
    },
    {
      key: "google_meet",
      name: "Google Meet transcripts",
      status: "planned",
      detail: "Recording/transcription must be enabled in CSI's Workspace edition; not assumed.",
      fallback: "Paste or upload transcript/notes text on the meeting record.",
    },
    {
      key: "gmail",
      name: "Gmail (email-to-task)",
      status: "planned",
      detail: "Opt-in per user only; never reads inboxes without explicit authorisation.",
      fallback: "Create tasks manually with source = Email and a reference.",
    },
    {
      key: "email_notifications",
      name: "Email notifications",
      status: "planned",
      detail: "Needs an SMTP/transactional email provider.",
      fallback: "In-app notification centre.",
    },
  ];
}

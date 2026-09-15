import type { Pool } from "pg";
import type { ChannelCredentials, Lead, Message, Tenant } from "../types.js";
import type {
  AuditLogEntry,
  AuditLogStore,
  FailedNotification,
  LeadStore,
  MessageStore,
  NotificationStore,
  TenantStore,
} from "./types.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { generateId } from "../idgen.js";

function leadFromRow(row: Record<string, unknown>): Lead {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: (row.name as string | null) ?? undefined,
    phone: (row.phone as string | null) ?? undefined,
    email: (row.email as string | null) ?? undefined,
    source: row.source as Lead["source"],
    createdAt: new Date(row.created_at as string).toISOString(),
    lastContactedAt: row.last_contacted_at ? new Date(row.last_contacted_at as string).toISOString() : undefined,
    previousConversationSummary: (row.previous_conversation_summary as string | null) ?? undefined,
    requestedService: (row.requested_service as string | null) ?? undefined,
    previousQuote: (row.previous_quote as string | null) ?? undefined,
    appointmentStatus: (row.appointment_status as Lead["appointmentStatus"]) ?? undefined,
    notes: (row.notes as string | null) ?? undefined,
    status: row.status as Lead["status"],
    preferredChannel: (row.preferred_channel as Lead["preferredChannel"]) ?? undefined,
    hadMissedCall: (row.had_missed_call as boolean | null) ?? undefined,
    respondedAfterContact: (row.responded_after_contact as boolean | null) ?? undefined,
    followUpCount: (row.follow_up_count as number | null) ?? undefined,
    nextFollowUpAt: row.next_follow_up_at ? new Date(row.next_follow_up_at as string).toISOString() : undefined,
    firstOutreachSentAt: row.first_outreach_sent_at
      ? new Date(row.first_outreach_sent_at as string).toISOString()
      : undefined,
  };
}

const LEAD_COLUMNS = `id, tenant_id, name, phone, email, source, created_at, last_contacted_at,
  previous_conversation_summary, requested_service, previous_quote, appointment_status, notes,
  status, preferred_channel, had_missed_call, responded_after_contact, follow_up_count,
  next_follow_up_at, first_outreach_sent_at`;

export class PostgresLeadStore implements LeadStore {
  constructor(private pool: Pool) {}

  async getAllLeads(tenantId: string): Promise<Lead[]> {
    const { rows } = await this.pool.query(
      `SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return rows.map(leadFromRow);
  }

  async getLeadById(tenantId: string, id: string): Promise<Lead | undefined> {
    const { rows } = await this.pool.query(`SELECT ${LEAD_COLUMNS} FROM leads WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
    ]);
    return rows[0] ? leadFromRow(rows[0]) : undefined;
  }

  async findLeadByContact(tenantId: string, contact: { phone?: string; email?: string }): Promise<Lead | undefined> {
    if (!contact.phone && !contact.email) return undefined;
    const { rows } = await this.pool.query(
      `SELECT ${LEAD_COLUMNS} FROM leads
       WHERE tenant_id = $1 AND ((phone IS NOT NULL AND phone = $2) OR (email IS NOT NULL AND email = $3))
       LIMIT 1`,
      [tenantId, contact.phone ?? null, contact.email ?? null]
    );
    return rows[0] ? leadFromRow(rows[0]) : undefined;
  }

  async createLead(lead: Lead): Promise<Lead> {
    await this.pool.query(
      `INSERT INTO leads (
        id, tenant_id, name, phone, email, source, created_at, last_contacted_at,
        previous_conversation_summary, requested_service, previous_quote, appointment_status, notes,
        status, preferred_channel, had_missed_call, responded_after_contact, follow_up_count,
        next_follow_up_at, first_outreach_sent_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        lead.id,
        lead.tenantId,
        lead.name ?? null,
        lead.phone ?? null,
        lead.email ?? null,
        lead.source,
        lead.createdAt,
        lead.lastContactedAt ?? null,
        lead.previousConversationSummary ?? null,
        lead.requestedService ?? null,
        lead.previousQuote ?? null,
        lead.appointmentStatus ?? null,
        lead.notes ?? null,
        lead.status,
        lead.preferredChannel ?? null,
        lead.hadMissedCall ?? null,
        lead.respondedAfterContact ?? null,
        lead.followUpCount ?? null,
        lead.nextFollowUpAt ?? null,
        lead.firstOutreachSentAt ?? null,
      ]
    );
    return lead;
  }

  async updateLead(tenantId: string, id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
    const existing = await this.getLeadById(tenantId, id);
    if (!existing) return undefined;
    const merged: Lead = { ...existing, ...patch };

    await this.pool.query(
      `UPDATE leads SET
        name = $3, phone = $4, email = $5, source = $6, created_at = $7, last_contacted_at = $8,
        previous_conversation_summary = $9, requested_service = $10, previous_quote = $11,
        appointment_status = $12, notes = $13, status = $14, preferred_channel = $15,
        had_missed_call = $16, responded_after_contact = $17, follow_up_count = $18,
        next_follow_up_at = $19, first_outreach_sent_at = $20
      WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        id,
        merged.name ?? null,
        merged.phone ?? null,
        merged.email ?? null,
        merged.source,
        merged.createdAt,
        merged.lastContactedAt ?? null,
        merged.previousConversationSummary ?? null,
        merged.requestedService ?? null,
        merged.previousQuote ?? null,
        merged.appointmentStatus ?? null,
        merged.notes ?? null,
        merged.status,
        merged.preferredChannel ?? null,
        merged.hadMissedCall ?? null,
        merged.respondedAfterContact ?? null,
        merged.followUpCount ?? null,
        merged.nextFollowUpAt ?? null,
        merged.firstOutreachSentAt ?? null,
      ]
    );
    return merged;
  }
}

const TENANT_COLUMNS = `id, name, api_key, timezone, quiet_hours_start, quiet_hours_end, dev_mode, channels, created_at,
  notify_webhook_url, templates, knowledge_base, auto_reply_enabled, status`;

/**
 * Tenant provider credentials (Twilio auth tokens, SendGrid API keys) are
 * encrypted at rest with AES-256-GCM (see src/crypto.ts) when an encryption
 * key is configured — required in production (see store/index.ts). The
 * `channels` JSONB column then holds `{"_encrypted": "<ciphertext>"}`
 * instead of the plaintext credentials object.
 *
 * `previousEncryptionKey` supports rotating LEADRECOVERY_ENCRYPTION_KEY
 * without downtime: decoding tries the current key first, then falls back
 * to the previous one for rows not yet re-encrypted. All writes
 * (encodeChannels) always use the current key — see
 * src/scripts/rotateEncryptionKey.ts for the batch job that re-encrypts
 * every existing row so the previous key can eventually be dropped.
 */
export class PostgresTenantStore implements TenantStore {
  constructor(
    private pool: Pool,
    private encryptionKey?: string,
    private previousEncryptionKey?: string
  ) {}

  private encodeChannels(channels: ChannelCredentials): string {
    if (!this.encryptionKey) return JSON.stringify(channels);
    return JSON.stringify({ _encrypted: encryptSecret(JSON.stringify(channels), this.encryptionKey) });
  }

  private decodeChannels(raw: unknown): ChannelCredentials {
    const parsed = raw as { _encrypted?: string } | ChannelCredentials | null;
    if (!parsed) return {};
    if ("_encrypted" in parsed && parsed._encrypted) {
      if (!this.encryptionKey) {
        throw new Error(
          "Tenant channel credentials are encrypted but no encryption key is configured " +
            "(set LEADRECOVERY_ENCRYPTION_KEY to the key used when they were saved)."
        );
      }
      try {
        return JSON.parse(decryptSecret(parsed._encrypted, this.encryptionKey)) as ChannelCredentials;
      } catch (err) {
        if (!this.previousEncryptionKey) throw err;
        // Mid-rotation: this row hasn't been re-encrypted with the new key yet.
        return JSON.parse(decryptSecret(parsed._encrypted, this.previousEncryptionKey)) as ChannelCredentials;
      }
    }
    return parsed as ChannelCredentials;
  }

  private fromRow(row: Record<string, unknown>): Tenant {
    const quietStart = row.quiet_hours_start as number | null;
    const quietEnd = row.quiet_hours_end as number | null;
    return {
      id: row.id as string,
      name: row.name as string,
      apiKey: row.api_key as string,
      timezone: row.timezone as string,
      quietHours: quietStart !== null && quietEnd !== null ? { startHour: quietStart, endHour: quietEnd } : undefined,
      devMode: Boolean(row.dev_mode),
      channels: this.decodeChannels(row.channels),
      notifyWebhookUrl: (row.notify_webhook_url as string | null) ?? undefined,
      templates: (row.templates as Tenant["templates"] | null) ?? undefined,
      knowledgeBase: (row.knowledge_base as string | null) ?? undefined,
      autoReplyEnabled: Boolean(row.auto_reply_enabled),
      status: (row.status as Tenant["status"]) ?? "active",
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const { rows } = await this.pool.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [id]);
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async getTenantByApiKey(apiKey: string): Promise<Tenant | undefined> {
    const { rows } = await this.pool.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE api_key = $1`, [apiKey]);
    return rows[0] ? this.fromRow(rows[0]) : undefined;
  }

  async listTenants(): Promise<Tenant[]> {
    const { rows } = await this.pool.query(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at ASC`);
    return rows.map((row) => this.fromRow(row));
  }

  async createTenant(tenant: Tenant): Promise<Tenant> {
    await this.pool.query(
      `INSERT INTO tenants (id, name, api_key, timezone, quiet_hours_start, quiet_hours_end, dev_mode, channels, created_at, notify_webhook_url, templates, knowledge_base, auto_reply_enabled, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        tenant.id,
        tenant.name,
        tenant.apiKey,
        tenant.timezone,
        tenant.quietHours?.startHour ?? null,
        tenant.quietHours?.endHour ?? null,
        tenant.devMode ?? false,
        this.encodeChannels(tenant.channels),
        tenant.createdAt,
        tenant.notifyWebhookUrl ?? null,
        tenant.templates ? JSON.stringify(tenant.templates) : null,
        tenant.knowledgeBase ?? null,
        tenant.autoReplyEnabled ?? false,
        tenant.status ?? "active",
      ]
    );
    return tenant;
  }

  async updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant | undefined> {
    const existing = await this.getTenant(id);
    if (!existing) return undefined;
    const merged: Tenant = { ...existing, ...patch };

    await this.pool.query(
      `UPDATE tenants SET name = $2, api_key = $3, timezone = $4, quiet_hours_start = $5,
        quiet_hours_end = $6, dev_mode = $7, channels = $8, notify_webhook_url = $9, templates = $10,
        knowledge_base = $11, auto_reply_enabled = $12, status = $13
      WHERE id = $1`,
      [
        id,
        merged.name,
        merged.apiKey,
        merged.timezone,
        merged.quietHours?.startHour ?? null,
        merged.quietHours?.endHour ?? null,
        merged.devMode ?? false,
        this.encodeChannels(merged.channels),
        merged.notifyWebhookUrl ?? null,
        merged.templates ? JSON.stringify(merged.templates) : null,
        merged.knowledgeBase ?? null,
        merged.autoReplyEnabled ?? false,
        merged.status ?? "active",
      ]
    );
    return merged;
  }

  async deleteTenant(id: string): Promise<boolean> {
    // ON DELETE CASCADE on leads.tenant_id and messages.tenant_id (0001_init.sql)
    // means this also removes every lead and message belonging to the tenant.
    const result = await this.pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

function messageFromRow(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    leadId: row.lead_id as string,
    channel: row.channel as Message["channel"],
    direction: row.direction as Message["direction"],
    body: row.body as string,
    at: new Date(row.at as string).toISOString(),
    classification: (row.classification as Message["classification"]) ?? undefined,
    providerMessageId: (row.provider_message_id as string | null) ?? undefined,
    deliveryStatus: (row.delivery_status as string | null) ?? undefined,
    kind: (row.kind as Message["kind"]) ?? undefined,
  };
}

const MESSAGE_COLUMNS = `id, tenant_id, lead_id, channel, direction, body, at, classification, provider_message_id, delivery_status, kind`;

export class PostgresMessageStore implements MessageStore {
  constructor(private pool: Pool) {}

  async logMessage(message: Message): Promise<Message> {
    await this.pool.query(
      `INSERT INTO messages (id, tenant_id, lead_id, channel, direction, body, at, classification, provider_message_id, delivery_status, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        message.id,
        message.tenantId,
        message.leadId,
        message.channel,
        message.direction,
        message.body,
        message.at,
        message.classification ?? null,
        message.providerMessageId ?? null,
        message.deliveryStatus ?? null,
        message.kind ?? null,
      ]
    );
    return message;
  }

  async getMessagesForLead(tenantId: string, leadId: string): Promise<Message[]> {
    const { rows } = await this.pool.query(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE tenant_id = $1 AND lead_id = $2 ORDER BY at ASC`,
      [tenantId, leadId]
    );
    return rows.map(messageFromRow);
  }

  async updateMessageStatus(tenantId: string, messageId: string, deliveryStatus: string): Promise<Message | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE messages SET delivery_status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${MESSAGE_COLUMNS}`,
      [tenantId, messageId, deliveryStatus]
    );
    return rows[0] ? messageFromRow(rows[0]) : undefined;
  }
}

function failedNotificationFromRow(row: Record<string, unknown>): FailedNotification {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    leadId: (row.lead_id as string | null) ?? undefined,
    reason: row.reason as FailedNotification["reason"],
    webhookUrl: row.webhook_url as string,
    payload: row.payload as Record<string, unknown>,
    attempts: row.attempts as number,
    lastError: (row.last_error as string | null) ?? undefined,
    status: row.status as FailedNotification["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
    lastAttemptAt: new Date(row.last_attempt_at as string).toISOString(),
  };
}

const FAILED_NOTIFICATION_COLUMNS = `id, tenant_id, lead_id, reason, webhook_url, payload, attempts, last_error, status, created_at, last_attempt_at`;

export class PostgresNotificationStore implements NotificationStore {
  constructor(private pool: Pool) {}

  async recordFailure(input: {
    tenantId: string;
    leadId?: string;
    reason: FailedNotification["reason"];
    webhookUrl: string;
    payload: Record<string, unknown>;
    error: string;
  }): Promise<FailedNotification> {
    const { rows } = await this.pool.query(
      `INSERT INTO failed_notifications (id, tenant_id, lead_id, reason, webhook_url, payload, attempts, last_error, status)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,'pending')
       RETURNING ${FAILED_NOTIFICATION_COLUMNS}`,
      [
        generateId("failnotif"),
        input.tenantId,
        input.leadId ?? null,
        input.reason,
        input.webhookUrl,
        input.payload,
        input.error,
      ]
    );
    return failedNotificationFromRow(rows[0]);
  }

  async listPending(): Promise<FailedNotification[]> {
    const { rows } = await this.pool.query(
      `SELECT ${FAILED_NOTIFICATION_COLUMNS} FROM failed_notifications WHERE status = 'pending' ORDER BY created_at ASC`
    );
    return rows.map(failedNotificationFromRow);
  }

  async listAll(): Promise<FailedNotification[]> {
    const { rows } = await this.pool.query(
      `SELECT ${FAILED_NOTIFICATION_COLUMNS} FROM failed_notifications ORDER BY created_at DESC`
    );
    return rows.map(failedNotificationFromRow);
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM failed_notifications WHERE id = $1`, [id]);
  }

  async markAttemptFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE failed_notifications
       SET attempts = attempts + 1, last_error = $2, last_attempt_at = now(),
           status = CASE WHEN attempts + 1 >= $3 THEN 'dead' ELSE 'pending' END
       WHERE id = $1`,
      [id, error, maxAttempts]
    );
  }
}

function auditLogEntryFromRow(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string | null) ?? undefined,
    action: row.action as AuditLogEntry["action"],
    actor: row.actor as string,
    details: (row.details as Record<string, unknown> | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

const AUDIT_LOG_COLUMNS = `id, tenant_id, action, actor, details, created_at`;

export class PostgresAuditLogStore implements AuditLogStore {
  constructor(private pool: Pool) {}

  async record(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<AuditLogEntry> {
    const { rows } = await this.pool.query(
      `INSERT INTO audit_log (id, tenant_id, action, actor, details)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${AUDIT_LOG_COLUMNS}`,
      [generateId("audit"), entry.tenantId ?? null, entry.action, entry.actor, entry.details ?? null]
    );
    return auditLogEntryFromRow(rows[0]);
  }

  async list({ limit, offset }: { limit?: number; offset: number }): Promise<AuditLogEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT ${AUDIT_LOG_COLUMNS} FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit ?? null, offset]
    );
    return rows.map(auditLogEntryFromRow);
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM audit_log`);
    return rows[0].count as number;
  }
}

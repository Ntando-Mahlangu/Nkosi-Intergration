# Onboarding a new client

This is the step-by-step process for bringing a real business onto
LeadRecovery, from first call to live sends.

## 1. Discovery

Before touching the system, confirm with the client:

- What CRM/booking software/phone system do they already use?
- Where do their "lost" leads live today (a CRM export, a spreadsheet, their
  phone provider's call log, a booking tool)?
- Which channels are they comfortable with LeadRecovery using on their
  behalf (SMS, WhatsApp, email — see `COMPLIANCE.md` for the approvals each
  one needs)?
- Do they already maintain a do-not-contact / opted-out list? Get it now —
  it must be loaded before anything else.
- What's their timezone and preferred quiet hours (default: no sends
  8pm-8am local)?

## 2. Compliance first

Load their do-not-contact list into the system **before** importing anything
else, so those leads land with `status: "do_not_contact"` from the start and
are never touched. See `COMPLIANCE.md` for the manual/legal steps (carrier
registration, WhatsApp Business approval, SPF/DKIM, consent basis) that have
to happen alongside this — some of these have lead times of days to weeks
and should be started immediately.

## 3. Provision the tenant

```bash
npm run onboard
```

This interactive CLI walks through: business name, timezone, quiet hours,
and (optionally) Twilio/SendGrid credentials. It prints:

- The tenant's **API key** — save it immediately, it is shown only once.
- Webhook URLs to configure with each provider.

Prefer automation? `POST /admin/tenants` (with `Authorization: Bearer
<ADMIN_API_KEY>`) does the same thing programmatically — see `README.md`.

If the client doesn't have Twilio/SendGrid accounts yet, create the tenant
anyway with those fields blank; it can run in `devMode` (console-only sends)
until credentials are ready, so you can validate the rest of the pipeline
immediately.

## 4. Connect their lead data

Pick whichever fits what they actually have:

- **One-time CSV import** (most common for a first cut of historical
  leads): `npm run import-leads -- --tenant <id> --file leads.csv`. Expected
  headers (case-insensitive): `name, phone, email, source, createdAt,
  requestedService, previousQuote, notes`.
- **Live CRM connection**: point the CRM's outgoing webhook (most CRMs —
  HubSpot, Pipedrive, GoHighLevel, Salesforce — support this natively) or a
  Zapier/Make/n8n automation at `POST /webhooks/lead` with `Authorization:
  Bearer <tenant api key>`.
- **Missed calls / inbound replies**: configure Twilio's webhook URLs
  (printed by `npm run onboard`) so LeadRecovery detects missed calls and
  processes SMS/WhatsApp replies automatically.

## 5. Dry run — review before anything sends

```
GET /leads/plan
```
(with `Authorization: Bearer <tenant api key>`), or open the dashboard
(`public/index.html`) and connect with the tenant's API key. This shows the
exact priority, reason, and drafted message for every lead **without sending
anything**. Walk through this with the client and get explicit sign-off on:

- Tone/wording of the templates (edit `src/messaging.ts` /
  `src/followup.ts` if they want different phrasing — these are shared
  across tenants today; a per-tenant template override is a natural next
  step if clients want to customize independently).
- Which leads are being excluded and why (the `skipped` list) — this is
  where you catch a bad CSV import or a missing do-not-contact entry before
  it becomes a real problem.

## 6. Pilot

Flip a small batch live first:

- Either temporarily restrict the imported leads to a handful of test
  contacts, or just run `POST /workflow/run` once and watch the `sent`
  results closely (delivery status, any immediate replies).
- Confirm STOP handling actually works by texting/emailing "STOP" from a
  test number/address and checking the lead flips to `opted_out`.

## 7. Go live

- Start the worker (`npm run worker`, or point your infrastructure's
  scheduler at `LEADRECOVERY_RUN_ONCE=true npm run worker` on the cadence
  you want).
- Make sure someone on the client's side is watching for `interested`
  replies (visible via `GET /leads/:id/messages`, or extend the webhook
  handlers to notify their sales team directly — a Slack/email hook on a
  classified-as-interested reply is a natural next addition).
- Agree on a reporting cadence (conversations recovered, appointments
  booked, revenue attributed) — this is the number that justifies the
  service to the client.

## 8. Ongoing

- Review the `skipped`/`deferred` lists periodically — a growing "no usable
  contact channel" count usually means a data-quality problem upstream.
  `GET /leads/plan` is the quickest health check.
- Revisit quiet hours / scoring thresholds (`src/scoring.ts`
  `SCORING_WINDOWS`) per vertical — a plumber's "recent" and a real estate
  agent's "recent" aren't the same.

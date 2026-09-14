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
(with `Authorization: Bearer <tenant api key>`), or open the list dashboard
(`public/dashboard.html`) and connect with the tenant's API key — the
Command Center landing page (`public/index.html`) is the impressive
overview, but this plain list is where you actually review exact message
wording per lead. This shows the exact priority, reason, and drafted
message for every lead **without sending anything**. Walk through this with
the client and get explicit sign-off on:

- Tone/wording of the templates. The built-in default wording lives in
  `src/messaging.ts`/`src/followup.ts`; a specific client can override it
  without a code change via `PATCH /tenants/me` (or the admin API), setting
  `templates.initialGrounded` / `templates.initialUngrounded` /
  `templates.followUps[]` with `{name}`/`{businessName}`/`{reason}`/
  `{service}` placeholders.
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

## 7. Optional: turn on the auto-reply chatbot

If the client wants routine customer questions (hours, pricing, policies)
answered automatically instead of always waiting on a human:

1. Write the knowledge base with the client — plain text is fine (services
   offered, pricing, hours, policies, whatever they'd want a front-desk
   person to know). Keep it factual and specific; the bot only answers from
   what's here and is instructed to escalate anything it isn't confident is
   covered.
2. Set it and turn the feature on:
   ```bash
   curl -X PATCH https://<host>/tenants/me \
     -H "Authorization: Bearer <tenant api key>" -H "Content-Type: application/json" \
     -d '{"knowledgeBase": "<the text above>", "autoReplyEnabled": true}'
   ```
   (`npm run onboard` can also prompt for a knowledge-base file and enable
   this at initial setup time.)
3. Test it directly — text/email the tenant's number/address a few sample
   questions (something clearly covered, something ambiguous, something
   that should escalate like a price negotiation or a complaint) and check
   the replies via `GET /leads/:id/messages` before trusting it with real
   customers.
4. Read "Bot disclosure" in `COMPLIANCE.md` — some jurisdictions require
   proactively disclosing that a customer is messaging with an automated
   system; this is a decision for the client and their counsel, not
   something the code assumes for them.

Anything the bot escalates (price negotiation, complaints, complex
requests, an explicit ask for a person, or a question outside the
knowledge base) routes to `notifyWebhookUrl` just like an `interested`
reply — see step 8 below for setting that up.

## 8. Go live

- Start the worker (`npm run worker`, or point your infrastructure's
  scheduler at `LEADRECOVERY_RUN_ONCE=true npm run worker` on the cadence
  you want) — for a real deployment (Docker/Compose or systemd), see
  `DEPLOYMENT.md`, including the hard "exactly one worker replica" rule.
- Make sure someone on the client's side is watching for `interested`
  replies and anything the chatbot escalates. Set `notifyWebhookUrl` on the
  tenant (via `PATCH /tenants/me` or the admin API) to a Slack incoming
  webhook URL (or any endpoint that accepts a JSON POST) and LeadRecovery
  notifies it automatically — no need to poll `GET /leads/:id/messages`.
- Agree on a reporting cadence (conversations recovered, appointments
  booked, revenue attributed) — this is the number that justifies the
  service to the client.

## 9. Ongoing

- Review the `skipped`/`deferred` lists periodically — a growing "no usable
  contact channel" count usually means a data-quality problem upstream.
  `GET /leads/plan` is the quickest health check.
- Revisit quiet hours / scoring thresholds (`src/scoring.ts`
  `SCORING_WINDOWS`) per vertical — a plumber's "recent" and a real estate
  agent's "recent" aren't the same.

## 10. Pausing or offboarding a client

- **Pause without losing data** (e.g. a billing issue, or the client wants a
  temporary hold): `PATCH /admin/tenants/<id>` with `{"status":
  "suspended"}`. This immediately blocks all of that tenant's API/webhook
  auth — including inbound replies and the worker skipping them entirely —
  without deleting anything. Reactivate the same way with `{"status":
  "active"}`. A tenant cannot suspend or reactivate itself; this is
  admin-only by design.
- **Offboard permanently**: `DELETE /admin/tenants/<id>`. This is
  irreversible — in Postgres it cascades to every lead and message that
  tenant ever had. Confirm with the client (and check any contractual data-
  retention obligations) before doing this; suspending is almost always the
  safer first move.

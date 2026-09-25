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

`public/admin.html`'s "Add new client" form requires checking "Client has a
documented lawful basis to contact its leads" before it will create the
tenant — an actual attestation with a timestamp
(`consentBasisConfirmedAt`), not a formality. Don't check it until you've
actually confirmed this with the client.

## 3. Provision the tenant

```bash
npm run onboard
```

This interactive CLI walks through: business name, timezone, quiet hours,
and (optionally) Twilio/SendGrid credentials. It prints:

- The tenant's **API key** — save it immediately, it is shown only once.
- Webhook URLs to configure with each provider.

Prefer a form over a CLI or curl? `public/admin.html`'s "Add new client"
form does the same thing (`POST /admin/tenants` under the hood — see
`README.md` if you want to script it instead). It's ordered for a call
with the client sitting in front of you: business name, timezone, and
their contact phone/email/website first (plain text, just for your own
reference — none of it connects to anything by itself), then the real
Twilio/SendGrid setup collapsed behind a "Skip provider setup for now
(test mode)" checkbox, checked by default. Skip it if those provider
accounts don't exist yet — the tenant is created in `devMode` (console-only
sends) so you can still validate the rest of the pipeline immediately —
and come back to it (`PATCH /admin/tenants/:id` or the same form's fields)
once they do.

Whenever you do configure real SMS/WhatsApp credentials for a client — now
or later — the sms/whatsapp channels stay unusable (silently falling back
to email, or skipping the lead) until you separately confirm carrier
approval: `PATCH /admin/tenants/:id` with `{"carrierApprovalConfirmed":
true}` once you've verified their 10DLC registration and/or WhatsApp
Business template approval with Twilio (see `COMPLIANCE.md`). `devMode`
bypasses this for test-mode use, same as it bypasses needing real
credentials at all.

If you've set `DEFAULT_TWILIO_ACCOUNT_SID`/
`DEFAULT_TWILIO_AUTH_TOKEN`/`DEFAULT_SENDGRID_API_KEY` (the common setup —
one shared Twilio/SendGrid account across all your clients, see
`README.md`'s `src/channelDefaults.ts` section), unchecking "skip" only
ever asks for this client's own phone number/from-email — the actual
credentials come from your shared account automatically. Only check
"this client uses their own Twilio/SendGrid account" if they're bringing
one.

Either way you create it, the response — or the form's "reveal" panel —
gives you two things:

- The tenant's **API key**, shown only once. Save it immediately.
- A **magic link** (`.../index.html?key=<the key>`) that logs the client
  straight in — send them that instead of asking them to copy/paste the
  raw key into the "API base URL"/"Tenant API key" fields. Every
  dashboard auto-connects from a `?key=` link like this and strips the
  key back out of the visible URL immediately after. If a key is ever
  rotated (`POST /admin/tenants/:id/rotate-key`), the old magic link
  stops working — the rotate response/reveal panel gives you a fresh one
  to send instead.

If more than one person runs the admin side of the agency, set
`ADMIN_API_KEYS` (a `name:key` list) instead of a single shared
`ADMIN_API_KEY` so the audit log (`GET /admin/audit-log`) records *who*
provisioned/suspended/deleted a tenant, not just an indistinguishable
"admin" for everyone.

### If you're billing this client through Paddle

Note the tenant's **id** (not its API key) from the create response — that's
what links a Paddle charge back to this tenant. There's no in-app "generate
a checkout link" button; do this directly in Paddle, using whichever fits
how you sell:

- **Invoicing a client directly** (simplest, no code): in the Paddle
  dashboard, create a manually-collected transaction/invoice for the
  subscription price against that customer, and set its **custom data** to
  `{"tenantId": "<the id you just noted>"}` before issuing it. When Paddle
  creates the resulting subscription off that transaction, it copies the
  custom data onto it — that's what makes `/webhooks/paddle` resolve future
  events (renewals, a failed payment, a cancellation) back to this tenant
  automatically, with no further manual step.
- **A self-serve checkout link instead**: call Paddle's `POST
  /transactions` API with the price, the customer, and the same
  `custom_data: {"tenantId": "..."}`, then send the customer the resulting
  checkout URL. This isn't wired up as a script in this repo (it needs a
  live `PADDLE_API_KEY` this project doesn't otherwise use, and getting the
  checkout-URL construction exactly right needs testing against a real
  Paddle account) — see Paddle's own "Create a transaction" API reference if
  you want to script this yourselves.

Either way, the rule that actually matters: **set `custom_data.tenantId` on
the transaction itself, at creation time** — not as an afterthought on the
resulting subscription (dashboard editing there is limited) and not solely
via a client-side checkout-overlay parameter, which is easy to get wrong.
Getting this step wrong is exactly the kind of misconfiguration
`/webhooks/paddle`'s own conflict/rebind checks (see "Billing (Paddle)" in
`DEPLOYMENT.md`) exist to catch loudly instead of silently.

## 4. Connect their lead data

Pick whichever fits what they actually have:

- **One-time CSV import** (most common for a first cut of historical
  leads): `npm run import-leads -- --tenant <id> --file leads.csv`, or have
  the client upload the same file themselves from the "Import leads" form
  on `public/dashboard.html` (`POST /leads/import`) — no CLI access
  needed. Expected headers (case-insensitive): `name, phone, email,
  source, createdAt, requestedService, previousQuote, appointmentAt,
  notes`. A row with a valid `appointmentAt` is automatically marked
  `appointmentStatus: "booked"`, which is what makes it eligible for the
  24-hour-before appointment reminder (`src/appointmentReminder.ts` in
  `README.md`'s Architecture section) — wording is editable per tenant from
  `public/settings.html`.
- **Live CRM connection**: point the CRM's outgoing webhook (most CRMs —
  HubSpot, Pipedrive, GoHighLevel, Salesforce — support this natively) or a
  Zapier/Make/n8n automation at `POST /webhooks/lead` with `Authorization:
  Bearer <tenant api key>`.
- **Missed calls / inbound replies**: configure Twilio's webhook URLs
  (printed by `npm run onboard`) so LeadRecovery detects missed calls and
  processes SMS/WhatsApp replies automatically.

## 5. Dry run — review before anything sends

The first time the client opens any dashboard with their own key (or your
magic link), they'll see a "Before you continue" gate asking them to
accept LeadRecovery's Terms of Service/Privacy Policy — this is the
client's own acceptance, not something you tick on their behalf during
onboarding. It's not just a UI formality: the worker, every inbound
webhook auto-reply, and `POST /workflow/run` all refuse to actually send
anything for a tenant that hasn't accepted, so nothing can go out before
they've agreed, even if you're the one clicking around in the dashboard
for them during this review step.

```
GET /leads/plan
```
(with `Authorization: Bearer <tenant api key>`), or open the list dashboard
(`public/dashboard.html`) and connect with the tenant's API key — the
Command Center landing page (`public/index.html`) is the impressive
overview, but this plain list is where you actually review exact message
wording per lead, click into a lead's own conversation history, and set
its appointment status/date — booking one (`appointmentStatus: "booked"`
+ `appointmentAt`) is what makes a lead eligible for the automatic
24-hour-before reminder. This shows the exact priority, reason, and drafted
message for every lead **without sending anything**. Walk through this with
the client and get explicit sign-off on:

- Tone/wording of the templates. The built-in default wording lives in
  `src/messaging.ts`/`src/followup.ts`; a specific client can override it
  without a code change — either via `PATCH /tenants/me` (or the admin API)
  setting `templates.initialGrounded` / `templates.initialUngrounded` /
  `templates.followUps[]` with `{name}`/`{businessName}`/`{reason}`/
  `{service}` placeholders, or by opening `public/settings.html` with the
  tenant's API key, which is the same thing as a form — hand the client
  this page directly if they'd rather write their own wording than dictate
  it to you.
- Which leads are being excluded and why (the `skipped` list) — this is
  where you catch a bad CSV import or a missing do-not-contact entry before
  it becomes a real problem.

## 6. Pilot

Before sending anything real, verify every provider credential actually
authenticates:

```bash
npm run check-providers -- --tenant <id>
```

This makes one real, lightweight, read-only call per configured provider
(Twilio account fetch, SendGrid scope check, Anthropic if the chatbot or
LLM classification is enabled) and reports pass/fail — catching a
typo'd/revoked/misscoped credential now instead of it failing silently on
a real customer's first message.

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
2. Set it and turn the feature on — either through `public/settings.html`
   (paste the knowledge base into the form, tick "Turn on auto-reply") or:
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
  service to the client, and the retainer invoice you send them.

## 9. Ongoing

- Pull `GET /tenants/me/report?since=<start of period>&until=<end of period>`
  for the numbers a monthly retainer report needs — lead status counts
  (a current pipeline snapshot) and message activity (outbound sends by
  kind, inbound replies by classification) for that window — instead of
  hand-computing them from `GET /leads` and message history. Or open
  `public/reports.html` with the tenant's API key for the same numbers as
  a page — reply rate, leads marked interested, and "This month"/"All
  time" range shortcuts — worth handing directly to a client who wants to
  check in on their own.
- Review the `skipped`/`deferred` lists periodically — a growing "no usable
  contact channel" count usually means a data-quality problem upstream.
  `GET /leads/plan` is the quickest health check.
- Revisit quiet hours / scoring thresholds (`src/scoring.ts`
  `SCORING_WINDOWS`) per vertical — a plumber's "recent" and a real estate
  agent's "recent" aren't the same.
- If a client asks for a copy of their own data, `GET /leads/export`
  (`?format=csv`, the default, or `?format=json`) gives every lead field as
  a one-shot download — see `COMPLIANCE.md` "Data handling."

## 10. Pausing or offboarding a client

All of the below can be done via curl against the admin API, or from
`public/admin.html` — connect with `ADMIN_API_KEY` (not a tenant key) for
a clickable view of every tenant plus the failed-notifications queue and
audit log, if you'd rather not hand-write requests.

- **Pause without losing data** (e.g. a billing issue, or the client wants a
  temporary hold): `PATCH /admin/tenants/<id>` with `{"status":
  "suspended"}`. This immediately blocks all of that tenant's API/webhook
  auth — including inbound replies and the worker skipping them entirely —
  without deleting anything. Reactivate the same way with `{"status":
  "active"}`. A tenant cannot suspend or reactivate itself; this is
  admin-only by design. If you're billing through Paddle (see "Billing
  (Paddle)" in `DEPLOYMENT.md`), this same pause/resume happens
  automatically on a subscription lapse/recovery — you shouldn't usually
  need to do it by hand for a non-payment case, only for a manual hold
  unrelated to billing. A tenant auto-suspended this way also shows a
  distinct "billing" tag next to its status badge in `admin.html`, and
  triggers `OPERATOR_ALERT_WEBHOOK_URL` if you've set one (see "Alerting" in
  `DEPLOYMENT.md`), so you don't have to notice a payment lapse by chance.
- **A tenant's API key leaked**: `POST /admin/tenants/<id>/rotate-key`
  issues a new key immediately (the old one stops working) without
  touching anything else — no need to delete and recreate the tenant.
- **Offboard permanently**: `DELETE /admin/tenants/<id>`. This is
  irreversible — in Postgres it cascades to every lead and message that
  tenant ever had. Confirm with the client (and check any contractual data-
  retention obligations) before doing this; suspending is almost always the
  safer first move.

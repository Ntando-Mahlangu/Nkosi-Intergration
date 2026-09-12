# LeadRecovery

AI-powered lead recovery and reactivation system by Nkosi Integrations.

LeadRecovery finds leads a business already generated but never converted
(missed calls, unanswered form submissions, abandoned bookings, cold quote
requests, etc.), scores them by recovery priority, works out a truthful
reason to reach back out, and drafts a short, human, personalized outreach
message — while permanently respecting any lead marked do-not-contact,
unqualified, fraudulent, already booked/converted, or opted out.

The full behavioral spec lives in [`SYSTEM_PROMPT.md`](./SYSTEM_PROMPT.md) —
that document is the source of truth for the rules implemented here, and can
also be loaded directly as the system prompt for an LLM-backed agent (e.g.
via the Claude API).

## How it works

```
data source(s) -> LeadStore -> compliance filter -> scoring -> reason -> message -> channel adapter -> log/status update
```

- **`src/compliance.ts`** — hard-stop suppression checks (do not contact,
  unqualified, fraudulent, active conversation, already booked/converted,
  opted out). These run first and override everything else.
- **`src/scoring.ts`** — assigns HIGH / MEDIUM / LOW recovery priority based
  on recency and intent signals (recent missed call, recent quote request,
  explicit appointment request, contacted-but-unresponsive, lead age, etc.).
- **`src/reason.ts`** — derives a *truthful* reason for contact strictly from
  known lead fields. Never invents an event; falls back to an explicitly
  "ungrounded" result when nothing concrete is known.
- **`src/messaging.ts`** — composes the initial outreach message: short,
  personalized, one clear next step, and an easy opt-out. Uses a neutral
  reactivation message when the reason isn't grounded in facts.
- **`src/channels/`** — a `ChannelAdapter` interface with mock SMS, WhatsApp,
  and Email adapters (they log to the console). Swap the `send()` body in
  each adapter for a real provider (Twilio, WhatsApp Business Cloud API,
  SendGrid, etc.) to go live — nothing else in the workflow needs to change.
  Channel selection follows the preferred order **SMS → WhatsApp → Email**,
  constrained to whichever contact info the lead actually has.
- **`src/store/leadStore.ts`** — a `LeadStore` interface with an in-memory
  implementation for local dev/tests. Swap in a real CRM/database-backed
  implementation to plug in live data (STEP 1 — IDENTIFY).
- **`src/workflow.ts`** — orchestrates the whole pipeline; `buildRecoveryPlans`
  is a side-effect-free dry run, `runRecoveryWorkflow` sends messages and
  updates lead status/`lastContactedAt` in the store.

## Getting started

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run the CLI against the bundled sample data (`data/sample-leads.json`):

```bash
npm run cli
```

Run the API server (defaults to port 3000):

```bash
npm run dev
```

Endpoints:

- `GET /health` — liveness check
- `GET /leads` — list all leads currently in the store
- `GET /leads/plan` — dry run: scored + composed recovery plans, nothing sent
- `POST /workflow/run` — executes the workflow (sends via channel adapters,
  updates lead status)

## Extending to a real deployment

1. Implement `LeadStore` against your CRM/database (see `InMemoryLeadStore`
   for the shape) to pull leads from real sources (CRM, website forms,
   missed-call records, booking software, etc.) per STEP 1 of the spec.
2. Replace the mock `send()` implementations in `src/channels/*.ts` with real
   provider calls.
3. Tune the recency windows in `src/scoring.ts` (`SCORING_WINDOWS`) to match
   your sales cycle.
4. Load `SYSTEM_PROMPT.md` as the system prompt if you want an LLM to handle
   free-form qualification conversations on top of this deterministic
   scoring/messaging pipeline (e.g. replying to a lead's response).

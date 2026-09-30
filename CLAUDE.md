# Hedwig — instructions for every AI session

Hedwig is a self-hosted email outreach tool: SvelteKit (adapter-node) + MongoDB + one Agenda worker. What it does, how to run
and deploy it: `README.md`. Everything a user sees is theirs to edit (org names, member roles, their own name, the agent's
persona). No company, product, school or domain name is hardwired in the UI, the agent, the defaults, the tests or the docs.

## THE LAWS
1. **Hedwig never relays mail.** Every send goes through a connected mailbox (the mailbox's own SMTP, or Microsoft Graph).
   No SES, SendGrid, Mailgun, Postmark, Resend for outreach. Resend is only for Hedwig's own emails to its users (team
   invites, the "someone is interested" note), via `sendSystemMail`.
2. **IMAP/SMTP with the mailbox password is the default path; Microsoft 365 is the one exception and connects by OAuth**
   (Microsoft killed password IMAP in 2022). Never ask for, store or log a Microsoft password. Other providers' passwords
   and every refresh token are sealed with `HEDWIG_MASTER_KEY` (AES-256-GCM).
3. **No multi-document transactions.** Every critical write is one atomic `findOneAndUpdate`; everything else is idempotent.
   The sender claims → prepares ids → sends → marks (`src/lib/server/sender.ts`); a crash in between is repaired by
   `reconcileClaims` from the Sent folder (SMTP sends are appended there over IMAP). A step is never sent twice. Keep it that way.
4. **Limits live in the sender and the planner, not the UI:** per-mailbox limit per calendar day in the mailbox's own timezone
   (`emailAccounts.timezone`, taken from the first campaign that uses it, editable under Manage; the campaign's zone as fallback),
   shared across campaigns; ramp for new mailboxes; per-campaign local-day limit; window in the campaign's own timezone
   (`src/lib/server/planner.ts`, `src/lib/server/accounts.ts`). Not a rolling 24 h: that chained each day's start to the day before.
5. **Every number on a screen equals a count on `events`.** Screens read `dailyStats` ($inc at event time, re-derived hourly).
   Nothing scans `events` or `sends` in a request handler beyond bounded, indexed queries.
6. **Scoping is structural.** Routes go through `ctx(locals)` and `ownedCampaign/ownedAccount`; every scoped document carries `space`.
7. **The worker is the only scheduler** (`src/worker/index.ts`, Agenda on `agendaJobs`). Never start crons in the SvelteKit server.
   The web enqueues work by inserting an Agenda-shaped job (`src/lib/server/jobs.ts`).
8. **Motion is a courtesy:** short, never blocking, off under `prefers-reduced-motion`.
9. **The classifier is asked once per reply, and an agent never sends.** A reply is claimed with one atomic
   `findOneAndUpdate` (`messages.ai.status` pending → running) before the model is called: Jev when `TYPESAFE_API_KEY` is
   set, Gemini when it is not or Jev cannot answer; a draft is Gemini's, at most one more call. A failed attempt retries at
   most twice; a hard daily cap
   (`GEMINI_DAILY_CAP`, all calls) stops it. A status a person set is final: the classifier skips that lead until "Label
   again". Drafts are text in the Inbox for a person to edit and send. There is no auto-reply mode. (`src/lib/server/agent.ts`)
10. **One canonical host.** Forms only work where the browser's Origin equals `ORIGIN`; `hooks.server.ts` redirects every other
   host of ours to `ORIGIN`, except `/t/`, `/u/` and `/health`.

## Working rules
- `npm run check` (svelte-check) and `npm test` before saying something works. `tests/db` needs the local MongoDB in `.env`.
- Dev: `npm run dev` (web on :5180) and `npm run worker` in another terminal. The worker does not hot-reload.
- Env comes from `.env` locally (never committed) and from the host in production. `ORIGIN` and `BODY_SIZE_LIMIT` must be set.
- Plain-language copy in the UI: say what happens, name the thing, no jargon, no vendor names in instructions
  ("add it to the server's environment", not a hosting product's menu path).
- Never put a real mailbox password in a file or in chat. Users type them into the Emails screen.
- Test fixtures use example domains and generic names, never a real person, company or client.

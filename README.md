# Hedwig

Hedwig sends multi-step email sequences from mailboxes you already own, at a safe pace, inside a sending window in the
timezone you choose. It reads the replies back, stops a sequence the moment someone answers, labels each reply with an AI
agent, and shows what was delivered, opened and answered. Self-hosted, no contact cap, and it never relays mail through a
third party: every email leaves through your mailbox's own SMTP or the Microsoft Graph API.

## What it does

- **Mailboxes**: any provider with IMAP and SMTP (Titan, Zoho, Google Workspace, IONOS, Hostinger, iCloud, your own server)
  connects with the mailbox password. The servers are detected from the domain's MX record. Microsoft 365 connects through
  Microsoft's consent screen instead, because Microsoft no longer accepts passwords over IMAP. Passwords and tokens are
  encrypted at rest (AES-256-GCM). SPF, DKIM and DMARC are checked daily with the exact record to add.
- **Campaigns**: import a CSV or Excel file of any size, map columns to variables, dedupe against the campaign and your
  suppression list. Write up to twelve steps with `{{variables|fallbacks}}`, bold, links and lists; follow-ups go out in the
  same thread. Test sends, previews with real rows, duplicate a campaign without its leads.
- **Sending**: a window (for example 09:00–17:00 Monday to Friday, in the campaign's timezone), a daily limit per campaign,
  a daily limit per mailbox shared across campaigns (counted per calendar day in the mailbox's own timezone), a warm-up
  ramp for new mailboxes (10 a day, +5 a week), sends spread across the window with jitter, never a burst. Leads are split
  across the campaign's mailboxes and pinned to one for the whole sequence.
- **Replies**: the inbox of every mailbox is read every two minutes. A reply is matched to its lead by conversation id
  (Microsoft), by the Message-ID headers Hedwig put on its own emails, or by the sender's address. Replies stop the
  sequence; bounces stop it and suppress the address; out-of-office notes are recognised and, by default, ignored. A
  mailbox pauses itself when bounces reach 5% of a week's sends (editable, or off).
- **Inbox**: every conversation that got an answer, filtered by status, agent label and campaign. Reply from the mailbox
  that holds the thread, threaded on their last message; set the lead's status from the thread.
- **Reply agent**: a built-in "Triage" agent reads each reply once and labels its sentiment: interested, meeting,
  question, not interested, out of office, bounce, unsubscribe, other. The labels come from Jev, TypeSafe's classifier, when
  its key is set; Gemini labels when there is no key or Jev can't answer (a rejected key, no room, an outage). Drafts always
  come from Gemini. Interested, meeting, not interested and unsubscribe set
  the lead's status when the agent is at least 75% sure; once you set a status by hand the agent leaves that lead alone.
  Interested and meeting email the campaign's owner. On request the agent drafts an answer for you to edit and send. An
  agent never sends anything by itself.
- **Curious**: once a day, people who opened a campaign's emails more often than they got them (two emails, three opens)
  and never replied are flagged curious, apart from their status. A reply clears it; you can set or reset it by hand.
- **Analytics**: sent, opens (once per email, machine prefetch discounted), replies, bounces, opportunities; per day, per
  step, per mailbox, per campaign. Each open by a person is recorded with its time.
- **Teams**: organisations with owners and members, invitations by email, a personal space for things nobody else sees.

## Research with an assistant

Connect ChatGPT, Claude, or another remote MCP client from **Connections**. The assistant researches with its available tools and saves structured, sourced results to **Research** tables. Add typed enrichment columns, protect manual edits, deduplicate contacts, and enroll snapshots into a draft or paused campaign. Read status and statistics, pause, configure, start and resume through the same connection. Sending requires a separate permission.

Hedwig supplies OAuth sign-in using your existing account; no enrichment subscription or external identity service is required. Deploy behind HTTPS and use the canonical `/mcp` endpoint. See [setup, permissions, tools and recovery](docs/mcp.md). Existing campaign data stays in place; new collections/indexes are additive. Pause active campaigns before modifying sending content or recipients.

## Run it locally

Node 22 and a MongoDB (local, Docker, or Atlas).

```bash
cp .env.example .env        # MONGODB_URI, HEDWIG_MASTER_KEY, BOOTSTRAP_USER_EMAIL, BOOTSTRAP_USER_PASSWORD at least
npm install
npm run dev                 # web on http://localhost:5180
npm run worker              # in another terminal: the scheduler (sender, inbox sync, agent, DNS checks)
```

Sign in with the bootstrap user, connect a mailbox on Emails, create a campaign, import a list, write the steps, pick a
mailbox in Options, activate. `npm run check` and `npm test` before a pull request (`tests/db` needs the MongoDB in `.env`
and uses the database `hedwig_test`).

## Deploy

Hedwig is one Node service plus MongoDB. The web server and the worker run as two processes; `npm start` runs both in one
container, which is the simplest setup. Run exactly one worker: it is the only scheduler.

**Docker Compose** (app + MongoDB, the quickest self-hosted way):

```bash
cp .env.example .env        # fill it in; MONGODB_URI is set for you
docker compose up -d --build
```

The app listens on port 3000. Put a reverse proxy with HTTPS in front of it (Caddy is two lines) and set `ORIGIN` to that
address. Back up the `mongo-data` volume.

**Any platform that builds from a repository** (Coolify, Railway, Render, Fly, Dokku and the like): point it at this
repository, build with the Dockerfile (or `npm run build` + `npm start` on Node 22 with a Debian-based image), expose port
3000, give it a MongoDB (a managed one or a database resource on the same platform) and the environment below.

**Environment**: `MONGODB_URI` (required) · `MONGODB_DB` (default `hedwig`) · `ORIGIN` (the one address the app lives on;
forms only work there, and Hedwig redirects every other host of yours to it) · `TRACKING_BASE_URL` (pixels and unsubscribe
links; can equal `ORIGIN`) · `HEDWIG_MASTER_KEY` (32 random bytes in base64; needed before the first mailbox; never change
it afterwards or every connected mailbox becomes unreadable) · `BODY_SIZE_LIMIT=25M` (large imports) ·
`BOOTSTRAP_USER_EMAIL` + `BOOTSTRAP_USER_PASSWORD` (the first user, created once) · `BOOTSTRAP_ORG_NAME` (optional) ·
`TYPESAFE_API_KEY` (optional: Jev labels replies; console.typesafe.ai → API keys) · `GEMINI_API_KEY` (drafts, and the
labels whenever Jev is not set or can't answer; with neither key replies are matched and stopped but not labelled) · `GEMINI_DAILY_CAP`
(optional, default 300 model calls a day, Jev and Gemini together) · `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (Microsoft 365 mailboxes,
below) · `RESEND_API_KEY` + `LOGIN_FROM` (optional: Hedwig's own emails to its users go through Resend; otherwise through the
first connected mailbox).

`/health` answers `{"ok":true,"db":true,"worker":{"alive":true}}` when everything runs. The Setup screen shows the worker's
heartbeat, every scheduled job, the last runs and the agent's model calls.

## Connect with Microsoft (Microsoft 365 only, one-time setup)

Microsoft ended password logins for IMAP in 2022, so Microsoft 365 mailboxes connect through a consent screen. That needs
an app registration in your Microsoft tenant, once, five minutes; afterwards any Microsoft mailbox connects with a click.
In the Entra admin center:

1. App registrations → **New registration**. Any name. Supported account types: *Accounts in any organizational directory
   and personal Microsoft accounts*. Redirect URI (Web): `https://<your ORIGIN>/emails/microsoft/callback`
   (for local development add `http://localhost:5180/emails/microsoft/callback`).
2. Overview → copy **Application (client) ID** → `MS_CLIENT_ID`. Leave `MS_TENANT_ID=common` (any Microsoft account) or set
   your tenant id to restrict it to your organisation.
3. Certificates & secrets → New client secret → copy the **Value** → `MS_CLIENT_SECRET`.
4. API permissions → Add → Microsoft Graph → Delegated: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`
   → **Grant admin consent**.
5. Put the values in the environment, restart, open **Emails → Connect with Microsoft**.

Nothing has to be switched on in Exchange: Hedwig sends and reads through the Graph API.

## How it works inside

- **Planner** (every minute): for each active campaign whose window is open in its own timezone, books today's missing sends
  spread across the remaining window with jitter, within the campaign's daily limit and each mailbox's daily limit and ramp.
  Follow-ups that are due take the first slots.
- **Sender** (same tick): claims one due send at a time with an atomic update, renders the variables, sends through the
  lead's mailbox (SMTP with Hedwig's own Message-ID, a copy appended to the Sent folder over IMAP; or Graph, where
  follow-ups are `createReply` so they thread), records the event. Provider ids are stored *before* the send, so a crash is
  repaired by the reconciler from the Sent folder and a step is never sent twice.
- **Inbox sync** (every two minutes): Graph delta or IMAP UIDs since last time; match, classify (bounce, out of office,
  reply), update the lead, cancel the remaining steps, suppress on bounce or unsubscribe; then hand new replies to the agent.
- **Reply agent**: a reply is claimed atomically before the model is called, so it is labelled once (Jev, or Gemini when Jev can't answer),
  retried at most twice after a failure, and never in parallel; a draft is at most one more Gemini call; a hard daily cap
  stops runaway usage. A status set by hand is final: the classifier skips that lead.
- **Tracking**: one pixel per email on the tracking host; each person's opens recorded with their time, prefetch discounted.
  `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every real send from an IMAP/SMTP mailbox, so mail clients show
  their own unsubscribe link; an optional unsubscribe line per campaign.
- **Counts**: every number on a screen is a count on the `events` collection, kept in `dailyStats` and re-derived hourly.

Stack: SvelteKit (adapter-node), MongoDB, Agenda for the worker, Luxon for timezones, Nodemailer and ImapFlow for mail,
Jev and Gemini for the agent. The rules the code keeps are in `CLAUDE.md`.

## License

MIT. See `LICENSE`.

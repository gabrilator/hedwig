# How Hedwig works

The details behind each screen, and the rules the code keeps.

## Features in detail

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
- **Reply agent**: each workspace has one agent, "Triage", that reads each reply once with Jev, TypeSafe's classifier, and
  labels it meeting, interested or replied. Without `TYPESAFE_API_KEY` nothing is labelled. Meeting and interested set the
  lead's status when Jev is at least 75% sure, and email the campaign's owner; replied changes nothing. Once you set a status
  by hand the agent leaves that lead alone. Bounces and out-of-office notes are sorted by the inbox sync before the agent.
  An agent never writes or sends anything. The Agents screen (on/off, Jev's usage) is for `ADMIN_EMAILS` only.
- **Team**: an owner invites by email; the invitation is a one-time link that only the invited address can use, sent from the
  team's own mailbox (or Resend). Signing up with an invited address does not join a team; opening the link does.
- **MCP**: assistants connect once per account and reach every workspace you are in, one at a time; the MCP tab lists
  your connections and disconnects them.
- **Curious**: once a day, people who opened a campaign's emails more often than they got them (two emails, three opens)
  and never replied are flagged curious, apart from their status. A reply clears it; you can set or reset it by hand.
- **Analytics**: sent, opens (once per email, machine prefetch discounted), replies, bounces, opportunities; per day, per
  step, per mailbox, per campaign. Each open by a person is recorded with its time.
- **Teams**: organisations with owners and members, invitations by email, a personal space for things nobody else sees.
- **Results feed**: a secret link per workspace serves its results as two CSV files, for a spreadsheet or another app to
  read without signing in. Made, replaced and turned off under Setup. See [Results feed](#results-feed).

## Results feed

**Setup → Results feed → Make a link** creates a secret link for the workspace you are in. It serves two read-only files
to anyone who has it:

- `/feed/<token>/leads.csv`: one row per lead in the workspace's campaigns, newest campaign first, then by email. Columns:
  `campaign, email, lead_id, branch, segment, status, agent_label, first_sent_at, last_sent_at, steps_sent, opens,
  replied_at, curious`. `lead_id`, `branch` and `segment` are the lead's variables of those names, empty when it has none
  (a CSV column called `lead_id` is imported as `leadId`, which counts too). `status` is the lead's status, including one a
  person set; `agent_label` is the reply agent's latest label. `opens` counts a person's opens across all steps.
  `replied_at` is the first reply; bounces and out-of-office notes don't count.
- `/feed/<token>/daily.csv`: one row per campaign per day for the last 180 days, oldest first. A day with nothing to count
  has no row. Columns: `date, campaign, sent, opens, replies, interested, meetings, bounces`. Sent, opens (emails opened),
  replies and bounces are the Analytics numbers, from `dailyStats`. Interested and meetings count leads whose status is
  interested or meeting now, on the day they first replied, so changing a status moves them.

Days and times are UTC, written `2026-10-28 14:03:00` so a spreadsheet reads them as dates. There is no email text,
subject or credential in either file. leads.csv stops at 50,000 rows.

The link is shown once: Hedwig keeps only a hash of it, like its other credentials. **Make a new link** replaces it and
**Turn off** removes it; either way the old link stops working at once. A link also stops working when the person who made
it leaves the workspace. Each link answers 30 requests a minute.

### In Google Sheets

Give each file its own tab and put the formula in cell A1:

```
=IMPORTDATA("https://hedwig.example.com/feed/<token>/leads.csv")
```

and the same with `daily.csv` in the other tab. When Setup makes the link it shows both formulas, each with a copy button.
Google fetches the file again about every hour. To fetch it at once, edit the formula, for example by adding `?1` to the
end of the address.

Anyone with the link can read these leads and numbers, and anyone who can open the sheet can see the formula. Make a new
link if it gets out. An app or an agent can read the same two addresses with a plain GET, no sign-in or header needed.

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
- **Reply agent**: a reply is claimed atomically before Jev is called, so it is labelled once, retried at most twice after a
  failure, and never in parallel; a hard daily cap (`JEV_DAILY_CAP`) stops runaway usage. A status set by hand is final: the classifier skips that lead.
- **Tracking**: one pixel per email on the tracking host; each person's opens recorded with their time, prefetch discounted.
  `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every real send from an IMAP/SMTP mailbox, so mail clients show
  their own unsubscribe link; an optional unsubscribe line per campaign.
- **Counts**: every number on a screen is a count on the `events` collection, kept in `dailyStats` and re-derived hourly.

Stack: SvelteKit (adapter-node), MongoDB, Agenda for the worker, Luxon for timezones, Nodemailer and ImapFlow for mail,
Jev for the agent. The rules the code keeps are in `CLAUDE.md`.

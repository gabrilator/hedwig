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

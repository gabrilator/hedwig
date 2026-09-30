# Self-hosting

Everything needed to run Hedwig on your own server. The short version is in the [README](../README.md).

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
it afterwards or every connected mailbox becomes unreadable) · `BODY_SIZE_LIMIT=25M` (large imports) · `HEDWIG_LANDING=1` (optional: a public home page at `/` for signed-out
visitors, with sign-up and the Claude Code and Codex setup for this address; without it `/` goes to the login) ·
`BOOTSTRAP_USER_EMAIL` + `BOOTSTRAP_USER_PASSWORD` (the first user, created once) · `BOOTSTRAP_ORG_NAME` (optional) ·
`TYPESAFE_API_KEY` (optional: Jev labels replies; console.typesafe.ai → API keys) · `GEMINI_API_KEY` (drafts, and the
labels whenever Jev is not set or can't answer; with neither key replies are matched and stopped but not labelled) · `GEMINI_DAILY_CAP`
(optional, default 300 model calls a day, Jev and Gemini together) · `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (Microsoft 365 mailboxes,
below) · `RESEND_API_KEY` + `LOGIN_FROM` (optional: Hedwig's own emails to its users go through Resend; otherwise through the
first connected mailbox).

`/health` answers `{"ok":true,"db":true,"worker":{"alive":true}}` when everything runs. The Setup screen shows the worker's
heartbeat, every scheduled job, the last runs and the agent's model calls.

## Run it on your laptop

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

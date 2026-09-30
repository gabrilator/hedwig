# Control Hedwig from an assistant

Hedwig exposes its outreach workflow and workspace controls to compatible MCP clients, including connected ChatGPT and Claude assistants. The client supplies its own research tools and sources; Hedwig does not search the web, discover private contact data, or verify mailbox deliverability. No enrichment-provider subscription or external identity service is required.

## Connect

1. Serve Hedwig at its configured `ORIGIN` over HTTPS. Loopback HTTP is allowed for local development. Run the web process and the existing worker as usual.
2. Open **Setup → Assistant connections** in Hedwig and copy the `/mcp` URL.
3. Add it as a custom remote MCP connection in your assistant (availability and settings depend on the client/account). Use automatic OAuth discovery, not a pasted access token.
4. Sign into Hedwig, select a workspace and permissions, and connect. All requested permissions are selected by default. You can deselect any permission before connecting. Campaign launch/test sends and inbox replies have separate sending permissions. When the client omits scopes, Hedwig offers the full set; an explicit narrower request stays narrow. Existing grants are never expanded: disconnect and reconnect to enable new controls.
5. Disconnect from **Setup → Assistant connections** to revoke the entire grant, including already-issued access and refresh tokens. Removing organization membership also removes access immediately.

The server supports Streamable HTTP and OAuth authorization code + S256 PKCE, dynamic client registration (DCR), public clients and client secrets. It publishes authorization-server and protected-resource discovery metadata. Clients should use DCR; Client ID Metadata Documents (CIMD) are not implemented. Request the exact canonical `/mcp` URL as the OAuth resource. `offline_access` enables rotating refresh tokens. Secrets and bearer tokens are never part of tool arguments.

Access tokens expire in 15 minutes. Refresh tokens expire in 30 days and rotate on use. Reuse of an old refresh token revokes the connection; reconnect after such a failure. Browser sessions are separate from MCP credentials. Credentials are hashed in MongoDB. All tool requests re-check the user, current workspace membership, grant revocation, token expiry, resource and scopes. Requests and registration are rate-limited; configure your reverse proxy's trusted client IP forwarding correctly for per-address limits.

## First workflow

> Create a research table for 40 companies. Columns: companyName (text), website (url), hiringSignal (text), fitScore (number), fitReason (text). Research using the tools available to you, save source URLs for each observed fact, and explicitly label inferences. Leave unknowns missing. Add contacts only when you have a stable identity.

> Add a column called openingLine and fill it using the cited facts. Preserve my manual edits.

> Create a draft campaign, configure its steps, schedule and sending mailboxes, and enroll the selected contacts. Show readiness before starting.

> Start the campaign. Later, pause it, wait until it is safe to edit, add more contacts, and resume only when I request it.

The tools include campaign/mailbox listing, configuration and readiness, UTC date-filtered statistics, draft creation, stopped-campaign editing, pause/start, paginated recipients, enrichment of existing recipients, research table/column creation, paginated research rows, bulk upsert and enrollment. `operation_get` retrieves write receipts. Tools without granted scopes are omitted from discovery; authorization is also enforced when executed. Enrollment additionally needs research read access.

## Default chat workflow

The server supplies the workflow in MCP initialization instructions and `workflow_get`. An assistant should read the saved state, perform requested edits, render previews, report the actual sender addresses and numbered initial/follow-up messages with delays, test when requested, and launch when requested. These instructions guide the client; they do not guarantee that every client model will follow them. Backend permissions, validation, workspace isolation and sending locks remain enforced.

`campaign_update` returns the saved configuration, readiness and personalized previews. `campaign_start` returns the active campaign and its schedule/window/capacity, while preserving the previous top-level ID/status response. `campaign_get` includes `safeToEdit`, unresolved-send count, selected mailbox addresses and effective agent settings. Active means enabled; sending can still wait for a window or capacity.

| Area | Tools / controls |
| --- | --- |
| Campaigns | Create, get, update all campaign options (including test recipient and agent/rules), pause, start/resume, clone, delete, resolve enrollment conflicts, statistics |
| Sequence testing | `campaign_preview`, `campaign_test`, `campaign_test_log` |
| Leads | List, enroll, enrich, explicit variable/status/curious corrections, requeue paused recipients, remove |
| Mailboxes | List/get settings, update name/limit/timezone/ramp/bounce threshold/status, check connection, enqueue sync/DNS, disconnect |
| Agents | List models/settings, create/edit custom agents or the built-in default, delete unassigned custom agents |
| Inbox | List/read conversations, mark read/unread, delete received messages locally, classify, draft, send requested replies |
| Research | Create/read/import/upsert lists, add columns, explicit cell corrections, rename, remove rows/delete lists |
| Workspace | Profile name, organization creation/rename/deletion, members/roles/invitations, connection listing/revocation, health and configuration status |

`campaign_test` requires an explicit test destination and active mailbox. Omit the 1-based `step` to send every step immediately; supply `leadId` to choose personalization. Tests use a separate test thread, do not advance live leads, and skip sequence delays. Missing variables block test sending. A full-sequence test stops on failure and reports each sent/uncertain step; inspect its receipt and test log before doing anything else. An identical request ID never sends again. These tests verify rendering and provider submission, not inbox placement, real scheduling or stop-on-reply behavior. The test log records sending/sent/failed state; a crash can leave a sending record for operator inspection.

`inbox_reply` sends only a requested reply, through the conversation mailbox, with a durable receipt and duplicate nonce protection. Built-in reply agents remain classify/draft-only. `lead_update` and `research_edit_cells` are for user-directed corrections; use enrichment tools for automatic research so manual values stay protected. Team invitations register access without emailing an invitation; the result includes a signup link to share.

Mailbox credentials, password changes, Microsoft consent and server environment secrets remain in secure browser/host setup, with links returned by `workflow_get`/`workspace_get`. No tool returns credentials. Connections stay bound to one workspace; reconnect to work in a newly created organization. Organization management still requires the user's actual role. Deletion requires an exact campaign/organization name or mailbox address and settled sends.

New scopes: `mailboxes:read/write`, `agents:read/write`, `inbox:read/write/send`, `workspace:read/write`. Existing campaign/research scopes keep their domains. Tools outside the grant are omitted and cannot be called. `operation_get` supports receipts in each authorized domain.

## Research and duplicates

- Contacts live in a workspace, independent of campaigns, and can belong to multiple research tables. An email or stable profile URL identifies a person. A company can be identified by its domain before any email is known. Names alone are rejected as ambiguous.
- Normalized emails and profile URLs (without query/fragment/trailing slash) have unique identity indexes. Domain identity is for company rows only: two people at a company are not duplicates.
- Conflicting identities are returned for review instead of auto-merged. Changed emails/profile identities are also flagged. Different aliases or two profiles without a shared identifier cannot be proven duplicates automatically.
- Column keys are email template variable names. Columns have text/number/boolean/URL types and optional research instructions. A contact holds at most 100 fields; a table exposes up to 50 columns.
- Each field stores value, observed/inferred/manual origin, sources, retrieval time, status and actor. Observed facts require evidence URLs. Hedwig stores those citations; it does not independently validate their claims.
- `fill_missing` preserves existing complete values; `replace` refreshes non-manual values. Automatic enrichment cannot label a value manual. Explicit user corrections through `research_edit_cells` (or the website) and user-provided imports can do so. Table cell edits protect that value against subsequent assistant updates.
- Enrollment copies current values into the campaign's sending variables. Later research changes cannot silently change live outreach. Enrollment never resumes a campaign.
- Unique campaign/email indexes prevent duplicate enrollment. Suppressed contacts are always skipped. Contacts in another active campaign are blocked; readiness rechecks this under the shared workspace lock. Prior outreach is skipped by default; explicit `allowPreviousOutreach` permits another campaign, never bypasses suppression or same-campaign deduplication.
- Existing CSV campaign leads remain in place. They can be read/enriched through campaign tools or copied by the assistant into a research table. There is no destructive conversion of existing data.
- CSV imports now skip contacts in another active campaign and previously contacted people; the import receipt reports both. Enriched campaign fields preserve imported/manual values by default.

## Sending and editing

Pause before changing recipients, sequence, mailboxes, schedule or sending variables. Individual opt-out/status changes that stop outreach remain available during sending. A pause returns `safeToEdit: false` if a send is already in flight or uncertain. It cannot recall an email already handed to a provider. Wait for reconciliation; do not treat `paused` alone as proof that editing is safe.

Start and resume use the same readiness checks: usable mailbox, sequence and schedule, eligible leads, required variables/fallbacks, current worker heartbeat, unresolved sends and active-campaign conflicts. Daily limits and sending windows still apply. A campaign can be active while waiting for its next window or mailbox capacity.

Cancelled, unprepared send slots are revived in place, preserving the unique lead/step key. Prepared/uncertain sends are never revived this way. Sending claims are serialized with campaign changes. Database changes are additive; existing campaigns, leads and mailboxes keep their IDs.

Every MCP write requires a unique `requestId` (8–128 characters). Reuse it for an identical retry. A durable receipt returns the original result without repeating a write—even if a campaign has since been paused. A different payload with the same ID is rejected. Bulk operations return row-level outcomes; inspect them rather than assuming every row succeeded. A process interrupted during a write leaves a pending receipt for operator review instead of silently repeating the mutation.

## Operations and recovery

Mutations and send claims use workspace/campaign mutex records. They do not expire while another process might still be writing. Normally they are released in `finally` blocks. If a process dies inside a critical section, operations in that workspace stop safely.

To recover after a crash: stop **both** web and worker processes, back up MongoDB, inspect `workspaceLocks`, campaign `editLock`/`editLockedAt`, `operationReceipts` with `status: pending`, and claimed/prepared sends. Resolve partial writes from the receipt and stored documents. Clear only the abandoned lock records and corresponding campaign lock fields while all writers are stopped. Restart the worker to reconcile sends before editing or resuming. Do not reset send state or replay pending commands blindly. There is intentionally no public force-unlock endpoint.

One worker remains the only scheduler. No MCP request starts a background scheduler. No enrichment providers or CLI are included in this release.

## Validation

`npm run check`, `npm test`, `npm run build`. Database tests use `MONGODB_DB_TEST` (default `hedwig_test`); use a dedicated local MongoDB and never point tests at production. The `research-mcp` suite exercises duplicate identities, manual edits, snapshot enrollment, pause/resume, suppression, receipts, date filtering, PKCE/replay, refresh/revocation, workspace access, MCP discovery and Streamable HTTP.

After building, `node scripts/smoke-mcp.mjs` runs the actual HTTP login/consent/OAuth/MCP path against a dedicated loopback MongoDB (default port 27119). It starts an isolated web server and never starts a sending worker. Live connection testing in ChatGPT/Claude requires an HTTPS-accessible deployment; local SDK/HTTP tests are not a substitute for that final interoperability check.

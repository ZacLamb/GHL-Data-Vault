# GHL Vault — file exporter for GoHighLevel sub-accounts

GHL's CSV export covers every data set except file uploads. This tool crawls every place a file can live
in a sub-account, streams each file into Cloudflare R2, and writes a manifest you can join back to your
contact / opportunity / conversation CSVs.

## What it exports

| Source key           | Where it looks                                            | GHL endpoint(s)                                  |
|----------------------|-----------------------------------------------------------|--------------------------------------------------|
| `contact_fields`     | Contact custom fields of type File Upload                 | `/locations/{id}/customFields`, `POST /contacts/search` |
| `opportunity_fields` | Opportunity custom fields of type File Upload             | `/opportunities/search`                          |
| `conversations`      | Message attachments (MMS/email/chat) + call recordings & voicemails | `/conversations/search`, `/conversations/{id}/messages`, `.../recording` |
| `forms`, `surveys`   | Uploads inside form/survey submissions                    | `/forms/submissions`, `/surveys/submissions`     |
| `media`              | Media Library (recurses folders)                          | `/medias/files`                                  |
| `documents`          | Documents & Contracts (signed PDFs)                       | `/proposals/document` — verify on first run, see notes |

R2 layout: `{locationId}/{source}/{contactId|conversationId|...}/{fieldName|messageId}/{fileId}_{filename}`

Manifest columns: `source, contact_id, opportunity_id, conversation_id, message_id, submission_id, document_id,
field_id, field_name, original_filename, mime_type, size_bytes, r2_key, source_url, status, error`.

## Deploy (GitHub → Railway)

1. Push this repo to GitHub, create a Railway service from it, add a Postgres plugin (Railway sets `DATABASE_URL`).
2. Set the env vars from `.env.example`. Create an R2 bucket + API token (Object Read & Write).
3. Open the service URL, log in with `ADMIN_PASSWORD` (any username).

## Auth options

- **Per-location PIT** — Settings → Private Integrations in the sub-account. Scopes needed: contacts, opportunities,
  conversations, conversations/message, forms, surveys, locations, locations/customFields, medias, documents/contracts (all read).
  Paste it when adding the location. Fine for a handful of accounts.
- **Agency OAuth (recommended for 85+)** — create a marketplace app (private, agency-level distribution) with the same
  read scopes, install it at the agency, put the agency access token + company id in env. Click **Import sub-accounts**
  and the tool mints per-location tokens automatically (`POST /oauth/locationToken`). You'll want a small refresh cron
  for the agency token since it expires in 24h.

## Running an export

Pick sources, click **Run export**. Jobs run one at a time in the background, save cursors after every page, and resume
automatically if Railway restarts the container. Re-running a location is idempotent: files already in R2 are skipped
(unique on `location_id + source_url`), so a second run only picks up new files. **Retry failed** re-queues downloads
that errored (expired signed URLs are the usual cause — they're re-fetched fresh from the API on the next crawl).

`manifest.csv` and `export.zip` are per-location. The zip is streamed straight out of R2, so it works for large
accounts without buffering on the server.

## Things to verify on the first real run

- **File field value shape.** `parseFileFieldValue()` handles string / array / `{docId: {url, meta}}`. If a field comes
  back in another shape, the file shows up as `filesFound: 0` for that source — log one contact's `customFields` and extend the parser.
- **Recordings** use the `/recording` endpoint with the bearer token and land as `.wav`. If a message type isn't
  `TYPE_CALL`/`TYPE_VOICEMAIL` on your accounts, add it to `CALL_TYPES` in `sources/conversations.js`.
- **Documents & Contracts** is the newest and least documented API. The crawler harvests any file-looking URL off each
  document object; if the signed PDF isn't exposed on the list endpoint, check whether a per-document GET returns it and
  add that call.
- **Signed URLs.** Some GHL storage links expire. That's why ingest downloads immediately on discovery rather than
  collecting first.

## Packages — splitting contacts across reps

After `contact_fields` has run for a location, the dashboard shows a **PACKAGE** bar with 1k / 5k / 10k / 20k / 50k / 100k
buttons. Each click:

1. Picks that many contacts **at random** from the ones not already in a package (a contact can only ever be in one
   package, so packages never overlap).
2. Writes `packages/{locationId}/pkg-{id}/contacts.csv` — GHL-importable columns plus every non-file custom field.
3. Copies each contact's files inside R2 to `pkg-{id}/{contactId}/{field name}/{filename}` (server-side copies, no
   download/upload; ~$4.50 per million files).
4. Writes `manifest.csv` (contact_id → package_path) and a README into the package folder.

Buttons grey out when there aren't enough unassigned contacts left. **dissolve** deletes the package record and returns its
contacts to the pool (files already copied into R2 are left in place; delete the prefix manually if you want them gone).

To hand a package to a rep: import `contacts.csv` into their sub-account, then either give them the zip (≤5k files) or an
rclone/R2 path. Pushing files back into their GHL contact fields via the API is a natural next step if you want it.

## Analytics

Each location has an **analytics →** link. It shows totals (contacts, with/without documents, documents in R2, storage,
unassigned, failed downloads), a documents-per-contact distribution, and breakdowns by document field, tag, state,
month added, and file source. Clicking any bar adds it as a filter. Filters combine: min/max documents, must-have /
must-not-have fields, tags, states, date range, custom field value, keyword, unassigned-only. From a filtered set you
can export a CSV or create a random package of N contacts drawn only from that filter (still non-overlapping with
existing packages).

## Usage analytics

`/usage.html` (link in the header) shows an agency overview — one row per sub-account with users, active users,
contacts, new contacts, outbound/inbound messages, calls, talk time, deals won, last activity — and, per location,
KPIs, a daily activity chart, channel breakdown, and a per-user table (SMS/email/social sent, calls in/out, talk time,
contacts touched/created/assigned, opportunities created/won/value, appointments, active days, first/last activity).
Any date range; click a user to chart just them; export the table to CSV.

Data comes from two sources: **conversations** (message metadata — every message, not just ones with attachments) and
**usage** (users, opportunities, calendar events). Run both, then use Sync new to keep them current. Logins are not
available through the public API; "active days" is the closest proxy.

### Agency checkup, owner reports, audit webhooks

- The usage overview shows a **health** tier per sub-account (active / slowing / dormant / never) and **idle seats**
  (users with no outbound activity in 30 days). The per-user table shows a **status** (active / low / inactive / none).
- **Owner report link** (on a location's usage page) creates a read-only `/report/<token>` page — light theme,
  printable, no login, last 7/30/90 days, that account only, no emails shown. Generating a new link revokes the old.
- **Audit stream**: create an agency-level marketplace app, subscribe to webhook events (ContactCreate/Update/Delete,
  NoteCreate, TaskCreate/Complete, OpportunityStageUpdate/StatusUpdate, OutboundMessage, InboundMessage,
  AppointmentCreate, UserCreate…) and set the webhook URL to `https://<host>/webhooks/ghl?key=<WEBHOOK_KEY>`.
  Events land in the `events` table and surface as Notes / Tasks / Edits / Stage moves columns per user.
  `/api/locations/<id>/events` shows what event types have arrived. Logins are not published by GHL.

# Plan — direct Facebook / Instagram Lead Ads connection

Requested by the owner (2026-11-28, "Yes" to building the direct Meta connection). Replaces the Zapier/Make
workaround of A-025. Recorded as A-047. Still needs the owner's Meta app (O-04) before it receives real leads.

## Flow

1. A person submits a Lead Ads form on Facebook or Instagram.
2. Meta calls `POST /api/v1/webhooks/meta` (field `leadgen`) with the page id, form id and lead id. The CRM checks
   `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), finds the connected page, and enqueues one
   job per lead (`meta.lead:<leadgen_id>`, idempotent). It answers 200 at once, so Meta does not retry.
3. The job fetches the lead from the Graph API (`GET /<leadgen_id>`) with the page's access token. It maps the form
   fields (name, phone, e-mail, city, custom questions) and sends the lead through the normal intake: channel
   META_ADS, the connection's source, campaign matched by Meta campaign id or name. Then allocation, first-call task
   and SLA follow as for every lead. Graph errors are retried, then dead-lettered (`/internal/status` reports them).
4. `GET /api/v1/webhooks/meta` answers Meta's subscription check with `META_VERIFY_TOKEN`.

## Configuration

- Platform (Vercel env): `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (default `v23.0`), `SECRETS_KEY`
  (32-byte key that encrypts page tokens). Without the app secret the webhook is switched off (404).
- Per brand (Sources & campaigns, `integration.manage`, like intake keys): a **Meta connection** with page id, page name, the CRM source to
  credit (a META_ADS source) and the page access token. The token is encrypted (AES-256-GCM) and never shown again; it
  can be replaced. Connecting also subscribes the page to the app's `leadgen` webhook. Connections can be paused.
  Every change is audited.
- Development and tests use a labelled **sandbox** Meta client (fake Graph API); production never registers it.

## Data (migration `meta_connections`)

`meta_connections`: organization, brand, source, page id (unique), page name, encrypted token, status, subscribed,
last lead at, last error, created by. Tenant table with RLS. The webhook looks a page up across organizations with the
system scope (page id → organization only), as the payment webhook does.

## Also

Campaign matching for every channel also accepts the campaign's **external id** (Meta / Google campaign id), not only
its UTM name.

## Tests

Signature check (missing / wrong → 401), subscription check, one job per lead (duplicate deliveries ignored), unknown
or paused page ignored, lead ingested with source and campaign, token encrypted at rest and never returned,
permissions, Graph failure retried then dead-lettered, no sandbox in production.

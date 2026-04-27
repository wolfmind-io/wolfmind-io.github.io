# wolfmind-forms (Cloudflare Worker)

Receives form submissions from `wolfmind.io` and pushes them into Attio
(People + Companies + the **Inbound leads** list).

## What it does

| Endpoint            | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `POST /design-partner` | §05 cohort application — upserts Company, upserts Person, links them, adds to Inbound leads (Stage: New) with `lead_source = "Design partner cohort form"` |
| `POST /keep-posted`    | Lighter capture — upserts Person, adds to Inbound leads (Stage: New) with `lead_source = "Keep me posted"` and `interest` including `Just keep me posted` |

Both upserts match People by `email_addresses` (unique) and Companies by
`domains` when the submitter uses a non-generic email; otherwise a new
Company record is created.

After the Attio write succeeds, two side-effects fire fire-and-forget
(the form response is already on the wire):

1. **Confirmation email** to the submitter via Resend
2. **Teams notification** to a Power Automate webhook

Both are best-effort — failures are logged but never block the form
response. Attio is the source of truth.

## Required Attio schema

These were created in the Attio UI before the Worker was wired up:

- **People → Interest** (multi-select): Aperture · PyroMesh Pulse · PyroMesh · Digital Provenance · Just keep me posted
- **People → Lead source** (single-select): Design partner cohort form · Keep me posted
- **List "Inbound leads"** (parent: people) with a `Stage` status: New → Contacted → Qualified → Design partner → Declined

## Secrets

| Secret | Required | Purpose |
| ------ | -------- | ------- |
| `ATTIO_TOKEN` | yes | Attio API bearer token, scope `record:read-write` + `list_entry:read-write` |
| `RESEND_API_KEY` | optional | Resend API key. Without it, confirmation emails are silently skipped. |
| `TEAMS_WEBHOOK_URL` | optional | Power Automate "Workflows" webhook URL. Without it, Teams pings are silently skipped. |

Set each with `npx wrangler secret put <NAME>` and paste the value when
prompted.

## One-time deploy

From this directory:

```sh
npm install
npx wrangler login                         # opens browser; signs into your CF account
npx wrangler secret put ATTIO_TOKEN
npx wrangler secret put RESEND_API_KEY     # optional
npx wrangler secret put TEAMS_WEBHOOK_URL  # optional
npx wrangler deploy
```

## Custom domain (optional)

If `wolfmind.io` is already on Cloudflare DNS, replace the workers.dev URL
with `https://forms.wolfmind.io` after binding it:

1. In `wrangler.jsonc`, uncomment the `routes` block.
2. `npx wrangler deploy`
3. Update `ENDPOINT` in `../assets/app.js`.

## Local dev

```sh
npx wrangler dev
```

Add `http://localhost:8787` to the origin allow-list in `src/index.js`
if testing from a local site server.

## Re-deploy after editing

```sh
npx wrangler deploy
```

Logs (live tail):

```sh
npx wrangler tail
```

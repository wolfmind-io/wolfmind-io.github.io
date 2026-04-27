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

## Required Attio schema

These were created in the Attio UI before the Worker was wired up:

- **People → Interest** (multi-select): Aperture · PyroMesh Pulse · PyroMesh · Digital Provenance · Just keep me posted
- **People → Lead source** (single-select): Design partner cohort form · Keep me posted
- **List "Inbound leads"** (parent: people) with a `Stage` status: New → Contacted → Qualified → Design partner → Declined

## One-time deploy

From this directory:

```sh
npm install
npx wrangler login                         # opens browser; signs into your CF account
npx wrangler secret put ATTIO_TOKEN        # paste your Attio API token (read+write)
npx wrangler deploy                        # publishes the Worker
```

The deploy step prints a URL like
`https://wolfmind-forms.<your-subdomain>.workers.dev`. Put that URL in
`../assets/app.js` (the `ENDPOINT` constant), commit, and push.

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

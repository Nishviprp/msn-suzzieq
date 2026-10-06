# Filling in the Suzzie Q catalog

This is the list of real places, people and groups Suzzie Q is allowed to suggest.
If something isn't in here, Suzzie Q cannot mention it — that's deliberate, and it's
what stops the AI inventing places that don't exist.

Work in a spreadsheet (Google Sheets or Excel), then export as CSV and save it as
`data/listings.csv`. Start from `data/listings-template.csv` and delete the SAMPLE rows.

## Columns

| Column | Required | What to put |
|---|---|---|
| `id` | yes | A unique code you make up, e.g. `msn_0001`. Never reuse or change one. |
| `type` | yes | One of: `practitioner`, `event`, `community`, `venue`, `business`, `nonprofit` |
| `name` | yes | What a member would recognise. No marketing slogans. |
| `active` | yes | `yes` while it's running, `no` when it closes. Set `no` rather than deleting the row. |
| `categories` | yes | Separate with `;` — e.g. `yoga;movement;stress`. See the list below. |
| `format` | yes | `in_person`, `online` or `hybrid` |
| `city`, `state` | for in-person | e.g. `Jersey City`, `NJ` |
| `address` | helpful | Full street address, in quotes if it contains commas |
| `priceUsd` | helpful | `0` for free. Leave blank if it varies. |
| `schedule` | helpful | Plain words: `Tuesdays 6:30pm`, `By appointment` |
| `bookingUrl` | helpful | Where a member goes to sign up |
| `phone`, `contactEmail` | helpful | Public contact details only |
| `languages` | helpful | `english;spanish` |
| `accessibility` | helpful | `wheelchair accessible`, `step-free`, `captions available` |
| `summary` | helpful | One or two plain sentences. What happens, who it suits. |
| `verified` | yes | `yes` only if MSN has actually checked this organisation |
| `source` | yes | `msn_curated`, `partner_claimed` or `public_open_data` |
| `lastCheckedAt` | yes | Date you last confirmed it's real and running: `2026-09-21` |

## Categories to use

`community`, `belonging`, `peer_support`, `social`, `movement`, `yoga`, `outdoors`,
`breathwork`, `meditation`, `stress`, `rest`, `classes`, `volunteering`, `creative`,
`nutrition`, `nature`

Add new ones if you need them — keep them lowercase, one word where possible.

## Rules that matter

1. **Only list what exists.** Every row should be something you could phone today.
2. **`verified` means MSN vouches for it.** Public listings pulled from open data are
   `public_open_data`, `verified: no`, and the app labels them differently. The loader
   forces this, so a public row cannot mark itself verified.
3. **Keep `lastCheckedAt` current.** Public listings are dropped automatically after
   90 days without a re-check, so nobody is sent somewhere that has closed.
4. **Closed something? Set `active` to `no`.** Don't delete the row — the id may be
   referenced elsewhere.
5. **No clinical claims in `summary`.** "Gentle movement class" is fine.
   "Helps with depression" is not.

## Loading it

Save the file as `data/listings.csv`, then:

```
npm run dev
```

The server prints how many listings loaded and lists any rows it had to skip, with the
row number and what was wrong. Fix those rows and restart. If there's no
`data/listings.csv`, the demo falls back to the built-in sample listings.

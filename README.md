# Suzzie Q

My Source Network's wellness navigator — an agent that helps someone who feels
lonely, stressed or stuck find real people, groups and services near them.

It is **not** a therapist, a diagnosis tool or an open-ended chatbot. It finds real
things in a real catalog, checks for safety before every answer, and says plainly
when it doesn't know.

Launch market: **US**.

---

## Requirements

- **Node.js 20 or newer** — check with `node -v`
- About **1GB of free disk** for the downloaded data
- An internet connection for the one-off data downloads

No API key. No cloud account. No database to set up. Everything runs on your machine.

---

## Quick start

### 1. Install

```bash
npm install
```

### 2. Check it works

```bash
npm test
```

You should see **75 passed**. These tests cover the safety rules, so if they fail,
stop and fix that before anything else.

### 3. Download the US location data (~1 minute, once)

```bash
npm run fetch:zips
```

Downloads 41,488 US ZIP codes with map coordinates into `data/us-zips.csv`.
Without this, "near me" falls back to matching city names as text.

### 4. Import real listings (~5 minutes)

```bash
npm run import:nonprofits -- --states NJ,NY
```

Scans about 2 million US organisations from public IRS data and keeps the ones a
member could actually turn up to — community groups, recreation, arts, peer
support, food programmes. Roughly 48,000 for NJ and NY.

Use any state codes you like, or leave off `--states` for the whole country
(much slower, and the files are ~340MB).

### 5. Import support services (~1 minute)

```bash
npm run import:samhsa -- --states NJ,NY
```

Mental health and substance use services from SAMHSA's national directories,
with phone numbers. These are marked as clinical and stay hidden unless a member
asks for professional help.

### 6. Build the meaning index (10–25 minutes)

```bash
npm run build:embeddings
```

Downloads a small language model (~23MB, once) and turns every listing into a
vector so the agent can match on meaning rather than keywords. Leave it running —
it prints a progress counter.

### 7. Start it

```bash
npm run dev
```

Open **http://localhost:5173**.

---

## Try these

| Type this | What should happen |
|---|---|
| `find yoga in Jersey City` | Real places, with distance and a reason on each card |
| `i feel lonely near 07306` | Asks **one** question — click "Just show me what you have" |
| `just go with this` | Proceeds anyway, and says what it assumed |
| `yoga in Bozeman` | Nothing nearby → offers online options and says so |
| `i have a severe headache` | Boundary: no cause, no treatment, offers a consultant |
| `worst headache of my life` | Urgent care message, **zero** listings |
| `i want to find a counsellor` | Now treatment facilities appear |

The microphone button works in Chrome and Edge. Speech is turned into text in the
browser, so the audio never leaves the machine.

---

## All commands

| Command | What it does | How often |
|---|---|---|
| `npm test` | Runs 75 tests | Every change |
| `npm run typecheck` | Checks types | Every change |
| `npm run dev` | Starts the demo on port 5173 | — |
| `npm run fetch:zips` | US ZIP codes and coordinates | Twice a year |
| `npm run import:nonprofits` | Community organisations from IRS data | Quarterly |
| `npm run import:samhsa` | Mental health and substance use services | Yearly |
| `npm run build:embeddings` | Rebuilds the meaning index | After any import |

**Order matters:** imports first, then `build:embeddings`, then `dev`. The index is
built from the catalog files, so importing without rebuilding leaves the agent
searching old data.

---

## How it works

**Preparing the catalog** (the commands above): download public data, filter out
anything nobody can visit, place each listing on the map, and give it a meaning
vector.

**Answering one message** — seven steps, in this order, every time:

1. **Safety check** — rules, before anything else
2. **Pick a mode** — discovery, platform help, clinical boundary, urgent, crisis, or silence
3. **Read the request** — activity, place, date, budget
4. **Resolve the location** — ZIP or city becomes coordinates
5. **Search** — filter by distance, price and format, then rank by meaning
6. **Write the reply**
7. **Validate** — re-check every listing against the catalog before it is shown

Steps 1, 2, 5 and 7 are ordinary code with tests. The model only does 3 and 6, and
if it fails the agent still answers in plainer words.

---

## Project layout

```
src/
  types.ts                 request and response schemas (Zod); the invariants live here
  agent/orchestrator.ts    the seven-step loop — every surface calls this
  agent/clarify.ts         one-question rule and "just go with this"
  safety/classifier.ts     risk levels: none → symptom → clinical → urgent → crisis
  safety/content.ts        crisis and boundary copy. CRISIS_CONTENT_APPROVED = false
  discovery/repository.ts  distance search, ranking, trust rules
  discovery/csvLoader.ts   loads catalog files, validates every row
  discovery/embeddings.ts  local model, vector index, relevance floor
  discovery/ntee.ts        which IRS categories become listings
  discovery/samhsa.ts      treatment facilities, marked clinical_service
  geo/zip.ts               ZIP/city lookup and distance, all 50 states
  llm/adapter.ts           provider-agnostic model interface + fallback
  memory/store.ts          consent-gated memory, per user, refuses health content
  server.ts                dev server; one endpoint, POST /api/ask

scripts/                   the data pipeline (fetch, import, build)
data/                      downloaded and generated — not in git, rebuild with the commands
docs/catalog-guide.md      instructions for whoever maintains MSN's own listings
tests/                     75 tests
```

---

## The rules the code enforces

1. **Safety is checked on every message**, before anything else runs.
2. **Severity beats intent.** "Find yoga, I want to end my life" is a crisis, not a search.
3. **No diagnosis, no treatment advice.** Physical symptoms get a boundary and a
   consultant. Red-flag descriptions get an urgent-care message and no listings.
4. **The agent cannot invent a place.** Every result is re-checked against the
   catalog before it reaches the screen.
5. **Two trust levels.** MSN's own listings can be verified; imported public data
   never is, ranks lower, and says "not checked by MSN" on the card.
6. **Public listings expire** after 90 days without a re-check.
7. **Clinical services stay hidden** unless someone asks for professional help.
8. **Memory needs consent**, is sealed per user, refuses health content, and is
   deleted when consent is withdrawn.
9. **It degrades, never breaks.** Model down? Plainer words. No index? Keyword search.
   Nothing nearby? Online options, and it says so.

---

## Where the data comes from

| Source | What it gives | Licence |
|---|---|---|
| [IRS Exempt Organizations file](https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf) | US nonprofits: name, address, category | US government, public domain |
| [SAMHSA national directories](https://www.samhsa.gov/data/data-we-collect/n-sumhss-national-substance-use-and-mental-health-services-survey/national-directories) | Treatment and support services with phone | Public domain |
| [GeoNames postal codes](https://download.geonames.org/export/zip/) | ZIP → coordinates | CC BY 4.0 — **credit required in the app** |
| all-MiniLM-L6-v2 | Meaning matching, runs locally | Apache 2.0 |

Nothing is scraped. Meetup, Eventbrite and Psychology Today are deliberately not
used — their terms forbid it.

**Attribution note:** the app must display *"ZIP data © GeoNames, CC BY 4.0"* wherever
the data is used. This is a licence condition, not optional.

---

## Troubleshooting

**`import failed — fetch failed`**
The IRS server dropped the connection. The importer retries three times; run it
again. If it fails every time, your old `data/listings-public.csv` is untouched and
still in use — the message says so.

**`no data/us-zips.csv`**
Run `npm run fetch:zips`. Until then, location matching is text-only.

**`no meaning index`**
Run `npm run build:embeddings`. Until then, search falls back to keywords and
results will be noticeably worse.

**`build:embeddings` fails mentioning @xenova**
Run `npm i @xenova/transformers`, then try again.

**Results look irrelevant after an import**
Rebuild the index: `npm run build:embeddings`. The index is built from the catalog
files, so a new import without a rebuild means the agent is searching the old set.

**Port 5173 already in use**
`PORT=5174 npm run dev`

---

## Not finished yet

- **`CRISIS_CONTENT_APPROVED = false`** in `src/safety/content.ts`. The engine
  refuses to start in production until someone qualified signs off the crisis
  wording and the US resource list. **This is a launch blocker, by design.**
- **No MSN catalog yet.** Everything shown is public data. The template is at
  `data/listings-template.csv` and the instructions at `docs/catalog-guide.md`.
- **Memory is built but not switched on** — the founder's PRD lists persistent
  memory as needing a separate written decision.
- **The safety classifier needs typo tolerance** and a trained model alongside the
  rules before any real user sees it.
- **No database yet.** Catalog files are CSV; Postgres comes with the production build.

---

## For the catalog owner

If you maintain MSN's listings, you don't need any of the above. Read
`docs/catalog-guide.md`, fill in a copy of `data/listings-template.csv`, save it as
`data/listings.csv`, and hand it to the engineer. Your listings always rank above
imported public data.

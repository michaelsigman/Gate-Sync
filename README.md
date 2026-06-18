# BookedUp Gate-Sync

Adds guest **driver names** to security gates automatically, pulled from
**Hostfully** reservation notes. Runs daily, processing reservations that
**arrive tomorrow**. Supports two gate systems:

| Gate | Properties | Mechanism | Auth |
|------|-----------|-----------|------|
| **Proptia** | 4 | HTML form (scrape CSRF + submit) | Django session cookie |
| **GoAccessControl** | 1 | REST API (`POST /api/v1/visitors`) | Supabase bearer token |

The right adapter is chosen per-property by the `gate` field in
`src/propertyMap.js`. Both share one notes parser and one Hostfully fetch.

GoAccess is a clean API and returns a **PIN** per guest (logged in the run
output) — you could later relay these to guests. Proptia is unofficial session
automation; treat it as more fragile.

---

## What it does, each run

1. Asks Hostfully for reservations arriving **tomorrow**.
2. Keeps only properties in `src/propertyMap.js` (others skipped).
3. Parses each reservation's notes for the
   `Drivers Names to be added to security gate:` block. The block is often
   **appended multiple times** as the guest edits check-in — we take the
   **latest** list (longest as fallback) and **dedupe**.
4. Routes each guest to the property's gate adapter and adds a guest pass for
   the stay dates — or, in **dry-run**, logs what it *would* add.
5. In live mode, checks who's **already on the gate** first to avoid duplicates.

---

## Safety: dry-run is the default

`DRY_RUN` defaults to `true`. Nothing is written until you set `DRY_RUN=false`.
Run in dry-run for a few days, confirm the output, then flip it.

---

## One-time setup per property

### Assisted mapping helper (recommended)
```bash
npm run map
```
Logs into GoAccess, reads your households **with their addresses**, pulls your
Hostfully properties, and **suggests** an address match for each — with a
confidence label and the runner-up shown. You confirm each (`y` / pick another /
skip); nothing is written until you do. A wrong match would add guests to a
**stranger's** gate, so confirmation is required by design. Output goes to
`gate_property_map.json`, which `propertyMap.js` loads automatically if present.

> GoAccess exposes address in `GET /api/v1/residents/{id}` → `household_info[]`
> (`household_id`, `community_id`, `address`). The login token carries no address,
> so the helper makes that second call. Proptia has no address payload, so the
> helper writes 4 Proptia stubs to fill in manually.

### Proptia properties (×4) — manual
From the **Add Guest** page URL in Proptia:
```
/en-us/resident/resident/{MEMBER_ID}/visitors/{COMMUNITY_ID}/add/{PROPERTY_ID}/{UNIT_ID}
```
`passName` = the UUID of the temporary **GUEST** pass option.

### GoAccess property (×1)
Auto-mapped by the helper, or hardcode: `communityId` 12, `householdId` 44928,
`residentId` 0fac128a-…, Guest `visitorTypeId` cd2ad43d-….

> In production, move this map to Firestore (`gate_property_map`).

---

## Configure

Copy `.env.example` to `.env`:
- `PROPTIA_USERNAME` / `PROPTIA_PASSWORD` — the single Proptia login.
- `GOACCESS_USERNAME` / `GOACCESS_PASSWORD` — the GoAccess login.
- `GOACCESS_ANON_KEY` — Supabase publishable key (the `apikey` header on the
  login request; safe to ship).
- `HOSTFULLY_API_KEY` / `HOSTFULLY_AGENCY_UID` — reuse your webhook receiver's.
- `CRON_SCHEDULE` — default `0 16 * * *` (16:00 UTC ≈ 8–9am Pacific).

---

## Run

```bash
npm install
npm run test-parser   # sanity-check the notes parser
npm run run-once      # one full pass (respects DRY_RUN)
npm start             # server + daily cron + POST /run
```

Manual trigger: `POST /run?token=YOUR_RUN_TOKEN`.

---

## Deploy on Render

New Web Service, Node, start command `npm start`. Set env vars (keep
`DRY_RUN=true` initially). Built-in cron handles the daily run.

---

## Verify before going live

1. **Proptia login** — Django defaults assumed (`/en-us/login/`,
   `username`/`password`). If login fails, capture a login HAR and adjust
   `proptiaClient.login()`. (Your captured HAR was already logged in, so the
   login request itself wasn't recorded.)
2. **GoAccess anon key** — set `GOACCESS_ANON_KEY` from the login request's
   `apikey` header (stripped from the HAR export).
3. **GoAccess dedupe** — `listVisitors()` assumes the resident endpoint returns
   household visitors; confirm the response shape and tune the path if needed.
   (Adding still works regardless; this only affects duplicate-skipping.)
4. **Hostfully reservation shape** — align `hostfullyClient.js` with the exact
   endpoint your receiver already uses.
5. **ToS** — Proptia is unofficial automation; confirm it's acceptable for your
   HOA arrangement. GoAccess is a real API but still confirm authorized use.

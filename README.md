# BookedUp Gate-Sync (Gate Pilot)

Adds guest **driver names** to community security gates. Guests submit names in
ArrivalPilot's "Vehicle & gate registration" step. ArrivalPilot syncs the Hospitable
reservations, and gate-sync reads them through ArrivalPilot's read-only `gateSyncFeed`.
Live at **https://gate-sync.onrender.com** (Render). Supports two gate systems:

| Gate | Properties | Mechanism | Auth |
|------|-----------|-----------|------|
| **Proptia** | 4 | HTML form (scrape CSRF + submit) | Django session cookie |
| **GoAccessControl** | 1 | REST API (`POST /api/v1/visitors`) | Supabase bearer token |

The right adapter is chosen per-property by the `gate` field in
`gate_property_map.json`. Hostfully notes remain only as a legacy fallback
(`RESERVATION_SOURCE=hostfully`). Hostfully stays are never eligible for automation.

GoAccess is a clean API and returns a **PIN** per guest (logged in the run
output) — you could later relay these to guests. Proptia is unofficial session
automation; treat it as more fragile.

---

## What it does, each sweep

A sweep runs every 15 minutes, and also when ArrivalPilot reports a guest submission.

1. Reads stays that overlap today → +14 days (Pacific time) from `gateSyncFeed`.
   The feed only contains Gate Pilot homes. Guests already in-house are included.
2. Skips anything not eligible (`src/gatePolicy.js`). An eligible stay's property has a
   fully configured gate in `gate_property_map.json`, and the stay came from the feed.
3. Uses the guest-submitted drivers. Legacy Hostfully notes blocks are still parsed.
4. Checks each property's `mode` (`off` | `preview` | `live`):
   - In preview it only logs `WOULD ADD …`.
   - It writes only when `AUTO_ADD=true`, `DRY_RUN=false` and the mode is `live`.
5. Before a live write it re-reads the gate. Passes run from the day before check-in
   through checkout + 1. Limits: 25 writes per run, 3 attempts per name.
6. Reports results and the run record to ArrivalPilot (`gateSyncReport`). Emails
   failures through SendGrid when configured.

---

## Safety: dry-run is the default

Any value except exactly `DRY_RUN=false` means preview. That applies to the sweep **and**
the dashboard's "Add to gate". Automatic writes also need `AUTO_ADD=true` and a property
with `mode: "live"`. A missing setting always means "don't write".

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
- `AP_FEED_URL` / `GATE_SYNC_TOKEN`: the ArrivalPilot feed and the shared bearer token.
- `UI_TOKEN`: required. Without it the API refuses every call (`ALLOW_OPEN_UI=true` for local dev only).
- `AUTO_ADD`, `SWEEP_CRON` (default every 15 min), `SWEEP_MAX_ADDS`, `MAX_ADD_ATTEMPTS`.
- `SENDGRID_API_KEY` / `ALERT_EMAIL_FROM`: failure email (optional).
- See `.env.example` for the full list.

---

## Run

```bash
npm install
npm run test-parser   # sanity-check the notes parser
npm run run-once      # one sweep (same controls as the scheduled one)
npm start             # server + 15-min sweep + POST /run
```

Manual sweep: `POST /run` with header `x-ui-token: <UI_TOKEN>`.

---

## Deploy on Render

The live service is **https://gate-sync.onrender.com**, and it auto-deploys from `main`.
See DEPLOY.md for the env vars. The sweep runs inside the service, so there's no separate cron job.

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

# Deploying Gate Sync

Three stages: run it locally, push to GitHub, deploy on Render. The app stays in
**dry-run** the whole way through — it won't create real gate passes until you
deliberately switch it to live.

---

## 1. Run locally (your PC / WSL2 Ubuntu)

```bash
# from the unzipped gate-sync folder
npm install
cp .env.example .env
```

Open `.env` and fill in what you have. To just see the **UI and parser** working,
you don't need any credentials yet — leave them blank and the dry-run preview and
the "paste notes" tester both work. To pull real arrivals, add your Hostfully key.

Start it:

```bash
npm start
```

Open http://localhost:3000

What you can do immediately:
- **Paste notes tester** (bottom of page) — paste a reservation's notes, see the
  driver names parsed. No credentials needed.
- **Load arrivals** — needs `HOSTFULLY_API_KEY` + `HOSTFULLY_AGENCY_UID`. Lists
  tomorrow's arrivals, shows which map to a gate, and the names per reservation.
- **Preview add** (dry-run) — shows exactly who would be added. Nothing is sent.

Keep the mode switch on **Dry-run** while testing.

---

## 2. Map your properties (one time)

```bash
npm run map
```

This logs into GoAccess, reads your households with addresses, pulls your
Hostfully properties, and suggests a match for each. You confirm each one. It
writes `gate_property_map.json` (git-ignored — it's just local config).

For the 4 Proptia properties, open each one's **Add Guest** page in Proptia and
copy the five UUIDs from the URL into `gate_property_map.json`.

Re-run `npm start` and your real properties now appear in the UI.

---

## 3. Push to a new GitHub repo

```bash
git init
git add .
git commit -m "BookedUp gate-sync: Proptia + GoAccess guest automation"
```

Create an empty repo on GitHub (no README), then:

```bash
git remote add origin git@github.com:michaelsigman/gate-sync.git
git branch -M main
git push -u origin main
```

`.env` and `gate_property_map.json` are git-ignored, so **no secrets get
committed**. Verify with `git status` before pushing — neither should be listed.

---

## 4. Deploy on Render

1. Render dashboard → **New** → **Web Service** → connect the GitHub repo.
2. Render reads `render.yaml` automatically (runtime Node, `npm install`,
   `npm start`).
3. Set the secret env vars (the ones marked `sync: false`):
   - Proptia and GoAccess logins, `GOACCESS_ANON_KEY`, `GOACCESS_RESIDENT_ID`
   - `GATE_SYNC_TOKEN`: the same value as ArrivalPilot's Secret Manager `GATE_SYNC_TOKEN`
   - `UI_TOKEN`: **required**. Without it the API refuses every request.
4. For stage 1 (preview) keep **`DRY_RUN=true`** and `AUTO_ADD=true`, and set
   `AP_FEED_URL=https://us-west1-arrival-pilot-dev.cloudfunctions.net/gateSyncFeed`.
5. The service is **https://gate-sync.onrender.com**, and it auto-deploys from `main`.
   - The Blueprint's service `name` is `bookedup-gate-sync`, but the live host is `gate-sync`.
   - Set ArrivalPilot's `GATE_SYNC_NOTIFY_URL` to `https://gate-sync.onrender.com/api/hooks/gate-submitted`.

The 15-minute sweep runs inside the service. In preview it logs `WOULD ADD …` lines to the
Render logs, and sends each run record to ArrivalPilot (`gateSyncRuns`). The last run is
also shown on `/api/status`.

> `gate_property_map.json` **is** committed, and it's what Render uses. It includes each
> property's `mode` (`off` | `preview` | `live`).

---

## 5. Going live (when you're ready)

First compare the `WOULD ADD` lists with what the team adds by hand. Then:

- **Stage 2 (one home):** set that property's `mode` to `"live"` in `gate_property_map.json`
  (commit, then deploy), and set `DRY_RUN=false` in Render. Other homes stay in `preview`.
- **Stage 3:** set the remaining homes to `"live"`.
- `DRY_RUN=false` also lets the dashboard's **Add to gate** write for Gate Pilot homes (after
  Settings → Live and a confirmation). While `DRY_RUN=true`, Add to gate is preview-only.

GoAccess returns a **PIN** for each guest (shown in the UI and logs) — useful if
you later want to text it to guests.

---

## Protecting the UI

`UI_TOKEN` is required. Without it every `/api/*` call returns 503 (local dev can set
`ALLOW_OPEN_UI=true`).

- **Dashboard:** open it once as `https://gate-sync.onrender.com/?token=YOUR_TOKEN`. The page
  keeps the token for that tab and removes it from the address bar.
- **ArrivalPilot hook:** uses its own `Authorization: Bearer <GATE_SYNC_TOKEN>`.
- **Debug endpoints:** `/api/debug/*-add-test` create real passes, so they stay disabled
  unless `ENABLE_DEBUG_WRITES=true`.

---

## Toward the guest portal

The API is intentionally simple (`/api/arrivals`, `/api/parse`, `/api/process`)
so the same backend can later serve your guest portal instead of this standalone
page. The gate adapters (`proptiaClient`, `goAccessClient`) and the orchestrator
don't change — only the front end does.

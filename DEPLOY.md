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
3. Set the secret env vars (the ones marked `sync: false`): Proptia and GoAccess
   logins, `GOACCESS_ANON_KEY`, `GOACCESS_RESIDENT_ID`, Hostfully key + agency,
   and a `UI_TOKEN` to password-protect the page.
4. Leave **`DRY_RUN=true`** for now.
5. Deploy. Your service is at `https://bookedup-gate-sync.onrender.com`.

The daily cron runs inside the service (default 16:00 UTC ≈ 8–9am Pacific) and
processes tomorrow's arrivals. While `DRY_RUN=true`, it only logs intentions —
check the Render logs to see what it *would* do each morning.

> `gate_property_map.json` isn't committed, so on Render either (a) add your
> mappings to `src/propertyMap.js` defaults and commit that, or (b) move the map
> to Firestore (recommended next step — then onboarding a property is just a
> confirm-and-save, no redeploy).

---

## 5. Going live (when you're ready)

After a few days of watching dry-run output and confirming it's adding the right
people to the right gates:

- In the **UI**: flip the mode switch to **Live**, then use **Add to gate** per
  reservation. You'll get a confirmation prompt each time.
- For the **automatic daily cron**: set `DRY_RUN=false` in Render env and
  redeploy.

GoAccess returns a **PIN** for each guest (shown in the UI and logs) — useful if
you later want to text it to guests.

---

## Protecting the UI

Set `UI_TOKEN` to any string. Then the page and API require it:
`https://…onrender.com/?token=YOUR_TOKEN`. Without `UI_TOKEN` set, the UI is open
to anyone with the URL — fine for local, not for a public Render URL.

---

## Toward the guest portal

The API is intentionally simple (`/api/arrivals`, `/api/parse`, `/api/process`)
so the same backend can later serve your guest portal instead of this standalone
page. The gate adapters (`proptiaClient`, `goAccessClient`) and the orchestrator
don't change — only the front end does.

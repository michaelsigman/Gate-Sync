'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { run, processReservation, makeGateManager } = require('./orchestrator');
const { HostfullyClient } = require('./hostfullyClient');
const { parseGateNames } = require('./parseNotes');
const propertyMap = require('./propertyMap');
const store = require('./store');
const gateCache = require('./gateCache');
const { getGateTargets, nameKey } = require('./orchestrator');

const app = express();
const PORT = process.env.PORT || 3000;
const DRY_RUN = String(process.env.DRY_RUN).toLowerCase() !== 'false';

// Gate reads for the dashboard go through ./gateCache (one login per vendor per
// 15 min, shared by every viewer). Writes (/api/process, cron) are unchanged.

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Optional shared-secret gate for the UI/API. Set UI_TOKEN in env to require it.
function checkToken(req, res, next) {
  const need = process.env.UI_TOKEN;
  if (!need) return next();
  const got = req.get('x-ui-token') || req.query.token;
  if (got === need) return next();
  return res.status(403).json({ error: 'forbidden' });
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Controlled single live add: one test guest to a GoAccess property ---
// POST /api/debug/goaccess-add-test?propertyUid=...  (creates ONE real pass)
app.post('/api/debug/goaccess-add-test', checkToken, async (req, res) => {
  try {
    const propertyUid = req.query.propertyUid;
    const prop = propertyUid && propertyMap[propertyUid];
    if (!prop) return res.status(404).json({ error: 'property not mapped' });

    const { getGateTargets, makeGateManager } = require('./orchestrator');
    const target = getGateTargets(prop).find((t) => t.gate === 'goaccess');
    if (!target) return res.status(400).json({ error: 'no goaccess gate on this property' });

    const gates = makeGateManager(console, { login: true });
    const client = await gates.get('goaccess');

    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const startISO = `${today.toISOString().slice(0, 10)}T07:00:00.000Z`;
    const endNext = new Date(tomorrow); endNext.setDate(endNext.getDate() + 1);
    const endISO = `${endNext.toISOString().slice(0, 10)}T06:59:59.999Z`;

    const guest = {
      firstName: req.query.first || 'Zzztest',
      lastName: req.query.last || 'Deleteme',
    };
    const r = await client.addGuest(target.config, guest, { startISO, endISO });
    res.json({
      added: r.ok,
      httpStatus: r.status,
      pin: r.pin || null,
      guest: `${guest.firstName} ${guest.lastName}`,
      gate: target.label,
      note: 'Check GoAccess portal for this guest, then delete it.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message, body: e.response?.data });
  }
});

// --- Controlled single live add: one test guest to one Proptia property ---
// POST /api/debug/proptia-add-test?propertyUid=...  (creates ONE real pass)
app.post('/api/debug/proptia-add-test', checkToken, async (req, res) => {
  try {
    const propertyUid = req.query.propertyUid;
    const prop = propertyUid && propertyMap[propertyUid];
    if (!prop) return res.status(404).json({ error: 'property not mapped' });

    const { getGateTargets, makeGateManager, fmtMMDDYYYY } = require('./orchestrator');
    const target = getGateTargets(prop).find((t) => t.gate === 'proptia');
    if (!target) return res.status(400).json({ error: 'no proptia gate on this property' });

    const gates = makeGateManager(console, { login: true });
    const client = await gates.get('proptia');

    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const guest = {
      firstName: req.query.first || 'Zzztest',
      lastName: req.query.last || 'Deleteme',
    };
    const r = await client.addGuest(target.config, guest, {
      arrivalMMDDYYYY: fmtMMDDYYYY(today),
      departureMMDDYYYY: fmtMMDDYYYY(tomorrow),
    });
    res.json({
      added: r.ok,
      httpStatus: r.status,
      guest: `${guest.firstName} ${guest.lastName}`,
      gate: target.label,
      note: 'Check Proptia portal for this guest, then delete it.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Test Proptia login in isolation (no gate write) ---
app.get('/api/debug/proptia-login', checkToken, async (req, res) => {
  try {
    const { ProptiaClient } = require('./proptiaClient');
    const client = new ProptiaClient({
      username: process.env.PROPTIA_USERNAME,
      password: process.env.PROPTIA_PASSWORD,
      logger: console,
    });
    await client.login();
    // If login throws, we never get here. Optionally verify we can read a
    // property's visitor list (proves the session is truly authenticated).
    let listCheck = 'skipped';
    const testProp = req.query.propertyUid && propertyMap[req.query.propertyUid];
    if (testProp) {
      const { getGateTargets } = require('./orchestrator');
      const t = getGateTargets(testProp).find((x) => x.gate === 'proptia');
      if (t) {
        try {
          const visitors = await client.listVisitors(t.config);
          listCheck = `ok — read ${visitors.length} existing visitor(s) for ${t.label}`;
        } catch (e) {
          listCheck = 'login ok, but visitor-list read failed: ' + e.message;
        }
      }
    }
    res.json({ login: 'success', listCheck });
  } catch (e) {
    res.status(500).json({ login: 'FAILED', error: e.message });
  }
});

// --- Find a confirmed booking and reveal where notes/driver-names live ---
// ?from=YYYY-MM-DD&to=YYYY-MM-DD  — scans bookings and dumps text-bearing fields.
app.get('/api/debug/booking', checkToken, async (req, res) => {
  try {
    const axios = require('axios');
    const http = axios.create({
      baseURL: 'https://api.hostfully.com/api/v3',
      headers: { 'X-HOSTFULLY-APIKEY': process.env.HOSTFULLY_API_KEY, Accept: 'application/json' },
      timeout: 20000,
    });
    const from = req.query.from || isoOffset(new Date(), -7);
    const to = req.query.to || isoOffset(new Date(), 60);
    const r = await http.get('/leads', {
      params: { agencyUid: process.env.HOSTFULLY_AGENCY_UID, checkInFrom: from, checkInTo: to, _limit: 50 },
    });
    const leads = r.data?.leads || [];
    // Keep only real, active guest bookings — exclude inquiries, blocks,
    // cancelled, and declined.
    const DEAD = ['CANCELLED', 'DECLINED', 'BLOCKED', 'EXPIRED', 'IGNORED'];
    const bookings = leads.filter((l) => {
      const t = (l.type || '').toUpperCase();
      const s = (l.status || '').toUpperCase();
      return t === 'BOOKING' && !DEAD.includes(s);
    });

    // Show notes + extraNotes in full, and flag which contain the gate block.
    const GATE = /Drivers?\s+Names?\s+to\s+be\s+added/i;
    const sample = bookings.slice(0, 8).map((l) => ({
      uid: l.uid,
      status: l.status,
      checkIn: (l.checkInLocalDateTime || '').slice(0, 10),
      notes: l.notes || '',
      extraNotes: l.extraNotes || '',
      hasGateBlock: GATE.test(l.notes || '') || GATE.test(l.extraNotes || ''),
    }));

    res.json({
      window: { from, to },
      totalLeads: leads.length,
      bookingCount: bookings.length,
      withGateBlock: sample.filter((s) => s.hasGateBlock).length,
      sample,
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message, body: e.response?.data });
  }
});

// --- Probe: try several call variants, capture RAW text exactly as returned ---
// Tells us which combination actually returns data for this account.
app.get('/api/debug/probe', checkToken, async (req, res) => {
  const axios = require('axios');
  const key = process.env.HOSTFULLY_API_KEY;
  const agency = process.env.HOSTFULLY_AGENCY_UID;

  const variants = [
    { label: 'v3 /leads agencyUid only',
      url: 'https://api.hostfully.com/api/v3/leads', params: { agencyUid: agency, _limit: 3 } },
    { label: 'v3.3 /leads agencyUid only',
      url: 'https://api.hostfully.com/api/v3.3/leads', params: { agencyUid: agency, _limit: 3 } },
    { label: 'v3 /leads checkIn window',
      url: 'https://api.hostfully.com/api/v3/leads', params: { agencyUid: agency, checkInFrom: '2026-06-20', checkInTo: '2026-06-20', _limit: 3 } },
    { label: 'v3 /properties agencyUid only',
      url: 'https://api.hostfully.com/api/v3/properties', params: { agencyUid: agency, _limit: 3 } },
  ];

  const out = [];
  for (const v of variants) {
    try {
      const r = await axios.get(v.url, {
        params: v.params,
        headers: { 'X-HOSTFULLY-APIKEY': key, Accept: 'application/json' },
        timeout: 20000,
        transformResponse: [(d) => d], // keep RAW text, no auto-JSON
        validateStatus: () => true,
      });
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      out.push({
        variant: v.label,
        status: r.status,
        contentType: r.headers['content-type'] || null,
        bodyLength: text ? text.length : 0,
        bodyPreview: text ? text.slice(0, 400) : '(empty)',
      });
    } catch (e) {
      out.push({ variant: v.label, error: e.message, status: e.response?.status });
    }
  }
  res.json({ agencyUidUsed: agency ? agency.slice(0, 8) + '…' : '(missing)', results: out });
});

// --- Diagnostic: raw Hostfully lead shape for a given date range ---
// Use this once to confirm field names (where do the driver notes live?).
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (defaults to a wide window)
app.get('/api/debug/leads', checkToken, async (req, res) => {
  try {
    const today = new Date();
    const from = req.query.from || isoOffset(today, 0);
    const to = req.query.to || isoOffset(today, 30); // default: next 30 days
    const axios = require('axios');
    const http = axios.create({
      baseURL: 'https://api.hostfully.com/api/v3',
      headers: { 'X-HOSTFULLY-APIKEY': process.env.HOSTFULLY_API_KEY, Accept: 'application/json' },
      timeout: 20000,
    });
    const r = await http.get('/leads', {
      params: {
        agencyUid: process.env.HOSTFULLY_AGENCY_UID,
        checkInFrom: from,
        checkInTo: to,
        _limit: 10,
      },
    });
    const leads = r.data?.leads || r.data?.data || (Array.isArray(r.data) ? r.data : null);
    res.json({
      window: { from, to },
      httpStatus: r.status,
      contentType: r.headers['content-type'],
      envelopeKeys: r.data && typeof r.data === 'object' ? Object.keys(r.data) : typeof r.data,
      leadCount: Array.isArray(leads) ? leads.length : '(not an array — see raw)',
      firstLead: Array.isArray(leads) && leads[0] ? leads[0] : null,
      raw: r.data,
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      error: e.message,
      hostfullyStatus: e.response?.status,
      hostfullyBody: e.response?.data,
    });
  }
});

function isoOffset(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// --- Arrivals: shared enrichment (gate status comes from the shared cache) ---
// Hostfully range reads are cached briefly so many viewers = one PMS call.
const HOSTFULLY_CACHE_MS = 60 * 1000;
const _hostfullyCache = new Map(); // "from|to" -> { at, promise }
function reservationsInRange(from, to) {
  const k = `${from}|${to}`;
  const hit = _hostfullyCache.get(k);
  if (hit && Date.now() - hit.at < HOSTFULLY_CACHE_MS) return hit.promise;
  const hostfully = new HostfullyClient({
    apiKey: process.env.HOSTFULLY_API_KEY,
    agencyUid: process.env.HOSTFULLY_AGENCY_UID,
  });
  const promise = hostfully.getReservationsInRange(from, to);
  _hostfullyCache.set(k, { at: Date.now(), promise });
  promise.catch(() => _hostfullyCache.delete(k));
  return promise;
}

async function enrichReservation(r, prop, { checkGates = true } = {}) {
  const parsed = parseGateNames(r.notes);
  const targets = getGateTargets(prop);
  let latestAdd = null;
  const namesWithStatus = [];
  for (const n of parsed.names) {
    const key = nameKey(n.firstName, n.lastName);
    const onGates = {}; // label -> true(on) / false(not) / null(unknown)
    const addedAt = {}; // label -> ISO time WE added them (if we did)
    for (const t of targets) {
      if (checkGates) {
        const keys = await gateCache.keysFor(t);
        onGates[t.label] = keys === null ? null : keys.has(key);
        if (onGates[t.label]) store.resolveIfOnGate(r.reservationId, t.label, key);
      }
      const rec = store.addedFor(r.reservationId, t.label, key);
      if (rec) {
        addedAt[t.label] = rec.at;
        if (!latestAdd || rec.at > latestAdd) latestAdd = rec.at;
      }
    }
    namesWithStatus.push({ firstName: n.firstName, lastName: n.lastName, onGates, addedAt });
  }
  const failures = store.openFailuresFor(r.reservationId).map((f) => ({
    at: f.at, name: f.name, gate: f.gate, gateLabel: f.gateLabel, reason: f.reason, source: f.source,
  }));
  return {
    reservationId: r.reservationId,
    propertyUid: r.propertyUid,
    mapped: true,
    gates: targets.map((t) => ({ gate: t.gate, label: t.label, community: t.config.community || prop.community || null })),
    gateCount: targets.length,
    property: prop.label,
    community: prop.community || (targets[0] && targets[0].config.community) || null,
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    notes: r.notes,
    guest: parsed.guest,
    names: parsed.names,
    namesWithStatus,
    nameCount: parsed.names.length,
    // The parser always lists the booking guest first, so nameCount > 0 even when
    // no driver list was submitted. This says whether a driver list exists.
    hasDriverList: (parsed.blockCount || 0) > 0,
    gateCheck: checkGates,
    addedAt: latestAdd, // most recent time WE added anyone for this reservation
    failures,           // open (unresolved) gate-push failures
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// --- API: arrivals for one day (kept for compatibility) ---
app.get('/api/arrivals', checkToken, async (req, res) => {
  try {
    const day = req.query.date || tomorrowISO();
    if (!ISO_DAY.test(day)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    // Gate check is ON by default; pass ?checkGates=0 to skip.
    const checkGates = req.query.checkGates !== '0';
    const reservations = (await reservationsInRange(day, day)).filter((r) => (r.arrivalDate || '').startsWith(day));
    const enriched = [];
    for (const r of reservations) {
      const prop = propertyMap[r.propertyUid];
      if (prop) enriched.push(await enrichReservation(r, prop, { checkGates })); // mapped houses only
    }
    res.json({ date: day, count: enriched.length, reservations: enriched, gatesCheckedAt: gateCache.lastCheckedAt() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: arrivals for a date range in ONE call (dashboard list) ---
// GET /api/arrivals/range?from=YYYY-MM-DD&to=YYYY-MM-DD  (max 31 days)
app.get('/api/arrivals/range', checkToken, async (req, res) => {
  try {
    const from = req.query.from || isoOffset(new Date(), 0);
    const to = req.query.to || isoOffset(new Date(), 7);
    if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || to < from) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD with from <= to' });
    }
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 31) {
      return res.status(400).json({ error: 'range is limited to 31 days' });
    }
    const reservations = await reservationsInRange(from, to);
    const enriched = [];
    for (const r of reservations) {
      const day = (r.arrivalDate || '').slice(0, 10);
      if (day < from || day > to) continue;
      const prop = propertyMap[r.propertyUid];
      if (prop) enriched.push(await enrichReservation(r, prop));
    }
    enriched.sort((a, b) => (a.arrivalDate || '').localeCompare(b.arrivalDate || ''));
    res.json({ from, to, count: enriched.length, reservations: enriched, gatesCheckedAt: gateCache.lastCheckedAt() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: status bar + ops view. Read-only; never triggers a gate read. ---
app.get('/api/status', checkToken, (_req, res) => {
  const health = gateCache.health();
  const lastRun = store.runs(1)[0] || null;
  const byCommunity = new Map();
  for (const h of health) {
    // Until the map has community names, group by property (same fallback as the sync log).
    const name = h.community || h.property || 'Unnamed community';
    const c = byCommunity.get(name) || { community: name, named: !!h.community, gates: [], lastSync: null };
    c.gates.push({ gate: h.gate, label: h.label, checkedAt: h.checkedAt, error: h.error });
    byCommunity.set(name, c);
  }
  for (const rc of (lastRun && lastRun.communities) || []) {
    const c = byCommunity.get(rc.community);
    if (c) c.lastSync = rc;
  }
  const failures = store.recentFailures(50);
  res.json({
    serverMode: DRY_RUN ? 'preview-locked' : 'live-allowed',
    communities: byCommunity.size,
    communityResults: [...byCommunity.values()],
    lastSyncAt: lastRun ? lastRun.finishedAt || lastRun.startedAt : null,
    lastSync: lastRun,
    gatesCheckedAt: gateCache.lastCheckedAt(),
    gateCacheTtlMs: gateCache.TTL_MS,
    openFailures: failures.filter((f) => !f.resolvedAt).length,
    failures,
  });
});

// --- API: month calendar counts (fast, no gate login) ---
// Returns, per day in the given month, how many MAPPED reservations with at
// least one parsed name check in. Used by the calendar overview.
app.get('/api/calendar', checkToken, async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || now.getUTCMonth() + 1; // 1-12
    const pad = (n) => String(n).padStart(2, '0');
    const from = `${year}-${pad(month)}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${pad(month)}-${pad(lastDay)}`;

    const reservations = await reservationsInRange(from, to);

    // Per day: { all, some, none } counts of mapped reservations needing names.
    //   all  = every name already on every gate (done) -> green
    //   some = at least one name on a gate, but not all -> amber
    //   none = nobody added yet -> red
    const counts = {};
    for (const r of reservations) {
      const prop = propertyMap[r.propertyUid];
      if (!prop) continue; // mapped only
      const day = (r.arrivalDate || '').slice(0, 10);
      if (!day) continue;
      const parsed = parseGateNames(r.notes);
      if (parsed.names.length === 0) continue; // only reservations that need names
      const targets = getGateTargets(prop);

      // Across all (name × gate) slots, how many are already present?
      let totalSlots = 0;
      let filledSlots = 0;
      let anyUnknown = false;
      for (const t of targets) {
        const keys = await gateCache.keysFor(t);
        for (const n of parsed.names) {
          totalSlots += 1;
          if (keys === null) { anyUnknown = true; continue; }
          if (keys.has(nameKey(n.firstName, n.lastName))) filledSlots += 1;
        }
      }
      if (!counts[day]) counts[day] = { all: 0, some: 0, none: 0, unknown: 0 };
      if (anyUnknown && filledSlots === 0) counts[day].unknown += 1;
      else if (filledSlots === 0) counts[day].none += 1;
      else if (filledSlots >= totalSlots) counts[day].all += 1;
      else counts[day].some += 1;
    }
    res.json({ year, month, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: parse a pasted note (no PMS needed) ---
app.post('/api/parse', checkToken, (req, res) => {
  const parsed = parseGateNames(req.body.notes || '');
  res.json(parsed);
});

// --- API: process one reservation (dry-run or live) ---
app.post('/api/process', checkToken, async (req, res) => {
  try {
    const { reservation, dryRun = true, names } = req.body;
    // Master safety: if the server is set to DRY_RUN=true, force dry-run
    // regardless of what the UI toggle requested. This lets you hard-lock the
    // deployment to preview-only via env, independent of the (Live-default) UI.
    const serverForcesDry = String(process.env.DRY_RUN).toLowerCase() === 'true';
    const effectiveDryRun = serverForcesDry ? true : !!dryRun;
    if (!reservation || !reservation.propertyUid) {
      return res.status(400).json({ error: 'reservation with propertyUid required' });
    }
    const prop = propertyMap[reservation.propertyUid];
    if (!prop) return res.status(404).json({ error: 'property not mapped to a gate' });

    const { getGateTargets } = require('./orchestrator');
    const clients = {};
    if (!effectiveDryRun) {
      const gates = makeGateManager(console, { login: true });
      // Log in once per distinct gate vendor this property targets.
      const vendors = [...new Set(getGateTargets(prop).map((t) => t.gate))];
      for (const v of vendors) clients[v] = await gates.get(v);
    }
    const out = await processReservation({
      reservation,
      prop,
      clients,
      dryRun: effectiveDryRun,
      names: Array.isArray(names) ? names : undefined,
      source: 'manual',
    });
    // Tell the UI if the server overrode its request, so it can show a notice.
    if (serverForcesDry && !dryRun) out.serverForcedDryRun = true;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Manual full run (all arrivals) ---
app.post('/run', checkToken, async (_req, res) => {
  try {
    const result = await run();
    res.json({ ok: true, result });
  } catch (e) {
    store.recordRun({ startedAt: new Date().toISOString(), mode: DRY_RUN ? 'dry-run' : 'live', error: e.message, communities: [] });
    res.status(500).json({ ok: false, error: e.message });
  }
});

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Daily cron. Default 16:00 UTC (~8–9am Pacific). Override with CRON_SCHEDULE.
const schedule = process.env.CRON_SCHEDULE || '0 16 * * *';
cron.schedule(schedule, () => {
  console.log('[gate-sync] cron firing');
  run().catch((e) => {
    console.error('[gate-sync] cron error', e);
    store.recordRun({ startedAt: new Date().toISOString(), mode: DRY_RUN ? 'dry-run' : 'live', error: e.message, communities: [] });
  });
});

app.listen(PORT, () => {
  console.log(`[gate-sync] listening on ${PORT}; cron "${schedule}"`);
});

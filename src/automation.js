'use strict';

/**
 * Automatic adding: the 15-minute sweep, also run on a guest submission (/api/hooks/gate-submitted).
 *
 * A name is written to a gate only when ALL of these hold:
 *   - gatePolicy.eligibility: gate configured in gate-sync's map AND the stay came from the
 *     ArrivalPilot feed (Gate Pilot homes only)
 *   - the property's mode (gate_property_map.json "mode") is 'live'   (missing → 'off')
 *   - AUTO_ADD is exactly "true"                                        (missing → never writes)
 *   - DRY_RUN is exactly "false"                                        (missing → never writes)
 * Otherwise the sweep only logs what it WOULD add. Mode 'off' skips the property entirely.
 *
 * Window: stays overlapping today → today+SWEEP_DAYS_AHEAD (default 14), so in-house stays whose
 * names arrive late are covered. Dates are the property's local (Pacific) days.
 * Passes use the buffered window (day before check-in → checkout + 1), via orchestrator.addOne.
 *
 * Dedupe: the shared gate cache, our own "added at" records, and — right before any live write —
 * a fresh read of that gate. Retry cap: MAX_ADD_ATTEMPTS (default 3) failed attempts per name per
 * gate, then it stops and the alert says to add by hand. Per-run cap: SWEEP_MAX_ADDS (default 25).
 * Sweeps are serialized: a submission during a sweep waits for it.
 */

const propertyMap = require('./propertyMap');
const store = require('./store');
const gateCache = require('./gateCache');
const notify = require('./notify');
const apReport = require('./apReport');
const { makeSource, gateNamesFor } = require('./reservations');
const { eligibility } = require('./gatePolicy');
const orch = require('./orchestrator');

const MODES = ['off', 'preview', 'live'];
const TZ = process.env.PROPERTY_TZ || 'America/Los_Angeles';

function settings() {
  return {
    autoAdd: process.env.AUTO_ADD === 'true',
    dryRun: process.env.DRY_RUN !== 'false',
    daysAhead: Number(process.env.SWEEP_DAYS_AHEAD || 14),
    maxAddsPerRun: Number(process.env.SWEEP_MAX_ADDS || 25),
    maxAttempts: Number(process.env.MAX_ADD_ATTEMPTS || 3),
  };
}

function modeFor(prop) {
  const m = prop && prop.mode;
  return MODES.includes(m) ? m : 'off';
}

/** Modes of every mapped property, for /api/status. */
function modes() {
  return Object.entries(propertyMap).map(([uid, p]) => ({ propertyUid: uid, property: p.label, mode: modeFor(p) }));
}

function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Versions already reported to ArrivalPilot, so a steady state isn't re-reported every 15 min.
const reported = new Map(); // rid -> `${version}|${result}`

let chain = Promise.resolve();
let lastSweep = null;

/** Queue a sweep; resolves with its record. Never runs two at once. */
function runSweep(opts = {}) {
  const p = chain.then(() => sweep(opts));
  chain = p.catch(() => {});
  return p;
}

async function sweep({ trigger = 'cron', reservationId = null, logger = console } = {}) {
  const cfg = settings();
  const startedAt = new Date().toISOString();
  const from = localDay(0);
  const to = localDay(cfg.daysAhead);
  const counts = { stays: 0, eligible: 0, notEligible: 0, modeOff: 0, awaiting: 0, alreadyOnGate: 0, wouldAdd: 0, added: 0, failed: 0, deferred: 0, gaveUp: 0, unreadable: 0 };
  const perProperty = {};
  const wouldAdd = [];
  const newFailures = [];
  const reports = [];
  const clients = {};      // vendor -> client | Error (one login per vendor per sweep)
  let writes = 0;

  const bump = (prop, key, n = 1) => {
    const k = prop.label;
    const row = (perProperty[k] = perProperty[k] || { property: k, mode: modeFor(prop), community: orch.communityOf(prop), ...Object.fromEntries(Object.keys(counts).map((c) => [c, 0])) });
    row[key] += n;
    counts[key] += n;
  };

  async function clientFor(vendor) {
    if (!clients[vendor]) {
      try { clients[vendor] = await orch.makeGateManager(logger, { login: true }).get(vendor); }
      catch (e) { clients[vendor] = e; }
    }
    if (clients[vendor] instanceof Error) throw clients[vendor];
    return clients[vendor];
  }

  let stays = await makeSource().getReservationsInRange(from, to);
  if (reservationId) stays = stays.filter((r) => r.reservationId === reservationId);
  logger.info(`[sweep] ${trigger}: ${stays.length} stay(s) ${from}..${to} | AUTO_ADD=${cfg.autoAdd} DRY_RUN=${cfg.dryRun}${reservationId ? ' | only ' + reservationId : ''}`);

  for (const r of stays) {
    const prop = propertyMap[r.propertyUid];
    if (!prop) continue;
    counts.stays += 1;
    const elig = eligibility(r, prop);
    if (!elig.ok) { bump(prop, 'notEligible'); continue; }
    const mode = modeFor(prop);
    if (mode === 'off') { bump(prop, 'modeOff'); continue; }
    bump(prop, 'eligible');
    const live = mode === 'live' && cfg.autoAdd && !cfg.dryRun;

    const { names, source: nameSource } = gateNamesFor(r);
    if (!names.length) { bump(prop, 'awaiting'); continue; }

    let stayFailed = null;
    let stayAllOn = true;
    let stayChanged = false;

    for (const target of orch.getGateTargets(prop)) {
      let keys = await gateCache.keysFor(target);
      const pending = [];
      for (const n of names) {
        const key = orch.nameKey(n.firstName, n.lastName);
        if ((keys && keys.has(key)) || store.addedFor(r.reservationId, target.label, key)) {
          if (keys && keys.has(key)) store.resolveIfOnGate(r.reservationId, target.label, key);
          bump(prop, 'alreadyOnGate');
          continue;
        }
        const attempts = store.failedAttempts(r.reservationId, target.label, key);
        if (attempts >= cfg.maxAttempts) { bump(prop, 'gaveUp'); stayAllOn = false; stayFailed = stayFailed || 'retry limit reached'; continue; }
        pending.push({ n, key, attempts });
      }
      if (!pending.length) continue;
      stayAllOn = false;

      if (!live) {
        for (const { n } of pending) {
          const item = { reservationId: r.reservationId, property: prop.label, gate: target.gate, gateLabel: target.label,
            name: `${n.firstName} ${n.lastName}`.trim(), arrivalDate: r.arrivalDate, departureDate: r.departureDate,
            mode, why: mode !== 'live' ? 'property in preview' : !cfg.autoAdd ? 'AUTO_ADD off' : 'DRY_RUN on', gateVerified: keys !== null };
          wouldAdd.push(item);
          bump(prop, 'wouldAdd');
          logger.info(`[sweep] WOULD ADD ${item.name} → ${item.gateLabel} (${item.gate}) | ${item.property} | stay ${item.arrivalDate}→${item.departureDate} | ${item.why}${keys === null ? ' | gate list unreadable' : ''}`);
        }
        continue;
      }

      // Live: log in (once per vendor) and re-read this gate right before writing.
      let client;
      try {
        client = await clientFor(target.gate);
        const fresh = new Set(await client.listVisitors(target.config).then((vs) => vs.map((v) => (v.first_name !== undefined
          ? orch.nameKey(v.first_name, v.last_name)
          : orch.nameKey(String(v.name || '').trim().split(/\s+/)[0] || '', String(v.name || '').trim().split(/\s+/).slice(1).join(' '))))));
        keys = fresh;
      } catch (e) {
        for (const { n, key, attempts } of pending) failSlot(r, prop, target, n, key, attempts, `gate unavailable: ${e.message}`);
        bump(prop, 'unreadable');
        continue;
      }
      for (const { n, key, attempts } of pending) {
        if (keys.has(key)) { store.resolveIfOnGate(r.reservationId, target.label, key); bump(prop, 'alreadyOnGate'); continue; }
        if (writes >= cfg.maxAddsPerRun) { bump(prop, 'deferred'); continue; }
        writes += 1;
        const slot = orch.slotInfo(r, prop, target, n, key, 'sweep:' + trigger);
        try {
          const out = await orch.addOne(client, target.gate, target.config, n, r.arrivalDate, r.departureDate);
          if (out.ok) {
            orch.recordOutcome(slot, target, true, null);
            bump(prop, 'added');
            stayChanged = true;
            logger.info(`[sweep] ADDED ${slot.name} → ${target.label}`);
          } else {
            failSlot(r, prop, target, n, key, attempts, `gate returned status ${out.status}`, slot);
          }
        } catch (e) {
          failSlot(r, prop, target, n, key, attempts, e.message, slot);
        }
      }
    }

    function failSlot(res, p, target, n, key, attempts, reason, slot) {
      orch.recordOutcome(slot || orch.slotInfo(res, p, target, n, key, 'sweep:' + trigger), target, false, reason);
      bump(p, 'failed');
      stayFailed = reason;
      stayChanged = true;
      const attempt = attempts + 1;
      newFailures.push({ property: p.label, name: `${n.firstName} ${n.lastName}`.trim(), gate: target.gate, gateLabel: target.label,
        arrivalDate: res.arrivalDate, departureDate: res.departureDate, reason, attempt, maxAttempts: cfg.maxAttempts, gaveUp: attempt >= cfg.maxAttempts });
      logger.warn(`[sweep] FAILED ${n.firstName} ${n.lastName} → ${target.label}: ${reason} (attempt ${attempt}/${cfg.maxAttempts})`);
    }

    // Tell ArrivalPilot the outcome for this exact driver-list version (live, guest-form lists only).
    if (live && nameSource === 'guest_form' && r.driversUpdatedAt) {
      const result = stayFailed ? 'failed' : stayAllOn || stayChanged ? 'added' : null;
      const tag = `${r.driversUpdatedAt}|${result}`;
      if (result && (stayChanged || reported.get(r.reservationId) !== tag)) {
        const rep = await apReport.reportResult({ reservationId: r.reservationId, driversUpdatedAt: r.driversUpdatedAt, result, error: stayFailed || undefined });
        if (rep.ok) reported.set(r.reservationId, tag);
        reports.push({ reservationId: r.reservationId, result, ...rep, body: undefined });
      }
    }
  }

  let alert = { sent: false, reason: 'nothing_to_send' };
  // Alerts are best-effort: no SendGrid key (or any email error) must never break a run. The
  // failures are already in the store, so the dashboard's red rows don't depend on this.
  if (newFailures.length) {
    try { alert = await notify.emailFailures(newFailures, { dashboardUrl: process.env.DASHBOARD_URL }); }
    catch (e) { alert = { sent: false, reason: 'error', error: String(e.message).slice(0, 200) }; }
  }

  const record = {
    kind: 'sweep', trigger, startedAt, finishedAt: new Date().toISOString(),
    mode: cfg.dryRun ? 'dry-run' : 'live', autoAdd: cfg.autoAdd, window: { from, to }, onlyReservation: reservationId,
    counts, perProperty: Object.values(perProperty),
    wouldAdd: wouldAdd.slice(0, 200), reports, alert,
    // /api/status groups by community
    communities: Object.values(perProperty).map((p) => ({ community: p.community, added: p.added, wouldAdd: p.wouldAdd, alreadyOnGate: p.alreadyOnGate, failed: p.failed, awaitingNames: p.awaiting, notEligible: p.notEligible })),
  };
  // History: ArrivalPilot's gateSyncRuns (Firestore) via gateSyncReport; the local store keeps
  // /api/status working between restarts of the process.
  record.history = await apReport.reportRun(record);
  store.recordRun(record);
  lastSweep = record;
  logger.info(`[sweep] done: ${JSON.stringify(counts)} | history ${record.history.ok ? 'saved ' + record.history.id : 'NOT saved (' + (record.history.httpStatus || record.history.reason) + ')'}`);
  return { summary: record };
}

module.exports = { runSweep, settings, modes, modeFor, localDay, lastSweep: () => lastSweep };

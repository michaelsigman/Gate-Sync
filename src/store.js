'use strict';

/**
 * Tiny persistent store for dashboard history: sync runs, gate-push failures,
 * and when WE added each guest to a gate. JSON file, atomic writes.
 *
 * STORE_PATH defaults to ./data/gate-store.json. On Render, point it at a
 * mounted persistent disk (e.g. /var/data/gate-store.json) or history resets on
 * every deploy/restart. Nothing in here ever talks to a gate.
 *
 * Every public function swallows its own errors: bookkeeping must never be able
 * to break or change a sync.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, '..', 'data', 'gate-store.json');
const MAX_RUNS = 50;
const MAX_FAILURES = 500;
const ADDED_TTL_DAYS = 120; // forget add records long after checkout

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[store] could not read, starting fresh:', e.message);
    db = {};
  }
  db.runs = db.runs || [];
  db.failures = db.failures || [];
  db.added = db.added || {}; // addKey -> { at, reservationId, gateLabel, name }
  return db;
}

let writeTimer = null;
function save() {
  // Coalesce bursts (one add per name per gate) into a single write.
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      const tmp = STORE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) {
      console.warn('[store] write failed:', e.message);
    }
  }, 200);
}

function addKey(reservationId, gateLabel, nameKey) {
  return `${reservationId}|${gateLabel}|${nameKey}`;
}

function safe(fn, fallback) {
  return (...args) => {
    try { return fn(...args); } catch (e) { console.warn('[store]', e.message); return fallback; }
  };
}

/** A gate accepted this guest. Clears any earlier failure for the same slot. */
const recordAdded = safe(({ reservationId, gateLabel, nameKey, name, source }) => {
  load();
  const at = new Date().toISOString();
  db.added[addKey(reservationId, gateLabel, nameKey)] = { at, reservationId, gateLabel, name, source };
  for (const f of db.failures) {
    if (!f.resolvedAt && f.reservationId === reservationId && f.gateLabel === gateLabel && f.nameKey === nameKey) {
      f.resolvedAt = at;
    }
  }
  save();
});

/** A gate push errored or was rejected. */
const recordFailure = safe(({ reservationId, propertyUid, property, community, gate, gateLabel, nameKey, name, reason, source }) => {
  load();
  db.failures.unshift({
    at: new Date().toISOString(),
    reservationId, propertyUid, property, community, gate, gateLabel, nameKey, name,
    reason: String(reason || 'unknown error').slice(0, 500),
    source,
    resolvedAt: null,
  });
  db.failures.length = Math.min(db.failures.length, MAX_FAILURES);
  save();
});

/** Mark failures resolved when the guest turns out to be on the gate anyway. */
const resolveIfOnGate = safe((reservationId, gateLabel, nameKey) => {
  load();
  let changed = false;
  for (const f of db.failures) {
    if (!f.resolvedAt && f.reservationId === reservationId && f.gateLabel === gateLabel && f.nameKey === nameKey) {
      f.resolvedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) save();
});

const recordRun = safe((run) => {
  load();
  db.runs.unshift(run);
  db.runs.length = Math.min(db.runs.length, MAX_RUNS);
  // Housekeeping: drop add records we'll never display again.
  const cutoff = Date.now() - ADDED_TTL_DAYS * 864e5;
  for (const [k, v] of Object.entries(db.added)) if (Date.parse(v.at) < cutoff) delete db.added[k];
  save();
});

const addedFor = safe((reservationId, gateLabel, nameKey) => {
  load();
  return db.added[addKey(reservationId, gateLabel, nameKey)] || null;
}, null);

const openFailuresFor = safe((reservationId) => {
  load();
  return db.failures.filter((f) => f.reservationId === reservationId && !f.resolvedAt);
}, []);

/** Failed attempts for one name on one gate since it last succeeded (drives the retry cap). */
const failedAttempts = safe((reservationId, gateLabel, nameKey) => {
  load();
  return db.failures.filter((f) => !f.resolvedAt && f.reservationId === reservationId && f.gateLabel === gateLabel && f.nameKey === nameKey).length;
}, 0);

const recentFailures = safe((limit = 50) => {
  load();
  return db.failures.slice(0, limit);
}, []);

const runs = safe((limit = 10) => load().runs.slice(0, limit), []);

module.exports = {
  STORE_PATH,
  recordAdded,
  recordFailure,
  resolveIfOnGate,
  recordRun,
  addedFor,
  openFailuresFor,
  failedAttempts,
  recentFailures,
  runs,
};

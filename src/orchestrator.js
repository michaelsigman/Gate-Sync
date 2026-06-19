'use strict';
require('dotenv').config();

const { ProptiaClient } = require('./proptiaClient');
const { GoAccessClient } = require('./goAccessClient');
const { HostfullyClient } = require('./hostfullyClient');
const { parseGateNames } = require('./parseNotes');
const propertyMap = require('./propertyMap');

const DRY_RUN = process.env.DRY_RUN !== 'false'; // defaults to TRUE (safe)

// --- Date handling (timezone-safe) ---
// Hostfully gives us a plain calendar date string like "2026-06-24". We never
// want the server's local timezone to shift it, so we parse/format from the
// string's components via Date.UTC and never read local getDate()/getMonth().

// Parse "YYYY-MM-DD" (ignoring any time/zone suffix) into a UTC Date at midnight.
function parseDateOnly(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
// Add whole days to a date-only value, staying in UTC.
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function fmtMMDDYYYY(dateInput) {
  const d = typeof dateInput === 'string' ? parseDateOnly(dateInput) : dateInput;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}
function fmtYYYYMMDD(dateInput) {
  const d = typeof dateInput === 'string' ? parseDateOnly(dateInput) : dateInput;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// GoAccess wants UTC instants. We anchor to the property's local midnight.
// For Pacific (UTC-7 in summer), local midnight = 07:00Z the same calendar day.
// We expose start-of-day and end-of-day for a given calendar date.
const PROPERTY_UTC_OFFSET_HOURS = Number(process.env.PROPERTY_UTC_OFFSET_HOURS || 7);
function startOfDayUTCISO(dateInput) {
  const ymd = fmtYYYYMMDD(dateInput);
  const hh = String(PROPERTY_UTC_OFFSET_HOURS).padStart(2, '0');
  return `${ymd}T${hh}:00:00.000Z`;
}
function endOfDayUTCISO(dateInput) {
  // End of this calendar day in local time = next day's local-midnight minus 1ms.
  const next = fmtYYYYMMDD(addDays(parseDateOnly(fmtYYYYMMDD(dateInput)), 1));
  const hh = String(PROPERTY_UTC_OFFSET_HOURS - 1).padStart(2, '0');
  return `${next}T${hh}:59:59.999Z`;
}

function nameKey(first, last) {
  return (first + '|' + (last || '')).toLowerCase().replace(/[\s'’.\-]/g, '');
}

// Lazy gate-client manager: one login per gate, only if needed.
function makeGateManager(logger, { login = !DRY_RUN } = {}) {
  const clients = {};
  return {
    async get(gate) {
      if (clients[gate]) return clients[gate];
      let c;
      if (gate === 'proptia') {
        c = new ProptiaClient({
          username: process.env.PROPTIA_USERNAME,
          password: process.env.PROPTIA_PASSWORD,
          logger,
        });
      } else if (gate === 'goaccess') {
        c = new GoAccessClient({
          username: process.env.GOACCESS_USERNAME,
          password: process.env.GOACCESS_PASSWORD,
          logger,
        });
      } else {
        throw new Error('Unknown gate vendor: ' + gate);
      }
      if (login) await c.login();
      clients[gate] = c;
      return c;
    },
  };
}

// Pull existing visitor name-keys for dedupe (live mode only).
async function existingKeys(client, gate, prop, logger) {
  try {
    const current = await client.listVisitors(prop);
    return new Set(
      current.map((v) => {
        // Proptia returns first_name/last_name; GoAccess returns a single name.
        if (v.first_name !== undefined) return nameKey(v.first_name, v.last_name);
        const parts = String(v.name || '').trim().split(/\s+/);
        return nameKey(parts[0] || '', parts.slice(1).join(' '));
      })
    );
  } catch (e) {
    logger.warn('  could not fetch existing visitors: ' + e.message);
    return new Set();
  }
}

// Pass window = day BEFORE arrival through day AFTER checkout (buffer for early
// arrivals / late departures). `arrival`/`departure` are date strings (YYYY-MM-DD).
function bufferedWindow(arrival, departure) {
  const passStart = addDays(parseDateOnly(arrival), -1);   // day before arrival
  const passEnd = addDays(parseDateOnly(departure), 1);    // day after checkout
  return { passStart, passEnd };
}

// GoAccess caps a Guest pass at 7 days; we use 6-day segments for safety margin.
// Split [start..end] (inclusive calendar days) into consecutive segments each
// spanning at most MAX_SEGMENT_DAYS calendar days, back-to-back with no gap.
const GOACCESS_MAX_SEGMENT_DAYS = Number(process.env.GOACCESS_MAX_SEGMENT_DAYS || 6);
function segmentWindow(passStart, passEnd, maxDays) {
  const segments = [];
  let segStart = new Date(passStart);
  // total inclusive day count
  while (segStart <= passEnd) {
    // segEnd is at most (maxDays-1) days after segStart, but not past passEnd.
    let segEnd = addDays(segStart, maxDays - 1);
    if (segEnd > passEnd) segEnd = new Date(passEnd);
    segments.push({ start: new Date(segStart), end: new Date(segEnd) });
    segStart = addDays(segEnd, 1); // next segment starts the day after
  }
  return segments;
}

async function addOne(client, gate, prop, guest, arrival, departure) {
  const { passStart, passEnd } = bufferedWindow(arrival, departure);
  if (gate === 'proptia') {
    return client.addGuest(prop, guest, {
      arrivalMMDDYYYY: fmtMMDDYYYY(passStart),
      departureMMDDYYYY: fmtMMDDYYYY(passEnd),
    });
  }
  // goaccess: chain 6-day segments to cover the whole window (max 7-day limit).
  const segments = segmentWindow(passStart, passEnd, GOACCESS_MAX_SEGMENT_DAYS);
  const results = [];
  for (const seg of segments) {
    const r = await client.addGuest(prop, guest, {
      startISO: startOfDayUTCISO(seg.start),
      endISO: endOfDayUTCISO(seg.end),
    });
    results.push(r);
  }
  // Report combined: ok only if every segment succeeded; collect PINs.
  const ok = results.every((r) => r.ok);
  const pins = results.map((r) => r.pin).filter(Boolean);
  return {
    ok,
    status: results[0] ? results[0].status : 0,
    pin: pins[0] || null,
    pins,
    segments: results.length,
  };
}

/**
 * A property may sit behind ONE gate (fields inline) or MULTIPLE gates
 * (a `gates: [...]` array — e.g. a 6-bedroom listing that is two neighboring
 * condos, each its own Proptia entry). Normalize to a list of targets, each
 * carrying its own gate vendor + IDs and a label.
 */
function getGateTargets(prop) {
  if (Array.isArray(prop.gates) && prop.gates.length) {
    return prop.gates.map((g, i) => ({
      gate: g.gate,
      config: { ...g, label: g.label || `${prop.label || 'property'} — unit ${i + 1}` },
      label: g.label || `${prop.label || 'property'} — unit ${i + 1}`,
    }));
  }
  // Single inline gate (legacy shape).
  return [{ gate: prop.gate, config: prop, label: prop.label }];
}

async function run({ logger = console } = {}) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  logger.info(
    `[gate-sync] ${DRY_RUN ? 'DRY-RUN' : 'LIVE'} — arrivals on ${fmtYYYYMMDD(tomorrow)}`
  );

  const hostfully = new HostfullyClient({
    apiKey: process.env.HOSTFULLY_API_KEY,
    agencyUid: process.env.HOSTFULLY_AGENCY_UID,
    logger,
  });

  const reservations = await hostfully.getReservationsArriving(fmtYYYYMMDD(tomorrow), { logger });
  logger.info(`[gate-sync] ${reservations.length} reservation(s) arriving tomorrow`);

  const actionable = reservations.filter((r) => propertyMap[r.propertyUid]);
  if (actionable.length === 0) {
    logger.info('[gate-sync] none map to a known gate property — nothing to do');
    return { processed: 0, summary: [] };
  }

  const gates = makeGateManager(logger);
  const summary = [];

  for (const res of actionable) {
    const prop = propertyMap[res.propertyUid];
    const parsed = parseGateNames(res.notes);
    const targets = getGateTargets(prop);

    logger.info(`\n=== ${prop.label || res.propertyUid} | res ${res.reservationId} | ${targets.length} gate(s) ===`);

    if (parsed.names.length === 0) {
      logger.info('  no gate-name block in notes — skipping');
      summary.push({ property: prop.label, added: [], skipped: 'no names' });
      continue;
    }

    const arrival = res.arrivalDate;     // keep as YYYY-MM-DD string
    const departure = res.departureDate; // keep as YYYY-MM-DD string

    for (const target of targets) {
      logger.info(`  -- [${target.gate}] ${target.label} --`);
      let client = null;
      let existing = new Set();
      if (!DRY_RUN) {
        client = await gates.get(target.gate);
        existing = await existingKeys(client, target.gate, target.config, logger);
      }

      const added = [];
      for (const n of parsed.names) {
        const key = nameKey(n.firstName, n.lastName);
        if (existing.has(key)) {
          logger.info(`    • ${n.firstName} ${n.lastName} — already on gate, skip`);
          continue;
        }
        if (DRY_RUN) {
          logger.info(
            `    + WOULD ADD: ${n.firstName} ${n.lastName}  ` +
              `(${fmtYYYYMMDD(arrival)} → ${fmtYYYYMMDD(departure)})`
          );
          added.push(`${n.firstName} ${n.lastName}`);
        } else {
          try {
            const r = await addOne(client, target.gate, target.config, n, arrival, departure);
            const pin = r.pin ? ` pin=${r.pin}` : '';
            logger.info(
              `    + ADDED: ${n.firstName} ${n.lastName} — ${r.ok ? 'ok' : 'status ' + r.status}${pin}`
            );
            if (r.ok) added.push(`${n.firstName} ${n.lastName}${pin}`);
          } catch (e) {
            logger.error(`    ! FAILED ${n.firstName} ${n.lastName}: ${e.message}`);
          }
        }
      }
      summary.push({ gate: target.gate, property: target.label, added });
    }
  }

  logger.info('\n[gate-sync] done. summary:');
  logger.info(JSON.stringify(summary, null, 2));
  return { processed: actionable.length, summary };
}

/**
 * Process a single reservation object (used by the UI API). Returns a structured
 * plan/result without logging. `clients` is a map of gate->client (may be empty
 * in dry-run). Handles properties that target multiple gates.
 */
async function processReservation({ reservation, prop, clients = {}, dryRun, names }) {
  // If the caller supplies an explicit `names` list (e.g. the UI after the
  // operator edited/checked names), use it. Otherwise parse from the notes.
  let parsed;
  if (Array.isArray(names)) {
    const clean = names
      .map((n) => ({
        firstName: String(n.firstName || '').trim(),
        lastName: String(n.lastName || '').trim(),
      }))
      .filter((n) => n.firstName || n.lastName);
    parsed = { names: clean, guest: parseGateNames(reservation.notes).guest };
  } else {
    parsed = parseGateNames(reservation.notes);
  }
  const arrival = reservation.arrivalDate;     // YYYY-MM-DD string
  const departure = reservation.departureDate; // YYYY-MM-DD string
  const targets = getGateTargets(prop);

  const gateResults = [];
  for (const target of targets) {
    const client = clients[target.gate] || null;
    let existing = new Set();
    if (!dryRun && client) {
      existing = await existingKeys(client, target.gate, target.config, console);
    }

    const results = [];
    for (const n of parsed.names) {
      const key = nameKey(n.firstName, n.lastName);
      const display = `${n.firstName} ${n.lastName}`.trim();
      if (existing.has(key)) {
        results.push({ name: display, status: 'already_on_gate' });
        continue;
      }
      if (dryRun) {
        results.push({ name: display, status: 'would_add' });
      } else {
        try {
          const r = await addOne(client, target.gate, target.config, n, arrival, departure);
          results.push({
            name: display,
            status: r.ok ? 'added' : 'failed',
            pin: r.pin || null,
            httpStatus: r.status,
          });
        } catch (e) {
          results.push({ name: display, status: 'failed', error: e.message });
        }
      }
    }
    gateResults.push({ gate: target.gate, label: target.label, results });
  }

  return {
    property: prop.label,
    guest: parsed.guest,
    arrival: fmtYYYYMMDD(arrival),
    departure: fmtYYYYMMDD(departure),
    blockCount: parsed.blockCount || 0,
    nameCount: parsed.names.length,
    gates: gateResults,
  };
}

module.exports = {
  run,
  processReservation,
  makeGateManager,
  getGateTargets,
  nameKey,
  fmtYYYYMMDD,
  fmtMMDDYYYY,
};

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

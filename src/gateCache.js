'use strict';

/**
 * Shared, read-only cache of "who is on each gate", so dashboard traffic never
 * turns into gate traffic.
 *
 *  - Refreshes per VENDOR: one login + one listVisitors per target, at most once
 *    per GATE_CACHE_TTL_MS (default 15 min) no matter how many viewers/calls.
 *  - Concurrent callers share the same in-flight refresh.
 *  - A failed login/read is also held for the full TTL before retrying, so a bad
 *    password or an outage can't turn into repeated logins and an account lockout.
 *  - On failure the last good data is kept and flagged stale.
 *
 * Never writes to a gate.
 */

const propertyMap = require('./propertyMap');
const { getGateTargets, makeGateManager, nameKey } = require('./orchestrator');

const TTL_MS = Number(process.env.GATE_CACHE_TTL_MS || 15 * 60 * 1000);

// Proptia visitor lists are per unit, GoAccess per household — key on all of it
// so two units in the same community don't share one list.
function targetKey(t) {
  const c = t.config || {};
  return [t.gate, c.communityId, c.propertyId, c.unitId, c.householdId, c.residentId].map((v) => v ?? '').join('|');
}

function allTargets() {
  const out = [];
  for (const [propertyUid, prop] of Object.entries(propertyMap)) {
    for (const t of getGateTargets(prop)) {
      out.push({ ...t, propertyUid, property: prop.label, community: t.config.community || prop.community || null });
    }
  }
  return out;
}

function visitorKeys(visitors) {
  const keys = new Set();
  for (const v of visitors) {
    if (v.first_name !== undefined) keys.add(nameKey(v.first_name, v.last_name));
    else if (v.name) {
      const parts = String(v.name).trim().split(/\s+/);
      keys.add(nameKey(parts[0] || '', parts.slice(1).join(' ')));
    }
  }
  return keys;
}

// vendor -> { at, error, targets: Map(targetKey -> { keys:Set|null, error, at }) }
const vendors = new Map();
const inflight = new Map();

async function refreshVendor(vendor) {
  const entry = vendors.get(vendor) || { at: 0, error: null, targets: new Map() };
  const targets = allTargets().filter((t) => t.gate === vendor);
  const attemptAt = Date.now();
  try {
    const gates = makeGateManager(console, { login: true });
    const client = await gates.get(vendor); // the one login for this vendor
    entry.error = null;
    for (const t of targets) {
      const k = targetKey(t);
      try {
        const keys = visitorKeys(await client.listVisitors(t.config));
        entry.targets.set(k, { keys, error: null, at: attemptAt });
      } catch (e) {
        const prev = entry.targets.get(k);
        entry.targets.set(k, { keys: prev ? prev.keys : null, error: e.message, at: prev ? prev.at : 0 });
        console.warn(`[gate-cache] read failed for ${t.label}: ${e.message}`);
      }
    }
  } catch (e) {
    entry.error = e.message; // login failed: keep last good lists, don't retry until TTL
    console.warn(`[gate-cache] ${vendor} login failed: ${e.message}`);
  }
  entry.at = attemptAt;
  vendors.set(vendor, entry);
  return entry;
}

async function ensureFresh(vendor) {
  const entry = vendors.get(vendor);
  if (entry && Date.now() - entry.at < TTL_MS) return entry;
  if (!inflight.has(vendor)) {
    inflight.set(vendor, refreshVendor(vendor).finally(() => inflight.delete(vendor)));
  }
  return inflight.get(vendor);
}

/** Set of name-keys on this target's gate, or null if it has never been readable. */
async function keysFor(target) {
  const entry = await ensureFresh(target.gate);
  const t = entry.targets.get(targetKey(target));
  return t ? t.keys : null;
}

/** After WE add someone, reflect it immediately without another gate read. */
function noteAdded(target, key) {
  const entry = vendors.get(target.gate);
  const t = entry && entry.targets.get(targetKey(target));
  if (t && t.keys) t.keys.add(key);
}

/** Per-target health for /api/status. Does not trigger a refresh. */
function health() {
  return allTargets().map((t) => {
    const entry = vendors.get(t.gate);
    const rec = entry && entry.targets.get(targetKey(t));
    return {
      gate: t.gate,
      label: t.label,
      community: t.community,
      property: t.property,
      propertyUid: t.propertyUid,
      checkedAt: rec && rec.at ? new Date(rec.at).toISOString() : null,
      error: (entry && entry.error) || (rec && rec.error) || null,
    };
  });
}

function lastCheckedAt() {
  let min = null;
  for (const e of vendors.values()) if (e.at && (min === null || e.at < min)) min = e.at;
  return min ? new Date(min).toISOString() : null;
}

module.exports = { TTL_MS, keysFor, noteAdded, health, lastCheckedAt, ensureFresh, allTargets };

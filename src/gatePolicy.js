'use strict';

/**
 * Which reservations gate-sync may add to a gate.
 *
 * Rule (Mike, 2026-09-24): collection (the guest form) is for every has_gate property; AUTOMATION
 * is only for properties with gate_pilot_enabled = true. gate-sync is the automation, so it adds
 * names only when BOTH hold:
 *
 *   gate configured  — checked HERE against gate-sync's own property map: every gate target names a
 *                      known system and carries every ID that system's client needs (community
 *                      included). No mapping = nothing to add to.
 *   Gate Pilot on    — the stay came from ArrivalPilot's gateSyncFeed, which returns ONLY
 *                      gate_pilot_enabled properties (so a property defaults to off by not being
 *                      in it). An explicit false in the row (gatePilotEnabled / gateEnabled /
 *                      hasGate) still turns it off.
 *
 * Hostfully (legacy fallback) has no Gate Pilot switch, so its stays are always off.
 * Callers: run() (daily sync), /api/process + processReservation (dashboard), and the sweep.
 */

const REQUIRED_IDS = {
  proptia: ['communityId', 'memberId', 'propertyId', 'unitId', 'passName'],
  goaccess: ['communityId', 'householdId', 'residentId', 'visitorTypeId'],
};

function gateConfigured(prop) {
  if (!prop) return { ok: false, reason: 'no gate mapping in gate-sync for this property' };
  const { getGateTargets } = require('./orchestrator'); // lazy: orchestrator requires this module
  const targets = getGateTargets(prop);
  if (!targets.length) return { ok: false, reason: 'no gate targets configured' };
  for (const t of targets) {
    const need = REQUIRED_IDS[t.gate];
    if (!need) return { ok: false, reason: `unknown gate system "${t.gate}" on ${t.label}` };
    const missing = need.filter((k) => t.config[k] === undefined || t.config[k] === null || t.config[k] === '');
    if (missing.length) return { ok: false, reason: `${t.label}: missing ${missing.join(', ')}` };
  }
  return { ok: true, reason: null };
}

function gatePilotOn(r) {
  if (!r) return { ok: false, reason: 'reservation not found' };
  // Only the ArrivalPilot feed can switch a property on: it returns ONLY gate_pilot_enabled
  // properties, so being in it is the "on" signal. Hostfully (legacy) has no such switch.
  if (r.source !== 'arrivalpilot') return { ok: false, reason: 'Gate Pilot is off (stay did not come from the ArrivalPilot feed)' };
  // An explicit "off" in the row still wins, if the feed ever sends one.
  if (r.hasGate === false) return { ok: false, reason: 'ArrivalPilot says this property has no gate' };
  if (r.gatePilotEnabled === false || r.gateEnabled === false) return { ok: false, reason: 'Gate Pilot is off for this property' };
  return { ok: true, reason: null };
}

/** { ok, gateConfigured, gatePilotOn, reason } — ok only when both hold. */
function eligibility(r, prop) {
  const g = gateConfigured(prop);
  const e = gatePilotOn(r);
  return { ok: g.ok && e.ok, gateConfigured: g.ok, gatePilotOn: e.ok, reason: g.ok ? e.reason : g.reason };
}

class NotEligibleError extends Error {
  constructor(reason) { super(reason); this.code = 'GATE_NOT_ELIGIBLE'; }
}

module.exports = { gateConfigured, gatePilotOn, eligibility, NotEligibleError, REQUIRED_IDS };

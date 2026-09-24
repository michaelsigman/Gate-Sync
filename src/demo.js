'use strict';

/**
 * VRMA booth demo. Fully separate from the real flow:
 *   - Invented homes' stays and names only (DEMO_STAYS below) — never reads guest data.
 *   - Exactly ONE stay (the red one) ever writes to a gate, and only to Desert Sky Outpost's GoAccess
 *     household (checked on every write), with a 2-hour pass tagged "Gate Pilot demo" in notes.
 *   - Plain public links (no token). Gate writes happen only while DEMO_GATE_WRITES=true (on for show
 *     days, off after); otherwise the form says the demo is offline. 15 s between submits, 20/hour.
 *   - Its own state file — independent of DRY_RUN, AUTO_ADD and property modes, and never written to
 *     the dashboard's history.
 *   - Reset archives the demo passes through GoAccess only when DEMO_REMOVE=api (set after the
 *     supervised removal test). Otherwise it answers "Remove in portal" with the names to delete.
 */

const fs = require('fs');
const path = require('path');
const propertyMap = require('./propertyMap');
const { GoAccessClient } = require('./goAccessClient');

const DEMO_PROPERTY_UID = 'ec4e291f-e51a-4e39-9e83-b439ecb4f312'; // Desert Sky Outpost
const DEMO_HOUSEHOLD_ID = 44928;
const DEMO_TAG = 'Gate Pilot demo';
const PASS_MINUTES = 120;
const MAX_DRIVERS = 3;
const NAME_MAX = 30;
const STATE_PATH = process.env.DEMO_STATE_PATH || path.join(__dirname, '..', 'data', 'demo-state.json');

// Words the booth form refuses (checked as whole words, case-insensitive, leetspeak-folded).
const BLOCKED = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard', 'slut', 'whore',
  'fag', 'faggot', 'nigger', 'nigga', 'retard', 'rape', 'nazi', 'hitler', 'porn', 'penis', 'vagina', 'tits', 'boob'];

const pad = (n) => String(n).padStart(2, '0');
function dayOffset(o) {
  const d = new Date(Date.now() + o * 864e5);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// Display-only stays with invented guests. Dates are relative to today so the calendar is always full.
function demoStays() {
  const s = (id, home, from, nights, guest, drivers) => ({ id, home, checkIn: dayOffset(from), checkOut: dayOffset(from + nights), guest, drivers });
  return [
    s('d-tp-1', 'Twin Palms', -1, 4, 'Avery Collins', ['Avery Collins', 'Morgan Collins', 'Riley Shaw']),
    s('d-tp-2', 'Twin Palms', 5, 3, 'Dana Whitaker', ['Dana Whitaker']),
    s('d-vc-1', 'Villa Chella', 0, 3, 'Priya Raman', ['Priya Raman', 'Arjun Raman']),
    s('d-vc-2', 'Villa Chella', 4, 5, 'Marcus Bell', ['Marcus Bell', 'Tanya Bell']),
    s('d-cg-1', 'Condo on the Green', 1, 2, 'Elena Ortiz', ['Elena Ortiz']),
    s('d-cg-2', 'Condo on the Green', 6, 4, 'Sam Nakamura', ['Sam Nakamura', 'Kenji Nakamura']),
    s('d-ds-2', 'Desert Sky Outpost', 4, 3, 'Grace Holloway', ['Grace Holloway', 'Leo Holloway']),
  ];
}
// The one live stay: red until the phone form is submitted.
function liveStayBase() {
  return { id: 'd-ds-live', home: 'Desert Sky Outpost', checkIn: dayOffset(0), checkOut: dayOffset(2), guest: 'Jordan Rivera', live: true };
}
const HOMES = ['Twin Palms', 'Villa Chella', 'Condo on the Green', 'Desert Sky Outpost'];
const PREFILL = [{ firstName: 'Jordan', lastName: 'Rivera' }, { firstName: 'Casey', lastName: 'Rivera' }];

// ---- state (demo-only file) ----
let state = null;
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { state = {}; }
  state.passes = state.passes || []; // [{ id, name, pin, startISO, endISO, addedAt }]
  state.log = state.log || [];       // demo-only activity log
  return state;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_PATH + '.tmp', STATE_PATH);
  } catch (e) { console.warn('[demo] state write failed:', e.message); }
}
function logEvent(ev) { load(); state.log.unshift({ at: new Date().toISOString(), ...ev }); state.log.length = Math.min(state.log.length, 200); save(); }

function settings() {
  return {
    gateWrites: process.env.DEMO_GATE_WRITES === 'true',
    removeVia: process.env.DEMO_REMOVE === 'api' ? 'api' : 'portal',
  };
}

function publicState() {
  load();
  const now = Date.now();
  const active = state.passes.filter((p) => Date.parse(p.endISO) > now);
  const live = { ...liveStayBase(), status: state.passes.length ? 'added' : 'awaiting', drivers: state.passes.map((p) => p.name),
    passes: state.passes.map((p) => ({ name: p.name, pin: p.pin || null, until: p.endISO, expired: Date.parse(p.endISO) <= now })) };
  return {
    homes: HOMES,
    days: Array.from({ length: 10 }, (_, i) => dayOffset(i - 1)),
    today: dayOffset(0),
    stays: [...demoStays().map((s) => ({ ...s, status: 'added' })), live],
    prefill: PREFILL,
    maxDrivers: MAX_DRIVERS,
    passMinutes: PASS_MINUTES,
    settings: settings(),
    activePasses: active.length,
  };
}

// ---- validation ----
function fold(s) { return s.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a'); }
function cleanName(v, field, i) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) throw new DemoError(400, `Driver ${i + 1}: ${field} is required.`);
  if (s.length > NAME_MAX) throw new DemoError(400, `Driver ${i + 1}: ${field} must be ${NAME_MAX} characters or fewer.`);
  if (!/^[\p{L}][\p{L} .'’-]*$/u.test(s)) throw new DemoError(400, `Driver ${i + 1}: ${field} can only use letters, spaces, apostrophes, periods and hyphens.`);
  // Split on spaces/hyphens only, then drop other punctuation inside a word ("F.u.c.k" -> "fuck").
  const words = fold(s).split(/[\s-]+/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
  const joined = fold(s).replace(/[^a-z]/g, '');
  if (words.some((w) => BLOCKED.includes(w)) || BLOCKED.some((b) => b.length >= 5 && joined.includes(b))) {
    throw new DemoError(400, `Driver ${i + 1}: please use a different name.`);
  }
  return s;
}
function validateDrivers(drivers) {
  if (!Array.isArray(drivers) || !drivers.length) throw new DemoError(400, 'Add at least one driver.');
  if (drivers.length > MAX_DRIVERS) throw new DemoError(400, `Up to ${MAX_DRIVERS} drivers.`);
  const out = drivers.map((d, i) => ({ firstName: cleanName(d && d.firstName, 'first name', i), lastName: cleanName(d && d.lastName, 'last name', i) }));
  const seen = new Set();
  return out.filter((d) => { const k = (d.firstName + ' ' + d.lastName).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

class DemoError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- gate target (hard-checked) ----
function demoTarget() {
  const prop = propertyMap[DEMO_PROPERTY_UID];
  const g = prop && (prop.gates || []).find((x) => x.gate === 'goaccess');
  if (!g || Number(g.householdId) !== DEMO_HOUSEHOLD_ID) throw new DemoError(500, 'Demo gate is not configured as expected (Desert Sky / GoAccess 44928).');
  return g;
}
async function goaccess() {
  const c = new GoAccessClient({ username: process.env.GOACCESS_USERNAME, password: process.env.GOACCESS_PASSWORD, logger: console });
  await c.login();
  return c;
}

// Serialize demo actions (submit / reset) so taps can't race.
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
let lastSubmitAt = 0;
let recentSubmits = [];
const MAX_SUBMITS_PER_HOUR = 20;

function submit(drivers) {
  return serial(async () => {
    const cfg = settings();
    if (!cfg.gateWrites) throw new DemoError(503, 'The demo is offline right now.');
    load();
    if (state.passes.length) throw new DemoError(409, 'This stay already has drivers. Press "Reset demo" first.');
    if (Date.now() - lastSubmitAt < 15000) throw new DemoError(429, 'One moment — try again in a few seconds.');
    // The links are public, so cap real gate adds per hour (a booth needs far fewer).
    const hourAgo = Date.now() - 3600e3;
    recentSubmits = recentSubmits.filter((t) => t > hourAgo);
    if (recentSubmits.length >= MAX_SUBMITS_PER_HOUR) throw new DemoError(429, 'The demo has reached its hourly limit. Try again later.');
    recentSubmits.push(Date.now());
    lastSubmitAt = Date.now();
    const clean = validateDrivers(drivers);
    const target = demoTarget();
    const start = new Date();
    const end = new Date(start.getTime() + PASS_MINUTES * 60000);
    const client = await goaccess();
    const added = [];
    const errors = [];
    for (const d of clean) {
      const name = `${d.firstName} ${d.lastName}`;
      try {
        const r = await client.addGuest(target, d, { startISO: start.toISOString(), endISO: end.toISOString(), notes: DEMO_TAG });
        if (!r.ok) throw new Error('GoAccess returned status ' + r.status);
        const p = { id: r.id, name, pin: r.pin || null, startISO: start.toISOString(), endISO: end.toISOString(), addedAt: new Date().toISOString() };
        state.passes.push(p);
        added.push(p);
      } catch (e) {
        errors.push({ name, error: e.message });
      }
    }
    save();
    logEvent({ type: 'submit', added: added.map((p) => ({ name: p.name, id: p.id, pin: p.pin })), errors });
    return { ok: errors.length === 0, added: added.map((p) => ({ name: p.name, pin: p.pin, until: p.endISO })), errors, community: 'Desert Sky Outpost' };
  });
}

function reset() {
  return serial(async () => {
    load();
    const cfg = settings();
    const passes = state.passes.slice();
    if (!passes.length) return { ok: true, removed: [], removeInPortal: [] };
    let removed = [];
    let removeInPortal = passes.map((p) => ({ name: p.name, pin: p.pin, until: p.endISO }));
    if (cfg.removeVia === 'api') {
      removed = [];
      removeInPortal = [];
      const client = await goaccess();
      for (const p of passes) {
        try {
          if (!p.id) throw new Error('no visitor id recorded');
          await client.archiveVisitor(p.id, DEMO_HOUSEHOLD_ID);
          removed.push({ name: p.name });
        } catch (e) {
          removeInPortal.push({ name: p.name, pin: p.pin, until: p.endISO, error: e.message });
        }
      }
    }
    state.passes = [];
    save();
    logEvent({ type: 'reset', removeVia: cfg.removeVia, removed, removeInPortal });
    return { ok: removeInPortal.length === 0, removed, removeInPortal, removeVia: cfg.removeVia };
  });
}

module.exports = { publicState, submit, reset, validateDrivers, DemoError, DEMO_TAG, settings };

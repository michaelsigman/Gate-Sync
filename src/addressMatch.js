'use strict';

/**
 * Address matching for gate<->property auto-suggestion.
 *
 * Gate addresses and PMS addresses rarely match exactly:
 *   gate:      "43-295 Passagio Lago Way"
 *   hostfully: "43295 Passagio Lago Way, Indian Wells, CA 92210"
 *
 * We normalize aggressively (strip punctuation, hyphens, unit words, common
 * street-type abbreviations, city/state/zip tails) and score similarity.
 * A mismatch here would add guests to the WRONG household, so the helper
 * NEVER auto-applies — it only suggests, and the user confirms.
 */

const STREET_TYPES = {
  street: 'st', st: 'st',
  avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  way: 'way',
  court: 'ct', ct: 'ct',
  place: 'pl', pl: 'pl',
  circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
};

function normalizeAddress(raw) {
  if (!raw) return { houseNum: '', rest: '', full: '' };
  let s = String(raw).toLowerCase();

  // Drop everything after the first comma (city/state/zip tail).
  s = s.split(',')[0];

  // Remove unit markers like "#33", "apt 2", "unit b", "ste 4".
  s = s.replace(/\b(apt|unit|ste|suite|#)\s*\.?\s*[a-z0-9-]+/g, ' ');

  // Strip punctuation; treat hyphens as nothing (43-295 -> 43295).
  s = s.replace(/-/g, '').replace(/[^a-z0-9\s]/g, ' ');

  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  const tokens = s.split(' ').filter(Boolean);

  // Leading house number (digits only after hyphen removal).
  let houseNum = '';
  if (tokens.length && /^\d+$/.test(tokens[0])) {
    houseNum = tokens.shift();
  }

  // Canonicalize street type words.
  const rest = tokens.map((t) => STREET_TYPES[t] || t).join(' ');

  return { houseNum, rest, full: (houseNum + ' ' + rest).trim() };
}

// Token-set similarity on the street-name portion (order-independent).
function tokenSetRatio(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score 0..1 that two addresses are the same place.
 * House number must match to score high; street similarity does the rest.
 */
function scoreMatch(addrA, addrB) {
  const A = normalizeAddress(addrA);
  const B = normalizeAddress(addrB);

  const streetSim = tokenSetRatio(A.rest, B.rest);

  let houseScore;
  if (A.houseNum && B.houseNum) {
    houseScore = A.houseNum === B.houseNum ? 1 : 0;
  } else {
    houseScore = 0.5; // unknown — neither confirm nor deny
  }

  // House number is the strongest signal; weight it heavily.
  const score = 0.6 * houseScore + 0.4 * streetSim;
  return { score, normA: A.full, normB: B.full, houseMatch: houseScore === 1 };
}

/**
 * For each gate household, rank PMS properties by score. Returns suggestions
 * with a confidence label.
 */
function suggestMatches(households, properties) {
  return households.map((h) => {
    const ranked = properties
      .map((p) => {
        const m = scoreMatch(h.address, p.address);
        return { property: p, ...m };
      })
      .sort((x, y) => y.score - x.score);

    const best = ranked[0];
    const second = ranked[1];
    let confidence = 'low';
    if (best) {
      if (best.houseMatch && best.score >= 0.85) confidence = 'high';
      else if (best.score >= 0.7) confidence = 'medium';
      // Big gap to runner-up raises confidence.
      if (second && best.score - second.score >= 0.4 && best.score >= 0.7) {
        confidence = best.houseMatch ? 'high' : 'medium';
      }
    }
    return { household: h, best, runnerUp: second, confidence, ranked };
  });
}

module.exports = { normalizeAddress, scoreMatch, suggestMatches, tokenSetRatio };

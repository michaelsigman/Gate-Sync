'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Maps each Hostfully property to its gate. The `gate` field selects the adapter:
 *   - "proptia"  -> HTML-form portal (memberId/communityId/propertyId/unitId/passName)
 *   - "goaccess" -> GoAccessControl REST API (householdId/visitorTypeId/communityId/residentId)
 *
 * If gate_property_map.json exists (produced by `node src/mapHelper.js` after you
 * confirm each address match), it is used. Otherwise these static defaults apply.
 * Properties not present are skipped.
 *
 * In production you'd load this from Firestore (`gate_property_map`).
 */

const GENERATED = path.join(__dirname, '..', 'gate_property_map.json');

const DEFAULTS = {
  // ---- Gate 1: Proptia (4 properties) — fill UUIDs from each Add-Guest URL ----
  'PROPTIA-PROP-1-HOSTFULLY-UID': {
    gate: 'proptia',
    label: 'Proptia Property 1 (replace me)',
    memberId: '496c134f-a7ab-4537-9332-a1e8f0991e66',
    communityId: '39d8e20f-2a05-463e-a8ec-84f1f180b0bd',
    propertyId: '6d99ee4c-5125-11f0-bfe5-0022480abcad',
    unitId: 'e5118bf6-e2ba-498d-8396-8da84529c6cb',
    passName: '5f5b814b-ac9a-4243-9a3d-439c5ea57096',
  },

  // ---- Gate 2: GoAccessControl (1 property) ----
  'GOACCESS-PROP-HOSTFULLY-UID': {
    gate: 'goaccess',
    label: 'GoAccess Property (replace me)',
    communityId: 12,
    householdId: 44928,
    residentId: '0fac128a-2849-460f-8deb-8c41df7bf559',
    visitorTypeId: 'cd2ad43d-2abd-46fe-aee7-6a23069ac2ff', // "Guest"
  },
};

let map = DEFAULTS;
try {
  if (fs.existsSync(GENERATED)) {
    map = JSON.parse(fs.readFileSync(GENERATED, 'utf8'));
  }
} catch (e) {
  console.warn('[propertyMap] could not read generated map, using defaults:', e.message);
}

module.exports = map;

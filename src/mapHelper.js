'use strict';

/**
 * One-time mapping helper. Run interactively:
 *   node src/mapHelper.js
 *
 * For GoAccess: logs in, pulls households (with addresses), pulls Hostfully
 * properties, suggests matches by address, and asks you to confirm each.
 * Confirmed matches are written to gate_property_map.json (which propertyMap.js
 * can load). NOTHING is written until you confirm — a wrong match would add
 * guests to a stranger's gate.
 *
 * For Proptia: there is no address payload, so it just lists your 4 properties
 * as stubs for manual UUID entry.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { GoAccessClient } = require('./goAccessClient');
const { HostfullyClient } = require('./hostfullyClient');
const { suggestMatches } = require('./addressMatch');

const OUT = path.join(__dirname, '..', 'gate_property_map.json');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function run() {
  const map = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

  const hostfully = new HostfullyClient({
    apiKey: process.env.HOSTFULLY_API_KEY,
    agencyUid: process.env.HOSTFULLY_AGENCY_UID,
  });
  console.log('Fetching Hostfully properties...');
  const properties = await hostfully.listProperties();
  console.log(`  ${properties.length} properties found.\n`);

  // ---- GoAccess: address-based auto-suggest ----
  const goaccess = new GoAccessClient({
    username: process.env.GOACCESS_USERNAME,
    password: process.env.GOACCESS_PASSWORD,
  });
  await goaccess.login();
  const residentId = process.env.GOACCESS_RESIDENT_ID;
  console.log('Fetching GoAccess households...');
  const households = await goaccess.listHouseholds(residentId);
  console.log(`  ${households.length} household(s) found.\n`);

  const suggestions = suggestMatches(households, properties);

  for (const s of suggestions) {
    const h = s.household;
    console.log('─'.repeat(60));
    console.log(`GoAccess household: ${h.address}  (household_id ${h.householdId})`);
    if (!s.best) {
      console.log('  No property candidates.');
      continue;
    }
    console.log(
      `  Suggested match [${s.confidence}]: "${s.best.property.address}" ` +
        `(${s.best.property.name}) score=${s.best.score.toFixed(2)}`
    );
    if (s.runnerUp) {
      console.log(
        `  Runner-up: "${s.runnerUp.property.address}" score=${s.runnerUp.score.toFixed(2)}`
      );
    }
    const ans = await ask('  Accept this match? [y]es / [n]o-pick-other / [s]kip: ');
    let chosen = null;
    if (ans.toLowerCase().startsWith('y')) {
      chosen = s.best.property;
    } else if (ans.toLowerCase().startsWith('n')) {
      s.ranked.slice(0, 8).forEach((r, i) =>
        console.log(`    ${i}. ${r.property.address} (${r.property.name}) [${r.score.toFixed(2)}]`)
      );
      const pick = await ask('    Enter number to map (or blank to skip): ');
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && s.ranked[idx]) chosen = s.ranked[idx].property;
    }
    if (chosen) {
      map[chosen.propertyUid] = {
        gate: 'goaccess',
        label: chosen.name || chosen.address,
        communityId: h.communityId,
        householdId: h.householdId,
        residentId,
        visitorTypeId:
          process.env.GOACCESS_VISITOR_TYPE_ID ||
          'cd2ad43d-2abd-46fe-aee7-6a23069ac2ff',
      };
      console.log(`  ✓ mapped ${chosen.propertyUid} -> household ${h.householdId}`);
    } else {
      console.log('  skipped.');
    }
  }

  // ---- Proptia: manual stubs (no address payload) ----
  console.log('\n' + '─'.repeat(60));
  console.log('Proptia gate: no address payload available — manual mapping.');
  console.log('Add the 4 Proptia properties to gate_property_map.json with their');
  console.log('UUIDs from each Add-Guest page URL. Stub entries written.\n');
  for (let i = 1; i <= 4; i++) {
    const key = `PROPTIA-PROP-${i}-HOSTFULLY-UID`;
    if (!map[key]) {
      map[key] = {
        gate: 'proptia',
        label: `Proptia Property ${i} (fill in)`,
        memberId: '', communityId: '', propertyId: '', unitId: '', passName: '',
      };
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log('Review it, fill Proptia UUIDs, then point propertyMap.js at it.');
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };

const { parseGateNames } = require('./src/parseNotes');
// Synthetic notes (no real guest data). Mirrors real Charge Automation output:
// repeated driver blocks (last one wins), lowercase names, a stray leading letter,
// and the booking guest repeated as a driver with different apostrophe/casing.
const notes = `We are coming for a family reunion  CA_PRE_ARRIVAL_LINK : https://app.chargeautomation.com/securelink/0000000000  Guest Email: test.guest@example.com  Guest Phone: +15555550100  Guest Zip Code: 90000  Guest First Name: Casey  Guest Last Name: O'Testa   Drivers Names to be added to security gate :  1. Robin sample 2. Jordan Demo 3. casey OTesta 4. jAlex Placeholder 5. Morgan example CA Online check-in Completed.  Drivers Names to be added to security gate :  1. Robin sample 2. Jordan Demo 3. casey OTesta 4. jAlex Placeholder 5. Taylor Fictional 6. Morgan example  Drivers Names to be added to security gate :  1. Robin sample 2. Jordan Demo 3. casey OTesta 4. jAlex Placeholder 5. Riley Madeup 6. Taylor Fictional 7. Morgan example`;
const r = parseGateNames(notes);
console.log("blocks found:", r.blockCount);
console.log("guest:", JSON.stringify(r.guest));
console.log("names (" + r.names.length + "):");
r.names.forEach((n,i)=>console.log(`  ${i+1}. first="${n.firstName}" last="${n.lastName}"`));

const { parseGateNames } = require('./src/parseNotes');
const notes = `We are going to a ballet competition  CA_PRE_ARRIVAL_LINK : https://app.chargeautomation.com/securelink/c62778e8a2  Guest Email: jennieodonnell9@gmail.com  Guest Phone: +16262530657  Guest Zip Code: 91750  Guest First Name: Jennie  Guest Last Name: O'donnell   Drivers Names to be added to security gate :  1. Liz pensick 2. Claudia Divas 3. jennie ODonnell 4. jHomayara Camacho 5. Denise carmona CA Online check-in Completed.  Drivers Names to be added to security gate :  1. Liz pensick 2. Claudia Divas 3. jennie ODonnell 4. jHomayara Camacho 5. Maritza Islas 6. Denise carmona  Drivers Names to be added to security gate :  1. Liz pensick 2. Claudia Divas 3. jennie ODonnell 4. jHomayara Camacho 5. Helen Reynoso 6. Maritza Islas 7. Denise carmona`;
const r = parseGateNames(notes);
console.log("blocks found:", r.blockCount);
console.log("guest:", JSON.stringify(r.guest));
console.log("names (" + r.names.length + "):");
r.names.forEach((n,i)=>console.log(`  ${i+1}. first="${n.firstName}" last="${n.lastName}"`));

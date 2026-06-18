'use strict';

/**
 * Hostfully reservation notes are appended to repeatedly as the guest edits
 * their online check-in. The "Drivers Names to be added to security gate" block
 * can appear multiple times, with the list growing or changing between versions.
 *
 * We take the LAST occurrence's list (most recent guest edit) and, as a safety
 * net, prefer the longest list if the last one is suspiciously short.
 *
 * Returns: { names: [{ firstName, lastName, raw }], guest: {firstName,lastName,email,phone} }
 */

const GATE_HEADER = /Drivers?\s+Names?\s+to\s+be\s+added\s+to\s+(?:the\s+)?security\s+gate\s*:?/i;

function splitBlocks(notes) {
  // Find every gate header and capture text until the next header or a known
  // non-list marker line.
  const blocks = [];
  const regex = new RegExp(GATE_HEADER.source, 'gi');
  let match;
  const indices = [];
  while ((match = regex.exec(notes)) !== null) {
    indices.push(match.index + match[0].length);
  }
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length
      ? notes.indexOf('Drivers', start) // rough; refined below
      : notes.length;
    blocks.push(notes.slice(start, end === -1 ? notes.length : end));
  }
  return blocks;
}

// Strip trailing/embedded non-name markers that Charge Automation glues on.
function stripMarkers(s) {
  return s
    .split(/\bCA\s+Online\b|\bCA[_\s]?PRE[_\s]?ARRIVAL\b|\bGuest\s+(?:Email|Phone|Zip|First|Last)\b|\bcheck-?in\s+completed\b/i)[0]
    .trim();
}

// Parse a single block's names. Handles TWO formats:
//   1) numbered list:  "1. Liz pensick  2. Claudia Divas"
//   2) plain lines:    "Miguel Rocha\nElizabeth Rocha"
// (including the case where the first name is on the same line as the label,
//  which the caller passes in as the block body).
function parseList(block) {
  const names = [];

  // First try numbered items.
  const itemRe = /(?:^|\s)(\d{1,2})[.)]\s*([^\d\n][^\n]*?)(?=\s+\d{1,2}[.)]|\n|$)/g;
  let m;
  let foundNumbered = false;
  while ((m = itemRe.exec(block)) !== null) {
    foundNumbered = true;
    const raw = stripMarkers(m[2].trim());
    if (!raw) continue;
    const cleaned = normalizeName(raw);
    if (cleaned.firstName) names.push(cleaned);
  }
  if (foundNumbered) return names;

  // No numbers → treat each non-empty line as a name. Split on newlines first,
  // then fall back to commas/semicolons if it's all on one line.
  let lines = block.split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /[;,]/.test(lines[0])) {
    lines = lines[0].split(/[;,]/).map((l) => l.trim()).filter(Boolean);
  }
  for (let line of lines) {
    line = stripMarkers(line);
    if (!line) continue;
    // Skip lines that are obviously not names (labels, urls, emails, phones).
    if (/https?:\/\/|@|\d{3,}|:/.test(line)) continue;
    // A plausible name is 1–4 words of letters/apostrophes/hyphens.
    const wordCount = line.split(/\s+/).length;
    if (wordCount > 4) continue;
    if (!/[A-Za-z]/.test(line)) continue;
    const cleaned = normalizeName(line);
    if (cleaned.firstName) names.push(cleaned);
  }
  return names;
}

// Light normalization: trim stray leading letters/typos are LEFT mostly intact
// (we don't want to "correct" a real name into the wrong one), but we fix casing
// and split into first/last.
function normalizeName(raw) {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const parts = collapsed.split(' ');
  const titleCase = (s) =>
    s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;

  let firstName = '';
  let lastName = '';
  if (parts.length === 1) {
    firstName = titleCase(parts[0]);
  } else {
    firstName = titleCase(parts[0]);
    // keep internal capitals for names like O'Donnell -> O'donnell handled simply
    lastName = parts.slice(1).map(titleCase).join(' ');
  }
  return { firstName, lastName, raw: collapsed };
}

function dedupeNames(names) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    // Normalize the key hard: lowercase, strip whitespace AND punctuation
    // (apostrophes, hyphens, periods) so "O'donnell" == "Odonnell".
    const key = (n.firstName + '|' + n.lastName)
      .toLowerCase()
      .replace(/[\s'’.\-]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function parseGuestMeta(notes) {
  // Stop the captured value at the next known label or the gate block, since
  // Hostfully notes often have no real newlines.
  const STOP = '(?=\\s+(?:Guest\\s+(?:Email|Phone|Zip\\s+Code|First\\s+Name|Last\\s+Name)|CA_PRE_ARRIVAL|CA\\s+Online|Drivers?\\s+Names?)\\b|$)';
  const grab = (label) => {
    const re = new RegExp(label + '\\s*:?\\s*(.+?)' + STOP, 'i');
    const m = notes.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    firstName: grab('Guest First Name'),
    lastName: grab('Guest Last Name'),
    email: grab('Guest Email'),
    phone: grab('Guest Phone'),
  };
}

// Build a name object from the parsed guest meta, so the primary guest is
// always added to the gate (deduped against any matching driver entry).
function guestAsName(guest) {
  if (!guest || (!guest.firstName && !guest.lastName)) return null;
  return normalizeName(`${guest.firstName} ${guest.lastName}`.trim());
}

function parseGateNames(notes) {
  const guest = parseGuestMeta(notes || '');
  const guestName = guestAsName(guest);

  if (!notes || !GATE_HEADER.test(notes)) {
    // No driver block — still add the guest if we have a name.
    return {
      names: dedupeNames(guestName ? [guestName] : []),
      guest,
    };
  }

  // Robust block split: cut the notes at each header occurrence.
  const headerRe = new RegExp(GATE_HEADER.source, 'gi');
  const cutPoints = [];
  let m;
  while ((m = headerRe.exec(notes)) !== null) {
    cutPoints.push({ start: m.index, after: m.index + m[0].length });
  }

  const blocks = cutPoints.map((cp, i) => {
    const end = i + 1 < cutPoints.length ? cutPoints[i + 1].start : notes.length;
    return notes.slice(cp.after, end);
  });

  const parsed = blocks.map(parseList);

  // Strategy: prefer the LAST block; if it has fewer names than the longest
  // block, fall back to the longest (guards against a truncated final edit).
  const last = parsed[parsed.length - 1] || [];
  const longest = parsed.reduce((a, b) => (b.length > a.length ? b : a), []);
  const chosen = last.length >= longest.length ? last : longest;

  // Always include the primary guest, listed first; dedupe drops any driver
  // entry that is the same person as the guest.
  const withGuest = guestName ? [guestName, ...chosen] : chosen;

  return {
    names: dedupeNames(withGuest),
    guest,
    blockCount: blocks.length,
  };
}

module.exports = { parseGateNames, normalizeName, dedupeNames };

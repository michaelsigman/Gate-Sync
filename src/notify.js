'use strict';

/**
 * Failure alerts by email (SendGrid HTTP API; SMS later).
 *   SENDGRID_API_KEY  — required to send
 *   ALERT_EMAIL_FROM  — a SendGrid-verified sender
 *   ALERT_EMAIL_TO    — defaults to mike@poolautopilot.com
 * Best-effort: never throws. Without a key it logs and reports { sent:false, reason }.
 */

const axios = require('axios');

const DEFAULT_TO = 'mike@poolautopilot.com';

function configured() {
  return !!(process.env.SENDGRID_API_KEY && process.env.ALERT_EMAIL_FROM);
}

async function sendEmail({ subject, text }) {
  if (!configured()) {
    console.warn(`[notify] email not configured (SENDGRID_API_KEY / ALERT_EMAIL_FROM) — not sent: ${subject}`);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: process.env.ALERT_EMAIL_TO || DEFAULT_TO }] }],
      from: { email: process.env.ALERT_EMAIL_FROM, name: 'Gate Pilot' },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }, { headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` }, timeout: 10000 });
    return { sent: true };
  } catch (e) {
    console.warn('[notify] email failed:', e.response ? e.response.status : e.message);
    return { sent: false, reason: 'error', error: String(e.message).slice(0, 200) };
  }
}

/** One email per sweep listing the failures that sweep produced. */
async function emailFailures(failures, { dashboardUrl } = {}) {
  if (!failures.length) return { sent: false, reason: 'nothing_to_send' };
  const lines = failures.map((f) =>
    `• ${f.property} — ${f.name} → ${f.gateLabel} (${f.gate}), stay ${f.arrivalDate} → ${f.departureDate}\n` +
    `  attempt ${f.attempt} of ${f.maxAttempts}${f.gaveUp ? ' — GIVING UP, add this one by hand' : ''}\n  reason: ${f.reason}`);
  const gaveUp = failures.filter((f) => f.gaveUp).length;
  return sendEmail({
    subject: `Gate Pilot: ${failures.length} gate add${failures.length === 1 ? '' : 's'} failed${gaveUp ? ` (${gaveUp} out of retries)` : ''}`,
    text: `These guests could not be added to the gate:\n\n${lines.join('\n\n')}\n\n` +
      (dashboardUrl ? `Dashboard: ${dashboardUrl}\n` : '') +
      'Failures are retried on the next sweeps (up to the attempt limit).',
  });
}

module.exports = { configured, sendEmail, emailFailures };

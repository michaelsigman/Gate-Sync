'use strict';

/**
 * Report a live result back to ArrivalPilot (gateSyncReport, same GATE_SYNC_TOKEN).
 * Sets reservations/{rid}.gate_registration.status to 'added' | 'failed' — only for the exact
 * driver-list version (driversUpdatedAt) gate-sync acted on; the backend refuses stale versions.
 *   AP_REPORT_URL — defaults to the feed URL with gateSyncFeed → gateSyncReport
 * Best-effort: never throws.
 */

const axios = require('axios');

function reportUrl() {
  if (process.env.AP_REPORT_URL) return process.env.AP_REPORT_URL;
  const feed = process.env.AP_FEED_URL || '';
  return /gateSyncFeed\/?$/.test(feed) ? feed.replace(/gateSyncFeed\/?$/, 'gateSyncReport') : '';
}

async function reportResult({ reservationId, driversUpdatedAt, result, error }) {
  const url = reportUrl();
  if (!url || !process.env.GATE_SYNC_TOKEN) return { sent: false, reason: 'not_configured' };
  if (!driversUpdatedAt) return { sent: false, reason: 'no_version' }; // legacy notes stays have no gate_registration
  try {
    const res = await axios.post(url, { reservationId, driversUpdatedAt, result, error: error || undefined }, {
      headers: { Authorization: `Bearer ${process.env.GATE_SYNC_TOKEN}` },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status >= 400) console.warn(`[apReport] ${reservationId} ${result} -> HTTP ${res.status}`, JSON.stringify(res.data).slice(0, 200));
    return { sent: true, httpStatus: res.status, ok: res.status < 400, body: res.data };
  } catch (e) {
    console.warn('[apReport] failed:', e.message);
    return { sent: false, reason: 'error', error: String(e.message).slice(0, 200) };
  }
}

module.exports = { reportUrl, reportResult };

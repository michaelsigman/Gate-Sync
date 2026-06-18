'use strict';

const axios = require('axios');

/**
 * Hostfully client — matches the pattern already used in the BookedUp
 * onboarding/webhook code.
 *
 * Auth:    header  X-HOSTFULLY-APIKEY: <key>
 * Base:    https://api.hostfully.com/api/v3   (production; note the /api segment)
 * Leads:   GET /leads?agencyUid=<uid>&checkInFrom=YYYY-MM-DD&checkInTo=YYYY-MM-DD
 *          In Hostfully, a "reservation" is a Lead. Confirmed bookings are leads
 *          with status BOOKED / PAID_IN_FULL.
 *
 * The /leads filter supports checkInFrom & checkInTo (inclusive dates), so we
 * set both to tomorrow to get same-day arrivals.
 */
class HostfullyClient {
  constructor({
    apiKey,
    agencyUid,
    baseURL = 'https://api.hostfully.com/api/v3',
    logger = console,
  }) {
    this.log = logger;
    this.agencyUid = agencyUid;
    this.http = axios.create({
      baseURL,
      timeout: 20000,
      headers: {
        'X-HOSTFULLY-APIKEY': apiKey,
        Accept: 'application/json',
      },
    });
  }

  // Normalize a Hostfully lead object into the shape the orchestrator expects.
  static normalizeLead(l) {
    // v3 leads expose check-in/out as date and/or zoned datetime fields.
    const arrival =
      l.checkInDate || l.arrivalDate ||
      (l.checkInZonedDateTime || l.checkInLocalDateTime || '').slice(0, 10);
    const departure =
      l.checkOutDate || l.departureDate ||
      (l.checkOutZonedDateTime || l.checkOutLocalDateTime || '').slice(0, 10);
    // Driver names may be appended to notes OR extraNotes by Charge Automation.
    const notes = [l.notes, l.extraNotes].filter(Boolean).join('\n');
    return {
      reservationId: l.uid || l.leadUid || l.id,
      propertyUid: l.propertyUid,
      arrivalDate: arrival,
      departureDate: departure,
      status: l.status,
      type: l.type,
      notes,
    };
  }

  // STRICT allowlist: only a confirmed BOOKED reservation flows to a gate.
  // Anything else (inquiries, holds, blocks, cancellations, even paid-status
  // variants) is excluded by default — safest posture for gate access.
  static isActiveBooking(l) {
    return (l.type || '').toUpperCase() === 'BOOKING' &&
      (l.status || '').toUpperCase() === 'BOOKED';
  }

  async getReservationsArriving(dateYYYYMMDD, { logger } = {}) {
    const res = await this.http.get('/leads', {
      params: {
        agencyUid: this.agencyUid,
        checkInFrom: dateYYYYMMDD,
        checkInTo: dateYYYYMMDD,
        _limit: 100,
      },
    });
    const leads = res.data?.leads || res.data?.data || res.data || [];
    const list = Array.isArray(leads) ? leads : [];

    // Log what we exclude so a wrongly-skipped real booking is visible.
    if (logger) {
      list
        .filter((l) => !HostfullyClient.isActiveBooking(l))
        .forEach((l) =>
          logger.info(
            `[hostfully] excluded ${l.uid} — status=${l.status} type=${l.type}`
          )
        );
    }

    return list
      .filter(HostfullyClient.isActiveBooking)
      .map(HostfullyClient.normalizeLead)
      .filter((r) => (r.arrivalDate || '').startsWith(dateYYYYMMDD));
  }

  /**
   * List all properties for the agency, with address. Used by the mapping
   * helper. Endpoint mirrors the onboarding app's properties call.
   */
  async listProperties() {
    const res = await this.http.get('/properties', {
      params: { agencyUid: this.agencyUid, _limit: 1000 },
    });
    const items = res.data?.properties || res.data?.data || res.data || [];
    const list = Array.isArray(items) ? items : [];
    return list.map((p) => {
      const a = p.address || {};
      const addressStr =
        typeof a === 'string'
          ? a
          : [a.address, a.address2, a.city, a.state, a.zipCode || a.zip]
              .filter(Boolean)
              .join(', ');
      return {
        propertyUid: p.uid || p.id,
        name: p.name || p.title || '',
        address: addressStr,
      };
    });
  }
}

module.exports = { HostfullyClient };

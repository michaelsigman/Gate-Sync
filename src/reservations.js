'use strict';

/**
 * Where reservations come from, and what names belong on the gate for each.
 *
 * Default source is ArrivalPilot's read-only gateSyncFeed (Hospitable-synced, since BookedUp left
 * Hostfully ~Sept 1). Set AP_FEED_URL + GATE_SYNC_TOKEN. RESERVATION_SOURCE=hostfully falls back to
 * the old Hostfully-notes path.
 *
 * Both sources return the same shape:
 *   { reservationId, propertyUid, arrivalDate, departureDate, status, notes, drivers?, guest?, inHouse? }
 */

const axios = require('axios');
const { HostfullyClient } = require('./hostfullyClient');
const { parseGateNames } = require('./parseNotes');

function sourceName() {
  const s = String(process.env.RESERVATION_SOURCE || '').toLowerCase();
  if (s === 'hostfully' || s === 'arrivalpilot') return s;
  return process.env.AP_FEED_URL ? 'arrivalpilot' : 'hostfully';
}

class ArrivalPilotFeed {
  constructor({ url = process.env.AP_FEED_URL, token = process.env.GATE_SYNC_TOKEN } = {}) {
    if (!url || !token) throw new Error('ArrivalPilot feed needs AP_FEED_URL and GATE_SYNC_TOKEN');
    this.http = axios.create({ baseURL: url, timeout: 20000, headers: { Authorization: `Bearer ${token}` } });
  }

  async getReservationsInRange(from, to) {
    const res = await this.http.get('', { params: { from, to } });
    return (res.data.reservations || []).map((r) => ({
      reservationId: r.reservationId,
      propertyUid: r.propertyUid,
      arrivalDate: r.arrivalDate,
      departureDate: r.departureDate,
      status: r.status,
      notes: r.legacyNotes || '',
      drivers: r.drivers || [],
      driversUpdatedAt: r.driversUpdatedAt || null,
      guest: r.guest || null,
      inHouse: !!r.inHouse,
    }));
  }

  async getReservationsArriving(day) {
    return (await this.getReservationsInRange(day, day)).filter((r) => r.arrivalDate === day);
  }
}

function makeSource() {
  if (sourceName() === 'arrivalpilot') return new ArrivalPilotFeed();
  return new HostfullyClient({ apiKey: process.env.HOSTFULLY_API_KEY, agencyUid: process.env.HOSTFULLY_AGENCY_UID });
}

/**
 * Names for the gate, plus the booking guest and whether a driver list exists.
 * Guest-submitted drivers (ArrivalPilot gate_registration) win; otherwise parse the legacy notes
 * block, which also lists the booking guest first.
 */
function gateNamesFor(r) {
  if (Array.isArray(r.drivers) && r.drivers.length) {
    return {
      names: r.drivers.map((d) => ({ firstName: d.firstName, lastName: d.lastName, plate: d.plate || null })),
      guest: r.guest || null,
      blockCount: 1,
      source: 'guest_form',
    };
  }
  const parsed = parseGateNames(r.notes || '');
  return { ...parsed, guest: parsed.guest && (parsed.guest.firstName || parsed.guest.lastName) ? parsed.guest : r.guest || parsed.guest, source: parsed.blockCount ? 'pms_notes' : 'none' };
}

module.exports = { sourceName, makeSource, gateNamesFor, ArrivalPilotFeed };

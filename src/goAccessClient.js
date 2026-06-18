'use strict';

const axios = require('axios');

/**
 * GoAccessControl gate adapter.
 *
 * Much cleaner than Proptia: a real REST API.
 *   1. POST to Supabase /auth/v1/token?grant_type=password -> bearer access_token
 *   2. Authorization: Bearer <token> on all backend calls
 *   3. POST /api/v1/visitors to add a guest (returns 201 + a PIN)
 *
 * Per-property config carries household_id (the property), visitorTypeId
 * (the "Guest" type), and communityId.
 */

const SUPABASE_URL = 'https://nhzvvrsfmtnsyabdhjsd.supabase.co';
const BACKEND = 'https://backend-356131498600.us-west2.run.app';

// Public anon key — REQUIRED by Supabase as the `apikey` header on auth calls.
// This is the client-side publishable key (safe to ship); it is NOT the user's
// password and grants nothing on its own. If auth 401s, re-capture it from the
// login request's `apikey` header and set GOACCESS_ANON_KEY in env.
const ANON_KEY = process.env.GOACCESS_ANON_KEY || '';

class GoAccessClient {
  constructor({ username, password, logger = console }) {
    this.username = username;
    this.password = password;
    this.log = logger;
    this.token = null;
    this.refreshToken = null;
    this.http = axios.create({ timeout: 20000 });
  }

  async login() {
    const res = await this.http.post(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      { email: this.username, password: this.password, gotrue_meta_security: {} },
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
        },
      }
    );
    this.token = res.data.access_token;
    this.refreshToken = res.data.refresh_token;
    if (!this.token) throw new Error('GoAccess login returned no access_token');
    this.log.info('[goaccess] logged in');
    return true;
  }

  _auth() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  /**
   * Returns the households this account manages, each with its address. Used by
   * the mapping helper to auto-suggest property matches.
   * Shape (confirmed from HAR): data.data.household_info[] each having
   * { household_id, community_id, address }.
   */
  async listHouseholds(residentId) {
    const res = await this.http.get(
      `${BACKEND}/api/v1/residents/${residentId}`,
      { headers: this._auth() }
    );
    const root = res.data?.data?.data || res.data?.data || res.data || {};
    const households = root.household_info || [];
    return households.map((h) => ({
      householdId: h.household_id || h.id,
      communityId: h.community_id,
      address: h.address || '',
      lotNumber: h.lot_number || '',
    }));
  }

  /**
   * List current visitors for a household so we can dedupe. The portal lists
   * per-resident; we filter to this household and to currently-valid passes.
   */
  async listVisitors(prop) {
    // The resident endpoint returns the household's visitors.
    const res = await this.http.get(
      `${BACKEND}/api/v1/residents/${prop.residentId}`,
      { headers: this._auth() }
    );
    // Shape is { data: { data: {... visitors: [...] }}} in this API; be defensive.
    const body = res.data?.data?.data || res.data?.data || res.data || {};
    const visitors = body.visitors || body.household?.visitors || [];
    return Array.isArray(visitors) ? visitors : [];
  }

  /**
   * Add one guest. Dates are the stay window; we send local-midnight-to-
   * local-end in UTC (07:00Z ~ midnight PDT) to match the captured request.
   */
  async addGuest(prop, guest, { startISO, endISO }) {
    const payload = {
      name: `${guest.firstName} ${guest.lastName || ''}`.trim(),
      first_name: '',
      last_name: '',
      visitor_type: prop.visitorTypeId,
      key_clearance: false,
      start_date: startISO,
      end_date: endISO,
      notes: '',
      requested_by: '',
      type: 'Guest',
      banned: false,
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
      visitor_profiles: [],
      photos: [],
      household_id: prop.householdId,
      source_gate_id: null,
    };

    const res = await this.http.post(`${BACKEND}/api/v1/visitors`, payload, {
      headers: this._auth(),
      validateStatus: () => true, // capture all statuses so we can read errors
    });

    if (res.status >= 400) {
      const body =
        typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const err = new Error(
        `GoAccess add failed ${res.status}: ${body ? body.slice(0, 300) : '(no body)'}`
      );
      err.status = res.status;
      throw err;
    }

    const data = res.data?.data?.data || res.data?.data || res.data || {};
    return { ok: res.status === 201 || res.status === 200, status: res.status, pin: data.pin };
  }
}

module.exports = { GoAccessClient };

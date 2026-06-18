'use strict';

const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const axios = require('axios');
const FormData = require('form-data');

/**
 * ProptiaClient drives the resident portal the same way a browser does:
 *   1. GET the login page -> scrape csrfmiddlewaretoken
 *   2. POST credentials -> hold the Django session cookie in a jar
 *   3. For each add: GET the add-guest page -> scrape a fresh CSRF token
 *      -> POST multipart/form-data mirroring the captured request
 *
 * There is no official API; this is session automation. Keep one client
 * instance per run (one login, many properties).
 */

const BASE = 'https://portal.proptia.com';

class ProptiaClient {
  constructor({ username, password, logger = console }) {
    this.username = username;
    this.password = password;
    this.log = logger;
    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        jar: this.jar,
        baseURL: BASE,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    );
  }

  static scrapeCsrf(html) {
    const m = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

  // Scrape the actual <input name="..."> for the email & password fields, so we
  // don't depend on guessing Django field names. Falls back to common names.
  static scrapeFieldNames(html) {
    const emailMatch =
      html.match(/<input[^>]*type=["']email["'][^>]*name=["']([^"']+)["']/i) ||
      html.match(/<input[^>]*name=["']([^"']*(?:email|username|login)[^"']*)["']/i);
    const passMatch =
      html.match(/<input[^>]*type=["']password["'][^>]*name=["']([^"']+)["']/i) ||
      html.match(/<input[^>]*name=["']([^"']*password[^"']*)["']/i);
    return {
      emailField: emailMatch ? emailMatch[1] : 'username',
      passField: passMatch ? passMatch[1] : 'password',
    };
  }

  async login() {
    // Real Proptia login path (confirmed): /en-us/proptia/accounts/login/
    const loginPath = process.env.PROPTIA_LOGIN_PATH || '/en-us/proptia/accounts/login/';
    const page = await this.http.get(loginPath + '?next=/en-us/', {
      // follow the GET (200) so we can scrape the form
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = page.data;
    const csrf = ProptiaClient.scrapeCsrf(html);
    if (!csrf) throw new Error('Could not find CSRF token on Proptia login page');
    const { emailField, passField } = ProptiaClient.scrapeFieldNames(html);

    const form = new URLSearchParams();
    form.append('csrfmiddlewaretoken', csrf);
    form.append(emailField, this.username);
    form.append(passField, this.password);
    form.append('next', '/en-us/');
    // "Remember Me" is optional; include it harmlessly.
    form.append('remember', 'on');

    const res = await this.http.post(loginPath, form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: BASE + loginPath,
        Origin: BASE,
      },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
    });

    // Success: Django issues a 302 to the dashboard/chooser. A 200 that returns
    // the login page again usually means bad credentials.
    if (res.status === 200 && /name=["']csrfmiddlewaretoken["']/.test(res.data || '')) {
      throw new Error('Proptia login failed — returned login page again (check credentials)');
    }
    if (res.status !== 302 && res.status !== 200) {
      throw new Error('Proptia login unexpected status: ' + res.status);
    }
    this.log.info('[proptia] logged in');
    return true;
  }

  /**
   * Fetch current visitors for a property via the DataTables JSON endpoint
   * (entry 76 in the HAR). Returns an array of { uuid, first_name, last_name, ... }.
   * Used to dedupe so re-runs don't create duplicate passes.
   */
  async listVisitors({ communityId, propertyId, unitId }) {
    // Proptia's DataTables endpoint requires the full columns[...] parameter set;
    // a stripped query returns 500. Build the 10-column payload it expects.
    const colNames = [
      'guest_type', 'first_name', 'last_name', 'approved_thru_date',
      'company', 'active_pass_count', 'vehicle_license_plate', 'user', '', '',
    ];
    const params = new URLSearchParams();
    params.append('draw', '1');
    colNames.forEach((name, i) => {
      params.append(`columns[${i}][data]`, name);
      params.append(`columns[${i}][name]`, name);
      params.append(`columns[${i}][searchable]`, 'true');
      params.append(`columns[${i}][orderable]`, 'true');
      params.append(`columns[${i}][search][value]`, '');
      params.append(`columns[${i}][search][regex]`, 'false');
    });
    params.append('order[0][column]', '0');
    params.append('order[0][dir]', 'asc');
    params.append('order[0][name]', 'guest_type');
    params.append('start', '0');
    params.append('length', '200');
    params.append('search[value]', '');
    params.append('search[regex]', 'false');
    params.append('_', String(Date.now()));

    const url =
      `/en-us/visitor/individual_table/v2/${communityId}/${propertyId}/${unitId}` +
      `?${params.toString()}`;
    const res = await this.http.get(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return data.data || [];
  }

  /**
   * Add one temporary guest pass. Mirrors the captured multipart POST field-for-field.
   * `prop` carries the per-property UUIDs; `guest` is { firstName,lastName,plate? }.
   */
  async addGuest(prop, guest, { arrivalMMDDYYYY, departureMMDDYYYY }) {
    const { memberId, communityId, propertyId, unitId, passName } = prop;
    const addPath =
      `/en-us/resident/resident/${memberId}/visitors/${communityId}` +
      `/add/${propertyId}/${unitId}`;
    const nextPath =
      `/en-us/resident/resident/dashboard/${communityId}/${propertyId}/${unitId}`;

    // Fresh CSRF from the add-guest form page.
    const page = await this.http.get(addPath + `?next=${encodeURIComponent(nextPath)}`);
    const csrf = ProptiaClient.scrapeCsrf(page.data);
    if (!csrf) throw new Error('No CSRF token on add-guest page for ' + memberId);

    const fd = new FormData();
    fd.append('csrfmiddlewaretoken', csrf);
    fd.append('guest_type', 'TEMPORARY');
    fd.append('visitor_of', 'INDIVIDUAL');
    fd.append('event_visitor', 'new_list');
    fd.append('visitor_type', 'GUEST');
    fd.append('pass_name', passName);
    fd.append('event', '');
    fd.append('limit_event_approval', '0');
    fd.append('limit_member_event_approval', '');
    fd.append('restricted_visitor', 'new');
    fd.append('visitor', '');
    fd.append('imported_guests_json', '');
    fd.append('event_list_update', '');
    fd.append('first_name', guest.firstName);
    fd.append('last_name', guest.lastName || '');
    fd.append('email', '');
    fd.append('phone', '');
    fd.append('company', '');
    fd.append('vehicle_license_plate', guest.plate || '');
    fd.append('vehicle_space_input', '');
    fd.append('notes', '');
    fd.append('identification', '');
    for (const d of ['1', '2', '3', '4', '5', '6', '7']) {
      fd.append('valid_pass_days_of_week', d);
    }
    fd.append('arrival_date_time', arrivalMMDDYYYY);
    fd.append('departure_date_time', departureMMDDYYYY);
    fd.append('approved_thru_date', departureMMDDYYYY);
    fd.append('event_date', '');
    fd.append('event_time_start', '');
    fd.append('event_time_end', '');
    fd.append('total_duration', '');

    const res = await this.http.post(
      addPath + `?next=${encodeURIComponent(nextPath)}`,
      fd,
      {
        headers: {
          ...fd.getHeaders(),
          Referer: BASE + addPath,
          Origin: BASE,
        },
      }
    );
    // Success is a 302 back to the dashboard.
    const ok = res.status === 302;
    return { ok, status: res.status };
  }
}

module.exports = { ProptiaClient };

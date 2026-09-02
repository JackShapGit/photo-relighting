// Venue endpoints (Spec 2). Workspace-scoped like scenes: every URL goes
// through api.js's wsUrl so a ?ws= namespace applies here too. Re-exported
// from api.js so callers keep a single import.
import { wsUrl } from '../api.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function jsonOrThrow(r, label) {
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(`${label}: ${r.status} ${text}`);
    err.status = r.status;
    try { err.body = JSON.parse(text); } catch { /* not JSON */ }
    throw err;
  }
  return r.json();
}

export async function listVenues() {
  return jsonOrThrow(await fetch(wsUrl('/venues')), '/venues');
}

export async function createVenue(venue) {
  return jsonOrThrow(await fetch(wsUrl('/venues'), {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(venue),
  }), '/venues POST');
}

export async function getVenue(id) {
  return jsonOrThrow(await fetch(wsUrl(`/venues/${id}`)), `/venues/${id}`);
}

export async function updateVenue(id, venue) {
  return jsonOrThrow(await fetch(wsUrl(`/venues/${id}`), {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(venue),
  }), '/venues PUT');
}

/** Resolves { ok: true }; a 409 (venue still referenced by scenes) rejects
 * with err.status === 409 and err.body.scene_count unless { force: true }. */
export async function deleteVenue(id, { force = false } = {}) {
  const path = force ? `/venues/${id}?force=1` : `/venues/${id}`;
  return jsonOrThrow(await fetch(wsUrl(path), { method: 'DELETE' }), '/venues DELETE');
}

export async function duplicateVenue(id, name) {
  return jsonOrThrow(await fetch(wsUrl(`/venues/${id}/duplicate`), {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name }),
  }), '/venues duplicate');
}

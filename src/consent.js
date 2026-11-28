// Who has to be asked before any analytics runs. Pure logic, no browser APIs,
// so it can be tested in Node.
//
// The EU, the wider EEA, the UK and Switzerland require consent before an
// analytics cookie is set. A static page cannot see where a visitor is, so the
// browser's time zone stands in for location. It errs toward asking: every
// "Europe/..." zone is treated as needing consent, including the few European
// countries where the law does not strictly require it.

// Countries covered by those rules, as ISO 3166-1 codes. Also handed to Google
// as a second line of defence: for visitors Google itself places in these
// countries, analytics storage stays off until they agree.
export const CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'GB', 'CH',
];

// Zones that belong to those countries but are not named "Europe/...".
const OTHER_ZONES = new Set([
  'Atlantic/Reykjavik', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Azores',
  'Atlantic/Faroe', 'Atlantic/Jan_Mayen', 'Arctic/Longyearbyen', 'Africa/Ceuta',
  'Asia/Nicosia', 'Asia/Famagusta',
  // French and Dutch overseas territories where EU law applies
  'America/Cayenne', 'America/Guadeloupe', 'America/Martinique', 'America/Marigot',
  'Indian/Reunion', 'Indian/Mayotte',
]);

/** True when the visitor must opt in before analytics may load. */
export function requiresOptIn(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return true; // unknown: ask
  return timeZone.startsWith('Europe/') || OTHER_ZONES.has(timeZone);
}

/**
 * What to do on page load.
 *   stored:  'granted' | 'denied' | 'notified' | null
 *            the visitor's saved choice; 'notified' means they were told that
 *            counting is on and did not turn it off
 *   optIn:   result of requiresOptIn()
 *   gpc:     the browser is sending a Global Privacy Control signal
 * Returns { load, ask, notice }:
 *   load    start analytics now
 *   ask     show the question and wait for an answer (nothing loads meanwhile)
 *   notice  analytics is running; tell the visitor and offer to turn it off
 */
export function decide({ stored, optIn, gpc }) {
  if (stored === 'granted') return { load: true, ask: false, notice: false };
  if (stored === 'notified' && !optIn && !gpc) return { load: true, ask: false, notice: false };
  if (stored === 'denied') return { load: false, ask: false, notice: false };
  if (gpc) return { load: false, ask: false, notice: false }; // a standing "no"
  if (optIn) return { load: false, ask: true, notice: false };
  return { load: true, ask: false, notice: true };
}

// Visit counting with Google Analytics 4.
//
// Set MEASUREMENT_ID to the "G-..." id of the GA4 web data stream. While it is
// empty this module does nothing at all: no script, no cookie, no notice.
//
// Rules it follows:
//   - Visitors in Europe (see consent.js) are asked first. Nothing is loaded
//     from Google until they say yes.
//   - Visitors elsewhere are counted straight away, told so once, and can turn
//     it off.
//   - A browser sending Global Privacy Control is treated as a "no".
//   - The choice is remembered, and can be changed any time from the
//     "Visit counting" link under the controls.
//   - Advertising features are switched off in every case.
import { CONSENT_REGIONS, requiresOptIn, decide } from './consent.js';

export const MEASUREMENT_ID = 'G-R4PDR1TFVT';

const KEY = 'swinglab.analytics';
let active = false; // the Google script has been requested and counting is on
let scriptAdded = false;
let panel = null;

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function remember(value) {
  try { localStorage.setItem(KEY, value); } catch { /* private mode: ask again next time */ }
}
function gtag() {
  // Google's tag expects the arguments object itself, not an array
  window.dataLayer.push(arguments); // eslint-disable-line prefer-rest-params
}

// agreed: the visitor has said yes in so many words, as opposed to being
// counted by default outside Europe
function start(agreed) {
  window[`ga-disable-${MEASUREMENT_ID}`] = false;
  if (!scriptAdded) {
    scriptAdded = true;
    window.dataLayer = window.dataLayer || [];
    const noAds = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' };
    gtag('consent', 'default', { ...noAds, analytics_storage: 'granted' });
    gtag('consent', 'default', { ...noAds, analytics_storage: 'denied', region: CONSENT_REGIONS });
    if (agreed) gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
    document.head.appendChild(s);
  } else if (agreed) {
    gtag('consent', 'update', { analytics_storage: 'granted' });
  }
  active = true;
}

function stop() {
  active = false;
  window[`ga-disable-${MEASUREMENT_ID}`] = true;
  if (scriptAdded) gtag('consent', 'update', { analytics_storage: 'denied' });
  // remove the cookies Google Analytics set for this site
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0].trim();
    if (name === '_ga' || name.startsWith('_ga_')) {
      for (const domain of ['', `; domain=${location.hostname}`, `; domain=.${location.hostname}`]) {
        document.cookie = `${name}=; Max-Age=0; path=/${domain}`;
      }
    }
  }
}

function choose(value) {
  remember(value);
  if (value === 'granted') start(true);
  else stop();
  closePanel();
}

function closePanel() {
  if (panel) { panel.remove(); panel = null; }
}

// mode: 'ask' (nothing running, waiting for an answer), 'notice' (running, say
// so once) or 'settings' (reopened by the visitor to review the choice)
function openPanel(mode) {
  closePanel();
  panel = document.createElement('section');
  panel.className = 'consent';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Visit counting');
  const p = document.createElement('p');
  const what = 'It uses Google Analytics, which sets a cookie, to see how many people come by and which deliveries they try. Nothing is used for advertising.';
  const row = document.createElement('div');
  row.className = 'consent-actions';
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = label;
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  };
  if (mode === 'ask') {
    p.textContent = `Can Swing Lab count your visit? ${what}`;
    button('Count my visit', () => choose('granted'));
    button('No thanks', () => choose('denied'));
  } else if (mode === 'notice') {
    p.textContent = `Swing Lab counts visits. ${what}`;
    button('Fine by me', () => choose('granted'));
    button('Turn it off', () => choose('denied'));
  } else {
    p.textContent = `Visit counting is ${active ? 'on' : 'off'}. ${what}`;
    if (active) button('Turn it off', () => choose('denied'));
    else button('Turn it on', () => choose('granted'));
    button('Close', closePanel);
  }
  panel.append(p, row);
  document.body.appendChild(panel);
}

/** Start visit counting according to the rules above. Call once on page load. */
export function initAnalytics({ settingsLink } = {}) {
  if (!MEASUREMENT_ID) return;
  let timeZone = null;
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* treated as unknown */ }
  const plan = decide({
    stored: stored(),
    optIn: requiresOptIn(timeZone),
    gpc: navigator.globalPrivacyControl === true,
  });
  if (plan.load) start(stored() === 'granted');
  if (plan.ask) openPanel('ask');
  else if (plan.notice) {
    openPanel('notice');
    remember('notified'); // say it once, not on every visit
  }
  if (settingsLink) {
    settingsLink.hidden = false;
    settingsLink.addEventListener('click', () => openPanel('settings'));
  }
}

/** Count something a visitor did. Silently ignored unless counting is on. */
export function track(name, params = {}) {
  if (!active || !MEASUREMENT_ID) return;
  gtag('event', name, params);
}

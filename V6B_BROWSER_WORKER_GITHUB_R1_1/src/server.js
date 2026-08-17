'use strict';

const http = require('node:http');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = intEnv('PORT', 3000, 1, 65535);
const NAVIGATION_TIMEOUT_MS = intEnv('NAVIGATION_TIMEOUT_MS', 20000, 1000, 30000);
const FORM_READY_TIMEOUT_MS = intEnv('FORM_READY_TIMEOUT_MS', 8000, 1000, 15000);
const POST_CLICK_TIMEOUT_MS = intEnv('POST_CLICK_TIMEOUT_MS', 12000, 1000, 20000);
const HARD_TIMEOUT_MS = intEnv('HARD_TIMEOUT_MS', 45000, 5000, 60000);
const MAX_BODY_BYTES = intEnv('MAX_BODY_BYTES', 65536, 4096, 262144);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '/artifacts';
const TOKEN = String(process.env.BROWSER_WORKER_TOKEN || '');

const ALLOWED_MAPPINGS = new Set([
  'SENDER_NAME',
  'SENDER_EMAIL',
  'SENDER_COMPANY',
  'SENDER_PHONE',
  'SUBJECT',
  'MESSAGE',
  'WEBSITE',
]);

const BLOCKED_INTERNAL_HOSTS = new Set([
  'localhost',
  'n8n',
  'browser-worker',
  'host.docker.internal',
  'gateway.docker.internal',
  ...String(process.env.BLOCKED_INTERNAL_HOSTNAMES || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean),
]);

const SUCCESS_PHRASES = [
  ['MESSAGE_ENVOYE', 'message envoyé'],
  ['MESSAGE_A_ETE_ENVOYE', 'message a été envoyé'],
  ['MESSAGE_A_BIEN_ETE_ENVOYE', 'message a bien été envoyé'],
  ['VOTRE_MESSAGE_A_BIEN_ETE_ENVOYE', 'votre message a bien été envoyé'],
  ['MERCI_MESSAGE', 'merci pour votre message'],
  ['MERCI_CONTACT', 'merci de nous avoir contactés'],
  ['THANK_YOU_MESSAGE', 'thank you for your message'],
  ['MESSAGE_SENT', 'message sent'],
  ['SUCCESSFULLY_SENT', 'successfully sent'],
];

const FAILURE_PHRASES = [
  ['REQUIRED_FIELD_FR', 'champ obligatoire'],
  ['REQUIRED_FIELD_EN', 'required field'],
  ['VALIDATION_ERROR_FR', 'erreur de validation'],
  ['VALIDATION_ERROR_EN', 'validation error'],
  ['INVALID_EMAIL_FR', 'email invalide'],
  ['INVALID_EMAIL_FR_2', 'adresse email invalide'],
  ['INVALID_EMAIL_EN', 'invalid email'],
  ['INVALID_EMAIL_EN_2', 'email is invalid'],
  ['FAILED_TO_SEND', 'failed to send'],
  ['ERROR_SENDING', 'error sending'],
  ['GENERIC_ERROR_FR', 'une erreur est survenue'],
];

const PURPOSE_SIGNALS = [
  ['SUPPORT', ['support', 'service apres vente', 'service après vente', 'service client', 'customer service', 'customer support', 'assistance client']],
  ['CANDIDATE', ['candidature', 'recrutement', 'rejoignez-nous', 'rejoignez nous', 'carriere', 'carrière', 'careers', 'job application', 'apply for a job']],
  ['NEWSLETTER', ['newsletter', 'subscribe to our newsletter', 'inscription newsletter']],
  ['LOGIN', ['se connecter', 'connexion client', 'espace client', 'login', 'sign in', 'mot de passe', 'password']],
  ['EMERGENCY', ['urgence', 'emergency']],
  ['QUOTE_REQUEST', ['demande de devis', 'obtenir un devis', 'request a quote', 'quote request']],
  ['SALES_CONTACT', ['contact commercial', 'contacter un commercial', 'parler a un commercial', 'sales contact', 'contact sales', 'talk to sales']],
];

let browser = null;
let busy = false;
let shuttingDown = false;

if (TOKEN.length < 32) {
  console.error(JSON.stringify({ level: 'fatal', reason: 'BROWSER_WORKER_TOKEN_MISSING_OR_TOO_SHORT' }));
  process.exit(1);
}

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clean(v) {
  return String(v ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function norm(v) {
  return clean(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function safeId(v, fallback = 'request') {
  const s = clean(v).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return s || fallback;
}

function safeFinalUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

function logMeta(meta) {
  const allowed = {
    ts: new Date().toISOString(),
    level: meta.level || 'info',
    request_id: meta.request_id || '',
    attempt_id: meta.attempt_id || '',
    prospect_id: meta.prospect_id || '',
    hostname: meta.hostname || '',
    mode: meta.mode || '',
    step: meta.step || '',
    classification: meta.classification || '',
    reason: meta.reason || '',
    duration_ms: Number(meta.duration_ms || 0),
  };
  console.log(JSON.stringify(allowed));
}

function timingSafeTokenEqual(given) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function readJsonBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('BODY_TOO_LARGE'), { httpCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) throw Object.assign(new Error('EMPTY_BODY'), { httpCode: 400 });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw Object.assign(new Error('INVALID_JSON'), { httpCode: 400 });
  }
  return parsed;
}

function isBlockedIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv4FromMappedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:')) return '';
  const tail = lower.slice(7);
  if (net.isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2) return '';
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return '';
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isBlockedIPv6(ip) {
  const s = ip.toLowerCase().split('%')[0];
  const mapped = ipv4FromMappedIPv6(s);
  if (mapped) return isBlockedIPv4(mapped);
  return (
    s === '::' ||
    s === '::1' ||
    s.startsWith('fc') ||
    s.startsWith('fd') ||
    /^fe[89ab]/.test(s) ||
    s.startsWith('2001:db8:') ||
    s.startsWith('ff')
  );
}

function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

function blockedHostnameByName(hostname) {
  const h = clean(hostname).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_INTERNAL_HOSTS.has(h)) return true;
  if (!h.includes('.') && net.isIP(h) === 0) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return true;
  return false;
}

function createNetworkGuard() {
  const cache = new Map();

  async function resolvePublic(hostname) {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (blockedHostnameByName(h)) throw new Error('SSRF_HOSTNAME_BLOCKED');
    if (net.isIP(h)) {
      if (isBlockedIp(h)) throw new Error('SSRF_IP_BLOCKED');
      return [h];
    }
    if (cache.has(h)) return cache.get(h);
    const rows = await Promise.race([
      dns.lookup(h, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSRF_DNS_TIMEOUT')), 3000)),
    ]);
    const ips = [...new Set(rows.map((x) => x.address))];
    if (!ips.length || ips.some(isBlockedIp)) throw new Error('SSRF_DNS_PRIVATE_OR_INVALID');
    cache.set(h, ips);
    return ips;
  }

  async function assertUrlAllowed(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      throw new Error('SSRF_URL_INVALID');
    }
    const protocol = u.protocol.toLowerCase();
    if (['data:', 'blob:', 'about:'].includes(protocol)) return;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) throw new Error('SSRF_SCHEME_BLOCKED');
    await resolvePublic(u.hostname);
  }

  return { assertUrlAllowed, cache };
}

function validateInput(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = clean(body.mode).toUpperCase();
  if (!['PREVIEW', 'LIVE'].includes(mode)) throw new Error('INVALID_MODE');
  if (!clean(body.attempt_id)) throw new Error('INVALID_ATTEMPT_ID');
  if (!clean(body.prospect_id)) throw new Error('INVALID_PROSPECT_ID');
  if (clean(body.expected_category).toUpperCase() !== 'GENERAL_CONTACT') throw new Error('INVALID_EXPECTED_CATEGORY');

  const parseHttps = (value, reason) => {
    let u;
    try { u = new URL(clean(value)); } catch (_) { throw new Error(reason); }
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error(reason);
    return u.toString();
  };

  const url = parseHttps(body.url, 'INVALID_URL');
  const expectedActionUrl = parseHttps(body.expected_action_url, 'INVALID_EXPECTED_ACTION_URL');
  const fields = Array.isArray(body.fields) ? body.fields : [];
  if (!fields.length || fields.length > 12) throw new Error('INVALID_FIELD_PLAN');

  const normalizedFields = [];
  const names = new Set();
  for (const item of fields) {
    const name = clean(item?.name);
    const mapping = clean(item?.mapping).toUpperCase();
    const required = item?.required === true;
    if (!/^[A-Za-z0-9_.:\[\]-]{1,200}$/.test(name)) throw new Error('UNSAFE_FIELD_NAME');
    if (!ALLOWED_MAPPINGS.has(mapping)) throw new Error('FIELD_MAPPING_NOT_ALLOWED');
    if (names.has(name)) throw new Error('DUPLICATE_FIELD_NAME');
    names.add(name);
    normalizedFields.push({ name, mapping, required });
  }

  const values = {};
  const sourceValues = body.values && typeof body.values === 'object' ? body.values : {};
  for (const mapping of ALLOWED_MAPPINGS) {
    const value = String(sourceValues[mapping] ?? '');
    const max = mapping === 'MESSAGE' ? 12000 : 1500;
    if (value.length > max) throw new Error(`VALUE_TOO_LONG_${mapping}`);
    values[mapping] = value;
  }
  for (const field of normalizedFields) {
    if (field.required && !values[field.mapping].trim()) throw new Error(`REQUIRED_VALUE_MISSING_${field.mapping}`);
  }

  return {
    request_id: safeId(body.request_id || crypto.randomUUID()),
    attempt_id: safeId(body.attempt_id || '', 'attempt'),
    prospect_id: safeId(body.prospect_id || '', 'prospect'),
    mode,
    url,
    expected_category: 'GENERAL_CONTACT',
    expected_action_url: expectedActionUrl,
    fields: normalizedFields,
    values,
    capture_preview: mode === 'PREVIEW' && body.capture_preview === true,
  };
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  return browser;
}

function resultBase(input, startedAt) {
  return {
    status: 'UNCONFIRMED',
    reason: 'BROWSER_RESPONSE_AMBIGUOUS',
    submit_clicked: false,
    final_url: input.url,
    form_found: false,
    filled_mappings: [],
    captcha_detected: false,
    required_consent_detected: false,
    success_signal: '',
    error_signal: '',
    duration_ms: Date.now() - startedAt,
  };
}

function terminal(input, startedAt, patch) {
  const out = {
    ...resultBase(input, startedAt),
    ...patch,
    duration_ms: Date.now() - startedAt,
  };
  out.final_url = safeFinalUrl(out.final_url || input.url);
  return out;
}

async function visibleText(locator, max = 2000) {
  try {
    if (!(await locator.isVisible())) return '';
    return clean((await locator.innerText()).slice(0, max));
  } catch (_) {
    return '';
  }
}

async function formPurposeContext(form) {
  const own = await visibleText(form, 5000);
  let heading = '';
  try {
    heading = await form.evaluate((el) => {
      let n = el.previousElementSibling;
      let hops = 0;
      while (n && hops < 6) {
        if (/^(H[1-6]|LEGEND)$/i.test(n.tagName || '')) return (n.textContent || '').trim();
        n = n.previousElementSibling;
        hops += 1;
      }
      const section = el.closest('section,article,main,div');
      const h = section?.querySelector?.('h1,h2,h3,h4,h5,h6,legend');
      return (h?.textContent || '').trim();
    });
  } catch (_) {}
  let submit = '';
  try {
    submit = await form.locator('button[type="submit"], input[type="submit"], button:not([type])').evaluateAll((els) => els.map((e) => (e.textContent || e.value || '').trim()).join(' '));
  } catch (_) {}
  return norm(`${heading} | ${submit} | ${own.slice(0, 1800)}`);
}

function classifyPurpose(context) {
  for (const [kind, phrases] of PURPOSE_SIGNALS) {
    if (phrases.some((p) => context.includes(norm(p)))) return kind;
  }
  if (/(^|\s)sav($|\s)/.test(context)) return 'SUPPORT';
  return '';
}

function noSolicitationSignal(context) {
  return [
    'pas de demarchage',
    'aucun demarchage',
    'demarchage commercial interdit',
    'pas de sollicitation commerciale',
    'aucune sollicitation commerciale',
    'prospection commerciale interdite',
    'no solicitation',
    'no commercial solicitation',
    'no sales solicitation',
  ].find((s) => context.includes(norm(s))) || '';
}

async function detectCaptcha(page, form) {
  const formSelectors = [
    '.g-recaptcha',
    '[name="g-recaptcha-response"]',
    '.h-captcha',
    '[name="h-captcha-response"]',
    '.cf-turnstile',
    '[name="cf-turnstile-response"]',
    '.wpforms-field-captcha',
    '.wpforms-recaptcha-container',
    'input[name*="captcha" i]',
    'textarea[name*="captcha" i]',
  ];
  for (const sel of formSelectors) {
    try {
      if ((await form.locator(sel).count()) > 0) return true;
    } catch (_) {}
  }

  // JS providers sometimes mount the actual challenge iframe outside <form>.
  // Count only an instantiated/visible widget, not a site-wide provider string/script.
  const pageSelectors = [
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    'iframe[src*="google.com/recaptcha" i]',
    'iframe[src*="recaptcha.net" i]',
    'iframe[src*="hcaptcha.com" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
  ];
  for (const sel of pageSelectors) {
    try {
      const loc = page.locator(sel);
      const count = Math.min(await loc.count(), 8);
      for (let i = 0; i < count; i += 1) {
        if (await loc.nth(i).isVisible().catch(() => false)) return true;
      }
    } catch (_) {}
  }
  return false;
}

async function getBlockingControl(form) {
  const checks = [
    ['REQUIRED_CHECKBOX_BROWSER', 'input[type="checkbox"][required], input[type="checkbox"][aria-required="true"]'],
    ['REQUIRED_RADIO_BROWSER', 'input[type="radio"][required], input[type="radio"][aria-required="true"]'],
    ['REQUIRED_SELECT_BROWSER', 'select[required], select[aria-required="true"]'],
    ['FILE_UPLOAD_BROWSER', 'input[type="file"]'],
  ];
  for (const [reason, selector] of checks) {
    try {
      if ((await form.locator(selector).count()) > 0) return reason;
    } catch (_) {}
  }
  return '';
}

async function findMatchingForm(page, input) {
  const forms = page.locator('form');
  const count = await forms.count();
  const matches = [];
  for (let i = 0; i < count; i += 1) {
    const form = forms.nth(i);
    let all = true;
    for (const field of input.fields) {
      const c = await form.locator(`[name=${JSON.stringify(field.name)}]`).count().catch(() => 0);
      if (c !== 1) { all = false; break; }
    }
    if (all) matches.push(form);
  }
  return matches;
}

async function assertFormAction(form, input) {
  let action = '';
  try { action = await form.getAttribute('action'); } catch (_) {}
  const pageUrl = new URL(input.url);
  const expected = new URL(input.expected_action_url);
  const actual = new URL(action || input.url, input.url);
  const effective = (u) => `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  if (actual.protocol !== 'https:') throw new Error('INSECURE_OR_DIFFERENT_ORIGIN_BROWSER');
  if (effective(actual) !== effective(pageUrl)) throw new Error('INSECURE_OR_DIFFERENT_ORIGIN_BROWSER');
  if (actual.href.split('#')[0] !== expected.href.split('#')[0]) throw new Error('FORM_ACTION_CHANGED_BROWSER');
}

async function findSubmit(form) {
  if ((await form.locator('input[type="image"]').count().catch(() => 0)) > 0) {
    return { error: 'UNUSUAL_SUBMIT_CONTROL_BROWSER' };
  }
  const candidates = form.locator('button[type="submit"], input[type="submit"], button:not([type])');
  const count = await candidates.count();
  if (count !== 1) return { error: count === 0 ? 'SUBMIT_BUTTON_NOT_FOUND' : 'MULTIPLE_SUBMIT_BUTTONS_BROWSER' };
  const submit = candidates.first();
  if (!(await submit.isVisible().catch(() => false))) return { error: 'SUBMIT_BUTTON_NOT_INTERACTABLE' };
  if (!(await submit.isEnabled().catch(() => false))) return { error: 'SUBMIT_BUTTON_NOT_INTERACTABLE' };
  return { submit };
}

async function fillFields(form, input) {
  const filled = [];
  for (const field of input.fields) {
    const loc = form.locator(`[name=${JSON.stringify(field.name)}]`);
    const count = await loc.count();
    if (count !== 1) throw new Error('FORM_NOT_UNAMBIGUOUS');
    const el = loc.first();
    const tag = (await el.evaluate((x) => x.tagName.toLowerCase())).toLowerCase();
    const type = clean(await el.getAttribute('type')).toLowerCase() || (tag === 'textarea' ? 'textarea' : 'text');
    if (!['input', 'textarea'].includes(tag)) throw new Error('FIELD_CONTROL_NOT_ALLOWED_BROWSER');
    if (!['text', 'email', 'tel', 'url', 'search', 'textarea'].includes(type)) throw new Error('FIELD_CONTROL_NOT_ALLOWED_BROWSER');
    if (!(await el.isVisible())) throw new Error('MAPPED_FIELD_NOT_VISIBLE');
    if (!(await el.isEditable())) throw new Error('MAPPED_FIELD_NOT_EDITABLE');
    await el.fill(input.values[field.mapping]);
    const got = await el.inputValue();
    if (got !== input.values[field.mapping]) throw new Error('FIELD_FILL_VERIFICATION_FAILED');
    filled.push(field.mapping);
  }
  return filled;
}

async function collectVisibleOutcome(page, form, baseline = {}) {
  const pageText = norm((await page.locator('body').innerText().catch(() => '')).slice(0, 12000));
  let wpformsConfirmation = false;
  const wpSelectors = [
    '.wpforms-confirmation-container-full',
    '.wpforms-confirmation-container',
    '[id^="wpforms-confirmation-"]',
  ];
  for (const sel of wpSelectors) {
    const loc = page.locator(sel);
    const c = await loc.count().catch(() => 0);
    for (let i = 0; i < c; i += 1) {
      if (await loc.nth(i).isVisible().catch(() => false)) { wpformsConfirmation = true; break; }
    }
    if (wpformsConfirmation) break;
  }

  let visibleErrors = '';
  const errorSelectors = [
    '.wpforms-error',
    '.wpforms-error-container',
    '[role="alert"]',
    '.error',
  ];
  for (const sel of errorSelectors) {
    const loc = form.locator(sel);
    const c = Math.min(await loc.count().catch(() => 0), 10);
    for (let i = 0; i < c; i += 1) {
      const t = norm(await visibleText(loc.nth(i), 500));
      if (t) visibleErrors += ` ${t}`;
    }
  }

  const foundSuccess = SUCCESS_PHRASES.find(([, phrase]) => pageText.includes(norm(phrase)) && !String(baseline.pageText || '').includes(norm(phrase)));
  const errorText = norm(visibleErrors || pageText);
  const foundFailure = FAILURE_PHRASES.find(([, phrase]) => errorText.includes(norm(phrase)) && !String(baseline.errorText || '').includes(norm(phrase)));
  const finalUrl = page.url();
  const urlStrong = finalUrl !== String(baseline.url || '') && /merci|thank-you|thankyou|confirmation|message-envoye|message-sent|success/i.test(finalUrl);

  return { wpformsConfirmation, foundSuccess, foundFailure, finalUrl, urlStrong };
}

async function waitForOutcome(page, form, baseline) {
  const deadline = Date.now() + POST_CLICK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await collectVisibleOutcome(page, form, baseline);
    if (r.wpformsConfirmation || r.foundSuccess || r.foundFailure || r.urlStrong) return r;
    await page.waitForTimeout(350);
  }
  return collectVisibleOutcome(page, form, baseline);
}

async function executeBrowser(input) {
  const startedAt = Date.now();
  const hostname = new URL(input.url).hostname;
  const meta = {
    request_id: input.request_id,
    attempt_id: input.attempt_id,
    prospect_id: input.prospect_id,
    hostname,
    mode: input.mode,
  };
  const guard = createNetworkGuard();
  let context = null;
  let submitClicked = false;
  let hardTimedOut = false;
  const hardTimer = setTimeout(() => {
    hardTimedOut = true;
    if (context) context.close().catch(() => {});
  }, HARD_TIMEOUT_MS);

  try {
    await guard.assertUrlAllowed(input.url);
    await guard.assertUrlAllowed(input.expected_action_url);

    const b = await ensureBrowser();
    context = await b.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    context.setDefaultTimeout(6000);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await context.route('**/*', async (route) => {
      try {
        await guard.assertUrlAllowed(route.request().url());
        await route.continue();
      } catch (_) {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(/.*/, async (ws) => {
        try {
          await guard.assertUrlAllowed(ws.url());
          await ws.connectToServer();
        } catch (_) {
          await ws.close({ code: 1008, reason: 'blocked' }).catch(() => {});
        }
      });
    }

    const page = await context.newPage();
    logMeta({ ...meta, step: 'NAVIGATE' });
    const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    if (!response || response.status() >= 400) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: 'BROWSER_NAVIGATION_FAILED', final_url: page.url() });
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(Math.min(1200, FORM_READY_TIMEOUT_MS));
    await page.locator('form').first().waitFor({ state: 'attached', timeout: FORM_READY_TIMEOUT_MS }).catch(() => {});

    const matches = await findMatchingForm(page, input);
    if (matches.length !== 1) {
      return terminal(input, startedAt, {
        status: 'MANUAL_REVIEW',
        reason: 'FORM_NOT_UNAMBIGUOUS',
        final_url: page.url(),
        form_found: matches.length > 0,
      });
    }
    const form = matches[0];

    try {
      await assertFormAction(form, input);
    } catch (e) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: e.message, final_url: page.url(), form_found: true });
    }

    const purposeContext = await formPurposeContext(form);
    const noSol = noSolicitationSignal(purposeContext);
    if (noSol) {
      return terminal(input, startedAt, { status: 'BLOCKED', reason: 'NO_SOLICITATION_DETECTED_BROWSER', final_url: page.url(), form_found: true });
    }
    const purpose = classifyPurpose(purposeContext);
    if (purpose) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: 'FORM_PURPOSE_NOT_AUTO_ALLOWED', final_url: page.url(), form_found: true, error_signal: purpose });
    }

    const captcha = await detectCaptcha(page, form);
    if (captcha) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: 'CAPTCHA_DETECTED_BROWSER', final_url: page.url(), form_found: true, captcha_detected: true });
    }

    const blockControl = await getBlockingControl(form);
    if (blockControl) {
      return terminal(input, startedAt, {
        status: 'MANUAL_REVIEW',
        reason: blockControl,
        final_url: page.url(),
        form_found: true,
        required_consent_detected: blockControl === 'REQUIRED_CHECKBOX_BROWSER',
      });
    }

    const submitInfo = await findSubmit(form);
    if (submitInfo.error) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: submitInfo.error, final_url: page.url(), form_found: true });
    }

    let filled;
    try {
      filled = await fillFields(form, input);
    } catch (e) {
      return terminal(input, startedAt, { status: 'MANUAL_REVIEW', reason: e.message, final_url: page.url(), form_found: true });
    }

    try {
      await submitInfo.submit.click({ trial: true, timeout: 5000 });
    } catch (_) {
      return terminal(input, startedAt, {
        status: 'MANUAL_REVIEW',
        reason: 'INTERACTION_BLOCKED_BY_OVERLAY',
        final_url: page.url(),
        form_found: true,
        filled_mappings: filled,
      });
    }

    if (input.mode === 'PREVIEW') {
      let screenshotFile = '';
      if (input.capture_preview) {
        await fs.mkdir(ARTIFACT_DIR, { recursive: true });
        screenshotFile = `preview-${safeId(input.attempt_id)}.png`;
        const absolute = path.join(ARTIFACT_DIR, screenshotFile);
        await form.screenshot({ path: absolute, animations: 'disabled' });
      }
      return terminal(input, startedAt, {
        status: 'READY_FOR_SUBMIT',
        reason: 'BROWSER_PREVIEW_OK',
        submit_clicked: false,
        final_url: page.url(),
        form_found: true,
        filled_mappings: filled,
        screenshot_file: screenshotFile,
      });
    }

    const baselinePageText = norm((await page.locator('body').innerText().catch(() => '')).slice(0, 12000));
    const baseline = { pageText: baselinePageText, errorText: baselinePageText, url: page.url() };

    // Zone ambiguë : à partir de ce point, aucune relance automatique n'est sûre.
    submitClicked = true;
    logMeta({ ...meta, step: 'CLICK_COMMAND_EMITTED' });
    try {
      await submitInfo.submit.click({ timeout: 5000 });
    } catch (_) {
      return terminal(input, startedAt, {
        status: 'UNCONFIRMED',
        reason: 'BROWSER_CLICK_RESULT_UNKNOWN',
        submit_clicked: true,
        final_url: page.url(),
        form_found: true,
        filled_mappings: filled,
        error_signal: 'CLICK_COMMAND_ERROR_AFTER_EMIT',
      });
    }

    const outcome = await waitForOutcome(page, form, baseline);
    if ((outcome.wpformsConfirmation || outcome.foundSuccess || outcome.urlStrong) && outcome.foundFailure) {
      return terminal(input, startedAt, {
        status: 'UNCONFIRMED',
        reason: 'CONFLICTING_BROWSER_SIGNALS',
        submit_clicked: true,
        final_url: outcome.finalUrl,
        form_found: true,
        filled_mappings: filled,
        success_signal: outcome.wpformsConfirmation ? 'WPFORMS_CONFIRMATION_VISIBLE' : (outcome.foundSuccess?.[0] || 'STRONG_SUCCESS_URL'),
        error_signal: outcome.foundFailure[0],
      });
    }
    if (outcome.foundFailure) {
      return terminal(input, startedAt, {
        status: 'REJECTED',
        reason: 'STRONG_BROWSER_ERROR_SIGNAL',
        submit_clicked: true,
        final_url: outcome.finalUrl,
        form_found: true,
        filled_mappings: filled,
        error_signal: outcome.foundFailure[0],
      });
    }
    if (outcome.wpformsConfirmation) {
      return terminal(input, startedAt, {
        status: 'CONFIRMED',
        reason: 'STRONG_BROWSER_SUCCESS_SIGNAL',
        submit_clicked: true,
        final_url: outcome.finalUrl,
        form_found: true,
        filled_mappings: filled,
        success_signal: 'WPFORMS_CONFIRMATION_VISIBLE',
      });
    }
    if (outcome.foundSuccess || outcome.urlStrong) {
      return terminal(input, startedAt, {
        status: 'CONFIRMED',
        reason: 'STRONG_BROWSER_SUCCESS_SIGNAL',
        submit_clicked: true,
        final_url: outcome.finalUrl,
        form_found: true,
        filled_mappings: filled,
        success_signal: outcome.foundSuccess?.[0] || 'STRONG_SUCCESS_URL',
      });
    }
    return terminal(input, startedAt, {
      status: 'UNCONFIRMED',
      reason: 'BROWSER_RESPONSE_AMBIGUOUS',
      submit_clicked: true,
      final_url: outcome.finalUrl,
      form_found: true,
      filled_mappings: filled,
    });
  } catch (e) {
    const reason = clean(e?.message) || 'BROWSER_WORKER_ERROR';
    return terminal(input, startedAt, {
      status: submitClicked ? 'UNCONFIRMED' : (hardTimedOut ? 'ERROR_PRE_SUBMIT' : 'ERROR_PRE_SUBMIT'),
      reason: hardTimedOut
        ? (submitClicked ? 'BROWSER_RESULT_UNKNOWN' : 'BROWSER_WORKER_HARD_TIMEOUT_PRE_CLICK')
        : (submitClicked ? 'BROWSER_RESULT_UNKNOWN' : reason),
      submit_clicked: submitClicked,
      error_signal: hardTimedOut
        ? (submitClicked ? 'WORKER_HARD_TIMEOUT_AFTER_CLICK' : 'WORKER_HARD_TIMEOUT_PRE_CLICK')
        : (submitClicked ? 'BROWSER_EXCEPTION_AFTER_CLICK' : reason),
    });
  } finally {
    clearTimeout(hardTimer);
    if (context) await context.close().catch(() => {});
  }
}

async function handleExecute(req, res) {
  if (busy) return sendJson(res, 409, { status: 'ERROR_PRE_SUBMIT', reason: 'BROWSER_WORKER_BUSY', submit_clicked: false });
  let raw;
  try { raw = await readJsonBody(req); }
  catch (e) { return sendJson(res, e.httpCode || 400, { status: 'ERROR_PRE_SUBMIT', reason: e.message, submit_clicked: false }); }

  let input;
  try { input = validateInput(raw); }
  catch (e) { return sendJson(res, 400, { status: 'ERROR_PRE_SUBMIT', reason: e.message, submit_clicked: false }); }

  busy = true;
  const startedAt = Date.now();
  try {
    logMeta({ request_id: input.request_id, attempt_id: input.attempt_id, prospect_id: input.prospect_id, hostname: new URL(input.url).hostname, mode: input.mode, step: 'START' });
    const result = await executeBrowser(input);
    logMeta({ request_id: input.request_id, attempt_id: input.attempt_id, prospect_id: input.prospect_id, hostname: new URL(input.url).hostname, mode: input.mode, step: 'FINISH', classification: result.status, reason: result.reason, duration_ms: Date.now() - startedAt });
    return sendJson(res, 200, result);
  } finally {
    busy = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/execute') {
      if (!timingSafeTokenEqual(req.headers['x-browser-worker-token'])) {
        return sendJson(res, 401, { status: 'ERROR_PRE_SUBMIT', reason: 'UNAUTHORIZED', submit_clicked: false });
      }
      return await handleExecute(req, res);
    }
    return sendJson(res, 404, { ok: false });
  } catch (_) {
    return sendJson(res, 500, { status: 'ERROR_PRE_SUBMIT', reason: 'INTERNAL_ERROR', submit_clicked: false });
  }
});

async function startup() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  // Fail closed: prove Chromium can start with sandbox before accepting traffic.
  const b = await ensureBrowser();
  const ctx = await b.newContext();
  await ctx.close();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', step: 'LISTENING', port: PORT, sandbox: true, concurrency: 1 }));
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', step: 'SHUTDOWN', signal }));
  server.close(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startup().catch((e) => {
  console.error(JSON.stringify({ level: 'fatal', reason: 'STARTUP_FAILED_WITH_SANDBOX', detail: clean(e?.message).slice(0, 240) }));
  process.exit(1);
});

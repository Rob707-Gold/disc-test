const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const RESULT_RECIPIENT = process.env.RESULTS_TO_EMAIL || 'Joshua@themcagroup.com.au';
const FROM_EMAIL = process.env.GMAIL_FROM_EMAIL || 'admin@mouldcleaningaustralia.com.au';
const MAX_ANSWERS = 30;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed =
    origin === 'https://rob707-gold.github.io' ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim().slice(0, 500);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function encodeHeader(value) {
  return /[^\x00-\x7F]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value;
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normaliseScores(scores) {
  const out = {};
  for (const key of ['d', 'i', 's', 'c']) {
    const value = Number(scores?.[key]);
    out[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

function buildEmailText(payload) {
  const firstName = cleanText(payload.firstName, 'Unknown');
  const lastName = cleanText(payload.lastName);
  const fullName = `${firstName} ${lastName}`.trim();
  const profileKey = cleanText(payload.profileKey, 'DISC');
  const profileName = cleanText(payload.profileName);
  const scores = normaliseScores(payload.scores);
  const answers = Array.isArray(payload.answers) ? payload.answers.slice(0, MAX_ANSWERS) : [];
  const submittedAt = cleanText(payload.submittedAt, new Date().toISOString());
  const pageUrl = cleanText(payload.pageUrl);

  return `
NEW DISC ASSESSMENT SUBMISSION
=======================================

Name: ${fullName}
Profile: ${profileKey}${profileName ? ` - ${profileName}` : ''}
Submitted: ${submittedAt}
Source URL: ${pageUrl}

SCORES
---------------------------------------
Dominance (D):         ${scores.d} / 80
Influence (I):         ${scores.i} / 80
Steadiness (S):        ${scores.s} / 80
Conscientiousness (C): ${scores.c} / 80

Primary:   ${cleanText(payload.primary)}
Secondary: ${cleanText(payload.secondary)}

RAW ANSWERS
---------------------------------------
${answers.map((answer, index) => `Q${index + 1}: ${JSON.stringify(answer)}`).join('\n')}
  `.trim();
}

function buildMimeMessage({ to, subject, text }) {
  const html = `<pre style="font-family: Arial, sans-serif; white-space: pre-wrap; line-height: 1.45;">${escapeHtml(text)}</pre>`;
  const boundary = `disc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const htmlB64 = Buffer.from(html, 'utf8').toString('base64');

  return [
    `From: MCA DISC Test <${FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64.match(/.{1,76}/g).join('\r\n'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function getAccessToken() {
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing Gmail OAuth configuration: ${missing.join(', ')}`);
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail token refresh failed: ${response.status} ${text.slice(0, 250)}`);
  }

  const json = await response.json();
  return json.access_token;
}

async function sendViaGmail({ to, subject, text }) {
  const accessToken = await getAccessToken();
  const raw = toBase64Url(buildMimeMessage({ to, subject, text }));
  const response = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail send failed: ${response.status} ${errorText.slice(0, 250)}`);
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const payload = parseBody(req);
    const firstName = cleanText(payload.firstName);
    const lastName = cleanText(payload.lastName);

    if (!firstName || !lastName) {
      return res.status(400).json({ ok: false, error: 'First name and last name are required' });
    }

    const profileKey = cleanText(payload.profileKey, 'DISC');
    const emailText = buildEmailText(payload);

    await sendViaGmail({
      to: RESULT_RECIPIENT,
      subject: `DISC Result: ${firstName} ${lastName} - ${profileKey}`,
      text: emailText,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('DISC submit error:', error);
    return res.status(500).json({ ok: false, error: 'Could not email DISC result' });
  }
};

// WolfMind forms → Attio proxy.
//
// Endpoints:
//   POST /design-partner  – §05 cohort application (company, role, name, email, interest[], notes)
//   POST /keep-posted     – lighter capture (email, products[])
//
// Both upsert a Person (matched by email) and add them to the "Inbound leads"
// list with Stage = "New". The §05 form additionally upserts a Company and
// links the Person to it.
//
// After a successful Attio write the Worker also (fire-and-forget):
//   1. Sends a confirmation email to the submitter via Resend
//   2. Posts a notification to a Microsoft Teams Power Automate webhook
// Both are best-effort: failures are logged, never block the form response.

const ATTIO = 'https://api.attio.com/v2';
const ATTIO_APP = 'https://app.attio.com/wolf-mind-industries';
const INBOUND_LEADS_LIST = 'inbound_leads';
const PEOPLE = 'people';
const COMPANIES = 'companies';
const FROM_EMAIL = 'WolfMind Industries <hello@wolfmind.io>';
const REPLY_TO = 'justin@wolfmind.io';

const INTEREST_MAP = {
  aperture: 'Aperture',
  pulse: 'PyroMesh Pulse',
  pyromesh: 'PyroMesh',
  provenance: 'Digital Provenance',
  'just-keep-posted': 'Just keep me posted',
};

const ALLOWED_ORIGINS = new Set([
  'https://wolfmind.io',
  'https://www.wolfmind.io',
  'https://wolfmind-io.github.io',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://127.0.0.1:8000',
]);

// Generic providers — don't promote these to a Company domain because every
// Acme Castings employee on Gmail would collapse into one company record.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'live.com', 'outlook.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'tutanota.com',
  'pm.me', 'duck.com', 'gmx.com',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://wolfmind.io';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, allowed);
    }

    if (!env.ATTIO_TOKEN) {
      return json({ error: 'Server misconfigured: ATTIO_TOKEN missing' }, 500, allowed);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, allowed);
    }

    try {
      if (url.pathname === '/design-partner') {
        return json(await handleDesignPartner(env, body, ctx), 200, allowed);
      }
      if (url.pathname === '/keep-posted') {
        return json(await handleKeepPosted(env, body, ctx), 200, allowed);
      }
      return json({ error: 'Not found' }, 404, allowed);
    } catch (err) {
      console.error('handler error', err);
      // Surface validation messages, hide upstream details.
      const msg = err.userMessage || 'Could not record submission. Email justin@wolfmind.io.';
      return json({ error: msg }, err.status || 500, allowed);
    }
  },
};

// ── Handlers ────────────────────────────────────────────────────────

async function handleDesignPartner(env, body, ctx) {
  const company = trimStr(body.company, 200);
  const role = trimStr(body.role, 120);
  const name = trimStr(body.name, 120);
  const email = trimStr(body.email, 200).toLowerCase();
  const notes = trimStr(body.notes, 4000);
  const page = trimStr(body.page, 500);
  const interest = mapInterest(body.interest);

  if (!email || !isEmail(email)) throw userError('A valid email is required.', 400);
  if (!company) throw userError('Company is required.', 400);

  const companyRecordId = await upsertCompany(env, company, email);
  const personRecordId = await upsertPerson(env, {
    email, name, role, companyRecordId,
    description: composeDescription({
      source: 'Design partner cohort form',
      page, notes, interest, role, company,
    }),
    interest,
    leadSource: 'Design partner cohort form',
  });
  const entryId = await addToInboundLeads(env, personRecordId);

  fireSideEffects(env, ctx, {
    source: 'Design partner cohort form',
    email, name, company, role, interest, notes, page,
    personRecordId,
    emailKind: 'design-partner',
  });

  return { ok: true, person: personRecordId, list_entry: entryId };
}

async function handleKeepPosted(env, body, ctx) {
  const email = trimStr(body.email, 200).toLowerCase();
  const page = trimStr(body.page, 500);
  const products = Array.isArray(body.products) ? body.products : [];
  const interestKeys = ['just-keep-posted', ...products];
  const interest = mapInterest(interestKeys);

  if (!email || !isEmail(email)) throw userError('A valid email is required.', 400);

  const personRecordId = await upsertPerson(env, {
    email,
    description: composeDescription({
      source: 'Keep me posted', page, interest,
    }),
    interest,
    leadSource: 'Keep me posted',
  });
  const entryId = await addToInboundLeads(env, personRecordId);

  fireSideEffects(env, ctx, {
    source: 'Keep me posted',
    email, interest, page,
    personRecordId,
    emailKind: 'keep-posted',
  });

  return { ok: true, person: personRecordId, list_entry: entryId };
}

// ── Side-effects: confirmation email + Teams notification ───────────
// Both are fire-and-forget. ctx.waitUntil keeps the Worker alive until
// the promise settles, but the response is already on the wire.

function fireSideEffects(env, ctx, payload) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return;
  ctx.waitUntil(Promise.allSettled([
    sendConfirmationEmail(env, payload).catch((e) => console.error('email failed', e)),
    notifyTeams(env, payload).catch((e) => console.error('teams failed', e)),
  ]));
}

async function sendConfirmationEmail(env, p) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set; skipping confirmation email');
    return;
  }
  const tmpl = p.emailKind === 'design-partner'
    ? designPartnerEmailTemplate(p)
    : keepPostedEmailTemplate(p);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [p.email],
      reply_to: REPLY_TO,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`resend ${res.status}: ${detail}`);
  }
}

async function notifyTeams(env, p) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.warn('TEAMS_WEBHOOK_URL not set; skipping Teams notification');
    return;
  }
  const attioUrl = p.personRecordId
    ? `${ATTIO_APP}/objects/people/record/${p.personRecordId}`
    : null;
  const submitted_at = new Date().toISOString();
  const card = buildAdaptiveCard(p, submitted_at, attioUrl);
  // Canonical Microsoft Teams webhook message shape — `attachments` is what
  // the "Send webhook alerts to a channel" flow template iterates over to
  // post each Adaptive Card. Extra flat fields are kept alongside for any
  // downstream filtering or routing in the flow.
  const payload = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: card,
      },
    ],
    source: p.source,
    email: p.email,
    name: p.name || '',
    company: p.company || '',
    role: p.role || '',
    interest: Array.isArray(p.interest) ? p.interest : [],
    notes: p.notes || '',
    page: p.page || '',
    submitted_at,
    attio_url: attioUrl || '',
    summary: `${p.source}: ${p.name || p.email}${p.company ? ` (${p.company})` : ''}`,
    text: buildTeamsText(p, submitted_at, attioUrl),
  };
  const res = await fetch(env.TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`teams ${res.status}: ${detail}`);
  }
}

function buildTeamsText(p, submitted_at, attioUrl) {
  const lines = [];
  lines.push(`**${p.source}**`);
  if (p.name)    lines.push(`**Name:** ${p.name}`);
  if (p.email)   lines.push(`**Email:** ${p.email}`);
  if (p.company) lines.push(`**Company:** ${p.company}`);
  if (p.role)    lines.push(`**Role:** ${p.role}`);
  if (p.interest && p.interest.length) lines.push(`**Interest:** ${p.interest.join(', ')}`);
  if (p.notes)   lines.push(`**Notes:** ${p.notes}`);
  if (p.page)    lines.push(`**Page:** ${p.page}`);
  lines.push(`**Submitted:** ${submitted_at}`);
  if (attioUrl)  lines.push(`[Open in Attio](${attioUrl})`);
  return lines.join('\n\n');
}

// Adaptive Card 1.4 — Teams Flowbot-compatible. Drop into the
// "Post card in a chat or channel" action's Adaptive Card field.
function buildAdaptiveCard(p, submitted_at, attioUrl) {
  const facts = [];
  if (p.name)    facts.push({ title: 'Name', value: p.name });
  if (p.email)   facts.push({ title: 'Email', value: p.email });
  if (p.company) facts.push({ title: 'Company', value: p.company });
  if (p.role)    facts.push({ title: 'Role', value: p.role });
  if (p.interest && p.interest.length) facts.push({ title: 'Interest', value: p.interest.join(', ') });
  facts.push({ title: 'Submitted', value: submitted_at });

  const body = [
    {
      type: 'TextBlock',
      text: 'WolfMind · New lead',
      weight: 'Bolder',
      size: 'Small',
      color: 'Accent',
      isSubtle: false,
      spacing: 'None',
    },
    {
      type: 'TextBlock',
      text: p.source,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      spacing: 'Small',
    },
    {
      type: 'FactSet',
      facts,
      spacing: 'Medium',
    },
  ];

  if (p.notes) {
    body.push({
      type: 'TextBlock',
      text: 'Notes',
      weight: 'Bolder',
      size: 'Small',
      color: 'Accent',
      spacing: 'Medium',
    });
    body.push({
      type: 'TextBlock',
      text: p.notes,
      wrap: true,
      spacing: 'None',
    });
  }

  if (p.page) {
    body.push({
      type: 'TextBlock',
      text: `Page: ${p.page}`,
      isSubtle: true,
      size: 'Small',
      wrap: true,
      spacing: 'Medium',
    });
  }

  const actions = [];
  if (attioUrl) {
    actions.push({
      type: 'Action.OpenUrl',
      title: 'Open in Attio',
      url: attioUrl,
    });
  }
  if (p.email) {
    actions.push({
      type: 'Action.OpenUrl',
      title: 'Reply',
      url: `mailto:${p.email}`,
    });
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    actions,
  };
}

function designPartnerEmailTemplate({ name, company }) {
  const greeting = name ? `Hi ${name.split(/\s+/)[0]},` : 'Hi,';
  const ref = company ? ` for ${company}` : '';
  const text = `${greeting}

Got your design-partner cohort application${ref}. We review every submission personally — expect a reply within a few business days.

If you have a deadline or a specific production window we should know about, hit reply on this email and tell us.

In the meantime, the public capability statement is here if it's useful:
https://wolfmind.io/assets/WolfMind_Capability_Statement.pdf

— Justin Baker
WolfMind Industries
hello@wolfmind.io
`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#1A1A1A;font-family:'Hanken Grotesk',Arial,sans-serif;color:#C8C4BA;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1A1A1A;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#232323;border:1px solid #4A4A4A;">
      <tr><td style="padding:24px 32px;border-bottom:2px solid #D97706;">
        <span style="font-weight:700;color:#F0ECE3;letter-spacing:0.32em;font-size:14px;">WOLFMIND</span>
        <span style="color:#5C5C5C;letter-spacing:0.22em;font-size:14px;"> INDUSTRIES</span>
      </td></tr>
      <tr><td style="padding:32px;color:#C8C4BA;font-size:15px;line-height:1.65;">
        <p style="margin:0 0 16px;color:#F0ECE3;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 16px;">Got your design-partner cohort application${escapeHtml(ref)}. We review every submission personally — expect a reply within a few business days.</p>
        <p style="margin:0 0 16px;">If you have a deadline or a specific production window we should know about, hit reply and tell us.</p>
        <p style="margin:0 0 24px;">In the meantime, the public capability statement is <a href="https://wolfmind.io/assets/WolfMind_Capability_Statement.pdf" style="color:#D97706;">here</a> if it's useful.</p>
        <p style="margin:0;color:#7C7C7C;font-size:13px;font-style:italic;">— Justin Baker</p>
        <p style="margin:0;color:#7C7C7C;font-size:13px;">WolfMind Industries · <a href="mailto:hello@wolfmind.io" style="color:#7C7C7C;">hello@wolfmind.io</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject: 'WolfMind — application received', text, html };
}

function keepPostedEmailTemplate({ email }) {
  const text = `Thanks — you're on the list.

We send a short note when there's real news: first units, public benchmarks, open specifications. Nothing else.

— Justin Baker
WolfMind Industries
hello@wolfmind.io

To unsubscribe, reply with "unsubscribe" and we'll remove ${email}.
`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#1A1A1A;font-family:'Hanken Grotesk',Arial,sans-serif;color:#C8C4BA;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1A1A1A;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#232323;border:1px solid #4A4A4A;">
      <tr><td style="padding:24px 32px;border-bottom:2px solid #D97706;">
        <span style="font-weight:700;color:#F0ECE3;letter-spacing:0.32em;font-size:14px;">WOLFMIND</span>
        <span style="color:#5C5C5C;letter-spacing:0.22em;font-size:14px;"> INDUSTRIES</span>
      </td></tr>
      <tr><td style="padding:32px;color:#C8C4BA;font-size:15px;line-height:1.65;">
        <p style="margin:0 0 16px;color:#F0ECE3;">Thanks — you're on the list.</p>
        <p style="margin:0 0 24px;">We send a short note when there's real news: first units, public benchmarks, open specifications. Nothing else.</p>
        <p style="margin:0;color:#7C7C7C;font-size:13px;font-style:italic;">— Justin Baker</p>
        <p style="margin:0 0 16px;color:#7C7C7C;font-size:13px;">WolfMind Industries · <a href="mailto:hello@wolfmind.io" style="color:#7C7C7C;">hello@wolfmind.io</a></p>
        <p style="margin:0;color:#5C5C5C;font-size:11px;">To unsubscribe, reply with &ldquo;unsubscribe&rdquo; and we&rsquo;ll remove ${escapeHtml(email)}.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject: 'WolfMind — you\'re on the list', text, html };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Attio operations ────────────────────────────────────────────────

async function upsertCompany(env, name, email) {
  const domain = companyDomainFromEmail(email);
  const values = { name };
  if (domain) values.domains = [domain];

  // Match on domain when we have one (more reliable than name fuzziness),
  // otherwise fall back to name. Attio requires the matching attribute to
  // be unique — name is not unique, so without a domain we just create.
  if (domain) {
    return await assertRecord(await attio(env, 'PUT', `/objects/${COMPANIES}/records`, {
      data: {
        values,
      },
    }, { matching_attribute: 'domains' }));
  }
  return await assertRecord(await attio(env, 'POST', `/objects/${COMPANIES}/records`, {
    data: { values },
  }));
}

async function upsertPerson(env, { email, name, role, companyRecordId, description, interest, leadSource }) {
  const values = {
    email_addresses: [email],
  };
  if (name) values.name = parsePersonalName(name);
  if (role) values.job_title = role;
  if (description) values.description = description;
  if (interest && interest.length) values.interest = interest;
  if (leadSource) values.lead_source = leadSource;
  if (companyRecordId) {
    values.company = [{ target_object: COMPANIES, target_record_id: companyRecordId }];
  }

  return await assertRecord(await attio(env, 'PUT', `/objects/${PEOPLE}/records`, {
    data: { values },
  }, { matching_attribute: 'email_addresses' }));
}

async function addToInboundLeads(env, personRecordId) {
  const res = await attio(env, 'POST', `/lists/${INBOUND_LEADS_LIST}/entries`, {
    data: {
      parent_record_id: personRecordId,
      parent_object: PEOPLE,
      entry_values: {
        stage: 'New',
      },
    },
  });
  return res?.data?.id?.entry_id ?? null;
}

// ── Attio fetch helper ──────────────────────────────────────────────

async function attio(env, method, path, body, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`${ATTIO}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.ATTIO_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    console.error('attio error', method, path, res.status, text);
    // Idempotent add-to-list: an already-added record returns 409. Treat as success.
    if (res.status === 409 && path.endsWith('/entries')) return { data: data?.data || null };
    throw userError(
      data?.message || data?.error?.message || `Attio ${method} ${path} failed (${res.status})`,
      502,
    );
  }
  return data;
}

function assertRecord(res) {
  const id = res?.data?.id?.record_id;
  if (!id) throw userError('Attio response missing record_id', 502);
  return id;
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapInterest(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    const title = INTEREST_MAP[key];
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  }
  return out;
}

function composeDescription({ source, page, notes, interest, role, company }) {
  const lines = [`Source: ${source}`];
  if (interest && interest.length) lines.push(`Interest: ${interest.join(', ')}`);
  if (role) lines.push(`Role: ${role}`);
  if (company) lines.push(`Company: ${company}`);
  if (page) lines.push(`Page: ${page}`);
  lines.push(`Submitted: ${new Date().toISOString()}`);
  if (notes) lines.push('', '— Notes —', notes);
  return lines.join('\n');
}

function parsePersonalName(name) {
  // Attio personal_name accepts "Lastname, Firstname" string or an object with
  // first/last/full. Free-text name fields most often arrive as "First Last".
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: '', full_name: parts[0] };
  }
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  return { first_name: first, last_name: last, full_name: trimmed };
}

function companyDomainFromEmail(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain.includes('.')) return null;
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

function trimStr(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function userError(message, status) {
  const e = new Error(message);
  e.userMessage = message;
  e.status = status;
  return e;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

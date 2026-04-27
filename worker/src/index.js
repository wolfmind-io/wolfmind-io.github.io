// WolfMind forms → Attio proxy.
//
// Endpoints:
//   POST /design-partner  – §05 cohort application (company, role, name, email, interest[], notes)
//   POST /keep-posted     – lighter capture (email, products[])
//
// Both upsert a Person (matched by email) and add them to the "Inbound leads"
// list with Stage = "New". The §05 form additionally upserts a Company and
// links the Person to it.

const ATTIO = 'https://api.attio.com/v2';
const INBOUND_LEADS_LIST = 'inbound_leads';
const PEOPLE = 'people';
const COMPANIES = 'companies';

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
  async fetch(request, env) {
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
        return json(await handleDesignPartner(env, body), 200, allowed);
      }
      if (url.pathname === '/keep-posted') {
        return json(await handleKeepPosted(env, body), 200, allowed);
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

async function handleDesignPartner(env, body) {
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

  return { ok: true, person: personRecordId, list_entry: entryId };
}

async function handleKeepPosted(env, body) {
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

  return { ok: true, person: personRecordId, list_entry: entryId };
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

// Flookes HQ — Cloudflare Worker
// Serves the app (public/) and its API, keeps everything in D1, sends push
// notifications, reads the family Google Calendar and runs the scheduled jobs.
// Everything under /api/ needs a signed-in family member except the login screen's
// list of names and the login itself.

import { SCHEMA, TABLES, MIGRATIONS, AFTER_MIGRATIONS } from './schema.js';
import { runChoreJobs, generateToday, migrateChoresOnce } from './chores.js';
import { runQuery, QueryError, bump } from './query.js';
import { pushTo, vapidKeys, isPushEndpoint } from './push.js';

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const SESSION_DAYS = 90;
const COOKIE = 'fhq_sid';

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const m of MIGRATIONS) {
    try { await env.DB.prepare(m).run(); } catch (_) { /* column already there */ }
  }
  await env.DB.batch(AFTER_MIGRATIONS.map((s) => env.DB.prepare(s)));
  await migrateChoresOnce(env);
  schemaReady = true;
}

// ── helpers ──────────────────────────────────────────────────
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
const err = (msg, status = 400) => json({ error: msg }, status);

async function readJson(req, maxBytes = 8_000_000) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > maxBytes) throw Object.assign(new Error('too large'), { status: 413 });
  try { return await req.json(); } catch { return null; }
}

function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function equalStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pacificNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    hour: parseInt(parts.hour, 10),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// ── PINs ─────────────────────────────────────────────────────
// Stored as PBKDF2. PINs carried over from Supabase are plain SHA-256; they still work
// and are upgraded to PBKDF2 the first time that person signs in.
const PBKDF2_ITER = 100000;
async function pbkdf2(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${await pbkdf2(pin, salt)}`;
}
async function checkPin(pin, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, , salt, hash] = stored.split('$');
    return equalStrings(await pbkdf2(pin, unb64(salt)), hash);
  }
  return equalStrings(await sha256Hex(pin), stored.toLowerCase());
}
const validPin = (p) => typeof p === 'string' && /^\d{4}$/.test(p);

// ── sessions ─────────────────────────────────────────────────
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
async function currentMember(req, env) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)fhq_sid=([A-Za-z0-9_-]{20,100})/);
  if (!m) return null;
  return env.DB.prepare(`
    SELECT f.id, f.name, f.role, f.emoji, f.color_primary, f.color_secondary, f.color_tertiary
    FROM sessions s JOIN family_members f ON f.id = s.member_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256Hex(m[1]), now()).first();
}

// 8 wrong PINs on one person's tile locks that tile for 15 minutes.
const MAX_FAILURES = 8;
const LOCK_SECONDS = 15 * 60;
async function lockedFor(env, memberId) {
  const row = await env.DB.prepare('SELECT failures, window_end FROM login_attempts WHERE member_id = ?').bind(memberId).first();
  return row && row.window_end > now() && row.failures >= MAX_FAILURES ? row.window_end - now() : 0;
}
async function recordFailure(env, memberId) {
  const t = now();
  await env.DB.prepare(`
    INSERT INTO login_attempts (member_id, failures, window_end) VALUES (?1, 1, ?2)
    ON CONFLICT(member_id) DO UPDATE SET
      failures   = CASE WHEN window_end > ?3 THEN failures + 1 ELSE 1 END,
      window_end = CASE WHEN window_end > ?3 THEN window_end ELSE ?2 END`)
    .bind(memberId, t + LOCK_SECONDS, t).run();
  const row = await env.DB.prepare('SELECT failures FROM login_attempts WHERE member_id = ?').bind(memberId).first();
  return Math.max(0, MAX_FAILURES - (row?.failures || 0));
}

const PROFILE_COLS = 'id, name, role, emoji, color_primary, color_secondary, color_tertiary, display_order';

// ── API ──────────────────────────────────────────────────────
async function handleApi(req, env, url, ctx) {
  const path = url.pathname;
  const method = req.method;

  // Refuse writes that come from other websites.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return err('Forbidden', 403);
  }

  // Names and colours for the login tiles.
  if (path === '/api/members' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT ${PROFILE_COLS} FROM family_members ORDER BY display_order`).all();
    return json(results);
  }

  if (path === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    const id = String(body?.id || '');
    const pin = String(body?.pin || '');
    const member = await env.DB.prepare('SELECT * FROM family_members WHERE id = ?').bind(id).first();
    if (!member) return err('Unknown family member.', 404);
    const wait = await lockedFor(env, id);
    if (wait) return json({ error: 'locked', minutes: Math.ceil(wait / 60) }, 429);
    if (!validPin(pin) || !(await checkPin(pin, member.pin_hash))) {
      const left = await recordFailure(env, id);
      if (left === 0) return json({ error: 'locked', minutes: LOCK_SECONDS / 60 }, 429);
      return json({ error: 'wrong_pin', attemptsLeft: left }, 401);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE member_id = ?').bind(id).run();
    if (!member.pin_hash.startsWith('pbkdf2$')) {
      await env.DB.prepare('UPDATE family_members SET pin_hash = ? WHERE id = ?').bind(await hashPin(pin), id).run();
    }
    const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
      env.DB.prepare('INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)')
        .bind(await sha256Hex(token), id, now() + SESSION_DAYS * DAY),
    ]);
    const { pin_hash, created_at, ...profile } = member;
    return json(profile, 200, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * DAY) });
  }

  // First-time setup: copy everything over from Supabase. Open to anyone only while the
  // database is still empty; after that, parents only.
  if (path === '/api/admin/import-supabase' && method === 'POST') {
    const empty = !(await env.DB.prepare('SELECT 1 FROM family_members LIMIT 1').first());
    if (!empty) {
      const me = await currentMember(req, env);
      if (!me || me.role !== 'parent') return err('Parents only.', 403);
    }
    return json(await importFromSupabase(env));
  }

  // ── everything below needs sign-in ──
  const me = await currentMember(req, env);
  if (!me) return err('Not signed in', 401);

  if (path === '/api/me' && method === 'GET') return json(me);

  if (path === '/api/logout' && method === 'POST') {
    const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)fhq_sid=([^;]+)/);
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(m[1])).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // Change your own PIN (needs the current one), or a parent resets a kid's PIN.
  if (path === '/api/pin' && method === 'POST') {
    const body = await readJson(req);
    const target = String(body?.member_id || me.id);
    const newPin = String(body?.new_pin || '');
    if (!validPin(newPin)) return err('PINs are 4 digits.');
    const member = await env.DB.prepare('SELECT id, role, pin_hash FROM family_members WHERE id = ?').bind(target).first();
    if (!member) return err('Unknown family member.', 404);
    if (target === me.id) {
      if (!(await checkPin(String(body?.current_pin || ''), member.pin_hash))) return err('Your current PIN is not right.', 401);
    } else if (!(me.role === 'parent' && member.role === 'kid')) {
      return err('Parents can reset a kid\'s PIN; everyone else changes their own.', 403);
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE family_members SET pin_hash = ? WHERE id = ?').bind(await hashPin(newPin), target),
      env.DB.prepare('DELETE FROM login_attempts WHERE member_id = ?').bind(target),
    ]);
    // Changing your own PIN signs out your other devices; a reset signs the kid out everywhere.
    const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)fhq_sid=([^;]+)/);
    const keep = target === me.id && m ? await sha256Hex(m[1]) : '';
    await env.DB.prepare('DELETE FROM sessions WHERE member_id = ? AND token_hash != ?').bind(target, keep).run();
    return json({ ok: true });
  }

  if (path === '/api/db' && method === 'POST') {
    const q = await readJson(req);
    try {
      return json(await runQuery(env, me, q));
    } catch (e) {
      if (e instanceof QueryError) return json({ data: null, error: { message: e.message } }, e.status);
      throw e;
    }
  }

  // What changed since the app last looked (one counter per table).
  if (path === '/api/changes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT tbl, v FROM changes').all();
    return json(Object.fromEntries(results.map((r) => [r.tbl, r.v])));
  }

  if (path === '/api/calendar' && method === 'GET') return calendar(env, me, url);

  // Hand out today's copies right after a parent adds or changes a repeating chore.
  if (path === '/api/chores/run' && method === 'POST') {
    if (me.role !== 'parent') return err('Parents only.', 403);
    return json({ created: await generateToday(env) });
  }

  if (path.startsWith('/api/ai/') && method === 'POST') {
    const body = await readJson(req);
    if (!body) return err('Invalid JSON body');
    if (!env.ANTHROPIC_API_KEY) return err('The AI key has not been added to Cloudflare yet.', 503);
    try {
      const kind = path.slice('/api/ai/'.length);
      if (kind === 'recipe') return json(await aiRecipe(env, body));
      if (kind === 'suggest') return json(await aiSuggest(env, body));
      if (kind === 'dedupe') return json(await aiDedupe(env, body));
      return err('Unknown route', 404);
    } catch (e) {
      console.log('ai error', e && e.message);
      return err(e.message || 'AI request failed', 500);
    }
  }

  if (path === '/api/push/key' && method === 'GET') {
    return json({ publicKey: (await vapidKeys(env)).publicKey });
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const body = await readJson(req);
    const sub = body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !isPushEndpoint(sub.endpoint)) {
      return err('That notification subscription is not valid.');
    }
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, family_member_id, endpoint, subscription, device_info, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(endpoint) DO UPDATE SET family_member_id = ?2, subscription = ?4, device_info = ?5`)
      .bind(crypto.randomUUID(), me.id, sub.endpoint,
        JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }),
        String(body.device_info || '').slice(0, 200), new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (path === '/api/push/send' && method === 'POST') {
    const body = await readJson(req);
    const target = String(body?.family_member_id || '');
    if (!(await env.DB.prepare('SELECT 1 FROM family_members WHERE id = ?').bind(target).first())) return err('Unknown family member.', 404);
    ctx.waitUntil(pushTo(env, target, body.title, body.body, body.tag));
    return json({ ok: true });
  }

  return err('Not found', 404);
}

// ── Google Calendar ──────────────────────────────────────────
const CALENDAR_ID = 'family03871031911333605133@group.calendar.google.com';

async function calendar(env, me, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return err('The Google Calendar connection has not been set up yet.', 503);
  }
  // Kids get 3 days and only events with their name in the title (same as before,
  // but now enforced here rather than in the page).
  const maxDays = me.role === 'kid' ? 3 : 7;
  const days = Math.max(1, Math.min(parseInt(url.searchParams.get('days') || '7', 10) || 7, maxDays));

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) {
    console.log('calendar token refresh failed', JSON.stringify(token));
    return err('Could not sign in to Google Calendar.', 502);
  }

  // Start of today in Pacific time, through the end of day N.
  const { date } = pacificNow();
  const offset = pacificOffset(date);
  const start = new Date(`${date}T00:00:00${offset}`);
  const end = new Date(start.getTime() + days * DAY * 1000);

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`
    + `?timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}`
    + '&singleEvents=true&orderBy=startTime&maxResults=100',
    { headers: { Authorization: `Bearer ${token.access_token}` } });
  const cal = await calRes.json();
  if (!calRes.ok) {
    console.log('calendar fetch failed', calRes.status, JSON.stringify(cal).slice(0, 500));
    return err('Google Calendar did not answer.', 502);
  }
  let items = (cal.items || []).map((evt) => ({
    id: evt.id,
    summary: evt.summary,
    location: evt.location,
    start: evt.start,
    end: evt.end,
    _pacificDate: evt.start?.date || evt.start?.dateTime?.slice(0, 10) || '',
  }));
  if (me.role === 'kid') {
    const name = me.name.toLowerCase();
    items = items.filter((e) => (e.summary || '').toLowerCase().includes(name));
  }
  return json({ items, days });
}

// "-07:00" in summer, "-08:00" in winter, for the given Pacific date.
function pacificOffset(date) {
  const noonUtc = new Date(`${date}T20:00:00Z`);
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23',
  }).format(noonUtc), 10);
  return `-${String(20 - hour).padStart(2, '0')}:00`;
}

// ── AI (recipe import, meal suggestions, shopping list clean-up) ──
const MODEL = 'claude-sonnet-5-5';

async function callClaude(env, system, userContent, maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content?.find((b) => b.type === 'text')?.text || '').trim();
}
function parseJsonReply(raw) {
  let s = raw.replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.indexOf('[');
  if (a !== -1 && (b === -1 || a < b)) s = s.slice(a, s.lastIndexOf('}') + 1);
  return JSON.parse(s);
}

const RECIPE_SYSTEM = `You extract ingredients from recipes for a gluten-free family.
Return ONLY valid JSON — no markdown, no commentary.
Format: {"name":"Meal Name","ingredients":[{"name":"ingredient with quantity","store":"tj|costco|wf|other|have_it"}]}
Store guide: tj=Trader Joe's, costco=Costco, wf=Whole Foods, other=anywhere, have_it=pantry staple.
If you cannot determine a store, use "other".
Combine quantity into the name field (e.g. "1 lb ground turkey"). Omit anything containing gluten.`;

async function aiRecipe(env, body) {
  let userContent;
  if (body.url) {
    let u;
    try { u = new URL(String(body.url)); } catch { throw new Error('That link is not a web address.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('That link is not a web address.');
    const pageRes = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Flookes/1.0)' } });
    if (!pageRes.ok) throw new Error('Could not fetch that URL');
    const html = await pageRes.text();
    const trimmed = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000);
    userContent = `Extract the recipe from this page:\n\n${trimmed}`;
  } else if (body.text) {
    userContent = `Extract the recipe from this text:\n\n${String(body.text).slice(0, 10000)}`;
  } else if (body.image) {
    const img = String(body.image);
    const mediaType = img.startsWith('iVBOR') ? 'image/png' : img.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: img } },
      { type: 'text', text: 'Extract the recipe from this image.' },
    ];
  } else {
    throw new Error('Provide url, text, or image');
  }
  return parseJsonReply(await callClaude(env, RECIPE_SYSTEM, userContent, 1024));
}

const SUGGEST_SYSTEM = `You are a meal planner for the Flookes family in Napa, CA.

FAMILY PROFILE:
- Jonathan & Courtney (parents), Henry & Audrey (kids, school-age)
- Entirely gluten-free — no exceptions
- Simple meals: protein + vegetable + starch
- Chicken 2–3×/week is fine; never the same protein on consecutive days
- All cuisines welcome
- Tuesday is ALWAYS Taco Tuesday — never suggest anything for Tuesday (it is handled separately)
- Preferred grocery stores: Trader Joe's (primary), Costco (proteins/bulk), Whole Foods

RULES:
1. Pick ONLY from the candidate list provided — do not invent new meals
2. Return each candidate's name EXACTLY as written in the list — character-for-character
3. Avoid repeating a protein already planned for the current week
4. Prefer meals not cooked recently (use lastCooked dates — older = higher priority)
5. Surface high-frequency favorites (count field) regularly but not exclusively
6. Vary proteins across the days being filled
7. Return ONLY valid JSON, no markdown fences, no commentary

RESPONSE FORMAT for mode=week:
{"suggestions":[{"dow":1,"name":"Exact Meal Name"},{"dow":4,"name":"Exact Meal Name"}]}

RESPONSE FORMAT for mode=day:
{"name":"Exact Meal Name"}`;

async function aiSuggest(env, body) {
  const { mode, candidates, currentWeek, emptyDays, dow } = body;
  if (!candidates?.length) throw new Error('No candidates provided');
  const today = pacificNow().date;
  const candidateLines = candidates.slice(0, 200).map((c) =>
    `- "${c.name}" (${c.lastCooked ? `last cooked ${c.lastCooked}` : 'never cooked (new)'}, cooked ${c.count}× total)`).join('\n');
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekLines = (currentWeek || []).length
    ? currentWeek.map((m) => `  ${DAY_NAMES[m.dow]}: ${m.name}`).join('\n')
    : '  (nothing planned yet)';
  const userMsg = mode === 'week'
    ? `Today is ${today}.\n\nCurrent week already has:\n${weekLines}\n\nPlease suggest one meal for each of these empty days: ${(emptyDays || []).map((d) => DAY_NAMES[d]).join(', ')} (day numbers: ${(emptyDays || []).join(', ')})\n\nCandidate meals (pick ONLY from this list, use exact names):\n${candidateLines}`
    : `Today is ${today}.\n\nI need one meal suggestion for ${DAY_NAMES[dow] || 'this day'}.\n\nCurrent week already has:\n${weekLines}\n\nCandidate meals (pick ONLY from this list, use exact names):\n${candidateLines}`;
  return parseJsonReply(await callClaude(env, SUGGEST_SYSTEM, userMsg, 512));
}

const DEDUPE_SYSTEM = `You are a shopping list consolidator for a gluten-free family.
You will receive a list of grocery items. Your job is to deduplicate and consolidate them.

Rules:
1. Merge items that are the same ingredient (e.g. "chicken breast", "1 lb chicken breast", "chicken" → one item)
2. Combine quantities into the name where it makes sense (e.g. "2 lbs ground beef" if two separate entries existed)
3. Keep the most descriptive/specific name
4. For store: pick the most appropriate store given the family's preferences (tj=Trader Joe's primary, costco=proteins/bulk, wf=Whole Foods specialty)
5. Remove true duplicates entirely
6. Do NOT merge fundamentally different ingredients (e.g. "chicken thighs" and "chicken breast" can stay separate if quantities suggest both are needed)
7. Return ONLY valid JSON, no markdown, no commentary

Response format:
{"items":[{"name":"consolidated item name","store":"tj|costco|wf|other"}]}`;

async function aiDedupe(env, body) {
  const items = body.items;
  if (!items?.length) throw new Error('No items provided');
  const lines = items.slice(0, 300).map((i) => `- ${i.name} (store: ${i.store || 'other'})`).join('\n');
  return parseJsonReply(await callClaude(env, DEDUPE_SYSTEM, `Please consolidate this shopping list:\n\n${lines}`, 1024));
}

// ── scheduled jobs (one hourly cron; each job runs once a day at its hour) ──
const NAPA = { lat: 38.2975, lon: -122.2869 };

async function onceToday(env, job, date) {
  const res = await env.DB.prepare(`
    INSERT INTO job_runs (job, ran_on) VALUES (?1, ?2)
    ON CONFLICT(job) DO UPDATE SET ran_on = ?2 WHERE ran_on != ?2`).bind(job, date).run();
  return res.meta.changes > 0;
}

async function runScheduled(env) {
  const { hour, dow, date } = pacificNow();
  const jobs = [];
  if (hour === 7 && await onceToday(env, 'morning', date)) jobs.push(jobWeather(env), jobDueReminders(env, date), jobPayoutCheck(env));
  if (hour === 10 && dow === 0 && await onceToday(env, 'meal-plan', date)) jobs.push(jobMealPlanReminder(env, date));
  await Promise.all(jobs);
  await runChoreJobs(env);
  // Tidy up expired sign-ins.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
}

async function members(env) {
  return (await env.DB.prepare('SELECT id, name, role, emoji FROM family_members').all()).results;
}

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code <= 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '🌨️';
  if (code <= 82) return '🌧️';
  if (code <= 99) return '⛈️';
  return '🌡️';
}

async function jobWeather(env) {
  try {
    const data = await fetch('https://api.open-meteo.com/v1/forecast'
      + `?latitude=${NAPA.lat}&longitude=${NAPA.lon}&current_weather=true`
      + '&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit'
      + '&timezone=America%2FLos_Angeles&forecast_days=1').then((r) => r.json());
    const { temperature, weathercode } = data.current_weather;
    const high = Math.round(data.daily.temperature_2m_max[0]);
    const low = Math.round(data.daily.temperature_2m_min[0]);
    const all = await members(env);
    await Promise.all(all.map((m) => pushTo(env, m.id, `Good morning, Flookes ${weatherEmoji(weathercode)}`,
      `Today: ${Math.round(temperature)}° · High ${high}° · Low ${low}°`, 'weather-morning')));
  } catch (e) { console.log('jobWeather', e && e.message); }
}

async function jobDueReminders(env, date) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, title, assigned_to FROM tasks
      WHERE substr(due_date, 1, 10) = ? AND completed_at IS NULL AND assigned_to IS NOT NULL
        AND due_at IS NULL AND missed_at IS NULL`).bind(date).all();
    await Promise.all(results.map((t) => pushTo(env, t.assigned_to, 'Due today ⏰', `"${t.title}"`, `due-${t.id}`)));
  } catch (e) { console.log('jobDueReminders', e && e.message); }
}

async function jobPayoutCheck(env) {
  try {
    const all = await members(env);
    const parents = all.filter((m) => m.role === 'parent');
    const weekAgo = new Date(Date.now() - 7 * DAY * 1000).toISOString();
    for (const kid of all.filter((m) => m.role === 'kid')) {
      const recent = await env.DB.prepare(`SELECT 1 FROM bank_transactions WHERE family_member_id = ? AND type = 'payout' AND created_at >= ? LIMIT 1`)
        .bind(kid.id, weekAgo).first();
      if (recent) continue;
      const bal = await env.DB.prepare('SELECT balance FROM bank_balances WHERE family_member_id = ?').bind(kid.id).first();
      const goals = (await env.DB.prepare('SELECT target_amount FROM savings_goals WHERE family_member_id = ?').bind(kid.id).all()).results;
      const balance = Number(bal?.balance || 0);
      const hitGoal = goals.some((g) => balance >= Number(g.target_amount));
      const noGoalHi = goals.length === 0 && balance > 40;
      if (!hitGoal && !noGoalHi) continue;
      const body = hitGoal
        ? `${kid.emoji} ${kid.name} has hit their savings goal`
        : `${kid.emoji} ${kid.name} has $${balance.toFixed(2)} saved with no goal set`;
      await Promise.all(parents.map((p) => pushTo(env, p.id, '💸 Payout time?', body, `payout-${kid.id}`)));
    }
  } catch (e) { console.log('jobPayoutCheck', e && e.message); }
}

async function jobMealPlanReminder(env, date) {
  try {
    if (await env.DB.prepare('SELECT 1 FROM meals WHERE week_start_date = ? LIMIT 1').bind(date).first()) return;
    const parents = (await members(env)).filter((m) => m.role === 'parent');
    await Promise.all(parents.map((p) => pushTo(env, p.id, "Plan the week's dinners 🍽️",
      'No meals added yet — tap to open the planner', 'meal-plan-reminder')));
  } catch (e) { console.log('jobMealPlanReminder', e && e.message); }
}

// ── one-time copy from Supabase ──────────────────────────────
// Reads with the old app's public key (which could read everything — the reason for the
// move) and replaces the D1 copy of each table. Safe to run again: it mirrors Supabase.
const SUPABASE_URL = 'https://nwrvgjfnetuaohxzmsuv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_TMqE0djUkHy9F1J_ye2Ytg_QebA9bTL';

async function importFromSupabase(env) {
  const counts = {};
  const fetched = {};
  for (const table of Object.keys(TABLES)) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: SUPABASE_KEY, Range: '0-9999' },
    });
    if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${await res.text()}`);
    fetched[table] = await res.json();
  }
  // Only replace once every table has been read successfully.
  const stmts = [];
  for (const [table, rows] of Object.entries(fetched)) {
    const cols = TABLES[table];
    stmts.push(env.DB.prepare(`DELETE FROM ${table}`));
    for (const r of rows) {
      const keys = Object.keys(cols).filter((k) => r[k] !== undefined);
      stmts.push(env.DB.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .bind(...keys.map((k) => {
          const v = r[k];
          if (v === null) return null;
          if (cols[k] === 'bool') return v ? 1 : 0;
          if (cols[k] === 'num' || cols[k] === 'int') return Number(v);
          return String(v);
        })));
    }
    counts[table] = rows.length;
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  for (const table of Object.keys(TABLES)) await bump(env, table);
  return { imported: counts };
}

// ── security headers ─────────────────────────────────────────
// The pages use inline scripts and onclick handlers, so 'unsafe-inline' is needed for
// scripts; no outside scripts are loaded.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.open-meteo.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function withSecurityHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('Content-Security-Policy', CSP);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'DENY');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('Strict-Transport-Security', 'max-age=31536000');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return r;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        await ensureSchema(env);
        return withSecurityHeaders(await handleApi(req, env, url, ctx));
      }
      // "/" is the login page.
      const assetReq = url.pathname === '/' ? new Request(new URL('/index.html', url), req) : req;
      const res = await env.ASSETS.fetch(assetReq);
      // Pages and the service worker must never be cached stale, or phones keep the old app.
      if (/\.(html|js|json)$|\/$/.test(url.pathname)) {
        const r = new Response(res.body, res);
        r.headers.set('Cache-Control', 'no-cache');
        return withSecurityHeaders(r);
      }
      return withSecurityHeaders(res);
    } catch (e) {
      if (e && e.status === 413) return withSecurityHeaders(err('That upload is too large.', 413));
      console.log('Unhandled error', (e && e.stack) || e);
      return withSecurityHeaders(err('Something went wrong on the server.', 500));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => runScheduled(env)));
  },
};

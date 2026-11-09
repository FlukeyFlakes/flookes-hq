// Chores v2 — the Worker, not the phones, hands out repeating chores, marks missed ones
// and sends deadline reminders. Runs from the cron every 15 minutes (and right after a
// parent saves a repeating chore). Everything is safe to run any number of times.

import { pushTo } from './push.js';
import { bump } from './query.js';

const DAY_MS = 86400000;

// ── Pacific time helpers ─────────────────────────────────────
export function pacificParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    hour: parseInt(p.hour, 10),
  };
}

// "-07:00" or "-08:00" for a Pacific date.
export function pacificOffset(date) {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23',
  }).format(new Date(`${date}T20:00:00Z`)), 10);
  return `-${String(20 - hour).padStart(2, '0')}:00`;
}

// Pacific wall-clock date + "HH:MM" → UTC ISO string.
export function pacificToIso(date, time = '00:00') {
  return new Date(`${date}T${time}:00${pacificOffset(date)}`).toISOString();
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// Deadline for a copy handed out on `date`: the due-by time that day, or midnight.
export function dueAtFor(date, dueTime) {
  return dueTime ? pacificToIso(date, dueTime) : pacificToIso(addDays(date, 1), '00:00');
}

async function kids(env) {
  return (await env.DB.prepare("SELECT id, name FROM family_members WHERE role = 'kid' ORDER BY display_order").all()).results;
}

// ── hand out today's copies ──────────────────────────────────
export async function generateToday(env) {
  const { date, dow } = pacificParts();
  const schedules = (await env.DB.prepare(`
    SELECT s.* FROM chore_schedules s
    WHERE IFNULL(s.paused, 0) = 0
      AND instr(s.days, ?1) > 0
      AND (s.start_date IS NULL OR s.start_date = '' OR s.start_date <= ?2)
      AND (s.end_date   IS NULL OR s.end_date   = '' OR s.end_date   >= ?2)
      AND NOT EXISTS (SELECT 1 FROM chore_runs r WHERE r.schedule_id = s.id AND r.for_date = ?2)`)
    .bind(String(dow), date).all()).results;
  if (!schedules.length) return 0;

  const allKids = await kids(env);
  const now = new Date().toISOString();
  const stmts = [];
  let made = 0;
  for (const s of schedules) {
    const slots = s.who === 'each' ? allKids.map((k) => k.id)
      : s.who === 'kid' ? [s.kid_id]
      : ['grab'];
    const dueAt = dueAtFor(date, s.due_time);
    for (const slot of slots) {
      if (!slot) continue;
      const grab = slot === 'grab';
      stmts.push(env.DB.prepare(`
        INSERT OR IGNORE INTO tasks (id, title, description, created_by, assigned_to, priority, is_chore,
          chore_amount, is_recurring, recurrence_pattern, open_to_kids, created_at,
          schedule_id, for_date, slot, due_at, due_time)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), s.title, s.description || null, s.created_by, grab ? null : slot,
          s.priority || 'medium', Number(s.amount || 0), grab ? 1 : 0, now,
          s.id, date, slot, dueAt, s.due_time || null));
      made++;
    }
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO chore_runs (schedule_id, for_date) VALUES (?, ?)').bind(s.id, date));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (made) await bump(env, 'tasks');
  return made;
}

// ── missed: past the deadline and never checked off ──────────
export async function markMissed(env) {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(`
    UPDATE tasks SET missed_at = ?1
    WHERE is_chore = 1 AND completed_at IS NULL AND missed_at IS NULL
      AND due_at IS NOT NULL AND due_at <= ?1`).bind(now).run();
  if (res.meta.changes) await bump(env, 'tasks');
  return res.meta.changes;
}

// ── reminders: 1 hour before a due-by time; 7 PM for chores due at midnight ──
export async function sendReminders(env) {
  const now = Date.now();
  const rows = (await env.DB.prepare(`
    SELECT id, title, chore_amount, assigned_to, open_to_kids, due_at, due_time FROM tasks
    WHERE is_chore = 1 AND completed_at IS NULL AND missed_at IS NULL AND reminded_at IS NULL
      AND due_at IS NOT NULL AND due_at > ?1`).bind(new Date(now).toISOString()).all()).results;
  const due = rows.filter((t) => {
    const lead = t.due_time ? 60 * 60 * 1000 : 5 * 60 * 60 * 1000; // midnight − 5 h = 7 PM
    return Date.parse(t.due_at) - now <= lead;
  });
  if (!due.length) return 0;
  const allKids = await kids(env);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  for (const t of due) {
    const when = t.due_time ? `due by ${fmt.format(new Date(t.due_at)).replace(':00', '')}` : 'due tonight';
    const money = Number(t.chore_amount) > 0 ? ` ($${Number(t.chore_amount).toFixed(2).replace('.00', '')})` : '';
    const targets = t.open_to_kids && !t.assigned_to ? allKids.map((k) => k.id) : [t.assigned_to].filter(Boolean);
    await Promise.all(targets.map((id) => pushTo(env, id, `⏰ ${t.title}`, `It's ${when}${money}`, `remind-${t.id}`)));
    await env.DB.prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').bind(new Date().toISOString(), t.id).run();
  }
  return due.length;
}

export async function runChoreJobs(env) {
  await markMissed(env);
  await generateToday(env);
  await sendReminders(env);
}

// ── one-time switch from the old phone-made repeating chores ──
// Turns the family's existing repeating chores into schedules (all first-to-grab, as
// agreed), marks the old undone copies as missed so they stop blocking, and hands out
// today's copies. Runs once; remembered in settings.
const STARTING_SCHEDULES = [
  { title: 'Get the mail', amount: 1, days: '0123456' },
  { title: 'Take trash bins to curb', amount: 3, days: '1' },
  { title: 'Empty all trash to trash bins', amount: 3, days: '1' },
  { title: 'Bring in the trash bins', amount: 3, days: '2' },
  { title: 'Unload Dishwasher', amount: 2, days: '0123456' },
];

export async function migrateChoresOnce(env) {
  const done = await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'chores_v2'").first();
  if (done) return false;
  const parent = await env.DB.prepare("SELECT id FROM family_members WHERE role = 'parent' ORDER BY display_order LIMIT 1").first();
  if (!parent) return false; // database not filled in yet
  const now = new Date().toISOString();
  const stmts = [
    // Dated to when they were handed out, so they don't count as missed this week.
    env.DB.prepare(`UPDATE tasks SET missed_at = IFNULL(created_at, ?) WHERE is_recurring = 1 AND schedule_id IS NULL
                      AND completed_at IS NULL AND missed_at IS NULL`).bind(now),
    // The old copies are history now; they no longer drive anything.
    env.DB.prepare('UPDATE tasks SET is_recurring = 0 WHERE schedule_id IS NULL'),
  ];
  const existing = (await env.DB.prepare('SELECT COUNT(*) AS n FROM chore_schedules').first()).n;
  if (!existing) {
    for (const s of STARTING_SCHEDULES) {
      stmts.push(env.DB.prepare(`
        INSERT INTO chore_schedules (id, title, amount, who, days, paused, priority, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'grab', ?, 0, 'medium', ?, ?, ?)`)
        .bind(crypto.randomUUID(), s.title, s.amount, s.days, parent.id, now, now));
    }
  }
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('chores_v2', ?)").bind(now));
  await env.DB.batch(stmts);
  await bump(env, 'tasks');
  await generateToday(env);
  return true;
}

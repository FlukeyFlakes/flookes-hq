// Runs the app's database queries against D1.
//
// The app still writes queries the way it did with Supabase
// (db.from('tasks').select('*').eq('id', x)…). public/db.js turns each one into a small
// JSON description and posts it to /api/db; this file checks it against the schema and
// the family's permission rules, then runs it as parameterised SQL. Nothing from the
// browser is ever pasted into SQL: table and column names must match the schema exactly,
// and every value is a bound parameter.

import { TABLES, DEFAULTS, RELATIONS } from './schema.js';

const OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const MAX_ROWS = 2000;

export class QueryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const nowIso = () => new Date().toISOString();

// ── value conversion ─────────────────────────────────────────
function toDb(type, v) {
  if (v === undefined || v === null) return null;
  if (type === 'bool') return v === true || v === 1 || v === 'true' ? 1 : 0;
  if (type === 'num') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (type === 'int') { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : null; }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).slice(0, 10000);
}

export function fromDb(table, row) {
  const cols = TABLES[table];
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = cols[k] === 'bool' && v !== null ? v === 1 : v;
  }
  return out;
}

// ── select-string parsing: "id, name, ingredients(name, store)" ──
function parseSelect(table, str) {
  const cols = [];
  const embeds = [];
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of String(str || '*')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    const m = raw.match(/^([a-z_]+)\((.*)\)$/);
    if (m) {
      const fk = RELATIONS[table]?.[m[1]];
      if (!fk) throw new QueryError(`Unknown relation ${m[1]}`);
      embeds.push({ table: m[1], fk, cols: parseSelect(m[1], m[2]).cols });
    } else if (raw === '*') {
      cols.push(...Object.keys(TABLES[table]));
    } else {
      if (!TABLES[table][raw]) throw new QueryError(`Unknown column ${table}.${raw}`);
      cols.push(raw);
    }
  }
  if (!cols.length && !embeds.length) cols.push(...Object.keys(TABLES[table]));
  return { cols: [...new Set(cols)], embeds };
}

// ── WHERE building ───────────────────────────────────────────
function buildWhere(table, filters, extra) {
  const cols = TABLES[table];
  const sql = [];
  const args = [];
  for (const f of filters || []) {
    if (!Array.isArray(f) || f.length !== 3) throw new QueryError('Bad filter');
    const [col, op, val] = f;
    if (!cols[col]) throw new QueryError(`Unknown column ${table}.${col}`);
    const type = cols[col];
    if (op === 'is') {
      if (val === null) sql.push(`${col} IS NULL`);
      else if (val === true || val === false) { sql.push(`${col} = ?`); args.push(val ? 1 : 0); }
      else throw new QueryError('Bad is() value');
    } else if (op === 'in') {
      const list = Array.isArray(val) ? val.slice(0, 1000) : [];
      if (!list.length) sql.push('0');
      else { sql.push(`${col} IN (${list.map(() => '?').join(',')})`); args.push(...list.map((v) => toDb(type, v))); }
    } else if (OPS[op]) {
      if (val === null && op === 'eq') sql.push(`${col} IS NULL`);
      else { sql.push(`${col} ${OPS[op]} ?`); args.push(toDb(type, val)); }
    } else {
      throw new QueryError(`Unsupported filter ${op}`);
    }
  }
  for (const e of extra) { sql.push(`(${e.sql})`); args.push(...e.args); }
  return { sql: sql.length ? ` WHERE ${sql.join(' AND ')}` : '', args };
}

function cleanRow(table, obj, { forInsert }) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new QueryError('Bad row');
  const cols = TABLES[table];
  const row = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!cols[k]) throw new QueryError(`Unknown column ${table}.${k}`);
    row[k] = v;
  }
  if (forInsert) {
    for (const [k, v] of Object.entries(DEFAULTS[table] || {})) if (row[k] === undefined) row[k] = v;
    if (!row.id) row.id = crypto.randomUUID();
    if (cols.created_at && !row.created_at) row.created_at = nowIso();
    if (cols.updated_at && !row.updated_at) row.updated_at = nowIso();
  }
  return row;
}

// ── permissions ──────────────────────────────────────────────
// Parents can do anything the app offers. Kids are limited to what the app lets them do:
// their own bank account (read-only), their own savings goals, their own tasks and race
// chores. Login PINs and push subscriptions are never reachable through this endpoint.
const KID_BANK_READ_ONLY = new Set(['bank_balances', 'bank_transactions']);

async function authorize(env, me, q, rows) {
  const extra = [];
  if (q.table === 'family_members' && q.op !== 'select') throw new QueryError('Not allowed', 403);
  if (me.role === 'parent') return extra;

  const own = { sql: 'family_member_id = ?', args: [me.id] };
  if (KID_BANK_READ_ONLY.has(q.table)) {
    if (q.op !== 'select') throw new QueryError('Only a parent can change the bank.', 403);
    extra.push(own);
  } else if (q.table === 'savings_goals') {
    extra.push(own);
    for (const r of rows) r.family_member_id = me.id;
  } else if (q.table === 'chore_schedules') {
    throw new QueryError('Only a parent can set up repeating chores.', 403);
  } else if (q.table === 'tasks') {
    // Kids see their own tasks and chores plus unclaimed first-to-grab chores — never
    // missed ones.
    const mine = { sql: '(assigned_to = ? OR open_to_kids = 1) AND missed_at IS NULL', args: [me.id] };
    if (q.op === 'select') {
      extra.push(mine);
    } else if (q.op === 'update') {
      const allowed = new Set(['completed_at', 'completed_by']);
      for (const k of Object.keys(rows[0])) if (!allowed.has(k)) throw new QueryError('Not allowed', 403);
      if (rows[0].completed_by != null && rows[0].completed_by !== me.id) throw new QueryError('Not allowed', 403);
      extra.push(mine);
      // Checking off only counts before the deadline, and the server sets the time
      // (it decides early bonuses, so a phone's clock can't).
      if (rows[0].completed_at != null) {
        rows[0].completed_at = new Date().toISOString();
        extra.push({ sql: 'due_at IS NULL OR due_at > ?', args: [new Date().toISOString()] });
      }
    } else if (q.op === 'delete') {
      extra.push({ sql: 'assigned_to = ? AND is_chore = 0', args: [me.id] });
    } else if (q.op === 'insert') {
      for (const r of rows) {
        if (r.is_chore === true || r.open_to_kids === true) throw new QueryError('Only a parent can create chores.', 403);
        r.assigned_to = me.id;
        r.created_by = me.id;
        for (const k of ['schedule_id', 'for_date', 'slot', 'due_at', 'missed_at', 'reject_note', 'reminded_at', 'bonus_at', 'bonus_amount']) delete r[k];
      }
    }
  }
  return extra;
}

// ── run one query ────────────────────────────────────────────
export async function runQuery(env, me, q) {
  if (!q || typeof q !== 'object' || !TABLES[q.table]) throw new QueryError('Unknown table');
  const table = q.table;
  const cols = TABLES[table];
  const op = q.op;

  let rows = [];
  if (op === 'insert') {
    rows = (Array.isArray(q.values) ? q.values : [q.values]).slice(0, 500).map((r) => cleanRow(table, r, { forInsert: true }));
    if (!rows.length) return { data: [] };
  } else if (op === 'update') {
    rows = [cleanRow(table, q.values, { forInsert: false })];
    delete rows[0].id;
    if (!Object.keys(rows[0]).length) throw new QueryError('Nothing to update');
  } else if (op !== 'select' && op !== 'delete') {
    throw new QueryError('Unknown operation');
  }

  const extra = await authorize(env, me, q, rows);
  const returning = op === 'select' || q.returning;
  const sel = returning ? parseSelect(table, q.select) : { cols: [], embeds: [] };
  let selCols = sel.cols;
  if (table === 'family_members') selCols = selCols.filter((c) => c !== 'pin_hash');
  // Embeds need the parent id even if the app didn't ask for it.
  const needId = sel.embeds.length && !selCols.includes('id');
  const colSql = [...selCols, ...(needId ? ['id'] : [])].join(', ') || 'id';

  let data;
  if (op === 'select') {
    const where = buildWhere(table, q.filters, extra);
    let sql = `SELECT ${colSql} FROM ${table}${where.sql}`;
    const order = (q.order || []).filter((o) => cols[o?.col]);
    if (order.length) sql += ' ORDER BY ' + order.map((o) => `${o.col} ${o.asc === false ? 'DESC' : 'ASC'}`).join(', ');
    const limit = Math.min(Number(q.limit) || MAX_ROWS, MAX_ROWS);
    sql += ` LIMIT ${limit}`;
    data = (await env.DB.prepare(sql).bind(...where.args).all()).results;
  } else if (op === 'insert') {
    const stmts = rows.map((r) => {
      const keys = Object.keys(r);
      const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
        + (returning ? ` RETURNING ${colSql}` : '');
      return env.DB.prepare(sql).bind(...keys.map((k) => toDb(cols[k], r[k])));
    });
    try {
      const res = await env.DB.batch(stmts);
      data = returning ? res.flatMap((r) => r.results) : null;
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new QueryError('duplicate key value violates unique constraint', 409);
      throw e;
    }
  } else if (op === 'update') {
    const keys = Object.keys(rows[0]);
    const where = buildWhere(table, q.filters, extra);
    if (!where.sql) throw new QueryError('Update needs a filter');
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${where.sql}`
      + (returning ? ` RETURNING ${colSql}` : '');
    const res = await env.DB.prepare(sql).bind(...keys.map((k) => toDb(cols[k], rows[0][k])), ...where.args).all();
    data = returning ? res.results : null;
  } else {
    const where = buildWhere(table, q.filters, extra);
    if (!where.sql) throw new QueryError('Delete needs a filter');
    const res = await env.DB.prepare(`DELETE FROM ${table}${where.sql}` + (returning ? ` RETURNING ${colSql}` : ''))
      .bind(...where.args).all();
    data = returning ? res.results : null;
  }

  if (op !== 'select') await bump(env, table);

  if (data) {
    data = data.map((r) => fromDb(table, r));
    for (const em of sel.embeds) {
      const ids = data.map((r) => r.id);
      const childCols = [...new Set([...em.cols, em.fk])];
      const children = ids.length
        ? (await env.DB.prepare(`SELECT ${childCols.join(', ')} FROM ${em.table} WHERE ${em.fk} IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all()).results.map((r) => fromDb(em.table, r))
        : [];
      for (const r of data) {
        r[em.table] = children.filter((c) => c[em.fk] === r.id).map((c) => {
          const o = {};
          for (const k of em.cols) o[k] = c[k];
          return o;
        });
      }
    }
    if (needId) for (const r of data) delete r.id;
  }
  return { data };
}

export async function bump(env, table) {
  await env.DB.prepare('INSERT INTO changes (tbl, v) VALUES (?1, 1) ON CONFLICT(tbl) DO UPDATE SET v = v + 1')
    .bind(table).run();
}

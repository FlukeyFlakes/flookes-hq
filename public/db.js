// Flookes HQ — database client.
// Speaks the same query language the app used with Supabase
// (db.from('tasks').select('*').eq('id', x).single()) but sends each query to this
// site's own Worker at /api/db, which checks sign-in and permissions and runs it on D1.
// db.channel() replaces Supabase realtime: it checks /api/changes every 15 seconds
// (and whenever the app comes back to the front) and calls back when a table changed.
(function () {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401 && !path.startsWith('/api/login')) {
      try { localStorage.removeItem('fhq_session'); } catch (_) {}
      if (!/\/(index\.html)?$/.test(location.pathname)) location.href = '/index.html';
    }
    return res;
  }

  class Query {
    constructor(table) {
      this.q = { table, op: 'select', select: '*', filters: [], order: [] };
      this.mode = null; // 'single' | 'maybe'
    }
    select(cols = '*') {
      if (this.q.op === 'select') this.q.select = cols;
      else { this.q.returning = true; this.q.select = cols; }
      return this;
    }
    insert(values) { this.q.op = 'insert'; this.q.values = values; return this; }
    update(values) { this.q.op = 'update'; this.q.values = values; return this; }
    delete() { this.q.op = 'delete'; return this; }
    _f(col, op, val) { this.q.filters.push([col, op, val]); return this; }
    eq(c, v) { return this._f(c, 'eq', v); }
    neq(c, v) { return this._f(c, 'neq', v); }
    gt(c, v) { return this._f(c, 'gt', v); }
    gte(c, v) { return this._f(c, 'gte', v); }
    lt(c, v) { return this._f(c, 'lt', v); }
    lte(c, v) { return this._f(c, 'lte', v); }
    is(c, v) { return this._f(c, 'is', v); }
    in(c, v) { return this._f(c, 'in', v); }
    order(col, opts = {}) { this.q.order.push({ col, asc: opts.ascending !== false }); return this; }
    limit(n) { this.q.limit = n; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    async run() {
      try {
        const res = await api('/api/db', { method: 'POST', body: JSON.stringify(this.q) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { data: null, error: body.error || { message: `HTTP ${res.status}` } };
        let data = body.data;
        if (this.mode && Array.isArray(data)) {
          if (data.length === 1) data = data[0];
          else if (data.length === 0 && this.mode === 'maybe') data = null;
          else return { data: null, error: { message: data.length ? 'More than one row' : 'No rows found', code: 'PGRST116' } };
        }
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message || 'Network error' } };
      }
    }
    then(resolve, reject) { return this.run().then(resolve, reject); }
  }

  // ── change polling (replaces realtime) ──
  const watchers = new Set();
  let last = null;
  let timer = null;
  async function poll() {
    if (document.visibilityState !== 'visible' || !watchers.size) return;
    try {
      const res = await api('/api/changes');
      if (!res.ok) return;
      const now = await res.json();
      if (last) {
        for (const w of watchers) if ((now[w.table] || 0) !== (last[w.table] || 0)) { try { w.cb(); } catch (_) {} }
      }
      last = now;
    } catch (_) {}
  }
  function start() {
    if (timer) return;
    timer = setInterval(poll, 15000);
    poll();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

  class Channel {
    constructor() { this.subs = []; }
    on(_type, filter, cb) { this.subs.push({ table: filter && filter.table, cb }); return this; }
    subscribe() { for (const s of this.subs) watchers.add(s); start(); return this; }
    unsubscribe() { for (const s of this.subs) watchers.delete(s); }
  }

  window.db = {
    from: (table) => new Query(table),
    channel: () => new Channel(),
    removeChannel: (ch) => ch && ch.unsubscribe(),
  };
  window.fhqApi = api;
})();

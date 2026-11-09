// D1 schema for Flookes HQ. Mirrors the old Supabase tables column-for-column so
// the app's queries keep working. Tables create themselves on first request.

// Column types per app table. 'bool' is stored as 0/1 and returned as true/false;
// 'num' is stored as REAL; 'int' as INTEGER; everything else is TEXT.
export const TABLES = {
  family_members: {
    id: 'text', name: 'text', role: 'text', emoji: 'text', pin_hash: 'text',
    color_primary: 'text', color_secondary: 'text', color_tertiary: 'text',
    display_order: 'int', created_at: 'text',
  },
  tasks: {
    id: 'text', title: 'text', description: 'text', created_by: 'text', assigned_to: 'text',
    priority: 'text', is_chore: 'bool', chore_amount: 'num', is_recurring: 'bool',
    recurrence_pattern: 'text', due_date: 'text', completed_at: 'text', completed_by: 'text',
    approved_by: 'text', approved_at: 'text', open_to_kids: 'bool', created_at: 'text',
    // Chores v2: which repeating chore and day a copy belongs to, its deadline, and
    // what happened to it. slot = the kid's id, or 'grab' for a first-to-grab copy.
    schedule_id: 'text', for_date: 'text', slot: 'text', due_at: 'text', due_time: 'text',
    missed_at: 'text', reject_note: 'text', reminded_at: 'text',
  },
  // Repeating chores, defined once. who: 'kid' (kid_id), 'each' (every kid gets a copy)
  // or 'grab' (one copy, first kid to do it). days: weekday digits, 0 = Sunday ("12345").
  chore_schedules: {
    id: 'text', title: 'text', description: 'text', amount: 'num', who: 'text', kid_id: 'text',
    days: 'text', due_time: 'text', start_date: 'text', end_date: 'text', paused: 'bool',
    priority: 'text', created_by: 'text', created_at: 'text', updated_at: 'text',
  },
  bank_balances: {
    id: 'text', family_member_id: 'text', balance: 'num', total_earned: 'num', updated_at: 'text',
  },
  bank_transactions: {
    id: 'text', family_member_id: 'text', amount: 'num', type: 'text', description: 'text',
    task_id: 'text', created_at: 'text',
  },
  savings_goals: {
    id: 'text', family_member_id: 'text', title: 'text', target_amount: 'num',
    created_at: 'text', achieved_at: 'text',
  },
  meals: {
    id: 'text', week_start_date: 'text', day_of_week: 'int', dinner_name: 'text',
    recipe_url: 'text', notes: 'text', created_by: 'text', created_at: 'text',
  },
  ingredients: {
    id: 'text', meal_id: 'text', name: 'text', quantity: 'text', store: 'text',
    category: 'text', created_at: 'text',
  },
  shopping_list_items: {
    id: 'text', ingredient_id: 'text', week_start_date: 'text', name: 'text', store: 'text',
    source: 'text', checked: 'bool', checked_by: 'text', checked_at: 'text', created_at: 'text',
  },
  meal_templates: {
    id: 'text', name: 'text', created_by: 'text', created_at: 'text',
  },
  template_ingredients: {
    id: 'text', template_id: 'text', name: 'text', store: 'text', created_at: 'text',
  },
};

// Defaults applied on insert when the app leaves a column out (same as Supabase's).
export const DEFAULTS = {
  tasks: { priority: 'medium', is_chore: false, chore_amount: 0, is_recurring: false, open_to_kids: false },
  bank_balances: { balance: 0, total_earned: 0 },
  ingredients: { store: 'any', category: 'other' },
  shopping_list_items: { checked: false },
  family_members: { emoji: '😊', display_order: 0 },
  chore_schedules: { amount: 0, who: 'grab', days: '0123456', paused: false, priority: 'medium' },
};

// Parent → child relations the app embeds in selects, e.g. meals?select=id,ingredients(name,store)
export const RELATIONS = {
  meals: { ingredients: 'meal_id' },
  meal_templates: { template_ingredients: 'template_id' },
};

const SQL_TYPE = { text: 'TEXT', int: 'INTEGER', num: 'REAL', bool: 'INTEGER' };

function tableSql(name, cols, extra = []) {
  const lines = Object.entries(cols).map(([c, t]) => (c === 'id' ? 'id TEXT PRIMARY KEY' : `${c} ${SQL_TYPE[t]}`));
  return `CREATE TABLE IF NOT EXISTS ${name} (\n  ${[...lines, ...extra].join(',\n  ')}\n)`;
}

export const SCHEMA = [
  ...Object.entries(TABLES).map(([name, cols]) =>
    tableSql(name, cols,
      name === 'bank_balances' ? ['UNIQUE(family_member_id)']
        : name === 'meals' ? ['UNIQUE(week_start_date, day_of_week)'] : [])),
  'CREATE INDEX IF NOT EXISTS tasks_assigned ON tasks(assigned_to)',
  'CREATE INDEX IF NOT EXISTS bank_tx_member ON bank_transactions(family_member_id, created_at)',
  'CREATE INDEX IF NOT EXISTS ingredients_meal ON ingredients(meal_id)',
  'CREATE INDEX IF NOT EXISTS shop_week ON shopping_list_items(week_start_date)',
  'CREATE INDEX IF NOT EXISTS tmpl_ing ON template_ingredients(template_id)',
  // Which repeating chores were already handed out on which day, so a copy a parent
  // deletes doesn't come back.
  `CREATE TABLE IF NOT EXISTS chore_runs (
     schedule_id TEXT NOT NULL,
     for_date    TEXT NOT NULL,
     PRIMARY KEY (schedule_id, for_date)
   )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id TEXT PRIMARY KEY,
     family_member_id TEXT NOT NULL,
     endpoint TEXT NOT NULL UNIQUE,
     subscription TEXT NOT NULL,
     device_info TEXT,
     created_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     member_id  TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
     member_id  TEXT PRIMARY KEY,
     failures   INTEGER NOT NULL,
     window_end INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // One counter per table, bumped on every write; the app polls it to know when to refresh.
  `CREATE TABLE IF NOT EXISTS changes (tbl TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  // Which scheduled jobs already ran today, so the hourly cron never doubles up.
  `CREATE TABLE IF NOT EXISTS job_runs (job TEXT PRIMARY KEY, ran_on TEXT NOT NULL)`,
];

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add them to an
// existing table, so each is added with ALTER TABLE (an error means it's already there).
export const MIGRATIONS = [
  ...['schedule_id', 'for_date', 'slot', 'due_at', 'due_time', 'missed_at', 'reject_note', 'reminded_at']
    .map((c) => `ALTER TABLE tasks ADD COLUMN ${c} TEXT`),
];
export const AFTER_MIGRATIONS = [
  'CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_slot ON tasks(schedule_id, for_date, slot)',
  'CREATE INDEX IF NOT EXISTS tasks_open_chores ON tasks(is_chore, completed_at, missed_at)',
];

-- =====================================================
-- FLOOKES HQ — Supabase Database Setup
-- Run this entire file in Supabase SQL Editor
-- =====================================================

-- =====================================================
-- FAMILY MEMBERS
-- =====================================================
CREATE TABLE IF NOT EXISTS family_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  emoji TEXT NOT NULL DEFAULT '😊',
  pin_hash TEXT NOT NULL,
  color_primary TEXT NOT NULL,
  color_secondary TEXT NOT NULL,
  color_tertiary TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon read" ON family_members;
DROP POLICY IF EXISTS "Allow anon update" ON family_members;
CREATE POLICY "Allow anon read" ON family_members FOR SELECT USING (true);
CREATE POLICY "Allow anon update" ON family_members FOR UPDATE USING (true);

-- =====================================================
-- TASKS & CHORES
-- =====================================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES family_members(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  is_chore BOOLEAN DEFAULT FALSE,
  chore_amount DECIMAL(10,2) DEFAULT 0,
  is_recurring BOOLEAN DEFAULT FALSE,
  recurrence_pattern TEXT CHECK (recurrence_pattern IN ('daily', 'weekly', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON tasks;
CREATE POLICY "Allow anon all" ON tasks FOR ALL USING (true);

-- =====================================================
-- BANK BALANCES (kids only)
-- =====================================================
CREATE TABLE IF NOT EXISTS bank_balances (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  family_member_id UUID REFERENCES family_members(id) ON DELETE CASCADE UNIQUE,
  balance DECIMAL(10,2) DEFAULT 0,
  total_earned DECIMAL(10,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON bank_balances;
CREATE POLICY "Allow anon all" ON bank_balances FOR ALL USING (true);

-- =====================================================
-- BANK TRANSACTIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  family_member_id UUID REFERENCES family_members(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('earned', 'payout')),
  description TEXT,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON bank_transactions;
CREATE POLICY "Allow anon all" ON bank_transactions FOR ALL USING (true);

-- =====================================================
-- SAVINGS GOALS
-- =====================================================
CREATE TABLE IF NOT EXISTS savings_goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  family_member_id UUID REFERENCES family_members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  achieved_at TIMESTAMPTZ
);

ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON savings_goals;
CREATE POLICY "Allow anon all" ON savings_goals FOR ALL USING (true);

-- =====================================================
-- WEEKLY MEAL PLAN
-- day_of_week: 0=Sunday, 1=Monday ... 6=Saturday
-- =====================================================
CREATE TABLE IF NOT EXISTS meals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start_date DATE NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  dinner_name TEXT NOT NULL,
  recipe_url TEXT,
  notes TEXT,
  created_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(week_start_date, day_of_week)
);

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON meals;
CREATE POLICY "Allow anon all" ON meals FOR ALL USING (true);

-- =====================================================
-- MEAL INGREDIENTS
-- =====================================================
CREATE TABLE IF NOT EXISTS ingredients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  meal_id UUID REFERENCES meals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity TEXT,
  store TEXT DEFAULT 'any' CHECK (store IN ('trader_joes', 'costco', 'whole_foods', 'any')),
  category TEXT DEFAULT 'other',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON ingredients;
CREATE POLICY "Allow anon all" ON ingredients FOR ALL USING (true);

-- =====================================================
-- SHOPPING LIST
-- =====================================================
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  checked BOOLEAN DEFAULT FALSE,
  checked_by UUID REFERENCES family_members(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE shopping_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON shopping_list_items;
CREATE POLICY "Allow anon all" ON shopping_list_items FOR ALL USING (true);

-- =====================================================
-- PUSH NOTIFICATION SUBSCRIPTIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  family_member_id UUID REFERENCES family_members(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL,
  device_info TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all" ON push_subscriptions;
CREATE POLICY "Allow anon all" ON push_subscriptions FOR ALL USING (true);

-- =====================================================
-- SEED: FAMILY MEMBERS
-- Default PIN for everyone: 1234
-- SHA-256("1234") = 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
-- IMPORTANT: Each person should change their PIN after first login
-- =====================================================
INSERT INTO family_members (name, role, emoji, pin_hash, color_primary, color_secondary, color_tertiary, display_order)
VALUES
  ('Jonathan', 'parent', '⚡', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', '#D4A017', '#1B2A4A', '#C4622D', 1),
  ('Courtney', 'parent', '🌿', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', '#7D9E6E', '#F5E6C8', '#C4918A', 2),
  ('Henry',   'kid',    '🎮', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', '#6B35C8', '#1E5FC8', '#C82020', 3),
  ('Audrey',  'kid',    '🌷', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4', '#B08ED4', '#F4A7C0', '#A8C8E8', 4)
ON CONFLICT DO NOTHING;

-- Initialize bank balances for kids
INSERT INTO bank_balances (family_member_id, balance, total_earned)
SELECT id, 0, 0 FROM family_members WHERE role = 'kid'
ON CONFLICT DO NOTHING;

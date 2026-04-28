# Flookes HQ 🏠⚡

The Flookes Family Command Center — a Progressive Web App for the Flookes family.

**Live at:** [family.flookesitup.com](https://family.flookesitup.com)

---

## First-Time Setup

### 1. Run the Supabase Schema
- Go to [supabase.com](https://supabase.com) → your `flookes-hq` project
- Click **SQL Editor** in the left sidebar
- Open `supabase-setup.sql` from this repo
- Paste the entire contents and click **Run**
- You should see all tables created and 4 family members inserted

### 2. Default PINs
All 4 family members start with PIN: **1234**

Each person should change their PIN after first login (PIN change feature coming soon — for now, update via Supabase dashboard if needed).

### 3. Add to Home Screen (iPhone)
1. Open Safari and go to `family.flookesitup.com`
2. Tap the **Share** button (box with arrow)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**

The app will appear on your home screen as **Flookes HQ**.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Hosting | GitHub Pages → `family.flookesitup.com` |
| Database + Auth | Supabase (free tier) |
| API Security | Cloudflare Workers |
| Weather | Open-Meteo (free, no key) |
| Calendar | Google Calendar API |
| PWA | Service Worker + Web Manifest |

---

## Build Progress

- [x] Project setup & planning
- [x] Supabase schema (all tables)
- [x] Login page (PIN-based, 4 profiles)
- [x] Dashboard skeleton (app.html)
- [x] PWA manifest + service worker
- [ ] Weather widget (Open-Meteo)
- [ ] Google Calendar integration
- [ ] Tasks & Chores system
- [ ] Chore Bank (balances, approvals, payouts)
- [ ] Savings Goals
- [ ] Meal Planner (weekly dinners)
- [ ] Shopping List (by store, live)
- [ ] Push Notifications
- [ ] iPad two-column layout
- [ ] PIN change in-app

---

*Built with Claude · Flookes Family · Napa, CA*

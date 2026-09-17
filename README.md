# Sorella Tea iPad Touch POS

A touch-first point-of-sale for Sorella Tea, built as a static HTML/CSS/JS frontend
(preserving the original pastel pink/cream branding and layout) backed by a Netlify DB
(Postgres via Drizzle) for real, redeploy-safe persistence.

## Stack

- Frontend: plain HTML/CSS/JS (`index.html`, `styles.css`, `app.js`) — no build step.
- Backend: a single Netlify Function (`netlify/functions/api.ts`) routed at `/api/*`, using
  Drizzle ORM against Netlify DB (managed Postgres).
- Schema: `db/schema.ts`. Migrations live in `netlify/database/migrations/` and are applied
  automatically by Netlify on deploy.

## Data model

Categories, series, products, ingredients, recipes (BOM), expenses, orders, held orders,
inventory movements and settings are all stored in the database — never in localStorage.
Only the in-progress cart is cached in the browser (`localStorage`) so an accidental refresh
mid-sale isn't lost; it is never treated as a source of truth for business data.

Inventory is only ever deducted when an order is completed (via each product's recipe),
recorded as a `Sale` movement. Manual stock changes (Stock In / Waste / Adjustment / Return /
Correction) go through the same `inventory_movements` ledger via Manage → Stock Movement.

## Local development

```
npm install
netlify dev
```

## Backup / restore

Settings → Export Backup JSON downloads a full snapshot from `/api/backup`. Import Backup
JSON restores it via `/api/restore`, which only inserts/updates records — it never deletes or
truncates existing data.

## v2.0.3 update
This version is intended for a fresh/test Netlify deployment first. It includes the full-product image presentation, realistic replacement visuals, canonical category grouping, and an improved Copilot message composer. No database schema migration is required. The first state load reconciles the menu categories and hides the legacy Hot Coffee section while retaining its records.

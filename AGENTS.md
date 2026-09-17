# AGENTS.md

## Architecture

- `index.html` / `styles.css` — the original Sorella Tea visual design, unchanged. Do not
  restyle or restructure; this is a deliberate constraint (pastel pink/cream branding, sidebar
  nav, floating review modal), not an oversight.
- `app.js` — all frontend logic. Talks to the backend exclusively through `api(path, method, body)`
  which hits `/api/*`. The only thing kept in `localStorage` is the in-progress cart
  (`sorellaTeaPOS_cart_v1`) — everything else (menu, categories, series, ingredients, recipes,
  expenses, orders, held orders, movements) is server state, re-fetched via `loadServerState()`.
- `netlify/functions/api.ts` — one Netlify Function handling all `/api/*` resources
  (categories, series, products, ingredients, recipes, expenses, orders, held-orders,
  ingredient-stock-in, movements, backup, restore). `completeOrder()` is the only code path
  that deducts inventory — it validates, records the order, then deducts recipe ingredients and
  writes `inventory_movements` rows, in that order. Nothing else touches `ingredients.currentStock`
  for sales.
- `db/schema.ts` — Drizzle schema, source of truth for the DB shape. Any schema change requires
  a new migration via `npx drizzle-kit generate` (never edit an applied migration, never run
  `drizzle-kit push/migrate` or raw DDL).
- `db/seedData.js` — one-time seed data (categories, series, products, ingredients, one worked
  recipe example), reconciled against `Sorella_Tea_iPad_Touch_POS.xlsx`. `ensureSeeded()` in
  `api.ts` only seeds an empty database — it never overwrites existing rows.

## Conventions / non-obvious decisions

- Drink sizes are always `TALL (12oz)` / `GRANDE (16oz)` / `VENTI (22oz)`; snack sizes are
  `SMALL` / `MEDIUM` / `LARGE`. Recipe `sizeLabel` must match one of these exactly (or `"ALL"`
  as a wildcard) — the original workbook's bare `"16oz"` labels never matched and silently broke
  costing, which is why seed recipes use the full label.
- Discounts are percentage-based and stored per-order (`discountPercent`/`discountAmount`); they
  never mutate `products.sizes` (the base price).
  Profit math: `Gross Profit = Revenue − COGS` (per order, `ingredientCost` from matching
  recipes); `Estimated Net Profit = Gross Profit − Misc Expenses` (computed in Reports, not
  stored per-order).
- `products.id` / `ingredients.id` / `recipes.id` / `expenses.id` are stable app-generated
  strings (not autoincrement), so seeding and restore can safely upsert without duplicating.
- Restore (`POST /api/restore`) is additive/upsert-only by design — it must never truncate a
  table, so a bad or partial backup file can't destroy existing business data.
- Several placeholder product photos are reused from the closest matching flavor (documented via
  each product's `description` field in `db/seedData.js`) where no dedicated photo was supplied —
  replace them with real photography rather than leaving the description stale.

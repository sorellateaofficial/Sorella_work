# Sorella Tea POS — Copilot Version

Added a built-in **Sorella Copilot** view to the existing vanilla-JS POS.

## Included
- Sorella AI sidebar entry.
- iPad-friendly Copilot chat interface.
- Menu-aware commands using the POS data already loaded from `/api/state` and `/api/orders`.
- Quick actions for menu summary, missing images, today's sales, low stock, and Taro pricing.
- Safe menu-price changes with an explicit confirmation step before writing to `/api/products/:id`.
- Drink size awareness: Tall (12oz) → Grande (16oz) → Venti (22oz).
- Snack size awareness: Small → Medium → Large.
- Snack flavor-aware price changes for Cheese, Barbecue, and Sour Cream.
- No new database migration.
- No changes to the existing production database schema.
- Approved Sorella visual reference included at `assets/sorella_product_visual_reference.png` for future image-gallery work.

## Important
This first Copilot is intentionally **local and deterministic**. It does not require an AI API key and cannot invent unrestricted database writes. It provides a foundation for a future connected LLM/AI Gateway while keeping POS changes behind explicit confirmation.

## v2.0.3 — Realistic imagery + category regrouping + message composer

- Product cards and item modal now use a taller 4:5 presentation with `object-fit: contain` so full cups/items remain visible instead of being cropped.
- Added cache-busting for product image paths so updated assets are not hidden by stale browser image cache.
- Added new realistic Sorella-style product visuals for Blueberry Fruit Soda, Ana's Fruit Tea, and Fries.
- Added `Ana's Fruit Tea` to the Fruit Tea category.
- Canonical menu grouping keeps Fruit Tea flavors in Fruit Tea, soda products in Fruit Soda, milk tea in Milk Tea, and fries/snacks in Snacks.
- The old Hot Coffee section is disabled/hidden in the POS as requested; existing Hot Coffee records are retained but marked inactive rather than deleted.
- Existing database records are reconciled when the POS state loads, so deploying this version updates category placement without requiring a schema migration.
- Copilot now has a proper multiline message composer, Enter-to-send, Shift+Enter for a new line, New Chat, and a Regroup Categories quick action.
- Price changes remain confirmation-gated before database writes.

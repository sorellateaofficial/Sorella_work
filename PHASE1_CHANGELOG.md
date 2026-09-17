# Sorella Tea POS vNext — Phase 1

Changes in this build:
- Canonical drink size order: Tall (12oz), Grande (16oz), Venti (22oz).
- Canonical snack size order: Small, Medium, Large.
- Product cards now use true 1:1 image frames and contain rendering.
- Product image is now shown in the item/size/flavor modal.
- Shared product-image rendering with fallback and broken-image recovery.
- Added `assets/sorella-default-product.svg` as a safe default/fallback asset.
- Existing product IDs, database migration, POS checkout, and database schema were preserved.
- No database migration was added.
- No Sorella AI Admin, authentication, or upload gallery was added in this phase.
- Existing source assets were not replaced; the realistic photography gallery remains a separate content-generation step.

Before production deployment:
1. Test this build as a separate Netlify site if possible.
2. Confirm the existing production database is not accidentally replaced.
3. Replace the fallback SVG and current tight-cropped source photos with approved full-product realistic images.

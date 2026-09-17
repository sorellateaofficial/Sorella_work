import type { Config, Context } from "@netlify/functions";
import { eq, asc } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  categories,
  series,
  products,
  ingredients,
  recipes,
  expenses,
  orders,
  heldOrders,
  inventoryMovements,
  settings,
} from "../../db/schema.js";
import { CATEGORIES, SERIES, PRODUCTS, INGREDIENTS, RECIPES, PRODUCT_IMAGE_OVERRIDES } from "../../db/seedData.js";

function json(data: unknown, init: number | ResponseInit = 200) {
  const opts: ResponseInit = typeof init === "number" ? { status: init } : init;
  return new Response(JSON.stringify(data), {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
}

function newId(prefix: string) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function ensureSeeded() {
  const existing = await db.select({ id: categories.id }).from(categories).limit(1);
  if (existing.length) return;
  await db.insert(categories).values(CATEGORIES.map((name, i) => ({ name, position: i, active: true })));
  await db.insert(series).values(SERIES.map((name, i) => ({ name, position: i, active: true })));
  await db.insert(products).values(
    PRODUCTS.map((p: any) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      seriesName: p.seriesName || "",
      type: p.type,
      sizes: p.sizes,
      flavors: p.flavors || null,
      image: p.image,
      description: p.description || "",
      active: p.active !== false,
    }))
  );
  await db.insert(ingredients).values(
    INGREDIENTS.map((i: any) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      unit: i.unit,
      currentStock: String(i.currentStock ?? 0),
      minStock: String(i.minStock ?? 0),
      costPerUnit: String(i.costPerUnit ?? 0),
      purchaseQty: String(i.purchaseQty ?? 0),
      purchaseCost: String(i.purchaseCost ?? 0),
      supplier: i.supplier || "",
      active: true,
    }))
  );
  await db.insert(recipes).values(
    RECIPES.map((r: any) => ({
      id: r.id,
      productId: r.productId,
      productName: r.productName,
      sizeLabel: r.sizeLabel,
      ingredientId: r.ingredientId,
      ingredientName: r.ingredientName,
      qty: String(r.qty ?? 0),
      unit: r.unit,
      active: true,
    }))
  );
  await db.insert(settings).values([{ key: "business", value: { name: "Sorella Tea", currency: "PHP" } }]);
}

async function reconcileMenu() {
  const rows = await db.select().from(products);
  const desiredCategorySet = new Set(CATEGORIES);
  const catRows = await db.select().from(categories);
  const byCat = new Map(catRows.map((c: any) => [c.name.toLowerCase(), c]));

  // Keep the canonical POS categories and order. Existing custom categories are preserved but
  // the old Hot Coffee tab is disabled so the order screen stays grouped around the approved menu.
  for (let i = 0; i < CATEGORIES.length; i++) {
    const name = CATEGORIES[i];
    const existing = byCat.get(name.toLowerCase());
    if (existing) {
      if (existing.position !== i || existing.active === false) {
        await db.update(categories).set({ position: i, active: true }).where(eq(categories.id, existing.id));
      }
    } else {
      await db.insert(categories).values({ name, position: i, active: true });
    }
  }
  const refreshedCats = await db.select().from(categories);
  for (const c of refreshedCats as any[]) {
    if (!desiredCategorySet.has(c.name) && c.name.toLowerCase() === "hot coffee" && c.active !== false) {
      await db.update(categories).set({ active: false }).where(eq(categories.id, c.id));
    }
  }

  const canonicalCategory = (p: any) => {
    const name = String(p.name || "").toLowerCase();
    if (p.type === "snack" || /fries|snack/.test(name)) return "Snacks";
    if (/fruit\s+soda|\bsoda\b/.test(name)) return "Fruit Soda";
    if (/fruit\s+tea/.test(name)) return "Fruit Tea";
    if (p.category === "Hot Coffee") return null;
    if (desiredCategorySet.has(p.category)) return p.category;
    return p.category || "Milk Tea";
  };

  // Add any newly bundled menu items to an existing production/test database without deleting or
  // overwriting the operator's existing products. This makes each ZIP upgrade additive and safe.
  const existingIds = new Set(rows.map((p: any) => p.id));
  const newProducts = PRODUCTS.filter((p: any) => !existingIds.has(p.id));
  if (newProducts.length) {
    await db.insert(products).values(newProducts.map((p: any) => ({
      id: p.id, name: p.name, category: p.category, seriesName: p.seriesName || "", type: p.type,
      sizes: p.sizes, flavors: p.flavors || null, image: p.image, description: p.description || "", active: p.active !== false,
    })));
  }

  const seriesRows = await db.select().from(series);
  const seriesByName = new Map((seriesRows as any[]).map(s => [s.name.toLowerCase(), s]));
  for (let i = 0; i < SERIES.length; i++) {
    const name = SERIES[i];
    if (!seriesByName.has(name.toLowerCase())) {
      await db.insert(series).values({ name, position: seriesRows.length + i, active: true });
    }
  }

  const seriesMap: Record<string,string> = {
    "Classic Milk Tea":"Signature Series", "Okinawa":"Signature Series", "Hokkaido":"Signature Series",
    "Winter Melon":"Signature Series", "Taro":"Taro Series", "Ice Taro Strawberry Milk":"Taro Series",
    "Iced Taro Brown Sugar":"Taro Series", "Matcha":"Matcha Series", "Matcha Strawberry Milk":"Matcha Series",
    "Chocolate Matcha":"Matcha Series", "Mango Cheesecake":"Cloudy Series", "Milky Chocolate":"Cloudy Series",
    "Strawberry Chocolate":"Chocolate Series", "Black Forest":"Chocolate Series",
    "Iced Caramel Macchiato":"Caramel Series", "Iced Salted Caramel":"Caramel Series",
    "Iced Mocha":"Mocha Series", "Iced Chocolate":"Chocolate Series", "Iced Vanilla Latte":"Vanilla Series",
    "Iced Hazelnut Latte":"Hazelnut Series", "Iced Hazelnut":"Hazelnut Series", "Iced Spanish Latte":"Signature Series",
  };

  const allRows = await db.select().from(products);
  for (const p of allRows as any[]) {
    const category = canonicalCategory(p);
    const image = PRODUCT_IMAGE_OVERRIDES[p.id as keyof typeof PRODUCT_IMAGE_OVERRIDES] || p.image;
    const patch: any = {};
    if (category === null && p.category === "Hot Coffee") patch.active = false;
    else if (category && category !== p.category) patch.category = category;
    if (image && image !== p.image) patch.image = image;
    if (seriesMap[p.name] && p.seriesName !== seriesMap[p.name]) patch.seriesName = seriesMap[p.name];
    if (Object.keys(patch).length) await db.update(products).set(patch).where(eq(products.id, p.id));
  }
}

async function getFullState() {
  await ensureSeeded();
  await reconcileMenu();
  const [cats, ser, prods, ings, recs, exps, held, sett] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.position)),
    db.select().from(series).orderBy(asc(series.position)),
    db.select().from(products),
    db.select().from(ingredients),
    db.select().from(recipes),
    db.select().from(expenses).orderBy(asc(expenses.createdAt)),
    db.select().from(heldOrders).orderBy(asc(heldOrders.createdAt)),
    db.select().from(settings),
  ]);
  return { categories: cats, series: ser, products: prods, ingredients: ings, recipes: recs, expenses: exps, heldOrders: held, settings: sett };
}

function computeItemIngredientCost(item: any, recipeRows: any[], ingredientRows: any[]) {
  const ingByName = new Map(ingredientRows.map((i: any) => [i.name, i]));
  const matching = recipeRows.filter(
    (r: any) => r.active !== false && r.productName === item.name && (r.sizeLabel === item.size || r.sizeLabel === "ALL")
  );
  return matching.reduce((sum: number, r: any) => {
    const ing = ingByName.get(r.ingredientName);
    const cpu = ing ? Number(ing.costPerUnit) : 0;
    return sum + cpu * Number(r.qty) * Number(item.qty);
  }, 0);
}

async function completeOrder(req: Request) {
  const body = await req.json();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "Order has no items." }, 400);

  const subtotal = items.reduce((a: number, x: any) => a + Number(x.qty) * Number(x.price), 0);
  const discountPercent = Math.max(0, Math.min(100, Number(body.discountPercent) || 0));
  const discountAmount = Math.round(subtotal * discountPercent) / 100;
  const total = subtotal - discountAmount;
  const cash = Number(body.cash) || 0;
  if (cash > 0 && cash < total) return json({ error: "Cash received is less than the total." }, 400);

  const [recipeRows, ingredientRows] = await Promise.all([
    db.select().from(recipes),
    db.select().from(ingredients),
  ]);

  const ingredientCost = items.reduce((a: number, item: any) => a + computeItemIngredientCost(item, recipeRows, ingredientRows), 0);
  const profit = total - ingredientCost;

  const now = new Date();
  const orderId = "ORD-" + now.toISOString().replace(/\D/g, "").slice(0, 14);
  const date = now.toISOString().slice(0, 10);
  const time = now.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });

  const order = {
    id: orderId,
    date,
    time,
    items,
    subtotal: String(subtotal),
    discountPercent: String(discountPercent),
    discountAmount: String(discountAmount),
    total: String(total),
    cash: String(cash),
    change: String(Math.max(0, cash - total)),
    payment: body.payment || "Cash",
    cashier: body.cashier || "",
    ingredientCost: String(ingredientCost),
    profit: String(profit),
  };

  // Only deduct inventory once the sale is actually recorded — never during browsing/edit/cancel/hold.
  await db.insert(orders).values(order);

  const ingById = new Map(ingredientRows.map((i: any) => [i.id, i]));
  const ingByName = new Map(ingredientRows.map((i: any) => [i.name, i]));
  const deductions = new Map<string, number>();
  for (const item of items) {
    const matching = recipeRows.filter(
      (r: any) => r.active !== false && r.productName === item.name && (r.sizeLabel === item.size || r.sizeLabel === "ALL")
    );
    for (const r of matching) {
      const ing = r.ingredientId ? ingById.get(r.ingredientId) : ingByName.get(r.ingredientName);
      if (!ing) continue;
      const qty = Number(r.qty) * Number(item.qty);
      deductions.set(ing.id, (deductions.get(ing.id) || 0) + qty);
    }
  }
  for (const [ingId, qty] of deductions) {
    const ing = ingById.get(ingId);
    const newStock = Number(ing.currentStock) - qty;
    await db.update(ingredients).set({ currentStock: String(newStock) }).where(eq(ingredients.id, ingId));
    await db.insert(inventoryMovements).values({
      ingredientId: ingId,
      ingredientName: ing.name,
      type: "Sale",
      qty: String(-qty),
      note: `Order ${orderId}`,
      orderId,
    });
  }

  return json(order, 201);
}

async function handleResource(req: Request, resource: string, id: string | null) {
  const method = req.method;

  if (resource === "state" && method === "GET") return json(await getFullState());

  if (resource === "categories") {
    if (method === "POST") {
      const b = await req.json();
      if (id) {
        const [row] = await db.update(categories).set(b).where(eq(categories.id, Number(id))).returning();
        return json(row);
      }
      const [row] = await db.insert(categories).values(b).returning();
      return json(row, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(categories).where(eq(categories.id, Number(id)));
      return json({ ok: true });
    }
  }

  if (resource === "series") {
    if (method === "POST") {
      const b = await req.json();
      if (id) {
        const [row] = await db.update(series).set(b).where(eq(series.id, Number(id))).returning();
        return json(row);
      }
      const [row] = await db.insert(series).values(b).returning();
      return json(row, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(series).where(eq(series.id, Number(id)));
      return json({ ok: true });
    }
  }

  if (resource === "products") {
    if (method === "POST") {
      const b = await req.json();
      const pid = id || b.id || newId("PROD_");
      const row = { ...b, id: pid };
      const [saved] = await db
        .insert(products)
        .values(row)
        .onConflictDoUpdate({ target: products.id, set: row })
        .returning();
      return json(saved, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(products).where(eq(products.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "ingredients") {
    if (method === "POST") {
      const b = await req.json();
      const iid = id || b.id || newId("ING_");
      const row = { ...b, id: iid };
      const [before] = await db.select().from(ingredients).where(eq(ingredients.id, iid));
      const [saved] = await db
        .insert(ingredients)
        .values(row)
        .onConflictDoUpdate({ target: ingredients.id, set: row })
        .returning();
      if (before && before.name !== saved.name) {
        await db.update(recipes).set({ ingredientName: saved.name }).where(eq(recipes.ingredientId, saved.id));
      }
      return json(saved, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(ingredients).where(eq(ingredients.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "recipes") {
    if (method === "POST") {
      const b = await req.json();
      const rid = id || b.id || newId("REC_");
      const row = { ...b, id: rid };
      const [saved] = await db
        .insert(recipes)
        .values(row)
        .onConflictDoUpdate({ target: recipes.id, set: row })
        .returning();
      return json(saved, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(recipes).where(eq(recipes.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "expenses") {
    if (method === "POST") {
      const b = await req.json();
      const eid = id || b.id || newId("EXP_");
      const row = { ...b, id: eid };
      const [saved] = await db
        .insert(expenses)
        .values(row)
        .onConflictDoUpdate({ target: expenses.id, set: row })
        .returning();
      return json(saved, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(expenses).where(eq(expenses.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "ingredient-stock-in" && method === "POST") {
    const b = await req.json();
    const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, b.ingredientId));
    if (!ing) return json({ error: "Ingredient not found." }, 404);
    const qty = Number(b.qty) || 0;
    const type = b.type || "Stock In"; // Stock In | Adjustment | Waste | Return | Correction
    const signedQty = type === "Waste" ? -Math.abs(qty) : qty;
    const newStock = Number(ing.currentStock) + signedQty;
    await db.update(ingredients).set({ currentStock: String(newStock) }).where(eq(ingredients.id, ing.id));
    const [movement] = await db
      .insert(inventoryMovements)
      .values({ ingredientId: ing.id, ingredientName: ing.name, type, qty: String(signedQty), note: b.note || "" })
      .returning();
    return json(movement, 201);
  }

  if (resource === "ingredient-stock-set" && method === "POST") {
    const b = await req.json();
    const [ing] = await db.select().from(ingredients).where(eq(ingredients.id, b.ingredientId));
    if (!ing) return json({ error: "Ingredient not found." }, 404);
    const newStock = Number(b.currentStock);
    if (!Number.isFinite(newStock) || newStock < 0) return json({ error: "Enter a valid non-negative stock quantity." }, 400);
    const oldStock = Number(ing.currentStock);
    const delta = newStock - oldStock;
    await db.update(ingredients).set({
      name: b.name ?? ing.name,
      category: b.category ?? ing.category,
      unit: b.unit ?? ing.unit,
      currentStock: String(newStock),
      minStock: String(b.minStock ?? ing.minStock),
      costPerUnit: String(b.costPerUnit ?? ing.costPerUnit),
      supplier: b.supplier ?? ing.supplier,
      active: b.active === undefined ? ing.active : !!b.active,
    }).where(eq(ingredients.id, ing.id));
    if (delta !== 0) {
      await db.insert(inventoryMovements).values({
        ingredientId: ing.id, ingredientName: String(b.name ?? ing.name),
        type: "Correction", qty: String(delta), note: b.note || "Manual inventory edit"
      });
    }
    const [saved] = await db.select().from(ingredients).where(eq(ingredients.id, ing.id));
    return json(saved);
  }

  if (resource === "movements" && method === "GET") {
    const rows = await db.select().from(inventoryMovements).orderBy(asc(inventoryMovements.createdAt));
    return json(rows);
  }

  if (resource === "orders") {
    if (method === "GET") {
      const rows = await db.select().from(orders).orderBy(asc(orders.createdAt));
      return json(rows);
    }
    if (method === "POST") return completeOrder(req);
    if (method === "DELETE" && id) {
      // Sales are an audit ledger; only used for the explicit "clear saved sales" maintenance action.
      await db.delete(orders).where(eq(orders.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "orders-clear" && method === "POST") {
    await db.delete(orders);
    return json({ ok: true });
  }

  if (resource === "held-orders") {
    if (method === "GET") return json(await db.select().from(heldOrders).orderBy(asc(heldOrders.createdAt)));
    if (method === "POST") {
      const b = await req.json();
      const hid = b.id || newId("HOLD_");
      const [row] = await db.insert(heldOrders).values({ id: hid, items: b.items, discountPercent: String(b.discountPercent || 0) }).returning();
      return json(row, 201);
    }
    if (method === "DELETE" && id) {
      await db.delete(heldOrders).where(eq(heldOrders.id, id));
      return json({ ok: true });
    }
  }

  if (resource === "backup" && method === "GET") {
    const state = await getFullState();
    const [ord, held, moves] = await Promise.all([
      db.select().from(orders),
      db.select().from(heldOrders),
      db.select().from(inventoryMovements),
    ]);
    return json({ ...state, orders: ord, heldOrders: held, inventoryMovements: moves, exportedAt: new Date().toISOString() });
  }

  if (resource === "restore" && method === "POST") {
    const b = await req.json();
    // Restore is additive/upsert only — it never truncates existing tables, so a bad backup can't wipe data.
    const tasks: Promise<any>[] = [];
    for (const c of b.categories || []) tasks.push(db.insert(categories).values({ name: c.name, position: c.position ?? 0, active: c.active !== false }).onConflictDoNothing());
    for (const s of b.series || []) tasks.push(db.insert(series).values({ name: s.name, position: s.position ?? 0, active: s.active !== false }).onConflictDoNothing());
    for (const p of b.products || []) tasks.push(db.insert(products).values(p).onConflictDoUpdate({ target: products.id, set: p }));
    for (const i of b.ingredients || []) tasks.push(db.insert(ingredients).values(i).onConflictDoUpdate({ target: ingredients.id, set: i }));
    for (const r of b.recipes || []) tasks.push(db.insert(recipes).values(r).onConflictDoUpdate({ target: recipes.id, set: r }));
    for (const e of b.expenses || []) tasks.push(db.insert(expenses).values(e).onConflictDoNothing());
    for (const o of b.orders || []) tasks.push(db.insert(orders).values(o).onConflictDoNothing());
    await Promise.all(tasks);
    return json({ ok: true, restored: true });
  }

  return json({ error: "Not found" }, 404);
}

export default async (req: Request, _context: Context) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
    const resource = parts[0] || "";
    const id = parts[1] || null;
    return await handleResource(req, resource, id);
  } catch (err: any) {
    console.error("API error:", err);
    return json({ error: err?.message || "Internal error" }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};

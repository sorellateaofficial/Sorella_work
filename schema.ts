import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  serial,
} from "drizzle-orm/pg-core";

export const categories = pgTable("categories", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  position: integer("position").notNull().default(0),
  active: boolean().notNull().default(true),
});

export const series = pgTable("series", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  position: integer("position").notNull().default(0),
  active: boolean().notNull().default(true),
});

export const products = pgTable("products", {
  id: text().primaryKey(),
  name: text().notNull(),
  category: text().notNull(),
  seriesName: text("series_name").default(""),
  type: text().notNull().default("drink"),
  sizes: jsonb().notNull().default({}),
  flavors: jsonb(),
  image: text(),
  sku: text(),
  description: text(),
  cost: numeric().default("0"),
  active: boolean().notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ingredients = pgTable("ingredients", {
  id: text().primaryKey(),
  name: text().notNull(),
  category: text().default("Other"),
  unit: text().notNull().default("pcs"),
  currentStock: numeric("current_stock").notNull().default("0"),
  minStock: numeric("min_stock").notNull().default("0"),
  costPerUnit: numeric("cost_per_unit").notNull().default("0"),
  purchaseQty: numeric("purchase_qty").default("0"),
  purchaseCost: numeric("purchase_cost").default("0"),
  supplier: text().default(""),
  active: boolean().notNull().default(true),
});

export const recipes = pgTable("recipes", {
  id: text().primaryKey(),
  productId: text("product_id"),
  productName: text("product_name").notNull(),
  sizeLabel: text("size_label").notNull().default("ALL"),
  ingredientId: text("ingredient_id"),
  ingredientName: text("ingredient_name").notNull(),
  qty: numeric().notNull().default("0"),
  unit: text().default("pcs"),
  active: boolean().notNull().default(true),
});

export const expenses = pgTable("expenses", {
  id: text().primaryKey(),
  date: text().notNull(),
  category: text().notNull(),
  description: text().default(""),
  amount: numeric().notNull().default("0"),
  payment: text().default(""),
  notes: text().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

export const orders = pgTable("orders", {
  id: text().primaryKey(),
  date: text().notNull(),
  time: text().notNull(),
  items: jsonb().notNull(),
  subtotal: numeric().notNull().default("0"),
  discountPercent: numeric("discount_percent").notNull().default("0"),
  discountAmount: numeric("discount_amount").notNull().default("0"),
  total: numeric().notNull().default("0"),
  cash: numeric().default("0"),
  change: numeric().default("0"),
  payment: text().default("Cash"),
  cashier: text().default(""),
  ingredientCost: numeric("ingredient_cost").default("0"),
  profit: numeric().default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const heldOrders = pgTable("held_orders", {
  id: text().primaryKey(),
  items: jsonb().notNull(),
  discountPercent: numeric("discount_percent").notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial().primaryKey(),
  ingredientId: text("ingredient_id"),
  ingredientName: text("ingredient_name").notNull(),
  type: text().notNull(),
  qty: numeric().notNull(),
  note: text().default(""),
  orderId: text("order_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
});

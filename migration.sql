CREATE TABLE "categories" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY,
	"date" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '',
	"amount" numeric DEFAULT '0' NOT NULL,
	"payment" text DEFAULT '',
	"notes" text DEFAULT '',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "held_orders" (
	"id" text PRIMARY KEY,
	"items" jsonb NOT NULL,
	"discount_percent" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"category" text DEFAULT 'Other',
	"unit" text DEFAULT 'pcs' NOT NULL,
	"current_stock" numeric DEFAULT '0' NOT NULL,
	"min_stock" numeric DEFAULT '0' NOT NULL,
	"cost_per_unit" numeric DEFAULT '0' NOT NULL,
	"purchase_qty" numeric DEFAULT '0',
	"purchase_cost" numeric DEFAULT '0',
	"supplier" text DEFAULT '',
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY,
	"ingredient_id" text,
	"ingredient_name" text NOT NULL,
	"type" text NOT NULL,
	"qty" numeric NOT NULL,
	"note" text DEFAULT '',
	"order_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY,
	"date" text NOT NULL,
	"time" text NOT NULL,
	"items" jsonb NOT NULL,
	"subtotal" numeric DEFAULT '0' NOT NULL,
	"discount_percent" numeric DEFAULT '0' NOT NULL,
	"discount_amount" numeric DEFAULT '0' NOT NULL,
	"total" numeric DEFAULT '0' NOT NULL,
	"cash" numeric DEFAULT '0',
	"change" numeric DEFAULT '0',
	"payment" text DEFAULT 'Cash',
	"cashier" text DEFAULT '',
	"ingredient_cost" numeric DEFAULT '0',
	"profit" numeric DEFAULT '0',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"series_name" text DEFAULT '',
	"type" text DEFAULT 'drink' NOT NULL,
	"sizes" jsonb DEFAULT '{}' NOT NULL,
	"flavors" jsonb,
	"image" text,
	"sku" text,
	"description" text,
	"cost" numeric DEFAULT '0',
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" text PRIMARY KEY,
	"product_id" text,
	"product_name" text NOT NULL,
	"size_label" text DEFAULT 'ALL' NOT NULL,
	"ingredient_id" text,
	"ingredient_name" text NOT NULL,
	"qty" numeric DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'pcs',
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL
);

CREATE TYPE "public"."market_listing_status" AS ENUM('ACTIVE', 'SOLD_OUT', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'MARKET_ESCROW';--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'MARKET_ESCROW_RETURN';--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'MARKET_BUY';--> statement-breakpoint
CREATE TABLE "market_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"remaining_cents" bigint NOT NULL,
	"status" "market_listing_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_listings_unit_price_ck" CHECK ("market_listings"."unit_price_cents" > 0),
	CONSTRAINT "market_listings_total_ck" CHECK ("market_listings"."total_cents" > 0 AND "market_listings"."total_cents" % 100 = 0),
	CONSTRAINT "market_listings_remaining_ck" CHECK ("market_listings"."remaining_cents" >= 0 AND "market_listings"."remaining_cents" <= "market_listings"."total_cents" AND "market_listings"."remaining_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "market_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"getcoins_cents" bigint NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"total_price_cents" bigint NOT NULL,
	"fee_cents" bigint NOT NULL,
	"seller_net_cents" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "purchase_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_orders_not_self_ck" CHECK ("market_orders"."buyer_id" <> "market_orders"."seller_id"),
	CONSTRAINT "market_orders_qty_ck" CHECK ("market_orders"."getcoins_cents" > 0 AND "market_orders"."getcoins_cents" % 100 = 0),
	CONSTRAINT "market_orders_total_ck" CHECK ("market_orders"."total_price_cents" = ("market_orders"."getcoins_cents" / 100) * "market_orders"."unit_price_cents"),
	CONSTRAINT "market_orders_fee_ck" CHECK ("market_orders"."fee_cents" >= 0 AND "market_orders"."seller_net_cents" >= 0 AND "market_orders"."fee_cents" + "market_orders"."seller_net_cents" = "market_orders"."total_price_cents")
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_one_target_ck";--> statement-breakpoint
ALTER TABLE "getcoin_purchases" ALTER COLUMN "package_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_listing_id_market_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."market_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_listings_status_price_idx" ON "market_listings" USING btree ("status","unit_price_cents");--> statement-breakpoint
CREATE INDEX "market_listings_seller_idx" ON "market_listings" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_orders_buyer_idempotency_uq" ON "market_orders" USING btree ("buyer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "market_orders_listing_status_idx" ON "market_orders" USING btree ("listing_id","status");--> statement-breakpoint
CREATE INDEX "market_orders_buyer_idx" ON "market_orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "market_orders_seller_idx" ON "market_orders" USING btree ("seller_id","created_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_market_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."market_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_uq" ON "payments" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_target_ck" CHECK ((CASE WHEN "payments"."get_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "payments"."purchase_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "payments"."order_id" IS NULL THEN 0 ELSE 1 END) = 1);
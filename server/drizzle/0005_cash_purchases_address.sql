CREATE TYPE "public"."cash_ledger_type" AS ENUM('GET_PAYMENT', 'GETCOIN_PURCHASE', 'WITHDRAWAL', 'WITHDRAWAL_REVERSAL', 'ADJUSTMENT', 'REFUND', 'MARKETPLACE_SALE', 'MARKETPLACE_FEE');--> statement-breakpoint
CREATE TYPE "public"."pix_key_type" AS ENUM('CPF', 'EMAIL', 'PHONE', 'RANDOM');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('PENDING_PAYMENT', 'PAID', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('PENDING', 'PAID', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'PURCHASE';--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'PURCHASE_BONUS';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'BALANCE';--> statement-breakpoint
ALTER TYPE "public"."payment_provider" ADD VALUE 'INTERNAL';--> statement-breakpoint
CREATE TABLE "cash_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "cash_ledger_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"type" "cash_ledger_type" NOT NULL,
	"reference_type" varchar(32),
	"reference_id" uuid,
	"reason" varchar(500),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_ledger_amount_non_zero_ck" CHECK ("cash_ledger"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "cash_wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_wallets_balance_non_negative_ck" CHECK ("cash_wallets"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "getcoin_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"getcoins_cents" bigint NOT NULL,
	"bonus_cents" bigint DEFAULT 0 NOT NULL,
	"price_cents" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "getcoin_packages_getcoins_positive_ck" CHECK ("getcoin_packages"."getcoins_cents" > 0),
	CONSTRAINT "getcoin_packages_bonus_ck" CHECK ("getcoin_packages"."bonus_cents" >= 0),
	CONSTRAINT "getcoin_packages_price_positive_ck" CHECK ("getcoin_packages"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "getcoin_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"package_name" varchar(80) NOT NULL,
	"getcoins_cents" bigint NOT NULL,
	"bonus_cents" bigint DEFAULT 0 NOT NULL,
	"price_cents" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "purchase_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "getcoin_purchases_values_ck" CHECK ("getcoin_purchases"."getcoins_cents" > 0 AND "getcoin_purchases"."bonus_cents" >= 0 AND "getcoin_purchases"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"pix_key_type" "pix_key_type" NOT NULL,
	"pix_key" varchar(140) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_amount_positive_ck" CHECK ("withdrawals"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "get_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cep" varchar(8);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "street" varchar(160);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "number" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "complement" varchar(80);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "district" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "state" varchar(2);--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_wallets" ADD CONSTRAINT "cash_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "getcoin_purchases" ADD CONSTRAINT "getcoin_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "getcoin_purchases" ADD CONSTRAINT "getcoin_purchases_package_id_getcoin_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."getcoin_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_ledger_user_created_idx" ON "cash_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_ledger_reference_idx" ON "cash_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "getcoin_purchases_user_idempotency_uq" ON "getcoin_purchases" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "getcoin_purchases_user_created_idx" ON "getcoin_purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_user_idempotency_uq" ON "withdrawals" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "withdrawals_status_created_idx" ON "withdrawals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "withdrawals_user_created_idx" ON "withdrawals" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_purchase_id_getcoin_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."getcoin_purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_purchase_uq" ON "payments" USING btree ("purchase_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_target_ck" CHECK (("payments"."get_id" IS NULL) <> ("payments"."purchase_id" IS NULL));
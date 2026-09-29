ALTER TYPE "public"."ledger_type" ADD VALUE 'COUPON';--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"coupon_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" integer DEFAULT 1 NOT NULL,
	"amount_cents" bigint NOT NULL,
	"ledger_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_seq_ck" CHECK ("coupon_redemptions"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(40) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"max_redemptions" integer,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"redemptions_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"new_accounts_only" boolean DEFAULT false NOT NULL,
	"description" varchar(200),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_upper_ck" CHECK ("coupons"."code" = upper("coupons"."code")),
	CONSTRAINT "coupons_amount_positive_ck" CHECK ("coupons"."amount_cents" > 0),
	CONSTRAINT "coupons_max_positive_ck" CHECK ("coupons"."max_redemptions" IS NULL OR "coupons"."max_redemptions" > 0),
	CONSTRAINT "coupons_per_user_positive_ck" CHECK ("coupons"."per_user_limit" > 0),
	CONSTRAINT "coupons_count_ck" CHECK ("coupons"."redemptions_count" >= 0 AND ("coupons"."max_redemptions" IS NULL OR "coupons"."redemptions_count" <= "coupons"."max_redemptions")),
	CONSTRAINT "coupons_dates_ck" CHECK ("coupons"."ends_at" IS NULL OR "coupons"."ends_at" > "coupons"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_redemptions_user_seq_uq" ON "coupon_redemptions" USING btree ("coupon_id","user_id","seq");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" USING btree ("coupon_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_uq" ON "coupons" USING btree ("code");
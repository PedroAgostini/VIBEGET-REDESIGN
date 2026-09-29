CREATE TYPE "public"."auth_token_type" AS ENUM('EMAIL_VERIFY', 'PASSWORD_RESET');--> statement-breakpoint
CREATE TYPE "public"."get_status" AS ENUM('PENDING_PAYMENT', 'CONFIRMED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('WELCOME_BONUS', 'CASHBACK', 'SPEND_ON_GET', 'REFUND', 'REFERRAL', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('PIX', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('MOCK');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('smartphones', 'notebooks', 'games', 'audio', 'wearables');--> statement-breakpoint
CREATE TYPE "public"."user_level" AS ENUM('EXPLORADOR', 'VIBER');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'SUPPORT', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."vibe_status" AS ENUM('DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" varchar(64) NOT NULL,
	"entity" varchar(32) NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "auth_token_type" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "getcoin_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"type" "ledger_type" NOT NULL,
	"reference_type" varchar(32),
	"reference_id" uuid,
	"reason" varchar(500),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_non_zero_ck" CHECK ("getcoin_ledger"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "gets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vibe_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cash_cents" bigint NOT NULL,
	"getcoin_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"status" "get_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gets_cash_positive_ck" CHECK ("gets"."cash_cents" > 0),
	CONSTRAINT "gets_getcoin_range_ck" CHECK ("gets"."getcoin_cents" >= 0 AND "gets"."getcoin_cents" <= "gets"."cash_cents"),
	CONSTRAINT "gets_total_ck" CHECK ("gets"."total_cents" = "gets"."cash_cents" + "gets"."getcoin_cents")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"get_id" uuid NOT NULL,
	"provider" "payment_provider" DEFAULT 'MOCK' NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"pix_copy_paste" text,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive_ck" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" varchar(160) NOT NULL,
	"category" "product_category" NOT NULL,
	"image_url" varchar(500),
	"original_price_cents" bigint NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_positive_ck" CHECK ("products"."original_price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"user_agent" varchar(512),
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"email" varchar(254) NOT NULL,
	"cpf" varchar(11),
	"phone" varchar(20),
	"birth_date" date,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"level" "user_level" DEFAULT 'EXPLORADOR' NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"referral_code" varchar(16) NOT NULL,
	"referred_by_id" uuid,
	"terms_accepted_at" timestamp with time zone,
	"terms_version" varchar(32),
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower_ck" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_cpf_digits_ck" CHECK ("users"."cpf" IS NULL OR "users"."cpf" ~ '^[0-9]{11}$')
);
--> statement-breakpoint
CREATE TABLE "vibes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"slug" varchar(140) NOT NULL,
	"status" "vibe_status" DEFAULT 'DRAFT' NOT NULL,
	"min_get_cents" bigint NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"goal_gets" integer,
	"cashback_percent" integer DEFAULT 40 NOT NULL,
	"winner_get_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vibes_min_get_positive_ck" CHECK ("vibes"."min_get_cents" > 0),
	CONSTRAINT "vibes_cashback_range_ck" CHECK ("vibes"."cashback_percent" BETWEEN 0 AND 100),
	CONSTRAINT "vibes_dates_ck" CHECK ("vibes"."ends_at" > "vibes"."starts_at"),
	CONSTRAINT "vibes_goal_positive_ck" CHECK ("vibes"."goal_gets" IS NULL OR "vibes"."goal_gets" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_non_negative_ck" CHECK ("wallets"."balance_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "getcoin_ledger" ADD CONSTRAINT "getcoin_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gets" ADD CONSTRAINT "gets_vibe_id_vibes_id_fk" FOREIGN KEY ("vibe_id") REFERENCES "public"."vibes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gets" ADD CONSTRAINT "gets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_get_id_gets_id_fk" FOREIGN KEY ("get_id") REFERENCES "public"."gets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vibes" ADD CONSTRAINT "vibes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_type_idx" ON "auth_tokens" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "ledger_user_created_idx" ON "getcoin_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_reference_idx" ON "getcoin_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gets_user_idempotency_uq" ON "gets" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gets_vibe_status_total_idx" ON "gets" USING btree ("vibe_id","status","total_cents");--> statement-breakpoint
CREATE INDEX "gets_user_created_idx" ON "gets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_id_uq" ON "payments" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_get_uq" ON "payments" USING btree ("get_id");--> statement-breakpoint
CREATE INDEX "payments_status_expires_idx" ON "payments" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_cpf_uq" ON "users" USING btree ("cpf");--> statement-breakpoint
CREATE UNIQUE INDEX "users_referral_code_uq" ON "users" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vibes_slug_uq" ON "vibes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "vibes_status_ends_idx" ON "vibes" USING btree ("status","ends_at");
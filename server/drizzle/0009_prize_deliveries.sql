CREATE TYPE "public"."prize_status" AS ENUM('AWAITING_ADDRESS', 'PREPARING', 'SHIPPED', 'DELIVERED');--> statement-breakpoint
CREATE TABLE "prize_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vibe_id" uuid NOT NULL,
	"get_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "prize_status" DEFAULT 'AWAITING_ADDRESS' NOT NULL,
	"recipient_name" varchar(120),
	"phone" varchar(20),
	"cep" varchar(8),
	"street" varchar(160),
	"number" varchar(20),
	"complement" varchar(80),
	"district" varchar(100),
	"city" varchar(100),
	"state" varchar(2),
	"address_confirmed_at" timestamp with time zone,
	"carrier" varchar(60),
	"tracking_code" varchar(60),
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_deliveries_shipped_ck" CHECK ("prize_deliveries"."status" NOT IN ('SHIPPED', 'DELIVERED') OR ("prize_deliveries"."carrier" IS NOT NULL AND "prize_deliveries"."tracking_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "prize_deliveries" ADD CONSTRAINT "prize_deliveries_vibe_id_vibes_id_fk" FOREIGN KEY ("vibe_id") REFERENCES "public"."vibes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ADD CONSTRAINT "prize_deliveries_get_id_gets_id_fk" FOREIGN KEY ("get_id") REFERENCES "public"."gets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ADD CONSTRAINT "prize_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prize_deliveries_vibe_uq" ON "prize_deliveries" USING btree ("vibe_id");--> statement-breakpoint
CREATE INDEX "prize_deliveries_user_idx" ON "prize_deliveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "prize_deliveries_status_idx" ON "prize_deliveries" USING btree ("status","created_at");--> statement-breakpoint
-- D13: Vibes já encerradas com vencedor ganham a entrega pendente (a partir daqui o settlement cria).
INSERT INTO "prize_deliveries" ("id", "vibe_id", "get_id", "user_id", "status")
SELECT gen_random_uuid(), v."id", v."winner_get_id", g."user_id", 'AWAITING_ADDRESS'
FROM "vibes" v JOIN "gets" g ON g."id" = v."winner_get_id"
WHERE v."status" = 'ENDED' AND v."winner_get_id" IS NOT NULL
ON CONFLICT DO NOTHING;
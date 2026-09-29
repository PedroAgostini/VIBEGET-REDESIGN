CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"vibe_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vibe_views" (
	"vibe_id" uuid NOT NULL,
	"visitor_hash" varchar(64) NOT NULL,
	"day" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand" varchar(80);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "model" varchar(120);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "specs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vibes" ADD COLUMN "benefits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vibes" ADD COLUMN "views_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_vibe_id_vibes_id_fk" FOREIGN KEY ("vibe_id") REFERENCES "public"."vibes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vibe_views" ADD CONSTRAINT "vibe_views_vibe_id_vibes_id_fk" FOREIGN KEY ("vibe_id") REFERENCES "public"."vibes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_uq" ON "favorites" USING btree ("user_id","vibe_id");--> statement-breakpoint
CREATE INDEX "favorites_vibe_idx" ON "favorites" USING btree ("vibe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vibe_views_uq" ON "vibe_views" USING btree ("vibe_id","visitor_hash","day");
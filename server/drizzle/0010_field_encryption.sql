ALTER TABLE "users" DROP CONSTRAINT "users_email_lower_ck";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_cpf_digits_ck";--> statement-breakpoint
DROP INDEX "users_email_uq";--> statement-breakpoint
DROP INDEX "users_cpf_uq";--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "ip" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "recipient_name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "phone" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "cep" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "street" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "number" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "complement" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "district" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "prize_deliveries" ALTER COLUMN "city" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_agent" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "ip" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "cpf" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "phone" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "birth_date" SET DATA TYPE text USING "birth_date"::text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "cep" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "street" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "number" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "complement" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "district" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "city" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "withdrawals" ALTER COLUMN "pix_key" SET DATA TYPE text;--> statement-breakpoint
-- Os hashes (índice cego) dependem da chave, que só o app tem: as linhas existentes são preenchidas
-- e cifradas por src/db/encrypt-legacy.ts logo depois desta migração, que então aplica o NOT NULL
-- de email_hash e a regra users_cpf_hash_ck.
ALTER TABLE "users" ADD COLUMN "email_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cpf_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_hash_uq" ON "users" USING btree ("email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_cpf_hash_uq" ON "users" USING btree ("cpf_hash");
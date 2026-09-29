-- O livro-razão de GetCoin é imutável: correções são feitas com novos lançamentos (ADJUSTMENT/REFUND).
CREATE OR REPLACE FUNCTION getcoin_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'getcoin_ledger é imutável (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER getcoin_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON getcoin_ledger
  FOR EACH ROW EXECUTE FUNCTION getcoin_ledger_immutable();

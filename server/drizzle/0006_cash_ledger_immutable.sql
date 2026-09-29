-- D6: o livro-razão do saldo em R$ é imutável, como o getcoin_ledger (0001/0002).
CREATE OR REPLACE FUNCTION cash_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cash_ledger é imutável (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cash_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON cash_ledger
  FOR EACH ROW EXECUTE FUNCTION cash_ledger_immutable();
--> statement-breakpoint
CREATE TRIGGER cash_ledger_no_truncate
  BEFORE TRUNCATE ON cash_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION cash_ledger_immutable();

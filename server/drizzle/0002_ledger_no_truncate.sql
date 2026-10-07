-- QA-12: a trigger por linha (0001) não pega TRUNCATE. Bloqueia também no nível de statement.
-- Em produção, complementar com um usuário de aplicação SEM privilégio de UPDATE/DELETE/TRUNCATE em getcoin_ledger.
CREATE TRIGGER getcoin_ledger_no_truncate
  BEFORE TRUNCATE ON getcoin_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION getcoin_ledger_immutable();

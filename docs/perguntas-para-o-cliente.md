# VibeGet — decisões que precisamos de vocês

Atualizado em 07/10/2026.

O sistema está pronto para testes: site, área do usuário, painel administrativo, marketplace de GetCoins, segurança e criptografia dos dados pessoais. Antes de colocar no ar, precisamos que vocês confirmem as regras abaixo.

Em cada item está **como funciona hoje** (o que implementamos) e **o que precisamos saber**. Onde estiver bom do jeito que está, basta responder "ok". Os valores marcados com ⚙️ podem ser mudados depois pelo próprio painel administrativo, sem programação.

---

## 1. Regras das Vibes (leilões)

**1.1 Fim da Vibe**
- **Hoje:** no **último minuto** da Vibe ninguém consegue dar Get novo. Quem deu Get antes disso tem **40 segundos** a mais para o Pix ser confirmado. Um pagamento que chega depois desse prazo não conta e é devolvido. ⚙️
- **Precisamos saber:** foi isso que vocês quiseram dizer com "não aceitar Get no minuto final / 40 segundos de margem"?

**1.2 Meta de Gets**
- **Hoje:** a meta (ex.: "412 de 480 Gets") é só informativa. A Vibe termina na data de fim, mesmo que a meta seja batida antes.
- **Precisamos saber:** a Vibe deve **terminar quando bater a meta**? Ou a meta é só informativa mesmo?

**1.3 Cashback de quem vence**
- **Hoje:** quem vence não recebe os 40% de volta em nenhum dos Gets que deu naquela Vibe. Os outros participantes recebem os 40% normalmente.
- **Precisamos saber:** confirmam?

**1.4 Preços reais dos produtos de demonstração**
- **Hoje:** quatro produtos estão com preço estimado por nós: MacBook Pro M3 14" (R$ 16.999), Xiaomi 14 Pro (R$ 6.499), Dell XPS 15 (R$ 13.999) e ThinkPad X1 Carbon (R$ 12.999).
- **Precisamos saber:** os preços reais. Ou, se esses produtos não vão ao ar, é só cadastrar os produtos verdadeiros pelo painel.

## 2. Entrega do prêmio

- **Hoje:**
  - o vencedor recebe um aviso para confirmar o endereço e pode alterá-lo até o envio;
  - depois do envio, o endereço fica travado e o vencedor acompanha o código de rastreio;
  - enquanto houver um prêmio a receber, a pessoa não consegue excluir a própria conta.
- **Precisamos saber:**
  - confirmam essas regras?
  - existe um **prazo** para o vencedor confirmar o endereço? Se sim, qual, e o que acontece se ele não confirmar?

## 3. Saques (saldo em R$ para Pix)

- **Hoje:**
  - saque mínimo de **R$ 10,00** e limite de **R$ 5.000,00 a cada 24 horas** por pessoa ⚙️;
  - a equipe faz o Pix manualmente e depois marca o saque como pago no painel.
- **Precisamos saber:**
  - os valores mínimo e máximo estão bons?
  - o limite diário é contado nas **últimas 24 horas** (como está) ou por **dia do calendário**, reiniciando à meia-noite?

## 4. Marketplace de GetCoins (entre usuários)

- **Hoje:**
  - a VibeGet fica com **10% de taxa** sobre cada venda, descontada do vendedor ⚙️;
  - o preço por GetCoin pode ir de **R$ 0,10 a R$ 10,00** ⚙️;
  - o anúncio mínimo é de **10 GetCoins** ⚙️.
- **Precisamos saber:** confirmam a taxa, a faixa de preço e o mínimo?

## 5. Cupons e área do usuário

**5.1 Cupom "só contas novas"**
- **Hoje:** só pode usar o cupom quem **criou a conta depois** que o cupom foi criado.
- **Precisamos saber:** é essa a regra? Ou "conta nova" quer dizer outra coisa, como "nunca deu um Get"?

**5.2 "Vencidas" em Meus Gets**
- **Hoje:** o número "Vencidas" mostra as Vibes que a pessoa **ganhou**.
- **Precisamos saber:** é esse o sentido? Ou "vencidas" quer dizer as Vibes que **já terminaram**?

**5.3 Bônus de boas-vindas e de indicação**
- **Hoje:** os dois estão em **zero** ⚙️.
- **Precisamos saber:** quantos GetCoins quem cria a conta ganha? E quem indica um amigo?

## 6. Privacidade e LGPD

**6.1 Por quanto tempo guardamos dados**
- **Hoje:**
  - o **IP** que fica no registro de atividades é apagado depois de **180 dias** (o registro do que aconteceu continua, como prova);
  - os dados de sessões encerradas são apagados depois de **30 dias**.
- **Precisamos saber:** o jurídico de vocês aprova esses prazos? Eles precisam constar na **Política de Privacidade**.

**6.2 Textos legais**
- **Hoje:** o site aponta para Termos de Uso, Política de Privacidade e Regras em vibeget.net.
- **Precisamos saber:** esses textos já existem e estão atualizados? Eles precisam mencionar:
  - o marketplace;
  - o saldo sacável;
  - a criptografia dos dados;
  - os prazos do item 6.1.

**6.3 Encarregado de dados (DPO)**
- **Precisamos saber:** quem será o encarregado de dados da VibeGet, como exige a LGPD, e qual o e-mail de contato dessa pessoa para os usuários.

**6.4 Busca de usuários no painel**
- **Hoje:** e-mail, CPF, telefone e endereço ficam **criptografados** no banco. Por isso, na busca do painel, o e-mail precisa ser digitado **completo**. Por nome continua dando para buscar só uma parte.
- **Precisamos saber:** isso atende a equipe de atendimento?

## 7. Para colocar no ar

Estes itens não são regras, mas dependem de contratação ou de acesso de vocês:

1. **Gateway de pagamento:** qual empresa vai processar Pix e cartão (ex.: Mercado Pago, Pagar.me, Asaas)? Precisamos do acesso à conta de testes.
2. **E-mail:** qual serviço vai enviar os e-mails de confirmação de conta e de troca de senha (ex.: Resend, Amazon SES, SendGrid)? E de qual endereço sai o e-mail (ex.: nao-responda@vibeget.net)?
3. **Servidor e banco de dados:** onde a API e o banco vão rodar? Podemos sugerir opções com custo estimado.
4. **Guarda das chaves de criptografia:** quem da empresa vai guardar a cópia de segurança das chaves? **Sem elas não há como recuperar os dados pessoais.**
5. **Domínio:** o site novo vai substituir o vibeget.net atual? Quando?
6. **Teste de invasão:** recomendamos contratar um teste de segurança externo (pentest) antes do lançamento. Vocês aprovam?

---

Quaisquer respostas parciais já ajudam. Os itens marcados com ⚙️ também podem ser ajustados por vocês mesmos no painel, a qualquer momento.

# LetsWork v0.1.0 — versão fechada

Fechada em 30/09/2026.

## Produto

A v0.1 está congelada como primeira versão distribuível do LetsWork.

Fluxo principal:

`currículo → extração factual → currículo-base → inventário RioVagas → ranking → pré-voo → envio HTTP → confirmação`

## Fonte e inventário

- Somente RioVagas.
- SQLite global compartilhado entre candidatos.
- Janela móvel de até 30 dias.
- Reconciliação completa obrigatória em toda abertura.
- A busca aguarda a sincronização inicial antes de usar o inventário.
- Atualização incremental durante o uso.
- Nova reconciliação completa após 24 horas de execução contínua.
- Vagas removidas ou com mais de 30 dias ficam inativas e saem da busca sem destruir referências históricas.
- Snapshot completo só pode desativar vagas quando todos os IDs esperados do WordPress foram lidos.

## Currículo

- Um currículo-base profissional por versão dos documentos.
- Modelos Executivo, Clássico e Compacto.
- PDF reutilizado nas candidaturas.
- Conteúdo factual; sem invenção de experiência, formação ou credenciais.
- PDF e DOCX são os formatos preferidos para distribuição a clientes.

## Ranking e formulários

- Área desejada informada pelo usuário tem prioridade sobre inferências. Quando o campo fica vazio, o sistema tenta inferir a direção profissional a partir do currículo.
- Testes feitos com área explicitamente preenchida validam busca/ranking dirigido, não inferência automática de carreira.

- Regras determinísticas filtram incompatibilidades objetivas.
- Ollama/llama3.2:3b revisa casos ambíguos.
- Pré-voo obrigatório antes de qualquer envio real.
- Variações atuais do formulário RioVagas suportadas.
- Campos obrigatórios novos ou estrutura desconhecida bloqueiam o envio.
- Dados deriváveis são extraídos/calculados antes de pedir informação humana.
- Dados pessoais realmente ausentes são salvos uma vez no perfil e reutilizados.
- Formulários incoerentes são INVALID_FORM, não pendência do candidato.

## Envio e prova

- Envio direto HTTP, sem Playwright/Chromium.
- SENT exige confirmação positiva e recibo persistido.
- UNCERTAIN não é considerado sucesso e não é reenviado automaticamente.
- Registros históricos antigos sem recibo foram reclassificados conservadoramente.
- Circuit breaker pausa o lote em erro inesperado de envio.

## Isolamento de candidatos

- Runs, jobs, aplicações, histórico e recibos são associados ao candidato correto.
- Troca de candidato limpa imediatamente o resultado visual anterior.
- Respostas assíncronas antigas não podem repintar vagas de outro candidato.

## Interface

- Localização mostra apenas bairro/cidade/estado.
- Campos como benefícios, vale-transporte e horário não podem aparecer em Local.
- Tipo de vaga usa checkboxes visíveis para CLT, PJ, Estágio, Temporário, Aprendiz e Freelancer.
- É obrigatório selecionar ao menos um tipo de vaga.

## Testes finais

A versão fechada passa:

- `npm run check`
- `npm run regression`
- `npm run smoke`
- `git diff --check`

Regressões cobrem:
- janela 7/15/30;
- sincronização de abertura;
- snapshot completo;
- isolamento candidato/run;
- vínculos de inventário;
- recibos de envio;
- SENT sem recibo = zero;
- localização limpa;
- formulário e dados de perfil;
- troca de candidato no frontend.

## Distribuição

O pacote para outro computador não contém banco, currículo, documento ou histórico real.

Requisitos:
- Windows 10/11 x64;
- internet;
- Ollama + `llama3.2:3b` para revisão local completa;
- aproximadamente 3 GB livres além do espaço normal do Windows/aplicativo.

O instalador usa assinatura local Authenticode. Em computadores que não conhecem esse certificado, o Windows SmartScreen pode exibir aviso.

## Git

Branch oficial: `main`.

Tag oficial desta versão: `v0.1.0`.

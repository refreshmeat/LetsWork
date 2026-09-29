# LetsWork

Aplicação desktop local para importar currículos, identificar oportunidades compatíveis e automatizar candidaturas sem inventar dados do candidato.

## Fluxo atual

Cada candidato possui dados, buscas, histórico e candidaturas isolados por `candidate_id`.

1. O currículo original e os documentos de apoio são importados.
2. O LetsWork extrai os fatos do candidato.
3. Um currículo-base otimizado é gerado uma única vez.
4. O currículo-base precisa existir antes de qualquer envio.
5. A busca deriva um conjunto compacto de cargos compatíveis.
6. Regras objetivas eliminam incompatibilidades antes da IA.
7. A IA local analisa apenas os poucos casos realmente ambíguos.
8. O mesmo currículo-base é reutilizado em todas as candidaturas.

Não existe geração de currículo por vaga.

Documentos de apoio e portfólios servem apenas como evidência factual. Eles não são anexados automaticamente ao currículo enviado. Projetos relevantes podem ser descritos na seção de projetos do currículo-base.

## Fonte de vagas

Durante a fase atual de validação, somente o RioVagas entra no fluxo automático. As demais integrações permanecem no projeto para serem validadas individualmente antes de serem ativadas.

A coleta do RioVagas usa cache local e atualização incremental. A interface recebe imediatamente as vagas decididas por regras. Casos ambíguos podem terminar a revisão de IA em segundo plano sem bloquear a busca.

## IA local

O único provider de IA do runtime é o Ollama.

O desktop escolhe o modelo conforme o hardware. Em máquinas mais modestas usa Llama 3.2 3B; o Llama 3.1 8B só é escolhido quando há RAM e VRAM suficientes. É possível sobrescrever o modelo com `OLLAMA_MODEL`.

A IA não é usada para inventar experiência, formação, ferramentas, resultados ou dados pessoais.

## Envio

RioVagas usa o caminho HTTP direto quando disponível. O Playwright fica reservado para sites/formulários que realmente precisam de navegador.

O envio nunca volta silenciosamente ao currículo original. Se o currículo-base não existir, o lote é interrompido com erro explícito.

## Dados

Dados operacionais ficam em:

`C:\Users\RefreshMeat\LetsWork\dados`

O banco SQLite, currículos, documentos, caches e relatórios não devem ser versionados.

## Verificação

`npm run check` valida a sintaxe dos módulos principais.

`npm run smoke` executa verificações de regressão sobre isolamento de candidatos, integridade do banco e geração de currículo-base.
## Arquitetura ativa: RioVagas

Nesta fase, o LetsWork opera exclusivamente com RioVagas. O app mantém um inventário local global de até 30 dias, aplica filtros de 7/15/30 dias localmente, ranqueia por compatibilidade profissional e usa IA apenas para casos ambíguos. O envio é feito diretamente por HTTP, sem exigir login do candidato.

Comandos de validação: `npm run check`, `npm run smoke`, `npm run regression` e `npm run regression:live`.

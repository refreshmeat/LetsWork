# Status atual do LetsWork

Atualizado em 28/09/2026.

## Runtime

- Desktop: Electron.
- Backend local: Express em `127.0.0.1:4317`.
- IA: Ollama local.
- Modelo padrão em máquinas modestas: `llama3.2:3b`.
- Llama 3.1 8B só é selecionado quando há RAM e VRAM suficientes.
- O provider antigo do ChatGPT web/CDP foi removido do runtime.

## Currículo-base

- Cada candidato possui um currículo-base otimizado.
- A geração acontece uma única vez por versão dos documentos.
- O currículo-base é obrigatório para iniciar envios.
- Não existe geração por vaga.
- Portfólios e documentos de apoio são usados somente como contexto factual.
- O portfólio não é anexado automaticamente ao PDF enviado.
- Formação, cursos, experiências e projetos são organizados por seções estruturadas.
- A IA não pode inventar experiência, cargo, formação ou ferramentas.

## Isolamento de candidatos

- Runs, jobs, histórico e candidaturas são ligados ao `candidate_id`.
- A interface descarta respostas atrasadas de um candidato anterior quando o usuário troca de perfil.
- O status de um run inclui `candidateId` e o front recusa renderizar um run de outro candidato.
- `npm run smoke` verifica integridade entre candidates, resumes, runs, jobs e applications.

## Busca

- Fonte ativa durante a validação: RioVagas.
- O plano de busca usa no máximo 24 termos compactos.
- O cache global do RioVagas é atualizado incrementalmente.
- Título e requisitos objetivos são avaliados antes da IA.
- Profissões claramente fora do plano são descartadas por regra.
- Casos ambíguos são limitados e revisados pela IA em segundo plano.
- A resposta inicial da busca não espera a revisão da IA terminar.

Benchmark local da Maria após a revisão:
- plano de busca: cerca de 0,03 s com cache;
- leitura/ranking do cache RioVagas: cerca de 0,3 s;
- 3.788 vagas no inventário;
- 260 vagas passaram pelo pré-filtro;
- 245 decididas diretamente por regras;
- 15 realmente ambíguas antes do limite de revisão.

## Envio

- RioVagas usa o caminho HTTP direto.
- O navegador não é aberto para preflight do RioVagas.
- O mesmo currículo-base é reutilizado em todas as vagas.
- Perguntas factuais conhecidas são respondidas por regra antes da IA.
- Um dry-run real de RioVagas chegou a READY em aproximadamente 2,7 s.

## Verificação

- `npm run check`: valida sintaxe dos módulos principais.
- `npm run smoke`: valida integridade do banco e geração de um currículo-base de regressão.
## Consolidação RioVagas — 2026-09-29

- Somente RioVagas está habilitado no runtime e no build desta fase.
- Inventário global SQLite com janela móvel máxima de 30 dias; filtros de 7/15/30 dias são consultas locais.
- Sincronização incremental automática e sincronização completa periódica; vagas antigas/fechadas deixam o inventário ativo.
- FTS5/BM25 prioriza o inventário antes do ranking profissional; regras objetivas continuam antes da IA.
- Associação candidato-vaga usa `inventory_id`; `external_id` do RioVagas preserva identidade mesmo se a URL mudar.
- `candidate_job_pool` legado foi removido.
- Candidatura RioVagas é HTTP direto, sem Chromium/Playwright no fluxo ativo e sem login do candidato.
- `SENT` só é aceito com confirmação positiva; respostas sem confirmação viram `UNCERTAIN`.
- Recibos estruturados ficam em `application_receipts` e eventos de execução em `run_events`.
- Backup portátil v2 inclui banco e arquivos dos candidatos, mas exclui sessões de navegador e inventário regenerável.
- Testes adicionados: `npm run regression` e `npm run regression:live`.
- Benchmark E2E da Maria em 7 dias: ~3 s, 3.583 vagas lidas, 3.571 após deduplicação, 290 liberadas deterministicamente e 12 para revisão de IA.

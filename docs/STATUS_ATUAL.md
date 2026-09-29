# Status atual do LetsWork

Atualizado em 29/09/2026.

## Escopo ativo

- Única fonte de vagas: RioVagas.
- Candidatura: HTTP direto.
- Login de candidato: não necessário.
- Automação de navegador: removida do projeto ativo.
- Fontes antigas e adapters de browser: removidos do repositório.
- Playwright: removido das dependências.

## Currículo

- Currículo-base profissional gerado uma vez por versão dos documentos.
- Modelos: Executivo, Clássico e Compacto.
- Reutilização do mesmo PDF nas candidaturas.
- Conteúdo factual apenas; IA não inventa experiência ou formação.
- Portfólio não é unido automaticamente ao PDF.

## Inventário

- SQLite global, independente do candidato.
- Janela móvel máxima de 30 dias.
- Filtros 7/15/30 locais.
- Sincronização incremental e reconciliação completa periódica.
- FTS5/BM25 para recuperação e priorização textual.
- Identidade estável pelo `external_id` do RioVagas.
- Vagas encerradas e antigas deixam o inventário ativo.

## Candidatos

- Runs, jobs, histórico, candidaturas e recibos vinculados ao candidato.
- Associação candidato-vaga em `candidate_job_matches`.
- `candidate_job_pool` legado removido.
- Histórico terminal impede reenvio da mesma vaga.

## Envio

- Revalidação do formulário imediatamente antes da candidatura.
- Workers HTTP dedicados ao RioVagas.
- `SENT` exige confirmação positiva.
- `ALREADY_APPLIED` exige evidência correspondente.
- POST sem confirmação segura vira `UNCERTAIN`.
- Recibos persistidos em `application_receipts`.
- Eventos persistidos em `run_events`.

## Backup

- Backup portátil inclui SQLite e arquivos dos candidatos.
- Sessões de navegador não são criadas nem exportadas.
- Restauração é validada antes de ser aplicada na próxima inicialização.
- O inventário de vagas é regenerável.

## Testes

- `npm run check`: sintaxe dos módulos ativos.
- `npm run smoke`: integridade básica e isolamento.
- `npm run regression`: fonte única, 7/15/30, FTS, duplicidade, relações candidato-vaga e recibos.
- `npm run regression:live`: formulário real do RioVagas via HTTP, sem candidatura.
- Build Windows assinado com `CN=LetsWork Local Code Signing`.

## Benchmark validado

No teste E2E do perfil Maria com janela de 7 dias:

- aproximadamente 3 segundos;
- 3.583 vagas lidas;
- 3.571 após deduplicação;
- 290 liberadas pelas regras;
- 12 encaminhadas para revisão de IA.

Os números do inventário variam ao longo do dia conforme o RioVagas publica ou encerra vagas.

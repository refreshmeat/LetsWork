# LetsWork

Aplicação desktop local para importar currículos, organizar o perfil profissional, encontrar vagas compatíveis e automatizar candidaturas sem inventar dados do candidato.

## Arquitetura atual

O LetsWork opera exclusivamente com o RioVagas nesta fase.

Fluxo:

1. Importa currículo e documentos de apoio.
2. Extrai somente fatos presentes nos documentos e dados informados pelo candidato.
3. Gera um currículo-base profissional e ATS-friendly, reutilizado nas candidaturas.
4. Mantém um inventário global local de vagas do RioVagas com janela móvel de até 30 dias.
5. Os filtros de 7, 15 e 30 dias são consultas locais no SQLite, sem nova busca na internet.
6. FTS5/BM25 e regras objetivas reduzem o universo antes da IA.
7. A IA local revisa apenas casos realmente ambíguos.
8. A candidatura é revalidada imediatamente antes do envio.
9. O envio ao RioVagas é feito diretamente por HTTP, sem login do candidato e sem automação de navegador.
10. Uma candidatura só recebe status `SENT` quando existe confirmação positiva do RioVagas.

## Currículo-base

Cada candidato possui um currículo-base otimizado por versão dos documentos. Não existe geração de um novo currículo para cada vaga.

Modelos disponíveis:

- Executivo
- Clássico
- Compacto

Portfólios e documentos de apoio são usados como evidência factual. Eles não são anexados automaticamente ao PDF enviado.

## Banco local

Os dados operacionais ficam em:

`C:\Users\RefreshMeat\LetsWork\dados`

O SQLite mantém candidatos, documentos, histórico, inventário de vagas, associações candidato-vaga, recibos de candidatura e eventos de execução.

O inventário do RioVagas é global. A mesma vaga não é duplicada para cada candidato.

## Inventário RioVagas

- Janela máxima: 30 dias.
- Vagas novas entram automaticamente.
- Vagas com mais de 30 dias saem.
- Vagas encerradas deixam o inventário ativo.
- Sincronização incremental ocorre durante o uso.
- Uma reconciliação completa periódica corrige inclusões, alterações e encerramentos.
- `external_id` do RioVagas preserva a identidade da vaga mesmo se a URL mudar.

## Envio

O fluxo ativo não contém Playwright, Chromium, Selenium nem login persistente.

O adapter dedicado do RioVagas executa:

`validar vaga → abrir formulário HTTP → preencher → anexar PDF → enviar → verificar confirmação → registrar recibo`

Respostas sem confirmação segura ficam como `UNCERTAIN`, evitando duplicidade por retentativa automática.

## IA

A IA local usa Ollama. Regras factuais e filtros determinísticos têm prioridade.

A IA não pode inventar experiência, formação, habilidades, endereço, documentos pessoais, disponibilidade ou credenciais.

## Backup e troca de PC

A interface permite exportar um backup portátil com:

- banco SQLite;
- currículos;
- documentos dos candidatos;
- histórico de candidaturas.

Sessões de navegador não existem no fluxo atual e não fazem parte do backup.

O inventário de vagas pode ser reconstruído pela sincronização do RioVagas.

## Verificação

Comandos principais:

- `npm run check`
- `npm run smoke`
- `npm run regression`
- `npm run regression:live`
- `npm run dist`

`regression:live` valida um formulário real recente do RioVagas via HTTP sem enviar candidatura.

## Estrutura

- `src/apply/rio.mjs`: adapter HTTP do RioVagas.
- `src/apply/answers.mjs`: respostas determinísticas/IA para perguntas do formulário.
- `src/services/jobs.mjs`: sincronização do inventário RioVagas.
- `src/services/inventory.mjs`: FTS5/BM25, associação candidato-vaga, métricas e eventos.
- `src/services/ranking.mjs`: compatibilidade profissional.
- `src/services/tailor.mjs`: geração do currículo-base.
- `src/services/backup.mjs`: exportação e restauração portátil.
- `src/server.mjs`: API local e orquestração.

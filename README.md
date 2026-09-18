# LetsWork

Aplicação desktop local para importar currículos, buscar vagas em volume, ranquear oportunidades compatíveis, gerar um currículo específico para cada vaga e automatizar candidaturas sem inventar dados do candidato.

## Como funciona

O LetsWork mantém dados separados por candidato. A busca usa currículo, preferências e IA local para gerar uma família ampla de cargos e termos, coleta muito mais do que 500 vagas quando disponível, elimina duplicatas e incompatibilidades claras e ordena o resultado.

O limite de 500 vale para a fila final de melhores vagas enviáveis. Vagas que exigem login, criação de conta ou barreira de e-mail não entram nessa fila.

RioVagas e Vagas.com são fontes prioritárias. LinkedIn e Gupy continuam sendo pesquisados, mas cada vaga é validada individualmente antes de ser considerada enviável.

## IA e currículos

O sistema usa regras determinísticas, Playwright e a IA local `letswork-ai` via Ollama.

Para cada vaga processada, o LetsWork gera uma versão direcionada do currículo usando somente fatos verificados. PDF recebe uma página inicial específica para a vaga e preserva o currículo original nas páginas seguintes.

## Dados e privacidade

Os dados ficam em `Documentos\LetsWork`. Não é necessário contratar banco de dados ou serviço de nuvem.

Dados de candidatos, banco SQLite, relatórios, sessões de navegador, currículos gerados, executáveis e certificados não são versionados no Git.

## Documentação

- [Histórico técnico, decisões, erros e correções](docs/HISTORICO_TECNICO.md)
- [Status atual e validações](docs/STATUS_ATUAL.md)

Antes de alterar busca, ranking, histórico ou autenticação, leia o histórico técnico. Ele existe especificamente para evitar regressões já resolvidas.

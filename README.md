# LetsWork

Aplicação desktop local para importar currículos, buscar vagas em volume, ranquear oportunidades compatíveis, gerar um currículo específico para cada vaga e automatizar candidaturas sem inventar dados do candidato.

## Como funciona

O LetsWork mantém dados separados por candidato. A busca usa currículo, preferências e a sessão ChatGPT web do operador para gerar uma família ampla de cargos e termos compatíveis. Depois coleta vagas, elimina duplicatas e incompatibilidades claras e ordena os resultados.

O limite de 500 vale para a fila final das melhores vagas enviáveis. Vagas que exigem login, criação de conta ou barreira de e-mail não entram nessa fila.

RioVagas e Vagas.com são fontes prioritárias. LinkedIn e Gupy continuam sendo pesquisados, mas cada vaga é validada individualmente antes de ser considerada enviável.

## IA e currículos

A única IA usada pelo LetsWork é a sessão persistente do ChatGPT web, configurada no perfil dedicado em GPT-5.6 Sol com nível High. O app controla essa sessão localmente por CDP em `127.0.0.1:9223`; não há Ollama/Llama nem fallback para a API oficial da OpenAI.

Cada candidato mantém uma única conversa persistente do ChatGPT, cuja URL é salva localmente. A mesma conversa gera termos de busca, seleciona conteúdo relevante, adapta cada currículo e responde perguntas de formulário quando necessário. O Playwright continua responsável pela navegação, preenchimento e envio das candidaturas.

Para cada vaga, o LetsWork reconstrói um currículo direcionado usando somente fatos verificados do currículo-base e documentos de apoio. O portfólio original, quando presente, é anexado depois sem ser refeito, preservando suas imagens.

## Dados e privacidade

Os dados operacionais ficam em `C:\Users\RefreshMeat\LetsWork\dados`. A ponte e o backend do aplicativo escutam somente em `127.0.0.1`.

Dados de candidatos, banco SQLite, relatórios, sessões de navegador, currículos gerados, executáveis e certificados não são versionados no Git.

## Documentação

- [Histórico técnico, decisões, erros e correções](docs/HISTORICO_TECNICO.md)
- [Status atual e validações](docs/STATUS_ATUAL.md)

Antes de alterar busca, ranking, histórico ou autenticação, leia o histórico técnico para evitar regressões já resolvidas.

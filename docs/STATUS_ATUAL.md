# Status atual do LetsWork

Data: 18/09/2026

## Estado validado

- Busca ampla: validada.
- Janela padrão: últimos 15 dias.
- Até 500 vagas enviáveis por lote, sem limitar a coleta bruta a 500.
- RioVagas continua fonte principal para candidaturas sem login.
- Vagas.com continua ativo como fonte bônus/prioritária quando responde; não bloqueia a busca quando falha.
- LinkedIn e Gupy continuam ativos. Nunca são excluídos por domínio inteiro; cada vaga é classificada individualmente.
- LinkedIn agora faz verificação aprofundada antes de declarar login: página pública, endpoint guest da vaga, URLs externas embutidas, atributos de candidatura e redirects. Bloqueios antigos de LinkedIn são rechecados em buscas futuras.
- Novas fontes adicionadas: Tramper, Huanna, BeaVagas e EmpregoDaqui.
- Tramper, Huanna e BeaVagas entram como fontes de candidatura sem criação de conta quando a vaga estiver recente e compatível.
- EmpregoDaqui entra na coleta, mas vagas que terminam apenas em WhatsApp não contam como envio automático até existir um fluxo seguro que não dependa de sessão do WhatsApp.
- Teste de 18/09/2026 com o perfil de validação e escopo RJ:
  - 2.643 vagas coletadas;
  - 2.592 recentes;
  - 3.353 no pool persistente;
  - 516 compatíveis;
  - 72 enviáveis sem login naquele recorte;
  - fontes frescas: RioVagas 2.200, LinkedIn 240, Vagas.com 140, Gupy 40, Remotive 15, BeaVagas 6, Huanna 1, Link Vagas 1;
  - Tramper e EmpregoDaqui retornaram 0 vagas recentes úteis para o recorte RJ naquele momento.
- Em teste isolado, 120 vagas LinkedIn foram verificadas com a lógica aprofundada; nenhuma delas possuía destino externo comprovadamente sem login. Elas não foram falsamente promovidas a enviáveis.
- Histórico por candidato: ativo.
- Modo preview: não grava vaga como “já apresentada”.
- Dados locais consolidados em `%USERPROFILE%\LetsWork\dados`; código local em `%USERPROFILE%\LetsWork\app`.
- Currículo personalizado: o PDF original nunca é “editado por cima” nem recebe capa. O conteúdo é extraído; PDF-imagem/scan cai para OCR; os fatos são estruturados; um currículo novo é reconstruído para cada vaga.
- Portfólio: OCR serve apenas para entendimento factual. O PDF visual original é anexado inteiro depois do currículo personalizado, preservando imagens e diagramação.
- Validação de 18/09/2026: OCR do portfólio recuperou 2.304 caracteres; currículo gerado teve 1 página; portfólio original anexado teve 18 páginas; total 19.
- A página 1 do portfólio original e a página correspondente do PDF combinado produziram o mesmo SHA-256 renderizado, confirmando preservação visual.
- Candidatura automática usa Playwright + Chromium headless; Google Chrome comum não é usado no fluxo automático.
- RioVagas reconhece resposta de candidatura anterior como `ALREADY_APPLIED` e não tenta novamente em retry.
- XLSX e CSV: exportação validada.
- Layout: sem overflow horizontal.
- IA: somente sessão persistente do ChatGPT web no perfil dedicado, GPT-5.6 Sol High, controlada por CDP local em `127.0.0.1:9333`. Cada candidato mantém uma única conversa persistente salva em `dados\\chatgpt-conversations.json`. O Chromium dedicado é deslocado para fora da tela, retirado da barra de tarefas e mantido ativo via CDP, portanto só a janela do LetsWork fica visível.
- Validação E2E de 18/09/2026: candidato fictício gerou 39 termos de busca; o mesmo chat persistente personalizou o currículo; PDF de 1 página foi gerado localmente; Playwright anexou o arquivo a um formulário local e o upload recebido teve tamanho idêntico (`UPLOAD_MATCH=true`); nenhuma vaga real foi enviada.
- Pipeline de candidatura: pré-flight com Playwright abre até 12 páginas em paralelo e verifica a candidatura real antes de gastar IA. Vagas antes marcadas como `UNVERIFIED_LOGIN` entram como acesso a verificar; login comprovado é cortado antes da geração de currículo.
- Personalização em lote: o Sol processa até 50 vagas por chamada e devolve somente seleção factual de projetos/skills; o texto final é montado localmente a partir do currículo verificado. Se a IA em lote falhar, existe fallback factual local em vez de dezenas de chamadas individuais.
- Envio: um único Chromium de aplicação é compartilhado por até 10 workers, cada um em contexto isolado. Uma vaga lenta não bloqueia as demais.
- Formulários: perguntas obrigatórias de uma etapa são consolidadas em uma única chamada ao Sol. Bairro e outros fatos explícitos são resolvidos localmente; deslocamento pode receber uma estimativa conservadora quando origem e destino são conhecidos.
- PDFs personalizados são salvos permanentemente em `dados\\candidatos\\<id>\\curriculos_personalizados`, não em `temp\\runtime_*`.
- Benchmark isolado de 18/09/2026: 50 vagas fictícias passaram pelo pipeline completo em 56,471 s, com 50 PDFs gerados e 50/50 `SENT`. Os 50 PDFs ficaram prontos em cerca de 32 s. Teste genérico adicional confirmou `SENT` com arquivo anexado e preenchimento em lote de bairro, deslocamento, residência por região e disponibilidade.
- Authenticode do executável: deve ser Valid após cada build.

## Regras de ouro

- coletar muito e ranquear depois;
- não completar 500 com vaga ruim;
- nenhuma vaga com login, criação de conta ou e-mail usado como autenticação entra na fila automática;
- formulário normal pode pedir e-mail de contato;
- LinkedIn/Gupy continuam sendo pesquisados;
- link externo do LinkedIn deve ser procurado antes de concluir que a vaga exige login;
- RioVagas e Vagas.com continuam prioritários;
- Tramper, Huanna, BeaVagas e EmpregoDaqui complementam a coleta;
- não inventar fatos do candidato;
- currículo específico por vaga;
- testes não contaminam histórico real;
- não versionar dados de candidatos, bancos, certificados ou executáveis.

- Corre��o de 18/09/2026: hist�rico de busca n�o bloqueia mais vagas com status `SELECTED` ou `ERROR`. Apenas `SENT` e `ALREADY_APPLIED` impedem a vaga de reaparecer em buscas futuras.
- Preview de valida��o ap�s a corre��o: 2.554 coletadas, 2.534 recentes, 3.351 no pool, 525 compat�veis e 79 envi�veis sem login; somente 5 vagas j� realmente enviadas foram ignoradas pelo hist�rico.


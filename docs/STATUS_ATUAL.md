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
- Personalização de currículo por vaga: validada em 3 vagas diferentes.
- Candidatura dry-run: 3/3 READY, cada uma usando currículo específico.
- XLSX e CSV: exportação validada.
- Layout: sem overflow horizontal.
- IA local: Ollama com modelo letswork-ai.
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

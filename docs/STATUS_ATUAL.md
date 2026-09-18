# Status atual do LetsWork

Data: 17/09/2026

## Estado validado

- Busca ampla: validada.
- Último preview: 867 coletadas, 807 recentes, 646 compatíveis, 347 enviáveis.
- RioVagas: 542 vagas frescas na validação.
- Vagas.com: temporariamente bloqueado por HTTP 429/WAF na máquina de desenvolvimento. Há cooldown e cache persistente para resultados bons futuros.
- LinkedIn/Gupy: mantidos na busca, mas só vagas sem autenticação entram na fila automática.
- Histórico por candidato: ativo.
- Modo preview: ativo, sem contaminar histórico.
- Personalização de currículo por vaga: validada em 3 vagas diferentes.
- Candidatura dry-run: 3/3 READY, cada uma com currículo específico.
- XLSX/CSV: validados com 630 linhas e colunas corretas.
- Layout: sem overflow horizontal no Electron.

## Pendência operacional

Candidatura real não foi disparada durante os testes. O envio real deve ser feito somente quando houver intenção explícita de executar candidaturas, pois produz efeitos externos.

## Regras de ouro

- coletar muito;
- ranquear depois;
- selecionar até 500 enviáveis;
- não contar login/e-mail como enviável;
- não inventar fatos;
- não contaminar histórico com testes;
- não versionar dados de candidatos.

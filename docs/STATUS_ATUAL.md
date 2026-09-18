# Status atual do LetsWork

Data: 17/09/2026

## Estado validado

- Busca ampla: validada.
- Pool de teste chegou a mais de 1.000 vagas recentes persistidas.
- Um preview validado produziu 630 vagas compatíveis.
- Após corrigir o classificador de envio, as mesmas 630 vagas resultaram em 333 enviáveis confirmadas: 332 RioVagas e 1 Gupy.
- Outro ciclo posterior registrado no ambiente chegou a 646 compatíveis e 347 enviáveis.
- RioVagas: fonte prioritária e 100% das 332 vagas compatíveis do teste de reclassificação foram reconhecidas como enviáveis.
- Vagas.com: temporariamente sujeito a HTTP 429/WAF na máquina de desenvolvimento. Há cooldown e cache persistente para resultados bons futuros; se ainda não houver uma coleta boa em cache, a fonte pode legitimamente vir vazia durante o cooldown.
- LinkedIn/Gupy: mantidos na busca, mas só vagas sem autenticação entram na fila automática.
- Histórico por candidato: ativo.
- Modo preview: ativo e não grava “vaga já apresentada”.
- 363 marcações produzidas por testes antigos foram retiradas do histórico de teste.
- Personalização de currículo por vaga: validada em 3 vagas diferentes.
- Os 3 PDFs tinham hashes distintos e primeira página específica para cada vaga, preservando o currículo original.
- Candidatura dry-run: 3/3 READY, cada uma com currículo específico; nenhum envio real foi realizado.
- XLSX/CSV: validados com 630 linhas e cabeçalhos exatos: Enviado, Nome da vaga, Local, Remuneração, Link.
- Layout: sem overflow horizontal no Electron.
- Build portátil final: concluído.
- Executável: `Desktop\LetsWork.exe`, aproximadamente 124 MB.
- Authenticode: Valid.
- Executável empacotado: inicialização validada.
- Backend do EXE: HTTP 200 em `127.0.0.1:4317`.
- Processo dono da porta: o próprio `LetsWork.exe` extraído pelo pacote portátil.
- IA no EXE: Ollama online, modelo `letswork-ai` instalado.
- Layout no EXE final: `innerWidth=1536`, `scrollWidth=1536`, `overflow=[]`.
- Código local commitado: `a756918` — “LetsWork: busca ampla, candidatura segura e documentação”.

## GitHub

O repositório local está pronto para publicação e sem dados de candidatos, banco, certificados ou executáveis.

A criação automática de um repositório novo no GitHub não foi concluída porque:
- o repositório LetsWork ainda não existe na conta conectada;
- o conector GitHub disponível não expõe criação de repositório;
- a sessão web do GitHub não está autenticada.

Assim que existir um repositório vazio `refreshmeat/LetsWork` (ou outro nome escolhido), o commit local está pronto para ser associado e enviado.

## Pendência operacional intencional

Candidatura real não foi disparada durante os testes. O envio real produz efeitos externos e deve ocorrer somente quando houver intenção explícita de enviar candidaturas reais.

## Regras de ouro

- coletar muito;
- ranquear depois;
- selecionar até 500 enviáveis;
- não completar 500 com vaga ruim;
- não contar login/e-mail de autenticação como enviável;
- priorizar RioVagas e Vagas.com sem excluir automaticamente LinkedIn/Gupy;
- não inventar fatos;
- currículo específico por vaga;
- não contaminar histórico com testes;
- não versionar dados de candidatos.

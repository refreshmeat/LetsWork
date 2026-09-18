# LetsWork — Histórico técnico, decisões e lições do projeto

> Documento vivo. Atualizado em 17/09/2026.
>
> Objetivo: impedir que decisões já tomadas sejam perdidas, que regressões antigas sejam reintroduzidas e que testes contaminem dados reais.

## 1. Propósito do projeto

O LetsWork nasceu como uma iniciativa social para ajudar pessoas com pouco acesso a tecnologia a encontrar e se candidatar a vagas de emprego em volume, com qualidade e sem exigir que cada pessoa navegue manualmente por dezenas de sites.

O produto é um aplicativo desktop local para Windows. Ele deve:

1. receber currículo e documentos de apoio;
2. interpretar perfil, formação, competências e área pretendida;
3. buscar muitas vagas recentes em várias fontes;
4. ordenar e filtrar as melhores oportunidades;
5. excluir da fila automática vagas que exijam autenticação ou barreiras incompatíveis com o fluxo;
6. adaptar o currículo individualmente para cada vaga, sem inventar fatos;
7. preencher candidaturas e, em modo real, enviar somente quando houver confirmação explícita;
8. guardar histórico para não repetir vagas já apresentadas;
9. exportar relatório simples e útil;
10. permitir apagar completamente os dados locais do candidato.

## 2. Princípios que não devem ser quebrados

- Busca ampla primeiro, ranking depois.
- O teto de 500 é da fila/lote de processamento, não da coleta.
- A primeira busca de um candidato pode coletar 1.000, 2.000 ou mais vagas.
- Só as melhores vagas elegíveis entram no lote de até 500.
- Não incluir vaga ruim apenas para “completar 500”.
- RioVagas e Vagas.com são fontes prioritárias porque historicamente entregam alto volume e baixo atrito.
- LinkedIn e Gupy continuam importantes pela qualidade das vagas, mas cada vaga deve ser verificada individualmente.
- Nenhuma fonte inteira deve ser proibida só pelo nome.
- Vaga que exige login, criação de conta ou etapa de autenticação por e-mail fica fora da fila automática.
- Formulário normal de candidatura pode conter e-mail de contato; o bloqueio é para e-mail usado como barreira de autenticação/conta.
- Nunca inventar experiência, formação, licença profissional, senioridade, habilidade, disponibilidade, PCD ou dado pessoal.
- Área pretendida informada pelo usuário tem prioridade sobre inferências.
- PCD: excluir por padrão apenas vaga explicitamente exclusiva para PCD; vaga “também para PCD” pode permanecer.
- Localização padrão: priorizar cidade escolhida, mas aceitar o estado.
- Vagas remotas compatíveis podem entrar quando o filtro permitir.
- Histórico é por candidato.
- Repostagem legítima com nova data de publicação pode voltar.
- Testes internos não podem marcar vaga como “já apresentada” para o candidato.
- Nunca alterar/apagar a pasta externa BARBARA_VAGAS.

## 3. Arquitetura atual

### Desktop
- Electron 44.
- Janela maximizada.
- Backend Express local em 127.0.0.1:4317.
- IA local via Ollama, modelo letswork-ai baseado em qwen3:1.7b.
- Build portátil para Windows.
- Assinatura local Authenticode com certificado “LetsWork Local Code Signing”.

### Dados
Raiz única do LetsWork:

`%USERPROFILE%\LetsWork\`

Código local:

`%USERPROFILE%\LetsWork\app\`

Banco principal:

`%USERPROFILE%\LetsWork\dados\data\letswork.sqlite`

Pastas por candidato:

`%USERPROFILE%\LetsWork\dados\candidatos\<id>\`

Cada candidato mantém currículo original, documentos de apoio, currículos personalizados, relatórios e sessões próprias. Nenhum dado operacional deve voltar para `Documents\LetsWork`.

### Tabelas relevantes
- candidates
- resumes
- documents
- runs
- jobs
- applications
- candidate_job_history
- candidate_job_pool

`candidate_job_pool` é o pool persistente recente por candidato. Ele permite coletar bastante, reaproveitar resultados recentes e separar “coletado” de “selecionado”.

## 4. Pipeline de busca definido

### Etapa A — interpretação do candidato
A IA recebe dados profissionais verificados e, quando houver, a área pretendida.

Ela deve produzir uma família ampla de termos:
- cargos diretamente relacionados;
- sinônimos;
- funções adjacentes plausíveis;
- cargos de entrada, assistente, auxiliar, estágio, aprendiz ou júnior quando compatíveis.

A IA não tem autorização para elevar qualificação.

Exemplo de regra:
- técnico de enfermagem não vira enfermeiro;
- estudante não vira profissional regulamentado sem formação;
- auxiliar não vira especialista sem evidência.

Existe validação determinística complementar contra senioridade e profissões regulamentadas.

### Etapa B — coleta
A coleta não tem teto de 500.

Configuração atual permite milhares de resultados no pool, com limites técnicos por fonte e um pool global amplo.

Janela padrão de publicação: últimos 15 dias.

Fontes:
- RioVagas
- Vagas.com
- LinkedIn
- Gupy
- EmpregosRJ
- Link Vagas
- Remotive
- Jooble quando configurado
- Adzuna quando configurado

### Etapa C — deduplicação
Deduplicação por URL canônica e impressão semântica.

Fingerprint considera:
- título;
- empresa;
- localização;
- data de publicação.

A data faz parte para permitir repostagem real.

### Etapa D — ranking
O ranking deve principalmente ORDENAR.

Só deve excluir cedo quando houver incompatibilidade clara, como:
- localização fora do escopo;
- senioridade explicitamente incompatível;
- requisito forte de experiência incompatível com filtro;
- contrato fora das opções marcadas;
- vaga exclusiva PCD quando PCD exclusivo está desativado;
- incompatibilidade profissional inequívoca.

Termos gerados pela IA são evidência de relevância.

Correspondência de termo deve respeitar palavra/frase, não substring arbitrária. Correção importante: “marketing” não pode casar automaticamente com “telemarketing”.

### Etapa E — sendability
Depois do ranking, cada vaga é classificada para envio.

Estados principais:
- enviável;
- LOGIN_REQUIRED;
- EMAIL_REQUIRED;
- UNVERIFIED_LOGIN.

A fila automática só usa vagas confirmadas como enviáveis.

O sistema continua verificando o pool até chegar a até 500 enviáveis ou esgotar as vagas relevantes.

## 5. Prioridade de fontes

### RioVagas
Fonte primária.

A coleta usa API WordPress recente, mais eficiente que abrir página por página.

Como o RioVagas é uma fonte ampla, os itens recebem `broadCollection=true`. Essa flag é importante para evitar que listagens amplas sejam tratadas como se já tivessem sido filtradas por cargo.

### Vagas.com
Fonte primária.

Regras:
- buscar “mais recentes”;
- interpretar Hoje, Ontem, Há X dias e datas normais;
- baixo volume de requisições;
- espaçamento entre requisições;
- ao receber HTTP 429, preservar tudo que já tiver sido coletado;
- manter cache persistente da última coleta boa.

Limitação conhecida:
se ocorrer 429 antes de existir uma primeira coleta boa persistida, a fonte pode retornar zero naquele ciclo. Isso deve ser visível no log e não pode zerar as demais fontes.

Não martelar Vagas.com em testes repetidos.

### LinkedIn
Coleta pública de listagens.

Não assumir que toda vaga exige login.
- vaga com candidatura externa comprovadamente pública pode entrar;
- login/authwall bloqueia;
- vaga não verificável não conta como enviável.

### Gupy
Mesma regra: decisão por vaga, não por domínio.

## 6. IA: decisão importante

A IA existe para ampliar busca, não apenas para reescrever texto.

Erro encontrado:
o Ollama local levava aproximadamente 20–25 segundos na primeira inferência, mas o código desistia em poucos segundos. Resultado: a IA “existia” no projeto, porém a busca frequentemente caía no fallback antes de receber a resposta.

Correções:
- timeout de primeira inferência aumentado;
- modelo mantido aquecido;
- entrada enviada para IA foi reduzida para informação profissional relevante;
- portfólio gigante e dados irrelevantes não precisam ser enviados ao planejador de busca;
- prompt exige diversidade de cargos e separação entre direto/adjacente/entrada;
- segunda validação pode remover termos claramente incompatíveis.

O modelo local é pequeno e pode sugerir termos ruins. Por isso a arquitetura é híbrida: IA amplia + regras de segurança verificam + ranking ordena.

## 7. Regressões importantes que já aconteceram

### 7.1 Ranking permissivo demais
Scripts históricos `fix_ranking_reach.py` e `broaden_ranking_without_junk.py` passaram a aceitar vaga quando a descrição continha palavras da área, mesmo com título incompatível.

Sintoma:
vagas aleatórias apareceram para um perfil de Design, incluindo funções sem relação.

Lição:
descrição ajuda no score, mas não pode transformar cargo claramente diferente em vaga compatível.

### 7.2 Ranking apertado demais
Na tentativa de corrigir lixo, o funil passou a cortar cedo demais.

Sintoma:
centenas de vagas coletadas viravam poucas dezenas compatíveis.

Correção:
busca ampla + termos da IA + ranking principalmente ordenador.

### 7.3 RioVagas perdeu broadCollection
A coleta nova do RioVagas deixou de marcar listagens como coleta ampla.

Consequência:
ranking aplicou pressupostos errados.

Correção:
restaurada `broadCollection=true`.

### 7.4 Repetição de probe em LinkedIn
O classificador de login reavaliava repetidamente as mesmas vagas não verificadas do LinkedIn.

Consequência:
gastava o orçamento de probes e deixava vagas posteriores do RioVagas sem classificação.

Sintoma observado:
79 vagas RioVagas apareceram como UNVERIFIED_LOGIN.

Correção:
cada vaga desconhecida ganha marca de tentativa `_sendabilityChecked`; ela é testada uma vez por ciclo.

Teste após correção:
- 630 compatíveis analisadas;
- 333 enviáveis;
- RioVagas: 332/332 enviáveis;
- Gupy: 1 enviável;
- LinkedIn: 170 bloqueadas por login e 122 ainda não verificáveis;
- nenhuma vaga RioVagas ficou não verificada.

### 7.5 Histórico de testes contaminou candidato
Testes anteriores escreveram centenas de vagas como “já apresentadas”.

Consequência:
uma busca real retornou apenas uma vaga.

Foram removidas 363 marcações criadas pelos testes internos.

Correção arquitetural:
`preview=true` cria run de teste sem gravar histórico de apresentação.
Runs PREVIEW também não devem virar “última execução” do candidato.

### 7.6 Defaults incorretos em uma execução
Foi observada execução com:
- city_only;
- none (somente sem experiência).

Os defaults corretos na UI são:
- `state_priority`: priorizar cidade, aceitar estado;
- `entry`: sem ou pouca experiência.

### 7.7 Match de substring
“marketing” podia casar dentro de “telemarketing”.

Correção:
comparação com limites de palavra/frase.

### 7.8 Termos ruins extraídos do currículo
Fallback chegou a transformar nome da pessoa, “Formações”, localização e skills isoladas em termos de busca.

Correção:
limpeza de termos; IA não deve usar nome, cidade, idioma, ferramenta ou formação como “cargo” isolado.

### 7.9 IA repetindo o mesmo cargo
Modelo local pequeno gerou várias versões de “designer de interfaces”.

Correção:
prompt estruturado em direct/adjacent/entry, nomes curtos e funções distintas.

### 7.10 Fonte pendurada segurava a busca
Uma fonte lenta podia prolongar a resposta global.

Correção:
timeout global por fonte. A busca continua com as fontes já concluídas.

### 7.11 Timers de timeout geravam logs falsos
Após a busca terminar, timers perdedores do `Promise.race` continuavam disparando mensagens “timeout”.

Correção:
timer cancelado quando a fonte termina.

## 8. Layout / interface

Problema histórico:
havia uma faixa vazia à direita e largura horizontal maior que a janela.

Causa real:
input de upload invisível estava `position:absolute`, mas herdava `width:100%`, extrapolando o viewport.

Correção:
input de arquivo e inputs invisíveis de chips passaram a ter dimensões mínimas e clipping.

Validação:
- innerWidth: 1536
- scrollWidth: 1536
- overflow: []
- sidebar: 270
- content: 1266

Também foram removidos limites antigos de largura em topbar/tabs/painel.

## 9. Currículo personalizado por vaga

Regra absoluta:
nenhum fato pode ser inventado.

### Arquitetura correta

O LetsWork não depende de editar o arquivo original. O pipeline é genérico:

1. extrair texto diretamente quando o arquivo possui camada de texto;
2. detectar texto ruim, fragmentado ou insuficiente;
3. em PDF/imagem escaneada, renderizar páginas e usar OCR;
4. estruturar fatos reais de currículo e documentos de apoio;
5. usar a vaga somente para selecionar, ordenar e resumir fatos relevantes;
6. reconstruir um currículo novo e profissional para aquela vaga;
7. validar o PDF gerado antes de permitir candidatura.

É proibido inserir uma “capa direcionada” na frente do currículo original e chamar isso de personalização.

### Portfólio

O portfólio visual não deve ser reconstruído nem perder imagens.
OCR/extrator é usado apenas para compreender projetos e fatos.
No arquivo final:
- currículo personalizado vem primeiro;
- PDF original do portfólio é anexado integralmente depois;
- imagens, layout e páginas do portfólio permanecem preservados.

### Validação de 18/09/2026

No perfil de teste:
- OCR do portfólio recuperou 2.304 caracteres;
- currículo reconstruído teve 1 página;
- portfólio original teve 18 páginas;
- arquivo final teve 19 páginas;
- renderização da página original do portfólio e da página anexada gerou SHA-256 idêntico, confirmando preservação visual.

Currículos gerados pela lógica antiga de capa foram considerados inválidos e removidos durante a limpeza.

## 10. Candidatura

Existem dois modos:
- Simulação/dry-run;
- Modo real.

Modo real exige confirmação explícita.

No dry-run:
- navega até formulário;
- preenche apenas dados conhecidos;
- gera currículo específico depois de obter a descrição completa da vaga;
- anexa currículo;
- não clica no envio final;
- retorna READY se tudo necessário estiver resolvido;
- retorna NEEDS_DATA se faltar fato obrigatório;
- retorna SKIPPED_LOGIN quando autenticação bloqueia.

CAPTCHA, 2FA e declarações jurídicas não triviais exigem intervenção humana.

## 11. Relatórios

Colunas definidas:
1. Enviado
2. Nome da vaga
3. Local
4. Remuneração
5. Link

Formatos:
- XLSX
- CSV

Teste de 17/09/2026:
- XLSX e CSV exportados;
- ambos com 630 linhas no run de teste;
- cabeçalhos exatamente conforme especificação;
- XLSX abriu corretamente via ExcelJS.

Estados de bloqueio devem diferenciar LOGIN e EMAIL.

## 12. Memória de vagas

`candidate_job_history`:
- impede reapresentar vagas efetivamente mostradas/processadas;
- é isolado por candidato;
- não deve registrar reserva não apresentada como “vista”;
- PREVIEW não grava histórico.

`candidate_job_pool`:
- guarda vagas recentes coletadas;
- permite reaproveitar resultados;
- armazena classificação de envio;
- serve de reserva para próximos lotes.

## 13. Dados locais e privacidade operacional

Objetivo é funcionar sem contratação de banco externo.

Dados ficam em `%USERPROFILE%\LetsWork\dados`. A pasta `Documents` não deve receber dados operacionais do LetsWork.

Ao excluir candidato:
- cadastro;
- currículo;
- documentos;
- sessões;
- currículos personalizados;
- relatórios;
- dados relacionais

devem ser apagados.

Arquivos pessoais e bancos não devem ir para Git.

## 14. Git / arquivos que nunca devem ser versionados

Ignorar:
- node_modules
- .env
- *.pfx
- SQLite/WAL/SHM
- data de execução
- uploads
- reports
- sessions
- builds
- .exe
- temporários
- testes locais com dados de candidato

Nunca colocar currículo real, documento pessoal, banco local ou certificado no GitHub.

## 15. Build e assinatura

Script:
`scripts/build_portable_fresh.ps1`

Problemas históricos:
- executável antigo apresentou `SyntaxError: Illegal return statement`;
- em um teste a porta 4317 estava ocupada por servidor dev e pareceu que o EXE funcionava quando não era o EXE;
- PFX dentro da pasta `build` podia desaparecer durante empacotamento;
- diretório fixo `dist-final\win-unpacked` ficou bloqueado pelo Windows e causou EBUSY.

Correções:
- validar sempre o processo dono da porta;
- PFX temporário fica fora de build resources e é apagado no finally;
- build usa diretório de release novo para evitar lock;
- desktop deve conter somente o `LetsWork.exe` final;
- verificar Authenticode após copiar.

## 16. Checklist antes de considerar uma versão pronta

1. `npm run check`.
2. Confirmar nenhum run em SEARCHING/APPLYING/RETRYING.
3. Teste de busca em PREVIEW.
4. Confirmar coleta ampla.
5. Confirmar relevância visual de amostra.
6. Confirmar RioVagas/Vagas.com não foram abafados por fontes secundárias.
7. Conferir coletadas / enviáveis / bloqueadas por fonte.
8. Confirmar nenhuma vaga de login entra na fila.
9. Gerar pelo menos 3 currículos para vagas diferentes.
10. Verificar que os arquivos são realmente diferentes.
11. Rodar candidatura dry-run.
12. Confirmar READY/NEEDS_DATA/SKIPPED_LOGIN coerentes.
13. Exportar XLSX e CSV e validar colunas.
14. Buildar EXE.
15. Abrir EXE da Área de Trabalho.
16. Confirmar que a porta pertence ao processo empacotado.
17. Confirmar HTTP 200.
18. Confirmar IA/Ollama online.
19. Confirmar layout sem overflow.
20. Confirmar assinatura Authenticode válida.
21. Só então commitar e subir ao GitHub.

## 17. Números de referência dos testes de 17/09/2026

Um dos ciclos de preview, antes da correção final do probe, apresentou:
- pool recente persistente: 1.016;
- compatíveis: 630;
- enviáveis inicialmente: 254;
- bloqueadas por login/e-mail: 147;
- não verificadas: 229.

Depois de corrigir a repetição do probe e reclassificar as mesmas 630 vagas:
- enviáveis: 333;
- bloqueadas: 171;
- não verificadas: 126;
- RioVagas: 332 compatíveis, 332 enviáveis;
- Gupy: 2 compatíveis, 1 enviável;
- LinkedIn: 292 compatíveis, 170 bloqueadas, 122 não verificáveis;
- Remotive: 4 compatíveis, 1 bloqueada, 3 não verificáveis.

Esses números são diagnóstico daquele pool e não metas fixas.

## 18. Pontos ainda dependentes do mundo externo

- Vagas.com pode aplicar HTTP 429.
- LinkedIn/Gupy podem mudar HTML/fluxo sem aviso.
- CAPTCHA e 2FA não são automatizados.
- APIs Jooble/Adzuna dependem de configuração/chave.
- Sites podem alterar formulários.
- Uma vaga pode mudar de fluxo entre coleta e candidatura.

A resposta correta é falhar de forma explícita e preservar o que já foi coletado, nunca fingir sucesso.

## 19. Regra para mudanças futuras

Antes de “melhorar” ranking, login, PCD, localização ou histórico:
1. ler este documento;
2. identificar qual comportamento anterior será alterado;
3. criar teste que reproduza o problema;
4. mudar o mínimo possível;
5. rodar regressão;
6. registrar aqui a decisão.

O objetivo do LetsWork não é produzir a heurística mais esperta possível. É produzir um sistema previsível, amplo, seguro e útil para pessoas reais.


## 20. Atualizações de 18/09/2026 — novas fontes e verificação aprofundada

Estas alterações já fazem parte da versão atual do LetsWork:

- Tramper adicionado como nova fonte de vagas.
- Huanna adicionada como nova fonte de vagas.
- BeaVagas adicionada como nova fonte de vagas.
- EmpregoDaqui adicionado como nova fonte de coleta.
- LinkedIn e Gupy permanecem ativos e não são excluídos por domínio inteiro.
- LinkedIn ganhou uma verificação mais profunda antes de uma vaga ser classificada como login obrigatório:
  - página pública da vaga;
  - endpoint público/guest do anúncio;
  - campos JSON de candidatura externa;
  - atributos HTML de candidatura;
  - URLs escapadas;
  - redirects para páginas externas da empresa.
- Classificações antigas de LinkedIn podem ser rechecadas, evitando que um falso bloqueio histórico impeça uma vaga externa sem login de ser aproveitada.
- EmpregoDaqui não é automaticamente tratado como enviável quando o único canal é WhatsApp. A vaga pode ser coletada, mas não entra como candidatura automática até existir um fluxo seguro e comprovado.
- Tramper, Huanna e BeaVagas só contribuem para a fila quando a vaga for recente, compatível e atender às regras de envio.
- Vagas.com continua sendo usado quando responde, mas sua falha nunca pode impedir a busca nas demais fontes.
- A regra central continua a mesma: coletar amplamente, ranquear depois e só colocar na fila automática vagas comprovadamente sem login, criação de conta ou barreira de autenticação por e-mail.

### Testes desta atualização

No preview completo de 18/09/2026:
- 2.643 vagas foram coletadas;
- 2.592 eram recentes;
- 3.353 estavam no pool persistente;
- 516 foram consideradas compatíveis;
- 72 eram enviáveis sem login naquele recorte específico;
- fontes frescas incluíram RioVagas 2.200, LinkedIn 240, Vagas.com 140, Gupy 40, Remotive 15, BeaVagas 6, Huanna 1 e Link Vagas 1.

Também foi executado um teste isolado em 120 vagas do LinkedIn usando a nova verificação aprofundada. Nenhuma das 120 possuía, naquele momento, destino externo comprovadamente sem login. O resultado importante é que o LetsWork agora procura esse destino antes de bloquear a vaga.

### Build validado

Após essas mudanças:
- o executável foi rebuildado;
- a assinatura Authenticode permaneceu válida;
- o backend respondeu HTTP 200;
- a IA local letswork-ai permaneceu online;
- o layout continuou sem overflow horizontal.

Este bloco deve ser tratado como parte do histórico oficial do projeto e lido antes de futuras alterações em fontes, sendability ou regras de login.

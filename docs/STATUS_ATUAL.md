# LetsWork v0.1.0 — versão final

Fechada em 30/09/2026.

## Produto

A v0.1.0 é a primeira versão final distribuível do LetsWork.

Fluxo principal:

`currículo → extração/normalização factual → currículo-base otimizado → inventário RioVagas → ranking → pré-voo → envio HTTP → confirmação`

## Fonte e inventário

- Somente RioVagas nesta versão.
- SQLite local por computador.
- Janela móvel de até 30 dias.
- Reconciliação completa obrigatória na abertura quando necessária.
- A busca aguarda a sincronização inicial antes de usar o inventário.
- Atualização incremental durante o uso.
- Manutenção automática do inventário durante a execução.
- Nova reconciliação completa quando a última tiver 24 horas ou mais.
- Vagas removidas ou com mais de 30 dias ficam inativas sem destruir referências históricas.
- Snapshot completo só pode desativar vagas quando todos os IDs esperados do WordPress foram lidos.

## Currículo

Todo currículo otimizado passa pelo mesmo pipeline global. Não existem correções específicas por candidato.

Regras da v0.1.0 final:

- Reextração e normalização automática dos dados sempre que o currículo-base é otimizado.
- Normalizador central único para corrigir texto com codificação quebrada antes de classificar as seções.
- Nome, e-mail, telefone/WhatsApp, LinkedIn, bairro, cidade, estado e CNH são tratados como campos distintos.
- Endereço não pode contaminar cidade/estado/CNH.
- Links do LinkedIn preservam o endereço completo e normalizam caracteres acentuados no slug.
- Cabeçalhos de Formação, Experiência, Habilidades, Cursos e demais seções são classificados antes da diagramação.
- Cabeçalhos duplicados de Experiência Profissional ou Formação Acadêmica bloqueiam a geração.
- Trechos de experiência não podem vazar para Cursos Complementares.
- Currículo-base deve ter exatamente uma página.
- Layout Executivo, Clássico e Compacto continuam disponíveis.
- Conteúdo factual; sem inventar experiência, formação, credenciais ou senioridade.
- O PDF otimizado é reutilizado nas candidaturas.
- PDF e DOCX continuam sendo os formatos preferidos de entrada/distribuição.

## Ranking e formulários

- Área desejada informada pelo usuário tem prioridade sobre inferências.
- Quando o campo fica vazio, o sistema tenta inferir a direção profissional a partir do currículo.
- Regras determinísticas filtram incompatibilidades objetivas.
- Ollama/llama3.2:3b revisa casos ambíguos.
- Pré-voo obrigatório antes de qualquer envio real.
- Variações atuais do formulário RioVagas são suportadas.
- Campos obrigatórios novos ou estrutura desconhecida bloqueiam o envio.
- Dados deriváveis são extraídos/calculados antes de pedir informação humana.
- Dados realmente ausentes podem ser salvos no perfil e reutilizados.
- Formulários incoerentes são INVALID_FORM, não pendência do candidato.

## Envio e prova

- Envio direto HTTP, sem Playwright/Chromium.
- SENT exige confirmação positiva e recibo persistido.
- UNCERTAIN não é considerado sucesso e não é reenviado automaticamente.
- Circuit breaker pausa o lote em erro inesperado.
- Lotes grandes reais foram validados com recibos positivos do RioVagas.

## Isolamento de candidatos

- Runs, jobs, aplicações, histórico e recibos são associados ao candidato correto.
- Troca de candidato limpa imediatamente o resultado visual anterior.
- Respostas assíncronas antigas não podem repintar vagas de outro candidato.
- Smoke/regressão verificam candidaturas órfãs e cruzamento de candidatos.

## Interface

- Localização mostra apenas bairro/cidade/estado.
- Benefícios, vale-transporte e horário não podem aparecer em Local.
- Tipo de vaga usa checkboxes visíveis para CLT, PJ, Estágio, Temporário, Aprendiz e Freelancer.
- É obrigatório selecionar ao menos um tipo de vaga.

## Testes finais

A versão final passa:

- `npm run check`
- `npm run regression`
- `npm run smoke`
- `git diff --check`

Regressões cobrem, entre outros:

- janela 7/15/30;
- sincronização de abertura;
- snapshot completo;
- isolamento candidato/run;
- vínculos de inventário;
- recibos de envio;
- localização limpa;
- formulário e dados de perfil;
- normalização de codificação;
- extração de contato/localização/CNH;
- geração de currículo-base em uma página;
- bloqueio de seções duplicadas.

O pipeline final de currículo foi testado nos quatro perfis locais existentes usando exatamente as mesmas regras globais.

## Distribuição

O pacote para outro computador não contém banco, currículo, documento ou histórico real.

Requisitos do usuário:

- Windows 10/11 x64;
- internet na instalação e para sincronizar vagas;
- aproximadamente 3 GB livres além do espaço normal do Windows/aplicativo.

O usuário não precisa instalar Ollama manualmente.

O instalador único:

1. instala o LetsWork;
2. baixa o instalador oficial do Ollama quando necessário;
3. valida a assinatura digital do Ollama;
4. instala o Ollama silenciosamente;
5. baixa e valida o modelo local de IA;
6. cria apenas os atalhos do LetsWork.

Cada computador cria seus próprios dados em:

`%USERPROFILE%\LetsWork\dados`

O instalador usa assinatura local Authenticode. Em computadores que ainda não confiam nesse certificado, o Windows SmartScreen pode exibir aviso.

## Git

Branch oficial: `main`.

Tag oficial da versão final: `v0.1.0`.

A branch temporária usada durante as correções finais deve ser removida após a integração em `main`.

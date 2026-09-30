# LetsWork v0.1.0

Aplicativo desktop para Windows que importa currículos, organiza o perfil profissional, encontra vagas compatíveis no RioVagas e automatiza candidaturas por HTTP, sem login e sem automação de navegador.

## Escopo fechado da v0.1

- Fonte de vagas: somente RioVagas.
- Inventário global em SQLite com janela móvel de até 30 dias.
- Reconciliação completa do RioVagas em toda abertura do programa.
- Atualização incremental durante o uso e nova reconciliação completa após 24 horas.
- Filtros locais de 7, 15 e 30 dias.
- Ranking profissional por regras objetivas e revisão local de casos ambíguos.
- Área desejada informada pelo usuário tem prioridade. Se ficar vazia, o LetsWork tenta inferir a direção profissional a partir do currículo.
- Currículo-base profissional em PDF, reutilizado nas candidaturas.
- Pré-voo obrigatório de cada formulário antes de qualquer POST real.
- Envio direto por HTTP.
- Status SENT somente quando existe confirmação positiva persistida.
- Estados conservadores para envio sem prova, formulário inválido e dados pessoais realmente ausentes.
- Histórico e resultados isolados por candidato.

## Dados locais

Por padrão, cada instalação usa:

`%USERPROFILE%\LetsWork\dados`

O código e os instaladores não carregam currículos, bancos, documentos ou histórico de outros usuários.

## IA local

A v0.1 usa Ollama com o modelo `llama3.2:3b` para revisar casos ambíguos. As regras determinísticas continuam sendo a base do sistema.

Para uma instalação nova, execute o preparador de IA fornecido junto do instalador. Ele instala o Ollama quando possível e baixa o modelo necessário.

## Formatos de currículo

Funcionam diretamente:
- PDF
- DOCX
- imagens PNG/JPG/JPEG/WEBP/BMP/TIF/TIFF
- TXT e formatos de texto simples
- ZIP contendo arquivos suportados

Arquivos antigos DOC/RTF/ODT usam automação do Microsoft Word para conversão. Para máxima compatibilidade em computadores de clientes, prefira PDF ou DOCX.

OCR de imagens/PDFs escaneados usa Tesseract.js e pode baixar os dados de idioma na primeira utilização. A aplicação já exige internet para sincronizar o RioVagas.

## Build

Versão: `0.1.0`

Comandos de validação:

- `npm run check`
- `npm run regression`
- `npm run smoke`
- `npm run regression:live`
- `npm run dist`

O build oficial gera instalador NSIS e executável portátil para Windows x64.

## Estrutura ativa

- `desktop/main.cjs`: aplicativo Electron.
- `public/`: interface.
- `src/server.mjs`: API local e orquestração.
- `src/services/jobs.mjs`: inventário e sincronização RioVagas.
- `src/services/ranking.mjs`: compatibilidade profissional.
- `src/services/tailor.mjs`: currículo-base.
- `src/apply/rio.mjs`: candidatura HTTP RioVagas.
- `src/apply/answers.mjs`: respostas e inferências de formulário.
- `src/services/inventory.mjs`: histórico, FTS e métricas.
- `src/services/ai.mjs`: integração local com Ollama.

## Segurança operacional

- Nenhuma candidatura real é feita em testes de regressão.
- Antes do modo real, todos os formulários do lote passam por pré-voo.
- Um erro inesperado ou resposta sem confirmação aciona proteção contra reenvio.
- Currículos e dados pessoais nunca devem ser versionados no Git.
- O instalador distribuído não contém dados de candidatos.

## Release

A v0.1.0 é a primeira versão fechada para distribuição controlada em outros computadores Windows.

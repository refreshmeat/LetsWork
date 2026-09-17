# AUTOMAÇÃO CURRÍCULO

Aplicação local para importar um currículo, buscar vagas compatíveis, preparar versões direcionadas e automatizar candidaturas com rastreamento de resultados.

## Estado atual

O MVP já possui interface local, leitura de PDF/DOCX/ZIP/texto, OCR para imagens e PDF escaneado, filtros de localização/remoto/PCD/CLT/PJ, busca em RioVagas e EmpregosRJ, suporte opcional à API do Jooble, ranking, modo de simulação, candidatura via Chrome/Playwright, retry e exportação CSV/XLSX.

A automação nunca deve inventar formação, experiência, habilidade, disponibilidade ou outro dado factual. Campos obrigatórios sem informação confirmada ficam como `NEEDS_DATA`. CAPTCHA e autenticação adicional também exigem intervenção manual.

## Executar

1. Instale Node.js 24+ e Google Chrome.
2. Rode `npm install`.
3. Copie `.env.example` para `.env` e configure apenas as integrações desejadas.
4. Rode `npm start`.
5. Abra `http://127.0.0.1:4317`.

## Dados locais

O banco fica em `data/runtime.sqlite`. Currículos importados ficam em `uploads/`, versões geradas em `generated/` e relatórios em `reports/`. Esses diretórios são descartáveis e não são enviados ao Git.

## Fluxo

Currículo → extração/OCR → perfil → filtros → coleta → deduplicação → compatibilidade → currículo por vaga → simulação/envio → tracker → retry → CSV/XLSX.

## Limites atuais

A preservação de layout com alteração de conteúdo está implementada de forma segura para DOCX. Currículos PDF e formatos não editáveis ainda são preservados sem alteração até existir uma estratégia genérica que não destrua o design original. Novos sites devem entrar como adaptadores, preferindo API oficial e usando Playwright quando necessário.

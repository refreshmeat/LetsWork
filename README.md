# LetsWork

AplicaÃ§Ã£o local para importar um currÃ­culo, buscar vagas compatÃ­veis, preparar versÃµes direcionadas e automatizar candidaturas com rastreamento de resultados.

## Estado atual

O MVP jÃ¡ possui interface local, leitura de PDF/DOCX/ZIP/texto, OCR para imagens e PDF escaneado, filtros de localizaÃ§Ã£o/remoto/PCD/CLT/PJ, busca em RioVagas e EmpregosRJ, suporte opcional Ã  API do Jooble, ranking, modo de simulaÃ§Ã£o, candidatura via Chrome/Playwright, retry e exportaÃ§Ã£o CSV/XLSX.

A automaÃ§Ã£o nunca deve inventar formaÃ§Ã£o, experiÃªncia, habilidade, disponibilidade ou outro dado factual. Campos obrigatÃ³rios sem informaÃ§Ã£o confirmada ficam como `NEEDS_DATA`. CAPTCHA e autenticaÃ§Ã£o adicional tambÃ©m exigem intervenÃ§Ã£o manual.

## Executar

1. Instale Node.js 24+ e Google Chrome.
2. Rode `npm install`.
3. Copie `.env.example` para `.env` e configure apenas as integraÃ§Ãµes desejadas.
4. Rode `npm start`.
5. Abra `http://127.0.0.1:4317`.

## Dados locais e descarte

Cada inicializaÃ§Ã£o cria uma pasta nova em `execucoes/EXECUCAO_AAAAMMDD_HHMMSS_PID/`. Dentro dela ficam `data/`, `uploads/`, `curriculos_personalizados/`, `relatorios/` e `sessoes_navegador/`. O terminal mostra o caminho exato da pasta ao iniciar.

Depois de encerrar o script, essa pasta inteira pode ser apagada sem afetar o programa. Na prÃ³xima execuÃ§Ã£o outra pasta limpa serÃ¡ criada automaticamente. Assim nenhuma execuÃ§Ã£o precisa acumular banco, currÃ­culos personalizados ou relatÃ³rios antigos.

## Fluxo

CurrÃ­culo â†’ extraÃ§Ã£o/OCR â†’ perfil â†’ filtros â†’ coleta â†’ deduplicaÃ§Ã£o â†’ compatibilidade â†’ currÃ­culo por vaga â†’ simulaÃ§Ã£o/envio â†’ tracker â†’ retry â†’ CSV/XLSX.

## Limites atuais

A preservaÃ§Ã£o de layout com alteraÃ§Ã£o de conteÃºdo estÃ¡ implementada de forma segura para DOCX. CurrÃ­culos PDF e formatos nÃ£o editÃ¡veis ainda sÃ£o preservados sem alteraÃ§Ã£o atÃ© existir uma estratÃ©gia genÃ©rica que nÃ£o destrua o design original. Novos sites devem entrar como adaptadores, preferindo API oficial e usando Playwright quando necessÃ¡rio.


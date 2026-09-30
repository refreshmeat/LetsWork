# Fila de correções do LetsWork

Regra de trabalho: novos pedidos entram no fim da fila. Um item iniciado só é considerado concluído depois de implementação, validação e regressão. Não interromper uma correção em andamento para começar outra.

## Concluído e validado

1. Pré-voo obrigatório de todas as vagas antes de qualquer POST real.
2. Suporte às variações atuais de formulário do RioVagas: PDF, currículo em texto, radio, textarea, campos raros e proteção contra schema obrigatório desconhecido.
3. Inferência automática de dados do currículo/perfil e reutilização de respostas equivalentes.
4. Cálculo de proximidade, distância, tempo de trajeto, conduções e estimativa de passagem.
5. Auditoria completa do lote de 511 vagas sem POST real.
6. Regressões permanentes para ranking, formulários, isolamento por candidato, dados de perfil e inventário de 30 dias.
7. Fluxo de dados faltantes: o runtime novo não gera NEEDS_DATA por pergunta comum. Fato pessoal realmente ausente vira PROFILE_REQUIRED, é pedido uma vez no perfil e reutilizado; formulário incoerente vira INVALID_FORM.
8. Nacionalidade padrão configurável como Brasileira quando não houver valor explícito. Valor informado pelo currículo/perfil prevalece. Naturalidade nunca é inferida a partir da residência.
9. Check, regressão, smoke e git diff --check aprovados após todos os ajustes.
10. Build Windows NSIS e portátil gerado e assinado com CN=LetsWork Local Code Signing. O portátil foi validado, substituiu o LetsWork.exe da área de trabalho e iniciou com a API local respondendo.

## Resultado de referência da auditoria

- 511 vagas originais.
- 379 compatíveis após ranking.
- 360 READY.
- 13 PROFILE_REQUIRED.
- 5 INVALID_FORM.
- 1 CLOSED.
- 0 NEEDS_DATA.
- 0 ERROR.
- Teste de conclusão de perfil: 13/13 PROFILE_REQUIRED passaram para READY com os fatos fornecidos apenas em memória, sem alterar o candidato real.

## Inventário

O RioVagas permanece como única fonte ativa nesta fase. O inventário local mantém janela móvel de até 30 dias: novas vagas entram nas sincronizações e vagas acima de 30 dias são removidas/desativadas conforme manutenção. O cache global é compartilhado; ranking, histórico e candidaturas permanecem isolados por candidato.

## Regra de segurança

- Nenhum lote real inicia antes do pré-voo.
- Campo obrigatório novo ou erro técnico bloqueia POST.
- PROFILE_REQUIRED representa somente fato pessoal que não pode ser inventado e é armazenado no perfil uma única vez.
- INVALID_FORM representa anúncio/formulário incoerente e nunca deve virar pergunta impossível ao candidato.
- NEEDS_DATA é mantido apenas para compatibilidade com históricos antigos e não deve ser gerado pelo fluxo novo.
- ERROR/UNCERTAIN inesperado durante envio aciona circuit breaker.
- SENT só é gravado quando existe confirmação positiva do provedor.

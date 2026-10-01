import fs from 'fs';
import path from 'path';
import { db } from '../src/db.mjs';
import { queryRioInventory, sourceRegistry } from '../src/services/inventory.mjs';
import { prefilterJobsForAI } from '../src/services/ranking.mjs';
import { rioLocation } from '../src/services/jobs.mjs';
import { knownAnswer, aiAnswers, canonicalFormQuestionKey, accessDestination } from '../src/apply/answers.mjs';
import { inferProfile, repairTextEncoding } from '../src/services/resume.mjs';
import { applyRioVagasDirect, parseRioFormHtml, invalidQuestionShape } from '../src/apply/rio.mjs';

function assert(condition,message){
  if(!condition)throw new Error(message);
}
function scalar(sql,...args){
  return Number(db.prepare(sql).get(...args)?.n||0);
}

const prereqInstallerText=fs.readFileSync(path.resolve('build/letswork-prereqs.ps1'),'utf8');
const nsisInstallerText=fs.readFileSync(path.resolve('build/installer.nsh'),'utf8');
assert(prereqInstallerText.includes("Join-Path $markerDir 'upgraded'")&&prereqInstallerText.includes('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES'),'Instalador voltou a abrir a interface do Ollama durante o provisionamento');
assert(prereqInstallerText.includes('Invoke-WithRetry')&&prereqInstallerText.includes('Test-OllamaModel'),'Provisionamento da IA perdeu retry ou validacao final do modelo');
assert(nsisInstallerText.includes('-WindowStyle Hidden')&&nsisInstallerText.includes('LetsWork-AI-Install.log'),'Instalador voltou a expor console do Ollama ou perdeu log de diagnostico');
assert(!nsisInstallerText.includes('isUpdated'),'Reinstalacao voltou a pular a validacao/reparo da IA local');

const sources=sourceRegistry();
const enabled=sources.filter(x=>Number(x.enabled)===1);
assert(enabled.length===1&&enabled[0].source_key==='rio','Somente RioVagas pode estar habilitado');
assert(enabled[0].apply_mode==='DIRECT_HTTP'&&Number(enabled[0].login_required)===0,'RioVagas deve ser DIRECT_HTTP e sem login');

const inventoryCount=scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1");
assert(inventoryCount>0,'Inventário RioVagas está vazio');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND url NOT LIKE '%riovagas.com.br/riovagas/%'")===0,'Inventário ativo contém URL que não é vaga direta RioVagas');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND datetime(published_at)<datetime('now','-30 days')")===0,'Há vaga ativa com mais de 30 dias');
assert(scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND (lower(location) LIKE '%benef%' OR lower(location) LIKE '%vale-transporte%' OR lower(location) LIKE '%horario%')")===0,'Local ativo ainda contém Benefícios/Vale-transporte/Horário');
assert(scalar("SELECT COUNT(*) n FROM (SELECT url,COUNT(*) c FROM job_inventory WHERE source='RioVagas' GROUP BY url HAVING c>1)")===0,'Há URL duplicada no inventário');

const counts={};
for(const days of [7,15,30]){
  counts[days]=scalar("SELECT COUNT(*) n FROM job_inventory WHERE source='RioVagas' AND active=1 AND datetime(published_at)>=datetime(?)",new Date(Date.now()-days*86400000).toISOString());
}
assert(counts[7]<=counts[15]&&counts[15]<=counts[30],'Janelas 7/15/30 estão inconsistentes');

const ftsHits=scalar("SELECT COUNT(*) n FROM job_inventory_fts WHERE job_inventory_fts MATCH 'auxiliar'");
assert(ftsHits>0,'FTS5 não retorna resultados esperados');
const ftsSample=queryRioInventory(30,['auxiliar'],100);
assert(ftsSample.length>0&&ftsSample.some(x=>Number.isFinite(x.ftsRank)),'Consulta BM25 não priorizou nenhuma vaga');

const applicationRunMismatch=scalar(`
  SELECT COUNT(*) n FROM applications a
  JOIN jobs j ON j.id=a.job_id
  WHERE a.run_id<>j.run_id
`);
assert(applicationRunMismatch===0,'Há candidatura ligada a job de outro run');

const runCandidateMismatch=scalar(`
  SELECT COUNT(*) n FROM runs r
  JOIN resumes x ON x.id=r.resume_id
  WHERE r.candidate_id<>x.candidate_id
`);
assert(runCandidateMismatch===0,'Há run ligado a currículo de outro candidato');

const matchOrphans=scalar(`
  SELECT COUNT(*) n FROM candidate_job_matches m
  LEFT JOIN candidates c ON c.id=m.candidate_id
  LEFT JOIN job_inventory i ON i.id=m.inventory_id
  WHERE c.id IS NULL OR i.id IS NULL
`);
assert(matchOrphans===0,'Há associação candidato-vaga órfã');

const jobInventoryOrphans=scalar(`
  SELECT COUNT(*) n FROM jobs j
  LEFT JOIN job_inventory i ON i.id=j.inventory_id
  WHERE j.inventory_id IS NOT NULL AND i.id IS NULL
`);
assert(jobInventoryOrphans===0,'Há job ligado a inventory_id inexistente');

const receiptCandidateMismatch=scalar(`
  SELECT COUNT(*) n
  FROM application_receipts x
  JOIN applications a ON a.id=x.application_id
  JOIN runs r ON r.id=a.run_id
  WHERE x.candidate_id<>r.candidate_id
`);
assert(receiptCandidateMismatch===0,'Há recibo ligado ao candidato errado');

const receiptJobMismatch=scalar(`
  SELECT COUNT(*) n
  FROM application_receipts x
  JOIN applications a ON a.id=x.application_id
  JOIN jobs j ON j.id=a.job_id
  WHERE x.inventory_id IS NOT NULL AND j.inventory_id IS NOT NULL AND x.inventory_id<>j.inventory_id
`);
assert(receiptJobMismatch===0,'Há recibo ligado à vaga errada');
const sentWithoutReceipt=scalar(`
  SELECT COUNT(*) n
  FROM applications a
  LEFT JOIN application_receipts x ON x.application_id=a.id
  WHERE a.status='SENT' AND x.id IS NULL
`);
assert(sentWithoutReceipt===0,'Há SENT sem recibo persistido');
const sentWithoutSuccessProof=scalar(`
  SELECT COUNT(*) n
  FROM applications a
  LEFT JOIN application_receipts x ON x.application_id=a.id AND x.confirmation_type='SUCCESS_TEXT'
  WHERE a.status='SENT' AND x.id IS NULL
`);
assert(sentWithoutSuccessProof===0,'Há SENT sem confirmação positiva SUCCESS_TEXT');
const staleUncertainVisual=scalar(`
  SELECT COUNT(*) n
  FROM jobs j
  JOIN runs r ON r.id=j.run_id
  JOIN candidate_job_history h
    ON h.candidate_id=r.candidate_id
   AND h.fingerprint=j.source_key
  WHERE h.status='UNCERTAIN'
    AND j.blocked_reason='ALREADY_SENT'
`);
assert(staleUncertainVisual===0,'Histórico UNCERTAIN ainda aparece como ALREADY_SENT');

assert(!fs.existsSync(path.resolve('src/apply/engine.mjs')),'Motor legado de navegador voltou ao projeto');
assert(!fs.existsSync(path.resolve('src/sources')),'Pasta de fontes legadas voltou ao projeto');
const packageText=fs.readFileSync(path.resolve('package.json'),'utf8');
assert(!packageText.includes('playwright-core'),'Playwright voltou às dependências');

for(const file of ['src/server.mjs','src/services/jobs.mjs','src/apply/rio.mjs']){
  const text=fs.readFileSync(path.resolve(file),'utf8');
  assert(!/from\s+['"]playwright-core['"]/.test(text),'Playwright voltou ao runtime ativo: '+file);
  assert(!/from\s+['"]\.\/sources\//.test(text),'Fonte legada voltou ao runtime ativo: '+file);
}


const locationProbe='Forma de Trabalho: Presencial Bairro: Barra da Tijuca Cidade: Rio de Janeiro Benefícios: Vale-transporte Vale-refeição Horário de Expediente: 09:00 às 18:00';
assert(rioLocation('Auxiliar de Escritório – Empresa – Barra da Tijuca',locationProbe)==='Barra da Tijuca - Rio de Janeiro','Local do RioVagas engoliu Benefícios ou Horário');
const indexText=fs.readFileSync(path.resolve('public/index.html'),'utf8');
const appText=fs.readFileSync(path.resolve('public/app.js'),'utf8');
assert(indexText.includes('class="contract-option"')&&indexText.includes('Tipo de vaga'),'Filtro de tipo de vaga deixou de exibir checkboxes claros');
assert(!indexText.includes('<div class="chip-group">'),'Filtro de contrato voltou ao formato ambíguo de chips');
assert(appText.includes('function displayJobLocation(job)'),'Proteção visual de localização foi removida');
assert(appText.includes('if(!searchFilters.contractTypes.length)'),'Busca voltou a aceitar zero tipos de vaga selecionados');
assert(appText.includes('function resetCandidateRunUi()'),'Troca de candidato deixou de limpar o estado visual imediatamente');
assert(appText.includes('const searchSelectionSeq=candidateSelectionSeq'),'Busca assíncrona deixou de capturar o candidato ativo');
assert(appText.includes('function isRunContextActive(')&&appText.includes('if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;'),'Polling pode voltar a pintar dados de outro candidato');
assert(appText.includes('function restoreCandidateInteractionState()')&&appText.includes('stopCandidateActivityTimers()'),'Troca de candidato pode voltar a herdar estado travado do lote anterior');
assert(appText.includes('function appConfirm(')&&!appText.includes('window.confirm('),'Confirmacao nativa do Electron voltou a bloquear os selects apos o fluxo real');
assert(appText.includes('const searchFilterDrafts=new Map()')&&appText.includes('restoreSearchFilterDraft(requestedCandidateId)'),'Filtros voltaram a vazar entre candidatos após um lote');
assert(appText.includes('rememberSearchFilterDraft(previousCandidateId)'),'Troca de candidato deixou de preservar um rascunho de filtro independente');
const desktopMainText=fs.readFileSync(path.resolve('desktop/main.cjs'),'utf8');
assert(desktopMainText.includes('app.disableHardwareAcceleration()'),'Protecao contra travamento de renderer/GPU foi removida');
const loadRunGuard=appText.indexOf("Number(status.candidateId)!==expectedId");
const loadRunMode=appText.indexOf("currentRunMode=status.mode==='live'?'live':'dry';",loadRunGuard);
const loadRunAssign=appText.indexOf("runId=requestedRunId",loadRunGuard);
assert(loadRunGuard>=0&&loadRunMode>loadRunGuard&&loadRunAssign>loadRunGuard,'loadRun voltou a assumir estado do lote antes de validar o candidato');

const syntheticDesignFilters={
  nationwide:false,state:'RJ',city:'Rio de Janeiro',cities:['Rio de Janeiro'],states:['RJ'],locationScope:'state_priority',
  area:'Design, UX/UI e Design Gráfico',workMode:'include_remote',pcdMode:'exclude',experienceLevel:'entry',recencyDays:30,
  contractTypes:['CLT','PJ','ESTAGIO','TEMPORARIO','APRENDIZ','FREELANCE'],
  searchFamilies:['Design','UX/UI','UI'],searchCoreTerms:['designer gráfico','ux','ui'],
  searchAdjacentTerms:['marketing digital','criação visual'],searchLiteralTerms:['figma','photoshop','canva'],
  searchTargetTerms:['designer gráfico','ux','ui','criação visual']
};
const syntheticDesignProfile={rawText:'Bacharelado em Design em andamento. Figma Photoshop Canva UX UI.',skills:['Figma','Photoshop','Canva','UX','UI','Design']};
const syntheticJobs=[
  {source:'RioVagas',title:'Designer Gráfico Júnior',description:'Criação de peças visuais, Figma, Photoshop e materiais digitais.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/design-grafico-junior',publishedAt:new Date().toISOString(),contractType:'CLT'},
  {source:'RioVagas',title:'Assistente de Projetos - Móveis Planejados',description:'Atendimento ao cliente, projeto de móveis planejados e Promob. Ambiente de design.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/moveis-planejados',publishedAt:new Date().toISOString(),contractType:'CLT'},
  {source:'RioVagas',title:'Ajudante de Marcenaria',description:'Apoio à produção de mobiliário e peças de design.',location:'Rio de Janeiro - RJ',url:'https://riovagas.com.br/riovagas/ajudante-marcenaria',publishedAt:new Date().toISOString(),contractType:'CLT'}
];
const syntheticRanked=prefilterJobsForAI(syntheticJobs,syntheticDesignProfile,syntheticDesignFilters);
assert(syntheticRanked.some(x=>/Designer Gráfico Júnior/i.test(x.title)),'Vaga válida de Design foi rejeitada pela regressão sintética');
assert(!syntheticRanked.some(x=>/Marcenaria|Móveis Planejados/i.test(x.title)),'Domínio de marcenaria/móveis vazou para perfil de Design');

const syntheticMaria={
  address:'Rua Virginia Vidal 148',neighborhood:'Tanque',residenceCity:'Rio de Janeiro',residenceState:'RJ',
  rawText:'ENSINO MÉDIO\nCompleto - Colégio Estadual Bangu\nIDIOMAS\nInglês Básico\nEspanhol Básico\nEXPERIÊNCIA\nAtendimento presencial e remoto.'
};
const mariaPrefs={city:'Rio de Janeiro',state:'RJ'};
assert(/Ensino Médio/i.test(String(knownAnswer('Qual a sua escolaridade ?',syntheticMaria,mariaPrefs)||'')),'Escolaridade conhecida deixou de ser reconhecida');
assert(/Tanque|Rio de Janeiro/i.test(String(knownAnswer('Em qual cidade e bairro você reside?',syntheticMaria,mariaPrefs)||'')),'Cidade/bairro conhecidos deixaram de ser reconhecidos');
const languageAnswers=await aiAnswers([{id:'1',question:'Tem Inglês intermediário',options:['Sim','Não']}],syntheticMaria,mariaPrefs,null);
assert(languageAnswers.get('1')==='Não','Nível de idioma inferior ao exigido não foi respondido com segurança');
const repairedEncoding=repairTextEncoding('FORMAÃ‡ÃƒO ACADÃŠMICA\\nEXPERIÃŠNCIA PROFISSIONAL\\nHABILIDADES PRINCIPAIS\\nQUALIFICAÃ‡Ã•ES E CURSOS COMPLEMENTARES');
assert(/FORMAÇÃO ACADÊMICA/.test(repairedEncoding),'Normalizador global não reparou Formação Acadêmica');
assert(/EXPERIÊNCIA PROFISSIONAL/.test(repairedEncoding),'Normalizador global não reparou Experiência Profissional');
assert(/QUALIFICAÇÕES E CURSOS COMPLEMENTARES/.test(repairedEncoding),'Normalizador global não reparou Qualificações/Cursos');
const syntheticContactProfile=inferProfile('CRISTIANO TESTE\n( 21) 99042 â€“ 8876\ncristiano@example.com\nRio de Janeiro, RJ, Brasil');
assert(syntheticContactProfile.phone==='(21) 99042-8876','Telefone com travessão/pontuação não foi normalizado');
assert(syntheticContactProfile.email==='cristiano@example.com','E-mail sintético deixou de ser extraído');
const contactProbe=path.resolve('tmp-contact-preflight.pdf');
fs.writeFileSync(contactProbe,'fake-pdf');
const missingContact=await applyRioVagasDirect({title:'Teste',url:'https://invalid.local/never-called'},contactProbe,{name:'Teste',email:'teste@example.com',phone:''},{},{dryRun:true});
fs.rmSync(contactProbe,{force:true});
assert(missingContact.status==='ERROR'&&/celular ausente/i.test(missingContact.error||''),'Dry-run voltou a ignorar contato obrigatório');

const inferredContactProfile=inferProfile('CRISTIANO TESTE\n33 ANOS\nRUA ALBANO, 194, CASA 3 - PRAÇA SECA\nRIO DE JANEIRO, RJ, BRASIL\n( 21) 99042 – 8876\ncristiano@example.com');
assert(inferredContactProfile.phone==='(21) 99042-8876','Telefone com travessão/pontuação não foi normalizado');
assert(inferredContactProfile.age==='33','Idade explícita do currículo deixou de ser extraída');
assert(/PRAÇA SECA/i.test(inferredContactProfile.neighborhood),'Bairro no final do endereço deixou de ser extraído');
assert(inferredContactProfile.nationality==='Brasileira','Nacionalidade padrão brasileira deixou de ser aplicada');
assert(!String(inferredContactProfile.naturality||'').trim(),'Naturalidade foi inferida indevidamente a partir da residência');
const syntheticLiviaProfile=inferProfile('LÍVIA SANTIAGO MESSNER\nContato: (21) 996640-7024 | livia@example.com\nEndereço: Barra de Guaratiba, Rio de Janeiro – RJ Habilitação: B\nPerfil: linkedin.com/in/livia\nRESUMO PROFISSIONAL\nProfissional graduada em Gestão Hospitalar.\nEXPERIÊNCIA PROFISSIONAL\nDETRAN - RJ\nAuxiliar Administrativo | 07/2013 – 03/2014');
assert(syntheticLiviaProfile.phone==='(21) 996640-7024','WhatsApp/telefone da Lívia deixou de ser extraído');
assert(syntheticLiviaProfile.neighborhood==='Barra de Guaratiba','Bairro da Lívia foi contaminado por estado/CNH');
assert(syntheticLiviaProfile.residenceCity==='Rio de Janeiro','Cidade da Lívia foi contaminada por experiência profissional');
assert(syntheticLiviaProfile.residenceState==='RJ','Estado da Lívia deixou de ser extraído');
assert(syntheticLiviaProfile.cnhCategory==='B','CNH da Lívia deixou de ser separada do endereço');
const explicitForeign=inferProfile('CANDIDATO TESTE\nNacionalidade: Portuguesa\nNaturalidade: Lisboa\nRio de Janeiro, RJ, Brasil');
assert(explicitForeign.nationality==='Portuguesa','Nacionalidade explícita deixou de prevalecer sobre o padrão');
assert(explicitForeign.naturality==='Lisboa','Naturalidade explícita deixou de ser preservada');
assert(canonicalFormQuestionKey('Qual bairro você mora?')===canonicalFormQuestionKey('Lugar que reside?'),'Variações de pergunta de bairro não foram agrupadas');
assert(canonicalFormQuestionKey('Possui fácil acesso à Zona Sul?')!==canonicalFormQuestionKey('Reside próximo a Zona Sul?'),'Acesso fácil e proximidade voltaram a ser tratados como a mesma coisa');
assert(canonicalFormQuestionKey('Quanto tempo leva até a Barra da Tijuca?')!==canonicalFormQuestionKey('Mora próximo à Barra da Tijuca?'),'Tempo de trajeto e proximidade voltaram a compartilhar resposta');
assert(accessDestination('Quanto tempo leva aproximadamente no trajeto até a Barra da Tijuca?')==='Barra da Tijuca','Destino da pergunta de trajeto deixou de ser isolado');
assert(accessDestination('Mora próximo ao Centro do Rio?')==='Centro','Destino Centro deixou de ser isolado');
const semanticSaved={...inferredContactProfile,formAnswers:{'Possui fácil acesso à Zona Sul?':'Sim'}};
assert(knownAnswer('Possui facil acesso a Zona Sul?',semanticSaved,{})==='Sim','Resposta confirmada equivalente de acesso não foi reaproveitada');
assert(knownAnswer('Reside próximo a Zona Sul?',semanticSaved,{})!== 'Sim','Resposta de acesso vazou indevidamente para pergunta de proximidade');

const reusableFacts={...inferredContactProfile,cnhCategory:'AB',uniformSize:'G',shoeSize:'40',transitCard:'RioCard e Jaé',schoolProof:'Certificado'};
assert(knownAnswer('Você possui CNH categoria B válida?',reusableFacts,{})==='Sim','CNH confirmada no perfil não foi reutilizada');
assert(/Uniforme\/roupa: G; calçado: 40/i.test(String(knownAnswer('INFORMAR NUMERO DO UNIFORME E TAMANHO DO CALÇADO',reusableFacts,{})||'')),'Tamanho de uniforme/calçado não foi reutilizado');
assert(/RioCard e Jaé/i.test(String(knownAnswer('possui rio card e jae',reusableFacts,{})||'')),'Cartão de transporte confirmado não foi reutilizado');
assert(knownAnswer('Você possui comprovante de escolaridade?',reusableFacts,{})==='Sim','Comprovante escolar confirmado não foi reutilizado');
assert(canonicalFormQuestionKey('Faz uso de medicação? Se sim, qual?')==='medication','Pergunta de medicação deixou de ser agrupada');
assert(canonicalFormQuestionKey('Possui alguma doença pré-existente? Se sim, qual?')==='health_condition','Pergunta de saúde deixou de ser agrupada');

const syntheticRioAttachmentForm=`
<input name="s" required value="">
<form method="post">
  <input type="hidden" name="candidato_vaga_nonce_field" value="nonce123">
  <input type="hidden" name="_wp_http_referer" value="/enviar-curriculo-gratis/?vaga=77">
  <input type="hidden" name="post_id" value="77">
  <input type="text" name="nome_candidato">
  <input type="email" name="email_candidato">
  <input type="text" name="celular_candidato">
  <input type="radio" name="forma_envio" value="anexo">
  <input type="file" name="anexo">
  <input type="hidden" name="perguntas[0]" value="Possui experiência?">
  <input type="radio" name="respostas[0]" value="Sim" required>
  <input type="radio" name="respostas[0]" value="Não" required>
  <input type="checkbox" name="ciente" required>
</form>`;
const parsedAttachment=parseRioFormHtml(syntheticRioAttachmentForm,'https://riovagas.com.br/enviar-curriculo-gratis/?vaga=77');
assert(parsedAttachment.schema.hasAttachment===true&&parsedAttachment.schema.hasTextResume===false,'Formulário com anexo não foi reconhecido');
assert(parsedAttachment.questions[0]?.options?.length===2,'Opções de radio do RioVagas deixaram de ser lidas');
assert(!parsedAttachment.schema.unsupportedRequired.includes('s'),'Campo de busca externo vazou para o formulário da candidatura');

const syntheticRioTextForm=`
<form method="post">
  <input type="hidden" name="candidato_vaga_nonce_field" value="nonce456">
  <input type="hidden" name="post_id" value="88">
  <input type="radio" name="forma_envio" value="texto">
  <textarea name="curriculo_candidato"></textarea>
  <input type="hidden" name="perguntas[2]" value="Em qual bairro você mora?">
  <textarea name="respostas[2]" required></textarea>
  <input type="checkbox" name="ciente" required>
</form>`;
const parsedText=parseRioFormHtml(syntheticRioTextForm,'https://riovagas.com.br/enviar-curriculo-gratis/?vaga=88');
assert(parsedText.schema.hasAttachment===false&&parsedText.schema.hasTextResume===true,'Formulário de currículo em texto não foi reconhecido');
assert(parsedText.questions[0]?.controlTypes?.includes('textarea'),'Resposta em textarea deixou de ser reconhecida');

const malformedAge={question:'Qual sua idade?',options:['Sim','Não']};
assert(/dado textual/i.test(invalidQuestionShape(malformedAge)),'Formulário de idade com Sim/Não deixou de ser marcado inválido');
const malformedNeighborhood={question:'Em qual bairro reside?',options:['Sim','Não']};
assert(/dado textual/i.test(invalidQuestionShape(malformedNeighborhood)),'Formulário de bairro com Sim/Não deixou de ser marcado inválido');
assert(!invalidQuestionShape({question:'Possui CNH categoria B?',options:['Sim','Não']}),'Pergunta válida de CNH foi marcada como formulário inválido');

const syntheticRioUnknownRequired=`
<form>
  <input type="hidden" name="candidato_vaga_nonce_field" value="n">
  <input type="hidden" name="post_id" value="99">
  <input type="text" name="campo_novo_do_rio" required>
  <input type="checkbox" name="ciente" required>
</form>`;
const parsedUnknown=parseRioFormHtml(syntheticRioUnknownRequired,'https://riovagas.com.br/enviar-curriculo-gratis/?vaga=99');
assert(parsedUnknown.schema.unsupportedRequired.includes('campo_novo_do_rio'),'Campo obrigatório novo deixou de acionar proteção de schema');

const serverRuntimeText=fs.readFileSync(path.resolve('src/server.mjs'),'utf8');
assert(serverRuntimeText.includes('PREFLIGHTING')&&serverRuntimeText.includes('ERROR_PREFLIGHT'),'Pré-voo obrigatório saiu do pipeline real');
assert(serverRuntimeText.includes('CIRCUIT_BREAKER')&&serverRuntimeText.includes('ERROR_DISPATCH_PAUSED'),'Circuit breaker do envio real saiu do pipeline');
assert(serverRuntimeText.includes('checkRioVagasHealth')&&serverRuntimeText.includes('ERROR_SOURCE_UNAVAILABLE'),'Proteção contra indisponibilidade do RioVagas saiu do pipeline');


const jobsRuntimeText=fs.readFileSync(path.resolve('src/services/jobs.mjs'),'utf8');
assert(jobsRuntimeText.includes('before:snapshotBefore'),'Reconciliação RioVagas deixou de congelar o snapshot temporal');
assert(jobsRuntimeText.includes('seenIds.size===expectedTotal'),'Reconciliação completa deixou de validar todos os IDs esperados');
assert(jobsRuntimeText.includes("fullSnapshot=!incremental&&rows._syncComplete===true"),'Limpeza destrutiva voltou a aceitar snapshot incompleto');
const serverStartupText=fs.readFileSync(path.resolve('src/server.mjs'),'utf8');
assert(serverStartupText.includes("syncRioVagasInventory({full:true,force:true})"),'Abertura do LetsWork deixou de forçar reconciliação completa');
assert(serverStartupText.includes('await startRioStartupSync()'),'Busca voltou a poder começar antes da sincronização inicial');
assert(serverStartupText.includes('setInterval(runRioInventoryMaintenance,60*60*1000)'),'Manutenção periódica do inventário deixou de existir');

console.log(JSON.stringify({
  ok:true,
  source:enabled[0].name,
  inventoryCount,
  windows:counts,
  ftsHits,
  applicationRunMismatch,
  runCandidateMismatch,
  matchOrphans,
  jobInventoryOrphans,
  receiptCandidateMismatch,
  receiptJobMismatch
}));

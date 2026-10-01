let candidateId=null;
let resumeId=null;
let runId=null;
let currentCandidate=null;
let currentJobs=[];
let candidates=[];
let pollTimer=null;
let selectedFiles=[];
let searchElapsedTimer=null;
let searchReviewTimer=null;
let pendingQuestions=[];
let selectedJobIds=new Set();
let manuallyDeselectedJobIds=new Set();
let selectionSaveTimer=null;
let currentStatuses=new Map();
let currentRunMode='dry';
let uploadInFlight=false;
let candidateSelectionSeq=0;

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const splitList=s=>String(s||'').split(/[,;]/).map(x=>x.trim()).filter(Boolean);
const dateBR=value=>value?new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'';
const sizeText=n=>n>1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;

const SEARCH_FILTER_IDS=['state','city','locationScope','area','workMode','pcdMode','experienceLevel','recencyDays','clt','pj','internship','temporary','apprentice','freelance','salaryExpectation','submitMode','availability','salaryFromJob'];
const searchFilterDrafts=new Map();

function defaultSearchFilterState(){
  return {
    state:'RJ',city:'Rio de Janeiro',locationScope:'state_priority',area:'',
    workMode:'include_remote',pcdMode:'exclude',experienceLevel:'entry',recencyDays:'15',
    clt:true,pj:true,internship:true,temporary:true,apprentice:true,freelance:true,
    salaryExpectation:'A combinar',submitMode:'dry',availability:false,salaryFromJob:true
  };
}
function readSearchFilterState(){
  const state={};
  for(const id of SEARCH_FILTER_IDS){
    const el=$(id); if(!el)continue;
    state[id]=el.type==='checkbox'?Boolean(el.checked):String(el.value??'');
  }
  return state;
}
function writeSearchFilterState(state=defaultSearchFilterState()){
  const next={...defaultSearchFilterState(),...(state||{})};
  for(const id of SEARCH_FILTER_IDS){
    const el=$(id); if(!el)continue;
    if(el.type==='checkbox')el.checked=Boolean(next[id]);
    else el.value=String(next[id]??'');
  }
  syncSubmitModeHint();
  syncFilterInteractivity();
}
function rememberSearchFilterDraft(id=candidateId){
  const key=Number(id);
  if(key>0)searchFilterDrafts.set(key,readSearchFilterState());
}
function restoreSearchFilterDraft(id){
  const key=Number(id);
  writeSearchFilterState(searchFilterDrafts.get(key)||defaultSearchFilterState());
}


function toast(text){
  const el=$('sessionStatus');
  el.textContent=text; el.classList.remove('hidden');
  clearTimeout(el._timer); el._timer=setTimeout(()=>el.classList.add('hidden'),5000);
}
function notice(id,text){
  const el=$(id); el.textContent=text||'';
  el.classList.toggle('hidden',!text);
}
function activateTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.add('hidden'));
  $(`tab-${name}`).classList.remove('hidden');
  if(name==='reports') loadReports();
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>activateTab(b.dataset.tab)));
async function loadSystemStatus(){
  try{
    const r=await fetch('/api/system/status'),d=await r.json();
    const inv=d.inventory||{},rio=inv.rio||{},jobbol=inv.jobbol||{};
    const active=Number(rio.active||0)+Number(jobbol.active||0);
    const latest=[rio.last_sync_at,jobbol.last_sync_at].filter(Boolean).sort().at(-1),last=latest?dateBR(latest):'';
    if($('inventoryLabel'))$('inventoryLabel').textContent=`RioVagas + Jobbol · ${active.toLocaleString('pt-BR')} vagas`;
    if($('inventoryMeta'))$('inventoryMeta').textContent=`até 30 dias${last?` · atualizado ${last}`:''}`;
  }catch{
    if($('inventoryMeta'))$('inventoryMeta').textContent='Inventário local indisponível';
  }
}

async function loadAI(){
  try{
    const r=await fetch('/api/ai/status'),d=await r.json();
    const local=d.engine==='ollama'||d.provider==='ollama';
    const ready=Boolean(d.online)&&(d.modelReady!==false);
    $('aiDot').className=`dot ${ready?'online':'offline'}`;
    if(local){
      $('aiLabel').textContent=ready?'Llama local conectado':(d.online?'Preparando Llama local':'Llama local indisponível');
      $('aiModel').textContent=`${d.model||'Llama'} • local`;
    }else{
      $('aiLabel').textContent=d.online?'Llama local conectado':'Llama local indisponível';
      $('aiModel').textContent=d.online?`${d.model||'GPT'} • ${d.level||''}`:(d.model||'GPT');
    }
  }catch{
    $('aiDot').className='dot offline'; $('aiLabel').textContent='IA local indisponível';
  }
}

$('backupImportBtn')?.addEventListener('click',()=>$('backupFile')?.click());
$('backupFile')?.addEventListener('change',async()=>{
  const file=$('backupFile').files?.[0];if(!file)return;
  if(!window.confirm('Importar este backup? O LetsWork validará o arquivo e aplicará a restauração na próxima inicialização.')){$('backupFile').value='';return;}
  const btn=$('backupImportBtn');btn.disabled=true;btn.textContent='Validando backup...';
  try{
    const fd=new FormData();fd.append('backup',file);
    const r=await fetch('/api/backup/import',{method:'POST',body:fd});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Falha ao importar backup');
    toast(`Backup validado: ${d.summary?.candidateCount||0} candidato(s). Feche e abra o LetsWork para restaurar.`);
  }catch(e){toast('Erro no backup: '+(e.message||e));}
  finally{btn.disabled=false;btn.textContent='Importar backup';$('backupFile').value='';}
});

function renderCandidates(){
  $('candidateList').innerHTML=candidates.length?candidates.map(c=>`
    <button class="candidate-item ${c.id===candidateId?'active':''}" data-id="${c.id}" type="button">
      <div><strong>${esc(c.name)}</strong><span>${c.sent||0} enviadas · ${c.runs||0} buscas</span></div>
    </button>`).join(''):'<div class="empty-list">Nenhum candidato salvo.</div>';
  document.querySelectorAll('.candidate-item').forEach(b=>b.addEventListener('click',()=>selectCandidate(Number(b.dataset.id))));
}

async function loadCandidates(selectNewest=false){
  const r=await fetch('/api/candidates');
  candidates=await r.json(); renderCandidates();
  if(selectNewest&&candidates.length) await selectCandidate(candidates[0].id);
}

function renderSelectedFiles(){
  const box=$('fileSelection');
  box.innerHTML=selectedFiles.map((f,i)=>`<div class="file-chip"><span>${esc(f.name)}</span><button type="button" class="file-remove" data-index="${i}" aria-label="Remover ${esc(f.name)}">×</button></div>`).join('');
  box.querySelectorAll('.file-remove').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();selectedFiles.splice(Number(b.dataset.index),1);renderSelectedFiles();}));
  $('primaryFileWrap').classList.toggle('hidden',selectedFiles.length<2);
  const previous=Number($('primaryFileSelect').value||0);
  $('primaryFileSelect').innerHTML=selectedFiles.map((f,i)=>`<option value="${i}">${esc(f.name)}</option>`).join('');
  if(selectedFiles.length) $('primaryFileSelect').value=String(Math.min(previous,selectedFiles.length-1));
  const likely=selectedFiles.findIndex(f=>{const n=String(f.name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();return /(^|[_ -])(cv|curriculo|curriculum|resume)([_ .-]|$)/.test(n)&&!/portfolio/.test(n);});
  if(likely>=0) $('primaryFileSelect').value=String(likely);
}
function showNewCandidate(openPicker=false){
  if(Number(candidateId)>0)rememberSearchFilterDraft(candidateId);
  candidateId=resumeId=runId=null; currentCandidate=null; currentJobs=[]; selectedFiles=[]; if(searchReviewTimer){clearInterval(searchReviewTimer);searchReviewTimer=null;}
  $('state').value='RJ'; $('city').value='Rio de Janeiro'; $('locationScope').value='state_priority'; $('area').value='';
  $('workMode').value='include_remote'; $('pcdMode').value='exclude'; $('experienceLevel').value='entry'; $('recencyDays').value='15';
  for(const id of ['clt','pj','internship','temporary','apprentice','freelance']) $(id).checked=true;
  $('salaryExpectation').value='A combinar'; $('submitMode').value='dry'; syncSubmitModeHint(); $('availability').checked=false; $('salaryFromJob').checked=true; syncFilterInteractivity();
  $('resumeFile').value=''; renderSelectedFiles(); notice('uploadStatus','');
  $('newCandidateView').classList.remove('hidden'); $('candidateView').classList.add('hidden');
  $('candidateActions').classList.add('hidden'); $('pageTitle').textContent='Novo candidato';
  $('pageSubtitle').textContent='Importe um currículo para começar.'; renderCandidates();
  $('newCandidateView').scrollIntoView({behavior:'smooth',block:'start'});
  if(openPicker) setTimeout(()=>$('resumeFile').click(),60);
}
$('newCandidateBtn').addEventListener('click',()=>showNewCandidate(true));
$('resumeFile').addEventListener('change',()=>{
  for(const f of [...$('resumeFile').files]) if(!selectedFiles.some(x=>x.name===f.name&&x.size===f.size&&x.lastModified===f.lastModified)) selectedFiles.push(f);
  $('resumeFile').value=''; renderSelectedFiles();
});
$('uploadForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(uploadInFlight)return;
  const files=[...selectedFiles];
  if(!files.length){notice('uploadStatus','Selecione pelo menos um arquivo para importar.');return;}
  uploadInFlight=true;
  const importBtn=$('importCandidateBtn');
  if(importBtn){importBtn.disabled=true;importBtn.textContent='Importando...';}
  $('resumeFile').disabled=true;
  notice('uploadStatus','Lendo arquivos e montando o cadastro. OCR pode levar alguns instantes...');
  const fd=new FormData();
  files.forEach(file=>fd.append('files',file));
  fd.append('primaryIndex',$('primaryFileSelect').value||'0');
  try{
    const r=await fetch('/api/candidate/import',{method:'POST',body:fd});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Falha ao importar currículo');
    candidateId=d.candidateId; resumeId=d.resumeId;
    selectedFiles=[]; $('resumeFile').value=''; renderSelectedFiles();
    await loadCandidates();
    await selectCandidate(candidateId,{tab:'profile'});
    if(d.deduplicated)toast('Esse mesmo cadastro já existia. A cópia duplicada foi ignorada.');
    if(!currentCandidate?.resume?.base_resume_path){
      $('optimizeBaseResume')?.click();
    }
  }catch(err){
    notice('uploadStatus',`Erro: ${err.message||err}`);
  }finally{
    uploadInFlight=false;
    $('resumeFile').disabled=false;
    if(importBtn){importBtn.disabled=false;importBtn.textContent='Importar arquivos';}
  }
});

function renderDocuments(documents=[]){
  const box=$('documentsList');
  const kindLabel={resume:'Currículo principal',portfolio:'Portfólio',certificate:'Certificado',support:'Documento de apoio'};
  box.innerHTML=documents.length?documents.map(d=>`<div class="document-row"><div><strong>${esc(d.original_name)}</strong><span>${esc(kindLabel[d.kind]||'Documento')}${d.is_primary?' · principal':''}</span></div><button class="ghost danger-text document-delete" type="button" data-id="${d.id}" data-primary="${d.is_primary?1:0}">Excluir</button></div>`).join(''):'<div class="empty-list">Nenhum arquivo salvo.</div>';
  box.querySelectorAll('.document-delete').forEach(b=>b.addEventListener('click',async()=>{
    const primary=b.dataset.primary==='1';
    const msg=primary?'Excluir o currículo principal? Se houver outro arquivo, ele vira o principal. Se não houver, será preciso criar outro cadastro para pesquisar vagas.':'Excluir este arquivo do candidato?';
    if(!window.confirm(msg)) return;
    const r=await fetch(`/api/candidate/${candidateId}/document/${b.dataset.id}`,{method:'DELETE'}),d=await r.json().catch(()=>({}));
    if(!r.ok) return toast(`Erro: ${d.error||'não foi possível excluir o arquivo'}`);
    toast('Arquivo excluído.'); await selectCandidate(candidateId); activateTab('profile');
  }));
}

function renderBaseResume(resume={}){
  const focus=$('baseResumeFocus'),template=$('baseResumeTemplate'),link=$('baseResumeDownload');
  if(focus)focus.value=resume?.base_resume_focus||$('area')?.value||'';
  if(template)template.value=['executive','classic','compact'].includes(String(resume?.base_resume_template||''))?resume.base_resume_template:'executive';
  if(link){
    const ready=Boolean(resume?.base_resume_path);
    link.classList.toggle('hidden',!ready);
    link.href=ready&&resumeId?`/api/resume/${resumeId}/base-file`:'#';
  }
  if(resume?.base_resume_path){const label={executive:'Executivo',classic:'Clássico',compact:'Compacto'}[resume?.base_resume_template||'executive']||'Executivo';notice('baseResumeStatus',`Currículo-base pronto${resume.base_resume_focus?` para ${resume.base_resume_focus}`:''} · modelo ${label}. Os envios reutilizam este arquivo sem reescrever por vaga.`);}
  else notice('baseResumeStatus','Ainda não há currículo-base otimizado. Até gerar um, os envios usarão o currículo original.');
}

function fillProfile(p={}){
  $('pName').value=p.name||''; $('pEmail').value=p.email||''; $('pPhone').value=p.phone||'';
  $('pLinkedin').value=p.linkedin||''; $('pPortfolio').value=p.portfolio||''; $('pInstagram').value=p.instagram||'';
  $('pPcd').value=p.pcd===true?'yes':p.pcd===false?'no':''; $('pCpf').value=p.cpf||''; $('pBirthDate').value=p.birthDate||''; $('pCep').value=p.cep||'';
  $('pAddress').value=p.address||''; $('pNeighborhood').value=p.neighborhood||'';
  $('pAdditionalFacts').value=p.additionalFacts||'';
}

async function loadPendingData(expectedCandidateId=candidateId,selectionSeq=candidateSelectionSeq){
  const targetCandidateId=Number(expectedCandidateId);
  const panel=$('pendingDataPanel'); if(!panel)return;
  if(!targetCandidateId){panel.classList.add('hidden');return;}
  const r=await fetch(`/api/candidate/${targetCandidateId}/pending-data`);
  if(selectionSeq!==candidateSelectionSeq||Number(candidateId)!==targetCandidateId)return;
  if(!r.ok){panel.classList.add('hidden');return;}
  const d=await r.json();
  if(selectionSeq!==candidateSelectionSeq||Number(candidateId)!==targetCandidateId)return;
  pendingQuestions=Array.isArray(d.custom)?d.custom:[];
  if(!d.total){panel.classList.add('hidden');$('pendingDataList').innerHTML='';return;}
  panel.classList.remove('hidden');
  const parts=[];
  for(const f of Array.isArray(d.requiredFields)?d.requiredFields:[]){
    const count=f.jobs?.length||f.questions?.length||1;
    const placeholder={
      cnhCategory:'Ex.: Não possuo, B, AB, D',
      uniformSize:'Ex.: M, G, 42',
      shoeSize:'Ex.: 39, 40, 41',
      transitCard:'Ex.: Jaé, RioCard, ambos ou não possuo',
      schoolProof:'Ex.: certificado, histórico, diploma ou não possuo',
      birthDate:'DD/MM/AAAA'
    }[f.field]||'Dado confirmado do candidato';
    parts.push(`<label class="span-2">${esc(f.label)}<input data-pending-field="${esc(f.field)}" value="${esc(f.value||'')}" placeholder="${esc(placeholder)}"><span class="sub">Preencha uma vez. Resolve ${count} candidatura(s).</span></label>`);
  }
  pendingQuestions.forEach((x,idx)=>{
    parts.push(`<label class="span-2">${esc(x.question)}<input data-pending-index="${idx}" value="${esc(x.answer||'')}" placeholder="Resposta confirmada do candidato"></label>`);
  });
  if(!parts.length)parts.push('<div class="span-2"><strong>Dados já preenchidos</strong><div class="sub">As pendências existentes já têm dados suficientes. Use "Refazer erros e pendências" para continuar.</div></div>');
  $('pendingDataList').innerHTML=parts.join('');
  $('pendingDataMeta').textContent=`${d.total} candidatura(s) aguardando dado. ${d.readyToRetry||0} já podem ser retentadas com os dados atuais.`;
}

async function savePendingData(){
  if(!candidateId)return;
  const answers={};
  document.querySelectorAll('[data-pending-index]').forEach(el=>{
    const idx=Number(el.dataset.pendingIndex),q=pendingQuestions[idx]?.question,v=el.value.trim();
    if(q&&v)answers[q]=v;
  });
  const fields={};
  document.querySelectorAll('[data-pending-field]').forEach(el=>{
    const key=String(el.dataset.pendingField||'').trim(),value=el.value.trim();
    if(key&&value)fields[key]=value;
  });
  Object.assign(fields,{
    cpf:$('pCpf').value.trim(),cep:$('pCep').value.trim(),birthDate:$('pBirthDate').value.trim()||fields.birthDate||'',
    address:$('pAddress').value.trim(),neighborhood:$('pNeighborhood').value.trim(),
    linkedin:$('pLinkedin').value.trim(),instagram:$('pInstagram').value.trim(),portfolio:$('pPortfolio').value.trim()
  });
  const r=await fetch(`/api/candidate/${candidateId}/pending-data`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({answers,fields})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){notice('pendingDataStatus',`Erro: ${d.error||'não foi possível salvar'}`);return;}
  if(d.profile)fillProfile(d.profile);
  notice('pendingDataStatus','Respostas pendentes salvas.');
  await loadPendingData();
}


function stopCandidateActivityTimers(){
  if(searchElapsedTimer){clearInterval(searchElapsedTimer);searchElapsedTimer=null;}
  if(searchReviewTimer){clearInterval(searchReviewTimer);searchReviewTimer=null;}
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  if(selectionSaveTimer){clearTimeout(selectionSaveTimer);selectionSaveTimer=null;}
}

function isRunContextActive(targetRun,targetCandidate,selectionSeq){
  return selectionSeq===candidateSelectionSeq
    && Number(candidateId)===Number(targetCandidate)
    && Number(runId)===Number(targetRun);
}

function restoreCandidateInteractionState(){
  syncFilterInteractivity();
  const panel=$('tab-search');
  if(panel){
    panel.inert=false;
    panel.removeAttribute('inert');
    panel.removeAttribute('aria-disabled');
    panel.style.pointerEvents='auto';
  }
  document.querySelectorAll('#tab-search fieldset').forEach(fieldset=>{
    fieldset.disabled=false;
    fieldset.inert=false;
    fieldset.removeAttribute('inert');
    fieldset.removeAttribute('aria-disabled');
    fieldset.style.pointerEvents='auto';
  });
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.disabled=false;
    tab.removeAttribute('aria-disabled');
    tab.style.pointerEvents='auto';
  });
  if($('searchBtn'))$('searchBtn').disabled=false;
}

function resetCandidateRunUi(){
  runId=null;
  currentJobs=[];
  currentStatuses=new Map();
  selectedJobIds.clear();
  manuallyDeselectedJobIds.clear();
  $('resultsCard')?.classList.add('hidden');
  if($('jobsBody'))$('jobsBody').innerHTML='';
  if($('resultMeta'))$('resultMeta').textContent='';
  if($('selectionMeta'))$('selectionMeta').textContent='';
  if($('batchSelect')){$('batchSelect').classList.add('hidden');$('batchSelect').innerHTML='';}
  if($('runSummary')){$('runSummary').classList.add('hidden');$('runSummary').innerHTML='';}
  if($('runProgress'))$('runProgress').classList.add('hidden');
  if($('uncertainWarning'))$('uncertainWarning').classList.add('hidden');
  if($('jobStatusFilter'))$('jobStatusFilter').value='all';
  if($('selectAllJobs')){$('selectAllJobs').checked=false;$('selectAllJobs').indeterminate=false;$('selectAllJobs').disabled=true;}
  if($('applyBtn'))$('applyBtn').disabled=true;
  if($('retryBtn'))$('retryBtn').disabled=true;
  if($('statJobs'))$('statJobs').textContent='0';
  if($('statStatus'))$('statStatus').textContent='Carregando';
  notice('searchStatus','');
  notice('applyStatus','');
}

async function selectCandidate(id,options={}){
  const previousCandidateId=Number(candidateId);
  if(previousCandidateId>0)rememberSearchFilterDraft(previousCandidateId);
  const selectionSeq=++candidateSelectionSeq;
  const requestedCandidateId=Number(id);
  stopCandidateActivityTimers();
  resetCandidateRunUi();
  restoreSearchFilterDraft(requestedCandidateId);
  restoreCandidateInteractionState();

  try{
    const r=await fetch('/api/candidate/'+requestedCandidateId),d=await r.json();
    if(selectionSeq!==candidateSelectionSeq)return;
    if(!r.ok){toast(d.error||'Candidato não encontrado');return;}
    candidateId=requestedCandidateId; currentCandidate=d; resumeId=d.resume?.id||null;
    $('newCandidateView').classList.add('hidden'); $('candidateView').classList.remove('hidden');
    $('candidateActions').classList.remove('hidden'); $('pageTitle').textContent=d.candidate.name;
    if($('deleteSearchHistory'))$('deleteSearchHistory').disabled=!(d.runs||[]).length;
    $('pageSubtitle').textContent=d.resume?.original_name?'Currículo: '+d.resume.original_name:'Cadastro local';
    fillProfile(d.resume?.profile||{}); renderBaseResume(d.resume||{}); renderDocuments(d.documents||[]);
    await loadPendingData(requestedCandidateId,selectionSeq);
    if(selectionSeq!==candidateSelectionSeq||Number(candidateId)!==requestedCandidateId)return;
    activateTab(options.tab||'search');
    restoreCandidateInteractionState();
    renderCandidates();
    await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
    await refreshCandidateStats(d,selectionSeq,requestedCandidateId);
  }catch(err){
    if(selectionSeq===candidateSelectionSeq)toast('Erro ao abrir candidato: '+(err?.message||err));
  }finally{
    if(selectionSeq===candidateSelectionSeq&&Number(candidateId)===requestedCandidateId){
      restoreCandidateInteractionState();
    }
  }
}
async function refreshCandidateStats(detail=currentCandidate,selectionSeq=candidateSelectionSeq,expectedCandidateId=candidateId){
  if(selectionSeq!==candidateSelectionSeq||Number(expectedCandidateId)!==Number(candidateId))return;
  const summary=candidates.find(c=>c.id===expectedCandidateId)||{};
  $('statSent').textContent=summary.sent||0; $('statRuns').textContent=summary.runs||detail?.runs?.length||0;
  const latestRunId=summary.latestRunId||detail?.runs?.[0]?.id||null;
  if(latestRunId) await loadRun(latestRunId,expectedCandidateId,selectionSeq);
  else{
    currentJobs=[]; $('statJobs').textContent='0'; $('statStatus').textContent='Pronto';
    $('resultsCard').classList.add('hidden');
  }
}

function isAlreadySent(j){
  return j?.alreadySent===true||String(j?.blocked_reason||j?.reason||'').toUpperCase()==='ALREADY_SENT';
}
function isJobSelectable(j){
  const applicationStatus=String(currentStatuses.get(j?.url)?.status||'').toUpperCase();
  return !isAlreadySent(j)&&Number(j?.sendable??1)!==0&&!['SENT','ALREADY_APPLIED','UNCERTAIN','CLOSED'].includes(applicationStatus);
}

function statusBadge(status,error=''){
  const code=String(status||'PENDING').toUpperCase();
  const map={
    SENT:['sent','ENVIADA'],
    ALREADY_APPLIED:['sent','JÁ CANDIDATADO'],
    READY:['ready','VALIDADA'],
    PREPARING:['processing','PREPARANDO'],
    PROFILE_REQUIRED:['wait','DADO DO PERFIL'],
    NEEDS_DATA:['wait','DADO LEGADO'],
    INVALID_FORM:['closed','FORMULÁRIO INVÁLIDO'],
    ERROR:['error','ERRO'],
    UNCERTAIN:['uncertain','NÃO CONFIRMADO'],
    CLOSED:['closed','VAGA ENCERRADA'],
    SKIPPED_INCOMPATIBLE:['closed','INCOMPATÍVEL'],
    PENDING:['neutral','PENDENTE']
  };
  const [cls,label]=map[code]||['neutral',code];
  const title=code==='UNCERTAIN'
    ? `${error||'O site recebeu a tentativa, mas não confirmou o resultado.'} Não retentar automaticamente.`
    : error;
  return `<span class="status-badge ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}
function effectiveJobStatus(job,application={}){
  if(isAlreadySent(job))return 'SENT';
  const status=String(application?.status||'').toUpperCase();
  if(status)return status;
  const blocked=String(job?.blocked_reason||job?.reason||'').toUpperCase();
  if(blocked==='ALREADY_UNCERTAIN')return 'UNCERTAIN';
  if(blocked==='CLOSED')return 'CLOSED';
  if(blocked==='SKIPPED_INCOMPATIBLE')return 'SKIPPED_INCOMPATIBLE';
  return 'PENDING';
}
function statusFilterMatch(status,filter){
  const code=String(status||'PENDING').toUpperCase(),wanted=String(filter||'all');
  if(wanted==='all')return true;
  if(wanted==='pending')return code==='PENDING'||code==='PREPARING';
  if(wanted==='SENT')return code==='SENT'||code==='ALREADY_APPLIED';
  return code===wanted;
}
function updateRunSummary(counts={},total=0,runStatus=''){
  const c=counts||{},n=k=>Number(c[k]||0);
  const sent=n('SENT')+n('ALREADY_APPLIED');
  const ready=n('READY'),profileRequired=n('PROFILE_REQUIRED'),needs=n('NEEDS_DATA'),invalidForm=n('INVALID_FORM'),errors=n('ERROR'),uncertain=n('UNCERTAIN'),closed=n('CLOSED');
  const terminal=sent+ready+profileRequired+needs+invalidForm+errors+uncertain+closed+n('SKIPPED_INCOMPATIBLE')+n('SKIPPED_LOGIN');
  const pct=total?Math.min(100,Math.round(terminal/total*100)):0;
  const summary=$('runSummary');
  if(summary){
    const cards=[
      ['Processadas',total?`${terminal}/${total}`:String(terminal),''],
      ['Validadas',String(ready),'ready'],
      ['Enviadas',String(sent),'sent'],
      ['Dados do perfil',String(profileRequired+needs),'wait'],
      ['Formulário inválido',String(invalidForm),'closed'],
      ['Erros',String(errors),'error'],
      ['Sem confirmação',String(uncertain),'uncertain']
    ];
    summary.innerHTML=cards.map(([label,value,cls])=>`<div class="run-summary-item ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
    summary.classList.toggle('hidden',!(total||terminal));
  }
  const progress=$('runProgress');
  if(progress){
    progress.classList.toggle('hidden',!total);
    $('runProgressPct').textContent=`${pct}%`;
    $('runProgressBar').style.width=`${pct}%`;
    const active=['APPLYING','RETRYING','PREFLIGHTING','CANARY','PREPARING'].includes(String(runStatus||'').toUpperCase());
    $('runProgressLabel').textContent=String(runStatus||'').toUpperCase()==='PREFLIGHTING'?'Pré-validando formulários':String(runStatus||'').toUpperCase()==='CANARY'?'Validando primeiro envio':active?'Processando lote':'Resumo do lote';
    progress.classList.toggle('active',active);
  }
  $('uncertainWarning')?.classList.toggle('hidden',uncertain===0);
  if($('retryBtn')){
    const running=['APPLYING','RETRYING','PREFLIGHTING','CANARY'].includes(String(runStatus||'').toUpperCase());
    $('retryBtn').disabled=running||(profileRequired+needs+invalidForm+errors===0);
    $('retryBtn').title=uncertain
      ? 'Retenta erros, dados de perfil já preenchidos e formulários revalidáveis. Envios sem confirmação não são repetidos.'
      : 'Retenta erros e candidaturas cujo dado de perfil já tenha sido preenchido.';
  }
}
function syncSubmitModeHint(){
  currentRunMode=$('submitMode')?.value==='live'?'live':'dry';
  const hint=$('submitModeHint');
  if(!hint)return;
  if(currentRunMode==='live'){
    hint.textContent='Modo real: as vagas selecionadas poderão ser enviadas. O LetsWork pedirá confirmação antes de começar.';
    hint.classList.add('danger-hint');
  }else{
    hint.textContent='Simulação: valida formulários e respostas sem enviar candidaturas.';
    hint.classList.remove('danger-hint');
  }
}

function syncSelectionUi(){
  const selectableIds=new Set(currentJobs.filter(isJobSelectable).map(j=>Number(j.id)));
  selectedJobIds=new Set([...selectedJobIds].filter(id=>selectableIds.has(Number(id))));
  const total=selectableIds.size,selected=selectedJobIds.size;
  const all=$('selectAllJobs');
  if(all){
    all.checked=total>0&&selected===total;
    all.indeterminate=selected>0&&selected<total;
    all.disabled=!total;
  }
  const sentCount=currentJobs.filter(isAlreadySent).length;
  const meta=$('selectionMeta');
  if(meta)meta.textContent=currentJobs.length?`${selected} de ${total} vagas novas selecionadas${sentCount?` · ${sentCount} já enviada(s)`:''}`:'';
  if($('applyBtn'))$('applyBtn').disabled=selected===0;
}
async function saveJobSelection(){
  if(!runId)return false;
  const r=await fetch(`/api/run/${runId}/selection`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({selectedJobIds:[...selectedJobIds]})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){toast(d.error||'Não foi possível salvar a seleção.');return false;}
  return true;
}
function scheduleJobSelectionSave(){
  clearTimeout(selectionSaveTimer);
  selectionSaveTimer=setTimeout(()=>{saveJobSelection().catch(()=>{});},120);
}
function bindJobSelection(){
  document.querySelectorAll('.job-select').forEach(input=>input.addEventListener('change',()=>{
    const id=Number(input.dataset.jobId);
    if(input.checked){
      selectedJobIds.add(id);
      manuallyDeselectedJobIds.delete(id);
    }else{
      selectedJobIds.delete(id);
      manuallyDeselectedJobIds.add(id);
    }
    syncSelectionUi();
    input.closest('tr')?.classList.toggle('job-unselected',!input.checked);
    scheduleJobSelectionSave();
  }));
}
function displayJobLocation(job){
  const description=String(job?.description||'').replace(/\s+/g,' ').trim();
  const field=label=>{
    if(!description)return '';
    const next='Bairro|Cidade|Benefícios|Beneficios|Horário(?: de Expediente)?|Horario(?: de Expediente)?|Salário|Salario|Bolsa Auxílio|Bolsa Auxilio|Informações(?: Adicionais)?|Informacoes(?: Adicionais)?|Forma de Trabalho|Regime de Contratação|Regime de Contratacao|Número de Vagas|Numero de Vagas';
    const rx=new RegExp('\\b'+label+'\\s*:\\s*(.+?)(?=\\s+(?:'+next+')\\s*:|$)','i');
    return String(description.match(rx)?.[1]||'').replace(/[.;,:\-–—\s]+$/g,'').trim();
  };
  const neighborhood=field('Bairro'),city=field('Cidade');
  if(neighborhood&&city&&neighborhood.toLowerCase()!==city.toLowerCase())return neighborhood+' - '+city;
  if(neighborhood||city)return neighborhood||city;
  let raw=String(job?.location||'').replace(/\s+/g,' ').trim();
  raw=raw.split(/\s+(?:Benefícios|Beneficios|Horário(?: de Expediente)?|Horario(?: de Expediente)?|Salário|Salario|Informações|Informacoes)\s*:/i)[0].trim();
  raw=raw.replace(/\s+Cidade\s*:\s*/i,' - ').replace(/[.;,:\-–—\s]+$/g,'').trim();
  if(/^(?:vale[- ]?transporte|beneficios?|horario|a combinar|sem experiencia)$/i.test(raw))return '';
  return raw;
}

function renderJobs(jobs,statuses=currentStatuses){
  currentStatuses=statuses instanceof Map?statuses:new Map();
  const filter=$('jobStatusFilter')?.value||'all';
  const visible=jobs.filter(j=>statusFilterMatch(effectiveJobStatus(j,currentStatuses.get(j.url)||{}),filter));
  $('jobsBody').innerHTML=visible.length?visible.map(j=>{
    const application=currentStatuses.get(j.url)||{},pct=Math.round((j.score||0)*100);
    const status=effectiveJobStatus(j,application),sent=isAlreadySent(j)||['SENT','ALREADY_APPLIED'].includes(status);
    const checked=!sent&&selectedJobIds.has(Number(j.id))?'checked':'';
    const selectable=isJobSelectable(j)&&!['SENT','ALREADY_APPLIED','CLOSED','UNCERTAIN'].includes(status);
    const selectCell=sent
      ? '<span class="sent-check" title="Candidatura já registrada">✓</span>'
      : selectable
        ? `<input class="job-select" data-job-id="${Number(j.id)}" type="checkbox" ${checked} aria-label="Selecionar ${esc(j.title)}">`
        : '<span class="select-placeholder">—</span>';
    const rowClass=[
      sent?'job-sent-history':'',
      checked?'':'job-unselected',
      status==='UNCERTAIN'?'job-uncertain':'',
      status==='ERROR'?'job-error':'',
      ['PROFILE_REQUIRED','NEEDS_DATA'].includes(status)?'job-needs-data':''
    ].filter(Boolean).join(' ');
    const badge=statusBadge(status,application.error||j.blocked_reason||'');
    return `<tr class="${rowClass}"><td class="select-col">${selectCell}</td>
      <td><strong>${esc(j.title)}</strong><span class="sub">${esc(j.company||j.source||'')}${sent?' · candidatura registrada':''}</span></td>
      <td>${esc(displayJobLocation(j)||'Não informado')}</td><td>${esc(j.salary||'')}</td>
      <td><span class="score-badge">${pct}%</span></td><td>${badge}</td>
      <td><a class="link-out" href="${esc(j.url)}" target="_blank" rel="noreferrer">Abrir</a></td></tr>`;
  }).join(''):`<tr><td colspan="7"><div class="empty-list">Nenhuma vaga neste filtro.</div></td></tr>`;
  bindJobSelection();syncSelectionUi();
}

function renderBatchControl(status={}){
  const total=Math.max(0,Number(status.batches||0)),active=Math.max(1,Number(status.activeBatch||1));
  const el=$('batchSelect');
  if(total<=1){el.classList.add('hidden');el.innerHTML='';return;}
  el.innerHTML=Array.from({length:total},(_,i)=>`<option value="${i+1}">Lote ${i+1} de ${total}</option>`).join('');
  el.value=String(Math.min(active,total));el.classList.remove('hidden');
}

async function loadRun(id,expectedCandidateId=candidateId,selectionSeq=candidateSelectionSeq){
  const requestedRunId=Number(id);
  const expectedId=Number(expectedCandidateId);
  const [jr,ar,sr]=await Promise.all([fetch(`/api/run/${id}/jobs`),fetch(`/api/run/${id}/applications`),fetch(`/api/run/${id}/status`)]);
  const jobsPayload=jr.ok?await jr.json():[];
  const apps=ar.ok?await ar.json():[];
  const status=sr.ok?await sr.json():{};
  if(selectionSeq!==candidateSelectionSeq||Number(candidateId)!==expectedId||Number(status.candidateId)!==expectedId)return;
  currentRunMode=status.mode==='live'?'live':'dry';
  runId=requestedRunId;
  currentJobs=jobsPayload;
  selectedJobIds=new Set(currentJobs.filter(j=>Number(j.selected)!==0).map(j=>Number(j.id)));
  manuallyDeselectedJobIds=new Set(currentJobs.filter(j=>isJobSelectable(j)&&Number(j.selected)===0).map(j=>Number(j.id)));
  currentStatuses=new Map(apps.map(x=>[x.url,x]));
  $('statJobs').textContent=currentJobs.length; $('statStatus').textContent=status.status||'Pronto';
  renderJobs(currentJobs,currentStatuses); renderBatchControl(status); updateRunSummary(status.counts||{},Number(status.total||0),status.status);
  $('resultsCard').classList.toggle('hidden',!currentJobs.length);
  $('resultMeta').textContent=currentJobs.length?`Lote ${status.activeBatch||1}/${status.batches||1}: ${currentJobs.filter(isJobSelectable).length} vagas neste lote · ${status.alreadySentTotal||0} já processadas anteriormente · ${status.sendableTotal||0} automatizáveis via HTTP direto · ${status.reserve||0} em outros lotes.`:'';
  $('xlsxBtn').href=`/api/run/${id}/export.xlsx`; $('csvBtn').href=`/api/run/${id}/export.csv`;
  restoreCandidateInteractionState();
}
function filters(){
  const nationwide=false;
  const states=splitList($('state').value),cities=splitList($('city').value);
  const contractTypes=[];
  if($('clt').checked) contractTypes.push('CLT'); if($('pj').checked) contractTypes.push('PJ');
  if($('internship').checked) contractTypes.push('ESTAGIO'); if($('temporary').checked) contractTypes.push('TEMPORARIO');
  if($('apprentice').checked) contractTypes.push('APRENDIZ'); if($('freelance').checked) contractTypes.push('FREELANCE');
  const workMode=$('workMode').value;
  return {nationwide,state:states[0]||'',city:cities[0]||'',states,cities,locationScope:$('locationScope').value,area:$('area').value.trim(),workMode,
    remote:workMode!=='onsite_only',pcdMode:$('pcdMode').value,experienceLevel:$('experienceLevel').value,recencyDays:[7,15,30].includes(Number($('recencyDays').value))?Number($('recencyDays').value):15,contractTypes,
    availability:$('availability').checked,
    salaryExpectation:$('salaryExpectation').value.trim()||'A combinar',salaryFromJob:$('salaryFromJob').checked,
    autoSubmit:$('submitMode').value==='live'};
}
function syncFilterInteractivity(){
  const ids=['state','city','locationScope','area','workMode','pcdMode','experienceLevel','recencyDays','clt','pj','internship','temporary','apprentice','freelance','salaryExpectation','submitMode','availability','salaryFromJob'];
  for(const id of ids){
    const el=$(id);
    if(el){
      el.disabled=false;
      el.readOnly=false;
      el.removeAttribute('aria-disabled');
      el.style.pointerEvents='auto';
    }
  }
  const panel=$('tab-search');
  if(panel){
    panel.inert=false;
    panel.removeAttribute('inert');
    panel.removeAttribute('aria-disabled');
    panel.style.pointerEvents='auto';
  }
  document.querySelectorAll('#tab-search fieldset').forEach(fieldset=>{
    fieldset.disabled=false;
    fieldset.inert=false;
    fieldset.removeAttribute('inert');
    fieldset.removeAttribute('aria-disabled');
    fieldset.style.pointerEvents='auto';
  });
}
window.addEventListener('focus',syncFilterInteractivity);
for(const id of SEARCH_FILTER_IDS){
  const el=$(id);
  if(!el)continue;
  const save=()=>rememberSearchFilterDraft();
  el.addEventListener('change',save);
  if(el.tagName==='INPUT'&&el.type!=='checkbox')el.addEventListener('input',save);
}

async function saveProfile(){
  if(!resumeId) return false;
  const body={name:$('pName').value.trim(),email:$('pEmail').value.trim(),phone:$('pPhone').value.trim(),
    linkedin:$('pLinkedin').value.trim(),portfolio:$('pPortfolio').value.trim(),instagram:$('pInstagram').value.trim(),
    pcd:$('pPcd').value==='yes'?true:$('pPcd').value==='no'?false:null,cpf:$('pCpf').value.trim(),birthDate:$('pBirthDate').value.trim(),cep:$('pCep').value.trim(),
    address:$('pAddress').value.trim(),neighborhood:$('pNeighborhood').value.trim(),additionalFacts:$('pAdditionalFacts').value.trim()};
  const r=await fetch(`/api/resume/${resumeId}/profile`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json(); if(!r.ok){notice('profileStatus',`Erro: ${d.error||'não foi possível salvar'}`);return false;}
  notice('profileStatus','Perfil salvo.'); $('pageTitle').textContent=body.name||'Sem nome';
  await loadCandidates(); await loadPendingData(); return true;
}
$('saveProfile').addEventListener('click',saveProfile);
$('optimizeBaseResume')?.addEventListener('click',async()=>{
  if(!resumeId)return;
  const btn=$('optimizeBaseResume');
  btn.disabled=true;
  notice('baseResumeStatus','Otimizando currículo-base com a IA local. Isso acontece uma única vez para este currículo...');
  if(currentCandidate?.resume?.original_name) $('pageSubtitle').textContent='Currículo: '+currentCandidate.resume.original_name+' · otimizando currículo-base...';
  try{
    await saveProfile();
    const focus=String($('baseResumeFocus')?.value||$('area')?.value||'').trim();
    const template=String($('baseResumeTemplate')?.value||'executive');
    const r=await fetch(`/api/resume/${resumeId}/optimize-base`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({focus,template})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Falha ao otimizar currículo-base');
    if(currentCandidate?.resume){
      currentCandidate.resume.base_resume_path=d.file||'ready';
      currentCandidate.resume.base_resume_focus=d.focus||focus;
      currentCandidate.resume.base_resume_template=d.template||template;
      currentCandidate.resume.base_resume_updated_at=d.updatedAt||new Date().toISOString();
    }
    renderBaseResume(currentCandidate?.resume||{base_resume_path:d.file,base_resume_focus:d.focus||focus});
    if(currentCandidate?.resume?.original_name) $('pageSubtitle').textContent='Currículo: '+currentCandidate.resume.original_name+' · currículo-base pronto';
    toast('Currículo-base otimizado e pronto para os envios.');
  }catch(e){notice('baseResumeStatus','Erro ao gerar currículo-base: '+(e.message||e)+'. O currículo original continua preservado.'); if(currentCandidate?.resume?.original_name) $('pageSubtitle').textContent='Currículo: '+currentCandidate.resume.original_name+' · falha ao gerar currículo-base';}
  finally{btn.disabled=false;}
});
$('savePendingData').addEventListener('click',savePendingData);
async function pollSearchReview(targetRun){
  if(!targetRun||runId!==targetRun)return false;
  const [sr,jr]=await Promise.all([
    fetch(`/api/run/${targetRun}/status`),
    fetch(`/api/run/${targetRun}/jobs`)
  ]);
  if(!sr.ok||!jr.ok)return true;
  const status=await sr.json(),jobs=await jr.json();
  if(runId!==targetRun)return false;
  const previousJobIds=new Set(currentJobs.map(j=>Number(j.id)));
  currentJobs=jobs||[];
  const nextSelected=new Set();
  for(const j of currentJobs){
    if(!isJobSelectable(j))continue;
    const id=Number(j.id);
    if(manuallyDeselectedJobIds.has(id))continue;
    if(selectedJobIds.has(id)||(!previousJobIds.has(id)&&Number(j.selected)!==0))nextSelected.add(id);
  }
  selectedJobIds=nextSelected;
  manuallyDeselectedJobIds=new Set([...manuallyDeselectedJobIds].filter(id=>currentJobs.some(j=>Number(j.id)===Number(id))));
  $('statJobs').textContent=currentJobs.length;
  renderJobs(currentJobs,currentStatuses);
  renderBatchControl(status);
  $('resultMeta').textContent=`Lote ${status.activeBatch||1}/${status.batches||1}: ${currentJobs.length} vagas · ${status.aiReviewPending||0} em análise pela IA · ${status.reserve||0} em outros lotes.`;
  if((status.aiReviewPending||0)>0){
    $('statStatus').textContent='Analisando vagas';
    notice('searchStatus',`${currentJobs.length} vagas já prontas. ${status.aiReviewPending} vagas ambíguas continuam em análise.`);
    return true;
  }
  $('statStatus').textContent='Busca concluída';
  notice('searchStatus',`${currentJobs.length} vagas prontas. Análise concluída.`);
  return false;
}
function startSearchReviewPoll(targetRun){
  if(searchReviewTimer)clearInterval(searchReviewTimer);
  const tick=async()=>{
    const keep=await pollSearchReview(targetRun).catch(()=>true);
    if(!keep&&searchReviewTimer){clearInterval(searchReviewTimer);searchReviewTimer=null;}
  };
  tick();
  searchReviewTimer=setInterval(tick,2500);
}

$('searchBtn').addEventListener('click',async()=>{
  if(!resumeId) return;
  const searchSelectionSeq=candidateSelectionSeq;
  const searchCandidateId=Number(candidateId);
  const searchResumeId=Number(resumeId);
  const searchFilters=filters();
  if(!searchFilters.contractTypes.length){
    notice('searchStatus','Selecione pelo menos um tipo de vaga: CLT, PJ, Estágio, Temporário, Aprendiz ou Freelancer.');
    toast('Marque pelo menos um tipo de vaga.');
    return;
  }
  $('searchBtn').disabled=true; $('statStatus').textContent='Buscando';
  const searchStarted=Date.now();
  notice('searchStatus','Buscando no RioVagas + Jobbol... 0s');
  clearInterval(searchElapsedTimer); searchElapsedTimer=setInterval(()=>{const sec=Math.floor((Date.now()-searchStarted)/1000);notice('searchStatus',`Buscando no RioVagas + Jobbol... ${sec}s`);},1000);
  try{
    await saveProfile();
    if(searchSelectionSeq!==candidateSelectionSeq||Number(candidateId)!==searchCandidateId||Number(resumeId)!==searchResumeId)return;
    const r=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resumeId:searchResumeId,filters:searchFilters})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Falha na busca');
    if(searchSelectionSeq!==candidateSelectionSeq||Number(candidateId)!==searchCandidateId||Number(resumeId)!==searchResumeId)return;
    runId=d.runId; currentRunMode=$('submitMode').value==='live'?'live':'dry'; currentJobs=d.jobs||[];
    selectedJobIds=new Set(currentJobs.filter(isJobSelectable).map(j=>Number(j.id)));
    manuallyDeselectedJobIds=new Set();
    currentStatuses=new Map(); $('statJobs').textContent=currentJobs.length; $('statStatus').textContent='Busca concluída';
    renderJobs(currentJobs,currentStatuses); $('resultsCard').classList.remove('hidden');
    $('resultMeta').textContent=`${d.compatible} novas no lote 1 · ${d.alreadySentTotal||0} já processadas anteriormente · ${d.sendableTotal||0} automatizáveis via HTTP direto · ${d.reserve||0} em outros lotes · ${d.aiReviewPending||0} em revisão da IA · ${d.recent??d.found} vagas recentes consultadas.`;
    renderBatchControl({batches:d.batches||1,activeBatch:1});
    $('xlsxBtn').href=`/api/run/${runId}/export.xlsx`; $('csvBtn').href=`/api/run/${runId}/export.csv`;
    notice('searchStatus',d.aiReviewPending>0?`${d.compatible} vagas já prontas. ${d.aiReviewPending} vagas ambíguas continuam em análise.`:`${d.compatible} vagas prontas neste lote.`);
    if((d.aiReviewPending||0)>0)startSearchReviewPoll(runId);
    setTimeout(()=>$('resultsCard').scrollIntoView({behavior:'smooth',block:'start'}),80);
    await loadCandidates(); renderCandidates();
  }catch(err){
    if(searchSelectionSeq===candidateSelectionSeq&&Number(candidateId)===searchCandidateId){
      notice('searchStatus',`Erro: ${err.message}`);$('statStatus').textContent='Erro';
    }
  }
  finally{clearInterval(searchElapsedTimer);searchElapsedTimer=null;$('searchBtn').disabled=false;}
});

async function refreshApplications(targetRun=Number(runId),targetCandidate=Number(candidateId),selectionSeq=candidateSelectionSeq){
  if(!targetRun) return;
  const r=await fetch('/api/run/'+targetRun+'/applications'); if(!r.ok) return;
  const rows=await r.json();
  if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
  currentStatuses=new Map(rows.map(x=>[x.url,x]));
  renderJobs(currentJobs,currentStatuses);
}

async function pollStatus(targetRun=Number(runId),targetCandidate=Number(candidateId),selectionSeq=candidateSelectionSeq){
  if(!targetRun||!isRunContextActive(targetRun,targetCandidate,selectionSeq)) return;
  const r=await fetch('/api/run/'+targetRun+'/status'); if(!r.ok) return;
  const d=await r.json();
  if(!isRunContextActive(targetRun,targetCandidate,selectionSeq)||Number(d.candidateId)!==Number(targetCandidate))return;
  const c=d.counts||{};
  currentRunMode=d.mode==='live'?'live':'dry';
  const statusLabel={PREFLIGHTING:'Pré-validando formulários',CANARY:'Validando primeiro envio',APPLYING:'Enviando candidaturas',RETRYING:'Retentando candidaturas',ERROR_PREFLIGHT:'Pré-voo bloqueou o envio',ERROR_DISPATCH_PAUSED:'Envio pausado por segurança',DONE:'Concluído'}[String(d.status||'').toUpperCase()]||d.status||'Processando';
  $('statStatus').textContent=statusLabel;
  const terminal=(c.SENT||0)+(c.ALREADY_APPLIED||0)+(c.READY||0)+(c.ERROR||0)+(c.PROFILE_REQUIRED||0)+(c.NEEDS_DATA||0)+(c.INVALID_FORM||0)+(c.UNCERTAIN||0)+(c.CLOSED||0)+(c.SKIPPED_INCOMPATIBLE||0);
  notice('applyStatus','Processadas: '+terminal+'/'+(d.total||0)+' · Enviadas: '+(c.SENT||0)+' · Validadas: '+(c.READY||0)+' · Dados do perfil: '+((c.PROFILE_REQUIRED||0)+(c.NEEDS_DATA||0))+' · Formulário inválido: '+(c.INVALID_FORM||0)+' · Erros: '+(c.ERROR||0)+' · Sem confirmação: '+(c.UNCERTAIN||0)+' · Encerradas: '+(c.CLOSED||0));
  updateRunSummary(c,Number(d.total||0),d.status);
  if(d.status==='DONE'||d.status==='CANCELLED'||String(d.status).startsWith('ERROR')){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
    $('applyBtn').disabled=false;

    await refreshApplications(targetRun,targetCandidate,selectionSeq);
    if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;

    await loadCandidates();
    if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
    renderCandidates();

    await loadPendingData(targetCandidate,selectionSeq);
    if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;

    restoreCandidateInteractionState();
    const finalStatus=await fetch('/api/run/'+targetRun+'/status').then(x=>x.ok?x.json():null).catch(()=>null);
    if(finalStatus&&isRunContextActive(targetRun,targetCandidate,selectionSeq)&&Number(finalStatus.candidateId)===Number(targetCandidate)){
      updateRunSummary(finalStatus.counts||{},Number(finalStatus.total||0),finalStatus.status);
      restoreCandidateInteractionState();
    }
  }
}

async function startRun(endpoint){
  if(!runId) return;
  const targetRun=Number(runId),targetCandidate=Number(candidateId),selectionSeq=candidateSelectionSeq;
  if(endpoint==='apply'){
    if(!selectedJobIds.size){toast('Selecione pelo menos uma vaga para processar.');return;}
    if(!await saveJobSelection())return;
    if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
  }
  if(searchReviewTimer){clearInterval(searchReviewTimer);searchReviewTimer=null;}
  let confirmLive=false;
  if(endpoint==='apply'&&$('submitMode').value==='live'){
    if(!window.confirm('Modo real: o LetsWork poderá enviar candidaturas de verdade. Continuar?')) return;
    confirmLive=true;
  }
  if(endpoint==='retry'){
    const retryLive=currentRunMode==='live';
    const msg=retryLive
      ? 'Retentar erros e pendências deste lote em MODO REAL? Erros, dados de perfil e formulários inválidos serão revalidados. Envios sem confirmação NÃO serão repetidos.'
      : 'Retentar erros e pendências desta simulação? Erros, dados de perfil e formulários inválidos serão revalidados. Envios sem confirmação NÃO serão repetidos.';
    if(!window.confirm(msg))return;
    confirmLive=retryLive;
  }
  if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
  $('applyBtn').disabled=true;$('retryBtn').disabled=true;$('statStatus').textContent=currentRunMode==='live'?'Pré-validando formulários':'Simulando formulários';
  const r=await fetch('/api/run/'+targetRun+'/'+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmLive,selectedJobIds:endpoint==='apply'?[...selectedJobIds]:undefined})}),d=await r.json();
  if(!isRunContextActive(targetRun,targetCandidate,selectionSeq))return;
  if(!r.ok){notice('applyStatus','Erro: '+(d.error||'falha'));$('applyBtn').disabled=false;$('retryBtn').disabled=false;restoreCandidateInteractionState();return;}
  notice('applyStatus',endpoint==='retry'?'Retentativa iniciada.':'Processamento iniciado.');
  if(pollTimer) clearInterval(pollTimer);
  await pollStatus(targetRun,targetCandidate,selectionSeq);
  if(isRunContextActive(targetRun,targetCandidate,selectionSeq)){
    pollTimer=setInterval(()=>pollStatus(targetRun,targetCandidate,selectionSeq),2500);
  }
}
$('selectAllJobs').addEventListener('change',()=>{
  const selectableIds=currentJobs.filter(isJobSelectable).map(j=>Number(j.id));
  if($('selectAllJobs').checked){
    selectedJobIds=new Set(selectableIds);
    for(const id of selectableIds)manuallyDeselectedJobIds.delete(id);
  }else{
    selectedJobIds.clear();
    for(const id of selectableIds)manuallyDeselectedJobIds.add(id);
  }
  renderJobs(currentJobs,currentStatuses);
  scheduleJobSelectionSave();
});
$('batchSelect').addEventListener('change',async()=>{
  if(!runId) return;
  const batch=Number($('batchSelect').value||1);
  const r=await fetch(`/api/run/${runId}/batch/${batch}`,{method:'POST'}),d=await r.json().catch(()=>({}));
  if(!r.ok){toast(d.error||'Não foi possível trocar o lote.');await loadRun(runId);return;}
  await loadRun(runId); toast(`Lote ${batch} carregado.`);
});
$('applyBtn').addEventListener('click',()=>startRun('apply'));
$('retryBtn').addEventListener('click',()=>startRun('retry'));

async function loadReports(){
  if(!candidateId) return;
  $('latestReportBtn').href=`/api/candidate/${candidateId}/export-latest.xlsx`;
  const r=await fetch(`/api/candidate/${candidateId}/reports`),rows=r.ok?await r.json():[];
  $('reportsList').innerHTML=rows.length?rows.map(x=>`
    <div class="report-row"><div><strong>${esc(x.name)}</strong><span>${dateBR(x.modifiedAt)} · ${sizeText(x.size||0)}</span></div>
      <a class="ghost button-link" href="/api/candidate/${candidateId}/report/${encodeURIComponent(x.name)}">Baixar</a></div>`).join(''):
    '<div class="empty-list">Nenhuma planilha salva ainda. Você pode gerar a planilha atual acima.</div>';
}

$('deleteSearchHistory').addEventListener('click',async()=>{
  if(!candidateId)return;
  const summary=candidates.find(c=>c.id===candidateId)||{};
  const sent=Number(summary.sent||0),runs=Number(summary.runs||currentCandidate?.runs?.length||0);
  if(!runs){toast('Este candidato ainda não possui buscas para excluir.');return;}
  const warning=`Excluir ${runs} busca(s) anterior(es) deste candidato? Isso apaga candidaturas registradas, relatórios e marcações de vaga ENVIADA, mas preserva o currículo e os dados pessoais.${sent?` Há ${sent} envio(s) registrado(s); depois da exclusão, essas vagas poderão aparecer como novas e ser processadas novamente.`:''}`;
  if(!window.confirm(warning))return;
  const r=await fetch(`/api/candidate/${candidateId}/search-history`,{method:'DELETE'}),d=await r.json().catch(()=>({}));
  if(!r.ok)return toast(`Erro: ${d.error||'não foi possível excluir as buscas'}`);
  runId=null;currentJobs=[];currentStatuses=new Map();selectedJobIds.clear();
  toast(`Histórico de buscas excluído (${d.deletedRuns||0} busca(s)). Currículo preservado.`);
  await loadCandidates();await selectCandidate(candidateId);
});
$('deleteCandidate').addEventListener('click',async()=>{
  if(!candidateId) return;
  const rr=await fetch(`/api/candidate/${candidateId}/reports`),reports=rr.ok?await rr.json():[];
  const warning=reports.length
    ?`Este candidato possui ${reports.length} relatório(s) salvo(s). A exclusão também apagará esses arquivos. Confirme que você já baixou o que precisa.`
    :'Esse cadastro e todos os arquivos locais dele serão apagados.';
  if(!window.confirm(warning)) return;
  if(!window.confirm(`Excluir definitivamente ${currentCandidate?.candidate?.name||'este candidato'}?`)) return;
  const r=await fetch(`/api/candidate/${candidateId}`,{method:'DELETE'}),d=await r.json().catch(()=>({}));
  if(!r.ok) return toast(`Erro: ${d.error||'não foi possível excluir'}`);
  toast('Candidato e dados locais excluídos.');
  showNewCandidate(); await loadCandidates(true);
});

$('latestReportBtn').addEventListener('click',e=>{
  if(!runId){e.preventDefault();toast('Faça pelo menos uma busca antes de gerar relatório.');}
});

$('jobStatusFilter')?.addEventListener('change',()=>renderJobs(currentJobs,currentStatuses));
$('submitMode')?.addEventListener('change',syncSubmitModeHint);

async function init(){
  syncSubmitModeHint();
  await loadAI(); loadSystemStatus();
  await loadCandidates();
  if(candidates.length) await selectCandidate(candidates[0].id);
  else showNewCandidate();
}
init();

let candidateId=null;
let resumeId=null;
let runId=null;
let currentCandidate=null;
let currentJobs=[];
let candidates=[];
let pollTimer=null;
let selectedFiles=[];
let searchElapsedTimer=null;

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const splitList=s=>String(s||'').split(/[,;]/).map(x=>x.trim()).filter(Boolean);
const dateBR=value=>value?new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'';
const sizeText=n=>n>1024*1024?`${(n/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`;

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
async function loadAI(){
  try{
    const r=await fetch('/api/ai/status'),d=await r.json();
    $('aiDot').className=`dot ${d.online?'online':'offline'}`;
    $('aiLabel').textContent=d.online?'ChatGPT conectado':'ChatGPT indisponível';
    $('aiModel').textContent=d.online?`${d.model||'GPT-5.6 Sol'} · ${d.level||'high'}`:(d.model||'GPT-5.6 Sol');
  }catch{
    $('aiDot').className='dot offline'; $('aiLabel').textContent='ChatGPT indisponível';
  }
}

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
  const likely=selectedFiles.findIndex(f=>/(^|[_ -])(cv|curr[ií]culo|curriculum|resume)([_ .-]|$)/i.test(f.name));
  if(likely>=0) $('primaryFileSelect').value=String(likely);
}
function showNewCandidate(openPicker=false){
  candidateId=resumeId=runId=null; currentCandidate=null; currentJobs=[]; selectedFiles=[];
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
  e.preventDefault(); const files=[...selectedFiles]; if(!files.length) return;
  notice('uploadStatus','Lendo arquivos. OCR pode levar alguns instantes...');
  const fd=new FormData(); files.forEach(file=>fd.append('files',file)); fd.append('primaryIndex',$('primaryFileSelect').value||'0');
  try{
    const r=await fetch('/api/candidate/import',{method:'POST',body:fd});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Falha ao importar currículo');
    candidateId=d.candidateId; resumeId=d.resumeId;
    await loadCandidates(); await selectCandidate(candidateId);
    notice('uploadStatus',''); selectedFiles=[]; $('resumeFile').value=''; renderSelectedFiles();
  }catch(err){notice('uploadStatus',`Erro: ${err.message}`);}
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

function fillProfile(p={}){
  $('pName').value=p.name||''; $('pEmail').value=p.email||''; $('pPhone').value=p.phone||'';
  $('pLinkedin').value=p.linkedin||''; $('pPortfolio').value=p.portfolio||''; $('pInstagram').value=p.instagram||'';
  $('pPcd').value=p.pcd===true?'yes':p.pcd===false?'no':''; $('pCpf').value=p.cpf||''; $('pBirthDate').value=p.birthDate||''; $('pCep').value=p.cep||'';
  $('pAddress').value=p.address||''; $('pNeighborhood').value=p.neighborhood||'';
  $('pAdditionalFacts').value=p.additionalFacts||'';
}

async function selectCandidate(id){
  // Cada candidato começa com busca ampla por padrão; filtros restritivos de outro candidato não vazam para este perfil.
  $('locationScope').value='state_priority';
  $('experienceLevel').value='entry';
  const r=await fetch(`/api/candidate/${id}`),d=await r.json();
  if(!r.ok) return toast(d.error||'Candidato não encontrado');
  candidateId=id; currentCandidate=d; resumeId=d.resume?.id||null;
  $('newCandidateView').classList.add('hidden'); $('candidateView').classList.remove('hidden');
  $('candidateActions').classList.remove('hidden'); $('pageTitle').textContent=d.candidate.name;
  $('pageSubtitle').textContent=d.resume?.original_name?`Currículo: ${d.resume.original_name}`:'Cadastro local';
  fillProfile(d.resume?.profile||{}); renderDocuments(d.documents||[]); activateTab('search');
  renderCandidates(); await refreshCandidateStats(d);
}
async function refreshCandidateStats(detail=currentCandidate){
  const summary=candidates.find(c=>c.id===candidateId)||{};
  $('statSent').textContent=summary.sent||0; $('statRuns').textContent=summary.runs||detail?.runs?.length||0;
  runId=summary.latestRunId||detail?.runs?.[0]?.id||null;
  if(runId) await loadRun(runId);
  else{
    currentJobs=[]; $('statJobs').textContent='0'; $('statStatus').textContent='Pronto';
    $('resultsCard').classList.add('hidden');
  }
}

function statusBadge(status,error=''){
  const s=String(status||'').toUpperCase();
  const cls=s==='SENT'?'sent':s==='ERROR'?'error':['NEEDS_DATA','SKIPPED_LOGIN','PREPARING'].includes(s)?'wait':'ready';
  const label=s==='SENT'?'ENVIADA':s==='PREPARING'?'GERANDO CURRÍCULO':s==='READY'?'PRONTO PARA ENVIO':s==='NEEDS_DATA'?'AGUARDA DADO':s==='SKIPPED_LOGIN'?'IGNORADA · LOGIN':s||'PENDENTE';
  return `<span class="status-badge ${cls}" title="${esc(error)}">${esc(label)}</span>`;
}

function renderJobs(jobs,statuses=new Map()){
  $('jobsBody').innerHTML=jobs.map(j=>{
    const a=statuses.get(j.url)||{}; const pct=Math.round((j.score||0)*100);
    return `<tr><td><strong>${esc(j.title)}</strong><span class="sub">${esc(j.company||j.source||'')}</span></td>
      <td>${esc(j.location||'')}</td><td>${esc(j.salary||'')}</td>
      <td><span class="score-badge">${pct}%</span></td><td>${statusBadge(a.status,a.error)}</td>
      <td><a class="link-out" href="${esc(j.url)}" target="_blank" rel="noreferrer">Abrir</a></td></tr>`;
  }).join('');
}
function renderBatchControl(status={}){
  const total=Math.max(0,Number(status.batches||0)),active=Math.max(1,Number(status.activeBatch||1));
  const el=$('batchSelect');
  if(total<=1){el.classList.add('hidden');el.innerHTML='';return;}
  el.innerHTML=Array.from({length:total},(_,i)=>`<option value="${i+1}">Lote ${i+1} de ${total}</option>`).join('');
  el.value=String(Math.min(active,total));el.classList.remove('hidden');
}

async function loadRun(id){
  runId=id;
  const [jr,ar,sr]=await Promise.all([fetch(`/api/run/${id}/jobs`),fetch(`/api/run/${id}/applications`),fetch(`/api/run/${id}/status`)]);
  currentJobs=jr.ok?await jr.json():[]; const apps=ar.ok?await ar.json():[]; const status=sr.ok?await sr.json():{};
  $('statJobs').textContent=currentJobs.length; $('statStatus').textContent=status.status||'Pronto';
  renderJobs(currentJobs,new Map(apps.map(x=>[x.url,x]))); renderBatchControl(status);
  $('resultsCard').classList.toggle('hidden',!currentJobs.length);
  $('resultMeta').textContent=currentJobs.length?`Lote ${status.activeBatch||1}/${status.batches||1}: ${currentJobs.length} vagas para processar · ${status.sendableTotal||currentJobs.length} automatizáveis sem login · ${status.reserve||0} guardadas em outros lotes · ${status.blockedLogin||0} bloqueadas por login e fora da fila.`:'';
  $('xlsxBtn').href=`/api/run/${id}/export.xlsx`; $('csvBtn').href=`/api/run/${id}/export.csv`;
}
function filters(){
  const nationwide=$('nationwide').checked;
  const states=nationwide?[]:splitList($('state').value),cities=nationwide?[]:splitList($('city').value);
  const contractTypes=[];
  if($('clt').checked) contractTypes.push('CLT'); if($('pj').checked) contractTypes.push('PJ');
  if($('internship').checked) contractTypes.push('ESTAGIO'); if($('temporary').checked) contractTypes.push('TEMPORARIO');
  if($('apprentice').checked) contractTypes.push('APRENDIZ'); if($('freelance').checked) contractTypes.push('FREELANCE');
  const workMode=$('workMode').value;
  return {nationwide,state:states[0]||'',city:cities[0]||'',states,cities,locationScope:$('locationScope').value,area:$('area').value.trim(),workMode,
    remote:workMode!=='onsite_only',pcdMode:$('pcdMode').value,experienceLevel:$('experienceLevel').value,recencyDays:Math.min(60,Math.max(1,Number($('recencyDays').value||15))),contractTypes,
    limit:Math.min(500,Math.max(100,Number($('limit').value||500))),availability:$('availability').checked,
    salaryExpectation:$('salaryExpectation').value.trim()||'A combinar',salaryFromJob:$('salaryFromJob').checked,
    autoSubmit:$('submitMode').value==='live'};
}
$('nationwide').addEventListener('change',()=>{
  $('state').disabled=$('nationwide').checked; $('city').disabled=$('nationwide').checked; $('locationScope').disabled=$('nationwide').checked;
});

async function saveProfile(){
  if(!resumeId) return false;
  const body={name:$('pName').value.trim(),email:$('pEmail').value.trim(),phone:$('pPhone').value.trim(),
    linkedin:$('pLinkedin').value.trim(),portfolio:$('pPortfolio').value.trim(),instagram:$('pInstagram').value.trim(),
    pcd:$('pPcd').value==='yes'?true:$('pPcd').value==='no'?false:null,cpf:$('pCpf').value.trim(),birthDate:$('pBirthDate').value.trim(),cep:$('pCep').value.trim(),
    address:$('pAddress').value.trim(),neighborhood:$('pNeighborhood').value.trim(),additionalFacts:$('pAdditionalFacts').value.trim()};
  const r=await fetch(`/api/resume/${resumeId}/profile`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json(); if(!r.ok){notice('profileStatus',`Erro: ${d.error||'não foi possível salvar'}`);return false;}
  notice('profileStatus','Perfil salvo.'); $('pageTitle').textContent=body.name||'Sem nome';
  await loadCandidates(); return true;
}
$('saveProfile').addEventListener('click',saveProfile);
$('searchBtn').addEventListener('click',async()=>{
  if(!resumeId) return;
  $('searchBtn').disabled=true; $('statStatus').textContent='Buscando';
  const searchStarted=Date.now();
  notice('searchStatus','Buscando em RioVagas, Vagas.com, LinkedIn, Gupy e demais fontes... 0s');
  clearInterval(searchElapsedTimer); searchElapsedTimer=setInterval(()=>{const sec=Math.floor((Date.now()-searchStarted)/1000);notice('searchStatus',`Buscando em várias fontes... ${sec}s`);},1000);
  try{
    await saveProfile();
    const r=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resumeId,filters:filters()})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Falha na busca');
    runId=d.runId; currentJobs=d.jobs||[]; $('statJobs').textContent=currentJobs.length; $('statStatus').textContent='Busca concluída';
    renderJobs(currentJobs); $('resultsCard').classList.remove('hidden');
    const sourceNames=[...new Set([...Object.keys(d.sourceCounts||{}),...Object.keys(d.sendableSourceCounts||{}),...Object.keys(d.blockedSourceCounts||{})])];
    const sourceTriples=sourceNames.slice(0,12).map(k=>`${k}: ${d.sourceCounts?.[k]||0}/${d.sendableSourceCounts?.[k]||0}/${d.blockedSourceCounts?.[k]||0}`).join(' · ');
    $('resultMeta').textContent=`${d.compatible} no lote 1 · ${d.sendableTotal||0} enviáveis sem login · ${d.reserve||0} guardadas para outros lotes · ${d.blockedLogin||0} bloqueadas por login · ${d.unverifiedLogin||0} aguardando verificação · ${d.compatibleTotal||0} compatíveis salvas · ${d.recent??d.found} recentes.${sourceTriples?` Por fonte (coletadas/enviáveis/bloqueadas): ${sourceTriples}.`:''}`;
    renderBatchControl({batches:d.batches||1,activeBatch:1});
    $('xlsxBtn').href=`/api/run/${runId}/export.xlsx`; $('csvBtn').href=`/api/run/${runId}/export.csv`;
    notice('searchStatus',`${d.compatible} vagas prontas neste lote. ${d.reserve||0} ficaram guardadas para depois.`);
    setTimeout(()=>$('resultsCard').scrollIntoView({behavior:'smooth',block:'start'}),80);
    await loadCandidates(); renderCandidates();
  }catch(err){notice('searchStatus',`Erro: ${err.message}`);$('statStatus').textContent='Erro';}
  finally{clearInterval(searchElapsedTimer);searchElapsedTimer=null;$('searchBtn').disabled=false;}
});

async function refreshApplications(){
  if(!runId) return;
  const r=await fetch(`/api/run/${runId}/applications`); if(!r.ok) return;
  const rows=await r.json(); renderJobs(currentJobs,new Map(rows.map(x=>[x.url,x])));
}

async function pollStatus(){
  if(!runId) return;
  const r=await fetch(`/api/run/${runId}/status`); if(!r.ok) return;
  const d=await r.json(),c=d.counts||{};
  $('statStatus').textContent=d.status||'Processando';
  notice('applyStatus',`Enviadas: ${c.SENT||0} · Gerando currículo: ${c.PREPARING||0} · Prontas para envio: ${c.READY||0} · Erros: ${c.ERROR||0} · Aguardando dado: ${c.NEEDS_DATA||0} · Ignoradas por login: ${c.SKIPPED_LOGIN||0}`);
  if(d.status==='DONE'||d.status==='CANCELLED'||String(d.status).startsWith('ERROR')){
    clearInterval(pollTimer);pollTimer=null;$('applyBtn').disabled=false;$('retryBtn').disabled=false;
    await refreshApplications();await loadCandidates();renderCandidates();
  }
}
async function startRun(endpoint){
  if(!runId) return;
  if(endpoint==='apply'&&$('submitMode').value==='live'){
    if(!window.confirm('Modo real: o LetsWork poderá enviar candidaturas de verdade. Continuar?')) return;
  }
  $('applyBtn').disabled=true;$('retryBtn').disabled=true;$('statStatus').textContent='Processando';
  const live=endpoint==='apply'&&$('submitMode').value==='live';
  const r=await fetch(`/api/run/${runId}/${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmLive:live})}),d=await r.json();
  if(!r.ok){notice('applyStatus',`Erro: ${d.error||'falha'}`);$('applyBtn').disabled=false;$('retryBtn').disabled=false;return;}
  notice('applyStatus',endpoint==='retry'?'Retentativa iniciada.':'Processamento iniciado.');
  if(pollTimer) clearInterval(pollTimer);await pollStatus();pollTimer=setInterval(pollStatus,2500);
}
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

async function init(){
  await loadAI();
  await loadCandidates();
  if(candidates.length) await selectCandidate(candidates[0].id);
  else showNewCandidate();
}
init();

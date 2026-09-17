let resumeId = null;
let runId = null;
let pollTimer = null;
const $ = id => document.getElementById(id);
const show = (id,text) => { const e=$(id); e.textContent=text; e.classList.remove('hidden'); };
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const splitList = s => String(s||'').split(/[,;]/).map(x=>x.trim()).filter(Boolean);

$('nationwide').addEventListener('change', () => {
  const disabled = $('nationwide').checked;
  $('state').disabled = disabled;
  $('city').disabled = disabled;
});

$('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('resumeFile').files[0];
  if (!file) return;
  show('uploadStatus','Lendo currículo... imagens e PDFs escaneados podem demorar por causa do OCR.');
  const fd = new FormData(); fd.append('resume',file);
  try {
    const r = await fetch('/api/resume/upload',{method:'POST',body:fd});
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Falha no upload');
    resumeId = data.resumeId;
    $('pName').value = data.profile.name || '';
    $('pEmail').value = data.profile.email || '';
    $('pPhone').value = data.profile.phone || '';
    $('pLinkedin').value = data.profile.linkedin || '';
    $('pPortfolio').value = data.profile.portfolio || '';
    $('profileCard').classList.remove('hidden');
    $('filtersCard').classList.remove('hidden');
    show('uploadStatus',`Currículo lido: ${data.chars.toLocaleString('pt-BR')} caracteres extraídos.`);
  } catch(err) { show('uploadStatus',`Erro: ${err.message}`); }
});
async function saveProfile() {
  if (!resumeId) return false;
  const body = {
    name:$('pName').value.trim(), email:$('pEmail').value.trim(), phone:$('pPhone').value.trim(),
    linkedin:$('pLinkedin').value.trim(), portfolio:$('pPortfolio').value.trim()
  };
  const r = await fetch(`/api/resume/${resumeId}/profile`, {
    method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) { show('uploadStatus',`Erro: ${data.error || 'não foi possível salvar'}`); return false; }
  show('uploadStatus','Dados atualizados.');
  return true;
}
$('saveProfile').addEventListener('click', saveProfile);

function filters() {
  const nationwide = $('nationwide').checked;
  const states = nationwide ? [] : splitList($('state').value);
  const cities = nationwide ? [] : splitList($('city').value);
  const contractTypes = [];
  if ($('clt').checked) contractTypes.push('CLT');
  if ($('pj').checked) contractTypes.push('PJ');
  const workMode = $('workMode').value;
  return {
    nationwide,
    state:states[0] || '', city:cities[0] || '', states, cities,
    area:$('area').value.trim(), workMode, remote:workMode !== 'onsite_only',
    pcdMode:$('pcdMode').value, contractTypes,
    limit:Math.min(500,Math.max(100,Number($('limit').value || 500))),
    availability:$('availability').checked,
    salaryExpectation:$('salaryExpectation').value.trim() || 'A combinar',
    autoSubmit:$('submitMode').value === 'live'
  };
}

function renderJobs(jobs) {
  $('jobsBody').innerHTML = jobs.map(j => `<tr>
    <td><strong>${esc(j.title)}</strong><br><span class="muted">${esc(j.company||'')}</span></td>
    <td>${esc(j.location||'')}</td><td>${esc(j.salary||'')}</td><td>${esc(j.source||'')}</td>
    <td class="score">${Math.round((j.score||0)*100)}%</td>
    <td><a href="${esc(j.url)}" target="_blank" rel="noreferrer">abrir</a></td>
  </tr>`).join('');
}
$('searchBtn').addEventListener('click', async () => {
  if (!resumeId) return;
  $('searchBtn').disabled = true;
  show('searchStatus','Buscando e filtrando vagas. Isso pode levar alguns minutos.');
  try {
    await saveProfile();
    const r = await fetch('/api/search',{
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({resumeId,filters:filters()})
    });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Falha na busca');
    runId = data.runId;
    renderJobs(data.jobs || []);
    $('resultsCard').classList.remove('hidden');
    $('resultMeta').textContent = `${data.compatible} vagas compatíveis de ${data.found} coletadas.`;
    $('xlsxBtn').href = `/api/run/${runId}/export.xlsx`;
    $('csvBtn').href = `/api/run/${runId}/export.csv`;
    show('searchStatus',`Busca concluída. ${data.compatible} vagas entraram na lista final.`);
  } catch(err) { show('searchStatus',`Erro: ${err.message}`); }
  finally { $('searchBtn').disabled = false; }
});

async function pollStatus() {
  if (!runId) return;
  const r = await fetch(`/api/run/${runId}/status`);
  if (!r.ok) return;
  const data = await r.json();
  const c = data.counts || {};
  const text = `Status: ${data.status}\nTotal: ${data.total} | Enviadas: ${c.SENT||0} | Prontas/simulação: ${c.READY||0} | Erros: ${c.ERROR||0} | Aguardando dado: ${c.NEEDS_DATA||0}`;
  show('applyStatus',text);
  if (data.status === 'DONE' || String(data.status).startsWith('ERROR')) {
    clearInterval(pollTimer); pollTimer = null;
    $('applyBtn').disabled = false; $('retryBtn').disabled = false;
  }
}
async function startRun(endpoint) {
  if (!runId) return;
  const live = $('submitMode').value === 'live';
  if (endpoint === 'apply' && live) {
    const ok = window.confirm('Modo real: as candidaturas poderão ser enviadas de verdade. Continuar?');
    if (!ok) return;
  }
  $('applyBtn').disabled = true; $('retryBtn').disabled = true;
  const r = await fetch(`/api/run/${runId}/${endpoint}`,{method:'POST'});
  const data = await r.json();
  if (!r.ok) {
    show('applyStatus',`Erro: ${data.error || 'falha'}`);
    $('applyBtn').disabled = false; $('retryBtn').disabled = false;
    return;
  }
  show('applyStatus',endpoint==='retry'?'Retentativa iniciada.':'Processamento iniciado.');
  if (pollTimer) clearInterval(pollTimer);
  await pollStatus();
  pollTimer = setInterval(pollStatus,2500);
}

$('applyBtn').addEventListener('click',()=>startRun('apply'));
$('retryBtn').addEventListener('click',()=>startRun('retry'));

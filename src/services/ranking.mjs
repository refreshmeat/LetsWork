import { askAI, parseJsonLoose } from './ai.mjs';

const stop=new Set('de da do das dos e em para com por a o as os um uma vaga vagas trabalho emprego'.split(' '));
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const stem=x=>x.length>5?x.replace(/(?:as|os|es|a|o|s)$/,''):x;
const words=s=>new Set(norm(s).split(/[^a-z0-9+#.]+/).map(stem).filter(x=>x.length>2&&!stop.has(x)));

function inferFlags(job){
  const text=norm(`${job.title||''} ${job.description||''} ${job.location||''} ${job.contractType||''}`);
  const pcdExclusive=Boolean(job.pcdExclusive)||/exclusiv.{0,40}(?:pcd|pessoa.{0,20}deficiencia|deficiencia)|afirmativ.{0,40}(?:pcd|pessoa.{0,20}deficiencia|deficiencia)|vaga.{0,40}exclusiv.{0,40}(?:pcd|pessoa.{0,20}deficiencia|deficiencia)|somente.{0,40}(?:pcd|pessoa.{0,20}deficiencia)/.test(text);
  const pcdEligible=pcdExclusive||Boolean(job.pcd)||/tambem p\/? pcd|pessoa com deficiencia|\bpcd\b/.test(text);
  const hybrid=/hibrid/.test(text);
  const remote=Boolean(job.remote)||/home office|remoto|remote/.test(text);
  return {
    pcd:pcdEligible,pcdEligible,pcdExclusive,remote,hybrid,
    clt:/\bclt\b|carteira assinada|efetivo/.test(text),
    pj:/\bpj\b|pessoa juridica|mei|autonomo/.test(text),
    internship:/estagio/.test(text),
    temporary:/temporario/.test(text),
    apprentice:/aprendiz/.test(text),
    freelance:/freelance|freelancer/.test(text)
  };
}

function workModeOk(flags,mode){
  if(mode==='remote_only')return flags.remote&&!flags.hybrid;
  if(mode==='onsite_only')return !flags.remote&&!flags.hybrid;
  return true;
}

function stateTextMatch(text,value){
  const s=norm(value).trim();
  if(!s)return false;
  if(s.length===2)return new RegExp(`(^|[^a-z])${s}([^a-z]|$)`).test(text);
  return text.includes(s);
}

function remoteRegionOk(job,filters){
  if(filters.nationwide)return true;
  const loc=norm(job.location);
  if(!loc)return true;
  if(/worldwide|anywhere|global|latin america|south america|brasil|brazil/.test(loc))return true;
  const chosen=[...(filters.states||[]),...(filters.cities||[])].map(norm).filter(Boolean);
  if(chosen.some(x=>loc.includes(x)))return true;
  return !/only|apenas|eua|usa|united states|canada|europe|europa|uk|united kingdom/.test(loc);
}

const rjOtherMunicipality=/\b(?:niteroi|duque de caxias|nova iguacu|sao goncalo|nilopolis|sao joao de meriti|belford roxo|mesquita|queimados|japeri|seropedica|itaguai|mage|guapimirim|itabora[ií]|marica|tangua|petropolis|teresopolis|nova friburgo|volta redonda|barra mansa|resende|macae|campos dos goytacazes|cabo frio|araruama|saquarema|rio das ostras|angra dos reis|paraty)\b/;
function rioVagasRioCityInference(job,cities){
  const wantsRio=cities.some(x=>norm(x)==='rio de janeiro');
  if(!wantsRio||!/^RioVagas$/i.test(job.source||''))return false;
  const loc=norm(job.location||'');
  if(!loc)return true;
  return !rjOtherMunicipality.test(loc);
}

function locationOk(job,filters,flags){
  if(filters.nationwide)return true;
  if(flags.remote&&filters.workMode!=='onsite_only')return remoteRegionOk(job,filters);
  const text=norm(`${job.location||''} ${job.title||''}`).replace(/rio de jan\.{2,}/g,'rio de janeiro');
  const cities=Array.isArray(filters.cities)?filters.cities.filter(Boolean):[filters.city].filter(Boolean);
  const states=Array.isArray(filters.states)?filters.states.filter(Boolean):[filters.state].filter(Boolean);
  const cityHit=cities.some(x=>text.includes(norm(x)));
  const stateHit=states.some(x=>stateTextMatch(text,x));
  const localRjSource=/^(RioVagas|EmpregosRJ)$/i.test(job.source||'');
  const wantsRj=states.some(x=>/^(rj|rio de janeiro)$/i.test(String(x).trim()));
  if(filters.locationScope==='state_only')return stateHit||(localRjSource&&wantsRj)||(!job.location&&localRjSource);
  if(cities.length){
    if(cityHit)return true;
    if((filters.locationScope||'state_priority')==='city_only')return rioVagasRioCityInference(job,cities);
    if(stateHit||(localRjSource&&wantsRj))return true;
    return false;
  }
  if(states.length)return stateHit||(localRjSource&&wantsRj);
  return true;
}

function locationBoost(job,filters,flags){
  if(filters.nationwide)return 0;
  if(flags.remote&&filters.workMode!=='onsite_only')return 0.05;
  const text=norm(`${job.location||''} ${job.title||''}`).replace(/rio de jan\.{2,}/g,'rio de janeiro');
  const cities=Array.isArray(filters.cities)?filters.cities.filter(Boolean):[filters.city].filter(Boolean);
  const states=Array.isArray(filters.states)?filters.states.filter(Boolean):[filters.state].filter(Boolean);
  if(cities.some(x=>text.includes(norm(x))))return 0.12;
  if(states.some(x=>stateTextMatch(text,x)))return 0.04;
  return 0;
}

function experienceOk(job,filters){
  const mode=filters.experienceLevel||'entry';
  if(mode==='all')return true;
  const title=norm(job.title),text=norm(`${job.title||''} ${job.description||''}`);
  const high=/\b(pleno|pl\.?|senior|sr\.?|especialista|specialist|coordenador|coordenadora|coordinator|gerente|manager|supervisor|supervisora|lider|head|diretor|diretora|director|lead|principal|staff)\b|\b(?:ii|iii|iv)\b|\bn[ií]vel\s*[234]\b|\blevel\s*[234]\b/.test(title);
  const req=[...text.matchAll(/experi[eê]ncia[^\d]{0,25}(\d+)\s*anos?|(?:minimo|ao menos|pelo menos|mais de)?\s*(\d+)\s*anos?\s*(?:de )?experi[eê]ncia/g)].map(m=>Number(m[1]||m[2])).filter(Number.isFinite);
  if(mode==='none'){
    if(high||req.some(n=>n>=1))return false;
    return !/experi[eê]ncia.{0,30}(?:obrigatoria|necessaria|comprovada|exigida|minima)|(?:exige|requer).{0,20}experi[eê]ncia/.test(text);
  }
  return !high&&!req.some(n=>n>=3);
}

function pcdOk(flags,mode){
  if(mode==='only')return flags.pcdEligible;
  if(mode==='include')return true;
  return !flags.pcdExclusive;
}

function contractOk(flags,filters){
  const wanted=new Set(filters.contractTypes||[]);
  if(!wanted.size)return true;
  const actual=new Set();
  if(flags.clt)actual.add('CLT');
  if(flags.pj)actual.add('PJ');
  if(flags.internship)actual.add('ESTAGIO');
  if(flags.temporary)actual.add('TEMPORARIO');
  if(flags.apprentice)actual.add('APRENDIZ');
  if(flags.freelance)actual.add('FREELANCE');
  if(!actual.size)return true;
  return [...actual].some(x=>wanted.has(x));
}

const specializationRules=[
  {job:/\b(?:engenharia|engenheiro|engenheira|engineer|engineering|mecanica|mecanico|eletrica|eletrico|edificacoes)\b/,profile:/\b(?:engenharia|engenheiro|engenheira|engineer|engineering|mecanica|mecanico|eletrica|eletrico|edificacoes)\b/},
  {job:/\b(?:enfermagem|enfermeir[oa]|fisioterapia|fisioterapeuta|psicologia|psicolog[oa]|biomedicina|biomedic[oa]|farmacia|farmaceutic[oa]|nutricao|nutricionista)\b/,profile:/\b(?:enfermagem|enfermeir[oa]|fisioterapia|fisioterapeuta|psicologia|psicolog[oa]|biomedicina|biomedic[oa]|farmacia|farmaceutic[oa]|nutricao|nutricionista)\b/},
  {job:/\b(?:pedagogia|pedagogic[oa]|professor[ao]?|docente|educacao infantil|educacao fisica|matematica|letras)\b/,profile:/\b(?:pedagogia|pedagogic[oa]|professor[ao]?|docente|licenciatura|educacao fisica|matematica|letras)\b/},
  {job:/\b(?:gastronomia|cozinha|confeitaria|cozinheir[oa]|garcom)\b/,profile:/\b(?:gastronomia|cozinha|confeitaria|cozinheir[oa]|garcom)\b/},
  {job:/\b(?:juridic[oa]|advogad[oa]|direito)\b/,profile:/\b(?:juridic[oa]|advogad[oa]|direito)\b/},
  {job:/\b(?:contabilidade|contabil|contador[ao]?|fiscal)\b/,profile:/\b(?:contabilidade|contabil|contador[ao]?|fiscal)\b/}
];

function professionalJobText(job){
  let text=norm(`${job.title||''} ${job.description||''}`);
  for(const value of [job.company,job.location]){
    const token=norm(value||'').trim();
    if(token.length>=3)text=text.split(token).join(' ');
  }
  return text.replace(/\s+/g,' ').trim();
}

function specializationMismatch(job,profileText){
  const title=norm(job.title||''),profile=norm(profileText||'');
  if(/\b(?:arquitetura|urbanismo|arquiteto|arquiteta)\b/.test(title)&&!/\b(?:arquitetura|urbanismo|arquiteto|arquiteta|design\s+de\s+interiores)\b/.test(profile))return true;
  return specializationRules.some(rule=>rule.job.test(title)&&!rule.profile.test(profile));
}

function higherEducationActive(profileText){
  return /\b(?:bacharelado|graduacao|universidade|faculdade|\d+[º°]?\s*semestre|cursando\s+(?:design|administracao|marketing|engenharia|direito|psicologia|pedagogia|tecnologia))\b/.test(norm(profileText));
}

const genericRoleTokens=new Set(['estagio','estagiario','estagiaria','assistente','auxiliar','analista','junior','jr','trainee','vaga','area']);
function roleTokens(value){return new Set(norm(value).split(/[^a-z0-9+#.]+/).filter(x=>x.length>=2&&!stop.has(x)));}
function rolePhraseMatch(text,term){
  const phrase=norm(term).trim();
  if(phrase.length<2)return false;
  const esc=phrase.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  return new RegExp('(^|[^a-z0-9])'+esc+'([^a-z0-9]|$)','i').test(norm(text));
}
function explicitRoleFit(value,terms){
  const role=norm(value).trim();
  if(!role||!terms.length)return false;
  const roleSet=roleTokens(role);
  for(const raw of terms){
    const term=norm(raw).trim();
    if(term.length<2)continue;
    if(rolePhraseMatch(role,term)||rolePhraseMatch(term,role))return true;
    const meaningful=[...roleTokens(term)].filter(x=>!genericRoleTokens.has(x));
    if(meaningful.length&&meaningful.every(x=>roleSet.has(x)))return true;
  }
  return false;
}
function approvedRoleFit(roleHead,filters){
  return explicitRoleFit(roleHead,[...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchTargetTerms||[])]);
}
function coreRoleFit(roleHead,filters){
  return explicitRoleFit(roleHead,[...(filters.searchCoreTerms||[])]);
}

const offTrackRole=/\b(?:recepcionista|recepcao|administrativ[oa]|administracao|secretari[oa]|vendedor[ao]?|vendas|atendente|atendimento|telemarketing|caixa|servicos\s+gerais|operador[ao]?\s+de\s+loja|auxiliar\s+de\s+escritorio)\b/;
function primaryRoleMismatch(roleHead,filters){
  const primary=String(roleHead||'').split(/\s+(?:e|&)\s+|\/|,/i)[0].trim();
  return offTrackRole.test(norm(primary))&&!approvedRoleFit(primary,filters);
}
function genericOffTrackMismatch(title,filters){
  const t=norm(title);
  const approved=[...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[])].map(norm);
  const groups=[/\b(?:atendente|atendimento|telemarketing)\b/,/\b(?:recepcionista|recepcao)\b/,/\b(?:administrativ[oa]|administracao|auxiliar de escritorio)\b/,/\b(?:vendedor[ao]?|vendas)\b/,/\bsecretari[oa]\b/,/\b(?:caixa|operador[ao]? de loja|servicos gerais)\b/];
  for(const rx of groups)if(rx.test(t)&&!approved.some(x=>rx.test(x)))return true;
  return false;
}

function entryMismatch(title,profileText){
  const t=norm(title),higher=higherEducationActive(profileText);
  if(higher&&/(?:estagio|estagiari[oa]).{0,18}ensino medio|ensino medio.{0,18}(?:estagio|estagiari[oa])/.test(t))return true;
  if(higher&&/\b(?:jovem\s+aprendiz|pessoa\s+jovem\s+aprendiz|aprendiz)\b/.test(t))return true;
  if(/\bmodelo de prova\b/.test(t))return true;
  if(/^\s*(?:varejo|estagiari[oa]|estagio|auxiliar|assistente)\s*$/.test(t))return true;
  if(/\bauxiliar de producao\b/.test(t)&&!/grafic|design|comunicacao|marketing|conteudo|audiovisual/.test(t))return true;
  return false;
}

function creativeAdjacentFit(job,profile){
  const full=norm(job?.title||''),role=full.split(/\s+[-–—]\s+/)[0].trim(),body=norm(job?.description||'');
  if(!/(?:social media|marketing|publicidade|comunicacao|conteudo|midias? digitais?|e-?commerce|audiovisual)/.test(role))return false;
  if(/\b(?:gerente|coordenador|supervisor|senior|sr\.?|pleno|head|diretor|vendedor|telemarketing|comercial|administrativ|estoquista|financeiro)\b/.test(role))return false;
  const creative=/(?:cria|produ|desenvolv|edit|tratamento).{0,90}(?:arte|peca|layout|conteudo|post|rede social|instagram|tiktok|imagem|foto|video|material|identidade visual|campanha)|photoshop|canva|figma|indesign|design grafico|comunicacao visual|identidade visual/.test(body);
  if(!creative)return false;
  const profileText=norm(`${profile?.rawText||''} ${(profile?.skills||[]).join(' ')}`);
  return /design|photoshop|canva|figma|indesign|ux|ui|ilustr|marketing|social media|conteudo/.test(profileText);
}

const namedSoftware=[
  ['illustrator',['illustrator','adobe illustrator']],
  ['coreldraw',['coreldraw','corel draw']],
  ['premiere',['premiere','premiere pro','adobe premiere']],
  ['after effects',['after effects','adobe after effects']],
  ['autocad',['autocad','auto cad']],
  ['photoshop',['photoshop','adobe photoshop']],
  ['figma',['figma']],
  ['indesign',['indesign','in design','adobe indesign']],
  ['blender',['blender']],
  ['sketch',['sketch']]
];
function literalSoftwarePresent(profileText,aliases){
  const p=norm(profileText),compact=p.replace(/[^a-z0-9]/g,'');
  return aliases.some(alias=>{
    const a=norm(alias),ac=a.replace(/[^a-z0-9]/g,'');
    if(ac.length>=5&&compact.includes(ac))return true;
    const esc=a.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&').replace(/\s+/g,'\\s+');
    return new RegExp('(^|[^a-z0-9])'+esc+'([^a-z0-9]|$)','i').test(p);
  });
}
function requiredSoftwareMismatch(job,profileText){
  const body=norm(job?.description||'');
  for(const [name,aliases] of namedSoftware){
    const hit=aliases.map(norm).find(a=>body.includes(a));
    if(!hit)continue;
    const at=body.indexOf(hit),around=body.slice(Math.max(0,at-130),Math.min(body.length,at+hit.length+130));
    const desired=/desejavel|diferencial|preferencial|sera um plus|seria um plus/.test(around);
    const required=/obrigat|requisit|necessari|exigid|dominio|dominar|imprescindivel|fundamental|experiencia\s+com|deve\s+(?:ter|dominar)|precisa\s+(?:ter|dominar)/.test(around);
    if(required&&!desired&&!literalSoftwarePresent(profileText,aliases))return {software:name,context:around};
  }
  return null;
}

function fallbackDomainFit(job,profileText){
  const t=norm(job.title||''),p=norm(profileText||'');
  if(/design|figma|photoshop|indesign|\bux\b|\bui\b|canva|ilustr/.test(p))return /designer|design|\bux\b|\bui\b|web designer|product designer|arte[- ]?final|branding|comunicacao visual|social media|conteudo|marketing/.test(t);
  if(/marketing|social media|publicidade|comunicacao|conteudo/.test(p))return /marketing|social media|publicidade|comunicacao|conteudo|midia/.test(t);
  if(/javascript|typescript|python|react|node|java|software|programacao/.test(p))return /desenvolvedor|programador|frontend|backend|full.?stack|software|qa|dados/.test(t);
  if(/administrativ|secretari|recepcion/.test(p))return /administrativ|secretari|recepcion/.test(t);
  if(/vendas|comercial|atendimento/.test(p))return /vendas|vendedor|comercial|atendimento/.test(t);
  return false;
}

function targetRelevance(job,profile,filters){
  const title=norm(job.title||''),profileText=norm(`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`);
  const exclusions=Array.isArray(filters.searchExclusions)?filters.searchExclusions.map(norm).filter(Boolean):[];
  if(exclusions.some(x=>title.includes(x)))return {ok:false,boost:0,tier:'none'};
  if(entryMismatch(title,profileText)||specializationMismatch(job,profileText))return {ok:false,boost:0,tier:'none'};
  const softwareMismatch=requiredSoftwareMismatch(job,profileText);
  if(softwareMismatch)return {ok:false,boost:0,tier:'none',hardMismatch:['software obrigatório ausente: '+softwareMismatch.software]};
  if(/rio design|design barra|design shopping/.test(title)&&/vendedor|vendedora|caixa|operador|loja/.test(title))return {ok:false,boost:0,tier:'none'};
  if(/designer.{0,20}(sobrancelh|cilio|unha|estetic)/.test(title)&&!/sobrancelh|cilio|unha|estetic|beleza/.test(profileText))return {ok:false,boost:0,tier:'none'};

  const roleHead=String(job.title||'').split(/\s+[-–—]\s+/)[0]||String(job.title||'');
  const hasPlan=[...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchTargetTerms||[])].length>0;
  const approved=hasPlan?(approvedRoleFit(roleHead,filters)||creativeAdjacentFit(job,profile)):fallbackDomainFit(job,profileText);
  if(genericOffTrackMismatch(roleHead,filters)||primaryRoleMismatch(roleHead,filters)||!approved)return {ok:false,boost:0,tier:'none'};

  const profileWords=words(profileText),bodyWords=words(professionalJobText(job)),roleWords=words(roleHead);
  const roleProfile=[...roleWords].filter(x=>profileWords.has(x)).length;
  const bodyProfile=[...bodyWords].filter(x=>profileWords.has(x)).length;
  const titleTermHits=Number(job.searchTitleHits||0),bodyTermHits=Number(job.searchBodyHits||0);
  const termBoost=Math.min(0.52,0.18+titleTermHits*0.2+Math.min(bodyTermHits,4)*0.035);
  const profileBoost=Math.min(0.14,roleProfile*0.06+Math.min(bodyProfile,3)*0.02);
  return {ok:true,boost:termBoost+profileBoost,tier:coreRoleFit(roleHead,filters)?'core':'target'};
}

function areaCompatibility(job,areaText){
  const directed=String(areaText||'').trim();
  if(!directed)return {ok:true,boost:0};
  const areaWords=words(directed),titleWords=words(job.title||''),bodyWords=words(`${job.title||''} ${job.description||''}`);
  const titleOverlap=[...areaWords].filter(x=>titleWords.has(x)).length;
  const bodyOverlap=[...areaWords].filter(x=>bodyWords.has(x)).length;
  return {ok:true,boost:Math.min(0.24,titleOverlap*0.1+bodyOverlap*0.035)};
}

export function rankJobs(jobs,profile,filters){
  const profileText=`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`,pWords=words(profileText),minScore=Number(filters.minScore??0.04);
  return jobs.map(job=>{
    const flags=inferFlags(job),jw=words(professionalJobText(job));
    const overlap=[...jw].filter(x=>pWords.has(x)).length;
    const base=overlap/Math.max(7,Math.min(jw.size,pWords.size||7));
    const area=areaCompatibility(job,filters.area||''),target=targetRelevance(job,profile,filters),locBoost=locationBoost(job,filters,flags);
    const professionalScore=Math.min(1,base+area.boost+target.boost);
    return {...job,...flags,areaMatch:area.ok,targetMatch:target.ok,compatibilityTier:target.tier||'none',hardMismatch:target.hardMismatch||job.hardMismatch,professionalScore,score:Math.min(1,professionalScore+locBoost)};
  }).filter(job=>job.areaMatch&&job.targetMatch&&job.professionalScore>=minScore)
    .filter(job=>pcdOk(job,filters.pcdMode||'exclude'))
    .filter(job=>workModeOk(job,filters.workMode||'include_remote'))
    .filter(job=>locationOk(job,filters,job))
    .filter(job=>experienceOk(job,filters))
    .filter(job=>contractOk(job,filters))
    .sort((a,b)=>b.score-a.score);
}

function needsAIReview(job,filters){
  const title=String(job?.title||'').split(/\s+[-–—]\s+/)[0]||String(job?.title||'');
  const body=norm(job?.description||'');
  const direct=coreRoleFit(title,filters);
  const complex=/experi[eê]ncia|obrigat|requisit|imprescind|desejavel|conhecimento|dominio|formacao|superior completo|graduado|bacharel/.test(body);
  return !direct||complex;
}

function literalSkills(profile){
  const raw=norm(profile?.rawText||''),compact=raw.replace(/[^a-z0-9]/g,'');
  return (Array.isArray(profile?.skills)?profile.skills:[]).filter(skill=>{
    const k=norm(skill),kc=k.replace(/[^a-z0-9]/g,'');
    if(kc.length>=5&&compact.includes(kc))return true;
    const esc=k.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&').replace(/\s+/g,'\\s+');
    return new RegExp('(^|[^a-z0-9])'+esc+'([^a-z0-9]|$)','i').test(raw);
  });
}

export async function reviewVerifiedJobsWithAI(jobs,profile,filters,{maxJobs=600,batchSize=6}={}){
  const eligible=jobs.filter(j=>j.sendable===1).slice(0,Math.max(0,maxJobs));
  if(!eligible.length)return jobs;
  const directSet=new Set(eligible.filter(j=>!needsAIReview(j,filters)));
  const verified=eligible.filter(j=>needsAIReview(j,filters));
  if(!verified.length)return jobs.map(j=>directSet.has(j)?{...j,aiReviewed:true,reviewMethod:'rules',aiReason:'Compatibilidade direta validada por requisitos objetivos e evidência do currículo.'}:j);

  const byKey=new Map(),cv=String(profile?.rawText||'').slice(0,14000),skills=literalSkills(profile);
  const literalEvidence=String(profile?.rawText||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.length>2).slice(0,80);

  const askBatch=async entries=>{
    const items=entries.map(({job,index})=>({id:String(index),title:job.title||'',company:job.company||'',location:job.location||'',contract:job.contractType||'',description:String(job.description||'').replace(/\s+/g,' ').slice(0,3000)}));
    const system='Avalie candidaturas de forma factual e conservadora. Decida se há candidatura profissional defensável e verdadeira. Rejeite apenas por incompatibilidade objetiva: função fora da área compatível, senioridade ou experiência obrigatória não comprovada, formação obrigatória incompatível, software/requisito técnico obrigatório ausente, PCD exclusivo incompatível ou outra exigência objetiva. Itens desejáveis não bastam para rejeitar. Nunca transforme ilustração/illustration em Adobe Illustrator nem palavras parecidas em software. Nunca invente experiência, ferramenta, curso, formação, senioridade ou resultado. Retorne somente JSON válido.';
    const prompt='CURRÍCULO:\n'+cv+'\n\nCOMPETÊNCIAS COMPROVADAS:\n'+JSON.stringify(skills)+'\n\nEVIDÊNCIA DO CURRÍCULO:\n'+JSON.stringify(literalEvidence)+'\n\nFILTROS:\n'+JSON.stringify({experienceLevel:filters?.experienceLevel||'',contractTypes:filters?.contractTypes||[],pcdMode:filters?.pcdMode||'',locationScope:filters?.locationScope||'',cities:filters?.cities||[],states:filters?.states||[],nationwide:!!filters?.nationwide})+'\n\nVAGAS:\n'+JSON.stringify(items)+'\n\nRetorne exatamente {"results":[{"id":"0","eligible":true,"reason":"curta","hardMismatch":[]}]}. Dê um resultado para TODOS os ids.';
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const parsed=parseJsonLoose(await askAI(system,prompt,{candidateId:profile?.candidateId}))||{};
        const rows=Array.isArray(parsed.results)?parsed.results:[];
        if(rows.length)return rows;
        lastError=new Error('AI retornou lote vazio');
      }catch(e){lastError=e;}
      await new Promise(r=>setTimeout(r,700*(attempt+1)));
    }
    console.error('[ranking] AI review batch failed',entries.map(x=>x.index).join(','),String(lastError?.message||lastError||''));
    return [];
  };

  const entries=verified.map((job,index)=>({job,index})),size=Math.max(3,Math.min(6,Number(batchSize||6)));
  for(let offset=0;offset<entries.length;offset+=size){
    const batch=entries.slice(offset,offset+size),rows=await askBatch(batch);
    for(const row of rows){
      const idx=Number(row?.id),entry=batch.find(x=>x.index===idx);
      if(!entry)continue;
      byKey.set(entry.job,{eligible:row?.eligible!==false,reason:String(row?.reason||'').slice(0,320),hardMismatch:Array.isArray(row?.hardMismatch)?row.hardMismatch.slice(0,6):[]});
    }
    for(const entry of batch.filter(x=>!byKey.has(x.job))){
      const retry=await askBatch([entry]);
      const row=retry.find(x=>Number(x?.id)===entry.index);
      if(row)byKey.set(entry.job,{eligible:row?.eligible!==false,reason:String(row?.reason||'').slice(0,320),hardMismatch:Array.isArray(row?.hardMismatch)?row.hardMismatch.slice(0,6):[]});
    }
  }

  return jobs.map(job=>{
    if(job.sendable!==1)return job;
    if(directSet.has(job))return {...job,aiReviewed:true,reviewMethod:'rules',aiReason:'Compatibilidade direta validada por requisitos objetivos e evidência do currículo.'};
    const review=byKey.get(job);
    if(!review)return {...job,sendable:0,reason:'AI_REVIEW_FAILED',verified:true,aiReviewed:false};
    if(review.eligible)return {...job,aiReviewed:true,reviewMethod:'ai',aiReason:review.reason};
    return {...job,sendable:0,reason:'AI_INCOMPATIBLE',verified:true,aiReviewed:true,reviewMethod:'ai',aiReason:review.reason,hardMismatch:review.hardMismatch};
  });
}

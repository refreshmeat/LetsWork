import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { storage } from '../storage.mjs';
import { askAI, parseJsonLoose } from './ai.mjs';

const stop=new Set('de da do das dos e em para com por a o as os um uma vaga vagas trabalho emprego'.split(' '));
function fixMojibake(value){
  return String(value||'')
    .replace(/á/g,'á').replace(/à /g,'à').replace(/ã/g,'ã').replace(/â/g,'â')
    .replace(/é/g,'é').replace(/ê/g,'ê').replace(/í/g,'í')
    .replace(/ó/g,'ó').replace(/ô/g,'ô').replace(/õ/g,'õ').replace(/ú/g,'ú')
    .replace(/ç/g,'ç').replace(/Á/g,'Á').replace(/À/g,'À').replace(/Ã/g,'Ã')
    .replace(/É/g,'É').replace(/Ê/g,'Ê').replace(/Í/g,'Í').replace(/Ó/g,'Ó')
    .replace(/Ô/g,'Ô').replace(/Õ/g,'Õ').replace(/Ú/g,'Ú').replace(/Ç/g,'Ç')
    .replace(/–|—/g,'-').replace(/"|"/g,'"').replace(/'/g,"'").replace(/Â/g,'');
}
const norm=s=>fixMojibake(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
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

function effectiveLocationText(job){
  const loc=String(job?.location||'').trim();
  const desc=String(job?.description||'');
  const city=desc.match(/\bCidade\s*:\s*([^;\n.]{2,80})/i)?.[1]?.trim()||'';
  const neighborhood=desc.match(/\bBairro\s*:\s*([^;\n.]{2,80})/i)?.[1]?.trim()||'';
  const suspicious=!loc||/^(?:sem experiencia|sem experi[eê]ncia|[0-9]+\s*vagas?|a combinar|pretens[aã]o salarial)$/i.test(loc);
  return [suspicious?'':loc,neighborhood,city,job?.title||''].filter(Boolean).join(' ');
}

const rjOtherMunicipality=/\b(?:niteroi|duque de caxias|nova iguacu|sao goncalo|nilopolis|sao joao de meriti|belford roxo|mesquita|queimados|japeri|seropedica|itaguai|mage|guapimirim|itabora[ií]|marica|tangua|petropolis|teresopolis|nova friburgo|volta redonda|barra mansa|resende|macae|campos dos goytacazes|cabo frio|araruama|saquarema|rio das ostras|angra dos reis|paraty)\b/;
function rioVagasRioCityInference(job,cities){
  const wantsRio=cities.some(x=>norm(x)==='rio de janeiro');
  if(!wantsRio||!/^RioVagas$/i.test(job.source||''))return false;
  const loc=norm(effectiveLocationText(job));
  if(!loc)return true;
  return !rjOtherMunicipality.test(loc);
}

function locationOk(job,filters,flags){
  if(filters.nationwide)return true;
  if(flags.remote&&filters.workMode!=='onsite_only')return remoteRegionOk(job,filters);
  const text=norm(effectiveLocationText(job)).replace(/rio de jan\.{2,}/g,'rio de janeiro');
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
  const text=norm(effectiveLocationText(job)).replace(/rio de jan\.{2,}/g,'rio de janeiro');
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
function plannedSpecialtyMismatch(job,filters){
  const role=norm(roleHeadOf(job?.title||''));
  const plan=norm([...(filters?.searchFamilies||[]),...(filters?.searchCoreTerms||[]),...(filters?.searchAdjacentTerms||[]),...(filters?.searchLiteralTerms||[])].join(' '));
  const rules=[
    {hits:['nail','lash','cilios','sobrancelha','manicure','pedicure'],support:['nail','lash','cilios','sobrancelha','estetica','manicure','pedicure']},
    {hits:['designer de interior','design de interior','interiorista'],support:['interior','interiores','interiorista','arquitetura']},
    {hits:['designer de moda','design de moda','fashion design'],support:['moda','fashion']}
  ];
  return rules.some(rule=>rule.hits.some(x=>role.includes(x))&&!rule.support.some(x=>plan.includes(x)));
}
function plannedRoleMismatch(job,filters){
  const role=norm(roleHeadOf(job?.title||''));
  if(approvedRoleFit(role,filters))return false;
  const plan=norm([...(filters?.searchFamilies||[]),...(filters?.searchCoreTerms||[]),...(filters?.searchAdjacentTerms||[])].join(' '));
  const divergent=[
    {role:/\b(?:atendente|atendimento|recepcionista)\b/,plan:/\b(?:atendimento|recepcao|customer service|customer success)\b/},
    {role:/\b(?:assistente|auxiliar)\s+(?:administrativ[oa]|administracao)\b/,plan:/\b(?:administrativ|administracao|financeiro|rh|recursos humanos)\b/},
    {role:/\b(?:vendedor|vendedora|caixa)\b/,plan:/\b(?:vendas|comercial|varejo|caixa)\b/}
  ];
  return divergent.some(rule=>rule.role.test(role)&&!rule.plan.test(plan));
}
function plannedDomainMismatch(job,filters){
  const title=norm(job?.title||''),body=norm(job?.description||'');
  const plan=norm([...(filters?.searchFamilies||[]),...(filters?.searchCoreTerms||[]),...(filters?.searchAdjacentTerms||[]),...(filters?.searchLiteralTerms||[])].join(' '));
  const designPlan=/\b(?:design|designer|ux|ui|grafico|grafica|visual)\b/.test(plan);
  if(designPlan){
    const interiorPlan=/\b(?:interior|interiores|arquitetura|moveis|mobiliario|marcenaria|promob)\b/.test(plan);
    const furnitureDomain=/\b(?:marcenaria|marceneir[oa]|ajudante de marcenaria|moveis planejados|mobiliario|promob|projetista de moveis|montador(?:a)? de moveis)\b/.test(title+' '+body.slice(0,900));
    if(furnitureDomain&&!interiorPlan)return true;

    const manualTrade=/\b(?:ajudante|auxiliar)\s+(?:de\s+)?(?:marcenaria|serralheria|carpintaria|producao|montagem)\b/.test(title);
    if(manualTrade)return true;
  }
  return false;
}

function roleAliasSupported(role,filters){
  const r=norm(role),plan=norm([...(filters?.searchFamilies||[]),...(filters?.searchCoreTerms||[]),...(filters?.searchAdjacentTerms||[])].join(' '));
  if(/\b(?:atendente|atendimento|recepcionista|sac)\b/.test(r)&&/\b(?:atendimento|recepcao|customer service|customer success)\b/.test(plan))return true;
  if(/\b(?:auxiliar|assistente)\s+(?:administrativ[oa]|administracao|de escritorio)|\bapoio administrativo\b/.test(r)&&/\b(?:administrativ|administracao|apoio administrativo)\b/.test(plan))return true;
  if(/\b(?:operador(?:a)? de caixa|caixa)\b/.test(r)&&/\bcaixa\b/.test(plan))return true;
  if(/\b(?:vendedor|vendedora|assistente de vendas)\b/.test(r)&&/\b(?:vendas|comercial|varejo)\b/.test(plan))return true;
  return false;
}
function clearlyOffTrackRole(role,filters){
  const r=norm(role),plan=norm([...(filters?.searchFamilies||[]),...(filters?.searchCoreTerms||[]),...(filters?.searchAdjacentTerms||[])].join(' '));
  const groups=[
    {rx:/\b(?:servicos gerais|limpeza|faxina|copeir[oa]|chapeir[oa]|cozinheir[oa]|garcom|repositori?[oa]?)\b/,support:/\b(?:servicos gerais|limpeza|cozinha|gastronomia|reposicao|estoque)\b/},
    {rx:/\b(?:manutencao|mecanico|eletricista|tecnico de manutencao)\b/,support:/\b(?:manutencao|mecanica|eletrica)\b/},
    {rx:/\b(?:seguranca do trabalho|controlador de acesso|vigilante|porteiro)\b/,support:/\b(?:seguranca|portaria|vigilancia)\b/},
    {rx:/\b(?:auxiliar de producao|operador de producao)\b/,support:/\b(?:producao|industria)\b/}
  ];
  return groups.some(g=>g.rx.test(r)&&!g.support.test(plan));
}
function currentStudyActive(profileText){
  const lines=String(profileText||'').split(/\r?\n/).map(x=>norm(x)).filter(Boolean);
  if(!lines.length)return false;
  const active=/\b(?:cursando|matriculad[oa]|em\s+andamento|\d+[º°]?\s*(?:semestre|periodo)|previsao\s+(?:de\s+)?conclusao|conclusao\s+prevista|20\d{2}\s*(?:-|a|ate)\s*(?:atual|presente))\b/;
  const study=/\b(?:bacharelado|graduacao|licenciatura|tecnologo|universidade|faculdade|curso superior|curso tecnico|tecnico em|ensino medio)\b/;
  for(let i=0;i<lines.length;i++){
    if(!active.test(lines[i]))continue;
    const context=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+2)).join(' ');
    if(/\b(?:nao\s+cursando|matricula\s+trancada|curso\s+trancado|curso\s+interrompido)\b/.test(context))continue;
    if(!study.test(context))continue;
    const onlyCompletedSecondary=/ensino medio[^.]{0,100}(?:completo|concluido)/.test(context)&&!/bacharelado|graduacao|licenciatura|tecnologo|universidade|faculdade|curso superior|curso tecnico|tecnico em/.test(context);
    if(onlyCompletedSecondary)continue;
    return true;
  }
  return false;
}
function higherEducationActive(profileText){
  const lines=String(profileText||'').split(/\r?\n/).map(x=>norm(x)).filter(Boolean);
  const higher=/\b(?:bacharelado|graduacao|licenciatura|tecnologo|universidade|faculdade|curso superior)\b/;
  const active=/\b(?:cursando|matriculad[oa]|em\s+andamento|\d+[º°]?\s*(?:semestre|periodo)|previsao\s+(?:de\s+)?conclusao|conclusao\s+prevista|20\d{2}\s*(?:-|a|ate)\s*(?:atual|presente))\b/;
  for(let i=0;i<lines.length;i++){
    const context=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+2)).join(' ');
    if(higher.test(context)&&active.test(context))return true;
  }
  return false;
}
function completedHigherEducation(profileText){
  const t=norm(profileText||'');
  return /\b(?:bacharelado|graduacao|licenciatura|tecnologo|curso superior)[^\n]{0,140}\b(?:concluido|concluida|completo|completa|finalizado|finalizada)\b/.test(t)||/\b(?:concluido|concluida|completo|completa|finalizado|finalizada)[^\n]{0,140}\b(?:bacharelado|graduacao|licenciatura|tecnologo|curso superior)\b/.test(t);
}
function requiresMandatoryActiveHigherEducation(value){
  const text=norm(value||'');
  const segments=text.split(/[.;\n]+/).map(x=>x.trim()).filter(Boolean);
  for(const segment of segments){
    const mentionsHigher=/\b(?:ensino superior|faculdade|graduacao|curso superior)\b/.test(segment);
    const active=/\b(?:cursando|em andamento|matriculad[oa]|estudante|periodo|semestre|previsao[^.]{0,40}(?:formatura|conclusao))\b/.test(segment);
    if(!mentionsHigher||!active)continue;
    if(/\b(?:desejavel|preferencial|preferencialmente|diferencial|sera um diferencial)\b/.test(segment))continue;
    const secondaryAlternative=/\bensino medio\b.{0,80}\bou\b.{0,100}\b(?:ensino superior|faculdade|graduacao|curso superior)\b|\b(?:ensino superior|faculdade|graduacao|curso superior)\b.{0,80}\bou\b.{0,100}\bensino medio\b/.test(segment);
    if(secondaryAlternative)continue;
    return true;
  }
  return false;
}

const genericRoleTokens=new Set('estagio estagiario estagiaria assistente auxiliar analista junior jr trainee vaga area professor professora monitor monitora mediador mediadora inspetor inspetora secretario secretaria recepcionista atendente agente operador operadora especialista consultor consultora coordenador coordenadora supervisor supervisora gerente diretor diretora orientador orientadora'.split(' ').map(stem));
const contextualRoleTokens=new Set([...genericRoleTokens,...'cuidador cuidadora educador educadora recreador recreadora bercarista acompanhante tutor tutora apoio'.split(' ').map(stem)]);
const bodyRescueRoleTokens=new Set('estagio estagiario estagiaria assistente auxiliar analista professor professora monitor monitora mediador mediadora inspetor inspetora agente cuidador cuidadora educador educadora recreador recreadora bercarista acompanhante tutor tutora apoio'.split(' ').map(stem));
function roleTokens(value){
  return new Set(norm(value).split(/[^a-z0-9+#.]+/).map(stem).filter(x=>x.length>=2&&!stop.has(x)));
}
const conceptKeyCache=new Map();
function conceptKey(value){
  const raw=String(value||'');
  if(conceptKeyCache.has(raw))return conceptKeyCache.get(raw);
  const key=stem(norm(raw).replace(/[^a-z0-9+#.]+/g,''));
  if(conceptKeyCache.size>12000)conceptKeyCache.clear();
  conceptKeyCache.set(raw,key);
  return key;
}
function conceptTokenMatch(a,b){
  const x=conceptKey(a),y=conceptKey(b);
  if(!x||!y)return false;
  if(x===y)return true;
  // Avoid derivational collisions such as "projeto" x "projetista".
  if((/ist$/.test(x)!==/ist$/.test(y))||(/log$/.test(x)!==/log$/.test(y)))return false;
  const min=Math.min(x.length,y.length);
  if(min<5)return false;
  let common=0;
  while(common<min&&x[common]===y[common])common++;
  return common>=5&&common/min>=0.62;
}
function conceptSetHas(set,token){
  for(const value of set||[])if(conceptTokenMatch(value,token))return true;
  return false;
}

function structuralRoleTokens(value){
  return new Set([...roleTokens(value)].filter(x=>genericRoleTokens.has(x)));
}
function rolePhraseMatch(text,term){
  const phrase=norm(term).trim();
  if(phrase.length<2)return false;
  const esc=phrase.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&').replace(/\s+/g,'\\s+');
  return new RegExp('(^|[^a-z0-9])'+esc+'([^a-z0-9]|$)','i').test(norm(text));
}
function explicitRoleFit(value,terms){
  const role=norm(value).trim();
  if(!role||!terms.length)return false;
  const roleSet=roleTokens(role),roleStructural=structuralRoleTokens(role);
  for(const raw of terms){
    const term=norm(raw).trim();
    if(term.length<2)continue;
    // A expressão completa no título é sempre evidência forte.
    if(rolePhraseMatch(role,term))return true;
    const termTokens=roleTokens(term);
    const meaningful=[...termTokens].filter(x=>!genericRoleTokens.has(x));
    if(meaningful.length>=2&&meaningful.every(x=>conceptSetHas(roleSet,x)))return true;
    if(meaningful.length===1&&conceptSetHas(roleSet,meaningful[0])){
      const termStructural=structuralRoleTokens(term);
      // Uma única palavra de domínio só vale se o tipo estrutural do cargo também combinar.
      if(!termStructural.size||[...termStructural].some(x=>roleStructural.has(x)))return true;
    }
  }
  return false;
}
function approvedRoleFit(roleHead,filters){
  return explicitRoleFit(roleHead,[...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchTargetTerms||[])]);
}
function coreRoleFit(roleHead,filters){
  const role=norm(roleHead).trim();
  if(!role)return false;
  const roleSet=roleTokens(role);
  const roleKinds=new Set([...roleSet].filter(x=>genericRoleTokens.has(x)));
  for(const raw of filters.searchCoreTerms||[]){
    const term=norm(raw).trim();
    if(!term)continue;
    if(rolePhraseMatch(role,term)||rolePhraseMatch(term,role))return true;
    const termSet=roleTokens(term);
    const termKinds=new Set([...termSet].filter(x=>genericRoleTokens.has(x)));
    const meaningful=[...termSet].filter(x=>!genericRoleTokens.has(x));
    const kindMatch=termKinds.size===0||[...termKinds].some(x=>roleKinds.has(x));
    if(kindMatch&&meaningful.length>=1&&meaningful.every(x=>conceptSetHas(roleSet,x)))return true;
  }
  return false;
}
function roleHeadOf(title){
  const raw=String(title||'').trim();
  if(!raw)return '';
  const parts=raw.split(/\s+(?:-|\u2013|\u2014|–|—|–|—)\s+/);
  return (parts[0]||raw).trim();
}

function candidateExclusionTerms(filters){
  return Array.isArray(filters?.searchExclusions)?filters.searchExclusions.map(x=>String(x||'').trim()).filter(Boolean):[];
}
function roleExcludedByPlan(value,filters){
  const exclusions=candidateExclusionTerms(filters);
  if(!exclusions.length)return false;
  return explicitRoleFit(value,exclusions)||exclusions.some(term=>rolePhraseMatch(value,term));
}
function primaryRoleMismatch(roleHead,filters){
  const primary=String(roleHead||'').split(/\s+(?:e|&)\s+|\/|,/i)[0].trim();
  return roleExcludedByPlan(primary,filters)&&!approvedRoleFit(primary,filters);
}
function genericOffTrackMismatch(title,filters){
  return roleExcludedByPlan(title,filters)&&!approvedRoleFit(title,filters);
}
function entryMismatch(title,profileText){
  const t=norm(title),higher=higherEducationActive(profileText);
  const internship=/\b(?:estagio|estagiari[oa])\b/.test(t);
  if(internship&&!currentStudyActive(profileText))return true;
  if(higher&&/(?:estagio|estagiari[oa]).{0,18}ensino medio|ensino medio.{0,18}(?:estagio|estagiari[oa])/.test(t))return true;
  if(higher&&/\b(?:jovem\s+aprendiz|pessoa\s+jovem\s+aprendiz|aprendiz)\b/.test(t))return true;
  if(/\bmodelo de prova\b/.test(t))return true;
  if(/^\s*(?:varejo|estagiari[oa]|estagio|auxiliar|assistente)\s*$/.test(t))return true;
  return false;
}

function adjacentPlanFit(job,filters){
  const roleHead=roleHeadOf(job?.title);
  const adjacent=[...(filters.searchFamilies||[]),...(filters.searchAdjacentTerms||[])];
  if(explicitRoleFit(roleHead,adjacent))return true;
  const lex=careerFamilyLexicon(filters);
  const titleHits=lexiconHits(roleHead,lex.strong);
  if(titleHits.length>=2)return true;
  const genericTitle=/\b(?:assistente|auxiliar|analista|estagio|estagiario|estagiaria|trainee|junior|jr\.?|tecnico|tecnica|operador|operadora|especialista)\b/.test(norm(roleHead));
  if(!genericTitle)return false;
  const bodyHits=lexiconHits(professionalJobText(job),lex.strong);
  return bodyHits.length>=2;
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
  ['sketchup',['sketchup','sketch up']],
  ['obs studio',['obs studio','obs']],
  ['capcut',['capcut','cap cut']],
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
  const title=norm(roleHeadOf(job?.title||''));
  for(const [name,aliases] of namedSoftware){ if(aliases.some(alias=>title.includes(norm(alias)))&&!literalSoftwarePresent(profileText,aliases))return {software:name,context:title}; }
  const body=norm(job?.description||'');
  const segments=body.split(/(?:[.;]|\s+-\s+|\n)+/).map(x=>x.trim()).filter(Boolean);
  for(const [name,aliases] of namedSoftware){
    const hits=segments.filter(segment=>aliases.some(alias=>segment.includes(norm(alias))));
    for(const around of hits){
      const desired=/desejavel|diferencial|preferencial|sera um plus|seria um plus/.test(around);
      const required=/obrigat|requisit|necessari|exigid|dominio|dominar|imprescindivel|fundamental|experiencia\s+com|deve\s+(?:ter|dominar)|precisa\s+(?:ter|dominar|saber|conhecer)|o que voce precisa saber/.test(around);
      if(!required||desired)continue;
      const alternatives=namedSoftware.filter(([,candidateAliases])=>candidateAliases.some(alias=>around.includes(norm(alias))));
      const alternativeGroup=/\b(?:ou|e\/ou)\b/.test(around)&&alternatives.length>=2;
      const alternativeSatisfied=alternativeGroup&&alternatives.some(([,candidateAliases])=>literalSoftwarePresent(profileText,candidateAliases));
      if(!alternativeSatisfied&&!literalSoftwarePresent(profileText,aliases))return {software:name,context:around};
    }
  }
  return null;
}

function fallbackDomainFit(job,profileText){
  const role=words(roleHeadOf(job?.title)),profileWords=words(profileText);
  const roleOverlap=[...role].filter(x=>profileWords.has(x)).length;
  // Sem plano profissional validado, não abra carreira nova usando apenas palavras do corpo da vaga.
  // O corpo pode conter "atendimento", "organização" etc. em profissões totalmente diferentes.
  return roleOverlap>=1;
}

function broadAgenticFit(job,profile,filters){
  const title=norm(job?.title||''),profileText=norm(String(profile?.rawText||'')+' '+(profile?.skills||[]).join(' '));
  if(!title||entryMismatch(title,profileText))return false;
  const roleHead=roleHeadOf(job.title);
  const hasPlan=[...(filters.searchFamilies||[]),...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchTargetTerms||[])].length>0;
  if(hasPlan&&roleExcludedByPlan(roleHead,filters)&&!approvedRoleFit(roleHead,filters))return false;
  if(String(filters.experienceLevel||'entry').toLowerCase()==='entry'&&/\b(?:gerente|coordenador|coordenadora|supervisor|supervisora|senior|sr\.?|pleno|head|diretor|diretora|lead|principal|staff)\b/.test(title))return false;
  if(hasPlan&&(approvedRoleFit(roleHead,filters)||adjacentPlanFit(job,filters)))return true;
  return !hasPlan&&fallbackDomainFit(job,profileText);
}
function targetRelevance(job,profile,filters){
  const title=norm(job.title||''),profileText=norm(String(profile.rawText||'')+' '+(profile.skills||[]).join(' '));
  const roleHead=roleHeadOf(job.title);
  const planTerms=[...(filters.searchFamilies||[]),...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchTargetTerms||[])];
  const hasPlan=planTerms.length>0;

  if(entryMismatch(title,profileText))return {ok:false,boost:0,tier:'none'};
  if(!hasPlan&&specializationMismatch(job,profileText))return {ok:false,boost:0,tier:'none'};

  const softwareMismatch=requiredSoftwareMismatch(job,profileText);
  if(softwareMismatch)return {ok:false,boost:0,tier:'none',hardMismatch:['software obrigatorio ausente: '+softwareMismatch.software]};

  const approved=hasPlan?(approvedRoleFit(roleHead,filters)||adjacentPlanFit(job,filters)):fallbackDomainFit(job,profileText);
  const excluded=hasPlan&&roleExcludedByPlan(roleHead,filters);
  if((excluded&&!approved)||!approved)return {ok:false,boost:0,tier:'none'};

  const profileWords=words(profileText),bodyWords=words(professionalJobText(job)),roleWords=words(roleHead);
  const roleProfile=[...roleWords].filter(x=>profileWords.has(x)).length;
  const bodyProfile=[...bodyWords].filter(x=>profileWords.has(x)).length;
  const titleTermHits=Number(job.searchTitleHits||0),bodyTermHits=Number(job.searchBodyHits||0);
  const termBoost=Math.min(0.52,0.18+titleTermHits*0.2+Math.min(bodyTermHits,4)*0.035);
  const profileBoost=Math.min(0.14,roleProfile*0.06+Math.min(bodyProfile,3)*0.02);
  const tier=coreRoleFit(roleHead,filters)?'core':(explicitRoleFit(roleHead,[...(filters.searchAdjacentTerms||[]),...(filters.searchFamilies||[])])?'adjacent':'target');
  return {ok:true,boost:termBoost+profileBoost,tier};
}
function areaCompatibility(job,areaText){
  const directed=String(areaText||'').trim();
  if(!directed)return {ok:true,boost:0};
  const areaWords=words(directed),titleWords=words(job.title||''),bodyWords=words(`${job.title||''} ${job.description||''}`);
  const titleOverlap=[...areaWords].filter(x=>titleWords.has(x)).length;
  const bodyOverlap=[...areaWords].filter(x=>bodyWords.has(x)).length;
  return {ok:true,boost:Math.min(0.24,titleOverlap*0.1+bodyOverlap*0.035)};
}


const aiPrefilterGenericTokens=new Set('estagio estagiario estagiaria assistente auxiliar analista junior jr trainee vaga vagas area para de da do das dos em com e ou profissional oportunidade criativo criativa professor professora monitor monitora mediador mediadora inspetor inspetora secretario secretaria recepcionista atendente agente operador operadora especialista consultor consultora coordenador coordenadora supervisor supervisora gerente diretor diretora orientador orientadora'.split(' ').map(stem));
const aiPrefilterAmbiguousTokens=new Set();
function careerFamilyLexicon(filters){
  const direct=[...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[])];
  const source=[...(filters.searchFamilies||[]),...direct,...(filters.searchQueries||[]),...(filters.searchTargetTerms||[])];
  const counts=new Map(),directTokens=new Set();
  const tokenize=raw=>[...new Set(norm(raw).split(/[^a-z0-9+#]+/).map(stem).filter(x=>x.length>=2&&!aiPrefilterGenericTokens.has(x)))];
  for(const raw of direct)for(const token of tokenize(raw))directTokens.add(token);
  for(const raw of source)for(const token of tokenize(raw))counts.set(token,(counts.get(token)||0)+1);
  const strong=[...counts.entries()].filter(([token,count])=>(count>=2||directTokens.has(token))&&!aiPrefilterAmbiguousTokens.has(token)).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  const supporting=[...counts.entries()].filter(([token,count])=>count>=2||directTokens.has(token)).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  return {strong,supporting};
}
function lexiconHits(text,tokens){
  const set=words(text);
  return tokens.filter(token=>set.has(stem(token)));
}
export function prefilterJobsForAI(jobs,profile,filters){
  const profileText=String(profile.rawText||'')+' '+(profile.skills||[]).join(' '),pWords=words(profileText);
  const hasPlan=[...(filters.searchFamilies||[]),...(filters.searchCoreTerms||[]),...(filters.searchAdjacentTerms||[]),...(filters.searchLiteralTerms||[])].length>0;

  const compileTerms=list=>(list||[]).map(raw=>{
    const phrase=norm(raw).replace(/[^a-z0-9+#.]+/g,' ').trim();
    const tokens=roleTokens(raw);
    const kinds=new Set([...tokens].filter(x=>genericRoleTokens.has(x)));
    const meaningful=[...tokens].filter(x=>!genericRoleTokens.has(x));
    return {raw:String(raw||''),phrase,kinds,meaningful};
  }).filter(x=>x.phrase);
  const coreTerms=compileTerms(filters.searchCoreTerms);
  const adjacentTerms=compileTerms([...(filters.searchFamilies||[]),...(filters.searchAdjacentTerms||[])]);
  const literalTerms=compileTerms(filters.searchLiteralTerms);
  const planTerms=[...coreTerms,...adjacentTerms,...literalTerms];
  const exclusionTerms=compileTerms(filters.searchExclusions);
  const planTokenSet=new Set(planTerms.flatMap(x=>x.meaningful));
  const tokenCounts=new Map();
  for(const term of [...coreTerms,...adjacentTerms]){
    for(const token of new Set(term.meaningful))tokenCounts.set(token,(tokenCounts.get(token)||0)+1);
  }
  const recurrentPlanTokens=new Set([...tokenCounts].filter(([,n])=>n>=2).map(([token])=>token));

  const fitTitle=(roleNorm,roleSet,roleKinds,terms,{relaxKinds=false}={})=>{
    const padded=' '+roleNorm.replace(/[^a-z0-9+#.]+/g,' ').trim()+' ';
    for(const term of terms){
      if(term.phrase.length>=3&&padded.includes(' '+term.phrase+' '))return true;
      if(term.meaningful.length>=2&&term.meaningful.every(x=>conceptSetHas(roleSet,x)))return true;
      if(term.meaningful.length===1&&conceptSetHas(roleSet,term.meaningful[0])){
        if(relaxKinds||!term.kinds.size||[...term.kinds].some(x=>roleKinds.has(x)))return true;
      }
    }
    return false;
  };
  const bodyContextHits=(bodyNorm,bodySet,terms)=>{
    const padded=' '+bodyNorm.replace(/[^a-z0-9+#.]+/g,' ').trim()+' ',out=[],seen=new Set();
    for(const term of terms){
      let hit=false;
      if(term.phrase.length>=5&&padded.includes(' '+term.phrase+' '))hit=true;
      else if(term.meaningful.length===1)hit=term.meaningful[0].length>=5&&conceptSetHas(bodySet,term.meaningful[0]);
      else hit=term.meaningful.length>=2&&term.meaningful.every(x=>conceptSetHas(bodySet,x));
      if(!hit)continue;
      const key=term.meaningful.map(stem).sort().join('|')||term.phrase;
      if(!seen.has(key)){seen.add(key);out.push(term);}
    }
    return out;
  };

  return jobs.map(job=>{
    const roleHead=roleHeadOf(job.title),roleNorm=norm(roleHead);
    if(!roleNorm||entryMismatch(roleHead,profileText))return null;
    if(specializationMismatch(job,profileText)||plannedSpecialtyMismatch(job,filters)||plannedRoleMismatch(job,filters)||plannedDomainMismatch(job,filters)||clearlyOffTrackRole(roleHead,filters))return null;
    if(String(filters.experienceLevel||'entry').toLowerCase()==='entry'&&/\b(?:gerente|coordenador|coordenadora|supervisor|supervisora|senior|sr\.?|pleno|head|diretor|diretora|lead|principal|staff)\b/.test(roleNorm))return null;

    const roleSet=roleTokens(roleHead);
    const roleKinds=new Set([...roleSet].filter(x=>genericRoleTokens.has(x)));
    const roleSpecific=[...roleSet].filter(x=>!genericRoleTokens.has(x));
    const roleProfileHits=roleSpecific.filter(x=>conceptSetHas(pWords,x));
    const roleRecurringHits=roleSpecific.filter(x=>conceptSetHas(recurrentPlanTokens,x));
    const roleSpecificPlanHits=roleSpecific.filter(x=>conceptSetHas(planTokenSet,x));
    const orderedRoleTokens=norm(roleHead).split(/[^a-z0-9+#.]+/).map(stem).filter(x=>x.length>=2&&!stop.has(x));
    const firstRoleToken=orderedRoleTokens[0]||'';
    const contextualRoleHead=genericRoleTokens.has(firstRoleToken)||contextualRoleTokens.has(firstRoleToken);
    const firstRoleSupported=contextualRoleHead||conceptSetHas(planTokenSet,firstRoleToken)||conceptSetHas(pWords,firstRoleToken);

    const core=fitTitle(roleNorm,roleSet,roleKinds,coreTerms);
    const literal=fitTitle(roleNorm,roleSet,roleKinds,literalTerms);
    const treeAdjacent=fitTitle(roleNorm,roleSet,roleKinds,adjacentTerms,{relaxKinds:true});
    const aliasDirect=roleAliasSupported(roleHead,filters);
    const adjacent=core||literal||treeAdjacent||aliasDirect;
    const exclusionHit=hasPlan&&fitTitle(roleNorm,roleSet,roleKinds,exclusionTerms);
    if(exclusionHit&&!adjacent)return null;
    if(!firstRoleSupported&&!core&&!literal)return null;
    // A palavra de domínio no fim do título não transforma outra profissão na carreira do candidato.
    // Ex.: "Porteiro Escolar" ou "Engenheiro ... Escola" não viram vaga pedagógica.
    if(treeAdjacent&&!core&&!literal&&!contextualRoleHead&&roleSpecific.length&&!roleSpecificPlanHits.length&&!roleProfileHits.length)return null;

    let bodyHits=[],bodyOnlyCandidate=false;
    if(!adjacent){
      const bodyNorm=norm(job.description||''),bodySet=words(job.description||'');
      bodyHits=bodyContextHits(bodyNorm,bodySet,planTerms);
      if(!bodyHits.length)return null;
      // Contexto da empresa não basta para abrir outra profissão.
      // Cargos estruturais ("auxiliar", "monitor", etc.) podem usar o corpo da vaga,
      // mas um complemento profissional estranho precisa ter apoio no currículo/plano.
      if(!bodyRescueRoleTokens.has(firstRoleToken)&&!roleProfileHits.length)return null;
      const titleEvidence=roleRecurringHits.length||roleSpecificPlanHits.length||roleProfileHits.length||roleAliasSupported(roleHead,filters);
      if(!titleEvidence)return null;
      if(roleSpecific.length&&!roleSpecificPlanHits.length&&!roleProfileHits.length&&!roleRecurringHits.length){
        const bareContextRole=roleSpecific.length===1&&bodyRescueRoleTokens.has(roleSpecific[0])&&bodyHits.length>=2;
        if(!bareContextRole)return null;
      }
      bodyOnlyCandidate=true;
    }

    const flags=inferFlags(job);
    if(!pcdOk(flags,filters.pcdMode||'exclude')||!workModeOk(flags,filters.workMode||'include_remote')||!locationOk(job,filters,flags)||!contractOk(flags,filters))return null;
    const experienceMismatch=!experienceOk(job,filters);
    if(experienceMismatch)return null;
    const softwareMismatch=requiredSoftwareMismatch(job,profileText);
    if(softwareMismatch)return null;
    const requirementText=norm(job.description||'');
    const requiresCompletedHigher=/\b(?:ensino|nivel|curso)\s+superior\s+completo\b|\bgraduacao\s+(?:completa|concluida)\b|\bformacao\s+superior\s+completa\b/.test(requirementText);
    if(requiresCompletedHigher&&!completedHigherEducation(profileText))return null;
    const requiresActiveHigher=requiresMandatoryActiveHigherEducation(requirementText);
    if(requiresActiveHigher&&!higherEducationActive(profileText))return null;
    const hasWorkHistory=/\b(?:experiencias? profissionais?|historico profissional|trabalhei|atuei|cargo|empresa)\b/.test(profileText)||/(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|atual|presente)/.test(profileText);
    const mandatoryExperience=/experiencia\s+(?:obrigatoria|necessaria|comprovada|exigida)|(?:exige|requer)[^.]{0,40}experiencia/.test(requirementText);
    if(mandatoryExperience&&!hasWorkHistory)return null;
    const allExperienceMode=String(filters.experienceLevel||'entry').toLowerCase()==='all';
    const explicitExperienceRequirement=/experiencia\s*[-:–—]?\s*\d+\s*(?:mes(?:es)?|anos?)|(?:minimo|minima|ao menos|pelo menos)\s+\d+\s+(?:mes(?:es)?|anos?)|\d+\s+(?:mes(?:es)?|anos?)\s+de\s+experiencia/.test(requirementText);
    const requirementNeedsAI=(allExperienceMode&&explicitExperienceRequirement)||
      /(?:curso|certificacao)[^.]{0,100}(?:obrigatorio|obrigatoria|necessario|necessaria|minimo|minima)\b|registro\s+(?:profissional|ativo)|\b(?:cref|crp|coren|oab|crf)\b|cnh\s+(?:obrigatoria|necessaria)/.test(requirementText);

    const familyPhraseHits=(filters.searchFamilies||[]).filter(term=>rolePhraseMatch(roleHead,term));
    const tier=core?'core':((literal||aliasDirect)?'literal':treeAdjacent?'adjacent':'ai-prefilter');
    const foreignSpecific=roleSpecific.filter(x=>!conceptSetHas(planTokenSet,x)&&!roleProfileHits.includes(x));
    const area=areaCompatibility(job,filters.area||'');
    const professionalScore=Math.min(1,0.12+area.boost+(core?0.45:literal?0.38:treeAdjacent?0.28:0.16)+Math.min(0.12,roleProfileHits.length*0.04));
    const titleContext=words(String(job.title||'').replace(String(roleHead||''),' '));
    const bodySetAll=words(job.description||'');
    const contextualDomainHits=[...new Set([
      ...[...titleContext].filter(x=>conceptSetHas(planTokenSet,x)||conceptSetHas(pWords,x)),
      ...[...bodySetAll].filter(x=>conceptSetHas(recurrentPlanTokens,x)&&(conceptSetHas(planTokenSet,x)||conceptSetHas(pWords,x)))
    ])];
    const directOccupationSupported=roleSpecificPlanHits.length>0||roleProfileHits.length>0||aliasDirect||core||literal;
    const foreignSpecificNeedsAI=foreignSpecific.length>0&&!directOccupationSupported;
    const narrowCoreNeedsAI=false;
    const forceAIReview=exclusionHit||bodyOnlyCandidate||foreignSpecificNeedsAI||narrowCoreNeedsAI||requirementNeedsAI;

    return {...job,...flags,areaMatch:true,targetMatch:true,compatibilityTier:tier,hardMismatch:job.hardMismatch,professionalScore,score:Math.min(1,professionalScore+locationBoost(job,filters,flags)),forceAIReview,prefilterEvidence:{families:familyPhraseHits.slice(0,8),literal,literalTerms:literal?literalTerms.filter(t=>fitTitle(roleNorm,roleSet,roleKinds,[t])).slice(0,4).map(t=>t.raw):[],bodyTerms:bodyHits.slice(0,6).map(x=>x.raw),roleRecurringHits:roleRecurringHits.slice(0,8),foreignSpecific:foreignSpecific.slice(0,8),contextualDomainHits:contextualDomainHits.slice(0,8)}};
  }).filter(Boolean).sort((a,b)=>{
    const tierRank=x=>x.compatibilityTier==='core'?4:x.compatibilityTier==='literal'?3:x.compatibilityTier==='adjacent'?2:1;
    return tierRank(b)-tierRank(a)||(b.score||0)-(a.score||0);
  });
}
export function rankJobs(jobs,profile,filters){
  const profileText=`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`,pWords=words(profileText),minScore=Number(filters.minScore??0.04);
  return jobs.map(job=>{
    const flags=inferFlags(job),jw=words(professionalJobText(job));
    const overlap=[...jw].filter(x=>pWords.has(x)).length;
    const base=overlap/Math.max(7,Math.min(jw.size,pWords.size||7));
    const area=areaCompatibility(job,filters.area||''),target=targetRelevance(job,profile,filters),locBoost=locationBoost(job,filters,flags);
    const broad=filters.agenticBroadReview===true&&broadAgenticFit(job,profile,filters);
    const targetOk=target.ok||broad;
    const targetBoost=target.ok?target.boost:(broad?0.08:0);
    const professionalScore=Math.min(1,base+area.boost+targetBoost);
    return {...job,...flags,areaMatch:area.ok,targetMatch:targetOk,compatibilityTier:target.ok?(target.tier||'target'):(broad?'agentic':'none'),hardMismatch:target.hardMismatch||job.hardMismatch,professionalScore,score:Math.min(1,professionalScore+locBoost)};
  }).filter(job=>job.areaMatch&&job.targetMatch&&job.professionalScore>=minScore)
    .filter(job=>pcdOk(job,filters.pcdMode||'exclude'))
    .filter(job=>workModeOk(job,filters.workMode||'include_remote'))
    .filter(job=>locationOk(job,filters,job))
    .filter(job=>experienceOk(job,filters))
    .filter(job=>contractOk(job,filters))
    .sort((a,b)=>b.score-a.score);
}

export function debugRankDecision(job,profile,filters){
  const flags=inferFlags(job);
  const profileText=`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`;
  const area=areaCompatibility(job,filters.area||'');
  const target=targetRelevance(job,profile,filters);
  const loc=locationOk(job,filters,flags);
  const exp=experienceOk(job,filters);
  const pcd=pcdOk(flags,filters.pcdMode||'exclude');
  const work=workModeOk(flags,filters.workMode||'include_remote');
  const contract=contractOk(flags,filters);
  const pWords=words(profileText),jw=words(professionalJobText(job));
  const overlap=[...jw].filter(x=>pWords.has(x)).length;
  const base=overlap/Math.max(7,Math.min(jw.size,pWords.size||7));
  const professionalScore=Math.min(1,base+area.boost+target.boost);
  const softwareMismatch=requiredSoftwareMismatch(job,profileText);return {flags,area,target,locationOk:loc,experienceOk:exp,pcdOk:pcd,workModeOk:work,contractOk:contract,softwareMismatch,base,professionalScore,minScore:Number(filters.minScore??0.04),passes:area.ok&&target.ok&&professionalScore>=Number(filters.minScore??0.04)&&pcd&&work&&loc&&exp&&contract&&!softwareMismatch};
}

function needsAIReview(job,filters){
  if(job?.forceAIReview===true)return true;
  const body=norm(job?.description||'');
  const hardRequirement=/registro\s+(?:profissional|ativo)|\bcref\b|\bcrp\b|\bcoren\b|\boab\b|\bcrf\b|cnh\s+(?:obrigatoria|necessaria)|certifica[cç][aã]o\s+(?:obrigatoria|necessaria)|curso\s+(?:obrigatorio|necessario)|(?:curso|certificacao)[^.]{0,100}(?:minimo|minima)\s+\d+\s*h/.test(body);
  if(hardRequirement)return true;
  if(job?.compatibilityTier==='core'||job?.compatibilityTier==='literal')return false;
  if(job?.compatibilityTier==='adjacent'&&((job?.prefilterEvidence?.families||[]).length||(job?.prefilterEvidence?.roleRecurringHits||[]).length))return false;
  return true;
}
export function jobNeedsAIReview(job,filters){return needsAIReview(job,filters);}
function literalSkills(profile){
  const raw=norm(profile?.rawText||''),compact=raw.replace(/[^a-z0-9]/g,'');
  return (Array.isArray(profile?.skills)?profile.skills:[]).filter(skill=>{
    const k=norm(skill),kc=k.replace(/[^a-z0-9]/g,'');
    if(kc.length>=5&&compact.includes(kc))return true;
    const esc=k.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&').replace(/\s+/g,'\\s+');
    return new RegExp('(^|[^a-z0-9])'+esc+'([^a-z0-9]|$)','i').test(raw);
  });
}


function extractContextsForAI(raw,rx,{radius=150,maxChars=320}={}){
  const out=[],seen=new Set();
  rx.lastIndex=0;
  let m,total=0;
  while((m=rx.exec(raw))&&total<maxChars){
    const a=Math.max(0,m.index-radius),b=Math.min(raw.length,m.index+m[0].length+radius);
    const piece=raw.slice(a,b).replace(/\s+/g,' ').trim();
    const key=norm(piece).slice(0,90);
    if(piece&&key&&!seen.has(key)){seen.add(key);out.push(piece);total+=piece.length+3;}
  }
  return out.join(' | ').slice(0,maxChars);
}
function jobEvidenceForAI(value){
  const raw=String(value||'').replace(/\s+/g,' ').trim();
  const duties=extractContextsForAI(raw,/atividad|responsabil|atribui|taref|rotina|funcao|função|funcoes|funções|dia a dia|principais atividades/gi,{radius:135,maxChars:360});
  const requirements=extractContextsForAI(raw,/formacao|formação|graduacao|graduação|cursando|curso|experiencia|experiência|obrigat|requisit|necessari|necessári|imprescind|desejavel|desejável|preferencial|habilidade|certificacao|certificação|idioma|superior completo|ensino medio|ensino médio/gi,{radius:125,maxChars:360});
  const technical=extractContextsForAI(raw,/conhecimento|dominio|domínio|proficiencia|proficiência|software|sistema|ferramenta|plataforma|programa|pacote|tecnologia|metodologia/gi,{radius:110,maxChars:240});
  return {intro:raw.slice(0,300),duties,requirements,technical};
}
const AI_REVIEW_CACHE_VERSION='review-v7-stable-job-key';
const aiReviewCacheDir=path.join(storage.data,'ai-review-cache');
fs.mkdirSync(aiReviewCacheDir,{recursive:true});
function aiReviewCacheKey(job,profile){
  return createHash('sha1').update(JSON.stringify({
    version:AI_REVIEW_CACHE_VERSION,
    candidateId:profile?.candidateId||0,
    profile:String(profile?.rawText||''),
    skills:Array.isArray(profile?.skills)?profile.skills:[],
    supportContext:String(profile?.supportContext||''),
    title:job?.title||'',url:job?.url||'',description:job?.description||''
  })).digest('hex').slice(0,32);
}
function validAIReviewReason(value){
  const r=norm(value).trim();
  if(!r)return false;
  if(['curta','breve','motivo','reason','ok','n a','na','sim','nao','não'].includes(r))return false;
  return r.length>=8;
}
function readAIReviewCache(job,profile){
  try{
    const file=path.join(aiReviewCacheDir,aiReviewCacheKey(job,profile)+'.json');
    if(!fs.existsSync(file))return null;
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
    if(parsed?.version!==AI_REVIEW_CACHE_VERSION||typeof parsed?.eligible!=='boolean')return null;
    const reason=String(parsed.reason||'').slice(0,320);
    if(!validAIReviewReason(reason))return null;
    return {eligible:parsed.eligible,reason,hardMismatch:Array.isArray(parsed.hardMismatch)?parsed.hardMismatch.slice(0,6):[]};
  }catch{return null;}
}
function writeAIReviewCache(job,profile,review){
  try{
    const file=path.join(aiReviewCacheDir,aiReviewCacheKey(job,profile)+'.json');
    fs.writeFileSync(file,JSON.stringify({version:AI_REVIEW_CACHE_VERSION,eligible:review.eligible,reason:review.reason||'',hardMismatch:review.hardMismatch||[]}), 'utf8');
  }catch{}
}
export async function reviewVerifiedJobsWithAI(jobs,profile,filters,{maxJobs=600,batchSize=18}={}){
  const eligible=jobs.filter(j=>j.sendable===1).slice(0,Math.max(0,maxJobs));
  if(!eligible.length)return jobs;
  const directSet=new Set(eligible.filter(j=>!needsAIReview(j,filters)));
  const verified=eligible.filter(j=>needsAIReview(j,filters));
  if(!verified.length)return jobs.map(j=>directSet.has(j)?{...j,aiReviewed:true,reviewMethod:'rules',aiReason:'Compatibilidade direta validada por requisitos objetivos e evidência do currículo.'}:j);

  const byKey=new Map(),cachedSet=new Set(),cv=String(profile?.rawText||'').split(/\n=== DOCUMENTO DE APOIO:/i)[0].slice(0,4200),skills=literalSkills(profile),supportContext=String(profile?.supportContext||'').slice(0,1800);
  for(const job of verified){const cached=readAIReviewCache(job,profile);if(cached){byKey.set(job,cached);cachedSet.add(job);}}
  const literalEvidence=String(profile?.rawText||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.length>2).slice(0,24);

  const askBatch=async (entries,lane=0)=>{
    const items=entries.map(({job,index})=>({id:String(index),title:job.title||'',company:job.company||'',location:job.location||'',contract:job.contractType||'',evidence:jobEvidenceForAI(job.description||'')}));
    const system='Avalie cada vaga contra o plano profissional DESTE candidato, sem tratar nenhuma profissao como boa ou ruim globalmente. Uma vaga e elegivel somente quando suas atividades e requisitos cabem de forma defensavel nas familias, core e adjacencias deste candidato e nos fatos comprovados do curriculo. Rejeite por incompatibilidade objetiva: funcao fora da arvore profissional individual, senioridade ou experiencia obrigatoria nao comprovada, formacao obrigatoria incompativel, requisito tecnico obrigatorio ausente, PCD exclusivo incompativel ou outra exigencia objetiva. Em cargos adjacentes ou titulos mistos, leia as atividades concretas: mencao a uma familia profissional no nome da empresa ou em uma tarefa secundaria nao basta. Se as tarefas principais pertencerem a outra carreira, rejeite. Itens desejaveis nao bastam para rejeitar. Nunca invente experiencia, ferramenta, curso, formacao, senioridade ou resultado. Retorne somente JSON valido.';
    const prompt='CURRICULO:\n'+cv+'\n\nCOMPETENCIAS COMPROVADAS:\n'+JSON.stringify(skills)+'\n\nEVIDENCIA DO CURRICULO:\n'+JSON.stringify(literalEvidence)+'\n\nPLANO PROFISSIONAL INDIVIDUAL:\n'+JSON.stringify({focus:filters?.searchFocus||'',families:filters?.searchFamilies||[],core:filters?.searchCoreTerms||[],adjacent:filters?.searchAdjacentTerms||[],exclusions:filters?.searchExclusions||[]})+'\n\nFILTROS OBJETIVOS:\n'+JSON.stringify({experienceLevel:filters?.experienceLevel||'',contractTypes:filters?.contractTypes||[],pcdMode:filters?.pcdMode||'',locationScope:filters?.locationScope||'',cities:filters?.cities||[],states:filters?.states||[],nationwide:!!filters?.nationwide})+'\n\nVAGAS:\n'+JSON.stringify(items)+'\n\nRetorne exatamente {"results":[{"id":"0","eligible":true,"reason":"motivo objetivo e específico da decisão","hardMismatch":[]}]}. De um resultado para TODOS os ids.';
    try{
      const parsed=parseJsonLoose(await askAI(system,prompt,{candidateId:profile?.candidateId,timeoutMs:12000,queueTimeoutMs:12000,maxAttempts:1,lane}))||{};
      return Array.isArray(parsed.results)?parsed.results:[];
    }catch(e){
      console.error('[ranking] AI review batch failed',entries.map(x=>x.index).join(','),String(e?.message||e||''));
      return [];
    }
  };

  const entries=verified.filter(job=>!cachedSet.has(job)).map((job,index)=>({job,index})),size=Math.max(8,Math.min(12,Number(batchSize||12)));
  const applyRows=(batch,rows)=>{
    for(const row of rows){
      const idx=Number(row?.id),entry=batch.find(x=>x.index===idx);
      if(!entry)continue;
      const reason=String(row?.reason||'').slice(0,320);
      if(!validAIReviewReason(reason))continue;
      const review={eligible:row?.eligible!==false,reason,hardMismatch:Array.isArray(row?.hardMismatch)?row.hardMismatch.slice(0,6):[]};
      byKey.set(entry.job,review);writeAIReviewCache(entry.job,profile,review);
    }
  };
  const processBatch=async (batch,lane=0)=>{
    const rows=await askBatch(batch,lane);
    applyRows(batch,rows);
    return {missing:batch.filter(x=>!byKey.has(x.job)),lane};
  };
  for(let offset=0;offset<entries.length;offset+=size*2){
    const batches=[entries.slice(offset,offset+size),entries.slice(offset+size,offset+size*2)].filter(x=>x.length);
    await Promise.all(batches.map((batch,lane)=>processBatch(batch,lane)));
    console.log(`[ranking] revisao AI: ${Math.min(offset+batches.reduce((n,x)=>n+x.length,0),entries.length)}/${entries.length}`);
  }

  return jobs.map(job=>{
    if(job.sendable!==1)return job;
    if(directSet.has(job))return {...job,aiReviewed:true,reviewMethod:'rules',aiReason:'Compatibilidade direta validada por requisitos objetivos e evidência do currículo.'};
    const review=byKey.get(job);
    if(!review)return {...job,sendable:0,reason:'AI_REVIEW_FAILED',verified:true,aiReviewed:false};
    if(review.eligible)return {...job,aiReviewed:true,reviewMethod:cachedSet.has(job)?'ai-cache':'ai',aiReason:review.reason};
    return {...job,sendable:0,reason:'AI_INCOMPATIBLE',verified:true,aiReviewed:true,reviewMethod:cachedSet.has(job)?'ai-cache':'ai',aiReason:review.reason,hardMismatch:review.hardMismatch};
  });
}

const stop=new Set('de da do das dos e em para com por a o as os um uma vaga vagas trabalho emprego'.split(' '));
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const stem=x=>x.length>5?x.replace(/(?:as|os|es|a|o|s)$/,''):x;
const words=s=>new Set(norm(s).split(/[^a-z0-9+#.]+/).map(stem).filter(x=>x.length>2&&!stop.has(x)));

function inferFlags(job){
  const text=norm(`${job.title} ${job.description} ${job.location} ${job.contractType}`);
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
  if(mode==='remote_only') return flags.remote&&!flags.hybrid;
  if(mode==='onsite_only') return !flags.remote&&!flags.hybrid;
  return true;
}

function remoteRegionOk(job,filters){
  if(filters.nationwide) return true;
  const loc=norm(job.location);
  if(!loc) return true;
  if(/worldwide|anywhere|global|latin america|south america|brasil|brazil/.test(loc)) return true;
  const chosen=[...(filters.states||[]),...(filters.cities||[])].map(norm).filter(Boolean);
  if(chosen.some(x=>loc.includes(x))) return true;
  return !/only|apenas|eua|usa|united states|canada|europe|europa|uk|united kingdom/.test(loc);
}function stateTextMatch(text,value){
  const s=norm(value).trim(); if(!s)return false;
  if(s.length===2) return new RegExp(`(^|[^a-z])${s}([^a-z]|$)`).test(text);
  return text.includes(s);
}
const rjOtherMunicipality=/\b(?:niteroi|duque de caxias|nova iguacu|sao goncalo|nilopolis|sao joao de meriti|belford roxo|mesquita|queimados|japeri|seropedica|itaguai|mage|guapimirim|itabora[ií]|marica|tangua|petropolis|teresopolis|nova friburgo|volta redonda|barra mansa|resende|macae|campos dos goytacazes|cabo frio|araruama|saquarema|rio das ostras|angra dos reis|paraty)\b/;
function rioVagasRioCityInference(job,cities){
  const wantsRio=cities.some(x=>norm(x)==='rio de janeiro');
  if(!wantsRio||!/^RioVagas$/i.test(job.source||''))return false;
  const loc=norm(job.location||'');
  if(!loc)return true;
  if(rjOtherMunicipality.test(loc))return false;
  return true;
}
function locationOk(job,filters,flags){
  if(filters.nationwide) return true;
  if(flags.remote&&filters.workMode!=='onsite_only') return remoteRegionOk(job,filters);
  const text=norm(`${job.location} ${job.title} ${job.description}`).replace(/rio de jan\.{2,}/g,'rio de janeiro');
  const cities=Array.isArray(filters.cities)?filters.cities.filter(Boolean):[filters.city].filter(Boolean);
  const states=Array.isArray(filters.states)?filters.states.filter(Boolean):[filters.state].filter(Boolean);
  const cityHit=cities.some(x=>text.includes(norm(x)));
  const stateHit=states.some(x=>stateTextMatch(text,x));
  const localRjSource=/^(RioVagas|EmpregosRJ)$/i.test(job.source||'');
  const wantsRj=states.some(x=>/^(rj|rio de janeiro)$/i.test(String(x).trim()));
  if(filters.locationScope==='state_only') return stateHit||(localRjSource&&wantsRj)||(!job.location&&localRjSource);
  if(cities.length){
    if(cityHit) return true;
    if((filters.locationScope||'state_priority')==='city_only') return rioVagasRioCityInference(job,cities);
    if(stateHit||(localRjSource&&wantsRj)) return true;
    return false;
  }
  if(states.length) return stateHit||(localRjSource&&wantsRj);
  return true;
}
function locationBoost(job,filters,flags){
  if(filters.nationwide)return 0;
  if(flags.remote&&filters.workMode!=='onsite_only')return 0.05;
  const text=norm(`${job.location} ${job.title}`).replace(/rio de jan\.{2,}/g,'rio de janeiro');
  const cities=Array.isArray(filters.cities)?filters.cities.filter(Boolean):[filters.city].filter(Boolean);
  const states=Array.isArray(filters.states)?filters.states.filter(Boolean):[filters.state].filter(Boolean);
  if(cities.some(x=>text.includes(norm(x))))return 0.12;
  if(states.some(x=>stateTextMatch(text,x)))return 0.04;
  return 0;
}
function experienceOk(job,filters){
  const mode=filters.experienceLevel||'entry'; if(mode==='all') return true;
  const title=norm(job.title),text=norm(`${job.title} ${job.description||''}`);
  const high=/\b(pleno|senior|sr\.?|especialista|coordenador|coordenadora|gerente|supervisor|supervisora|lider|head|diretor|diretora|lead)\b|\b(?:ii|iii|iv)\b|\bn[ií]vel\s*[234]\b|\blevel\s*[234]\b/.test(title);
  const req=[...text.matchAll(/experi[eê]ncia[^\d]{0,25}(\d+)\s*anos?|(?:mínimo|ao menos|pelo menos|mais de)?\s*(\d+)\s*anos?\s*(?:de )?experi[eê]ncia/g)].map(m=>Number(m[1]||m[2])).filter(Number.isFinite);
  if(mode==='none') return /sem experi[eê]ncia|n[aã]o exige experi[eê]ncia|primeiro emprego|est[aá]gio|aprendiz|trainee/.test(text);
  return !high&&!req.some(n=>n>=3);
}

function pcdOk(flags,mode){
  if(mode==='only') return flags.pcdEligible;
  if(mode==='include') return true;
  return !flags.pcdExclusive;
}

function contractOk(flags,filters){
  const wanted=new Set(filters.contractTypes||[]);
  if(!wanted.size) return true;
  const actual=new Set();
  if(flags.clt) actual.add('CLT'); if(flags.pj) actual.add('PJ');
  if(flags.internship) actual.add('ESTAGIO'); if(flags.temporary) actual.add('TEMPORARIO');
  if(flags.apprentice) actual.add('APRENDIZ'); if(flags.freelance) actual.add('FREELANCE');
  if(!actual.size) return true;
  return [...actual].some(x=>wanted.has(x));
}

const domainRules={
  design:/designer|design gr[aá]f|design digital|\bux\b|\bui\b|web designer|product designer|arte[- ]?final|diretor.*arte|desenhista|est[aá]gio.{0,30}design/,
  marketing:/marketing|social media|conte[uú]do|publicidade|comunica[cç][aã]o|m[ií]dia|tr[aá]fego|copywriter/,
  teaching:/professor|professora|docente|instrutor|educador|pedagog/,
  tech:/desenvolvedor|programador|frontend|backend|full.?stack|software|devops|dados|data analyst|qa|tester/,
  admin:/administrativ|secret[aá]ri|recepcion|office assistant/,
  sales:/vendedor|vendas|comercial|atendimento|customer success|inside sales/,
  finance:/financeir|cont[aá]bil|contabil|tesouraria|faturamento|fiscal/,
  hr:/recursos humanos|\brh\b|recrutamento|departamento pessoal|people/ 
};
function inferDomains(text){
  const t=norm(text), out=[];
  if(/design|figma|photoshop|illustrator|indesign|\bux\b|\bui\b|canva/.test(t)) out.push('design');
  if(/marketing|social media|redes sociais|publicidade|comunicacao|conteudo/.test(t)) out.push('marketing');
  if(/professor|professora|docente|pedagog|licenciatura|educador/.test(t)) out.push('teaching');
  if(/javascript|typescript|python|react|node|java|programa[cç][aã]o|desenvolvedor|software/.test(t)) out.push('tech');
  if(/administrativ|secretari|recepcion/.test(t)) out.push('admin');
  if(/vendas|comercial|vendedor|atendimento ao cliente|customer success/.test(t)) out.push('sales');
  if(/financeir|contab|contabil|tesouraria|faturamento/.test(t)) out.push('finance');
  if(/recursos humanos|\brh\b|recrutamento|departamento pessoal/.test(t)) out.push('hr');
  return [...new Set(out)];
}
function targetRelevance(job,profile,filters){
  const title=norm(job.title||'');
  const profileText=norm(`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`);
  const exclusions=Array.isArray(filters.searchExclusions)?filters.searchExclusions.map(norm).filter(Boolean):[];
  if(exclusions.some(x=>title.includes(x))) return {ok:false,boost:0};
  if(/rio design|design barra|design shopping/.test(title)&&/vendedor|vendedora|caixa|operador|loja/.test(title)) return {ok:false,boost:0};
  if(/designer.{0,20}(sobrancelh|cilio|unha|estetic)/.test(title)&&!/sobrancelh|cilio|unha|estetic|beleza/.test(profileText)) return {ok:false,boost:0};
  const titleTermHits=Number(job.searchTitleHits||0),bodyTermHits=Number(job.searchBodyHits||0);
  const profileWords=words(`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`);
  const titleWords=words(job.title||''),bodyWords=words(`${job.title||''} ${job.description||''} ${job.company||''}`);
  const roleHead=String(job.title||'').split(/\s+[-–—]\s+/)[0]||String(job.title||'');
  const roleWords=words(roleHead);
  const titleProfile=[...titleWords].filter(x=>profileWords.has(x)).length;
  const roleProfile=[...roleWords].filter(x=>profileWords.has(x)).length;
  const bodyProfile=[...bodyWords].filter(x=>profileWords.has(x)).length;
  const titleTerms=Array.isArray(job.searchTitleTerms)?job.searchTitleTerms:[];
  const roleTerms=titleTerms.filter(t=>{const tw=words(t);return tw.size&&[...tw].every(w=>roleWords.has(w));});
  const specificRoleTerms=roleTerms.filter(t=>words(t).size>=2);
  const hasEvidence=titleTermHits>0||bodyTermHits>0||titleProfile>0||bodyProfile>=2;
  if(job.broadCollection===true){
    const genericEntry=/^(estagio|aprendiz|trainee|assistente|auxiliar|analista|junior)\b/.test(norm(roleHead).trim());
    const roleOk=specificRoleTerms.length>0||roleProfile>=2||(roleTerms.length>0&&(bodyTermHits>=2||bodyProfile>=2))||(genericEntry&&roleProfile>=1&&bodyTermHits>=2);
    if(!hasEvidence||!roleOk) return {ok:false,boost:0};
  }
  const termBoost=Math.min(0.5,titleTermHits*0.22+Math.min(bodyTermHits,5)*0.055);
  const profileBoost=Math.min(0.18,roleProfile*0.07+Math.min(bodyProfile,4)*0.02);
  return {ok:true,boost:termBoost+profileBoost};
}
function areaCompatibility(job,areaText){
  const directed=String(areaText||'').trim();
  if(!directed) return {ok:true,boost:0};
  const areaWords=words(directed),titleWords=words(job.title||''),bodyWords=words(`${job.title||''} ${job.description||''}`);
  const titleOverlap=[...areaWords].filter(x=>titleWords.has(x)).length;
  const bodyOverlap=[...areaWords].filter(x=>bodyWords.has(x)).length;
  const boost=Math.min(0.24,titleOverlap*0.1+bodyOverlap*0.035);
  return {ok:true,boost};
}export function rankJobs(jobs,profile,filters){
  const profileText=`${profile.rawText||''} ${(profile.skills||[]).join(' ')}`;
  const pWords=words(profileText);
  const minScore=Number(filters.minScore??0.13);
  const eligible=jobs.map(job=>{
    const flags=inferFlags(job);
    const jw=words(`${job.title} ${job.description} ${job.company}`);
    const overlap=[...jw].filter(x=>pWords.has(x)).length;
    const base=overlap/Math.max(7,Math.min(jw.size,pWords.size||7));
    const area=areaCompatibility(job,filters.area||'');
    const target=targetRelevance(job,profile,filters);
    const locBoost=locationBoost(job,filters,flags);
    return {...job,...flags,areaMatch:area.ok,targetMatch:target.ok,score:Math.min(1,base+area.boost+target.boost+locBoost)};
  }).filter(job=>job.areaMatch&&job.targetMatch)
    .filter(job=>pcdOk(job,filters.pcdMode||'exclude'))
    .filter(job=>workModeOk(job,filters.workMode||'include_remote'))
    .filter(job=>locationOk(job,filters,job))
    .filter(job=>experienceOk(job,filters))
    .filter(job=>contractOk(job,filters))
    .sort((a,b)=>b.score-a.score);

  return eligible;
}
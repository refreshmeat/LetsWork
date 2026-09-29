import { askAI, parseJsonLoose } from '../services/ai.mjs';

const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function resolvedPrefs(job,prefs){
  const advertised=String(job.salary||'').trim();
  const usable=advertised&&!/pretens|a combinar|não informado|nao informado/i.test(advertised);
  return {...prefs,salaryExpectation:(prefs.salaryFromJob&&usable)?advertised:(prefs.salaryExpectation||'A combinar')};
}

function lineMatch(text,rx){
  return String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).find(x=>rx.test(x)&&x.length<=220)||null;
}
function ageFromBirth(value){
  const m=String(value||'').match(/(\d{1,2})\D(\d{1,2})\D(\d{4})/); if(!m) return null;
  const birth=new Date(Number(m[3]),Number(m[2])-1,Number(m[1])); if(Number.isNaN(birth.getTime())) return null;
  const now=new Date(); let age=now.getFullYear()-birth.getFullYear();
  if(now.getMonth()<birth.getMonth()||(now.getMonth()===birth.getMonth()&&now.getDate()<birth.getDate())) age--;
  return age>=14&&age<100?String(age):null;
}
function inferredNeighborhood(profile){
  if(String(profile?.neighborhood||'').trim())return String(profile.neighborhood).trim();
  const raw=String(profile?.rawText||'');
  return raw.match(/(?:RJ\s*[-–—]\s*Rio de Janeiro\s*[-–—]\s*)([^\n,;|]{2,60})/i)?.[1]?.trim()
    ||raw.match(/(?:bairro\s*[:\-]\s*)([^\n,;|]{2,60})/i)?.[1]?.trim()
    ||'';
}
export function knownAnswer(label,profile,prefs,job=null){
  const q=norm(label),raw=String(profile.rawText||''),neighborhood=inferredNeighborhood(profile);
  const saved=profile?.formAnswers&&typeof profile.formAnswers==='object'?profile.formAnswers:{};
  for(const [savedQuestion,savedAnswer] of Object.entries(saved)){
    if(norm(savedQuestion)===q&&savedAnswer!==undefined&&savedAnswer!==null&&String(savedAnswer).trim())return String(savedAnswer).trim();
  }
  if(/nome/.test(q)) return profile.name||null;
  if(/e-?mail/.test(q)) return profile.email||null;
  if(/telefone|celular|whatsapp/.test(q)) return profile.phone||null;
  if(/\bcpf\b/.test(q)) return profile.cpf||null;
  if(/data.*nascimento|nascimento/.test(q)) return profile.birthDate||null;
  if(/idade/.test(q)) return ageFromBirth(profile.birthDate);
  if(/\bcep\b/.test(q)) return profile.cep||null;
  if(/(?:tempo|demora|desloc|minut)/.test(q)&&/(?:bairro|resid|mora)/.test(q)) return null;
  if(/(?:em que|qual).*bairro|bairro.*resid|bairro.*mora/.test(q)&&neighborhood) return neighborhood;
  if(/reside em bairros|voce reside em|mora em (?:algum|um) dos/.test(q)&&neighborhood) return q.includes(norm(neighborhood))?'Sim':'Não';
  if(/bairro/.test(q)&&neighborhood) return neighborhood;
  if(/endere[cç]o|logradouro/.test(q)&&profile.address) return profile.address;
  if(/pretens.*salar|salario/.test(q)) return prefs.salaryExpectation||'A combinar';
  if(/(?:interesse|interessad).*(?:trabalhar|atuar)/.test(q)){
    const target=(q.match(/(?:com|em|na area de|na área de)\s+(.+)$/i)?.[1]||'').trim();
    const evidence=norm([raw,(profile.skills||[]).join(' '),prefs.area||'',prefs.searchFocus||'',...(prefs.searchCoreTerms||[]),...(prefs.searchFamilies||[]),job?.title||''].join(' '));
    const tokens=norm(target).split(/[^a-z0-9+#]+/).filter(x=>x.length>=4&&!['trabalhar','atuar','interesse','interessado','interessada'].includes(x));
    if(tokens.length&&tokens.some(x=>evidence.includes(x)))return 'Sim';
  }
  if(/cidade|municipio/.test(q)&&(profile.residenceCity||prefs.city)) return profile.residenceCity||prefs.city;
  if(/estado|\buf\b/.test(q)&&(profile.residenceState||prefs.state)) return profile.residenceState||prefs.state;
  if(/linkedin/.test(q)&&profile.linkedin) return profile.linkedin;
  if(/instagram|@/.test(q)&&profile.instagram) return profile.instagram;
  if(/portfolio/.test(q)&&profile.portfolio) return profile.portfolio;
  if(/semestre|periodo/.test(q)){ const m=raw.match(/\b(\d{1,2})\s*(?:º|°|o)?\s*(?:semestre|periodo)\b/i); if(m)return m[1]; }
  if(/curso|graduacao|faculdade|formacao/.test(q)) return lineMatch(raw,/bacharel|gradua|faculdade|universidade|curso superior/i);
  if(/ingles/.test(q)) return lineMatch(raw,/ingl[eê]s|english/i);
  if(/pcd|deficiencia/.test(q)) return profile.pcd===true?'Sim':profile.pcd===false?'Não':null;
  if(/contratacao.*pj|aceita.*pj/.test(q)) return (prefs.contractTypes||[]).includes('PJ')?'Sim':'Não';
  if(/disponibilidade/.test(q)) return prefs.availability===false?'Não':prefs.availability===true?'Sim':null;
  return null;
}


function rawResumeLines(profile){
  return String(profile?.rawText||'').replace(/\r/g,'').split('\n').map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
}
function experienceSectionLines(profile){
  const lines=rawResumeLines(profile);
  let start=lines.findIndex(x=>/^(?:experiencias? profissionais?|historico profissional|experiencias?)$/i.test(norm(x)));
  if(start<0)return [];
  const out=[];
  for(let i=start+1;i<lines.length;i++){
    const n=norm(lines[i]);
    if(/^(?:formacao|formacoes|formacao academica|habilidades|skills|competencias|certificacoes|certificados|idiomas|informacoes adicionais|projetos|portfolio)$/.test(n))break;
    out.push(lines[i]);
  }
  return out;
}
function experienceSummaryAnswer(profile){
  const lines=experienceSectionLines(profile);
  if(!lines.length)return null;
  const dateRx=/(?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|atual|presente)|\|\s*(?:19|20)\d{2}/i;
  const groups=[];
  let i=0;
  while(i<lines.length&&groups.length<3){
    const company=lines[i],role=lines[i+1]||'';
    if(role&&dateRx.test(role)){
      const duties=[];let j=i+2;
      while(j<lines.length){
        if(j+1<lines.length&&dateRx.test(lines[j+1]))break;
        duties.push(lines[j]);j++;
      }
      groups.push(company+' — '+role+(duties[0]?': '+duties[0].replace(/[.;]+$/,''):''));
      i=j;continue;
    }
    i++;
  }
  return groups.length?groups.join('; ').slice(0,900):lines.slice(0,7).join('; ').slice(0,900);
}
function contextForExperienceTerm(profile,terms){
  const lines=rawResumeLines(profile),normalizedTerms=terms.map(norm).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    const n=norm(lines[i]);
    if(!normalizedTerms.some(t=>n.includes(t)))continue;
    const prev=i>0?lines[i-1]:'';
    const prev2=i>1?lines[i-2]:'';
    const company=/\b(?:19|20)\d{2}\b/.test(prev)?prev2:prev;
    return [company,lines[i]].filter(Boolean).join(' — ').slice(0,500);
  }
  return null;
}
function deterministicFormAnswer(question,options,profile,prefs,job){
  const q=norm(question),raw=norm(String(profile?.rawText||'')),opts=(options||[]).map(String);
  const yesNo=value=>{
    const wanted=value?'sim':'nao';
    return opts.find(x=>norm(x)===wanted)||opts.find(x=>norm(x).includes(wanted))||(value?'Sim':'Não');
  };

  if(/disponibilidade/.test(q)&&prefs?.availability!==undefined)return yesNo(prefs.availability!==false);

  const lang=q.match(/\b(?:nivel\s+(?:de\s+)?)?(ingles|english|espanhol|spanish|frances|french|alemao|german)\b/);
  if(lang){
    const names={
      ingles:['ingles','english'],english:['ingles','english'],
      espanhol:['espanhol','spanish'],spanish:['espanhol','spanish'],
      frances:['frances','french'],french:['frances','french'],
      alemao:['alemao','german'],german:['alemao','german']
    };
    const aliases=names[lang[1]]||[lang[1]];
    const lines=rawResumeLines(profile);
    const line=lines.find(x=>aliases.some(a=>norm(x).includes(a)));
    if(!line)return null;
    const level=norm(line).match(/\b(basico|intermediario|avancado|fluente|nativo|a1|a2|b1|b2|c1|c2)\b/)?.[1];
    if(level){
      const pretty={basico:'Básico',intermediario:'Intermediário',avancado:'Avançado',fluente:'Fluente',nativo:'Nativo'}[level]||level.toUpperCase();
      return opts.find(x=>norm(x)===level)||opts.find(x=>norm(x).includes(level))||pretty;
    }
    return line;
  }

  if(/mora\s+em|reside\s+em/.test(q)&&!/(?:que|qual|bairro)/.test(q)){
    const match=q.match(/(?:mora|reside)\s+em\s+(.+?)(?:\?|$)/);
    const target=match?.[1]?.replace(/\b(?:algum|alguma|um|uma|dos|das)\b/g,' ').replace(/\s+/g,' ').trim();
    if(target){
      const residence=norm([profile?.neighborhood,profile?.residenceCity,profile?.residenceState].filter(Boolean).join(' '));
      const tokens=target.split(/[^a-z0-9]+/).filter(x=>x.length>=3&&!['rio','janeiro'].includes(x));
      if(tokens.length)return yesNo(tokens.every(x=>residence.includes(x)));
    }
  }

  if(/comente.*experien|fale.*experien|resuma.*experien|conte.*experien/.test(q)){
    return experienceSummaryAnswer(profile);
  }

  if(/experien|vivencia|ja trabalhou|ja atuou|trabalhou em/.test(q)){
    const typeQuestion=/em que tipo de empresa|qual empresa|onde trabalhou|onde teve experiencia/.test(q);
    const domains=[
      ['hotel',['hotel','hoteis','hotelaria']],
      ['restaurante',['restaurante','restaurantes']],
      ['loteria',['loteria','loterica']],
      ['shopping',['shopping']],
      ['caixa',['caixa']],
      ['recepcao',['recepcao','recepcionista']],
      ['atendimento',['atendimento','atendente']],
      ['administrativo',['administrativo','administrativa']],
      ['vendas',['vendas','vendedor','vendedora']]
    ];
    const mentioned=domains.filter(([key,aliases])=>aliases.some(a=>q.includes(norm(a))));
    if(typeQuestion&&mentioned.length){
      const evidence=contextForExperienceTerm(profile,mentioned.flatMap(([,aliases])=>aliases));
      return evidence||null;
    }
    if(mentioned.length){
      const evidenced=mentioned.some(([,aliases])=>aliases.some(a=>raw.includes(norm(a))));
      return yesNo(evidenced);
    }
    if(/na funcao|nesta funcao|nessa funcao/.test(q)&&job?.title){
      const role=norm(job.title);
      const roleTerms=['caixa','recepcao','recepcionista','atendimento','atendente','administrativo','vendas'].filter(x=>role.includes(x));
      if(roleTerms.length)return yesNo(roleTerms.some(x=>raw.includes(x)));
    }
    return yesNo(experienceSectionLines(profile).length>0);
  }
  return null;
}
function objectiveQuestionWithoutAI(question){
  const q=norm(question);
  return /nivel.*(?:ingles|english|espanhol|spanish|frances|french|alemao|german)|experien|vivencia|ja trabalhou|ja atuou|bairro|endereco|cep|cpf|nascimento|onde mora|onde reside|mora em|reside em|cnh|habilitacao|veiculo|carro|moto|trajeto|desloc|distancia|demora|minut|tempo.*(?:local|empresa|trabalho)|disponibilidade|semestre|periodo|curso|graduacao|faculdade|formacao|pretens.*salar|salario|whatsapp|telefone|celular/.test(q);
}


const travelCache=new Map();
let geoQueue=Promise.resolve(),lastGeoAt=0;
async function geoPoint(query){
  const q=String(query||'').trim(); if(!q)return null;
  const key='g:'+norm(q); if(travelCache.has(key))return travelCache.get(key);
  const work=geoQueue.then(async()=>{
    const gap=Date.now()-lastGeoAt;if(gap<1100)await new Promise(r=>setTimeout(r,1100-gap));
    lastGeoAt=Date.now();
    try{
      const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q),{headers:{'user-agent':'LetsWork/0.1 job-application-assistant'},signal:AbortSignal.timeout(6000)});
      const rows=await r.json();const x=rows?.[0];const pt=x?{lat:Number(x.lat),lon:Number(x.lon)}:null;
      if(pt)travelCache.set(key,pt);
      return pt;
    }catch{return null;}
  });
  geoQueue=work.catch(()=>null);
  return work;
}
async function travelEstimate(profile,prefs,job){
  const preciseOrigin=String(profile.address||'').trim()||inferredNeighborhood(profile);
  if(!preciseOrigin)return null;
  const origin=[preciseOrigin,profile.residenceCity||prefs.city,profile.residenceState||prefs.state,'Brasil'].filter(Boolean).join(', ');
  const dest=[job?.location,prefs.city,prefs.state,'Brasil'].filter(Boolean).join(', ');
  if(!origin||!job?.location)return null;
  const key='r:'+norm(origin)+'>'+norm(dest); if(travelCache.has(key))return travelCache.get(key);
  const a=await geoPoint(origin),b=await geoPoint(dest); if(!a||!b)return null;
  try{
    const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`,{signal:AbortSignal.timeout(7000)});
    const route=(await r.json())?.routes?.[0]; if(!route)return null;
    const minutes=Math.max(1,Math.round(Number(route.duration||0)/60));
    const km=Math.round((Number(route.distance||0)/1000)*10)/10;
    const out={minutes,km,near:minutes<=45,origin,destination:dest}; travelCache.set(key,out); return out;
  }catch{return null;}
}
export function safeFallbackAnswer(question,options=[],profile={},prefs={},job=null){
  const q=norm(question), opts=(options||[]).map(String).filter(Boolean);
  // Never fabricate personal location, identity, transport or possessions.
  if(/bairro|endere[cç]o|logradouro|\bcep\b|\bcpf\b|nascimento|onde mora|onde reside|resid[eê]ncia/.test(q))return null;
  if(/proxim|perto|facil acesso|f[aá]cil acesso|distancia|desloc|trajeto|locomo[cç][aã]o|tempo.*(?:local|empresa|trabalho)|onibus|ônibus|brt|metr[oô]|transporte/.test(q))return null;
  if(/cnh|habilita[cç][aã]o|moto propria|carro proprio|veiculo proprio/.test(q))return null;
  if(/tiktok|instagram|linkedin|@|rede social|portfolio|portifolio/.test(q)){
    const known=knownAnswer(question,profile,prefs,job);
    if(known)return known;
    if(/se tiver|se houver|caso tenha|opcional/.test(q))return 'Não possuo';
    return null;
  }
  if(/curso.*(?:turno|periodo|previsao)|turno.*curso|previsao.*conclusao/.test(q))return null;
  if(/concorda.*rpa|contrata[cç][aã]o.*rpa/.test(q))return null;
  if(/entrevista.*(?:dia|data|hora)|disponibilidade.*entrevista.*\d/.test(q))return null;
  if(/experien|vivencia|ja trabalhou|ja atuou|possui experiencia|tem experiencia/.test(q)){
    if(opts.length){const no=opts.find(x=>/^(nao|não)$/i.test(x.trim())||/nao possuo|não possuo/i.test(x));if(no)return no;}
    return 'Não';
  }
  if(/disponibilidade/.test(q)) return prefs.availability===false?'Não':'Sim';
  if(/pretens.*salar|salario/.test(q)) return prefs.salaryExpectation||'A combinar';
  if(/motiva|porque.*vaga|por que.*vaga|interesse.*vaga/.test(q)) return `Tenho interesse na oportunidade de ${job?.title||'trabalho'} por ser compatível com minha formação, conhecimentos e objetivos profissionais descritos no currículo.`;
  if(/apresent|fale sobre voce|conte sobre voce|resumo profissional/.test(q)) return 'Meu currículo apresenta minha formação, experiências e competências comprovadas relacionadas à oportunidade.';
  if(opts.length){
    const safe=opts.find(x=>/não se aplica|nao se aplica|sem experi|a combinar|^0$|^(nao|não)$/i.test(x.trim())); if(safe)return safe;
    return null;
  }
  return null;
}
export async function aiAnswers(questions,profile,prefs,job=null){
  if(!questions.length)return new Map();
  const formAiEnabled=process.env.LETSWORK_FORM_AI==='1';
  const travelEnabled=process.env.LETSWORK_TRAVEL_ESTIMATE==='1';
  const needsTravel=travelEnabled&&questions.some(q=>/(proxim|perto|distancia|desloc|trajeto|demora|minut|tempo.*(?:local|vaga|trabalho))/i.test(norm(q?.question||'')));
  const travel=needsTravel?await travelEstimate(profile,prefs,job).catch(()=>null):null;
  const out=new Map(),remaining=[];
  const raw=norm(String(profile.rawText||'')+' '+(profile.skills||[]).join(' '));
  const skillNames=(profile.skills||[]).map(String).filter(Boolean);
  const knownTools=['canva','photoshop','figma','indesign','illustrator','illustration','excel','power bi','after effects','premiere','corel','autocad','sketchup','word','wordpress','html','css','javascript','python'];
  for(const q of questions){
    const id=String(q?.id??''),label=String(q?.question||''),n=norm(label),options=(q?.options||[]).map(String);
    let answer=knownAnswer(label,profile,prefs,job)||deterministicFormAnswer(label,options,profile,prefs,job)||null;
    const requiresConfirmedPersonalData=/bairro|endere[cç]o|logradouro|\bcep\b|\bcpf\b|nascimento|onde mora|onde reside|resid[eê]ncia|cnh|habilita[cç][aã]o|moto propria|carro proprio|veiculo proprio/.test(n);
    const requiresPreciseTravel=/proxim|perto|facil acesso|f[aá]cil acesso|distancia|desloc|trajeto|locomo[cç][aã]o|tempo.*(?:local|empresa|trabalho)|onibus|ônibus|brt|metr[oô]|transporte/.test(n);
    if(!answer&&travel&&/(proxim|perto|distancia|desloc|trajeto|demora|minut|tempo)/.test(n)){
      if(/proxim|perto|mora.*local|reside.*local/.test(n)){
        const wanted=travel.near?'sim':'nao';
        answer=options.find(x=>norm(x)===wanted)||options.find(x=>norm(x).includes(wanted))||(travel.near?'Sim':'Não');
      }else if(/tempo|demora|minut|desloc|trajeto/.test(n)){
        const estimated=/onibus|ônibus|transporte public|transporte público/.test(n)?Math.round(travel.minutes*1.45+8):travel.minutes;
        answer=String(estimated);
        if(!options.length&&!/numero|quantos|minutos?\b/.test(n))answer+=' minutos aproximadamente';
      }
    }
    if(!answer&&/(quantos?.*anos|anos?.*experi|tempo.*experi)/.test(n)){
      const m=raw.match(/(\d+(?:[.,]\d+)?)\s*anos?[^\n]{0,80}/);answer=m?.[1]||'0';
    }
    if(!answer&&/(experien|vivencia|conhec|domina|sabe usar|utiliza|familiaridade)/.test(n)){
      const mentioned=knownTools.filter(t=>n.includes(norm(t)));
      const evidenced=mentioned.some(t=>raw.includes(norm(t)))||skillNames.some(k=>n.includes(norm(k))&&raw.includes(norm(k)));
      if(mentioned.length||skillNames.some(k=>n.includes(norm(k)))) {
        const wanted=evidenced?'sim':'nao';
        answer=options.find(x=>norm(x)===wanted)||options.find(x=>norm(x).includes(wanted))||(evidenced?'Sim':'Não');
      }
    }
    if(!answer&&/disponibilidade/.test(n))answer=prefs.availability===false?'Não':'Sim';
    if(!answer&&/(motiva|porque.*vaga|por que.*vaga|interesse.*vaga)/.test(n))answer=safeFallbackAnswer(label,options,profile,prefs,job);
    if(!answer&&/(apresent|fale sobre voce|conte sobre voce|resumo profissional)/.test(n))answer=safeFallbackAnswer(label,options,profile,prefs,job);
    if(answer)out.set(id,String(answer));
    else if(requiresConfirmedPersonalData||requiresPreciseTravel||objectiveQuestionWithoutAI(label)){}
    else remaining.push(q);
  }
  if(remaining.length&&formAiEnabled){
    const system='Responda perguntas de formulário de candidatura usando somente fatos do currículo, dados confirmados da pessoa candidata, preferências e informações da vaga. Nunca invente experiência, habilidade, formação, endereço, disponibilidade ou credenciais. Se uma experiência ou habilidade não estiver comprovada, responda negativamente. Para opções, devolva exatamente uma opção existente. Para perguntas abertas, redija resposta curta e profissional baseada somente nos fatos fornecidos. Retorne apenas JSON válido.';
    const facts={curriculo:String(profile.rawText||'').slice(0,12000),dadosAdicionais:String(profile.additionalFacts||'').slice(0,3000),origemBairro:inferredNeighborhood(profile)||'',deslocamento:travel||null,vaga:{titulo:job?.title||'',empresa:job?.company||'',local:job?.location||'',descricao:String(job?.description||'').slice(0,7000)},preferencias:{availability:prefs.availability,contractTypes:prefs.contractTypes,pcdMode:prefs.pcdMode,salaryExpectation:prefs.salaryExpectation,city:prefs.city,state:prefs.state}};
    const prompt='CONTEXTO:\n'+JSON.stringify(facts)+'\n\nPERGUNTAS:\n'+JSON.stringify(remaining)+'\n\nRetorne exatamente {"answers":[{"id":"...","answer":"..."}]}. Responda todas. Não use null. Se faltar comprovação de experiência, responda de forma negativa e verdadeira, sem inventar.';
    try{
      const parsed=parseJsonLoose(await askAI(system,prompt,{candidateId:profile.candidateId,timeoutMs:12000,maxAttempts:1,numCtx:4096,numPredict:360,temperature:0.1}))||{};
      for(const item of Array.isArray(parsed.answers)?parsed.answers:[]){
        const id=String(item?.id??''),answer=item?.answer==null?'':String(item.answer).trim();if(answer)out.set(id,answer);
      }
    }catch{}
  }
  for(const q of questions){const id=String(q?.id??'');if(!out.get(id))out.set(id,safeFallbackAnswer(q?.question,q?.options,profile,prefs,job));}
  return out;
}

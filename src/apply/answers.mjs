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
function inferredAge(profile){
  const explicit=String(profile?.age||'').match(/\b(\d{2})\b/)?.[1]||'';
  if(explicit&&Number(explicit)>=14&&Number(explicit)<100)return explicit;
  const fromBirth=ageFromBirth(profile?.birthDate);if(fromBirth)return fromBirth;
  const raw=String(profile?.rawText||'');
  const m=raw.match(/\b(?:idade\s*[:\-]?\s*)?(\d{2})\s*anos?\b/i);
  return m&&Number(m[1])>=14&&Number(m[1])<100?m[1]:null;
}
function compactQuestion(value){
  return norm(value).replace(/[^a-z0-9]+/g,' ').trim();
}
function accessDestination(question){
  let q=compactQuestion(question);
  q=q.replace(/\b(voce|vcs|possui|tem|mora|reside|facil|acesso|proximo|proxima|perto|ao|a|do|da|de|bairro|local|trabalho|empresa|vaga|regiao|na|no|para|ate)\b/g,' ').replace(/\s+/g,' ').trim();
  return q.slice(0,90);
}
export function canonicalFormQuestionKey(question){
  const q=compactQuestion(question);
  if(!q)return '';
  if(/(?:telefone|celular|whatsapp).*(?:endereco|logradouro)|(?:endereco|logradouro).*(?:telefone|celular|whatsapp)/.test(q))return 'contact_address';
  if(/bairro.*idade|idade.*bairro/.test(q))return 'neighborhood_age';
  if(/data.*nascimento|nascimento/.test(q))return 'birth_date';
  if(/\bidade\b/.test(q))return 'age';
  if(/(?:qual|em qual|que|onde|lugar).*bairro|bairro.*(?:mora|reside|residencia)|(?:mora|reside).*bairro|lugar que reside/.test(q))return 'neighborhood';
  if(/endereco|logradouro/.test(q))return 'address';
  if(/telefone|celular|whatsapp/.test(q))return 'phone';
  if(/\bcpf\b/.test(q))return 'cpf';
  if(/\bcep\b|codigo postal/.test(q))return 'cep';
  if(/cnh|habilitacao/.test(q))return 'cnh';
  if(/numero.*roupa.*calcado|uniforme.*calcado|roupa.*sapato|tamanho.*calcado/.test(q))return 'uniform_shoe_size';
  if(/rio card|riocard|\bjae\b|bilhete unico/.test(q))return 'transit_card';
  if(/meio.*transporte|qual.*transporte/.test(q))return 'transport_mode';
  if(/valor.*passagem|passagem.*valor|quantas?.*passag/.test(q))return 'transport_cost:'+accessDestination(q);
  if(/curso.*(?:turno|periodo|previsao)|(?:turno|periodo|previsao).*(?:curso|conclusao|formatura)/.test(q))return 'education_details';
  if(/medicacao|remedio/.test(q))return 'medication';
  if(/animais|caes|gatos/.test(q))return 'animals';
  if(/facil acesso|proxim|perto|distancia|desloc|trajeto|tempo.*(?:chegar|local|trabalho|empresa)/.test(q))return 'access:'+accessDestination(q);
  if(/horario|turno/.test(q)&&/\d{1,2}h/.test(q))return 'shift:'+q.replace(/\s+/g,' ').slice(0,110);
  return q;
}
function savedFormAnswer(question,profile){
  const saved=profile?.formAnswers&&typeof profile.formAnswers==='object'?profile.formAnswers:{};
  const key=canonicalFormQuestionKey(question);
  for(const [savedQuestion,savedAnswer] of Object.entries(saved)){
    if((compactQuestion(savedQuestion)===compactQuestion(question)||canonicalFormQuestionKey(savedQuestion)===key)
      &&savedAnswer!==undefined&&savedAnswer!==null&&String(savedAnswer).trim())return String(savedAnswer).trim();
  }
  return null;
}

function inferredNeighborhood(profile){
  if(String(profile?.neighborhood||'').trim())return String(profile.neighborhood).trim();
  const address=String(profile?.address||'').trim();
  const addressParts=address.split(/\s+[\-–—]\s+/).map(x=>x.trim()).filter(Boolean);
  for(let i=addressParts.length-1;i>0;i--){
    const part=addressParts[i];
    if(part&&!/^(?:rio de janeiro|rj|brasil|brazil)$/i.test(part))return part;
  }
  const raw=String(profile?.rawText||'');
  const explicit=raw.match(/(?:bairro\s*[:\-]\s*)([^\n,;|]{2,60})/i)?.[1]?.trim();
  if(explicit)return explicit;
  const addressLine=raw.split(/\r?\n/).find(x=>/^(?:rua|avenida|av\.?|estrada|travessa|alameda|rodovia|pra[cç]a)\b/i.test(x));
  const parts=String(addressLine||'').split(/\s+[\-–—]\s+/).map(x=>x.trim()).filter(Boolean);
  for(let i=parts.length-1;i>0;i--){
    const part=parts[i];
    if(part&&!/^(?:rio de janeiro|rj|brasil|brazil)$/i.test(part))return part;
  }
  return '';
}
function residenceText(profile,prefs={}){
  const neighborhood=inferredNeighborhood(profile);
  const city=String(profile?.residenceCity||prefs?.city||'').trim();
  const state=String(profile?.residenceState||prefs?.state||'').trim();
  const address=String(profile?.address||'').trim();
  if(address)return [address,city,state].filter(Boolean).join(' - ');
  return [neighborhood,city,state].filter(Boolean).join(' - ');
}
function educationAnswer(profile){
  const lines=rawResumeLines(profile);
  const higherIndex=lines.findIndex(x=>/bacharel|gradua|licenciatura|tecnologo|faculdade|universidade|curso superior/.test(norm(x)));
  if(higherIndex>=0){
    const nearby=lines.slice(higherIndex,Math.min(lines.length,higherIndex+3)).join(' ');
    return nearby.replace(/\s+/g,' ').trim().slice(0,260);
  }
  const mediumIndex=lines.findIndex(x=>/ensino medio/.test(norm(x)));
  if(mediumIndex>=0){
    const nearby=lines.slice(mediumIndex,Math.min(lines.length,mediumIndex+3));
    const complete=nearby.some(x=>/completo|concluido|concluida/.test(norm(x)));
    return complete?'Ensino Médio completo':nearby[0].replace(/\s+/g,' ').trim();
  }
  const fundamentalIndex=lines.findIndex(x=>/ensino fundamental/.test(norm(x)));
  if(fundamentalIndex>=0)return lines[fundamentalIndex];
  const technicalIndex=lines.findIndex(x=>/curso tecnico|tecnico em/.test(norm(x)));
  return technicalIndex>=0?lines[technicalIndex]:null;
}
function languageEvidence(profile){
  const lines=rawResumeLines(profile);
  const known=[
    ['Inglês',['ingles','english']],
    ['Espanhol',['espanhol','spanish']],
    ['Francês',['frances','french']],
    ['Alemão',['alemao','german']],
    ['Italiano',['italiano','italian']]
  ];
  const out=[];
  for(const [label,aliases] of known){
    const line=lines.find(x=>aliases.some(a=>norm(x).includes(a)));
    if(!line)continue;
    const level=norm(line).match(/\b(basico|intermediario|avancado|fluente|nativo|a1|a2|b1|b2|c1|c2)\b/)?.[1]||'';
    const pretty={basico:'básico',intermediario:'intermediário',avancado:'avançado',fluente:'fluente',nativo:'nativo'}[level]||level.toUpperCase();
    out.push({label,level,text:pretty?label+' '+pretty:line.replace(/\s+/g,' ').trim()});
  }
  return out;
}
function languageMeets(profile,language,requested){
  const evidence=languageEvidence(profile);
  const aliases={ingles:'Inglês',english:'Inglês',espanhol:'Espanhol',spanish:'Espanhol',frances:'Francês',french:'Francês',alemao:'Alemão',german:'Alemão'};
  const item=evidence.find(x=>x.label===aliases[language]);
  if(!item)return false;
  if(requested==='fluente')return /^(?:fluente|nativo|c2)$/i.test(item.level);
  const rank={a1:1,a2:1,basico:1,b1:2,b2:2,intermediario:2,c1:3,avancado:3,c2:4,fluente:4,nativo:5};
  return (rank[item.level]||0)>=(rank[requested]||0);
}
export function knownAnswer(label,profile,prefs,job=null){
  const q=norm(label),raw=String(profile.rawText||''),neighborhood=inferredNeighborhood(profile);
  const savedAnswer=savedFormAnswer(label,profile);
  if(savedAnswer)return savedAnswer;
  if(/nome/.test(q)) return profile.name||null;
  if(/e-?mail/.test(q)) return profile.email||null;
  if(/(?:telefone|celular|whatsapp).*(?:endere[cç]o|logradouro)|(?:endere[cç]o|logradouro).*(?:telefone|celular|whatsapp)/.test(q)){
    if(profile.phone&&profile.address)return String(profile.phone)+' | '+String(profile.address);
    return null;
  }
  if(/bairro.*\bidade\b|\bidade\b.*bairro/.test(q)){
    const age=inferredAge(profile);if(neighborhood&&age)return neighborhood+' | '+age+' anos';return null;
  }
  if(/telefone|celular|whatsapp/.test(q)) return profile.phone||null;
  if(/\bcpf\b/.test(q)) return profile.cpf||null;
  if(/data.*nascimento|nascimento/.test(q)) return profile.birthDate||null;
  if(/\bidade\b/.test(q)) return inferredAge(profile);
  if(/\bcep\b/.test(q)) return profile.cep||null;
  if(/(?:tempo|demora|desloc|minut)/.test(q)&&/(?:bairro|resid|mora)/.test(q)) return null;
  if(/(?:em qual|qual).*cidade.*bairro|(?:em qual|qual).*bairro.*cidade/.test(q)){const v=residenceText(profile,prefs);if(v)return v;}
  if(/onde.*(?:mora|reside)|qual.*local.*residencia|local.*residencia|lugar.*reside/.test(q)){const v=residenceText(profile,prefs);if(v)return v;}
  if(/(?:em que|em qual|qual|que).*bairro|bairro.*resid|bairro.*mora|mora.*bairro|reside.*bairro/.test(q)&&neighborhood) return neighborhood;
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
  if(/escolaridade|grau.*escolar|nivel.*escolar/.test(q)) return educationAnswer(profile);
  if(/curso|graduacao|faculdade|formacao/.test(q)) return lineMatch(raw,/bacharel|gradua|faculdade|universidade|curso superior/i);
  if(/quais?.*idiomas|idiomas?.*(?:possui|fala|fluencia)/.test(q)){const items=languageEvidence(profile);if(items.length)return items.map(x=>x.text).join(' e ');}
  if(/(?:qual|nivel).*(?:ingles|english)|(?:ingles|english).*nivel/.test(q)) return lineMatch(raw,/ingl[eê]s|english/i);
  if(/pcd|deficiencia/.test(q)) return profile.pcd===true?'Sim':profile.pcd===false?'Não':null;
  if(/contratacao.*pj|aceita.*pj/.test(q)) return (prefs.contractTypes||[]).includes('PJ')?'Sim':'Não';
  if(/disciplina.*home office|trabalhar.*100%?\s*home office/.test(q)&&/\b(?:remoto|home office)\b/.test(norm(raw))) return 'Sim. Tenho experiência anterior com atendimento remoto, conforme descrito no currículo.';
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

  const languageNames=['ingles','english','espanhol','spanish','frances','french','alemao','german'];
  const mentionedLanguages=languageNames.filter(name=>new RegExp('(^|[^a-z])'+name+'([^a-z]|$)').test(q));
  const yesNoOptions=opts.some(x=>norm(x)==='sim')&&opts.some(x=>norm(x)==='nao');
  if(mentionedLanguages.length&&yesNoOptions){
    let requested=q.match(/\b(basico|intermediario|avancado|fluente|nativo)\b/)?.[1]||'';
    if(!requested&&/fluenc/.test(q))requested='fluente';
    if(requested){
      const canonical=[...new Set(mentionedLanguages.map(x=>({english:'ingles',spanish:'espanhol',french:'frances',german:'alemao'}[x]||x)))];
      return yesNo(canonical.every(lang=>languageMeets(profile,lang,requested)));
    }
  }
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
  if(/motiva|porque.*vaga|por que.*vaga|por que.*(?:boa pessoa|trabalhar|oportunidade)|interesse.*vaga/.test(q)){const exp=experienceSummaryAnswer(profile);return exp?`Tenho experiência comprovada relacionada à oportunidade, incluindo ${exp.slice(0,360)}. Busco contribuir com atendimento responsável, organização e aprendizado contínuo.`:`Tenho interesse na oportunidade de ${job?.title||'trabalho'} por ser compatível com minha formação, conhecimentos e objetivos profissionais descritos no currículo.`;}
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
    if(!answer&&/(motiva|porque.*vaga|por que.*vaga|por que.*(?:boa pessoa|trabalhar|oportunidade)|interesse.*vaga)/.test(n))answer=safeFallbackAnswer(label,options,profile,prefs,job);
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

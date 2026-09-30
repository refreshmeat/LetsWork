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
export function accessDestination(question){
  const q=compactQuestion(question);
  if(!q)return '';
  const known=[
    ['Barra da Tijuca',/\bbarra(?: da tijuca)?\b/],
    ['Jacarepaguá',/\bjacarepagua\b/],
    ['Centro',/\bcentro(?: do rio(?: de janeiro)?)?\b/],
    ['Zona Sul',/\bzona sul\b/],
    ['Zona Oeste',/\bzona oeste\b/],
    ['Zona Norte',/\bzona norte\b/],
    ['Ilha do Governador',/\bilha do governador\b/],
    ['Santa Cruz',/\bsanta cruz\b/],
    ['Realengo',/\brealengo\b/],
    ['Pilares',/\bpilares\b/],
    ['Bangu Shopping',/\bbangu shopping\b/],
    ['Bangu',/\bbangu\b/],
    ['Vila Isabel',/\bvila isabel\b/],
    ['Pavuna',/\bpavuna\b/],
    ['Tijuca',/\btijuca\b/],
    ['Copacabana',/\bcopacabana\b/],
    ['São Cristóvão',/\bsao cristovao\b/],
    ['Bonsucesso',/\bbonsucesso\b/]
  ];
  const found=[];
  for(const [label,rx] of known)if(rx.test(q)&&!found.some(x=>label.includes(x)||x.includes(label)))found.push(label);
  if(found.length)return found.join(' | ');
  const patterns=[
    /(?:trajeto|deslocamento|deslocar|chegar|leva|demora)[^]*?\b(?:ate|para|pra|ao|a|no|na)\s+(.+)$/,
    /(?:facil acesso|acesso)\s+(?:a|ao|aos|as|para|pra|no|na)?\s*(.+)$/,
    /(?:proximo|proxima|perto)\s+(?:a|ao|aos|as|da|do|de|no|na)?\s*(.+)$/
  ];
  let dest='';
  for(const rx of patterns){
    const m=q.match(rx);
    if(m?.[1]){dest=m[1].trim();break;}
  }
  if(!dest){
    dest=q.replace(/\b(voce|vcs|possui|tem|mora|reside|facil|acesso|proximo|proxima|perto|quanto|tempo|leva|aproximadamente|trajeto|deslocamento|deslocar|demora|bairro|local|trabalho|empresa|vaga|regiao)\b/g,' ').replace(/\s+/g,' ').trim();
  }
  dest=dest.replace(/^(?:a|ao|aos|as|para|pra|no|na|da|do|de|o|os)\s+/,'').trim();
  if(/^(?:local(?: de trabalho| da vaga)?|empresa|vaga|escola|unidade|localizacao)$/.test(dest))return '';
  if(/^(?:a?lor|valor|custo).*passag/.test(dest))return '';
  return dest.slice(0,90);
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
  if(/comprovante.*escolaridade|document.*escolaridade|ensino medio completo.*document/.test(q))return 'school_proof';
  if(/doenca.*pre existente|condicao.*saude|problema.*saude/.test(q))return 'health_condition';
  if(/meio.*transporte|qual.*transporte/.test(q))return 'transport_mode';
  if(/(?:valor|alor).*passagem|passagem.*(?:valor|custo)|quantas?.*passag/.test(q))return 'transport_cost:'+accessDestination(q);
  if(/quantas?.*(?:conduc|onibus|ônibus)|(?:conduc|onibus|ônibus).*quantas?/.test(q))return 'transport_segments:'+accessDestination(q);
  if(/tempo|demora|minut|trajeto|deslocamento/.test(q))return 'travel_time:'+accessDestination(q);
  if(/distancia|quilometr|\bkm\b/.test(q))return 'travel_distance:'+accessDestination(q);
  if(/proxim|perto/.test(q))return 'proximity:'+accessDestination(q);
  if(/facil acesso|acesso.*(?:bairro|regiao|zona|local)/.test(q))return 'access:'+accessDestination(q);
  if(/curso.*(?:turno|periodo|previsao)|(?:turno|periodo|previsao).*(?:curso|conclusao|formatura)/.test(q))return 'education_details';
  if(/medicacao|remedio/.test(q))return 'medication';
  if(/animais|caes|gatos/.test(q))return 'animals';
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
  if(/cnh|habilitacao/.test(q)){
    const category=String(profile.cnhCategory||'').trim();
    if(!category)return null;
    const normalized=norm(category);
    if(/nao|nenhuma|sem cnh|nao possuo/.test(normalized))return 'Não';
    const requested=[...q.matchAll(/\b(?:categoria\s*)?([a-e]{1,2})\b/g)].flatMap(m=>m[1].split('')).filter(x=>/[a-e]/.test(x));
    const owned=[...normalized.toUpperCase()].filter(x=>/[A-E]/.test(x));
    if(requested.length)return requested.some(x=>owned.includes(x.toUpperCase()))?'Sim':'Não';
    return category;
  }
  if(/numero.*roupa.*calcado|uniforme.*calcado|roupa.*sapato|tamanho.*calcado/.test(q)){
    const uniform=String(profile.uniformSize||'').trim(),shoe=String(profile.shoeSize||'').trim();
    if(uniform&&shoe)return 'Uniforme/roupa: '+uniform+'; calçado: '+shoe;
    return null;
  }
  if(/rio card|riocard|\bjae\b|bilhete unico/.test(q))return String(profile.transitCard||'').trim()||null;
  if(/comprovante.*escolaridade|document.*escolaridade|ensino medio completo.*document/.test(q)){
    const proof=String(profile.schoolProof||'').trim();
    if(proof)return /nao|não/i.test(proof)?'Não':'Sim';
    return null;
  }
  if(/nacionalidade/.test(q)) return profile.nationality||null;
  if(/naturalidade|cidade.*nascimento|local.*nascimento/.test(q)) return profile.naturality||null;
  if(/pais.*(?:resid|mora|vive)|(?:resid|mora|vive).*pais/.test(q)) return (profile.residenceCity||profile.residenceState||profile.address)?'Brasil':null;
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
  if(/nivel.*atencao.*detalh|atencao.*detalh/.test(q)){
    const evidence=rawResumeLines(profile).filter(x=>/organiza|controle|confer|responsab|planilha|estoque|document/.test(norm(x))).slice(0,2);
    if(evidence.length)return 'Alto. Meu histórico profissional destaca organização, controle e responsabilidade com informações e rotinas.';
  }
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
export function deterministicFormAnswer(question,options,profile,prefs,job){
  const q=norm(question),raw=norm(String(profile?.rawText||'')),opts=(options||[]).map(String);
  const yesNo=value=>{
    const wanted=value?'sim':'nao';
    return opts.find(x=>norm(x)===wanted)||opts.find(x=>norm(x).includes(wanted))||(value?'Sim':'Não');
  };

  if(/disponibilidade/.test(q)&&prefs?.availability!==undefined)return yesNo(prefs.availability!==false);
  if(/vaga.*horario.*(?:\bou\b|\/)|horario.*(?:\bou\b|\/).*vaga/.test(q)){
    return prefs?.availability===false?'Não tenho disponibilidade para os horários informados.':'Tenho disponibilidade para ambos os horários informados.';
  }
  if(/(?:meio|forma).*transporte|transporte.*(?:utilizar|usar)/.test(q))return 'Transporte público';
  if(/ciente.*(?:vaga|escala|horario)|(?:vaga|escala|horario).*ciente/.test(q)){
    if(!opts.length&&/\b\d{1,2}[:h]\d{0,2}.*\b\d{1,2}[:h]\d{0,2}/.test(q))return 'Sim, tenho ciência do horário informado e disponibilidade para a escala descrita.';
    return yesNo(prefs?.availability!==false);
  }
  if(/se sim.*(?:fale|conte|descreva).*atividades|(?:quais|fale).*atividades.*(?:realizou|realizava|exercia)/.test(q))return experienceSummaryAnswer(profile);
  if(/animais|caes|gatos/.test(q)){
    return opts.length?yesNo(true):'Não tenho objeção em trabalhar em ambiente com animais domésticos.';
  }
  if(/comprovante.*escolaridade|ensino medio completo.*document/.test(q)){
    const education=educationAnswer(profile);
    if(education&&/medio.*completo/i.test(norm(education)))return opts.length?yesNo(true):'Sim. Ensino Médio completo; documentação comprobatória disponível para apresentação.';
  }

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
async function geoPoint(query,{preferredCity='',fallbacks=[]}={}){
  const candidates=[query,...fallbacks].map(x=>String(x||'').trim()).filter(Boolean);
  for(const q of candidates){
    const key='g:'+norm(q)+'|'+norm(preferredCity); if(travelCache.has(key))return travelCache.get(key);
    const work=geoQueue.then(async()=>{
      const gap=Date.now()-lastGeoAt;if(gap<1100)await new Promise(r=>setTimeout(r,1100-gap));
      lastGeoAt=Date.now();
      try{
        const url='https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&q='+encodeURIComponent(q);
        const response=await fetch(url,{headers:{'user-agent':'LetsWork/0.1 job-application-assistant'},signal:AbortSignal.timeout(6500)});
        if(!response.ok)return null;
        const rows=await response.json();
        if(!Array.isArray(rows)||!rows.length)return null;
        const qTokens=norm(q).split(/[^a-z0-9]+/).filter(x=>x.length>2&&!['brasil','estado','regiao'].includes(x));
        const city=norm(preferredCity);
        const scored=rows.map(row=>{
          const display=norm(row.display_name||'');
          let score=0;
          for(const token of qTokens)if(display.includes(token))score+=1;
          if(qTokens.length&&qTokens.every(token=>display.includes(token)))score+=5;
          if(city&&display.includes(city))score+=5;
          const first=qTokens[0]||'';
          if(first&&display.startsWith(first))score+=4;
          return {row,score};
        }).sort((x,y)=>y.score-x.score);
        const x=scored[0]?.row;
        return x?{lat:Number(x.lat),lon:Number(x.lon)}:null;
      }catch{return null;}
    });
    geoQueue=work.catch(()=>null);
    const point=await work;
    if(point){travelCache.set(key,point);return point;}
  }
  return null;
}
export async function travelEstimate(profile,prefs,job,destinationHint=''){
  const address=String(profile.address||'').trim(),neighborhood=inferredNeighborhood(profile);
  const city=String(profile.residenceCity||prefs.city||'').trim(),state=String(profile.residenceState||prefs.state||'').trim();
  const preciseOrigin=address||neighborhood;
  if(!preciseOrigin)return null;
  const origin=[preciseOrigin,city,state,'Brasil'].filter(Boolean).join(', ');
  const street=address.split(',')[0].replace(/\s+\d+.*$/,'').trim();
  const originFallbacks=[
    [street,neighborhood,city,state,'Brasil'].filter(Boolean).join(', '),
    [neighborhood,city,state,'Brasil'].filter(Boolean).join(', ')
  ];
  const hinted=String(destinationHint||'').trim();
  const destinationBase=hinted||String(job?.location||'').trim();
  if(!destinationBase)return null;
  const dest=[destinationBase,prefs.city||city,prefs.state||state,'Brasil'].filter(Boolean).join(', ');
  const key='r:'+norm(origin)+'>'+norm(dest); if(travelCache.has(key))return travelCache.get(key);
  const a=await geoPoint(origin,{preferredCity:city,fallbacks:originFallbacks});
  const b=await geoPoint(dest,{preferredCity:prefs.city||city,fallbacks:[
    [destinationBase,city,state,'Brasil'].filter(Boolean).join(', '),
    [destinationBase,state,'Brasil'].filter(Boolean).join(', ')
  ]});
  if(!a||!b)return null;
  try{
    const response=await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`,{signal:AbortSignal.timeout(7000)});
    if(!response.ok)return null;
    const route=(await response.json())?.routes?.[0]; if(!route)return null;
    const minutes=Math.max(1,Math.round(Number(route.duration||0)/60));
    const km=Math.round((Number(route.distance||0)/1000)*10)/10;
    const publicMinutes=Math.max(minutes+10,Math.round(minutes*1.45+8));
    const estimatedSegments=km<=6?1:km<=20?2:3;
    const out={minutes,publicMinutes,km,near:publicMinutes<=75,veryNear:km<=10||publicMinutes<=40,estimatedSegments,origin,destination:dest,source:'OSM/OSRM estimate'};
    travelCache.set(key,out);return out;
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
  const travelEnabled=process.env.LETSWORK_TRAVEL_ESTIMATE!=='0';
  const travelQuestions=questions.filter(q=>/(proxim|perto|facil acesso|distancia|desloc|trajeto|demora|minut|passag|conduc|tempo.*(?:local|vaga|trabalho|empresa|chegar)|acesso.*(?:bairro|regiao|zona))/i.test(norm(q?.question||'')));
  const travelByQuestion=new Map();
  if(travelEnabled){
    for(const q of travelQuestions){
      const hints=accessDestination(q?.question||'').split('|').map(x=>x.trim()).filter(Boolean);
      const targets=hints.length?hints:[''];
      const estimates=[];
      for(const hint of targets){
        const estimate=await travelEstimate(profile,prefs,job,hint).catch(()=>null);
        if(estimate)estimates.push(estimate);
      }
      if(estimates.length){
        const aggregate=estimates.length===1?estimates[0]:{
          minutes:Math.max(...estimates.map(x=>x.minutes)),
          publicMinutes:Math.max(...estimates.map(x=>x.publicMinutes)),
          km:Math.max(...estimates.map(x=>x.km)),
          near:estimates.every(x=>x.near),
          veryNear:estimates.every(x=>x.veryNear),
          estimatedSegments:Math.max(...estimates.map(x=>x.estimatedSegments)),
          origin:estimates[0].origin,
          destination:estimates.map(x=>x.destination).join(' | '),
          source:'OSM/OSRM aggregate estimate'
        };
        travelByQuestion.set(String(q?.id??''),aggregate);
      }
    }
  }
  const out=new Map(),remaining=[];
  const raw=norm(String(profile.rawText||'')+' '+(profile.skills||[]).join(' '));
  const skillNames=(profile.skills||[]).map(String).filter(Boolean);
  const knownTools=['canva','photoshop','figma','indesign','illustrator','illustration','excel','power bi','after effects','premiere','corel','autocad','sketchup','word','wordpress','html','css','javascript','python'];
  for(const q of questions){
    const id=String(q?.id??''),label=String(q?.question||''),n=norm(label),options=(q?.options||[]).map(String);
    let answer=knownAnswer(label,profile,prefs,job)||deterministicFormAnswer(label,options,profile,prefs,job)||null;
    const requiresConfirmedPersonalData=/bairro|endere[cç]o|logradouro|\bcep\b|\bcpf\b|nascimento|onde mora|onde reside|resid[eê]ncia|cnh|habilita[cç][aã]o|moto propria|carro proprio|veiculo proprio/.test(n);
    const requiresPreciseTravel=/proxim|perto|facil acesso|f[aá]cil acesso|distancia|desloc|trajeto|locomo[cç][aã]o|passag|conduc|tempo.*(?:local|empresa|trabalho|chegar)|onibus|ônibus|brt|metr[oô]|transporte/.test(n);
    const travel=travelByQuestion.get(id)||null;
    if(!answer&&travel&&/(proxim|perto|facil acesso|distancia|desloc|trajeto|demora|minut|tempo|passag|conduc|onibus|ônibus|transporte)/.test(n)){
      const chooseYesNo=value=>{
        const wanted=value?'sim':'nao';
        return options.find(x=>norm(x)===wanted)||options.find(x=>norm(x).includes(wanted))||(value?'Sim':'Não');
      };
      if(/facil acesso/.test(n)){
        answer=chooseYesNo(travel.near);
      }else if(/\bproxim(?:o|a|idade)?\b|\bperto\b|mora.*local|reside.*local/.test(n)){
        answer=chooseYesNo(travel.veryNear);
      }else if(/quantas?.*(?:conduc|onibus|ônibus)|(?:conduc|onibus|ônibus).*quantas?/.test(n)){
        answer=String(travel.estimatedSegments);
        if(!options.length)answer+=' conduções aproximadamente por trecho';
      }else if(/quantas?.*passag/.test(n)){
        answer=String(travel.estimatedSegments*2);
        if(!options.length)answer+=' passagens aproximadamente considerando ida e volta';
      }else if(/(?:valor|alor|custo).*passag|passag.*(?:valor|custo)|valor diario.*passag/.test(n)){
        const fare=Math.max(0.01,Number(process.env.LETSWORK_RIO_TRANSIT_FARE||5));
        const roundMoney=v=>Math.round(v*100)/100;
        const computed=roundMoney(travel.estimatedSegments*fare*(/diari|ida e volta/.test(n)?2:1));
        const offered=[...label.matchAll(/R\$\s*(\d+(?:[.,]\d{1,2})?)/gi)].map(m=>Number(m[1].replace(',','.'))).filter(Number.isFinite);
        const picked=offered.length?offered.sort((a,b)=>Math.abs(a-computed)-Math.abs(b-computed))[0]:computed;
        answer='R$ '+picked.toFixed(2).replace('.',',');
      }else if(/tempo|demora|minut|desloc|trajeto/.test(n)){
        const estimated=/carro|automovel|automóvel/.test(n)?travel.minutes:travel.publicMinutes;
        const ranged=options.find(x=>{
          const t=norm(x),nums=[...t.matchAll(/\d+/g)].map(m=>Number(m[0]));
          if(nums.length>=2)return estimated>=Math.min(...nums)&&estimated<=Math.max(...nums);
          if(nums.length===1&&/ate|menos/.test(t))return estimated<=nums[0];
          if(nums.length===1&&/mais|acima/.test(t))return estimated>=nums[0];
          return false;
        });
        answer=ranged||String(estimated);
        if(!ranged&&!options.length){
          if(/qual.*trajeto|trajeto.*(?:chegar|ir)/.test(n))answer='Transporte público, com tempo estimado de '+estimated+' minutos a partir de '+inferredNeighborhood(profile)+'.';
          else if(!/numero|quantos|minutos?\b/.test(n))answer+=' minutos aproximadamente';
        }
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
    const facts={curriculo:String(profile.rawText||'').slice(0,12000),dadosAdicionais:String(profile.additionalFacts||'').slice(0,3000),origemBairro:inferredNeighborhood(profile)||'',deslocamentos:Object.fromEntries(travelByQuestion),vaga:{titulo:job?.title||'',empresa:job?.company||'',local:job?.location||'',descricao:String(job?.description||'').slice(0,7000)},preferencias:{availability:prefs.availability,contractTypes:prefs.contractTypes,pcdMode:prefs.pcdMode,salaryExpectation:prefs.salaryExpectation,city:prefs.city,state:prefs.state}};
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

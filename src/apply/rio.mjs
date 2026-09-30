import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { aiAnswers, safeFallbackAnswer } from './answers.mjs';

const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function htmlDecode(s){
  return String(s||'')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"')
    .replace(/&#0*39;|&apos;/gi,"'")
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function tagAttr(tag,name){
  const m=String(tag||'').match(new RegExp('\\b'+name+'\\s*=\\s*(["\\\'])(.*?)\\1','i'));
  return m?htmlDecode(m[2]):'';
}
function candidateFormHtml(html){
  const forms=[...String(html||'').matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(x=>x[0]);
  return forms.find(x=>/name=["']candidato_vaga_nonce_field["']/i.test(x))||String(html||'');
}
function selectOptions(block){
  return [...String(block||'').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
    .map(m=>htmlDecode(tagAttr('<option '+m[1]+'>','value')||String(m[2]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()))
    .filter(Boolean);
}
function formSchema(formHtml){
  const inputs=[...String(formHtml||'').matchAll(/<input\b[^>]*>/gi)].map(x=>x[0]);
  const selects=[...String(formHtml||'').matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)].map(x=>x[0]);
  const textareas=[...String(formHtml||'').matchAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi)].map(x=>x[0]);
  const controls=[];
  for(const tag of inputs){
    const name=tagAttr(tag,'name');if(!name)continue;
    controls.push({kind:'input',type:(tagAttr(tag,'type')||'text').toLowerCase(),name,value:tagAttr(tag,'value'),required:/\srequired(?:\s|=|>|\/)/i.test(tag)});
  }
  for(const tag of selects){
    const open=tag.match(/^<select\b[^>]*>/i)?.[0]||tag,name=tagAttr(open,'name');if(!name)continue;
    controls.push({kind:'select',type:'select',name,value:'',required:/\srequired(?:\s|=|>|\/)/i.test(open),options:selectOptions(tag)});
  }
  for(const tag of textareas){
    const open=tag.match(/^<textarea\b[^>]*>/i)?.[0]||tag,name=tagAttr(open,'name');if(!name)continue;
    controls.push({kind:'textarea',type:'textarea',name,value:'',required:/\srequired(?:\s|=|>|\/)/i.test(open)});
  }
  const known=name=>[
    'ciente','ciente_email','candidato_vaga_nonce_field','_wp_http_referer','post_id',
    'nome_candidato','email_candidato','celular_candidato','telefone_candidato','forma_envio','anexo',
    'curriculo_candidato','pretensao_salarial','apresentacao_candidato','form_submit'
  ].includes(name)||/^perguntas\[[^\]]+\]$/.test(name)||/^respostas\[[^\]]+\]$/.test(name);
  const unsupportedRequired=[...new Set(controls.filter(x=>x.required&&!known(x.name)).map(x=>x.name))];
  const signature=createHash('sha256').update(JSON.stringify(controls.map(x=>({
    kind:x.kind,type:x.type,name:x.name,required:Boolean(x.required),options:x.options||[]
  })).sort((a,b)=>(a.name+a.type).localeCompare(b.name+b.type)))).digest('hex').slice(0,16);
  return {
    controls,
    hasAttachment:controls.some(x=>x.name==='anexo'&&x.type==='file'),
    hasTextResume:controls.some(x=>x.name==='curriculo_candidato'),
    deliveryOptions:controls.filter(x=>x.name==='forma_envio').map(x=>x.value).filter(Boolean),
    unsupportedRequired,
    signature
  };
}
function closedError(message){
  const e=new Error(message);e.code='RIO_CLOSED';return e;
}
async function fetchRioGet(url,{timeout=10000,attempts=3}={}){
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const r=await fetch(url,{headers:{'user-agent':UA,'accept-language':'pt-BR,pt;q=0.9'},redirect:'follow',signal:AbortSignal.timeout(timeout)});
      if(r.ok||(![408,425,429,500,502,503,504].includes(r.status)))return r;
      lastError=new Error('RioVagas GET respondeu HTTP '+r.status);
    }catch(e){lastError=e;}
    if(attempt<attempts)await new Promise(resolve=>setTimeout(resolve,350*attempt));
  }
  throw lastError||new Error('RioVagas GET falhou');
}
function pageLooksClosed(html,url=''){
  const text=norm(htmlDecode(String(html||'').replace(/<[^>]+>/g,' ')));
  return /\/vaga-encerrada\//i.test(String(url||''))||/vaga encerrada|esta vaga foi encerrada|processo seletivo encerrado|vaga nao esta mais disponivel/.test(text);
}
export function parseRioFormHtml(html,applyUrl){
  const formHtml=candidateFormHtml(html);
  const schema=formSchema(formHtml);
  const tags=schema.controls.filter(x=>x.kind==='input');
  const nonceTag=tags.find(t=>t.name==='candidato_vaga_nonce_field')||{};
  const postTag=tags.find(t=>t.name==='post_id')||{};
  const refTag=tags.find(t=>t.name==='_wp_http_referer')||{};
  const questions=[];
  for(const t of tags){
    const m=String(t.name||'').match(/^perguntas\[([^\]]+)\]$/);
    if(!m)continue;
    const id=m[1],question=t.value||'';
    const answerControls=schema.controls.filter(x=>x.name===('respostas['+id+']'));
    const options=[...new Set(answerControls.flatMap(x=>x.options?.length?x.options:(x.value?[x.value]:[])).filter(Boolean))];
    questions.push({id,question,options,required:answerControls.some(x=>x.required),controlTypes:[...new Set(answerControls.map(x=>x.type))]});
  }
  const url=new URL(applyUrl);
  const postId=postTag.value||url.searchParams.get('vaga')||'';
  const nonce=nonceTag.value||'';
  if(!postId||!nonce)throw closedError('RioVagas: formulário ativo não pôde ser validado');
  return {html:formHtml,nonce,postId,referer:refTag.value||url.pathname+url.search,questions,schema};
}

export async function resolveRioApplyForm(job,{timeout=10000,attempts=3}={}){
  let applyUrl=/\/enviar-curriculo-gratis\//i.test(String(job?.url||''))?String(job.url):'';
  if(!applyUrl){
    const r=await fetchRioGet(job.url,{timeout,attempts});
    const html=await r.text();
    if([404,410].includes(r.status)||pageLooksClosed(html,r.url))throw closedError('RioVagas: vaga encerrada ou removida');
    const m=html.match(/href=["']([^"']*enviar-curriculo-gratis\/?\?vaga=[^"'#]+)["']/i);
    if(!m?.[1])throw closedError('RioVagas: vaga não possui mais formulário ativo de candidatura');
    applyUrl=new URL(htmlDecode(m[1]),r.url||job.url).toString();
  }
  const r=await fetchRioGet(applyUrl,{timeout,attempts});
  const html=await r.text();
  if([404,410].includes(r.status)||pageLooksClosed(html,r.url))throw closedError('RioVagas: formulário da vaga foi encerrado');
  if(!r.ok)throw new Error('RioVagas: formulário respondeu HTTP '+r.status);
  return {applyUrl,...parseRioFormHtml(html,applyUrl)};
}
export async function checkRioVagasHealth(job){
  try{
    await resolveRioApplyForm(job,{timeout:5000,attempts:1});
    return {ok:true,error:''};
  }catch(e){
    if(e?.code==='RIO_CLOSED')return {ok:true,error:''};
    return {ok:false,error:'RioVagas indisponível ou lento: '+String(e?.message||e)};
  }
}

function resolvedPrefs(job,prefs={}){
  const advertised=String(job?.salary||'').trim();
  const usable=advertised&&!/pretens|a combinar|não informado|nao informado/i.test(advertised);
  return {...prefs,salaryExpectation:(prefs.salaryFromJob&&usable)?advertised:(prefs.salaryExpectation||'A combinar')};
}
function intro(job,profile){
  const skills=(profile.skills||[]).slice(0,8).join(', ');
  return `Tenho interesse na oportunidade de ${job.title}. Meu currículo apresenta minha formação, projetos e experiências verificadas${skills?`, incluindo conhecimentos em ${skills}`:''}. Estou à disposição para as etapas do processo seletivo.`;
}
function plainText(html){
  return htmlDecode(String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
}
function confirmationSnippet(text,rx){
  const m=String(text||'').match(rx);
  if(!m)return '';
  const idx=Math.max(0,m.index-80),end=Math.min(text.length,(m.index||0)+m[0].length+120);
  return text.slice(idx,end).trim().slice(0,400);
}
function receipt(form,r,body,type,text=''){
  return {
    provider:'RioVagas',
    providerJobId:String(form?.postId||''),
    confirmationType:type,
    httpStatus:Number(r?.status||0)||null,
    responseUrl:String(r?.url||form?.applyUrl||'').slice(0,500),
    responseHash:createHash('sha256').update(String(body||'')).digest('hex'),
    confirmationText:String(text||'').slice(0,500)
  };
}

export async function applyRioVagasDirect(job,resumeFile,profile,prefs={},options={}){
  const dryRun=options.dryRun!==false;
  if(!resumeFile||!fs.existsSync(resumeFile))return {status:'ERROR',error:'Currículo-base não encontrado'};
  const bytes=fs.statSync(resumeFile).size;
  if(bytes>2*1024*1024)return {status:'ERROR',error:'Currículo excede o limite de 2 MB do RioVagas: '+(bytes/1024/1024).toFixed(2)+' MB'};
  if(!String(profile.name||'').trim()||!String(profile.email||'').trim()||!String(profile.phone||'').trim())
    return {status:'ERROR',error:'RioVagas: nome, email ou celular ausente no perfil'};
  let form;
  try{form=await resolveRioApplyForm(job);}
  catch(e){
    if(e?.code==='RIO_CLOSED')return {status:'CLOSED',error:String(e.message||e)};
    return {status:'ERROR',error:String(e?.message||e)};
  }
  if(form.schema?.unsupportedRequired?.length)return {status:'ERROR',error:'RioVagas: formulário mudou e possui campo obrigatório ainda não suportado: '+form.schema.unsupportedRequired.join(', ')};
  if(!form.schema?.hasAttachment&&!form.schema?.hasTextResume)return {status:'ERROR',error:'RioVagas: formulário ativo não oferece meio suportado para enviar o currículo'};
  if(!form.schema?.hasAttachment&&form.schema?.hasTextResume&&!String(profile.baseResumeText||'').trim())
    return {status:'ERROR',error:'RioVagas: formulário exige currículo em texto e o currículo-base textual não está disponível'};
  const preflight={schemaHash:form.schema?.signature||'',resumeMode:form.schema?.hasAttachment?'attachment':'text',questionCount:form.questions.length,providerJobId:String(form.postId||'')};
  const effectivePrefs=resolvedPrefs(job,prefs);
  const questions=form.questions.map(q=>({id:String(q.id),question:q.question,options:q.options}));
  const answers=questions.length?await aiAnswers(questions,profile,effectivePrefs,job).catch(()=>new Map()):new Map();
  const resolved=[];
  for(const q of questions){
    const answer=answers.get(String(q.id))||safeFallbackAnswer(q.question,q.options,profile,effectivePrefs,job);
    if(!answer)return {status:'NEEDS_DATA',error:'Campos obrigatórios sem dado confirmado: '+q.question,preflight};
    let value=String(answer);
    if(q.options.length){
      const exact=q.options.find(x=>norm(x)===norm(value))||q.options.find(x=>norm(x).includes(norm(value))||norm(value).includes(norm(x)));
      if(!exact)return {status:'NEEDS_DATA',error:'Resposta segura não encontrada para: '+q.question,preflight};
      value=exact;
    }
    resolved.push({id:q.id,question:q.question,value});
  }
  const data=new FormData();
  data.set('ciente','on');
  data.set('ciente_email','on');
  data.set('candidato_vaga_nonce_field',form.nonce);
  data.set('_wp_http_referer',form.referer);
  data.set('post_id',form.postId);
  data.set('nome_candidato',String(profile.name));
  data.set('email_candidato',String(profile.email));
  data.set('celular_candidato',String(profile.phone));
  data.set('telefone_candidato',String(profile.phone));
  const deliveryOptions=form.schema?.deliveryOptions||[];
  const attachmentMode=deliveryOptions.find(x=>/anexo|arquivo/i.test(norm(x)));
  const textMode=deliveryOptions.find(x=>!/anexo|arquivo/i.test(norm(x)));
  const delivery=form.schema?.hasAttachment?(attachmentMode||deliveryOptions[0]||'anexo'):(textMode||deliveryOptions[0]||'texto');
  data.set('forma_envio',delivery);
  if(/name=['"]pretensao_salarial['"]/i.test(form.html))data.set('pretensao_salarial',String(effectivePrefs.salaryExpectation||'A combinar'));
  if(/name=['"]apresentacao_candidato['"]/i.test(form.html))data.set('apresentacao_candidato',intro(job,profile));
  for(const q of resolved){data.set('perguntas['+q.id+']',q.question);data.set('respostas['+q.id+']',q.value);}
  if(form.schema?.hasAttachment){
    const blob=new Blob([fs.readFileSync(resumeFile)],{type:'application/pdf'});
    data.set('anexo',blob,path.basename(resumeFile));
  }
  if(form.schema?.hasTextResume){
    const resumeText=String(profile.baseResumeText||profile.rawText||'').trim();
    if(!resumeText)return {status:'ERROR',error:'RioVagas: formulário exige currículo em texto, mas o currículo-base textual está vazio'};
    data.set('curriculo_candidato',resumeText);
  }
  data.set('form_submit','confirm');
  const missingPayloadFields=[...new Set((form.schema?.controls||[])
    .filter(x=>x.required&&!data.has(x.name))
    .map(x=>x.name))];
  if(missingPayloadFields.length)
    return {status:'ERROR',error:'RioVagas: payload incompleto para campos obrigatórios: '+missingPayloadFields.join(', '),preflight};
  if(dryRun)return {status:'READY',error:'',preflight};

  let r,body='';
  try{
    r=await fetch(form.applyUrl,{method:'POST',headers:{'user-agent':UA,'accept-language':'pt-BR,pt;q=0.9','referer':form.applyUrl},body:data,redirect:'follow',signal:AbortSignal.timeout(25000)});
    body=await r.text();
  }catch(e){
    return {status:'UNCERTAIN',error:'RioVagas: POST iniciado sem confirmação segura: '+String(e?.message||e),receipt:{provider:'RioVagas',providerJobId:String(form.postId||''),confirmationType:'POST_UNCERTAIN',httpStatus:null,responseUrl:form.applyUrl,responseHash:'',confirmationText:String(e?.message||e).slice(0,300)}};
  }
  const plain=plainText(body),normalized=norm(plain+' '+(r?.url||''));
  const alreadyRx=/ja\s+(?:se\s+)?candidat|candidatura\s+ja\s+(?:foi\s+)?realizada|candidatura\s+ja\s+enviada|curriculo\s+ja\s+(?:foi\s+)?enviado|ja\s+enviou\s+(?:seu\s+)?curriculo|candidato\s+ja\s+cadastrado/i;
  const successRx=/curriculo enviado com sucesso|curriculo recebido|candidatura enviada|candidatura realizada|candidatura concluida|obrigado por se candidatar|obrigado pelo envio|recebemos (?:seu|o) curriculo|envio realizado com sucesso|mensagem de confirmacao/i;
  if(alreadyRx.test(normalized)){
    const text=confirmationSnippet(normalized,alreadyRx);
    return {status:'ALREADY_APPLIED',error:'Candidatura já registrada anteriormente no RioVagas',receipt:receipt(form,r,body,'ALREADY_APPLIED_TEXT',text)};
  }
  if(successRx.test(normalized)){
    const text=confirmationSnippet(normalized,successRx);
    return {status:'SENT',error:'',receipt:receipt(form,r,body,'SUCCESS_TEXT',text)};
  }
  const errors=[...body.matchAll(/<(?:div|span|p)[^>]*class=["'][^"']*(?:error|invalid|danger)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p)>/gi)]
    .map(x=>plainText(x[1])).filter(Boolean).slice(0,5);
  if(errors.length)return {status:'ERROR',error:'RioVagas recusou o envio. HTTP '+r.status+' · '+errors.join(' | '),receipt:receipt(form,r,body,'FORM_ERROR',errors.join(' | '))};
  return {status:'UNCERTAIN',error:'RioVagas respondeu ao POST, mas não confirmou o envio com segurança. HTTP '+r.status,receipt:receipt(form,r,body,'HTTP_UNCONFIRMED','Sem texto de confirmação reconhecido')};
}

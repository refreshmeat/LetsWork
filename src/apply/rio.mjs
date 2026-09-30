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
export async function resolveRioApplyForm(job){
  let applyUrl=/\/enviar-curriculo-gratis\//i.test(String(job?.url||''))?String(job.url):'';
  if(!applyUrl){
    const r=await fetchRioGet(job.url,{timeout:10000,attempts:3});
    const html=await r.text();
    if([404,410].includes(r.status)||pageLooksClosed(html,r.url))throw closedError('RioVagas: vaga encerrada ou removida');
    const m=html.match(/href=["']([^"']*enviar-curriculo-gratis\/?\?vaga=[^"'#]+)["']/i);
    if(!m?.[1])throw closedError('RioVagas: vaga não possui mais formulário ativo de candidatura');
    applyUrl=new URL(htmlDecode(m[1]),r.url||job.url).toString();
  }
  const r=await fetchRioGet(applyUrl,{timeout:10000,attempts:3});
  const html=await r.text();
  if([404,410].includes(r.status)||pageLooksClosed(html,r.url))throw closedError('RioVagas: formulário da vaga foi encerrado');
  if(!r.ok)throw new Error('RioVagas: formulário respondeu HTTP '+r.status);
  const tags=[...html.matchAll(/<input\b[^>]*>/gi)].map(x=>x[0]);
  const nonceTag=tags.find(t=>tagAttr(t,'name')==='candidato_vaga_nonce_field')||'';
  const postTag=tags.find(t=>tagAttr(t,'name')==='post_id')||'';
  const refTag=tags.find(t=>tagAttr(t,'name')==='_wp_http_referer')||'';
  const questions=[];
  for(const t of tags){
    const name=tagAttr(t,'name'),m=name.match(/^perguntas\[(\d+)\]$/);
    if(!m)continue;
    const id=m[1],question=tagAttr(t,'value');
    const answerTags=tags.filter(x=>tagAttr(x,'name')===('respostas['+id+']'));
    const options=answerTags.map(x=>tagAttr(x,'value')).filter(Boolean);
    questions.push({id,question,options});
  }
  const postId=tagAttr(postTag,'value')||new URL(applyUrl).searchParams.get('vaga')||'';
  const nonce=tagAttr(nonceTag,'value');
  if(!postId||!nonce)throw closedError('RioVagas: formulário ativo não pôde ser validado');
  return {applyUrl,html,nonce,postId,referer:tagAttr(refTag,'value')||new URL(applyUrl).pathname+new URL(applyUrl).search,questions};
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
  const effectivePrefs=resolvedPrefs(job,prefs);
  const questions=form.questions.map(q=>({id:String(q.id),question:q.question,options:q.options}));
  const answers=questions.length?await aiAnswers(questions,profile,effectivePrefs,job).catch(()=>new Map()):new Map();
  const resolved=[];
  for(const q of questions){
    const answer=answers.get(String(q.id))||safeFallbackAnswer(q.question,q.options,profile,effectivePrefs,job);
    if(!answer)return {status:'NEEDS_DATA',error:'Campos obrigatórios sem dado confirmado: '+q.question};
    let value=String(answer);
    if(q.options.length){
      const exact=q.options.find(x=>norm(x)===norm(value))||q.options.find(x=>norm(x).includes(norm(value))||norm(value).includes(norm(x)));
      if(!exact)return {status:'NEEDS_DATA',error:'Resposta segura não encontrada para: '+q.question};
      value=exact;
    }
    resolved.push({id:q.id,question:q.question,value});
  }
  if(dryRun)return {status:'READY',error:''};

  const data=new FormData();
  data.set('ciente','on');
  data.set('ciente_email','on');
  data.set('candidato_vaga_nonce_field',form.nonce);
  data.set('_wp_http_referer',form.referer);
  data.set('post_id',form.postId);
  data.set('nome_candidato',String(profile.name));
  data.set('email_candidato',String(profile.email));
  data.set('celular_candidato',String(profile.phone));
  data.set('telefone_candidato','');
  data.set('forma_envio','anexo');
  if(/name=['"]pretensao_salarial['"]/i.test(form.html))data.set('pretensao_salarial',String(effectivePrefs.salaryExpectation||'A combinar'));
  if(/name=['"]apresentacao_candidato['"]/i.test(form.html))data.set('apresentacao_candidato',intro(job,profile));
  for(const q of resolved){data.set('perguntas['+q.id+']',q.question);data.set('respostas['+q.id+']',q.value);}
  const blob=new Blob([fs.readFileSync(resumeFile)],{type:'application/pdf'});
  data.set('anexo',blob,path.basename(resumeFile));
  data.set('curriculo_candidato','');
  data.set('form_submit','confirm');

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

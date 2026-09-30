import fs from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { candidateDir, storage } from '../storage.mjs';

const execFileAsync=promisify(execFile);
const BASE='https://candidatos.jobbol.com.br';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156 Safari/537.36';
const locks=new Map();

const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function decodeHtml(s){
  return String(s||'')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#0*39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
}
function plainText(html){
  return decodeHtml(String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
}
function attr(tag,name){
  const m=String(tag||'').match(new RegExp('\\b'+name+'\\s*=\\s*(["\\\'])(.*?)\\1','i'));
  return m?decodeHtml(m[2]):'';
}
function formSchema(html){
  const form=(String(html||'').match(/<form\b[^>]*action=["'][^"']*\/assets\/php\/candidatura\/enviar\.php[^"']*["'][^>]*>[\s\S]*?<\/form>/i)||[])[0]||'';
  if(!form)throw new Error('Jobbol: formulario de candidatura nao encontrado');
  const controls=[];
  for(const m of form.matchAll(/<input\b[^>]*>/gi)){
    const tag=m[0],name=attr(tag,'name'); if(!name)continue;
    controls.push({tag:'INPUT',name,type:(attr(tag,'type')||'text').toLowerCase(),value:attr(tag,'value'),required:/\srequired(?:\s|=|>|\/)/i.test(tag),checked:/\schecked(?:\s|=|>|\/)/i.test(tag)});
  }
  for(const m of form.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)){
    const tag=m[0],open=(tag.match(/^<select\b[^>]*>/i)||[])[0]||'',name=attr(open,'name');if(!name)continue;
    controls.push({tag:'SELECT',name,type:'select',value:'',required:/\srequired(?:\s|=|>|\/)/i.test(open),checked:false});
  }
  for(const m of form.matchAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi)){
    const tag=m[0],open=(tag.match(/^<textarea\b[^>]*>/i)||[])[0]||'',name=attr(open,'name');if(!name)continue;
    controls.push({tag:'TEXTAREA',name,type:'textarea',value:'',required:/\srequired(?:\s|=|>|\/)/i.test(open),checked:false});
  }
  const known=new Set(['csrf','jobkey','arquivo_token','site','nome','email','celular','origem_curriculo','cargo_desejado','escolaridade','sem_experiencia','experiencia_cargo','experiencia_empresa']);
  const unsupportedRequired=[...new Set(controls.filter(x=>x.required&&!known.has(x.name)).map(x=>x.name))];
  const find=name=>controls.find(x=>x.name===name);
  const signature=createHash('sha256').update(JSON.stringify(controls.map(x=>({name:x.name,type:x.type,required:x.required})).sort((a,b)=>(a.name+a.type).localeCompare(b.name+b.type)))).digest('hex').slice(0,16);
  return {form,controls,unsupportedRequired,signature,csrf:find('csrf')?.value||'',jobkey:find('jobkey')?.value||'',emailValue:find('email')?.value||'',accountChecked:controls.some(x=>x.name==='origem_curriculo'&&x.value==='conta'&&x.checked)};
}
function cookiePath(candidateId){
  const dir=candidateDir(candidateId);
  fs.mkdirSync(dir,{recursive:true});
  return path.join(dir,'jobbol-session.cookies');
}
function tmpCookie(jobkey){
  return path.join(storage.temp,`jobbol-${process.pid}-${jobkey}-${Date.now()}-${Math.random().toString(16).slice(2)}.cookies`);
}
async function curl(args,{maxBuffer=2*1024*1024}={}){
  try{
    const {stdout,stderr}=await execFileAsync('curl.exe',args,{windowsHide:true,maxBuffer,encoding:'utf8'});
    return {stdout:String(stdout||''),stderr:String(stderr||'')};
  }catch(e){
    const msg=[e?.message,e?.stderr,e?.stdout].filter(Boolean).join(' | ');
    throw new Error('Jobbol/curl: '+msg.slice(0,800));
  }
}
function splitMeta(text){
  const marker='__LW_CURL_META__';
  const idx=text.lastIndexOf(marker);
  if(idx<0)return {body:text,status:0,url:''};
  const body=text.slice(0,idx).replace(/\s+$/,'');
  const meta=text.slice(idx+marker.length).trim().split('\t');
  return {body,status:Number(meta[0]||0),url:String(meta[1]||'')};
}
async function getForm(jobkey,jar,{writeCookies=false}={}){
  const url=BASE+'/candidatura/'+encodeURIComponent(jobkey);
  const args=['-sS','--max-time','20','-A',UA,'-H','Accept-Language: pt-BR,pt;q=0.9'];
  if(jar&&fs.existsSync(jar))args.push('-b',jar);
  if(jar&&writeCookies)args.push('-c',jar);
  args.push('-w','\n__LW_CURL_META__%{http_code}\t%{url_effective}',url);
  const {stdout}=await curl(args);
  const r=splitMeta(stdout);
  if(r.status!==200||/<title>Just a moment|id=["']challenge-error-text["']|cf-chl-bypass/i.test(r.body))throw new Error('Jobbol: pagina de candidatura indisponivel. HTTP '+r.status);
  return {...r,schema:formSchema(r.body),applyUrl:url};
}
async function checkEmail(email,jobkey){
  const r=await fetch(BASE+'/assets/php/candidatura/checar-email.php',{
    method:'POST',headers:{'user-agent':UA,'content-type':'application/json','accept':'application/json','referer':BASE+'/candidatura/'+jobkey},
    body:JSON.stringify({email:String(email||''),jobkey:String(jobkey||'')}),signal:AbortSignal.timeout(10000)
  });
  if(!r.ok)throw new Error('Jobbol: checagem de email respondeu HTTP '+r.status);
  return r.json();
}
async function uploadResume(file,jobkey,jar){
  const args=['-sS','--max-time','30','-A',UA,'-e',BASE+'/candidatura/'+jobkey,'-b',jar,'-c',jar,'-F',`arquivo=@${file};type=application/pdf`,BASE+'/assets/php/candidatura/upload-cv.php'];
  const {stdout}=await curl(args);
  let data;try{data=JSON.parse(stdout);}catch{throw new Error('Jobbol: upload do curriculo retornou resposta invalida');}
  if(!data?.ok||!data?.token)throw new Error('Jobbol: '+String(data?.mensagem||'upload do curriculo falhou'));
  return data;
}
function confirmation(text,rx){
  const m=String(text||'').match(rx);if(!m)return '';
  const i=Math.max(0,m.index-120),e=Math.min(text.length,(m.index||0)+m[0].length+180);
  return text.slice(i,e).trim().slice(0,500);
}
function receipt(jobkey,r,kind,text=''){
  return {provider:'Jobbol',providerJobId:String(jobkey||''),confirmationType:kind,httpStatus:r?.status||null,responseUrl:r?.url||'',responseHash:createHash('sha256').update(String(r?.body||'')).digest('hex'),confirmationText:String(text||'').slice(0,500)};
}
async function submit(jobkey,jar,schema,token,profile){
  const url=BASE+'/assets/php/candidatura/enviar.php';
  const args=['-sS','-L','--max-time','30','-A',UA,'-e',BASE+'/candidatura/'+jobkey,'-b',jar,'-c',jar,
    '--data-urlencode','csrf='+schema.csrf,'--data-urlencode','jobkey='+jobkey,'--data-urlencode','arquivo_token='+token,
    '--data-urlencode','site=','--data-urlencode','nome='+String(profile.name||''),'--data-urlencode','email='+String(profile.email||''),
    '--data-urlencode','celular='+String(profile.phone||''),'--data-urlencode','origem_curriculo=anexo',
    '-w','\n__LW_CURL_META__%{http_code}\t%{url_effective}',url];
  const {stdout}=await curl(args,{maxBuffer:4*1024*1024});
  return splitMeta(stdout);
}
function withLock(key,fn){
  const prev=locks.get(key)||Promise.resolve();
  const run=prev.catch(()=>{}).then(fn);
  locks.set(key,run);
  return run.finally(()=>{if(locks.get(key)===run)locks.delete(key);});
}
export async function checkJobbolHealth(job){
  const jobkey=String(job?.provider_job_id||job?.externalId||job?.external_id||'').trim();
  if(!jobkey)return {ok:false,error:'Jobbol: codigo da vaga ausente'};
  const jar=tmpCookie(jobkey);
  try{await getForm(jobkey,jar,{writeCookies:true});return {ok:true,error:''};}
  catch(e){return {ok:false,error:String(e?.message||e)};}
  finally{try{fs.unlinkSync(jar);}catch{}}
}
export async function applyJobbolDirect(job,resumeFile,profile,prefs={},options={}){
  const dryRun=options.dryRun!==false;
  const jobkey=String(job?.provider_job_id||job?.externalId||job?.external_id||'').trim();
  if(!jobkey)return {status:'ERROR',error:'Jobbol: codigo da vaga ausente'};
  if(!resumeFile||!fs.existsSync(resumeFile))return {status:'ERROR',error:'Jobbol: curriculo-base nao encontrado'};
  const bytes=fs.statSync(resumeFile).size;
  if(bytes>6*1024*1024)return {status:'ERROR',error:'Jobbol: curriculo excede 6 MB'};
  if(!String(profile.name||'').trim()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(profile.email||''))||String(profile.phone||'').replace(/\D/g,'').length<10)
    return {status:'PROFILE_REQUIRED',error:'Jobbol: nome, email ou celular ausente/invalido'};
  const candidateId=Number(prefs?.candidateId||0);
  const persistent=candidateId?cookiePath(candidateId):'';
  const run=async()=>{
    const preflightJar=(persistent&&fs.existsSync(persistent))?persistent:tmpCookie(jobkey);
    const temporary=preflightJar!==persistent;
    try{
      const form=await getForm(jobkey,preflightJar,{writeCookies:temporary});
      if(!form.schema.csrf||!form.schema.jobkey)return {status:'INVALID_FORM',error:'Jobbol: formulario sem CSRF/jobkey',preflight:{schemaHash:form.schema.signature,providerJobId:jobkey}};
      if(form.schema.unsupportedRequired.length)return {status:'INVALID_FORM',error:'Jobbol: campo obrigatorio novo: '+form.schema.unsupportedRequired.join(', '),preflight:{schemaHash:form.schema.signature,providerJobId:jobkey}};
      const acct=await checkEmail(profile.email,jobkey).catch(()=>({tem_conta:false,tem_curriculo:false,checkFailed:true}));
      const authenticated=norm(form.schema.emailValue)===norm(profile.email)&&Boolean(form.schema.emailValue);
      if(acct?.tem_conta===true&&!authenticated&&dryRun){
        return {status:'LOGIN_REQUIRED',error:'Jobbol: este email ja possui conta e a sessao local nao esta autenticada.',preflight:{schemaHash:form.schema.signature,providerJobId:jobkey,existingAccount:true}};
      }
      const preflight={schemaHash:form.schema.signature,providerJobId:jobkey,resumeMode:'attachment',existingAccount:Boolean(acct?.tem_conta),authenticated};
      if(dryRun)return {status:'READY',error:'',preflight};
      if(persistent&&preflightJar!==persistent){
        try{fs.copyFileSync(preflightJar,persistent);}catch{}
      }
      const actualJar=persistent||preflightJar;
      const liveForm=await getForm(jobkey,actualJar,{writeCookies:true});
      const liveAcct=await checkEmail(profile.email,jobkey).catch(()=>({tem_conta:false}));
      const liveAuthenticated=norm(liveForm.schema.emailValue)===norm(profile.email)&&Boolean(liveForm.schema.emailValue);
      if(liveAcct?.tem_conta===true&&!liveAuthenticated){
        return {status:'LOGIN_REQUIRED',error:'Jobbol: a conta do candidato existe, mas a sessao expirou. E necessario autenticar no Jobbol antes de continuar.',preflight};
      }
      const up=await uploadResume(resumeFile,jobkey,actualJar);
      const r=await submit(jobkey,actualJar,liveForm.schema,up.token,profile);
      const text=plainText(r.body),n=norm(text+' '+r.url);
      const alreadyRx=/ja\s+(?:se\s+)?candidat|candidatura\s+ja\s+(?:foi\s+)?realizada|voce\s+ja\s+se\s+candidat/i;
      const successRx=/candidatura\s+(?:foi\s+)?enviada|candidatura\s+realizada|candidatura\s+concluida|enviada\s+com\s+sucesso|recebemos\s+(?:sua|a)\s+candidatura|obrigado\s+por\s+se\s+candidatar/i;
      const loginRx=/entre\s+na\s+sua\s+conta\s+para\s+se\s+candidatar|faca\s+login\s+para\s+se\s+candidatar/i;
      if(alreadyRx.test(n)){const t=confirmation(n,alreadyRx);return {status:'ALREADY_APPLIED',error:'Candidatura ja registrada no Jobbol',receipt:receipt(jobkey,r,'ALREADY_APPLIED_TEXT',t)};}
      if(successRx.test(n)){const t=confirmation(n,successRx);return {status:'SENT',error:'',receipt:receipt(jobkey,r,'SUCCESS_TEXT',t)};}
      if(loginRx.test(n)){const t=confirmation(n,loginRx);return {status:'LOGIN_REQUIRED',error:'Jobbol solicitou autenticacao para continuar.',receipt:receipt(jobkey,r,'LOGIN_REQUIRED',t)};}
      const errorRx=/confira\s+seu\s+e-?mail|preencha\s+corretamente|nao\s+foi\s+possivel|erro\s+ao\s+enviar|campo\s+obrigatorio/i;
      if(errorRx.test(n)){const t=confirmation(n,errorRx);return {status:'ERROR',error:'Jobbol recusou o envio: '+t,receipt:receipt(jobkey,r,'FORM_ERROR',t)};}
      return {status:'UNCERTAIN',error:'Jobbol respondeu ao envio, mas sem confirmacao textual reconhecida. HTTP '+r.status,receipt:receipt(jobkey,r,'HTTP_UNCONFIRMED','')};
    }finally{
      if(temporary)try{fs.unlinkSync(preflightJar);}catch{}
    }
  };
  return dryRun?run():withLock('candidate:'+String(candidateId||'anon'),run);
}

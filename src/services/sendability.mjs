const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const strip=s=>decode(String(s||'').replace(/<!--[\s\S]*?-->/g,' ').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<noscript\b[\s\S]*?<\/noscript>/gi,' ').replace(/<svg\b[\s\S]*?<\/svg>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
const loginUrlRx=/\/(?:login(?:-candidatos)?|signin|sign-in|auth)(?:[/?#]|$)|\/candidates\/signin(?:[/?#]|$)/i;
const loginTextRx=/fa[cç]a login|entre na sua conta|login para continuar|sign in to apply|log in to apply|acessar sua conta para continuar|criar conta para continuar|cadastre-se para continuar/i;
const emailGateTextRx=/continue(?:r)?\s+(?:com|with)\s+(?:seu\s+)?e-?mail|digite\s+(?:seu\s+)?e-?mail\s+para\s+continuar|e-?mail\s+para\s+(?:entrar|continuar|acessar|cadastrar)|use\s+your\s+email\s+to\s+(?:continue|sign in|log in)/i;
const applyTextRx=/candidat|apply|inscrev|quero me candidatar|enviar curr[ií]culo|candidate-se|tenho interesse|interesse nessa vaga/i;
const applyPathRx=/\/(?:apply|application|applications|candidat|candidates|inscricao|inscricoes|tenho-interesse)(?:[/?#]|$)/i;
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function absolute(href,base){
  try{return new URL(decode(href),base).toString();}catch{return '';}
}
function hostname(value){
  try{return new URL(value).hostname.toLowerCase();}catch{return '';}
}
function linkedInJobId(value){
  try{
    const u=new URL(value);
    return u.searchParams.get('currentJobId')||u.pathname.match(/-(\d{8,})(?:\/|$)/)?.[1]||u.pathname.match(/\/(\d{8,})(?:\/|$)/)?.[1]||'';
  }catch{return String(value||'').match(/(\d{8,})/)?.[1]||'';}
}
function extractApplyLinks(html,base){
  const out=[];
  const anchor=/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=anchor.exec(String(html||'')))){
    const href=absolute(m[2],base), context=strip(`${m[1]} ${m[3]} ${m[4]}`);
    if(href&&!/^mailto:|^tel:|^javascript:/i.test(href)&&(applyTextRx.test(context)||applyPathRx.test(href))) out.push(href);
  }
  const jsonRx=/(?:applyUrl|applicationUrl|apply_url|application_url|externalApplyUrl|external_apply_url|offsiteApplyUrl|offsite_apply_url|companyApplyUrl|company_apply_url|jobApplyUrl|job_apply_url)["']?\s*[:=]\s*["']([^"']+)["']/gi;
  while((m=jsonRx.exec(String(html||'')))){const href=absolute(m[1].replace(/\\u002F/g,'/').replace(/\\\//g,'/'),base);if(href)out.push(href);}
  const attrRx=/(?:data-)?(?:apply-url|application-url|external-apply-url|offsite-apply-url)=["']([^"']+)["']/gi;
  while((m=attrRx.exec(String(html||'')))){const href=absolute(m[1],base);if(href)out.push(href);}
  const escapedRx=/(https?:\\?\/\\?\/[^"'<>\\s]+(?:apply|application|candidat)[^"'<>\\s]*)/gi;
  while((m=escapedRx.exec(String(html||'')))){const href=absolute(m[1].replace(/\\u002F/g,'/').replace(/\\\//g,'/'),base);if(href)out.push(href);}
  return [...new Set(out)];
}async function fetchPage(url,timeout=6500){
  try{
    const r=await fetch(url,{redirect:'follow',headers:{'user-agent':UA,'accept-language':'pt-BR,pt;q=0.9,en;q=0.8'},signal:AbortSignal.timeout(timeout)});
    const html=await r.text().catch(()=>'');
    return {ok:r.ok,status:r.status,url:r.url||url,html,rateLimited:r.status===429};
  }catch(e){return {ok:false,status:0,url,error:String(e?.message||e),html:'',rateLimited:false};}
}
function loginEvidence(page){
  if(!page)return false;
  return loginUrlRx.test(page.url||'')||loginTextRx.test(strip(page.html).slice(0,24000));
}
function emailGateEvidence(page){
  if(!page)return false;
  const h=String(page.html||''),txt=strip(h).slice(0,24000);
  const hasEmailInput=/<input\b[^>]*(?:type=["']email["']|name=["'][^"']*email[^"']*["'])/i.test(h);
  const hasResumeInput=/<input\b[^>]*type=["']file["']/i.test(h)||/name=["'][^"']*(?:curriculo|resume|cv)[^"']*["']/i.test(h);
  return (hasEmailInput&&!hasResumeInput&&(emailGateTextRx.test(txt)||/entrar|login|sign in|log in|continuar|continue|criar conta|cadastro/i.test(txt.slice(0,5000))))||emailGateTextRx.test(txt);
}
function listingPageEvidence(page,job){
  const url=String(page?.url||job?.url||''), html=String(page?.html||'');
  const title=(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const source=String(job?.source||'');
  if(/linkedin/i.test(source)&&/linkedin\.com\/jobs\/(?!view\/)/i.test(url))return true;
  if(/indeed/i.test(source)&&(/\/jobs(?:\?|$)/i.test(url)||/[?&]q=/.test(url)||/\/q-[^/]+-jobs/i.test(url)))return true;
  if(/glassdoor/i.test(source)&&/SRCH_/i.test(url))return true;
  if(/catho/i.test(source)&&/\/vagas\//i.test(url)&&!/\/vaga\//i.test(url)&&/(vagas|empregos)/i.test(title))return true;
  if(/\b\d{2,}\s+vagas\b|vagas de emprego|empregos de .+ em/i.test(title))return true;
  return false;
}
function applicationFormEvidence(page){
  const h=String(page?.html||'');
  const forms=h.match(/<form\b[\s\S]*?<\/form>/gi)||[];
  return forms.some(f=>{
    const strongFile=/type=["']file["']/i.test(f)||/name=["'][^"']*(?:curriculo|resume|cv)[^"']*["']/i.test(f);
    if(strongFile)return true;
    const context=strip(f).slice(0,12000);
    const actionish=/candidat|apply|application|inscrev|vaga|curriculo|resume|cv/i.test(f.slice(0,2500)+' '+context.slice(0,2500));
    const email=/(?:type=["']email["']|name=["'][^"']*email[^"']*["'])/i.test(f);
    const phone=/name=["'][^"']*(?:phone|telefone|celular|whatsapp)[^"']*["']/i.test(f);
    const name=/name=["'][^"']*(?:nome|name)[^"']*["']/i.test(f);
    const submit=/(?:type=["']submit["']|<button\b[^>]*>[^<]*(?:candidat|apply|enviar|finalizar|concluir|inscrev))/i.test(f);
    return actionish&&submit&&[email,phone,name].filter(Boolean).length>=2;
  });
}
async function followApplication(url,depth=0){
  const page=await fetchPage(url,7000);
  if(page.rateLimited)return {sendable:0,reason:'UNVERIFIED_LOGIN',rateLimited:true};
  if(!page.ok)return {sendable:0,reason:'UNVERIFIED_LOGIN'};
  if(loginEvidence(page))return {sendable:0,reason:'LOGIN_REQUIRED'};
  if(emailGateEvidence(page))return {sendable:0,reason:'EMAIL_REQUIRED'};
  if(applicationFormEvidence(page))return {sendable:1,reason:'',httpReady:true};
  if(depth<1){
    const links=extractApplyLinks(page.html,page.url).filter(x=>x!==page.url);
    if(links.length)return followApplication(links[0],depth+1);
  }
  if(applyPathRx.test(page.url))return {sendable:1,reason:''};
  return {sendable:0,reason:'UNVERIFIED_LOGIN'};
}function obviousListingJob(job){
  const url=String(job?.url||''),source=String(job?.source||'');
  if(/linkedin/i.test(source)&&/linkedin\.com\/jobs\/(?!view\/)/i.test(url))return true;
  if(/indeed/i.test(source)&&(/\/empregos-de-/i.test(url)||/\/jobs(?:\?|$)/i.test(url)||/[?&]q=/.test(url)))return true;
  if(/glassdoor/i.test(source)&&/SRCH_/i.test(url))return true;
  if(/catho/i.test(source)&&/\/vagas\/[^/]+\/(?:rio-de-janeiro-rj|[^/]+-[a-z]{2})\/?(?:\?|$)/i.test(url))return true;
  return false;
}
export function initialSendability(job){
  const source=String(job?.source||''),url=String(job?.url||'');
  if(obviousListingJob(job))return {sendable:0,reason:'NOT_JOB_DETAIL',verified:true};
  if(job?.requiresLogin===true&&source==='LinkedIn')return {sendable:0,reason:'UNVERIFIED_LOGIN',verified:false};
  if(job?.requiresLogin===true)return {sendable:0,reason:'LOGIN_REQUIRED',verified:true};
  if(source==='RioVagas'||/riovagas\.com\.br\/riovagas\//i.test(url))return {sendable:1,reason:'',verified:true,httpReady:true};
  return {sendable:0,reason:'UNVERIFIED_LOGIN',verified:false};
}
export async function probeJobSendability(job){
  const source=String(job?.source||'');
  const first=await fetchPage(job.url,7000);
  if(first.rateLimited)return {sendable:0,reason:'UNVERIFIED_LOGIN',verified:false,rateLimited:true};
  if(!first.ok)return {sendable:0,reason:'UNVERIFIED_LOGIN',verified:false};

  const detailText=strip(first.html).slice(0,30000);
  const withDetail=result=>({...result,detailText});

  if(listingPageEvidence(first,job))return withDetail({sendable:0,reason:'NOT_JOB_DETAIL',verified:true});
  if(source==='RioVagas')return withDetail({sendable:1,reason:'',verified:true,httpReady:true});

  const links=extractApplyLinks(first.html,first.url);
  if(source==='LinkedIn'){
    const unwrap=x=>{try{const u=new URL(x);if(/(^|\.)linkedin\.com$/i.test(u.hostname)&&/redir|redirect|externalApply/i.test(u.pathname)){for(const k of ['url','target','dest','destination','redirect']){const v=u.searchParams.get(k);if(v)return decodeURIComponent(v);}}return x;}catch{return x;}};
    const externalFrom=page=>extractApplyLinks(page?.html||'',page?.url||job.url).map(unwrap).find(x=>!/linkedin\.com$/i.test(hostname(x))&&!/\.linkedin\.com$/i.test(hostname(x)));
    let external=externalFrom(first);
    let guest=null;
    if(!external){
      const id=linkedInJobId(job.url);
      if(id){
        guest=await fetchPage(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,7000);
        if(guest.ok)external=externalFrom(guest);
      }
    }
    if(external){const r=await followApplication(external);return withDetail({...r,verified:r.reason!=='UNVERIFIED_LOGIN',externalUrl:external});}
    const combined=`${first.html||''} ${guest?.html||''}`;
    if(loginEvidence(first)||/sign-in-modal|authwall|sign in to apply|log in to apply/i.test(combined))return withDetail({sendable:0,reason:'LOGIN_REQUIRED',verified:true});
    if(emailGateEvidence(first)||(guest&&emailGateEvidence(guest)))return withDetail({sendable:0,reason:'EMAIL_REQUIRED',verified:true});
    return withDetail({sendable:0,reason:'UNVERIFIED_LOGIN',verified:false});
  }

  if(loginEvidence(first))return withDetail({sendable:0,reason:'LOGIN_REQUIRED',verified:true});
  if(emailGateEvidence(first))return withDetail({sendable:0,reason:'EMAIL_REQUIRED',verified:true});

  if(source==='Gupy'||source==='Vagas.com'){
    const apply=links.find(x=>applyPathRx.test(x))||links[0];
    if(apply){const r=await followApplication(apply);return withDetail({...r,verified:r.reason!=='UNVERIFIED_LOGIN'});}
    return withDetail(applicationFormEvidence(first)?{sendable:1,reason:'',verified:true,httpReady:true}:{sendable:0,reason:'UNVERIFIED_LOGIN',verified:false});
  }

  if(applicationFormEvidence(first))return withDetail({sendable:1,reason:'',verified:true,httpReady:true});
  if(links.length){const r=await followApplication(links[0]);return withDetail({...r,verified:r.reason!=='UNVERIFIED_LOGIN'});}
  return withDetail({sendable:0,reason:'UNVERIFIED_LOGIN',verified:false});
}
async function runGroup(rows,workers){
  let cursor=0,rateLimited=false;
  async function worker(){
    while(cursor<rows.length&&!rateLimited){
      const job=rows[cursor++];
      const result=await probeJobSendability(job);
      Object.assign(job,result);
      if(result.rateLimited)rateLimited=true;
      if(job.source==='Vagas.com')await delay(650);
    }
  }
  await Promise.all(Array.from({length:Math.min(workers,rows.length)},()=>worker()));
}
export async function classifyJobsForQueue(jobs,{batchSize=500,probeLimit=1800}={}){
  const prepared=jobs.map(job=>({...job,...initialSendability(job)}));
  const maxProbes=Math.min(prepared.length,Math.max(batchSize*2,Number(probeLimit||1800)));
  let probed=0;
  while(probed<maxProbes){
    let sendableSeen=0,cutoff=prepared.length-1;
    for(let i=0;i<prepared.length;i++){if(prepared[i].sendable===1&&++sendableSeen>=batchSize){cutoff=i;break;}}
    const pending=[];
    for(let i=0;i<=cutoff&&pending.length<120&&probed+pending.length<maxProbes;i++){
      const j=prepared[i]; if(!j.verified&&!j._probing&&!j._sendabilityChecked){j._probing=true;pending.push(j);}
    }
    if(!pending.length) break;
    probed+=pending.length;
    const groups=new Map();
    for(const job of pending){const source=job.source||'Outra';if(!groups.has(source))groups.set(source,[]);groups.get(source).push(job);}
    await Promise.all([...groups.entries()].map(([source,rows])=>{
      const workers=source==='Vagas.com'?1:source==='Gupy'?3:source==='LinkedIn'?5:4;
      return runGroup(rows,workers);
    }));
    for(const j of pending){delete j._probing;j._sendabilityChecked=true;}
  }
  return prepared;
}
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const uniq=rows=>[...new Map(rows.filter(x=>x?.url&&x?.title).map(x=>[x.url,x])).values()];
const htmlDecode=s=>String(s||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

function parseBrDate(text){
  const m=String(text||'').match(/(?:publicad[ao]\s+em\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if(!m)return '';
  return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}T12:00:00-03:00`;
}
function recentEnough(date,days=15){
  if(!date)return true;
  const ms=Date.parse(date); if(!Number.isFinite(ms))return true;
  return ms>=Date.now()-Math.max(1,Math.min(60,Number(days)||15))*86400000;
}
function money(text){
  return String(text||'').match(/R\$\s*[\d.]+(?:,\d{2})?(?:\s*[–-]\s*R\$\s*[\d.]+(?:,\d{2})?)?/i)?.[0]||(/a combinar/i.test(text||'')?'A combinar':'');
}
function remoteFrom(text){return /remot|home office|home-office|100%\s*remot/i.test(String(text||''));}
function cleanTitle(text){
  let s=String(text||'').replace(/\s+/g,' ').trim();
  s=s.replace(/^(?:vaga urgente\s*)?#?\d+\s*[-–]\s*/i,'');
  s=s.replace(/\s+publicad[ao]\s+em\s+\d{1,2}\/\d{1,2}\/\d{4}[\s\S]*$/i,'').trim();
  return s;
}
function desiredLocation(filters){
  return norm([...(filters.cities||[]),filters.city,...(filters.states||[]),filters.state].filter(Boolean).join(' '));
}
async function browser(){
  return chromium.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
}
async function pageLinks(page,selector,base){
  return page.locator(selector).evaluateAll((as,base)=>as.map(a=>({text:(a.innerText||a.textContent||'').replace(/\s+/g,' ').trim(),href:new URL(a.getAttribute('href')||'',base).toString()})),base);
}
async function bodyTextFrom(url,browserInstance){
  const p=await browserInstance.newPage({locale:'pt-BR'});
  try{await p.goto(url,{waitUntil:'domcontentloaded',timeout:16000});await p.waitForTimeout(900);return (await p.locator('body').innerText({timeout:5000}).catch(()=>'' )).replace(/[ \t]+/g,' ').trim();}
  catch{return '';}finally{await p.close();}
}
async function detailSnapshot(url,browserInstance){
  const p=await browserInstance.newPage({locale:'pt-BR'});
  try{
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:16000});await p.waitForTimeout(900);
    return {h1:(await p.locator('h1').first().innerText({timeout:3000}).catch(()=>'' )).trim(),body:(await p.locator('body').innerText({timeout:5000}).catch(()=>'' )).replace(/[ \t]+/g,' ').trim()};
  }catch{return {h1:'',body:''};}finally{await p.close();}
}
async function huannaMeta(url){
  try{
    const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(7000)});
    const h=await r.text(); if(!r.ok)return {};
    const pick=rx=>htmlDecode(h.match(rx)?.[1]||'');
    return {
      publishedAt:pick(/"datePosted"\s*:\s*"([^"]+)"/i),
      company:pick(/"hiringOrganization"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i),
      city:pick(/"addressLocality"\s*:\s*"([^"]+)"/i),
      state:pick(/"addressRegion"\s*:\s*"([^"]+)"/i)
    };
  }catch{return {};}
}

export async function searchTramper(terms,filters,max=500){
  const b=await browser(),out=[];
  try{
    const p=await b.newPage({locale:'pt-BR'});
    await p.goto('https://tramper.com.br/vagas',{waitUntil:'domcontentloaded',timeout:20000});
    for(let i=0;i<5;i++){await p.mouse.wheel(0,5000).catch(()=>{});await delay(250);}
    const rows=await pageLinks(p,'a[href^="/vaga/"],a[href*="tramper.com.br/vaga/"]','https://tramper.com.br/');
    await p.close();
    for(const r of rows){
      if(out.length>=max)break;
      const text=r.text.replace(/\bVer vaga\b/gi,'').trim();
      const snap=await detailSnapshot(r.href,b),detail=snap.body;
      const lines=detail.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      const title=cleanTitle(snap.h1||text);
      if(!title)continue;
      const idx=lines.findIndex(x=>norm(x)===norm(title));
      const company=idx>=0?(lines[idx+1]||''):'';
      const location=idx>=0?(lines[idx+2]||''):(text.match(/\b([A-ZÀ-Ý][\wÀ-ÿ .'-]+,\s*[A-Z]{2})\b/)?.[1]||'');
      const publishedAt=parseBrDate(detail||text);
      if(!recentEnough(publishedAt,filters.recencyDays))continue;
      out.push({source:'Tramper',title,company,location,url:r.href,description:(detail||text).slice(0,24000),salary:money(detail||text),contractType:'',publishedAt,remote:remoteFrom(detail||text),loginFreeCandidate:true,broadCollection:true});
    }
  }catch(e){console.log('[Tramper]',String(e?.message||e));}
  finally{await b.close().catch(()=>{});}
  return uniq(out).slice(0,max);
}

export async function searchHuanna(terms,filters,max=500){
  const b=await browser(),out=[],seen=new Set();
  try{
    const p=await b.newPage({locale:'pt-BR'});
    for(let pg=1;pg<=8&&out.length<max;pg++){
      const url='https://huanna.com.br/vagas'+(pg>1?`?page=${pg}`:'');
      try{await p.goto(url,{waitUntil:'domcontentloaded',timeout:16000});}catch{break;}
      const rows=(await pageLinks(p,'a[href^="/vagas/"]','https://huanna.com.br/')).filter(x=>!x.href.endsWith('/candidatar'));
      if(!rows.length)break;
      let added=0;
      for(const r of rows){
        if(seen.has(r.href))continue;seen.add(r.href);
        const text=r.text;
        const lines=text.split(/(?=R\$|A combinar|EM DESTAQUE)/i);
        const slug=new URL(r.href).pathname.split('/').filter(Boolean).at(-1)||'';
        let title=slug.replace(/-[a-z0-9]{4}$/i,'').replace(/-/g,' ').replace(/\b\w/g,m=>m.toUpperCase()).trim();
        if(!title)title=text.replace(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ ]{3,25}\s+/,'').split(/R\$|A combinar|EM DESTAQUE/i)[0].trim();
        const meta=await huannaMeta(r.href);
        const loc=[meta.city,meta.state].filter(Boolean).join(' - ')||text.match(/([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ .'-]+)\s+[—-]\s+([A-Z]{2})\b/)?.[0]||'';
        const publishedAt=meta.publishedAt||'';
        if(!recentEnough(publishedAt,filters.recencyDays))continue;
        out.push({source:'Huanna',title:cleanTitle(title),company:meta.company||'',location:loc,url:r.href,description:text,salary:money(text),contractType:/CLT/i.test(text)?'CLT':/Prestador|PJ/i.test(text)?'PJ':'',publishedAt,remote:remoteFrom(text),loginFreeCandidate:true,broadCollection:true});
        added++;
        if(out.length>=max)break;
      }
      if(!added)break;
    }
    await p.close();
  }catch(e){console.log('[Huanna]',String(e?.message||e));}
  finally{await b.close().catch(()=>{});}
  return uniq(out).slice(0,max);
}

export async function searchBeaVagas(terms,filters,max=500){
  const b=await browser(),out=[],seen=new Set();
  try{
    const p=await b.newPage({locale:'pt-BR'});
    for(let pg=1;pg<=12&&out.length<max;pg++){
      try{await p.goto(`https://beavagas.com.br/vagas?page=${pg}`,{waitUntil:'domcontentloaded',timeout:16000});}catch{break;}
      const rows=await pageLinks(p,'a[href*="/vagas/p/"]','https://beavagas.com.br/');
      if(!rows.length)break;
      let anyRecent=false;
      for(const r of rows){
        if(seen.has(r.href))continue;seen.add(r.href);
        const text=r.text;
        const publishedAt=parseBrDate(text);
        if(publishedAt&&recentEnough(publishedAt,filters.recencyDays))anyRecent=true;
        if(!recentEnough(publishedAt,filters.recencyDays))continue;
        const title=cleanTitle(text);
        const loc=text.match(/\b([A-ZÀ-Ý][\wÀ-ÿ .'-]+)\s+-\s+([A-Z]{2})\b/)?.[0]||(/\bRJ\b/.test(text)?'RJ':'');
        const company=(text.match(/\b(?:R\$\s*[\d.]+(?:,\d{2})?|A combinar)\s+([^|]{2,70})/)?.[1]||'').trim();
        out.push({source:'BeaVagas',title,company,location:loc,url:r.href,description:text,salary:money(text),contractType:'',publishedAt,remote:remoteFrom(text),loginFreeCandidate:true,broadCollection:true});
        if(out.length>=max)break;
      }
      if(pg>2&&!anyRecent)break;
    }
    await p.close();
  }catch(e){console.log('[BeaVagas]',String(e?.message||e));}
  finally{await b.close().catch(()=>{});}
  return uniq(out).slice(0,max);
}

export async function searchEmpregoDaqui(terms,filters,max=500){
  const b=await browser(),out=[],seen=new Set();
  try{
    const p=await b.newPage({locale:'pt-BR'});
    await p.goto('https://empregodaqui.com.br/vagas',{waitUntil:'domcontentloaded',timeout:16000});
    const cityLinks=(await pageLinks(p,'a[href^="/vagas/"]','https://empregodaqui.com.br/')).filter(x=>/\/vagas\/[^/?#]+$/.test(new URL(x.href).pathname));
    const wanted=desiredLocation(filters),wantedCity=norm(filters.city),wantedState=norm(filters.state);
    let selected=cityLinks.filter(x=>{const t=norm(x.text).replace(/\d+\s+vagas?.*$/,'').trim();return wantedCity?t.includes(wantedCity):wantedState?t.endsWith(' '+wantedState)||t===wantedState:!wanted;});
    if(filters.nationwide)selected=cityLinks.slice(0,20);
    selected=[...new Map(selected.map(x=>[x.href,x])).values()].slice(0,20);
    for(const city of selected){
      if(out.length>=max)break;
      try{await p.goto(city.href,{waitUntil:'domcontentloaded',timeout:14000});}catch{continue;}
      const jobs=await pageLinks(p,'a[href^="/vaga/"]','https://empregodaqui.com.br/');
      for(const r of jobs){
        if(seen.has(r.href))continue;seen.add(r.href);
        const text=r.text;
        const detail=await bodyTextFrom(r.href,b);
        const publishedAt=parseBrDate(detail||text);
        if(!recentEnough(publishedAt,filters.recencyDays))continue;
        const title=cleanTitle((detail||text).split(/\n|\s{2,}/)[0]||text);
        const loc=(detail.match(/\b([A-ZÀ-Ý][\wÀ-ÿ .'-]+)\s*[·-]\s*([A-Z]{2})\b/)?.[0]||city.text.replace(/\d+\s+VAGAS?/i,'').trim());
        const hasEmail=/mailto:/i.test(await p.locator('body').innerHTML().catch(()=>''));
        out.push({source:'EmpregoDaqui',title,company:'',location:loc,url:r.href,description:(detail||text).slice(0,24000),salary:money(detail||text),contractType:/\bCLT\b/i.test(detail||text)?'CLT':'',publishedAt,remote:remoteFrom(detail||text),loginFreeCandidate:false,broadCollection:true,applicationChannel:hasEmail?'email_or_whatsapp':'whatsapp'});
        if(out.length>=max)break;
      }
    }
    await p.close();
  }catch(e){console.log('[EmpregoDaqui]',String(e?.message||e));}
  finally{await b.close().catch(()=>{});}
  return uniq(out).slice(0,max);
}

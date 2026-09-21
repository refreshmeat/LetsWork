const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const strip=s=>clean(decode(String(s||'').replace(/<[^>]+>/g,' ')));
const uniq=rows=>[...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const knownHosts=/indeed\.|infojobs\.|catho\.|glassdoor\.|talent\.com|jobbol\.|trabalhabrasil\.|empregos\.com\.br|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com|teamtailor\.com|myworkdayjobs\.com|workdayjobs\.com|gupy\.io|vagas\.com\.br|linkedin\.com|trampos\.co|99jobs\.com|ciee\.org\.br|nube\.com\.br/i;
const jobWords=/\b(vaga|vagas|emprego|empregos|est[aá]gio|estagi[aá]ri[oa]|job|jobs|career|careers|apply|candidat|oportunidade|oportunidades)\b/i;

function sourceName(url){
  let h='';try{h=new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{}
  if(/indeed/.test(h))return 'Indeed';
  if(/infojobs/.test(h))return 'InfoJobs';
  if(/catho/.test(h))return 'Catho';
  if(/glassdoor/.test(h))return 'Glassdoor';
  if(/talent\.com/.test(h))return 'Talent.com';
  if(/jobbol/.test(h))return 'Jobbol';
  if(/trabalhabrasil/.test(h))return 'Trabalha Brasil';
  if(/empregos\.com\.br/.test(h))return 'Empregos.com.br';
  if(/greenhouse\.io/.test(h))return 'Greenhouse';
  if(/lever\.co/.test(h))return 'Lever';
  if(/workable\.com/.test(h))return 'Workable';
  if(/smartrecruiters\.com/.test(h))return 'SmartRecruiters';
  if(/teamtailor\.com/.test(h))return 'Teamtailor';
  if(/workday/.test(h))return 'Workday';
  if(/trampos\.co/.test(h))return 'Trampos';
  if(/99jobs/.test(h))return '99jobs';
  if(/ciee/.test(h))return 'CIEE';
  if(/nube/.test(h))return 'Nube';
  return h?('Web · '+h):'Web';
}
function decodeDuckUrl(href){
  try{
    const raw=decode(String(href||'')),full=raw.startsWith('//')?'https:'+raw:raw;
    const u=new URL(full,'https://duckduckgo.com');
    return decodeURIComponent(u.searchParams.get('uddg')||full);
  }catch{return '';}
}
function accept(url,title,snippet){
  if(!/^https?:/i.test(url))return false;
  if(/(?:google|bing|duckduckgo|brave)\./i.test(url))return false;
  if(/\.(?:pdf|jpg|jpeg|png|gif)(?:$|\?)/i.test(url))return false;
  let h='';try{h=new URL(url).hostname;}catch{}
  const pathJob=/\/(?:job|jobs|vaga|vagas|career|careers|position|positions|oportunidade|oportunidades|apply|candidat)/i.test(url);
  return knownHosts.test(h)||pathJob||jobWords.test(title)||jobWords.test(snippet);
}
async function brave(query,max){
  const out=[];
  try{
    const r=await fetch('https://search.brave.com/search?q='+encodeURIComponent(query)+'&source=web',{
      headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.7'},
      signal:AbortSignal.timeout(8000)
    });
    if(!r.ok)return out;
    const html=await r.text();
    const blocks=html.split(/<div class="snippet [^"]*"[^>]*data-type="web"[^>]*>/i).slice(1);
    for(const block of blocks){
      const href=decode(block.match(/<a[^>]+href="(https?:\/\/[^\"]+)"/i)?.[1]||'');
      const title=strip(block.match(/<div class="title[^"]*"[^>]*title="([^"]+)"/i)?.[1]||block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
      const snippet=strip(block.match(/<div class="generic-snippet[\s\S]*?<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
      if(href&&accept(href,title,snippet))out.push({url:href,title,snippet});
      if(out.length>=max)break;
    }
  }catch{}
  return out;
}
async function duck(query,max){
  const out=[];
  try{
    const r=await fetch('https://html.duckduckgo.com/html/?q='+encodeURIComponent(query)+'&kl=br-pt',{
      headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9,en;q=0.7'},signal:AbortSignal.timeout(8000)
    });
    if(!r.ok)return out;
    const html=await r.text();
    const blocks=html.split(/<div class="result results_links[^>]*>/i).slice(1);
    for(const block of blocks){
      const raw=block.match(/class="result__a"[^>]*href="([^"]+)"/i)?.[1]||'';
      const href=decodeDuckUrl(raw);
      const title=strip(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i)?.[1]||'');
      const snippet=strip(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1]||'');
      if(href&&accept(href,title,snippet))out.push({url:href,title,snippet});
      if(out.length>=max)break;
    }
  }catch{}
  return out;
}

function slug(value){
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
async function getHtml(url,timeout=10000){
  try{
    const r=await fetch(url,{
      headers:{
        'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'accept-language':'pt-BR,pt;q=0.9,en;q=0.6'
      },
      redirect:'follow',
      signal:AbortSignal.timeout(timeout)
    });
    if(!r.ok)return '';
    return await r.text();
  }catch{return '';}
}
function parseInfoJobsDate(value){
  const m=String(value||'').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m?(m[1]+'-'+m[2]+'-'+m[3]+'T12:00:00-03:00'):'';
}
async function infoJobs(term,max=120){
  const html=await getHtml('https://www.infojobs.com.br/vagas-de-emprego-'+slug(term)+'.aspx?campo=griddate&orden=desc',12000);
  if(!html)return [];
  const out=[];
  const parts=html.split(/<div id="vacancy\d+"/i).slice(1);
  for(const block of parts){
    const href=decode(block.match(/data-href="([^"]+)"/i)?.[1]||block.match(/href="([^"]*\/vaga-de-[^"]+)"/i)?.[1]||'');
    const title=strip(block.match(/<h2[^>]*js_vacancyTitle[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||'');
    if(!href||!title)continue;
    const date=parseInfoJobsDate(block.match(/class="js_date"[^>]*data-value="([^"]+)"/i)?.[1]||'');
    const location=strip(block.match(/<div class="mb-8">([\s\S]*?)<\/div>/i)?.[1]||'');
    const company=strip(block.match(/<a[^>]+href="[^"]*empresa-[^"]+"[^>]*>([\s\S]*?)<\/a>/i)?.[1]||'');
    const description=strip(block.match(/<div class="text-medium">([\s\S]*?)<\/div>/i)?.[1]||'');
    const salary=strip(block.match(/icon-money[\s\S]{0,900}?<\/svg>([\s\S]{0,500}?)<\/div>/i)?.[1]||'');
    out.push({
      source:'InfoJobs',title,company,salary,location,
      url:new URL(href,'https://www.infojobs.com.br').href,
      description,contractType:'',publishedAt:date,loginFreeCandidate:false
    });
    if(out.length>=max)break;
  }
  return out;
}
function cathoDate(text){
  const m=String(text||'').match(/Publicada em\s*(\d{1,2})\/(\d{1,2})/i);
  if(!m)return '';
  let year=new Date().getFullYear();
  const month=Number(m[2]),nowMonth=new Date().getMonth()+1;
  if(month>nowMonth+2)year--;
  return year+'-'+String(month).padStart(2,'0')+'-'+String(Number(m[1])).padStart(2,'0')+'T12:00:00-03:00';
}
async function catho(term,filters,max=120){
  const city=slug(filters.city||'rio-de-janeiro');
  const state=slug(filters.state||'rj');
  const loc=filters.nationwide?'':'/'+city+'-'+state;
  const html=await getHtml('https://www.catho.com.br/vagas/'+slug(term)+loc+'/',12000);
  if(!html)return [];
  const out=[];
  const parts=html.split(/<li data-offer-item="/i).slice(1);
  for(const block of parts){
    const href=decode(block.match(/<h2[^>]*title_offer[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i)?.[1]||'');
    const title=strip(block.match(/<h2[^>]*title_offer[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]||'');
    if(!href||!title)continue;
    const company=strip(block.match(/<p class="mb-2">[\s\S]*?<span[^>]*text-12[^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
    const locText=strip(block.match(/i_job_location[\s\S]*?<\/span>([\s\S]*?)<\/p>/i)?.[1]||'').replace(/^\s*\d+\s*vaga[s]?\s*-?\s*/i,'');
    const salary=strip(block.match(/i_salary[\s\S]*?<\/span>([\s\S]*?)<\/p>/i)?.[1]||'');
    const publishedAt=cathoDate(block);
    out.push({
      source:'Catho',title,company,salary,location:locText,
      url:new URL(href,'https://www.catho.com.br').href,
      description:'',contractType:'',publishedAt,loginFreeCandidate:false
    });
    if(out.length>=max)break;
  }
  return out;
}
async function talent(term,filters,max=120){
  const place=filters.nationwide?'Brasil':[filters.city,filters.state].filter(Boolean).join(', ');
  const out=[];
  for(let page=1;page<=3&&out.length<max;page++){
    const html=await getHtml('https://br.talent.com/jobs?k='+encodeURIComponent(term)+'&l='+encodeURIComponent(place)+'&p='+page,12000);
    if(!html)break;
    const urls=[...html.matchAll(/"url":"(https:\/\/br\.talent\.com\/view\?id=\d+)"/g)].map(m=>m[1]);
    const blocks=html.split(/data-testid="jobcard-container-[^"]+"/i).slice(1);
    let added=0;
    for(let i=0;i<Math.min(urls.length,blocks.length);i++){
      const block=blocks[i];
      const title=strip(block.match(/<h2[^>]*JobCard_title[^>]*>([\s\S]*?)<\/h2>/i)?.[1]||'');
      if(!title)continue;
      const company=strip(block.match(/<span[^>]*JobCard_company[^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
      const location=strip(block.match(/<span[^>]*JobCard_location[^>]*>([\s\S]*?)<\/span>/i)?.[1]||'');
      const description=strip(block.match(/<p[^>]*JobCard_snippet[^>]*>([\s\S]*?)<\/p>/i)?.[1]||'');
      const publishedAt=block.match(/<time[^>]+dateTime="([^"]+)"/i)?.[1]||'';
      out.push({
        source:'Talent.com',title,company,salary:'',location,url:urls[i],
        description,contractType:'',publishedAt,loginFreeCandidate:false
      });
      added++; if(out.length>=max)break;
    }
    if(!added)break;
  }
  return uniq(out).slice(0,max);
}
async function directPortals(terms,filters,max=1800){
  const queue=[...new Set((terms||[]).map(x=>String(x||'').trim()).filter(Boolean))].slice(0,40);
  const out=new Map(),deadline=Date.now()+85000; let cursor=0;
  async function worker(){
    while(cursor<queue.length&&out.size<max&&Date.now()<deadline){
      const term=queue[cursor++];
      const [a,b,c]=await Promise.all([
        infoJobs(term,80),
        catho(term,filters,80),
        talent(term,filters,80)
      ]);
      for(const row of [...a,...b,...c]){
        if(!row.url||out.has(row.url))continue;
        out.set(row.url,row);
        if(out.size>=max)break;
      }
      await delay(80);
    }
  }
  await Promise.all(Array.from({length:Math.min(5,queue.length||1)},()=>worker()));
  const rows=[...out.values()].slice(0,max);
  const by=rows.reduce((a,j)=>(a[j.source]=(a[j.source]||0)+1,a),{});
  console.log('[Web] portais diretos: '+rows.length+' '+JSON.stringify(by));
  return rows;
}
async function indexedSearch(terms,filters,max=600){
  const cutoff=new Date(Date.now()-Math.max(1,Math.min(60,Number(filters.recencyDays||15)))*86400000).toISOString().slice(0,10);
  const place=filters.nationwide?'Brasil':[filters.city,filters.state].filter(Boolean).join(' ');
  const queue=[...new Set((terms||[]).map(x=>String(x||'').trim()).filter(Boolean))].slice(0,18);
  const out=new Map(),deadline=Date.now()+50000;let cursor=0;
  async function worker(){
    while(cursor<queue.length&&out.size<max&&Date.now()<deadline){
      const term=queue[cursor++];
      const q=['"'+term+'"',place?('"'+place+'"'):'','(vaga OR emprego OR estágio OR estagio OR job OR careers)','after:'+cutoff].filter(Boolean).join(' ');
      const pair=await Promise.all([brave(q,20),duck(q,20)]);
      for(const row of [...pair[0],...pair[1]]){
        if(out.has(row.url))continue;
        const source=sourceName(row.url);
        out.set(row.url,{source,title:row.title||term,company:'',salary:'',location:place,url:row.url,description:row.snippet||'',contractType:'',publishedAt:cutoff,indexedRecent:true,loginFreeCandidate:false,webDiscovered:true});
        if(out.size>=max)break;
      }
      await delay(120);
    }
  }
  await Promise.all(Array.from({length:Math.min(3,queue.length||1)},()=>worker()));
  return uniq([...out.values()]).slice(0,max);
}
export async function searchWebJobs(terms,filters,max=1800){
  const [direct,indexed]=await Promise.all([
    directPortals(terms,filters,max),
    indexedSearch(terms,filters,Math.min(600,max))
  ]);
  const rows=uniq([...direct,...indexed]).slice(0,max);
  console.log('[Web] total: '+rows.length+' vagas/anúncios candidatos');
  return rows;
}

const uniq=rows=>[...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
const strip=s=>clean(decode(String(s||'').replace(/<[^>]+>/g,' ')));
function locationText(filters){return filters.nationwide?'Brasil':[filters.city,filters.state,'Brasil'].filter(Boolean).join(', ');}
function parseGuest(html){
  const blocks=String(html||'').match(/<li>[\s\S]*?<\/li>/gi)||[];
  return blocks.map(block=>{
    const href=decode(block.match(/<a[^>]+class="[^"]*base-card__full-link[^"]*"[^>]+href="([^"]+)"/i)?.[1]||'');
    const title=strip(block.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    const company=strip(block.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i)?.[1]);
    const location=strip(block.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const publishedAt=decode(block.match(/<time[^>]*datetime="([^"]+)"/i)?.[1]||'');
    return href&&title?{source:'LinkedIn',title,company,location,url:href,publishedAt,salary:'',contractType:'',description:`${title} ${company} ${location}`,loginFreeCandidate:false}:null;
  }).filter(Boolean);
}
async function guestPage(term,location,days,start){
  const qs=new URLSearchParams({keywords:term,location,f_TPR:`r${days*86400}`,start:String(start)});
  const url=`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs}`;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'},signal:AbortSignal.timeout(7000)});
      if(r.status===429){await delay(700+attempt*500);continue;}
      return r.ok?parseGuest(await r.text()):[];
    }catch{return [];}
  }
  return [];
}
export async function searchLinkedIn(terms,filters,max=350){
  const out=[],seen=new Set(),days=Math.max(1,Math.min(60,Number(filters.recencyDays||15))),location=locationText(filters),deadline=Date.now()+50000;
  const starts=[0,25,50,75,100,125,150,175,200,225];
  for(const term of terms.slice(0,32)){
    if(out.length>=max||Date.now()>=deadline)break;
    for(const start of starts){
      if(out.length>=max||Date.now()>=deadline)break;
      const rows=await guestPage(term,location,days,start);
      for(const job of rows){const key=job.url.replace(/[?&].*$/,'');if(seen.has(key))continue;seen.add(key);out.push(job);if(out.length>=max)break;}
      await delay(100);
    }
  }
  return uniq(out).slice(0,max);
}

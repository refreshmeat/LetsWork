import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const uniq = rows => [...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];
const clean = s => String(s || '').replace(/\s+/g,' ').trim();
const stateNames={AC:'Acre',AL:'Alagoas',AP:'Amapá',AM:'Amazonas',BA:'Bahia',CE:'Ceará',DF:'Distrito Federal',ES:'Espírito Santo',GO:'Goiás',MA:'Maranhão',MT:'Mato Grosso',MS:'Mato Grosso do Sul',MG:'Minas Gerais',PA:'Pará',PB:'Paraíba',PR:'Paraná',PE:'Pernambuco',PI:'Piauí',RJ:'Rio de Janeiro',RN:'Rio Grande do Norte',RS:'Rio Grande do Sul',RO:'Rondônia',RR:'Roraima',SC:'Santa Catarina',SP:'São Paulo',SE:'Sergipe',TO:'Tocantins'};
const stateValue=v=>stateNames[String(v||'').trim().toUpperCase()]||String(v||'').trim();

function parseCard(text, url) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const pub = lines.findIndex(x => /^Publicada em:/i.test(x));
  const core = (pub >= 0 ? lines.slice(0,pub) : lines).filter(x=>!/Também p\/ PcD/i.test(x));
  if (core.length < 2) return null;
  const company = core[0] || '';
  const title = core[1] || '';
  const location = core[2] || '';
  const mode = core.find(x=>/Presencial|Híbrido|Remoto/i.test(x)) || '';
  const contractType = core.find(x=>/Efetivo|Estágio|Aprendiz|Temporário|Freelance/i.test(x)) || '';
  const publishedAt=lines.find(x=>/^Publicada em:/i.test(x))?.replace(/^Publicada em:\s*/i,'')||'';
  return { source:'Gupy', title, company, location, url, salary:'', publishedAt,
    description:text, contractType, remote:/remoto/i.test(mode), pcd:/Também p\/ PcD/i.test(text), loginFreeCandidate:false };
}

async function blockNoise(page) {
  await page.route('**/*', route => {
    const r=route.request(), u=r.url(), t=r.resourceType();
    if (/doubleclick|googlesyndication|google-analytics|googletagmanager|hotjar|clarity/i.test(u)) return route.abort();
    if (['media','font','image','stylesheet'].includes(t)) return route.abort();
    return route.continue();
  });
}export async function searchGupy(terms, filters, max=150) {
  const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
  const out=[],seen=new Set(),queue=terms.slice(0,32); let cursor=0;
  const deadline=Date.now()+55000;
  async function worker(){
    const page=await browser.newPage();await blockNoise(page);
    try{
      while(cursor<queue.length&&out.length<max&&Date.now()<deadline){
        const term=queue[cursor++];
        const state=!filters.nationwide&&filters.state?`&state=${encodeURIComponent(stateValue(filters.state))}`:'';
        const url=`https://portal.gupy.io/job-search/term=${encodeURIComponent(term)}${state}`;
        try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:12000});}catch{continue;}
        await page.waitForTimeout(350);
        for(let n=1;n<=6&&out.length<max&&Date.now()<deadline;n++){
          const cards=await page.locator('a[href*=".gupy.io/job/"]').evaluateAll(as=>as.map(a=>({text:(a.innerText||'').trim(),url:a.href})));
          for(const card of cards){if(seen.has(card.url))continue;const parsed=parseCard(card.text,card.url);if(parsed?.title){seen.add(card.url);out.push(parsed);if(out.length>=max)break;}}
          const next=page.getByRole('button',{name:`Página ${n+1}`}).first();
          if(!await next.count())break;
          await next.click({timeout:2000}).catch(()=>{});await page.waitForTimeout(200);
        }
      }
    }finally{await page.close().catch(()=>{});}
  }
  try{await Promise.all(Array.from({length:Math.min(2,queue.length)},()=>worker()));return uniq(out).slice(0,max);}
  finally{await browser.close().catch(()=>{});}
}

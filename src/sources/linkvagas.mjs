import { chromium } from 'playwright-core';

const CHROME=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const uniq=rows=>[...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];
const stateCodes={
  'acre':'AC','alagoas':'AL','amapa':'AP','amazonas':'AM','bahia':'BA','ceara':'CE','distrito federal':'DF',
  'espirito santo':'ES','goias':'GO','maranhao':'MA','mato grosso':'MT','mato grosso do sul':'MS','minas gerais':'MG',
  'para':'PA','paraiba':'PB','parana':'PR','pernambuco':'PE','piaui':'PI','rio de janeiro':'RJ','rio grande do norte':'RN',
  'rio grande do sul':'RS','rondonia':'RO','roraima':'RR','santa catarina':'SC','sao paulo':'SP','sergipe':'SE','tocantins':'TO'
};
function ufOf(value){const v=String(value||'').trim();return v.length===2?v.toUpperCase():stateCodes[norm(v)]||'';}
function parseCard(text,url){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const title=lines[0]||'';
  const contract=lines.find(x=>/^(CLT|Estágio|Temporário|Autônomo\s*-\s*PJ|Outro)$/i.test(x))||'';
  const loc=lines.slice(1,4).join(' ').replace(/\s+\//g,' /').trim();
  return {source:'Link Vagas',title,company:'',salary:'',location:loc,url,description:text,contractType:contract,
    remote:/remot|home office/i.test(text),pcd:/\bpcd\b|defici[eê]ncia/i.test(text),loginFreeCandidate:false};
}
async function blockNoise(page){
  await page.route('**/*',route=>{
    const r=route.request(),u=r.url(),t=r.resourceType();
    if(/doubleclick|googlesyndication|google-analytics|googletagmanager|facebook\.net/i.test(u)) return route.abort();
    if(['media','font','image','stylesheet'].includes(t)) return route.abort();
    return route.continue();
  });
}
function details(text,job){
  const salary=String(text).match(/R\$\s*[\d.]+(?:,\d{2})?/)?.[0]||job.salary||'';
  const lines=String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const reg=lines.findIndex(x=>/^Regime de Trabalho$/i.test(x));
  const contract=reg>=0?(lines[reg+1]||job.contractType):job.contractType;
  const loc=lines.find(x=>/\/[A-Z]{2}$/.test(x))||job.location||'';
  return {...job,salary,location:loc,contractType:contract,description:String(text||'').slice(0,26000),
    remote:/remot|home office/i.test(text),pcd:/\bpcd\b|defici[eê]ncia/i.test(text)};
}
async function enrich(browser,rows){
  let cursor=0;
  async function worker(){
    const page=await browser.newPage();await blockNoise(page);
    try{while(cursor<rows.length){const i=cursor++,job=rows[i];try{
      await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:18000});
      const text=await page.locator('body').innerText({timeout:5000});rows[i]=details(text,job);
    }catch{}}}finally{await page.close().catch(()=>{});}
  }
  await Promise.all(Array.from({length:Math.min(5,rows.length)},()=>worker()));return rows;
}
export async function searchLinkVagas(terms,filters,max=120){
  const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();await blockNoise(page);
  const out=[];
  try{
    const uf=filters.nationwide?'':ufOf(filters.state||filters.states?.[0]);
    const url=`https://linkvagas.com.br/vagas/index${uf?`?uf=${encodeURIComponent(uf)}`:''}`;
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:7000});
    await page.waitForTimeout(100);
    const cards=await page.locator('a[href*="/vagas/detalhes/"]').evaluateAll(as=>as.map(a=>({text:(a.innerText||'').trim(),url:a.href})).filter(x=>x.text));
    const wanted=terms.map(norm).filter(Boolean);
    for(const c of cards){
      const job=parseCard(c.text,c.url);const hay=norm(`${job.title} ${job.description}`);
      if(!wanted.length||wanted.some(t=>t.split(/\s+/).some(w=>w.length>2&&hay.includes(w)))) out.push(job);
    }
    return uniq(out).slice(0,max);
  }catch{return [];}
  finally{await browser.close().catch(()=>{});}
}

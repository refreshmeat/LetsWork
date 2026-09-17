import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const delay = ms => new Promise(r => setTimeout(r, ms));
const uniqByUrl = rows => [...new Map(rows.filter(x => x.url).map(x => [x.url, x])).values()];
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

const expansions = [
  [/social media|redes sociais/, ['social media','redes sociais','marketing digital','conteúdo digital','assistente de marketing','estágio marketing']],
  [/marketing/, ['marketing','marketing digital','assistente de marketing','analista de marketing','estágio marketing','conteúdo']],
  [/design|designer|ux|ui/, ['designer','design gráfico','ux ui','web designer','estágio design','designer júnior']],
  [/professor|professora|docente/, ['professor','professora','docente','instrutor','educador']],
  [/administrativ/, ['assistente administrativo','auxiliar administrativo','administrativo','recepção']],
  [/desenvolv|programa|dev/, ['desenvolvedor','programador','software','frontend','backend']]
];

function queryTerms(profile, filters) {
  const typed = String(filters.area || '').split(/[,;/]/).map(x => x.trim()).filter(Boolean);
  const base = typed.length ? typed : (profile.skills || []).filter(x => x.length > 2).slice(0,8);
  const out = new Set(base);
  const joined = norm(base.join(' '));
  for (const [rx, list] of expansions) if (rx.test(joined)) list.forEach(x => out.add(x));
  return [...out].slice(0,10);
}
function titleSalary(title) {
  const m = String(title || '').match(/R\$\s*[\d.]+(?:,\d{2})?(?:\s*(?:a|até)\s*R\$\s*[\d.]+(?:,\d{2})?)?/i);
  if (m) return m[0].replace(/\s+/g,' ').trim();
  if (/pretens[aã]o salarial/i.test(title || '')) return 'Pretensão salarial';
  return '';
}

function titleLocation(title) {
  const parts = String(title || '').split(/\s+[–—]\s+/).map(x => x.trim()).filter(Boolean);
  while (parts.length && /\d+\s*vagas?$/i.test(parts.at(-1))) parts.pop();
  if (parts.length >= 3) {
    const last = parts.at(-1);
    if (!/R\$|pretens[aã]o salarial/i.test(last)) return last;
  }
  return '';
}

function labeledValue(text, labels) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (let i=0;i<lines.length;i++) {
    const line = lines[i];
    for (const label of labels) {
      const rx = new RegExp(`^${label}\\s*:?\\s*(.*)$`,'i');
      const m = line.match(rx);
      if (m) return (m[1] || lines[i+1] || '').trim();
    }
  }
  return '';
}

function parseDetails(text, title) {
  const salary = labeledValue(text,['sal[aá]rio','remunera[cç][aã]o','bolsa(?: auxílio)?']) || titleSalary(title);
  const city = labeledValue(text,['cidade','munic[ií]pio']);
  const neighborhood = labeledValue(text,['bairro','local de trabalho','localiza[cç][aã]o','local']);
  const location = [neighborhood,city].filter(Boolean).join(' - ') || titleLocation(title);
  const contract = labeledValue(text,['regime de contrata[cç][aã]o','tipo de contrato','contrata[cç][aã]o']);
  return { salary, location, contractType:contract };
}
async function blockNoise(page) {
  await page.route('**/*', route => {
    const r = route.request();
    const u = r.url();
    const type = r.resourceType();
    if (/doubleclick|googlesyndication|google-analytics|googletagmanager|criteo|adnxs|smartadserver|amazon-adsystem/i.test(u)) return route.abort();
    if (['media','font'].includes(type)) return route.abort();
    return route.continue();
  });
}

async function wordpressSearch(base, source, terms, max) {
  const browser = await chromium.launch({ executablePath:CHROME, headless:true, args:['--no-sandbox'] });
  const page = await browser.newPage();
  await blockNoise(page);
  const out = [];
  try {
    for (const term of terms) {
      for (let n=1;n<=12 && out.length<max;n++) {
        const prefix = n===1 ? base : `${base.replace(/\/$/,'')}/page/${n}/`;
        const url = `${prefix}?s=${encodeURIComponent(term)}`;
        try { await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}); } catch { break; }
        const rows = await page.locator('article').evaluateAll(arts => arts.map(a => {
          const l = a.querySelector('h1 a,h2 a,h3 a,.entry-title a');
          const excerpt = a.querySelector('.entry-summary,.entry-content,.excerpt')?.textContent?.trim() || '';
          return l ? { title:l.textContent.trim(), url:l.href, excerpt } : null;
        }).filter(Boolean));
        if (!rows.length) break;
        for (const r of rows) out.push({
          ...r, source, description:r.excerpt || '', company:'',
          salary:titleSalary(r.title), location:titleLocation(r.title)
        });
        await delay(60);
      }
    }
  } finally { await browser.close(); }
  return uniqByUrl(out).slice(0,max);
}
async function enrichWordpressJobs(rows, maxWorkers=6) {
  if (!rows.length) return rows;
  const browser = await chromium.launch({ executablePath:CHROME, headless:true, args:['--no-sandbox'] });
  let cursor = 0;
  async function worker() {
    const page = await browser.newPage();
    await blockNoise(page);
    try {
      while (cursor < rows.length) {
        const idx = cursor++;
        const job = rows[idx];
        try {
          await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:28000});
          const text = await page.locator('article, main').first().innerText({timeout:5000}).catch(async()=>await page.locator('body').innerText());
          const parsed = parseDetails(text,job.title);
          rows[idx] = { ...job, description:String(text||'').slice(0,24000),
            salary:parsed.salary || job.salary, location:parsed.location || job.location,
            contractType:parsed.contractType || '' };
        } catch {}
      }
    } finally { await page.close(); }
  }
  try { await Promise.all(Array.from({length:Math.min(maxWorkers,rows.length)},()=>worker())); }
  finally { await browser.close(); }
  return rows;
}
async function searchJooble(terms, filters, max) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) return [];
  const out = [];
  for (const term of terms) {
    if (out.length >= max) break;
    const body = { keywords:term, location:[filters.city,filters.state].filter(Boolean).join(', '), page:1 };
    try {
      const res = await fetch(`https://br.jooble.org/api/${key}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) out.push({
        source:'Jooble', title:j.title||'', company:j.company||'', salary:j.salary||'',
        location:j.location||'', url:j.link||'', description:j.snippet||'', contractType:j.type||''
      });
    } catch {}
  }
  return uniqByUrl(out).slice(0,max);
}

async function searchRemotive(terms, max) {
  const out = [];
  for (const term of terms.slice(0,5)) {
    if (out.length >= max) break;
    try {
      const res = await fetch(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=${Math.min(100,max)}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const j of data.jobs || []) out.push({
        source:'Remotive', title:j.title||'', company:j.company_name||'', salary:j.salary||'',
        location:j.candidate_required_location||'Remoto', url:j.url||'', description:j.description||'',
        contractType:j.job_type||'', remote:true
      });
    } catch {}
  }
  return uniqByUrl(out).slice(0,max);
}
function interleave(...lists) {
  const out = [];
  const maxLen = Math.max(0,...lists.map(x=>x.length));
  for (let i=0;i<maxLen;i++) {
    for (const list of lists) if (list[i]) out.push(list[i]);
  }
  return out;
}

export async function searchJobs(profile, filters) {
  const max = Math.min(500,Math.max(100,Number(filters.limit||500)));
  const terms = queryTerms(profile,filters);
  if (!terms.length) throw new Error('Não foi possível inferir uma área; use o filtro opcional de área.');
  const perSource = Math.min(max,Math.max(100,Math.ceil(max*0.65)));
  const wantsRemote = (filters.workMode || 'include_remote') !== 'onsite_only';
  const [rio,empregos,jooble,remotive] = await Promise.all([
    wordpressSearch('https://riovagas.com.br/','RioVagas',terms,perSource),
    wordpressSearch('https://empregosrj.com.br/','EmpregosRJ',terms,perSource),
    searchJooble(terms,filters,perSource),
    wantsRemote ? searchRemotive(terms,Math.min(150,perSource)) : Promise.resolve([])
  ]);
  const wordpress = interleave(rio,empregos).slice(0,max);
  await enrichWordpressJobs(wordpress,6);
  return uniqByUrl(interleave(jooble,wordpress,remotive)).slice(0,max);
}

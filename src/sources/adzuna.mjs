const uniq = rows => [...new Map(rows.filter(x=>x.url).map(x=>[x.url,x])).values()];

function salaryText(j) {
  const fmt=n=>Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
  if (j.salary_min && j.salary_max) return `${fmt(j.salary_min)} - ${fmt(j.salary_max)}`;
  if (j.salary_min) return `A partir de ${fmt(j.salary_min)}`;
  if (j.salary_max) return `Até ${fmt(j.salary_max)}`;
  return '';
}

export async function searchAdzuna(terms,filters,max=150) {
  const appId=process.env.ADZUNA_APP_ID, key=process.env.ADZUNA_APP_KEY;
  if (!appId || !key) return [];
  const out=[];
  const where=filters.nationwide?'Brasil':[filters.city,filters.state].filter(Boolean).join(', ');
  const deadline=Date.now()+60000;
  for (const term of [...new Set(terms)].slice(0,60)) {
    if (out.length>=max || Date.now()>=deadline) break;
    for (let page=1;page<=10 && out.length<max && Date.now()<deadline;page++) {
      const qs=new URLSearchParams({app_id:appId,app_key:key,results_per_page:'50',what:term,where,'content-type':'application/json'});
      try {
        const r=await fetch(`https://api.adzuna.com/v1/api/jobs/br/search/${page}?${qs}`,{signal:AbortSignal.timeout(7000)});
        if (!r.ok) break;
        const data=await r.json(); if (!data.results?.length) break;
        for (const j of data.results) out.push({source:'Adzuna',title:j.title||'',company:j.company?.display_name||'',
          salary:salaryText(j),location:j.location?.display_name||'',url:j.redirect_url||'',description:j.description||'',
          contractType:j.contract_type||'',remote:/remot|home office/i.test(`${j.title} ${j.description}`),publishedAt:j.created||''});
      } catch { break; }
    }
  }
  return uniq(out).slice(0,max);
}
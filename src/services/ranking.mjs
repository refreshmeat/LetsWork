const stop = new Set('de da do das dos e em para com por a o as os um uma vaga vagas trabalho emprego'.split(' '));
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const stem = x => x.length > 5 ? x.replace(/(?:as|os|es|a|o|s)$/,'') : x;
const words = s => new Set(norm(s).split(/[^a-z0-9+#.]+/).map(stem).filter(x => x.length > 2 && !stop.has(x)));

function inferFlags(job) {
  const text = norm(`${job.title} ${job.description} ${job.location} ${job.contractType}`);
  return {
    pcd:/\bpcd\b|pessoa com deficiencia|exclusiv.{0,8}pcd/.test(text),
    remote:Boolean(job.remote) || /home office|remoto|remote/.test(text),
    hybrid:/hibrid/.test(text),
    clt:/\bclt\b|carteira assinada|efetivo/.test(text),
    pj:/\bpj\b|pessoa juridica|mei/.test(text)
  };
}

function workModeOk(flags, mode) {
  if (mode === 'remote_only') return flags.remote;
  if (mode === 'onsite_only') return !flags.remote || flags.hybrid;
  return true;
}

function remoteRegionOk(job, filters) {
  const loc = norm(job.location);
  if (!loc) return true;
  if (/worldwide|anywhere|global|latin america|south america|brasil|brazil/.test(loc)) return true;
  const chosen = [...(filters.states||[]),...(filters.cities||[])].map(norm).filter(Boolean);
  if (chosen.some(x => loc.includes(x))) return true;
  return !/only|apenas|eua|usa|united states|canada|europe|europa|uk|united kingdom/.test(loc);
}
function locationOk(job, filters, flags) {
  if (flags.remote && filters.workMode !== 'onsite_only') return remoteRegionOk(job,filters);
  const text = norm(`${job.location} ${job.title} ${job.description}`);
  const cities = Array.isArray(filters.cities) ? filters.cities.filter(Boolean) : [filters.city].filter(Boolean);
  const states = Array.isArray(filters.states) ? filters.states.filter(Boolean) : [filters.state].filter(Boolean);
  if (cities.length) return cities.some(x => text.includes(norm(x)));
  if (states.length) {
    if (states.some(x => text.includes(norm(x)))) return true;
    const localRjSource = /^(RioVagas|EmpregosRJ)$/.test(job.source || '');
    const wantsRj = states.some(x => /^(rj|rio de janeiro)$/i.test(x));
    if (localRjSource && wantsRj) return true;
    return false;
  }
  return true;
}
function pcdOk(flags, mode) {
  if (mode === 'only') return flags.pcd;
  if (mode === 'include') return true;
  return !flags.pcd;
}

function contractOk(flags, filters) {
  const wanted = new Set(filters.contractTypes || []);
  if (!wanted.size) return true;
  if (!flags.clt && !flags.pj) return true;
  return (wanted.has('CLT') && flags.clt) || (wanted.has('PJ') && flags.pj);
}

function areaCompatibility(job, areaWords) {
  if (!areaWords.size) return {ok:true,boost:0};
  const jw = words(`${job.title} ${job.description} ${job.company}`);
  const overlap = [...areaWords].filter(x => jw.has(x)).length;
  return {ok:overlap > 0,boost:Math.min(0.4,(overlap/areaWords.size)*0.4)};
}
export function rankJobs(jobs, profile, filters) {
  const profileText = `${profile.rawText || ''} ${(profile.skills || []).join(' ')}`;
  const pWords = words(profileText);
  const areaWords = words(filters.area || '');
  const minScore = Number(filters.minScore ?? 0.13);
  return jobs.map(job => {
    const flags = inferFlags(job);
    const jw = words(`${job.title} ${job.description} ${job.company}`);
    const overlap = [...jw].filter(x => pWords.has(x)).length;
    const base = overlap / Math.max(7,Math.min(jw.size,pWords.size || 7));
    const area = areaCompatibility(job,areaWords);
    const score = Math.min(1,base + area.boost);
    return {...job,...flags,areaMatch:area.ok,score};
  }).filter(job => job.areaMatch)
    .filter(job => pcdOk(job,filters.pcdMode || 'exclude'))
    .filter(job => workModeOk(job,filters.workMode || 'include_remote'))
    .filter(job => locationOk(job,filters,job))
    .filter(job => contractOk(job,filters))
    .filter(job => job.score >= minScore)
    .sort((a,b)=>b.score-a.score)
    .slice(0,Math.min(500,Math.max(100,Number(filters.limit||500))));
}

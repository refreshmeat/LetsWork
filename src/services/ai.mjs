const OLLAMA_URL=process.env.OLLAMA_URL || 'http://127.0.0.1:11435';
const OLLAMA_MODEL=process.env.OLLAMA_MODEL || 'letswork-ai';

async function tryOllama(system,prompt){
  try{
    const res=await fetch(`${OLLAMA_URL.replace(/\/$/,'')}/api/chat`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({
        model:OLLAMA_MODEL,stream:false,think:false,keep_alive:'15m',
        options:{temperature:0.15,num_predict:512},
        messages:[{role:'system',content:system},{role:'user',content:prompt}]
      })
    });
    if(!res.ok) return null;
    return (await res.json()).message?.content||'';
  }catch{return null;}
}

async function tryOpenAI(system,prompt){
  if(!process.env.OPENAI_API_KEY) return null;
  try{
    const res=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6',temperature:0.2,
        messages:[{role:'system',content:system},{role:'user',content:prompt}]})
    });    if(!res.ok) return null;
    return (await res.json()).choices?.[0]?.message?.content||'';
  }catch{return null;}
}

export async function askAI(system,prompt){
  const local=await tryOllama(system,prompt);
  if(local) return local;
  const cloud=await tryOpenAI(system,prompt);
  return cloud||'';
}

export async function aiStatus(){
  try{
    const r=await fetch(`${OLLAMA_URL.replace(/\/$/,'')}/api/tags`);
    const data=await r.json();
    const models=(data.models||[]).map(x=>x.name);
    return {engine:'ollama',online:r.ok,model:OLLAMA_MODEL,installed:models.some(x=>x===OLLAMA_MODEL||x.startsWith(`${OLLAMA_MODEL}:`))};
  }catch{return {engine:'ollama',online:false,model:OLLAMA_MODEL,installed:false};}
}

export function parseJsonLoose(text){
  const m=String(text||'').match(/\{[\s\S]*\}/);
  if(!m) return null;
  try{return JSON.parse(m[0]);}catch{return null;}
}

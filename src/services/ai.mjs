const OLLAMA_URL=String(process.env.OLLAMA_URL||'http://127.0.0.1:11434').replace(/\/$/,'');
const OLLAMA_MODEL=String(process.env.OLLAMA_MODEL||'llama3.2:3b').trim();
const OLLAMA_NUM_CTX=Math.max(2048,Number(process.env.OLLAMA_NUM_CTX||8192));
const OLLAMA_TIMEOUT_MS=Math.max(10000,Number(process.env.OLLAMA_TIMEOUT_MS||45000));
let ollamaQueue=Promise.resolve();

async function ollamaTags(){
  const r=await fetch(`${OLLAMA_URL}/api/tags`,{signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error(`Ollama respondeu HTTP ${r.status}`);
  return r.json();
}

async function askOllama(system,prompt,options={}){
  const timeout=Math.max(10000,Number(options.timeoutMs||OLLAMA_TIMEOUT_MS));
  const body={
    model:OLLAMA_MODEL,
    stream:false,
    keep_alive:'15m',
    messages:[
      {role:'system',content:String(system||'')},
      {role:'user',content:String(prompt||'')}
    ],
    options:{
      temperature:Number(options.temperature??0.1),
      num_ctx:Math.max(2048,Number(options.numCtx||OLLAMA_NUM_CTX)),
      ...(options.numPredict?{num_predict:Math.max(64,Number(options.numPredict))}:{})
    }
  };
  const r=await fetch(`${OLLAMA_URL}/api/chat`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    signal:AbortSignal.timeout(timeout),
    body:JSON.stringify(body)
  });
  if(!r.ok){
    const text=await r.text().catch(()=>'');
    throw new Error(`Ollama falhou (HTTP ${r.status}): ${text.slice(0,240)}`);
  }
  const data=await r.json();
  const answer=String(data?.message?.content||'').trim();
  if(!answer)throw new Error('Ollama retornou resposta vazia');
  return answer;
}

export async function askAI(system,prompt,options={}){
  const task=ollamaQueue.then(()=>askOllama(system,prompt,options));
  ollamaQueue=task.catch(()=>{});
  return task;
}

export async function aiStatus(){
  try{
    const data=await ollamaTags();
    const models=Array.isArray(data?.models)?data.models.map(x=>String(x?.name||x?.model||'')): [];
    const modelReady=models.some(x=>x===OLLAMA_MODEL||x.startsWith(OLLAMA_MODEL+'-'));
    return {engine:'ollama',provider:'ollama',online:true,model:OLLAMA_MODEL,modelReady,models,level:'local'};
  }catch(e){
    return {engine:'ollama',provider:'ollama',online:false,model:OLLAMA_MODEL,modelReady:false,models:[],level:'local',error:String(e?.message||e)};
  }
}

export function parseJsonLoose(text){
  const raw=String(text||'').trim();
  if(!raw)return null;
  try{return JSON.parse(raw);}catch{}
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if(fenced){try{return JSON.parse(fenced);}catch{}}
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start)return null;
  try{return JSON.parse(raw.slice(start,end+1));}catch{return null;}
}

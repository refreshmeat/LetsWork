import fs from 'fs';
import path from 'path';
import os from 'os';

const CHATGPT_CDP_URL=process.env.CHATGPT_CDP_URL || 'http://127.0.0.1:9223';
const CHATGPT_MODEL=process.env.CHATGPT_WEB_MODEL || 'GPT-5.6 Sol';
const CHATGPT_LEVEL=process.env.CHATGPT_WEB_LEVEL || 'high';
const MIN_GAP_MS=Math.max(500,Number(process.env.CHATGPT_MIN_GAP_MS||1500));
const RATE_BACKOFF_MS=Math.max(30000,Number(process.env.CHATGPT_RATE_LIMIT_BACKOFF_MS||60000));
const REQUEST_TIMEOUT_MS=Math.max(60000,Number(process.env.CHATGPT_WEB_TIMEOUT_MS||330000));
const DATA_ROOT=process.env.LETSWORK_DATA_ROOT || path.join(os.homedir(),'LetsWork','dados');
const CONVERSATION_FILE=path.join(DATA_ROOT,'chatgpt-conversations.json');

let queue=Promise.resolve();
let lastStartedAt=0;
let conversations=loadConversations();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadConversations(){
  try{return JSON.parse(fs.readFileSync(CONVERSATION_FILE,'utf8'))||{};}catch{return {};}
}
function saveConversations(){
  fs.mkdirSync(DATA_ROOT,{recursive:true});
  const tmp=CONVERSATION_FILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(conversations,null,2),'utf8');
  fs.renameSync(tmp,CONVERSATION_FILE);
}
function candidateKey(candidateId){
  return candidateId==null||candidateId===''?'global':String(candidateId);
}
function cleanConversationUrl(value){
  try{
    const u=new URL(value);
    if(u.hostname!=='chatgpt.com'||!/^\/c\//.test(u.pathname)||/^\/c\/WEB(?::|%3A)/i.test(u.pathname))return '';
    return `https://chatgpt.com${u.pathname}`;
  }catch{return '';}
}
function rateLimitError(){
  const e=new Error('CHATGPT_RATE_LIMITED');
  e.code='CHATGPT_RATE_LIMITED';
  return e;
}

async function targetList(){
  const r=await fetch(`${CHATGPT_CDP_URL}/json/list`,{signal:AbortSignal.timeout(5000)});
  if(!r.ok) throw new Error(`CDP respondeu HTTP ${r.status}`);
  return r.json();
}
async function chatTarget(){
  const targets=await targetList();
  const target=targets.find(x=>x.type==='page'&&String(x.url||'').includes('chatgpt.com'));
  if(!target?.webSocketDebuggerUrl) throw new Error('Aba persistente do ChatGPT não encontrada');
  return target;
}
function cdpSession(wsUrl){
  const ws=new WebSocket(wsUrl);
  let seq=0,closed=false;
  const pending=new Map();
  ws.onmessage=e=>{
    let msg;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.id&&pending.has(msg.id)){
      const {resolve,timer}=pending.get(msg.id);
      clearTimeout(timer);pending.delete(msg.id);resolve(msg);
    }
  };
  const opened=new Promise((resolve,reject)=>{
    ws.onopen=resolve;
    ws.onerror=()=>reject(new Error('Falha ao conectar ao CDP do ChatGPT'));
  });
  const send=async(method,params={})=>{
    await opened;
    if(closed)throw new Error('Sessão CDP encerrada');
    return new Promise((resolve,reject)=>{
      const id=++seq;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout CDP em ${method}`));},8000);
      pending.set(id,{resolve,reject,timer});
      ws.send(JSON.stringify({id,method,params}));
    });
  };
  const close=()=>{closed=true;try{ws.close();}catch{}};
  return {opened,send,close};
}
async function evalValue(cdp,expression){
  const msg=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(msg.error)throw new Error(msg.error.message||'Erro CDP');
  if(msg.result?.exceptionDetails)throw new Error(msg.result.exceptionDetails.text||'Erro ao avaliar página ChatGPT');
  return msg.result?.result?.value;
}
async function forcePageActive(cdp){
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>{});
  await cdp.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});
}
function pageStateExpr(){
  return `(()=>({
    title:document.title,
    url:location.href,
    loggedIn:!!document.querySelector('[data-testid="accounts-profile-button"]'),
    rateLimited:!!document.querySelector('[data-testid="modal-conversation-history-rate-limit"]') ||
      /Excesso de solicitações[\\s\\S]*solicitações rápido demais/i.test(document.body.innerText||''),
    composer:!!document.querySelector('#prompt-textarea'),
    send:!!document.querySelector('[data-testid="send-button"]')
  }))()`;
}
async function pageState(cdp){return evalValue(cdp,pageStateExpr());}
async function dismissRateLimitModal(cdp){
  return evalValue(cdp,`(()=>{const m=document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');if(!m)return false;const b=[...m.querySelectorAll('button')].find(x=>/Entendido|OK/i.test(x.innerText||''))||m.querySelector('button');if(!b)return false;b.click();return true;})()`);
}
async function waitPageReady(cdp,timeout=45000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const state=await pageState(cdp).catch(()=>null);
    if(state?.rateLimited){await dismissRateLimitModal(cdp).catch(()=>false);await sleep(250);continue;}
    if(state?.loggedIn&&state?.composer)return state;
    await sleep(500);
  }
  throw new Error('ChatGPT não ficou pronto para receber mensagens');
}
async function navigate(cdp,url){
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate',{url});
  await sleep(700);
  await forcePageActive(cdp);
  return waitPageReady(cdp);
}
async function ensureCandidateConversation(cdp,candidateId){
  const key=candidateKey(candidateId);
  const mapped=cleanConversationUrl(conversations[key]?.url||'');
  let state=await pageState(cdp);
  if(mapped){
    if(cleanConversationUrl(state?.url)!==mapped)state=await navigate(cdp,mapped);
    else state=await waitPageReady(cdp);
    return {key,state};
  }
  if(cleanConversationUrl(state?.url)||!String(state?.url||'').startsWith('https://chatgpt.com')){
    state=await navigate(cdp,'https://chatgpt.com/');
  }else{
    state=await waitPageReady(cdp);
  }
  return {key,state};
}
async function rememberCandidateConversation(cdp,key){
  for(let i=0;i<12;i++){
    const state=await pageState(cdp).catch(()=>null);
    const url=cleanConversationUrl(state?.url);
    if(url){
      if(conversations[key]?.url!==url){
        conversations={...conversations,[key]:{url,updatedAt:new Date().toISOString()}};
        saveConversations();
      }
      return url;
    }
    await sleep(400);
  }
  return '';
}
async function setComposer(cdp,text){
  const payload=JSON.stringify(String(text||''));
  const inserted=await evalValue(cdp,`(()=>{const e=document.querySelector('#prompt-textarea');if(!e)return false;e.focus();const text=${payload};if('value' in e){const proto=Object.getPrototypeOf(e);const desc=Object.getOwnPropertyDescriptor(proto,'value');if(desc?.set)desc.set.call(e,text);else e.value=text;e.dispatchEvent(new Event('input',{bubbles:true}));}else{e.textContent='';const sel=getSelection();const r=document.createRange();r.selectNodeContents(e);r.collapse(true);sel.removeAllRanges();sel.addRange(r);if(!document.execCommand('insertText',false,text)){e.textContent=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}}return (e.innerText||e.textContent||e.value||'').trim().length>0;})()`);
  if(!inserted)throw new Error('Não foi possível preencher o composer do ChatGPT');
}
async function clickSend(cdp){
  const ok=await evalValue(cdp,`(()=>{const b=document.querySelector('[data-testid="send-button"]');if(!b||b.disabled)return false;b.click();return true;})()`);
  if(!ok)throw new Error('Botão de envio do ChatGPT indisponível');
}
async function messageSnapshot(cdp){
  return evalValue(cdp,`(()=>{const clean=e=>(e?.innerText||'').trim();const turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')].map(e=>{const testid=e.getAttribute('data-testid')||'';const n=Number((testid.match(/conversation-turn-(\\d+)/)||[])[1]||-1);const author=e.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role')||e.getAttribute('data-message-author-role')||'';return {turn:n,testid,author,text:clean(e)};}).filter(x=>x.text);const direct=[...document.querySelectorAll('[data-message-author-role="assistant"]')].map(e=>clean(e)).filter(Boolean);return {turns,direct,lastTurn:Math.max(-1,...turns.map(x=>x.turn))};})()`);
}
function extractAssistant(snapshot,before){
  const beforeTurn=Number(before?.lastTurn??-1);
  const fresh=(snapshot?.turns||[]).filter(t=>t.author==='assistant'&&t.turn>beforeTurn&&t.text).sort((a,b)=>a.turn-b.turn);
  if(fresh.length)return fresh.at(-1).text;
  const direct=snapshot?.direct||[];
  const beforeDirect=before?.direct?.length||0;
  if(direct.length>beforeDirect)return direct.at(-1);
  return '';
}
async function waitAssistant(cdp,before){
  const deadline=Date.now()+REQUEST_TIMEOUT_MS;
  let last='',lastChangedAt=Date.now();
  while(Date.now()<deadline){
    await sleep(450);
    const snapshot=await messageSnapshot(cdp);
    const answer=extractAssistant(snapshot,before).trim();
    if(answer){
      if(answer!==last){last=answer;lastChangedAt=Date.now();}
      const generating=await evalValue(cdp,`(()=>{const b=document.querySelector('[data-testid="stop-button"],button[aria-label*="Interromper"],button[aria-label*="Stop"]');return !!(b&&b.offsetParent!==null);})()`).catch(()=>false);
      const quietFor=Date.now()-lastChangedAt;
      if(!generating&&quietFor>=1800){
        await dismissRateLimitModal(cdp).catch(()=>false);
        return answer;
      }
    }
    const state=await pageState(cdp);
    if(state?.rateLimited&&!answer){await dismissRateLimitModal(cdp).catch(()=>false);await sleep(600);}
  }
  throw new Error('Timeout aguardando resposta do ChatGPT');
}
async function runPrompt(system,prompt,{candidateId=null,clearRateModal=false}={}){
  const elapsed=Date.now()-lastStartedAt;
  if(elapsed<MIN_GAP_MS)await sleep(MIN_GAP_MS-elapsed);
  lastStartedAt=Date.now();

  const target=await chatTarget();
  const cdp=cdpSession(target.webSocketDebuggerUrl);
  try{
    await cdp.opened;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await forcePageActive(cdp);
    if(clearRateModal)await dismissRateLimitModal(cdp).catch(()=>false);
    let state=await pageState(cdp);
    if(!state?.loggedIn)throw new Error('Sessão do ChatGPT não está logada');
    if(state?.rateLimited){await dismissRateLimitModal(cdp).catch(()=>false);await sleep(250);state=await pageState(cdp);}

    const {key}=await ensureCandidateConversation(cdp,candidateId);
    const before=await messageSnapshot(cdp);
    const full=`SYSTEM:\n${system}\n\nUSER:\n${prompt}`;
    await setComposer(cdp,full);
    await clickSend(cdp);
    await rememberCandidateConversation(cdp,key);
    return await waitAssistant(cdp,before);
  }finally{cdp.close();}
}
async function runWithBackoff(system,prompt,options){
  let backoff=RATE_BACKOFF_MS;
  for(let attempt=0;attempt<4;attempt++){
    try{return await runPrompt(system,prompt,{...options,clearRateModal:attempt>0});}
    catch(e){
      const message=String(e?.message||e);
      if(e?.code==='CHATGPT_RATE_LIMITED'){
        if(attempt===3)throw new Error('ChatGPT temporariamente limitado por excesso de solicitações');
        await sleep(backoff);backoff=Math.min(backoff*2,240000);continue;
      }
      const transient=/Timeout CDP|Falha ao conectar ao CDP|Sess[aã]o CDP encerrada|ChatGPT n[aã]o ficou pronto|Aba persistente do ChatGPT n[aã]o encontrada/i.test(message);
      if(!transient||attempt>=2)throw e;
      await sleep(700*(attempt+1));
    }
  }
}
export async function askAI(system,prompt,options={}){
  const job=queue.then(()=>runWithBackoff(system,prompt,options));
  queue=job.catch(()=>{});
  return job;
}
export async function aiStatus(){
  try{
    const target=await chatTarget();
    const cdp=cdpSession(target.webSocketDebuggerUrl);
    try{
      await cdp.opened;
      await cdp.send('Runtime.enable');
      await forcePageActive(cdp);
      const state=await pageState(cdp);
      return {engine:'chatgpt-web-cdp',online:!!state?.loggedIn,model:CHATGPT_MODEL,level:CHATGPT_LEVEL,loggedIn:!!state?.loggedIn,rateLimited:!!state?.rateLimited};
    }finally{cdp.close();}
  }catch{
    return {engine:'chatgpt-web-cdp',online:false,model:CHATGPT_MODEL,level:CHATGPT_LEVEL,loggedIn:false,rateLimited:false};
  }
}

export function parseJsonLoose(text){
  const m=String(text||'').match(/\{[\s\S]*\}/);
  if(!m)return null;
  try{return JSON.parse(m[0]);}catch{return null;}
}

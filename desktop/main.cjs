const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.PORT || 4317);
const AI_PORT = 11435;
let mainWindow = null;
let logFile = null;
let ollamaProcess = null;
let ollamaOwned = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function log(msg){
  try{
    const line='['+new Date().toISOString()+'] '+String(msg)+'\n';
    if(logFile) fs.appendFileSync(logFile,line);
    console.log(line.trim());
  }catch{}
}

async function waitUrl(url,tries=80){
  for(let i=0;i<tries;i++){
    try{const r=await fetch(url);if(r.ok)return true;}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  return false;
}
function getOllamaExe(){
  const candidates=[
    process.env.OLLAMA_EXE,
    process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','Ollama','ollama.exe')
  ].filter(Boolean);
  return candidates.find(p=>fs.existsSync(p))||null;
}

async function ensureLocalAI(){
  process.env.OLLAMA_URL=`http://127.0.0.1:${AI_PORT}`;
  if(await waitUrl(`${process.env.OLLAMA_URL}/api/tags`,3)){
    log('Ollama CPU já disponível'); return true;
  }
  const exe=getOllamaExe();
  if(!exe){log('Ollama não encontrado; IA local ficará indisponível');return false;}
  const env={...process.env,
    OLLAMA_HOST:`127.0.0.1:${AI_PORT}`,
    OLLAMA_LLM_LIBRARY:'cpu_avx2',
    CUDA_VISIBLE_DEVICES:'-1',
    OLLAMA_NO_CLOUD:'true',
    OLLAMA_KEEP_ALIVE:'15m'};
  ollamaProcess=spawn(exe,['serve'],{env,windowsHide:true,stdio:'ignore'});
  ollamaOwned=true;
  const ok=await waitUrl(`${process.env.OLLAMA_URL}/api/tags`,80);
  log(ok?'Ollama CPU iniciado':'Ollama CPU não respondeu');
  return ok;
}
async function waitForServer(){
  const ok=await waitUrl(`http://127.0.0.1:${PORT}/api/ai/status`,100);
  if(!ok) throw new Error('O servidor local do LetsWork não iniciou.');
}

async function createWindow(){
  const dataRoot=path.join(app.getPath('documents'),'LetsWork');
  fs.mkdirSync(dataRoot,{recursive:true});
  logFile=path.join(dataRoot,'desktop.log');
  process.env.LETSWORK_DATA_ROOT=dataRoot;
  process.env.PORT=String(PORT);
  log('iniciando LetsWork em '+__dirname);

  await ensureLocalAI();
  const serverPath=path.join(__dirname,'..','src','server.mjs');
  await import(pathToFileURL(serverPath).href);
  await waitForServer();

  mainWindow=new BrowserWindow({
    width:1320,height:860,minWidth:1040,minHeight:680,
    title:'LetsWork',show:true,autoHideMenuBar:true,backgroundColor:'#f6f7f9',icon:path.join(__dirname,'..','build','icon.ico'),
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}
  });

  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({url})=>{
    shell.openExternal(url);return {action:'deny'};
  });
  mainWindow.once('ready-to-show',()=>{
    mainWindow.show(); mainWindow.focus(); log('Janela exibida');
  });
  await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  const layout=await mainWindow.webContents.executeJavaScript(`(()=>{const w=s=>document.querySelector(s)?.getBoundingClientRect().width||0;const overflow=[...document.querySelectorAll('*')].map(e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,cls:e.className||'',id:e.id||'',left:r.left,right:r.right,width:r.width}}).filter(x=>x.right>innerWidth+1||x.left<-1).sort((a,b)=>b.right-a.right).slice(0,8);return{innerWidth,scrollWidth:document.documentElement.scrollWidth,shell:w('.app-shell'),sidebar:w('.sidebar'),content:w('.content'),topbar:w('.topbar'),tabs:w('.tabs'),panel:w('.tab-panel'),overflow}})()`).catch(()=>null);
  if(layout) log('Layout '+JSON.stringify(layout));
  if(!mainWindow.isVisible()){mainWindow.show(); mainWindow.focus(); log('Janela exibida por fallback');}
  mainWindow.on('closed',()=>{mainWindow=null;});
}
if(!hasSingleInstanceLock){
  app.quit();
}else{
  app.on('second-instance',()=>{
    if(mainWindow){if(mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus();}
  });
  app.whenReady().then(createWindow).catch(err=>{
    log('ERRO: '+(err?.stack||err));
    app.quit();
  });
}

app.on('activate',()=>{
  if(BrowserWindow.getAllWindows().length===0) createWindow();
});

app.on('before-quit',()=>{
  if(ollamaOwned&&ollamaProcess){
    try{spawnSync('taskkill',['/PID',String(ollamaProcess.pid),'/T','/F'],{windowsHide:true});}catch{}
    ollamaProcess=null;
  }
});

app.on('window-all-closed',()=>{
  if(process.platform!=='darwin') app.quit();
});


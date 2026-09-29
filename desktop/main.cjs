const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { applyPendingRestore } = require('./restore.cjs');

const PORT=Number(process.env.PORT||4317);
let mainWindow=null;
let logFile=null;
const hasSingleInstanceLock=app.requestSingleInstanceLock();

function log(msg){
  try{
    const line='['+new Date().toISOString()+'] '+String(msg)+'\n';
    if(logFile)fs.appendFileSync(logFile,line);
    console.log(line.trim());
  }catch{}
}
process.on('uncaughtException',err=>log('UNCAUGHT_EXCEPTION: '+String(err?.stack||err)));
process.on('unhandledRejection',reason=>log('UNHANDLED_REJECTION: '+String(reason?.stack||reason)));

async function waitUrl(url,tries=80){
  for(let i=0;i<tries;i++){
    try{const r=await fetch(url);if(r.ok)return true;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return false;
}

function getOllamaExe(){
  const candidates=[
    process.env.OLLAMA_EXE,
    process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Programs','Ollama','ollama.exe'):'',
    process.env.PROGRAMFILES?path.join(process.env.PROGRAMFILES,'Ollama','ollama.exe'):''
  ].filter(Boolean);
  for(const file of candidates)if(fs.existsSync(file))return file;
  try{
    const r=spawnSync('where.exe',['ollama'],{windowsHide:true,encoding:'utf8'});
    const file=String(r.stdout||'').split(/\r?\n/).map(x=>x.trim()).find(Boolean);
    if(file&&fs.existsSync(file))return file;
  }catch{}
  return '';
}

function detectedGpuVramBytes(){
  try{
    const r=spawnSync('nvidia-smi',['--query-gpu=memory.total','--format=csv,noheader,nounits'],{windowsHide:true,encoding:'utf8'});
    const mb=String(r.stdout||'').split(/\r?\n/).map(x=>Number(x.trim())).filter(Number.isFinite);
    if(mb.length)return Math.max(...mb)*1024*1024;
  }catch{}
  try{
    const cmd='(Get-CimInstance Win32_VideoController | Measure-Object -Property AdapterRAM -Maximum).Maximum';
    const r=spawnSync('powershell.exe',['-NoProfile','-Command',cmd],{windowsHide:true,encoding:'utf8'});
    const bytes=Number(String(r.stdout||'').trim());
    return Number.isFinite(bytes)?bytes:0;
  }catch{return 0;}
}

async function ollamaModelReady(model){
  try{
    const r=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(4000)});
    if(!r.ok)return false;
    const data=await r.json();
    return (data.models||[]).some(x=>{
      const n=String(x.name||x.model||'');
      return n===model||n.startsWith(model+'-');
    });
  }catch{return false;}
}

async function ensureOllama(){
  process.env.LETSWORK_AI_PROVIDER='ollama';
  process.env.OLLAMA_URL=process.env.OLLAMA_URL||'http://127.0.0.1:11434';
  if(!process.env.OLLAMA_MODEL){
    const gpuVram=detectedGpuVramBytes();
    process.env.OLLAMA_MODEL=(os.totalmem()>=16*1024**3&&gpuVram>=6*1024**3)?'llama3.1:8b':'llama3.2:3b';
  }
  const model=process.env.OLLAMA_MODEL;
  let online=await waitUrl(process.env.OLLAMA_URL+'/api/tags',3);
  const exe=getOllamaExe();
  if(!online&&exe){
    try{spawn(exe,['serve'],{windowsHide:true,detached:true,stdio:'ignore'}).unref();}
    catch(e){log('Falha ao iniciar Ollama: '+String(e?.message||e));}
    online=await waitUrl(process.env.OLLAMA_URL+'/api/tags',60);
  }
  if(!online){
    log('Ollama indisponível. Instale o Ollama para usar a IA local.');
    return false;
  }
  if(!(await ollamaModelReady(model))){
    if(exe){
      log('Baixando modelo local '+model+' em segundo plano');
      try{spawn(exe,['pull',model],{windowsHide:true,detached:true,stdio:'ignore'}).unref();}
      catch(e){log('Falha ao baixar modelo '+model+': '+String(e?.message||e));}
    }else{
      log('Ollama online, mas o executável não foi localizado para baixar '+model);
    }
  }else{
    log('IA local pronta: '+model);
  }
  return true;
}

async function ensureServer(){
  const statusUrl=`http://127.0.0.1:${PORT}/api/ai/status`;
  if(await waitUrl(statusUrl,4)){
    log('Servidor local já disponível');
    return true;
  }
  const serverPath=path.join(__dirname,'..','src','server.mjs');
  await import(pathToFileURL(serverPath).href);
  const ok=await waitUrl(statusUrl,120);
  if(!ok)throw new Error('O servidor local do LetsWork não iniciou.');
  log('Servidor local iniciado no processo principal');
  return true;
}

function stopExternalServerProcesses(){
  try{
    const ps="$needle='LetsWork\\app\\src\\server.mjs'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*'+$needle+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',ps],{windowsHide:true,stdio:'ignore'});
  }catch{}
}

async function createWindow(){
  const dataRoot=path.join(app.getPath('home'),'LetsWork','dados');
  fs.mkdirSync(dataRoot,{recursive:true});
  logFile=path.join(dataRoot,'desktop.log');
  process.env.LETSWORK_DATA_ROOT=dataRoot;
  process.env.PORT=String(PORT);
  log('iniciando LetsWork em '+__dirname);
  applyPendingRestore(dataRoot,{log,beforeApply:stopExternalServerProcesses});

  await ensureOllama();
  await ensureServer();

  mainWindow=new BrowserWindow({
    width:1320,height:860,minWidth:1040,minHeight:680,
    title:'LetsWork',show:true,autoHideMenuBar:true,backgroundColor:'#f6f7f9',
    icon:path.join(__dirname,'..','build','icon.ico'),
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({url})=>{
    shell.openExternal(url);
    return {action:'deny'};
  });
  mainWindow.once('ready-to-show',()=>{
    mainWindow.show();
    mainWindow.focus();
    log('Janela exibida');
  });
  await mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  if(!mainWindow.isVisible()){
    mainWindow.show();
    mainWindow.focus();
    log('Janela exibida por fallback');
  }
  mainWindow.on('close',()=>log('Janela principal recebeu evento close'));
  mainWindow.webContents.on('render-process-gone',(event,details)=>log('RENDER_PROCESS_GONE '+JSON.stringify(details||{})));
  mainWindow.webContents.on('unresponsive',()=>log('RENDERER_UNRESPONSIVE'));
  mainWindow.webContents.on('responsive',()=>log('RENDERER_RESPONSIVE'));
  mainWindow.on('closed',()=>{log('Janela principal fechada');mainWindow=null;});
}

if(!hasSingleInstanceLock){
  app.quit();
}else{
  app.on('second-instance',()=>{
    if(mainWindow){
      if(mainWindow.isMinimized())mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow).catch(err=>{
    log('ERRO: '+(err?.stack||err));
    app.quit();
  });
}

app.on('child-process-gone',(event,details)=>log('CHILD_PROCESS_GONE '+JSON.stringify(details||{})));
app.on('will-quit',()=>log('Aplicativo will-quit'));
app.on('activate',()=>{
  if(BrowserWindow.getAllWindows().length===0)createWindow();
});
app.on('before-quit',()=>{
  log('Aplicativo before-quit');
  stopExternalServerProcesses();
});
app.on('window-all-closed',()=>{
  if(process.platform!=='darwin')app.quit();
});

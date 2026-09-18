const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const PORT = Number(process.env.PORT || 4317);
let mainWindow = null;
let logFile = null;
let chatgptProcess = null;
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
function getPlaywrightChromium(){
  try{
    const exe=chromium.executablePath();
    if(exe&&fs.existsSync(exe)) return exe;
  }catch{}
  const root=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'ms-playwright'):'';
  if(root&&fs.existsSync(root)){
    const candidates=fs.readdirSync(root,{withFileTypes:true})
      .filter(x=>x.isDirectory()&&/^chromium-\d+$/i.test(x.name))
      .sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}))
      .map(x=>path.join(root,x.name,'chrome-win64','chrome.exe'))
      .filter(fs.existsSync);
    if(candidates.length) return candidates[0];
  }
  return null;
}
function unpackedScript(name){
  return app.isPackaged
    ? path.join(process.resourcesPath,'app.asar.unpacked','scripts',name)
    : path.join(__dirname,'..','scripts',name);
}
async function cloakChatGPTWindow(profile){
  const script=unpackedScript('cloak-chatgpt-window.ps1');
  if(!fs.existsSync(script)) return;
  await new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,profile],{windowsHide:true,stdio:'ignore'});
    const done=()=>resolve();
    child.once('exit',done);child.once('error',done);
    setTimeout(done,3500);
  });
}

async function ensureChatGPTBrowser(dataRoot){
  process.env.CHATGPT_CDP_URL='http://127.0.0.1:9223';
  process.env.CHATGPT_WEB_MODEL='GPT-5.6 Sol';
  process.env.CHATGPT_WEB_LEVEL='high';
  const profile=path.join(dataRoot,'chatgpt-web-provider-profile');
  fs.mkdirSync(profile,{recursive:true});
  if(await waitUrl(`${process.env.CHATGPT_CDP_URL}/json/version`,4)){
    await cloakChatGPTWindow(profile);
    log('Sessão ChatGPT invisível já disponível'); return true;
  }
  const exe=getPlaywrightChromium();
  if(!exe) throw new Error('Chromium do Playwright não encontrado para abrir o ChatGPT.');
  try{fs.rmSync(path.join(profile,'lockfile'),{force:true});}catch{}
  chatgptProcess=spawn(exe,[
    '--remote-debugging-port=9223',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-position=-32000,-32000',
    '--window-size=800,600',
    'https://chatgpt.com/'
  ],{windowsHide:true,stdio:'ignore'});
  const ok=await waitUrl(`${process.env.CHATGPT_CDP_URL}/json/version`,100);
  if(!ok) throw new Error('Navegador persistente do ChatGPT não respondeu.');
  await cloakChatGPTWindow(profile);
  log('Sessão ChatGPT iniciada invisível');
  return true;
}
async function waitForServer(){
  const ok=await waitUrl(`http://127.0.0.1:${PORT}/api/ai/status`,100);
  if(!ok) throw new Error('O servidor local do LetsWork não iniciou.');
}

async function createWindow(){
  const dataRoot=path.join(app.getPath('home'),'LetsWork','dados');
  fs.mkdirSync(dataRoot,{recursive:true});
  logFile=path.join(dataRoot,'desktop.log');
  process.env.LETSWORK_DATA_ROOT=dataRoot;
  process.env.PORT=String(PORT);
  log('iniciando LetsWork em '+__dirname);

  await ensureChatGPTBrowser(dataRoot);
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
  const profile=path.join(app.getPath('home'),'LetsWork','dados','chatgpt-web-provider-profile');
  const script=unpackedScript('stop-chatgpt-browser.ps1');
  if(fs.existsSync(script)){
    try{spawnSync('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,profile],{windowsHide:true,stdio:'ignore'});}catch{}
  }else if(chatgptProcess?.pid){
    try{spawnSync('taskkill',['/PID',String(chatgptProcess.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
  }
  chatgptProcess=null;
});

app.on('window-all-closed',()=>{
  if(process.platform!=='darwin') app.quit();
});


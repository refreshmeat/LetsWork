import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PACKED_SCRIPT=path.join(APP_ROOT,'scripts','word_convert.ps1');
const SCRIPT=PACKED_SCRIPT.includes('app.asar')?PACKED_SCRIPT.replace('app.asar','app.asar.unpacked'):PACKED_SCRIPT;

async function runWord(input, output, mode) {
  if (!fs.existsSync(input)) throw new Error(`Arquivo não encontrado: ${input}`);
  await execFileAsync('powershell.exe',[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',SCRIPT,
    '-InputPath',input,'-OutputPath',output,'-Mode',mode
  ],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  if (!fs.existsSync(output)) throw new Error(`Word não gerou ${output}`);
  return output;
}

export async function convertToDocx(input, output) {
  return runWord(input,output,'docx');
}

export async function exportToPdf(input, output) {
  return runWord(input,output,'pdf');
}

export function wordAutomationAvailable() {
  return process.platform === 'win32' && fs.existsSync(SCRIPT);
}
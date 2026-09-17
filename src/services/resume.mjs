import fs from 'fs';
import path from 'path';
import os from 'os';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';
import { createWorker } from 'tesseract.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

const imageExt = new Set(['.png','.jpg','.jpeg','.webp','.bmp','.tif','.tiff']);
const textExt = new Set(['.txt','.md','.csv','.json','.xml','.html','.htm','.rtf']);
const ignoredNameWords = /curr[ií]culo|curriculum|perfil|contato|forma[cç][aã]o|experi[eê]ncia|habilidades|compet[eê]ncias/i;

async function withOcrWorker(fn) {
  const worker = await createWorker('por');
  try { return await fn(worker); }
  finally { await worker.terminate(); }
}

function pageTextLines(content) {
  const rows = new Map();
  for (const item of content.items || []) {
    const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x:item.transform?.[4] || 0, text:item.str || '' });
  }
  return [...rows.entries()].sort((a,b)=>b[0]-a[0])
    .map(([,parts])=>parts.sort((a,b)=>a.x-b.x).map(x=>x.text).join(' ').replace(/\s+/g,' ').trim())
    .filter(Boolean).join('\n');
}

async function readPdf(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, disableWorker:true }).promise;
  const pages = [];
  for (let i=1;i<=doc.numPages;i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(pageTextLines(content));
  }
  const text = pages.join('\n').trim();
  if (text.replace(/\s/g,'').length >= 80) return text;
  return withOcrWorker(async worker => {
    const chunks = [];
    for (let i=1;i<=Math.min(doc.numPages,8);i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale:1.8 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext:canvas.getContext('2d'), viewport }).promise;
      chunks.push((await worker.recognize(canvas.toBuffer('image/png'))).data.text || '');
    }
    return chunks.join('\n').trim();
  });
}
async function ocrImage(file) {
  return withOcrWorker(async worker => (await worker.recognize(file)).data.text || '');
}

async function extractZip(file) {
  const zip = new AdmZip(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'cvzip-'));
  zip.extractAllTo(dir,true);
  const chunks = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const target = path.join(dir,entry.entryName);
    try {
      const txt = await extractText(target);
      if (txt) chunks.push(txt);
    } catch {}
  }
  fs.rmSync(dir,{recursive:true,force:true});
  return chunks.join('\n');
}

export async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return readPdf(file);
  if (ext === '.docx') return (await mammoth.extractRawText({path:file})).value;
  if (ext === '.zip') return extractZip(file);
  if (imageExt.has(ext)) return ocrImage(file);
  if (textExt.has(ext)) return fs.readFileSync(file,'utf8');
  try { return fs.readFileSync(file,'utf8'); } catch { return ''; }
}

const skillWords = ['excel','word','powerpoint','photoshop','illustrator','indesign','figma','canva','javascript','typescript','python','java','sql','react','node','marketing','social media','ux','ui','design','vendas','atendimento','inglês','ingles'];

function guessName(text) {
  const lines = String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const byLine = lines.find(x => x.length>=5 && x.length<=80 && !x.includes('@') && !ignoredNameWords.test(x) && /^[A-Za-zÀ-ÿ' -]+$/.test(x));
  if (byLine) return byLine;
  const head = String(text||'').slice(0,260);
  const upper = head.match(/\b([A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]{2,}(?:\s+(?:DA|DE|DO|DAS|DOS|E|[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]{2,})){1,6})\b/);
  return upper?.[1] || '';
}

export function inferProfile(text) {
  const clean = String(text||'').replace(/\s+/g,' ').trim();
  const lower = clean.toLowerCase();
  const email = clean.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || '';
  const phone = clean.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/)?.[0] || '';
  const links = [...clean.matchAll(/https?:\/\/[^\s)]+/g)].map(x=>x[0]);
  const linkedin = links.find(x=>/linkedin\.com/i.test(x)) || '';
  const portfolio = links.find(x=>!(/linkedin\.com/i.test(x))) || '';
  const skills = skillWords.filter(x=>lower.includes(x));
  return {name:guessName(text),email,phone,linkedin,portfolio,skills,rawText:text};
}

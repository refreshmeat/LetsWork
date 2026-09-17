import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { askAI, parseJsonLoose } from './ai.mjs';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'generated');
fs.mkdirSync(OUT, { recursive: true });
const slug = s => String(s || 'vaga').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-zA-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,70);
const xmlDecode = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
const xmlEncode = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function copyFallback(source, job) {
  const ext = path.extname(source) || '.bin';
  const out = path.join(OUT, `${slug(job.title)}_${Date.now()}${ext}`);
  fs.copyFileSync(source, out);
  return { file: out, strategy: 'copy-original' };
}

async function tailorDocx(source, job, profile) {
  const zip = new AdmZip(source);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) return copyFallback(source, job);
  let xml = entry.getData().toString('utf8');
  const nodes = [...xml.matchAll(/<w:t([^>]*)>([\s\S]*?)<\/w:t>/g)]
    .map((m,i) => ({ i, full:m[0], attrs:m[1], raw:m[2], text:xmlDecode(m[2]) }))
    .filter(x => x.text.trim().length >= 35);
  if (!nodes.length) return copyFallback(source, job);
  const candidate = nodes.slice(0, 18).map(x => ({ id:x.i, text:x.text }));
  const system = 'Você adapta currículo para uma vaga sem inventar fatos. Preserve significado verdadeiro, tom profissional e comprimento aproximado. Retorne apenas JSON.';
  const prompt = `VAGA:\n${job.title}\n${job.description || ''}\n\nPERFIL VERIFICADO:\n${String(profile.rawText || '').slice(0,9000)}\n\nTRECHOS:\n${JSON.stringify(candidate)}\n\nRetorne {"replacements":[{"id":0,"text":"..."}]}. Só altere trechos que realmente ganham relevância para a vaga. Não invente habilidade, experiência, formação ou disponibilidade.`;
  const answer = await askAI(system, prompt);
  const parsed = parseJsonLoose(answer) || { replacements: [] };
  const repl = new Map((parsed.replacements || []).map(x => [Number(x.id), String(x.text || '').trim()]));
  for (const node of nodes) {
    const next = repl.get(node.i);
    if (!next || next.length > Math.max(node.text.length * 1.35, node.text.length + 55)) continue;
    const replacement = `<w:t${node.attrs}>${xmlEncode(next)}</w:t>`;
    xml = xml.replace(node.full, replacement);
  }
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  const out = path.join(OUT, `${slug(job.title)}_${Date.now()}.docx`);
  zip.writeZip(out);
  return { file: out, strategy: 'docx-preserve-layout' };
}

export async function tailorResume(source, job, profile) {
  const ext = path.extname(source).toLowerCase();
  if (ext === '.docx') return tailorDocx(source, job, profile);
  return copyFallback(source, job);
}

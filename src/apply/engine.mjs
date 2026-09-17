import { chromium } from 'playwright-core';
import fs from 'fs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

function knownAnswer(label, profile, prefs) {
  const q = norm(label);
  if (/nome/.test(q)) return profile.name || null;
  if (/e-?mail/.test(q)) return profile.email || null;
  if (/telefone|celular|whatsapp/.test(q)) return profile.phone || null;
  if (/pretens.*salar|salario/.test(q)) return prefs.salaryExpectation || 'A combinar';
  if (/cidade|municipio/.test(q) && prefs.city) return prefs.city;
  if (/estado|uf/.test(q) && prefs.state) return prefs.state;
  if (/linkedin/.test(q) && profile.linkedin) return profile.linkedin;
  if (/portfolio/.test(q) && profile.portfolio) return profile.portfolio;
  return null;
}

async function fillTextFields(page, profile, prefs) {
  const fields = page.locator('input:visible, textarea:visible');
  const unknown = [];
  for (let i = 0; i < await fields.count(); i++) {
    const el = fields.nth(i); const type = (await el.getAttribute('type') || 'text').toLowerCase();
    if (['hidden','submit','button','file','checkbox','radio'].includes(type)) continue;
    const required = await el.getAttribute('required') !== null;
    const label = await el.evaluate(e => {
      const id = e.id; const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return [l?.innerText,e.getAttribute('placeholder'),e.getAttribute('name'),e.getAttribute('aria-label')].filter(Boolean).join(' ');
    });
    const ans = knownAnswer(label, profile, prefs);
    if (ans) await el.fill(String(ans)).catch(()=>{}); else if (required && !(await el.inputValue().catch(()=>''))) unknown.push(label || `campo ${i+1}`);
  }
  return unknown;
}
async function chooseKnownRadios(page, prefs) {
  const groups = await page.locator('input[type="radio"]:visible').evaluateAll(es => [...new Set(es.map(e => e.name).filter(Boolean))]);
  const unknown = [];
  for (const name of groups) {
    const options = page.locator(`input[type="radio"][name="${name}"]:visible`);
    const text = norm(await options.first().evaluate(e => e.closest('fieldset,div,p')?.innerText || e.name));
    let value = null;
    if (/pcd|deficiencia/.test(text)) value = ['include','only'].includes(prefs.pcdMode) ? 'sim' : 'nao';
    if (/aceita.*pj|contratacao.*pj/.test(text)) value = (prefs.contractTypes || []).includes('PJ') ? 'sim' : 'nao';
    if (/disponibilidade/.test(text) && typeof prefs.availability === 'boolean') value = prefs.availability ? 'sim' : 'nao';
    if (!value) {
      if (await options.first().getAttribute('required') !== null) unknown.push(text.slice(0,120));
      continue;
    }
    for (let i = 0; i < await options.count(); i++) {
      const o = options.nth(i);
      const ov = norm(`${await o.getAttribute('value') || ''} ${await o.evaluate(e => e.parentElement?.innerText || '')}`);
      const yes = value === 'sim' && /\bsim\b|\byes\b/.test(ov);
      const no = value === 'nao' && /\bnao\b|\bnão\b|\bno\b/.test(ov);
      if (yes || no) { await o.check().catch(()=>{}); break; }
    }
  }
  return unknown;
}

async function uploadResume(page, resumeFile) {
  const inputs = page.locator('input[type="file"]:visible');
  if (!await inputs.count()) return false;
  for (let i = 0; i < await inputs.count(); i++) {
    await inputs.nth(i).setInputFiles(resumeFile).catch(()=>{});
  }
  return true;
}
async function findApplicationPage(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (job.source === 'RioVagas') {
    const link = page.locator('a:has-text("QUERO ME CANDIDATAR")').first();
    if (await link.count()) {
      const href = await link.getAttribute('href');
      if (href) await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
  } else {
    const apply = page.getByRole('link', { name: /candidat|apply/i }).first();
    if (await apply.count()) await apply.click().catch(()=>{});
    else {
      const button = page.getByRole('button', { name: /candidat|apply/i }).first();
      if (await button.count()) await button.click().catch(()=>{});
    }
    await page.waitForTimeout(900);
  }
}

export async function applyToJob(job, resumeFile, profile, prefs, { dryRun = true } = {}) {
  if (!fs.existsSync(resumeFile)) return { status:'ERROR', error:'Currículo personalizado não encontrado' };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args:['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await findApplicationPage(page, job);
    const body = norm(await page.locator('body').innerText().catch(()=>''));
    if (/captcha|recaptcha|hcaptcha|codigo de verificacao|autenticacao de dois fatores/.test(body)) {
      return { status:'NEEDS_DATA', error:'Site exige CAPTCHA, código ou autenticação manual' };
    }
    const unknown = [];
    for (let step = 0; step < 4; step++) {
      if (await page.locator('#ciente:visible').count()) await page.locator('#ciente:visible').check().catch(()=>{});
      unknown.push(...await fillTextFields(page, profile, prefs));
      unknown.push(...await chooseKnownRadios(page, prefs));
      await uploadResume(page, resumeFile);
      if (unknown.length) break;
      const next = page.getByRole('button', { name: /pr[oó]ximo|prosseguir|continuar|avançar/i }).first();
      const idNext = page.locator('#btn-proceed:visible').first();
      if (await idNext.count()) { await idNext.click().catch(()=>{}); await page.waitForTimeout(500); continue; }
      if (await next.count()) { await next.click().catch(()=>{}); await page.waitForTimeout(500); continue; }
      break;
    }
    if (unknown.length) return { status:'NEEDS_DATA', error:`Campos obrigatórios sem dado confirmado: ${[...new Set(unknown)].join(' | ')}` };
    if (dryRun) return { status:'READY', error:'' };

    const submitSelectors = [
      '#btn-confim:visible',
      'button[type="submit"]:visible',
      'input[type="submit"]:visible'
    ];
    let submit = null;
    for (const sel of submitSelectors) {
      const candidate = page.locator(sel).first();
      if (await candidate.count()) { submit = candidate; break; }
    }
    if (!submit) return { status:'ERROR', error:'Botão final de envio não encontrado' };
    await submit.click();
    await page.waitForTimeout(1800);
    const finalText = norm(await page.locator('body').innerText().catch(()=>''));
    const ok = /enviado com sucesso|candidatura realizada|application submitted|curriculo=enviado/.test(`${finalText} ${page.url()}`);
    if (!ok) return { status:'ERROR', error:'Envio executado, mas sem confirmação inequívoca do site' };
    return { status:'SENT', error:'' };
  } catch (err) {
    return { status:'ERROR', error:String(err?.message || err).slice(0,500) };
  } finally {
    await browser.close().catch(()=>{});
  }
}

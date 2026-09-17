export async function askAI(system, prompt) {
  if (process.env.OLLAMA_URL) {
    const res = await fetch(`${process.env.OLLAMA_URL.replace(/\/$/,'')}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'qwen2.5:7b', stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    return (await res.json()).message?.content || '';
  }
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-5.6-mini', temperature: 0.2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    return (await res.json()).choices?.[0]?.message?.content || '';
  }
  return '';
}

export function parseJsonLoose(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

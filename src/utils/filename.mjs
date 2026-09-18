export function cleanUploadFilename(value){
  const name=String(value||'');
  if(!/[ÃÂâð]/.test(name)) return name;
  try{
    const decoded=Buffer.from(name,'latin1').toString('utf8');
    if(decoded&&!decoded.includes('\uFFFD')) return decoded;
  }catch{}
  return name;
}

export function safeFilename(value){
  return String(value||'arquivo')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9._ -]+/g,'_')
    .slice(0,120);
}

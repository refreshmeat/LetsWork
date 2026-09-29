import { db } from '../src/db.mjs';
import { resolveRioApplyForm } from '../src/apply/rio.mjs';

const rows=db.prepare("SELECT id,url,title FROM job_inventory WHERE source='RioVagas' AND active=1 ORDER BY datetime(published_at) DESC LIMIT 12").all();
if(!rows.length)throw new Error('Inventário RioVagas vazio');
let ok=null,last=null;
for(const job of rows){
  try{
    const form=await resolveRioApplyForm(job);
    if(form?.postId&&form?.nonce){ok={jobId:job.id,title:job.title,providerJobId:form.postId,questions:form.questions.length};break;}
  }catch(e){last=e;}
}
if(!ok)throw last||new Error('Nenhuma vaga recente expôs formulário HTTP válido');
console.log(JSON.stringify({ok:true,httpOnly:true,form:ok}));

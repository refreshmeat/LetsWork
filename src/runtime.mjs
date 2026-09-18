import fs from 'fs';
import path from 'path';
import { storage } from './storage.mjs';

const session=path.join(storage.temp,`runtime_${process.pid}`);
export const runtime={
  root:storage.root,
  executions:storage.candidates,
  session,
  data:storage.data,
  uploads:path.join(session,'uploads'),
  generated:path.join(session,'generated'),
  reports:path.join(session,'reports'),
  sessions:path.join(session,'sessions')
};
for(const dir of [session,runtime.uploads,runtime.generated,runtime.reports,runtime.sessions]){
  fs.mkdirSync(dir,{recursive:true});
}

import fs from 'fs';
import pngToIco from 'png-to-ico';

const png='build/icon.png';
if(!fs.existsSync(png)) throw new Error('build/icon.png não encontrado');
fs.writeFileSync('build/icon.ico',await pngToIco(png));
console.log('icon ok');

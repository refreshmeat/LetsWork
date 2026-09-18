import fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';
import pngToIco from 'png-to-ico';

const canvas=createCanvas(512,512);
const ctx=canvas.getContext('2d');
ctx.fillStyle='#171717';
ctx.fillRect(0,0,512,512);
ctx.fillStyle='#ffffff';
ctx.font='bold 190px Segoe UI';
ctx.textAlign='center';
ctx.textBaseline='middle';
ctx.fillText('LW',256,270);
const png='build/icon.png';
fs.writeFileSync(png,canvas.toBuffer('image/png'));
fs.writeFileSync('build/icon.ico',await pngToIco(png));
console.log('icon ok');
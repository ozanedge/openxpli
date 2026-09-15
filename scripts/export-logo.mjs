// Regenerate logo PNGs from the canonical SVG assets with installed Chrome.
import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../assets/logo/',import.meta.url));
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try {
 const page=await browser.newPage({viewport:{width:1200,height:1080},deviceScaleFactor:1});
 const exports=[['favicon',16,'favicon-16'],['favicon',32,'favicon-32'],['favicon',180,'apple-touch-icon-180'],['favicon',512,'icon-512'],['mark',256,'mark-256'],['lockup-horizontal',null,'lockup-horizontal'],['lockup-stacked',480,'lockup-stacked']];
 for(const [source,size,target] of exports){
  const svg=await readFile(root+'openxpli-'+source+'.svg','utf8');
  const dims=svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const width=size || Math.ceil(Number(dims[1])*3);const height=Math.round(width*Number(dims[2])/Number(dims[1]));
  await page.setViewportSize({width,height});
  await page.setContent('<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>'+svg);
  await page.screenshot({path:root+'openxpli-'+target+'.png',omitBackground:true});
 }
 const board=await browser.newPage({viewport:{width:1200,height:1080}});
 await board.goto('file://'+root+'preview.html', {waitUntil:'networkidle'});
 await board.locator('.sheet').waitFor();
 await board.evaluate(()=>Promise.all(Array.from(document.images).map(img=>img.decode())));
 await board.screenshot({path:root+'openxpli-brand-preview.png',fullPage:true});
 console.log('Exported seven PNG assets and the brand preview.');
} finally {await browser.close();}

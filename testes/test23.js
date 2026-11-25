const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);
const p=await b.newPage({viewport:{width:1440,height:950}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(300);
await p.click('.row[data-id=c7]');
await p.click('#info [data-act=ruleExample]');await p.press('#msg','Enter');await p.waitForTimeout(1200);
await p.screenshot({path:'ff1.png'});
await p.click('[data-act=ruleOn]');await p.waitForTimeout(1000);await p.screenshot({path:'ff2.png'});
await p.click('.ai-msg:last-of-type [data-v=nao]');

await p.click('#info [data-act=ruleSim]');await p.waitForTimeout(200);await p.screenshot({path:'ff3.png'});
await p.click('.ai-msg:last-of-type [data-v=veio]');await p.fill('.ai-msg:last-of-type input','frente liberada: 120 m de linha');await p.click('.ai-msg:last-of-type [data-v=veioSave]');
await p.evaluate(()=>{const e=[...document.querySelectorAll('#info .block')].find(b=>b.textContent.includes('Alertas desta missão'));e.scrollIntoView();});await p.screenshot({path:'ff4.png'});
console.log(errs);await b.close();})();

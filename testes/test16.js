const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);
const p=await b.newPage({viewport:{width:1440,height:950}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(300);
await p.click('.row[data-id=c7]');await p.click('.chat-head [data-act=info]');
await p.click('[data-act=layer][data-v=int]');await p.waitForTimeout(100);
// weekend flow
await p.evaluate(()=>document.querySelector('.ai-msg [data-v=charge]').scrollIntoView());
await p.click('.ai-msg [data-v=charge]');await p.click('.ai-msg [data-v=formYes]');await p.click('.ai-msg [data-v=viaEmail]');
await p.fill('input[list]','Everton Quintela');await p.click('.ai-msg [data-v=search]');await p.waitForTimeout(100);
await p.evaluate(()=>[...document.querySelectorAll('.ai-msg')].find(x=>x.textContent.includes('RDO nº 75')).scrollIntoView());await p.screenshot({path:'y1.png'});
// romaneio
await p.evaluate(()=>[...document.querySelectorAll('.ai-msg')].find(x=>x.textContent.includes('R-2026-0502')).scrollIntoView({block:'center'}));
await p.screenshot({path:'y2.png'});
await p.click('.ai-msg [data-v=unl]');await p.click('.ai-msg [data-v=unlSave]');
await p.click('[data-act=layer][data-v=mgmt]');await p.waitForTimeout(100);
await p.evaluate(()=>document.getElementById('mg-eq').scrollIntoView());await p.screenshot({path:'y3.png'});
await p.evaluate(()=>document.querySelector('.ac-grid.two').scrollIntoView());await p.screenshot({path:'y4.png'});
await p.click('[data-act=layer][data-v=rep]');await p.click('[data-act=repType][data-t=RCPU]');await p.waitForTimeout(100);await p.screenshot({path:'y5.png'});
await p.click('[data-act=repView] >> nth=0');await p.screenshot({path:'y6.png'});await p.click('.modal [data-act=closeModal]');
await p.click('[data-act=repWa] >> nth=0');
console.log(errs);await b.close();})();

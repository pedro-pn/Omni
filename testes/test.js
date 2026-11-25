const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);
for(const [w,hh,name] of [[1440,900,'desk'],[390,820,'mob']]){
const p=await b.newPage({viewport:{width:w,height:hh}});const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(800);
if(name==='desk'){
 await p.click('[data-act=tab][data-v=arquivos]');await p.click('.fs-item[data-act=cdIn] >> nth=1');await p.click('.fs-item[data-act=cdIn] >> nth=0');
 await p.screenshot({path:'s-files.png'});
 await p.click('.fs-item[data-file] >> nth=0');
 await p.fill('#msg','Segue o layout, Pedro!');await p.press('#msg','Enter');
 await p.fill('#msg','/tarefa Revisar memorial +Priscila sexta às 10h p1');await p.dispatchEvent('#msg','input');
 await p.screenshot({path:'s-task.png'});await p.press('#msg','Enter');
 await p.waitForTimeout(6000);await p.screenshot({path:'s-desk.png'});
 await p.click('[data-act=call][data-k=wa]');await p.waitForTimeout(3500);await p.screenshot({path:'s-call.png'});
 await p.click('[data-act=endCall]');await p.waitForTimeout(4000);await p.screenshot({path:'s-after.png'});
} else { await p.screenshot({path:'s-mob.png'}); await p.click('.row >> nth=1'); await p.waitForTimeout(300); await p.screenshot({path:'s-mob2.png'}); 
 const ov=await p.evaluate(()=>document.documentElement.scrollWidth); console.log('mob scrollWidth',ov);}
console.log(name,errs);}
await b.close();})();

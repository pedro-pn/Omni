const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);fs.writeFileSync(require('os').tmpdir()+'/PT-4250-Rev1.pdf','%PDF-1.4 test');
const p=await b.newPage({viewport:{width:1440,height:950}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(300);
await p.click('.row[data-id=c9]');await p.click('[data-act=layer][data-v=int]');await p.waitForTimeout(100);await p.screenshot({path:'bb1.png'});
await p.selectOption('.ai-msg [id$=-s]','anaelise');await p.click('.ai-msg [data-v=save] >> nth=0');await p.waitForTimeout(100);
await p.click('.ai-msg:last-of-type [data-v=save]');await p.waitForTimeout(100); // validation
await p.setInputFiles('.ai-msg:last-of-type input[type=file]',require('os').tmpdir()+'/PT-4250-Rev1.pdf');
await p.fill('.ai-msg:last-of-type input[type=date]','2026-11-23');await p.fill('.ai-msg:last-of-type [id$=-cn]','Robson Teodoro');await p.fill('.ai-msg:last-of-type [id$=-ce]','robson.teodoro@portonorte.com.br');await p.fill('.ai-msg:last-of-type [id$=-cp]','+55 91 98877-3301');await p.fill('.ai-msg:last-of-type textarea','Diálise do óleo dos redutores do píer 2, 10 dias.');
await p.click('.ai-msg:last-of-type [data-v=save]');await p.waitForTimeout(100);
const docBtn=p.locator('.ai-msg',{hasText:'responsável pela documentação'}).locator('[data-v=save]');await docBtn.click();
await p.waitForTimeout(100);await p.screenshot({path:'bb2.png'});
await p.evaluate(()=>{const e=[...document.querySelectorAll('#info .block')].find(b=>b.textContent.includes('Responsáveis da missão'));e.scrollIntoView();document.querySelector('#info .info-body').scrollTop+=380;});await p.screenshot({path:'bb3.png'});
console.log(errs);await b.close();})();

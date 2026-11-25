const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);
const p=await b.newPage({viewport:{width:1440,height:900}});const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(400);
await p.click('[data-act=view][data-v=tasks]');await p.click('[data-act=batchOpen]');await p.waitForTimeout(100);
for(const k of ['pessoa','tabela','rotulos','linha']){
 await p.click(`[data-act=batchFmt][data-k=${k}]`);await p.click('[data-act=batchTpl]');await p.click('[data-act=batchReview]');await p.waitForTimeout(100);
 const rows=await p.evaluate(()=>[...document.querySelectorAll('.brows .brow')].map(r=>{const q=s=>r.querySelector(s);return [q('[data-f=title]').value,q('[data-f=proj]').selectedOptions[0].text,q('[data-f=who]').selectedOptions[0].text,q('[data-f=due]').value,q('[data-f=time]').value].join(' | ')}));
 const w=await p.evaluate(()=>[...document.querySelectorAll('.warn-box li')].map(l=>l.textContent));
 console.log('== '+k);rows.forEach(r=>console.log(r));console.log('warn',w);
 if(k==='pessoa') await p.screenshot({path:'b1.png'});
 await p.click('[data-act=batchBack]');
}
await p.click('[data-act=batchFmt][data-k=pessoa]');await p.click('[data-act=batchTpl]');await p.click('[data-act=batchReview]');
await p.click('[data-act=batchCreate]');await p.waitForTimeout(200);await p.screenshot({path:'b2.png'});
await p.click('[data-act=selMode]');await p.click('.sel-ck >> nth=0');await p.click('.sel-ck >> nth=1');await p.selectOption('#selWho','laercio');await p.screenshot({path:'b3.png'});await p.click('[data-act=selApply]');
const ctx=await b.newContext({viewport:{width:390,height:820},hasTouch:true,isMobile:true});const m=await ctx.newPage();m.on('pageerror',e=>errs.push(e.message));
await m.goto('file://'+require('os').tmpdir()+'/central-t.html');await m.waitForTimeout(300);await m.click('[data-act=view][data-v=tasks]');await m.click('[data-act=batchOpen]');await m.click('[data-act=batchTpl]');await m.click('[data-act=batchReview]');await m.screenshot({path:'b4.png'});
console.log(errs);await b.close();})();

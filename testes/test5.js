const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900}});const errs=[];p.on('pageerror',e=>errs.push(e.message+' '+e.stack));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(300);
await p.click('[data-act=view][data-v=tasks]');await p.click('[data-act=batchOpen]');await p.click('[data-act=batchTpl]');await p.click('[data-act=batchReview]');await p.waitForTimeout(200);
console.log(errs, await p.evaluate(()=>document.querySelector('#toasts').innerText));await b.close();})();

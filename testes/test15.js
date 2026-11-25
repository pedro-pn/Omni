const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();const errs=[];
const m=await (await b.newContext({viewport:{width:390,height:820},hasTouch:true,isMobile:true})).newPage();m.on('pageerror',e=>errs.push(e.message));
await m.goto('file://'+require('os').tmpdir()+'/central-t.html');await m.waitForTimeout(300);await m.click('.row[data-id=c9]');await m.click('[data-act=layer][data-v=int]');await m.screenshot({path:'x1.png'});
console.log(errs, await m.evaluate(()=>document.documentElement.scrollWidth));await b.close();})();

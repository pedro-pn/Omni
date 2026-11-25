const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const errs=[];
const m=await (await b.newContext({viewport:{width:390,height:820},hasTouch:true,isMobile:true})).newPage();m.on('pageerror',e=>errs.push(e.message));
await m.goto('file://'+require('os').tmpdir()+'/central-t.html');await m.waitForTimeout(300);await m.click('.row[data-id=c7]');await m.click('[data-act=layer][data-v=rep]');await m.click('[data-act=repType][data-t=RCPU]');await m.screenshot({path:'z1.png'});
await m.click('[data-act=layer][data-v=mgmt]');await m.evaluate(()=>document.getElementById('mg-rom').scrollIntoView());await m.screenshot({path:'z2.png'});
console.log(errs, await m.evaluate(()=>document.documentElement.scrollWidth));await b.close();})();

const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'+fs.readFileSync(require('path').join(__dirname,'..','prototipo','central-filtrovali.fragment.html'),'utf8')+'</body></html>';
fs.writeFileSync(''+require('os').tmpdir()+'/central-t.html',html);
const ctx=await b.newContext({viewport:{width:390,height:820},hasTouch:true,isMobile:true});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('file://'+require('os').tmpdir()+'/central-t.html');await p.waitForTimeout(500);
await p.screenshot({path:'m1.png'});
const r=await p.locator('.row[data-id=c6]').boundingBox();
await p.mouse.move(r.x+300,r.y+30);await p.mouse.down();
for(let i=1;i<=10;i++){await p.mouse.move(r.x+300-i*18,r.y+31);}
await p.screenshot({path:'m2.png'});
await p.mouse.up();await p.waitForTimeout(700);await p.screenshot({path:'m3.png'});
console.log('archived',await p.evaluate(()=>document.querySelectorAll('.row[data-id=c6]').length), 'pane',await p.evaluate(()=>document.getElementById('app').dataset.pane));
await p.click('.row[data-id=c1]');await p.waitForTimeout(200);
const fs2=await p.evaluate(()=>getComputedStyle(document.getElementById('msg')).fontSize);console.log('msg font',fs2);
await p.screenshot({path:'m4.png'});
console.log(errs);await b.close();})();

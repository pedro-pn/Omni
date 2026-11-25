// Roda todos os testes de fumaça do protótipo (Playwright + Chromium).
// Uso: npm install && npx playwright install chromium && node testes/run-all.js
const {execFileSync}=require('child_process');const fs=require('fs');const path=require('path');
const dir=__dirname, out=path.join(dir,'screenshots'); fs.mkdirSync(out,{recursive:true});
const files=fs.readdirSync(dir).filter(f=>/^test\d*\.js$/.test(f)).sort((a,b)=>(parseInt(a.slice(4))||0)-(parseInt(b.slice(4))||0));
let fail=0; for(const f of files){ try{ const r=execFileSync('node',[path.join(dir,f)],{cwd:out,encoding:'utf8',timeout:180000}); const errs=/pageerror|ReferenceError|TypeError/.test(r)&&!/\[\]/.test(r); console.log((errs?'⚠️ ':'✅ ')+f+'  '+r.trim().split('\n').pop()); }catch(e){ fail++; console.log('❌ '+f+'  '+String(e.stdout||e.message).split('\n').slice(-3).join(' ')); } }
console.log(fail?`${fail} teste(s) falharam`:'Todos os testes rodaram'); process.exit(fail?1:0);

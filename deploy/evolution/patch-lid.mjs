import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Evolution v2.3.7 (depois do patch-contatos): a lista de contatos (chat/findContacts)
// passa a trazer, para cada contato, o outro identificador da mesma pessoa:
//   número (…@s.whatsapp.net) → lidJid (…@lid);  @lid → pnJid (número).
// O WhatsApp manda muitas conversas só pelo @lid, e o nome da agenda fica no número:
// sem isso o Omni não sabe que são a mesma pessoa e mostra o número.
// Lê SÓ o mapeamento já guardado na sessão (chaves "lid-mapping"): nenhuma consulta
// nova ao WhatsApp (o getLIDForPN da Baileys consultaria a rede quando não acha).
const filename = process.argv[2] || '/evolution/dist/main.mjs';
const expected = '0220846c68e08ccb32df86ffdfdef28a65433064bec85d7cc18521560a74ae47';
const source = readFileSync(filename, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Unexpected Evolution source; review before applying the lid fix');
}
const old = 'async fetchContacts({instanceName:s},e){return await this.waMonitor.waInstances[s].fetchContacts(e)}';
const fixed =
  'async fetchContacts({instanceName:s},e){let r=await this.waMonitor.waInstances[s].fetchContacts(e);' +
  'try{let m=this.waMonitor.waInstances[s]?.client?.signalRepository?.lidMapping;' +
  'if(m&&m.keys&&typeof m.keys.get==="function"&&Array.isArray(r)){' +
  'let u=j=>String(j).split("@")[0].split(":")[0],ok=j=>/^\\d{5,20}$/.test(j);' +
  'let pn=r.filter(c=>typeof c?.remoteJid==="string"&&c.remoteJid.endsWith("@s.whatsapp.net")),' +
  'ld=r.filter(c=>typeof c?.remoteJid==="string"&&c.remoteJid.endsWith("@lid"));' +
  'let a=pn.length?await m.keys.get("lid-mapping",pn.map(c=>u(c.remoteJid))):{};' +
  'for(let c of pn){let l=a?.[u(c.remoteJid)];l!=null&&ok(u(l))&&(c.lidJid=u(l)+"@lid")}' +
  'let b=ld.length?await m.keys.get("lid-mapping",ld.map(c=>u(c.remoteJid)+"_reverse")):{};' +
  'for(let c of ld){let p=b?.[u(c.remoteJid)+"_reverse"];p!=null&&ok(u(p))&&(c.pnJid=u(p)+"@s.whatsapp.net")}}}' +
  'catch(x){this.waMonitor?.logger?.warn?.("omni lid mapping: "+(x?.message||x))}return r}';
if (source.split(old).length !== 2) throw new Error('Ambiguous fetchContacts controller');
writeFileSync(filename, source.replace(old, fixed));
console.log('EVOLUTION_LID_MAPPING_FIXED');

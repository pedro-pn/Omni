import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Evolution v2.3.7: "contacts.upsert" grava os contatos com createMany(skipDuplicates).
// Quando o celular sincroniza a agenda e o contato JÁ existia (criado antes por uma
// mensagem, sem nome), o nome salvo no celular é descartado e o Omni mostra só o
// número. O patch atualiza o nome dos que já existiam: o da agenda (name), senão o
// verificado (verifiedName), senão o do perfil (notify). Número no lugar de nome, nunca.
const filename = process.argv[2] || '/evolution/dist/main.mjs';
const expected = 'c489ffefc16bc194e5d3ff9604711596ab77b10b8c2a5c7f7cce62b96487d0cd';
const source = readFileSync(filename, 'utf8');
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Unexpected Evolution source; review before applying the contacts fix');
}
const old = 'this.configService.get("DATABASE").SAVE_DATA.CONTACTS&&await this.prismaRepository.contact.createMany({data:t,skipDuplicates:!0});';
const fixed =
  'this.configService.get("DATABASE").SAVE_DATA.CONTACTS&&(await this.prismaRepository.contact.createMany({data:t,skipDuplicates:!0}),' +
  'await Promise.all(e.map(i=>({remoteJid:i.id,nome:(i?.name||i?.verifiedName||i?.notify||"").trim()}))' +
  '.filter(i=>i.nome&&i.nome.replace(/\\D/g,"")!==String(i.remoteJid).split("@")[0])' +
  '.map(i=>this.prismaRepository.contact.updateMany({where:{remoteJid:i.remoteJid,instanceId:this.instanceId},data:{pushName:i.nome}}))));';
if (source.split(old).length !== 2) throw new Error('Ambiguous contacts.upsert handler');
writeFileSync(filename, source.replace(old, fixed));
console.log('EVOLUTION_CONTACT_NAMES_FIXED');

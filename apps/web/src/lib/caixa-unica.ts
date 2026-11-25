import { nomeParaComparar, telefoneCanonico } from "@omni/core";

import type { ConversaResumo } from "./conversas-fns.ts";
import type { ContatoDaAgenda, Correspondente } from "./unica-fns.ts";

/**
 * Caixa única: junta, por contato, a conversa do WhatsApp e os e-mails trocados com ele.
 * A ligação vem da agenda da empresa (contacts/contact_identities, 0067). Regras puras.
 */

/** Um contato na caixa única: WhatsApp (conversa), e-mails, ou os dois. */
export type ContatoUnico = {
  chave: string;
  nome: string;
  empresa: string | null;
  contatoId: string | null;
  conversa: ConversaResumo | null;
  /** Endereços de e-mail deste contato (agenda + correspondentes). */
  enderecos: string[];
  telefones: string[];
  ultimaEm: string | null;
  previa: string | null;
  canal: "whatsapp" | "email";
  emailsNaoLidos: number;
  /** E-mails e telefones ligados sozinhos (assinatura do e-mail). */
  automaticos: string[];
  noPrisma: boolean;
};

export const digitos = (t: string | null) => (t ?? "").replace(/\D/g, "");

/** Junta conversas individuais e correspondentes de e-mail pelo contato da agenda. */
export function juntarContatos(conversas: ConversaResumo[], correspondentes: Correspondente[], agenda: ContatoDaAgenda[]): ContatoUnico[] {
  const porTelefone = new Map<string, ContatoDaAgenda>();
  const porEmail = new Map<string, ContatoDaAgenda>();
  for (const c of agenda) {
    for (const t of c.telefones) porTelefone.set(t, c);
    for (const e of c.emails) porEmail.set(e, c);
  }
  const itens = new Map<string, ContatoUnico>();
  const mais = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));
  for (const c of conversas) {
    const daAgenda = !c.grupo ? porTelefone.get(telefoneCanonico(c.telefone) ?? digitos(c.telefone)) : undefined;
    const chave = daAgenda ? `c:${daAgenda.id}` : `w:${c.id}`;
    const ja = itens.get(chave);
    // Mesmo contato em dois números meus: fica a conversa mais recente.
    if (ja?.conversa && (ja.conversa.ultimaEm ?? "") >= (c.ultimaEm ?? "")) continue;
    itens.set(chave, {
      chave,
      nome: daAgenda?.nome ?? c.nome,
      empresa: daAgenda?.empresa ?? null,
      contatoId: daAgenda?.id ?? null,
      conversa: c,
      enderecos: daAgenda?.emails ?? [],
      telefones: daAgenda?.telefones ?? (c.telefone ? [telefoneCanonico(c.telefone) ?? digitos(c.telefone)] : []),
      ultimaEm: c.ultimaEm,
      previa: c.previa,
      canal: "whatsapp",
      emailsNaoLidos: 0,
      automaticos: daAgenda?.automaticos ?? [],
      noPrisma: daAgenda?.noPrisma ?? false,
    });
  }
  for (const e of correspondentes) {
    const daAgenda = porEmail.get(e.endereco);
    const chave = daAgenda ? `c:${daAgenda.id}` : `e:${e.endereco}`;
    const ja = itens.get(chave);
    if (ja) {
      const maisNovo = (e.ultimaEm ?? "") > (ja.ultimaEm ?? "");
      ja.enderecos = [...new Set([...ja.enderecos, e.endereco])];
      ja.ultimaEm = mais(ja.ultimaEm, e.ultimaEm);
      if (maisNovo) {
        ja.previa = e.assunto ?? e.previa;
        ja.canal = "email";
      }
      ja.emailsNaoLidos += e.naoLidos;
      continue;
    }
    itens.set(chave, {
      chave,
      nome: daAgenda?.nome ?? e.nome ?? e.endereco,
      empresa: daAgenda?.empresa ?? null,
      contatoId: daAgenda?.id ?? null,
      conversa: null,
      enderecos: daAgenda ? [...new Set([...daAgenda.emails])] : [e.endereco],
      telefones: daAgenda?.telefones ?? [],
      ultimaEm: e.ultimaEm,
      previa: e.assunto ?? e.previa,
      canal: "email",
      emailsNaoLidos: e.naoLidos,
      automaticos: daAgenda?.automaticos ?? [],
      noPrisma: daAgenda?.noPrisma ?? false,
    });
  }
  return [...itens.values()].sort((a, b) => (b.ultimaEm ?? "").localeCompare(a.ultimaEm ?? ""));
}

/**
 * Acha o contato pela chave, mesmo depois de vincular (a chave muda de "w:<conversa>" ou
 * "e:<e-mail>" para "c:<contato>"): o que estava aberto continua aberto.
 */
export function acharContato(contatos: ContatoUnico[], chave: string | null): ContatoUnico | null {
  if (!chave) return null;
  const exato = contatos.find((c) => c.chave === chave);
  if (exato) return exato;
  const valor = chave.slice(2);
  if (chave.startsWith("w:")) return contatos.find((c) => c.conversa?.id === valor) ?? null;
  if (chave.startsWith("e:")) return contatos.find((c) => c.enderecos.includes(valor)) ?? null;
  return null;
}

/** Telefones das conversas individuais na forma da agenda (com DDI e o 9 do celular). */
export function telefonesParaAgenda(conversas: ConversaResumo[]): string[] {
  return [...new Set(conversas.filter((c) => !c.grupo && c.telefone).map((c) => telefoneCanonico(c.telefone)).filter((t): t is string => Boolean(t)))].sort();
}

export type SugestaoDeVinculo = { nome: string; whatsapp: ContatoUnico; email: ContatoUnico; endereco: string; telefone: string };

/**
 * "Mesma pessoa?": a conversa do WhatsApp e o correspondente de e-mail com o mesmo nome
 * (nome e sobrenome, sem acento nem caixa), ainda soltos (sem contato na agenda) e não
 * recusados por mim. Nome repetido em mais de um item fica de fora (ambíguo). Só sugere:
 * juntar é sempre um clique da pessoa.
 */
export function sugestoesPorNome(contatos: ContatoUnico[], recusadas: Set<string>, limite = 3): SugestaoDeVinculo[] {
  const soltosWa = new Map<string, ContatoUnico[]>();
  const soltosEmail = new Map<string, ContatoUnico[]>();
  for (const c of contatos) {
    if (c.contatoId) continue;
    const n = nomeParaComparar(c.conversa ? c.conversa.nome : c.nome);
    if (!n) continue;
    if (c.conversa && !c.conversa.grupo && c.telefones[0]) soltosWa.set(n, [...(soltosWa.get(n) ?? []), c]);
    else if (!c.conversa && c.enderecos[0]) soltosEmail.set(n, [...(soltosEmail.get(n) ?? []), c]);
  }
  const out: SugestaoDeVinculo[] = [];
  for (const [n, wa] of soltosWa) {
    const em = soltosEmail.get(n);
    if (wa.length !== 1 || !em || em.length !== 1) continue;
    const telefone = wa[0]!.telefones[0]!;
    const endereco = em[0]!.enderecos[0]!;
    if (recusadas.has(`${endereco}|${telefone}`)) continue;
    out.push({ nome: em[0]!.nome, whatsapp: wa[0]!, email: em[0]!, endereco, telefone });
    if (out.length >= limite) break;
  }
  return out;
}


import { z } from "zod";

/**
 * Projeções de leitura do Prisma usadas pelo Omni (contrato 1.66.0,
 * `crm-filtrovali/docs/prisma-omni.md`). Só os campos que o Omni guarda; o
 * resto da projeção é ignorado. Valores e contatos ficam de fora.
 */

/** Referência de pasta do SharePoint confirmada pelo Prisma (não concede acesso ao Graph). */
export const pastaSharepointSchema = z.object({
  driveId: z.string().min(1).nullable(),
  folderId: z.string().min(1).max(500),
  webUrl: z.string().nullable(),
  source: z.enum(["opportunity", "mission"]),
  status: z.enum(["ready", "configuration_required"]),
});
export type PastaSharepoint = z.infer<typeof pastaSharepointSchema>;

const quando = z.string().nullable().optional();
/** Lista completa atual; ausente em eventos antigos (não apaga o que o Omni já tem). */
const pastas = z.array(pastaSharepointSchema).optional();

export const empresaPrismaSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
  /** Domínios de e-mail da empresa (vínculo de e-mails por domínio no Omni). */
  emailDomains: z.array(z.string()).nullable().optional(),
  updatedAt: quando,
  deletedAt: quando,
});
export type EmpresaPrisma = z.infer<typeof empresaPrismaSchema>;

export const oportunidadePrismaSchema = z.object({
  id: z.string(),
  code: z.string().nullable().optional(),
  proposalCode: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  missionId: z.string().nullable().optional(),
  updatedAt: quando,
  deletedAt: quando,
  sharepointFolders: pastas,
});
export type OportunidadePrisma = z.infer<typeof oportunidadePrismaSchema>;

export const missaoPrismaSchema = z.object({
  id: z.string(),
  number: z.union([z.number(), z.string()]).nullable().optional(),
  title: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  companyIds: z.array(z.string()).optional(),
  dealIds: z.array(z.string()).optional(),
  updatedAt: quando,
  deletedAt: quando,
  sharepointFolders: pastas,
});
export type MissaoPrisma = z.infer<typeof missaoPrismaSchema>;

/** GET events: `data` é a projeção completa atual, ou `{id, deletedAt}` na exclusão. */
export const eventoPrismaSchema = z.object({
  id: z.union([z.string(), z.number()]),
  cursor: z.string(),
  type: z.string(),
  resource: z.string(),
  recordId: z.string(),
  at: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type EventoPrisma = z.infer<typeof eventoPrismaSchema>;

/**
 * Alertas de risco (Fase 11 do planejamento): volume fora do comum de downloads de
 * arquivos ou de arquivos enviados para fora da empresa, por pessoa. Regras puras;
 * o worker (job `riscos`) junta os números e avisa a Administração e a diretoria.
 *
 * Os limites são altos de propósito: o objetivo é notar uma cópia em massa, não o
 * trabalho do dia a dia.
 */

export const LIMITES_RISCO = {
  /** Arquivos diferentes baixados na última hora. */
  downloadsPorHora: 40,
  /** Arquivos diferentes baixados nas últimas 24 horas. */
  downloadsPorDia: 150,
  /** Arquivos enviados para fora (e-mail para outro domínio, WhatsApp) na última hora. */
  enviosPorHora: 15,
  /** Volume enviado para fora na última hora, em bytes. */
  bytesEnviadosPorHora: 50 * 1024 * 1024,
} as const;

export type TipoRisco = "downloads_em_massa" | "envio_para_fora";

export type UsoDaPessoa = {
  personId: string;
  downloadsHora: number;
  downloadsDia: number;
  /** Origem → quantos (para o detalhe do alerta). */
  origensDownload: Record<string, number>;
  enviosHora: number;
  bytesEnviadosHora: number;
};

export type AlertaDeRisco = { tipo: TipoRisco; personId: string; motivo: string; detalhes: Record<string, unknown> };

const mb = (b: number) => `${Math.round(b / (1024 * 1024))} MB`;

export function avaliarRiscos(usos: UsoDaPessoa[], limites = LIMITES_RISCO): AlertaDeRisco[] {
  const alertas: AlertaDeRisco[] = [];
  for (const u of usos) {
    if (u.downloadsHora >= limites.downloadsPorHora || u.downloadsDia >= limites.downloadsPorDia) {
      alertas.push({
        tipo: "downloads_em_massa",
        personId: u.personId,
        motivo:
          u.downloadsHora >= limites.downloadsPorHora
            ? `${u.downloadsHora} arquivos baixados na última hora (limite ${limites.downloadsPorHora})`
            : `${u.downloadsDia} arquivos baixados nas últimas 24 horas (limite ${limites.downloadsPorDia})`,
        detalhes: { hora: u.downloadsHora, dia: u.downloadsDia, origens: u.origensDownload },
      });
    }
    if (u.enviosHora >= limites.enviosPorHora || u.bytesEnviadosHora >= limites.bytesEnviadosPorHora) {
      alertas.push({
        tipo: "envio_para_fora",
        personId: u.personId,
        motivo:
          u.enviosHora >= limites.enviosPorHora
            ? `${u.enviosHora} arquivos enviados para fora da empresa na última hora (limite ${limites.enviosPorHora})`
            : `${mb(u.bytesEnviadosHora)} enviados para fora da empresa na última hora (limite ${mb(limites.bytesEnviadosPorHora)})`,
        detalhes: { arquivos: u.enviosHora, bytes: u.bytesEnviadosHora },
      });
    }
  }
  return alertas;
}

/** Destinatário de fora: o domínio não está entre os da empresa (os dos e-mails das pessoas do Omni). */
export function enderecoDeFora(endereco: string, dominiosDaEmpresa: ReadonlySet<string>): boolean {
  const dominio = endereco.trim().toLowerCase().split("@")[1];
  return !dominio || !dominiosDaEmpresa.has(dominio);
}

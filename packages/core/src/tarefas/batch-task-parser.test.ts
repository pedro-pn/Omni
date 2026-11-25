import assert from "node:assert/strict";
import { test } from "vitest";
import { parseBatchTasks, matchBatchPeople } from "./batch-task-parser.ts";

const projects = [
  { id: "qsms", name: "QSMS" },
  { id: "okr", name: "OKR - Bimestral" },
];
const people = [
  { name: "pedro.augusto", email: "pedro.augusto@filtrovali.com.br", nickname: "Pedroca" },
  { name: "pedro.bueno", email: "pedro.bueno@filtrovali.com.br" },
  { name: "Rogério Lino Amaral Neto", email: "rogerio.amaral@filtrovali.com.br" },
  { name: "Laércio", email: "laercio@filtrovali.com.br" },
  { name: "Otávio Barcelos", email: "otavio.barcelos@filtrovali.com.br" },
];
const parse = (text: string) =>
  parseBatchTasks({
    text,
    projects,
    people,
    defaultProjectId: "",
    today: "2026-09-06",
    tomorrow: "2026-09-07",
  });

export const meetingSummary = `QSMS

PEDRO AUGUSTO - quinta
- Ajustar o sistema para puxar do Néctar a programação dos próximos 30 dias.
- Ajustar o calendário para permitir a visualização das datas futuras das equipes.
- Verificar quanto foi realizado em Porto Alto e lançar no sistema.
- Adicionar, no custo da Atlas, os salários dos colaboradores que estão faltando.
- Corrigir as datas de viagem das obras.
- Pensar em uma forma melhor de acompanhar a localização/alocação dos colaboradores nas obras.
- Revisar o custo da Boreal, pois os valores estão estranhos.
- Verificar o desvio no romaneio da Boreal: equipamentos 5790 e 5726 estão incorretos.
- Verificar a missão 5745 da Boreal, que está faltando.
- Melhorar a forma de excluir/baixar missões já concluídas, evitando acúmulo de missões no Ponto.
- Verificar o sistema de assinatura dos relatórios.
- Permitir abrir e visualizar o romaneio completo, incluindo mangueiras e demais itens.
- Corrigir as horas da BRX.
- Verificar a Lumetra, que está sem custo de salário lançado.
- Adicionar nas missões a informação se existe obra ou medição liberada, puxando os dados do OMIE.
- VALTEC: adicionar a bomba de filtragem que está faltando no sistema.
- VALTEC: corrigir as horas, pois estão sem custo lançado.

PEDRO BUENO - Quinta
- Melhorar a forma de excluir/baixar missões já concluídas, evitando acúmulo de missões no Expresso.
- Confirmar se a Renata está conferindo o Expresso toda quinta-feira e realizando os lançamentos no OMIE.

ROGÉRIO - Quarta
- Passar o apontamento dos colaboradores para o Laércio.
- Verificar se a Lumetra já foi faturada.

LAÉRCIO - Terça
- Falar com a equipe de Santa Clara sobre o avanço das atividades.
- Acompanhar a Maremar de perto.
- Verificar necessidade de mais pessoas e montar uma programação de treinamento para trabalho offshore. - Quinta
- QUIMAX: verificar se está tudo certo com os exames.
- Iniciar o projeto da Petroluz.
- Confirmar se o responsável da Petroluz irá presencialmente conferir os equipamentos/itens.

OTÁVIO
- Liberar o site da RVT. - hoje
- Arrumar site da trimax - hoje
- Verificar se o sistema da Norvia está habilitado. - terça`;

test("resumo real: 30 tarefas, responsáveis corretos e prazos herdados com exceções", () => {
  const result = parse(meetingSummary);
  assert.equal(result.tasks.length, 30);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.tasks.every((task) => task.projectId === "qsms"));
  assert.deepEqual(
    people.map(
      (person) => result.tasks.filter((task) => task.assigneeEmail === person.email).length,
    ),
    [17, 2, 2, 6, 3],
  );
  assert.ok(result.tasks.slice(0, 19).every((task) => task.dueDate === "2026-09-10"));
  assert.ok(result.tasks.slice(19, 21).every((task) => task.dueDate === "2026-09-09"));
  assert.deepEqual(
    result.tasks.slice(21, 27).map((task) => task.dueDate),
    ["2026-09-08", "2026-09-08", "2026-09-10", "2026-09-08", "2026-09-08", "2026-09-08"],
  );
  assert.deepEqual(
    result.tasks.slice(27).map((task) => task.dueDate),
    ["2026-09-06", "2026-09-06", "2026-09-08"],
  );
  assert.ok(result.tasks[18].content.includes("toda quinta-feira"));
  assert.ok(result.tasks.every((task) => task.recurrence === null && task.dueTime === null));
});

test("não escolhe entre Pedros ambíguos; aceita apelido e normaliza pontuação", () => {
  assert.equal(matchBatchPeople(people, "Pedro").length, 2);
  assert.equal(matchBatchPeople(people, "Pedroca")[0].email, people[0].email);
  const result = parse("QSMS\nPEDRO - quinta\n- Conferir relatório");
  assert.equal(result.tasks[0].assigneeEmail, null);
  assert.equal(result.warnings.length, 1);
});

test("datas numéricas com horário, sem herdar prazo do responsável anterior", () => {
  const result = parse(
    "QSMS\nLAÉRCIO - 10/10/26 07:30\n1. Conferir\n2. Revisar - amanhã\nOTÁVIO\n• Publicar",
  );
  assert.equal(result.tasks[0].dueDate, "2026-10-10");
  assert.equal(result.tasks[0].dueTime, "07:30");
  assert.equal(result.tasks[1].dueDate, "2026-09-07");
  assert.equal(result.tasks[1].dueTime, null);
  assert.equal(result.tasks[2].dueDate, null);
});

test("projeto desconhecido exige correção; troca de projeto limpa cabeçalho anterior", () => {
  const unknown = parse("NÃO EXISTE\nOTÁVIO\n- Conferir");
  assert.equal(unknown.tasks[0].projectId, null);
  assert.ok(unknown.warnings.length);
  const result = parse("QSMS\nOTÁVIO - hoje\n- A\nOKR - Bimestral\nLAÉRCIO\n- B");
  assert.equal(result.tasks[1].projectId, "okr");
  assert.equal(result.tasks[1].dueDate, null);
});

const inlinePeople = [
  ...people,
  { name: "Gilmar Rangel", email: "gilmar@filtrovali.com.br" },
  { name: "Silvana", email: "silvana@filtrovali.com.br" },
  { name: "Sabrina Lobato", email: "sabrina@filtrovali.com.br" },
];
const parseInline = (text: string) =>
  parseBatchTasks({
    text,
    projects,
    people: inlinePeople,
    sections: [{ id: "pedroca", name: "Pedroca", projectId: "qsms" }],
    defaultProjectId: "qsms",
    today: "2026-09-08",
    tomorrow: "2026-09-09",
  });

export const inlineSummary = `Saldos dos PCs da Maralto e Vale Services, ver como vamos proceder nesses casos e ajustar - Gilmar - Quinta

Comprar material de segurança - Tripé, exaustor EX, aspirador 12v e refletor 12v - Rogério - 22/09

Fazer contatos para buscarmos uma definição sobre a vaga de Técnico de segurança - Falar com Silas, Téo e demais colaboradores do time. Abrir possibilidade para que possamos trazer de fora, desde que a pessoa venha com a condição de morar em Itajaí (não terá folga) - Silvana - Quarta feira

Ver para estreitarmos o acesso com a NTRX, buscar alguma visita, saber sobre novas obras - Gilmar - Sexta feira

Atualizar planilha de investimentos para eu ver como estamos com relação a isso, caso tenha coisas que não esteja comprada efetivamente ja bota a previsão de quanto vai ser, caso tenha em mente o que precisa comprar - Sabrina - Quarta`;

test("cinco exemplos reais sem marcadores: responsáveis, datas e hífens internos preservados", () => {
  const result = parseInline(inlineSummary);
  assert.equal(result.tasks.length, 5);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.tasks.map((row) => row.assigneeEmail),
    [
      "gilmar@filtrovali.com.br",
      people[2].email,
      "silvana@filtrovali.com.br",
      "gilmar@filtrovali.com.br",
      "sabrina@filtrovali.com.br",
    ],
  );
  assert.deepEqual(
    result.tasks.map((row) => row.dueDate),
    ["2026-09-10", "2026-09-22", "2026-09-09", "2026-09-11", "2026-09-09"],
  );
  assert.equal(
    result.tasks[1].content,
    "Comprar material de segurança - Tripé, exaustor EX, aspirador 12v e refletor 12v",
  );
  assert.ok(result.tasks[2].content.endsWith("(não terá folga)"));
  assert.ok(result.tasks.every((row) => row.projectId === "qsms" && !row.dueTime));
});

test("responsável no início, no meio e no fim do texto, sem apagar a frase", () => {
  const result = parseInline(
    "Gilmar revisar os saldos quinta\nRevisar com Rogério o material 22/09\nAtualizar a planilha com Sabrina quarta feira",
  );
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(
    result.tasks.map((row) => row.assigneeEmail),
    ["gilmar@filtrovali.com.br", people[2].email, "sabrina@filtrovali.com.br"],
  );
  assert.equal(result.tasks[0].content, "Gilmar revisar os saldos");
  assert.equal(result.tasks[1].content, "Revisar com Rogério o material");
  assert.equal(result.tasks[2].content, "Atualizar a planilha com Sabrina");
});

test("metadados separados por hífen em qualquer ordem ou posição", () => {
  const result = parseInline(
    "Quinta - Gilmar - Revisar saldos\nComprar - Rogério - material - 22/09\nQuarta feira - Conferir - Sabrina",
  );
  assert.deepEqual(
    result.tasks.map((row) => row.content),
    ["Revisar saldos", "Comprar - material", "Conferir"],
  );
  assert.deepEqual(
    result.tasks.map((row) => row.dueDate),
    ["2026-09-10", "2026-09-22", "2026-09-09"],
  );
  assert.ok(result.tasks.every((row) => row.assigneeEmail));
});

test("atalhos da tarefa individual preservam projeto, seção, prioridade, horário, recorrência e etiqueta", () => {
  const result = parseInline(
    "Revisar +Pedro Augusto #QSMS /Pedroca !p1 10/10/26 07:30 @financeiro\n+Sabrina Conferir #OKR - Bimestral toda quarta feira às 14h !p2",
  );
  const [first, second] = result.tasks;
  assert.equal(first.content, "Revisar");
  assert.equal(first.assigneeEmail, people[0].email);
  assert.equal(first.sectionId, "pedroca");
  assert.equal(first.priority, 1);
  assert.equal(first.dueDate, "2026-10-10");
  assert.equal(first.dueTime, "07:30");
  assert.deepEqual(first.labels, ["financeiro"]);
  assert.equal(second.projectId, "okr");
  assert.equal(second.priority, 2);
  assert.equal(second.assigneeEmail, "sabrina@filtrovali.com.br");
  assert.ok(second.recurrence);
  assert.equal(second.dueTime, "14:00");
});

test("não escolhe entre nomes ambíguos nem duas pessoas; +pessoa define o responsável", () => {
  const result = parseInline(
    "Pedro conferir amanhã\nRevisar com Gilmar e Rogério quinta\nFalar com Rogério +Gilmar quinta\n+Pedro conferir\nPedro Augusto conferir",
  );
  assert.deepEqual(
    result.tasks.map((row) => row.assigneeEmail),
    [null, null, "gilmar@filtrovali.com.br", null, people[0].email],
  );
  assert.equal(result.warnings.length, 3);
});

test("linhas independentes não herdam dados e nomes não casam dentro de outras palavras", () => {
  const result = parseInline(
    "Revisar - Gilmar - quinta\nComprar combustível amanhã\nConferir pedrologia\nRevisar com GILMAR\nRevisar com Sabrina",
  );
  assert.equal(result.tasks.length, 5);
  assert.equal(result.tasks[1].assigneeEmail, null);
  assert.equal(result.tasks[1].dueDate, "2026-09-09");
  assert.equal(result.tasks[2].assigneeEmail, null);
  assert.equal(result.tasks[2].dueDate, null);
  assert.equal(result.tasks[3].assigneeEmail, "gilmar@filtrovali.com.br");
  assert.equal(result.tasks[4].assigneeEmail, "sabrina@filtrovali.com.br");
});

test("não confunde nomes em projetos e seções com o responsável", () => {
  const result = parseBatchTasks({
    text: "Revisar #Comercial - Gilmar /Rogério - Campo +Sabrina quinta",
    projects: [{ id: "comercial", name: "Comercial - Gilmar" }],
    sections: [{ id: "campo", name: "Rogério - Campo", projectId: "comercial" }],
    people: inlinePeople,
    defaultProjectId: "",
    today: "2026-09-08",
    tomorrow: "2026-09-09",
  });
  assert.equal(result.tasks[0].content, "Revisar");
  assert.equal(result.tasks[0].projectId, "comercial");
  assert.equal(result.tasks[0].sectionId, "campo");
  assert.equal(result.tasks[0].assigneeEmail, "sabrina@filtrovali.com.br");
});

test("formatos mistos não transformam uma atividade sem marcador em cabeçalho", () => {
  const result = parseInline(
    "Comprar material de segurança\n- Revisar com Rogério amanhã\nConferir relatórios\nGilmar - Revisar o orçamento",
  );
  assert.equal(result.tasks.length, 4);
  assert.equal(result.tasks[0].content, "Comprar material de segurança");
  assert.equal(result.tasks[3].assigneeEmail, "gilmar@filtrovali.com.br");
});

test("só agrupa responsáveis herdados do mesmo cabeçalho, não linhas independentes", () => {
  assert.ok(parseInline(inlineSummary).tasks.every((row) => row.assigneeGroup === undefined));
  const rows = parseInline(
    "QSMS\nGILMAR - quinta\n- A\n- B\n- C +Rogério\nROGÉRIO - quarta\n- D",
  ).tasks;
  assert.equal(rows[0].assigneeGroup, rows[1].assigneeGroup);
  assert.equal(rows[2].assigneeGroup, undefined);
  assert.notEqual(rows[0].assigneeGroup, rows[3].assigneeGroup);
});

export const detailedSummary = `1. Saldos dos PCs — Maralto e Vale Services
   Verificar os saldos dos PCs da Maralto e Vale Services, definir como vamos proceder em cada caso e realizar os ajustes necessários.
   👤 Gilmar | 📅 Até quinta-feira, 10/09

2. Compra de materiais de segurança
   Providenciar a compra dos seguintes equipamentos: tripé, exaustor EX, aspirador 12V e refletor 12V.
   👤 Rogério | 📅 Até terça-feira, 22/09

3. Vaga — Técnico de Segurança
   Avançar nos contatos para buscarmos uma definição sobre a vaga. Falar com Silas, Téo e demais colaboradores do time em busca de indicações.

Ampliar também a busca para profissionais de fora da região, desde que tenham disponibilidade para morar em Itajaí. Nesse caso, a contratação será para permanência na cidade, sem regime de folga para retorno à cidade de origem.
👤 Silvana | 📅 Até quarta-feira, 09/09

4. Aproximação com a NTRX
   Estreitar nosso relacionamento com a NTRX, buscando realizar uma visita e levantar informações sobre novas obras e oportunidades previstas.
   👤 Gilmar | 📅 Até sexta-feira, 11/09

5. Atualização da planilha de investimentos
   Atualizar a planilha de investimentos para termos uma visão do realizado e do que ainda está pendente.

Para os itens ainda não comprados, incluir a previsão de valor dos investimentos que já sabemos que serão necessários.
👤 Sabrina | 📅 Até quarta-feira, 09/09`;

test("resumo numerado real com emojis: cinco tarefas e descrições completas com parágrafos", () => {
  const result = parseInline(detailedSummary);
  assert.equal(result.tasks.length, 5);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.tasks.map((row) => row.content),
    [
      "Saldos dos PCs — Maralto e Vale Services",
      "Compra de materiais de segurança",
      "Vaga — Técnico de Segurança",
      "Aproximação com a NTRX",
      "Atualização da planilha de investimentos",
    ],
  );
  assert.deepEqual(
    result.tasks.map((row) => row.assigneeEmail),
    parseInline(inlineSummary).tasks.map((row) => row.assigneeEmail),
  );
  assert.deepEqual(
    result.tasks.map((row) => row.dueDate),
    ["2026-09-10", "2026-09-22", "2026-09-09", "2026-09-11", "2026-09-09"],
  );
  assert.equal(
    result.tasks[2].description,
    "Avançar nos contatos para buscarmos uma definição sobre a vaga. Falar com Silas, Téo e demais colaboradores do time em busca de indicações.\n\nAmpliar também a busca para profissionais de fora da região, desde que tenham disponibilidade para morar em Itajaí. Nesse caso, a contratação será para permanência na cidade, sem regime de folga para retorno à cidade de origem.",
  );
  assert.ok(result.tasks[4].description?.includes("\n\nPara os itens ainda não comprados"));
  assert.ok(
    result.tasks.every(
      (row) =>
        row.description && !row.description.includes("👤") && !row.description.includes("📅"),
    ),
  );
});

test("campos rotulados em linhas separadas, data numérica prevalece sobre dia da semana", () => {
  const rows = parseInline(
    "1. Revisar\n   Falar com Rogério sobre orçamento.\n   Responsável: Gilmar\n   Prazo: Até quinta-feira, 22/09/26 07:30\n\n2. Conferir\n   Outro detalhe.\n   👤 Pedro\n   📅 amanhã",
  ).tasks;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].assigneeEmail, "gilmar@filtrovali.com.br");
  assert.equal(rows[0].dueDate, "2026-09-22");
  assert.equal(rows[0].dueTime, "07:30");
  assert.equal(rows[1].assigneeEmail, null);
  assert.equal(rows[1].dueDate, "2026-09-09");
});

const missionPeople = [
  ...people,
  { name: "Alexandre", email: "alexandre.torres@filtrovali.com.br" },
  { name: "Wanderson Silva", email: "wanderson.silva@filtrovali.com.br" },
  { name: "Ana Quaresma", email: "ana.quaresma@filtrovali.com.br" },
];
const parseMission = (text: string, members = missionPeople) =>
  parseBatchTasks({
    text,
    projects,
    people: members,
    defaultProjectId: "qsms",
    today: "2026-10-10",
    tomorrow: "2026-10-11",
  });

test("sobrenomes completos do nome e do e-mail, sem casar fragmentos ou domínio", () => {
  for (const query of ["Torres", "TORRES", "+Torres", "@Torres"]) {
    assert.equal(matchBatchPeople(missionPeople, query)[0]?.email, missionPeople[5].email);
  }
  assert.equal(matchBatchPeople(people, "Amaral Neto")[0]?.email, people[2].email);
  assert.deepEqual(matchBatchPeople(missionPeople, "nogue"), []);
  assert.deepEqual(matchBatchPeople(missionPeople, "filtrovali"), []);
  assert.deepEqual(matchBatchPeople(missionPeople, "com.br"), []);
  assert.equal(
    matchBatchPeople(missionPeople, "wanderson.silva@filtrovali.com.br")[0]?.email,
    missionPeople[6].email,
  );
});

test("Torres funciona em cabeçalhos, campos, atalhos e texto livre", () => {
  for (const text of [
    "TORRES\n- Conferir custos",
    "Conferir custos - Torres",
    "Conferir custos | Torres",
    "Conferir custos +Torres",
    "Conferir custos. Responsável: Torres",
    "Torres conferir custos",
  ]) {
    const result = parseMission(text);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].assigneeEmail, missionPeople[5].email);
    assert.deepEqual(result.warnings, []);
  }
});

test("exemplo Quaresma: terceiro campo vence menção a Pedro Augusto e preserva missão, cliente, texto e prazo", () => {
  const description =
    "Conferir os custos da missão, incluindo os escopos extras. Informar os valores ao Pedro Augusto e confirmar com ele se os custos foram registrados corretamente no sistema.";
  const result = parseMission(`5815 | Quaresma | Wanderson | ${description} Prazo: 13/10/2026.`);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].assigneeEmail, missionPeople[6].email);
  assert.equal(result.tasks[0].content, `5815 | Quaresma | ${description}`);
  assert.equal(result.tasks[0].dueDate, "2026-10-13");
  assert.deepEqual(result.warnings, []);
});

test("coluna do responsável aceita sobrenome e não herda o responsável da linha anterior", () => {
  const result = parseMission(
    "5815|Quaresma|Torres|Conferir custos. Prazo: 13/10/2026.\n5816 | Quaresma | Wanderson | Falar com Pedro Augusto.\nConferir relatórios",
  );
  assert.deepEqual(
    result.tasks.map((row) => row.assigneeEmail),
    [missionPeople[5].email, missionPeople[6].email, null],
  );
  assert.deepEqual(
    result.tasks.map((row) => row.dueDate),
    ["2026-10-13", null, null],
  );
  assert.deepEqual(result.warnings, []);
});

test("sobrenome ambíguo ou coluna desconhecida/vazia exige revisão, sem atribuir à pessoa citada", () => {
  const members = [
    ...missionPeople,
    { name: "Carlos Torres", email: "carlos@filtrovali.com.br" },
  ];
  for (const text of [
    "5815 | Quaresma | Torres | Falar com Pedro Augusto",
    "5815 | Quaresma | Desconhecido | Falar com Pedro Augusto",
    "5815 | Quaresma | | Falar com Pedro Augusto",
  ]) {
    const result = parseMission(text, members);
    assert.equal(result.tasks[0].assigneeEmail, null);
    assert.equal(result.warnings.length, 1);
  }
  assert.equal(matchBatchPeople(members, "Torres").length, 2);
  const exact = { name: "Torres", email: "outro@filtrovali.com.br" };
  assert.deepEqual(matchBatchPeople([...members, exact], "Torres"), [exact]);
});

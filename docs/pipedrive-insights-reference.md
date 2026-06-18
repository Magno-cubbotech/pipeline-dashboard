# Pipedrive Insights - referencia de produto para o dashboard

Pesquisa realizada em 2026-06-18, usando documentacao oficial do Pipedrive
Knowledge Base e Developer Docs.

Este documento deve servir como base de consulta para evoluir o dashboard da
Cubbo Tech em direcao a uma experiencia mais proxima do Pipedrive Insights,
sem depender da memoria da conversa.

## Fontes oficiais consultadas

- Insights feature: https://support.pipedrive.com/en/article/insights-feature
- Insights dashboards: https://support.pipedrive.com/en/article/insights-dashboards
- Insights report types: https://support.pipedrive.com/en/article/insights-report-types
- Insights chart types: https://support.pipedrive.com/en/article/insights-reports-chart-types
- Insights deal performance: https://support.pipedrive.com/en/article/insights-reports-deal-performance
- Insights deal conversion: https://support.pipedrive.com/en/article/insights-reports-deal-conversion
- Insights deal duration: https://support.pipedrive.com/en/article/insights-reports-deal-duration
- Insights deal progress: https://support.pipedrive.com/en/article/insights-reports-deal-progress
- Insights activities performance: https://support.pipedrive.com/en/article/insights-reports-activities-performance
- Insights lead performance: https://support.pipedrive.com/en/article/insights-reports-lead-performance
- Insights lead conversion: https://support.pipedrive.com/en/article/insights-reports-lead-conversion
- Insights deal revenue forecast: https://support.pipedrive.com/en/article/insights-reports-revenue-forecast
- Insights product revenue forecast: https://support.pipedrive.com/en/article/insights-revenue-forecast
- Insights products: https://support.pipedrive.com/en/article/insights-products
- Insights combined data: https://support.pipedrive.com/en/article/insights-combined-data
- Insights collaboration: https://support.pipedrive.com/en/article/insights-collaboration
- Shareable Insights: https://support.pipedrive.com/en/article/shareable-insights
- Exporting data from Insights: https://support.pipedrive.com/en/article/exporting-data-from-insights
- Pipedrive API reference: https://developers.pipedrive.com/docs/api/v1

## Modelo mental do Insights

O Insights tem tres objetos principais:

- Reports: visualizacoes de dados da conta, sempre baseadas em filtros.
- Dashboards: colecoes de reports e goals em uma unica tela.
- Goals: metas de deals, atividades e forecast/revenue.

Para o projeto, a arquitetura equivalente deve ser:

- `report_definition`: configuracao salva do report.
- `report_result` ou RPC: resultado calculado a partir dos dados sincronizados.
- `dashboard_definition`: layout, ordem, tamanho e filtros globais.
- `dashboard_snapshot`: cache pronto para leitura rapida pelo frontend.

## Regras de visibilidade e permissoes

Insights respeita a visibilidade dos itens base, como deals, leads, pessoas,
organizacoes e produtos. Usuarios com permissao de admin de deals veem todos os
deals/leads; admins globais veem todos os dados de pessoas, organizacoes e
produtos.

Implicacao para este projeto:

- O dashboard deve continuar exigindo Supabase Auth.
- No futuro, se houver usuarios com escopos diferentes, o cache global atual
  deve virar cache por usuario/perfil/permissao, ou a leitura deve passar por
  RPC que aplica RLS.

## Anatomia de um report

Um report do Insights normalmente tem tres areas:

1. Filter view
   - Define quais registros entram no report.
   - Pode usar campos da entidade principal e, em alguns casos, dados
     combinados de entidades relacionadas.

2. Visual builder
   - Define como os registros filtrados sao agregados e exibidos.
   - Usa a gramatica:
     - Measure by: o que e contado/somado/medido.
     - View by: como separar o eixo principal.
     - Segment by: como quebrar cada grupo por uma segunda dimensao.

3. Table view / Summary
   - Lista os registros que compoem o grafico ou mostra um resumo agregado.
   - Colunas da tabela sao configuraveis e exportaveis.

Implicacao para este projeto:

- O construtor de relatorios deve separar claramente:
  - filtros,
  - metrica,
  - agrupamento principal,
  - segmentacao,
  - tabela detalhada.
- A tabela deve representar o mesmo universo filtrado do grafico.

## Tipos de grafico

O Insights trabalha com cinco tipos principais:

- Column chart
- Bar chart
- Pie chart
- Scorecard
- Table

Regras importantes:

- Nem todo tipo de report permite todos os tipos de grafico.
- Column/bar usam Measure by, View by e Segment by.
- Em bar chart, a orientacao visual troca os eixos, mas a logica continua a
  mesma.
- Pie chart usa Measure by e Segment by, sem View by.
- Scorecard usa apenas Measure by, com filtros definindo o escopo.
- Table chart funciona como uma lista configuravel.
- Quando View by e temporal, o Insights oferece granularidade anual,
  trimestral, mensal, semanal e diaria.

Implicacao para este projeto:

- O modelo interno deve guardar `chart_type`, `measure`, `view_by`,
  `segment_by`, `date_grain` e `filters`.
- O frontend nao deve amarrar a metrica ao tipo de grafico; grafico deve ser uma
  camada de apresentacao.

## Dashboards

Dashboards sao colecoes de reports/goals. Regras oficiais relevantes:

- Um dashboard pode conter ate 25 reports.
- O mesmo report pode ser adicionado a mais de um dashboard.
- Reports podem ser movidos, redimensionados e abertos para edicao.
- Remover um report do dashboard nao exclui o report original.
- Filtros globais do dashboard nao alteram os dados salvos no report; eles
  alteram apenas o que e exibido no dashboard.
- Filtros globais principais:
  - Period
  - User
- Quick filter nao e suportado em goals.
- Se um filtro global remove todos os dados de um report, o card vazio continua
  aparecendo.

Implicacao para este projeto:

- Dashboard precisa de layout persistente.
- Filtros globais devem ser tratados como uma camada acima do report.
- Cada card deve manter seu estado vazio em vez de desaparecer.
- Goals devem ter tratamento separado dos reports.

## Compartilhamento e exportacao

Insights suporta:

- Compartilhamento interno com usuarios/equipes.
- Link publico para dashboards.
- Links publicos de dashboards podem ser vistos por pessoas sem conta Pipedrive.
- Dashboard publico reflete reports e goals atuais.
- Atualizacao padrao de dashboard publico: 1 hora.
- Exportacao:
  - charts: PDF/PNG.
  - dashboards: PDF/PNG com reports visiveis na ordem da tela.
  - dados tabulares: XLSX/CSV.
  - coluna/ponto do grafico pode abrir detalhe e exportar resultados.

Implicacao para este projeto:

- O recurso de link publico existente em `reports` deve evoluir para dashboard
  publico tambem.
- Exportar deve respeitar filtros e ordem visual atual.
- Para links publicos, cache com TTL e snapshot congelado por intervalo e
  suficiente e mais seguro que expor queries dinamicas.

## Dados combinados

O Insights permite campos combinados em algumas tabelas:

- Leads report: pode incluir contact person, organization e deal fields.
- Deals report: pode incluir lead, contact person e organization fields.
- Activity report: pode incluir deal, lead, contact person e organization
  fields.
- Contact person report: pode incluir organization fields.

Implicacao para este projeto:

- A camada `dashboard_snapshots` atual e boa para o dashboard principal, mas o
  construtor de reports deve evoluir para tabelas flat/visoes que tragam as
  dimensoes de relacionamento.
- Para reports de atividades, e importante materializar deal_id, pipeline,
  funil, organization e person quando disponiveis.

## Report types e logica principal

### Deal performance

Objetivo: mostrar quantos deals foram iniciados, ganhos e perdidos.

Padrao:

- Filtro default: Deal created = this year.
- Deals/leads arquivados e nao arquivados entram por padrao; excluir exige
  filtro.
- Tem filter view, visual builder e table view.
- Suporta os cinco graficos: column, bar, pie, scorecard/table.

Aplicacao no projeto:

- O ranking atual de negocios por consultor se aproxima de Deal performance.
- Melhorias:
  - diferenciar "criados", "ganhos", "perdidos" e "abertos";
  - permitir measure by: count, deal value, weighted value, MRR, implantacao;
  - permitir view by: owner, creator/SDR, pipeline, funil, stage, source/channel,
    dates.

### Deal conversion

Dois tipos:

1. Funnel conversion
   - Mostra conversao entre etapas do pipeline.
   - Filtros default: pipeline, deal created = this year, status = won/lost.
   - Deals won sao considerados como tendo completado todos os estagios do
     pipeline, mesmo se fechados antes do fim.
   - Deals lost param no estagio em que foram perdidos.
   - O filtro de pipeline e requerido para report baseado em etapas.

2. Win/loss conversion
   - Compara won vs lost.
   - Filtros default: deal created = this year, status = won/lost.
   - Normalmente agrupado por owner, data ou outro campo.

Measure by:

- Number of deals
- Deal value
- Weighted value
- Campos custom numericos/monetarios

Aplicacao no projeto:

- Implementar separadamente:
  - "Conversao de funil" por etapa.
  - "Win/loss" por consultor, prospector, canal, periodo.
- Nao misturar conversao de etapa com conversao comercial final.
- Para funil, precisamos historico de mudanca de stage; se a API sincronizada
  nao traz historico suficiente, sera necessario capturar updates/stage changes
  em tabela propria.

### Deal duration

Objetivo: tempo medio para um deal atravessar o pipeline.

Regras:

- Sempre medido em dias.
- Filtros default:
  - Deal created = this year.
  - Pipeline = default pipeline.
  - Status in lost/won.
- Recomendado analisar won/lost, mas open pode ser incluido.
- Se um deal for ganho antes do fim do pipeline, todos os estagios sao
  considerados.
- Tempo medio do ciclo = tempo total gasto nos estagios / total de deals do
  filtro.
- Estagios deletados nao entram no calculo.
- Se houver open deals no filtro, o grafico mostra tempo medio no estagio; sem
  open deals, mostra tempo medio no pipeline.

Aplicacao no projeto:

- Hoje o projeto nao tem base suficiente para "tempo por etapa" fiel se so
  depender do estado atual do deal.
- Precisamos sincronizar ou reconstruir historico de stage changes.
- Sem historico, usar apenas aproximacoes e rotular como "idade do deal" ou
  "dias parado", nao como duration Insights.

### Deal progress

Objetivo: movimento de deals atraves de estagios em um periodo.

Regras:

- Filtro default:
  - Date of entering stage = this year.
  - Pipeline = default pipeline.
- O filtro Date of entering stage e travado, pois e necessario para medir
  progresso.
- Progress usa updates mais recentes de stage; se um deal volta da etapa 2 para
  etapa 1, ele e representado na etapa 1.
- Medindo por number of deals, conta deals que entraram em cada stage no periodo.
- Deals que pulam etapas ao avancar sao contados como tendo entrado nos estagios
  intermediarios. Ex.: stage 2 -> stage 5 conta stage 3, 4 e 5.
- Winning nao afeta progress de stages pulados.
- Se View by = Stage entered, Segment by nao e aplicado.

Aplicacao no projeto:

- Criar tabela `pd_deal_stage_events` ou equivalente.
- Nao tentar inferir progress apenas por `stage_id` atual.
- Separar "foto atual do pipeline" de "movimento no periodo".

### Activities performance

Objetivo: acompanhar conclusao/produtividade de atividades como calls,
meetings e tasks.

Padrao:

- Filtro default: Add time = this month.
- A interface tem filter view, visual builder e table/summary.
- Duration e sempre calculado em horas.
- Emails so entram se foram adicionados como atividades; email sync/Smart Bcc
  tem report proprio.

Campos suportados relevantes:

- Duration (minutes)
- Number of activities
- Pipeline
- Team
- Add time
- Due time
- Marked as done time
- Assigned to user
- Creator
- Type of activity
- Deal
- Contact person
- Organization
- Subject
- Status
- ID

Aplicacao no projeto:

- O painel de abordagens deve usar `marked_as_done_time` quando a pergunta e
  "o que foi concluido no periodo".
- O painel operacional de apresentacoes pode usar `due_date` quando a pergunta e
  "o que estava agendado para o periodo".
- Documentar cada card com o campo de data usado.

### Lead performance

Objetivo: quantos leads foram criados, arquivados ou convertidos em deals.

Aplicacao no projeto:

- Se leads forem incluidos futuramente, criar tabela `pd_leads` e separar funil
  de lead vs deal.
- Nao misturar "prospector criou deal" com "lead convertido" sem fonte de lead.

### Lead conversion

Objetivo: taxa de lead-to-deal.

Formula oficial:

- conversion rate = converted leads * 100% / total leads

Padrao:

- Leads created = this year.
- Agrupado por lead source.
- Pode ser column chart ou scorecard.
- Para won deals, usar Deal conversion em vez de Lead conversion.

Aplicacao no projeto:

- O projeto hoje calcula conversao de deals; nao deve chamar isso de lead
  conversion.
- Para implementar lead conversion real, precisa sincronizar leads, status de
  conversao e relacao lead -> deal.

### Deal revenue forecast

Objetivo: estimar receita futura a partir de deals.

Regras:

- Disponivel em planos Premium+.
- Mostra valor total de open e won deals.
- Open deals sao posicionados por expected close date.
- Won deals sao posicionados por won time.
- Filtros obrigatorios:
  - Forecast period.
  - Status.
- Lost deals nao podem ser visualizados nesse report.
- View by default: cumulative forecast mensal; pode mudar para forecast nao
  cumulativo.

Aplicacao no projeto:

- Criar card "Forecast" separado dos cards de venda realizada.
- Open -> expected_close_date.
- Won -> won_time.
- Excluir lost.
- Suportar cumulative vs regular forecast.

### Product revenue forecast

Objetivo: projetar receita de produtos regulares e recorrentes ligados a deals.

Regras:

- Usa billing date e billing cycle dos produtos.
- View by default: billing date.
- Colunas representam valor dos produtos por periodo.

Aplicacao no projeto:

- So implementar quando `deal_products`/produtos estiverem sincronizados.
- Campos necessarios: billing date, billing cycle, product amount, quantity,
  TCV, product type/frequency/name/variation.

### Product reporting

Objetivo: analisar desempenho dos produtos anexados aos deals.

Regras:

- Cada linha da tabela representa um produto anexado a um deal.
- Se um deal tem dois ou mais produtos, cada produto aparece em linha propria.
- View by default: Product name.
- Measure by default: Product TCV.
- Opcoes comuns:
  - Product TCV.
  - Product amount.
  - Product quantity.

Aplicacao no projeto:

- Nao modelar produto como atributo unico do deal.
- Usar granularidade deal-product.

## API e dados necessarios

A referencia publica da API lista endpoints para entidades base como deals,
activities, leads, users, stages, pipelines, products, deal products, filters,
goals e webhooks. Nao foi identificado endpoint publico especifico para
exportar "Insights reports/dashboards" prontos.

Implicacao para este projeto:

- Devemos continuar replicando entidades base do Pipedrive para o Supabase.
- A logica de Insights deve ser reproduzida no nosso backend/Postgres.
- Goals podem ter relacao com endpoint de Goals, mas reports/dashboards custom
  devem ser modelados no proprio projeto.

## Prioridades para transformar o projeto

1. Consolidar schema de reports
   - `reports` ja existe, mas deve evoluir para modelo compativel com
     Measure/View/Segment/Filters/Table.

2. Criar camada flat por entidade
   - `deals_flat`
   - `activities_flat`
   - `leads_flat` quando leads entrarem
   - `deal_stage_events` para progress/duration/conversion por stage
   - `deal_products_flat` para product/revenue reports

3. Separar filtros globais de dashboard dos filtros de report
   - Dashboard filters: Period, User.
   - Report filters: definem universo base.

4. Implementar cards vazios
   - Se filtro remove todos os dados, mostrar o card vazio, nao sumir.

5. Criar backend de agregacao
   - Uma RPC generica `run_report_v2(config, dashboard_filters)`.
   - Snapshots por dashboard para carregamento rapido.

6. Criar UI de builder mais fiel ao Insights
   - Escolher tipo de report.
   - Escolher chart type.
   - Configurar filters, measure by, view by, segment by.
   - Configurar table columns.

7. Auditar nomes de metricas
   - "Lead conversion" so quando houver entidade lead.
   - "Deal conversion" para won/lost e funil.
   - "Duration" apenas com historico de stage.
   - "Forecast" separado de receita realizada.

## Glossario rapido

- Measure by: metrica agregada no eixo principal, como count, value, weighted
  value, duration.
- View by: dimensao principal de agrupamento, como owner, date, stage, pipeline.
- Segment by: segunda dimensao dentro do grupo, normalmente representada por cor.
- Scorecard: numero unico calculado no escopo filtrado.
- Table view: registros detalhados que compoem o report.
- Summary: agregacao textual/tabular do mesmo universo filtrado.
- Dashboard filter: filtro aplicado na tela, sem alterar a definicao original
  dos reports.

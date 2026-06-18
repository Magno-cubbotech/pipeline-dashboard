import Chart from 'chart.js/auto';
import { createClient } from '@supabase/supabase-js';

// ─── Constantes ───────────────────────────────────────────────────────────────
const PIPE_BASE = 'https://cubbotech.pipedrive.com/deal/';

// ─── Supabase (Auth + leitura dos dados já sincronizados do Pipedrive) ────────
// Os dados não são mais buscados direto da API do Pipedrive pelo navegador — um
// Edge Function agendado (a cada 15min) mantém as tabelas pd_* atualizadas no
// Postgres, e este dashboard só lê de lá. Chave abaixo é a anon key (pública,
// segura no cliente): o acesso de leitura é restrito por RLS a usuários
// autenticados (Supabase Auth), e a escrita usa a service role só no servidor.
const SUPABASE_URL      = 'https://yzsfysodktsdntxehcwb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6c2Z5c29ka3RzZG50eGVoY3diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTk0MzAsImV4cCI6MjA5NzI5NTQzMH0.ZByJp3ORwaROAB7yHoin5wlADvBc7EwyZ0JegbDZ4zU';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Paleta de cores para consultores (expansível)
const COLOR_PALETTE = [
  { dot:'#4ade80', avatar:'rgba(74,222,128,0.15)',  text:'#4ade80' },
  { dot:'#fbbf24', avatar:'rgba(251,191,36,0.15)',  text:'#fbbf24' },
  { dot:'#f87171', avatar:'rgba(248,113,113,0.15)', text:'#f87171' },
  { dot:'#60a5fa', avatar:'rgba(96,165,250,0.15)',  text:'#60a5fa' },
  { dot:'#a78bfa', avatar:'rgba(167,139,250,0.15)', text:'#a78bfa' },
  { dot:'#22d3ee', avatar:'rgba(34,211,238,0.15)',  text:'#22d3ee' },
  { dot:'#fb923c', avatar:'rgba(251,146,60,0.15)',  text:'#fb923c' },
  { dot:'#e879f9', avatar:'rgba(232,121,249,0.15)', text:'#e879f9' },
];

// ─── Estado global ─────────────────────────────────────────────────────────────
let DEALS         = [];
let ACTIVITIES    = [];  // atividades de apresentação + no-show (REAGENDAR), via /activities
let STAGES        = {};   // { stage_id: 'Nome da Etapa' }
let CLOSERS       = [];   // nomes únicos dos consultores ATIVOS no Pipedrive (sem papéis especiais)
let INACTIVE_CLOSER_NAMES = []; // donos de negócio que não estão mais ativos no Pipedrive (ex-consultores) — continuam aparecendo nos relatórios e nas tabelas, só não contam como "ativos"
let SPECIAL_NAMES = [];   // closers/criadores que são papel especial (Felipe, Juliana) e aparecem nos dados
let OUTREACH      = [];   // atividades de abordagem (whatsapp/ligações/e-mail), via /activities — período regido por marked_as_done_time
let OUTREACH_FROM = null; // limite inferior do período de abordagens exibido (marked_as_done_time)
let OUTREACH_TO   = null; // limite superior do período de abordagens exibido (marked_as_done_time)
let MEETINGS      = [];   // atividades do tipo "Reunião Comercial" (slug 'meeting', doc. Pipedrive seção 16.2) — agendamento que precede o outcome d1/apresentado_com_decisor/nfc_e__nf_e. Vem do mesmo fetch de ACTIVITIES, sem chamada extra à API.
let ACTIVE_USER_NAMES = new Set(); // nomes de usuários com active_flag=true no Pipedrive (fonte da verdade p/ ativo/inativo)
let CLOSER_COLORS = {};   // { nome: { dot, avatar, text } }
let TODAY         = new Date();

// PROSPECTOR (enum) — dicionário oficial de opções (campo 084a8764...)
const PROSPECTOR_OPTS = {
  725:'Bruna', 730:'Cavalcanti', 731:'Cleiton', 510:'Edson Lima', 729:'Dayane Maria',
  737:'EPAGOS', 719:'Felipe', 643:'Flávio Henrique', 775:'Gabrielly Oliveira',
  736:'Juliana Santiago', 646:'Kimbelly', 772:'Leandro Pereira', 781:'Lucas Alberto',
  771:'Lucas Emerson', 601:'Marcelo Silva', 658:'Maria Vitória', 645:'Sávio Coriolano', 727:'Wivian Souza',
};
function prospectorName(v) {
  if (!v) return null;
  return PROSPECTOR_OPTS[Number(v)] || String(v);
}

// Canal de origem (campo nativo enum 'channel') — dicionário oficial
const CHANNEL_OPTS = {
  650:'Campanha 3c', 757:'DRIVA Qualificado (QPA)', 765:'DRIVA Não Qualificado (NQPA)',
  654:'Eventos', 651:'Indicação Consultor', 745:'Indicação SDR', 749:'Indicação CS Anderson',
  750:'Indicação CS Esh', 751:'Indicação CS Dayane', 752:'Indicação CS Silvia',
  647:'Lead Cubbotech', 753:'Lead Sittax a Tratar', 648:'Lead Sittax Tratado',
  766:'Lista perdidos', 649:'Outbound Ligação Manual', 653:'PAP',
  656:'Quem mandou deixar parado', 652:'Reativação Comercial', 655:'Whatsapp',
  760:'Whatsapp (Campanha Driva)',
};
function channelName(v) {
  if (!v) return null;
  return CHANNEL_OPTS[Number(v)] || String(v);
}

// Papéis especiais: não competem como closer/SDR padrão (regra de ouro do briefing)
const SPECIAL_ROLES = {
  'felipe gomes':     'Gestor Comercial',
  'felipe':           'Gestor Comercial',
  'juliana santiago': 'Líder SDR',
  'juliana':          'Líder SDR',
};
function specialRole(name) {
  if (!name) return null;
  return SPECIAL_ROLES[name.toLowerCase().trim()] || null;
}

// Etiquetas de ciclo de vida (label_ids) — dicionário oficial
const LABELS = {
  185:'INATIVO', 419:'Suspenso', 261:'SUSPENSO POR REAJUSTE', 262:'SUSPENSO PARA REATIVAÇÃO',
  189:'IMPLANTAÇÃO', 145:'Ativo', 187:'CANCELAMENTO', 188:'CANCELADO',
  455:'CANC. DIF. contato (reativável)', 520:'CANC. inadimplência +60d',
  546:'Não houve pagto. entrada', 626:'BASE SIEG', 773:'Cons. DRIVA',
};
function labelBadge(ids) {
  if (!ids || !ids.length) return '<span class="badge badge-gray">—</span>';
  return ids.map(id => {
    const txt = LABELS[id] || id;
    const isCancel = [187,188,520].includes(Number(id));
    const isSusp   = [419,261,262,546].includes(Number(id));
    const cls = isCancel ? 'badge-red' : isSusp ? 'badge-amber' : (Number(id)===145 ? 'badge-green' : 'badge-gray');
    return `<span class="badge ${cls}">${txt}</span>`;
  }).join(' ');
}
function hasCancelLabel(d) {
  return (d.label_ids||[]).some(id => [187,188,520].includes(Number(id)));
}

// Qualificação / Gravação
const QUALI = { 732:'Com perfil', 733:'Sem perfil' };
const GRAV  = { 627:'Sim', 628:'Não', 632:'Não apresentado', 641:'Incompleto', 629:'Presencial', 630:'Erro gravação' };
function qualiBadge(v) {
  if (!v) return '<span class="badge badge-gray">—</span>';
  const txt = QUALI[v] || v;
  return `<span class="badge ${Number(v)===732?'badge-green':'badge-amber'}">${txt}</span>`;
}
function gravBadge(v) {
  if (!v) return '<span class="badge badge-gray">Não auditado</span>';
  const txt = GRAV[v] || v;
  return `<span class="badge ${Number(v)===627?'badge-green':'badge-red'}">${txt}</span>`;
}

let activeCloser = 'todos';
let onlyVenc     = false;
let searchTerm   = '';
let statusFilter = 'all';   // 'open' | 'won' | 'lost' | 'all'
let funilFilter  = 'todos';  // 'todos' | 'SITTAX' | 'RECUPERA' | 'SITTAX ST'
let dateFrom     = null;
let dateTo       = null;

// ─── Relatórios personalizados — estado e identidade do usuário logado ────────
let CURRENT_USER = { id: null, email: null };

// ─── Sessão (Supabase Auth) ────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-overlay').classList.add('open');
}
function showApp(session) {
  document.getElementById('login-overlay').classList.remove('open');
  const userEl = document.getElementById('sidebar-user');
  if (userEl) userEl.textContent = session?.user?.email || '—';
  CURRENT_USER.id    = session?.user?.id || null;
  CURRENT_USER.email = session?.user?.email || null;
}

// ─── Estado de UI da sidebar (localStorage) ────────────────────────────────────
// Lembra entre sessões: sidebar oculta/visível + quais grupos retráteis estão
// abertos. Puramente visual — nunca afeta quais negócios são buscados/exibidos.
const UI_STATE_KEY = 'pd_dashboard_ui_state_v1';
function loadUIState() {
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY)) || {}; } catch (e) { return {}; }
}
function saveUIState() { localStorage.setItem(UI_STATE_KEY, JSON.stringify(UI_STATE)); }
let UI_STATE = loadUIState();
if (typeof UI_STATE.sidebarHidden !== 'boolean') UI_STATE.sidebarHidden = false;
if (!UI_STATE.groups) UI_STATE.groups = {};
['empty', 'special', 'inactive'].forEach(g => { if (typeof UI_STATE.groups[g] !== 'boolean') UI_STATE.groups[g] = false; });

// Mostrar/ocultar a sidebar inteira (botão no topo da sidebar + botão flutuante quando oculta)
function toggleSidebar() {
  UI_STATE.sidebarHidden = !UI_STATE.sidebarHidden;
  document.body.classList.toggle('sidebar-hidden', UI_STATE.sidebarHidden);
  saveUIState();
}

// Grupos retráteis genéricos: 'empty' (sem negócios no filtro), 'special' (papéis
// especiais), 'inactive' (ex-consultores). IDs de toggle/corpo seguem o padrão
// "<nome>-toggle" / "nav-<nome>", exceto 'empty' que usa os IDs legados já
// existentes (empty-toggle / nav-closers-empty) para não duplicar markup.
const NAV_GROUP_IDS = {
  empty:    { toggle: 'empty-toggle',    body: 'nav-closers-empty' },
  special:  { toggle: 'special-toggle',  body: 'nav-special' },
  inactive: { toggle: 'inactive-toggle', body: 'nav-inactive' },
};
function applyNavGroupState(name) {
  const ids  = NAV_GROUP_IDS[name];
  const open = !!UI_STATE.groups[name];
  if (!ids) return;
  document.getElementById(ids.toggle)?.classList.toggle('open', open);
  document.getElementById(ids.body)?.classList.toggle('open', open);
}
function toggleNavGroup(name) {
  UI_STATE.groups[name] = !UI_STATE.groups[name];
  applyNavGroupState(name);
  saveUIState();
}

// ─── Login / logout (Supabase Auth) ────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('btn-login');
  const errEl    = document.getElementById('login-error');

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Entrar';

  if (error) {
    errEl.textContent = 'E-mail ou senha inválidos.';
    return;
  }
  showApp(data.session);
  loadData();
}

async function handleLogout() {
  await sb.auth.signOut();
  DEALS = []; ACTIVITIES = []; OUTREACH = []; MEETINGS = [];
  CURRENT_USER = { id: null, email: null };
  REPORTS = [];
  applyDefaultDatePreset(); // próxima sessão começa limpa, no mês vigente
  showDashboardPage();
  showState('empty');
  showLogin();
}

// ─── Fetch helpers (lendo do Supabase, já sincronizado do Pipedrive) ──────────
// Busca paginada genérica — o PostgREST limita a 1000 linhas por requisição
// por padrão, então varremos em páginas até a tabela se esgotar.
async function fetchAllRows(table, columns) {
  let rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(`Erro ao ler ${table}: ${error.message}`);
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAllDeals() {
  const rows = await fetchAllRows('pd_deals', 'raw');
  return rows.map(r => r.raw);
}

async function fetchStages() {
  const rows = await fetchAllRows('pd_stages', 'id,name');
  const map = {};
  rows.forEach(s => { map[s.id] = s.name; });
  return map;
}

async function fetchPipelines() {
  const rows = await fetchAllRows('pd_pipelines', 'id,name');
  const map = {};
  rows.forEach(p => { map[p.id] = p.name; });
  return map;
}

// ─── Buscar TODOS os usuários (ativos + inativos) ─────────────────────────────
// Retorna a lista completa; quem chama decide o que filtrar. Isso permite
// reconhecer negócios de ex-consultores (inativos) sem precisar incluí-los na
// busca de atividades (que continua restrita aos ativos — ver loadData).
async function fetchUsers() {
  return fetchAllRows('pd_users', 'id,name,active_flag');
}

// ─── Atividades de apresentação (com/sem decisor + não apresentado) ──────────
const PRESENT_TYPES = ['d1', 'apresentado_com_decisor', 'nfc_e__nf_e'];

// ─── Atividades (todos os tipos, todos os usuários) ───────────────────────────
// O sync no Supabase já guarda as atividades de TODOS os usuários (ativos e
// inativos), então buscamos a tabela inteira de uma vez e filtramos no cliente
// (por usuário ativo e, quando aplicável, por período) — mesma lógica de
// antes, só que sem precisar varrer a API do Pipedrive usuário a usuário.
async function fetchActivitiesRaw() {
  const rows = await fetchAllRows('pd_activities', 'raw');
  return rows.map(r => r.raw);
}

// Horário da última sincronização bem-sucedida (Edge Function agendada a
// cada 15 min) — usado no rodapé/timestamp em vez do horário de carregamento
// da página, já que os dados vêm do Supabase e não de uma busca em tempo real.
async function fetchLastSyncInfo() {
  const { data, error } = await sb
    .from('sync_runs')
    .select('finished_at')
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0].finished_at;
}

function mapActivity(a, userMap) {
  const closerId = typeof a.user_id === 'object' ? a.user_id?.value : a.user_id;
  const sdrId     = typeof a.created_by_user_id === 'object' ? a.created_by_user_id?.value : a.created_by_user_id;
  return {
    id:          a.id,
    deal_id:     a.deal_id || null,
    type:        a.type, // d1 | apresentado_com_decisor | nfc_e__nf_e
    type_label:  a.type === 'd1' ? 'Apresentado com decisor'
               : a.type === 'apresentado_com_decisor' ? 'Apresentado sem decisor'
               : 'Não apresentado',
    closer:      userMap[closerId] || null, // quem apresentou (user_id)
    sdr:         userMap[sdrId]    || null, // quem agendou (created_by_user_id)
    due_date:    a.due_date || null,
    done:        !!a.done,
  };
}

// ─── Atividade "Reunião Comercial" (slug 'meeting', doc. Pipedrive seção 16.2) ──
// É o agendamento que precede o outcome (d1/apresentado_com_decisor/nfc_e__nf_e).
// Usada para achar reuniões VENCIDAS: agendadas com due_date já passado e que
// nunca foram marcadas como concluídas (sem outcome registrado) — cruzamento
// pedido pelo gestor na tabela de Conclusão de Atividades por Consultor.
const MEETING_TYPE = 'meeting';

function mapMeetingActivity(a, userMap) {
  const closerId = typeof a.user_id === 'object' ? a.user_id?.value : a.user_id;
  return {
    id:       a.id,
    deal_id:  a.deal_id || null,
    closer:   userMap[closerId] || null, // quem é o responsável pela reunião agendada
    due_date: a.due_date || null,
    done:     !!a.done,
  };
}

// ─── Atividades de abordagem (Whatsapp, Ligação efetiva/não efetiva, E-mail) ──
// Volume real ~100x maior que as de apresentação (confirmado em amostra de uma
// semana: 2541 abordagens vs. ~100/mês de apresentações).
//
// Período regido por marked_as_done_time (quando a atividade foi de fato
// concluída) — mesmo critério usado no relatório nativo do Pipedrive ("Marcado
// como feito em"), para que os totais batam com esse relatório. A API do
// Pipedrive só filtra start_date/end_date por due_date, então não dá pra cortar
// por marked_as_done_time direto no servidor: a busca de abordagens é feita SEM
// corte de data (todo o histórico das atividades desses 4 tipos, para os
// usuários ativos) e o filtro de período é aplicado no cliente, comparando
// marked_as_done_time com o período selecionado (ver inOutreachDateRange).
// Decisão tomada com o gestor: prioriza bater com o relatório nativo, com o
// custo de uma busca mais pesada.
const OUTREACH_TYPES   = ['whatsapp', 'ligacao_efetiva', 'ligacao_nao_efetiva', 'e_mail'];

const OUTREACH_TYPE_LABELS = {
  whatsapp:             'Whatsapp',
  ligacao_efetiva:      'Ligação efetiva',
  ligacao_nao_efetiva:  'Ligação não efetiva',
  e_mail:               'E-mail',
};

// EPAGOS realiza abordagens e criação de negócios usando o login do Felipe no
// Pipedrive (o gestor não executa esse processo pessoalmente) — por isso essas
// atividades são atribuídas a "EPAGOS" em vez de "Felipe" nos painéis de
// Abordagens. Isso também as classifica automaticamente como prospector
// (EPAGOS não está em OUTREACH_CLOSER_NAMES) e alinha com o campo Prospector
// já existente nos negócios (PROSPECTOR_OPTS já tem "EPAGOS" como opção
// distinta de "Felipe").
const OUTREACH_OWNER_ALIASES = { 'Felipe': 'EPAGOS' };

function mapOutreachActivity(a, userMap) {
  const ownerId   = typeof a.user_id === 'object' ? a.user_id?.value : a.user_id;
  const creatorId = typeof a.created_by_user_id === 'object' ? a.created_by_user_id?.value : a.created_by_user_id;
  const rawOwner  = userMap[ownerId] || null;
  return {
    id:        a.id,
    deal_id:   a.deal_id || null,
    type:      a.type, // whatsapp | ligacao_efetiva | ligacao_nao_efetiva | e_mail
    type_label: OUTREACH_TYPE_LABELS[a.type] || a.type,
    owner:     OUTREACH_OWNER_ALIASES[rawOwner] || rawOwner, // quem realizou a abordagem (user_id) — EPAGOS usa o login do Felipe
    creator:   userMap[creatorId] || null, // quem registrou a atividade (created_by_user_id)
    due_date:  a.due_date || null,
    done:      !!a.done,
    marked_as_done_time: a.marked_as_done_time ? a.marked_as_done_time.slice(0, 10) : null,
  };
}

// ─── Normalizar nome do funil ──────────────────────────────────────────────────
function normFunil(pipelineName) {
  const u = pipelineName.toUpperCase();
  if (u.includes('SITTAX') && (u.includes(' ST') || u.endsWith('ST'))) return 'SITTAX ST';
  if (u.includes('SITTAX'))   return 'SITTAX';
  if (u.includes('RECUPERA')) return 'RECUPERA';
  return pipelineName; // mantém o nome original se não bater
}

// ─── Mapear deal da API → formato interno ─────────────────────────────────────
function mapDeal(d, pipelines) {
  const pName  = pipelines[d.pipeline_id] || `Pipeline ${d.pipeline_id}`;
  const funil  = normFunil(pName);
  const addStr = d.add_time ? d.add_time.slice(0, 10) : null;

  return {
    id:       d.id,
    name:     d.title,
    funil,
    closer:   d.user_id?.name          || 'Sem consultor',
    creator:  d.creator_user_id?.name  || '—',
    add:      addStr,
    ec:       d.expected_close_date    || null,
    last_act: d.last_activity_date     || null,
    acts:     d.activities_count       || 0,
    stage:    d.stage_id,
    status:   d.status                 || 'open', // 'open' | 'won' | 'lost'
    won_time:  d.won_time  ? d.won_time.slice(0,10)  : null,
    lost_time: d.lost_time ? d.lost_time.slice(0,10) : null,
    value:    Number(d.value) || 0,
    currency: d.currency || 'BRL',
    mrr:          Number(d['15fe9ebc552f1016ec24edf3b16df5f6cd2a4364']) || 0, // VALOR MENSALIDADE INICIAL
    mrr_atual:    Number(d['eef9fbac9bbcd2a7368144522306bca170fa4ed5']) || 0, // VALOR MENSALIDADE ATUAL
    implantacao:  Number(d['605d01681634ea74ca6f87cf2d0c3642a0a9c3cb']) || 0, // VALOR IMPLANTAÇÃO
    lost_reason:  d.lost_reason || null,                                      // motivo nativo da perda
    label_ids:    Array.isArray(d.label_ids) ? d.label_ids : (d.label ? [d.label] : []), // ciclo de vida (185 INATIVO,189 IMPLANTAÇÃO,145 ATIVO,188 CANCELADO...)
    prospector:   prospectorName(d['084a876496a003901cc17439fcc1dc671069ac94']), // enum PROSPECTOR resolvido para nome
    channel:      channelName(d['channel']),                                  // Canal de origem (enum nativo)
    qualificacao: d['cb1427cdc2f52d3fce1ceb9f1a126244f370475c'] || null,       // 732 Com perfil / 733 Sem perfil
    gravacao:     d['67cb51cd760d6237184cd9121d55d6300a8d5f67'] || null,       // 627 Sim / 628 Não
    is_special:   false, // marcado depois (Felipe Gomes / Juliana Santiago)
  };
}

// ─── Carregar dados ────────────────────────────────────────────────────────────
async function loadData() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    showState('empty');
    showLogin();
    return;
  }

  showState('loading');
  setRefreshLoading(true);
  setMsg('Buscando pipelines e etapas…');
  TODAY = new Date(); // atualiza data de referência a cada load

  try {
    // Pipelines, etapas, usuários e negócios não dependem uns dos outros para
    // SEREM LIDOS (só para serem mapeados depois) — disparar tudo em paralelo
    // reduz o tempo total de carregamento em vez de esperar cada um por vez.
    // Tudo já está sincronizado no Supabase (Edge Function agendado a cada
    // 15min) — não há mais chamada direta à API do Pipedrive pelo navegador.
    setMsg('Lendo pipelines, etapas, usuários e negócios…');
    const [pipelines, stages, allUsers, rawDeals] = await Promise.all([
      fetchPipelines(),
      fetchStages(),
      fetchUsers(),
      fetchAllDeals(),
    ]);
    STAGES = stages;

    // Ativos vs inativos no Pipedrive — fonte da verdade: active_flag.
    const activeUsers = allUsers.filter(u => u.active_flag);
    ACTIVE_USER_NAMES = new Set(activeUsers.map(u => u.name));
    const userMap = {};
    allUsers.forEach(u => { userMap[u.id] = u.name; }); // mapa completo (ativos+inativos) p/ rotular atividades antigas

    // Mapear e filtrar (excluir negócios onde o CLOSER é Felipe)
    // Ajuste a lista abaixo se precisar excluir outros closers
    const EXCLUIR_CLOSER = []; // ex: ['Felipe'] — deixe vazio para mostrar todos
    DEALS = rawDeals
      .map(d => mapDeal(d, pipelines))
      .filter(d => !EXCLUIR_CLOSER.some(n =>
        d.closer.toLowerCase().includes(n.toLowerCase())
      ));

    // Marcar papéis especiais (Felipe Gomes / Juliana Santiago) — não competem como closer/SDR padrão
    DEALS.forEach(d => {
      d.is_special = !!(specialRole(d.closer) || specialRole(d.creator));
    });

    // Consultores com negócios, separados por status real no Pipedrive (ativo/inativo).
    // IMPORTANTE: nenhum negócio é descartado por isso — só muda em qual lista o
    // nome do dono aparece e se ganha o marcador "Inativo". Negócios cancelados,
    // ganhos ou perdidos de ex-consultores continuam aparecendo nos relatórios
    // (ver closersToShow em renderAll).
    const regularSet   = new Set(DEALS.filter(d => !specialRole(d.closer)).map(d => d.closer));
    const regularNames = Array.from(regularSet).sort();
    CLOSERS = regularNames.filter(c => ACTIVE_USER_NAMES.has(c));
    INACTIVE_CLOSER_NAMES = regularNames.filter(c => !ACTIVE_USER_NAMES.has(c));

    const specialSet = new Set(DEALS.filter(d => specialRole(d.closer)).map(d => d.closer));
    SPECIAL_NAMES = Array.from(specialSet).sort();

    // Atribuir cores
    CLOSER_COLORS = {};
    [...CLOSERS, ...INACTIVE_CLOSER_NAMES, ...SPECIAL_NAMES].forEach((c, i) => {
      CLOSER_COLORS[c] = COLOR_PALETTE[i % COLOR_PALETTE.length];
    });

    // ─── Atividades de apresentação (com/sem decisor + não apresentado) ────────
    // Necessário para "apresentados reais" e cruzamento com no-show por prospector.
    // Restrito aos usuários ATIVOS (regra de ouro do briefing) — mesmo recorte
    // de antes, só que agora aplicado no cliente em vez de via parâmetro da API,
    // já que a tabela pd_activities traz todos os usuários (ver fetchActivitiesRaw).
    //
    // Corte de período: dateFrom/dateTo (quando preenchidos) filtram por
    // due_date, replicando o que antes era feito via start_date/end_date da API.
    // Os negócios NÃO são cortados por data nessa etapa — decisão tomada com o
    // usuário, já que o campo de data relevante varia com o status
    // (criação/ganho/perda) e um corte aqui arriscaria esconder negócio.
    // O filtro pós-carregamento por status+data nos negócios continua existindo
    // exatamente como antes (ver inDateRange/dateFieldFor).
    setMsg('Lendo atividades…');
    const allRawActivities = await fetchActivitiesRaw();
    const activeUserIds    = new Set(activeUsers.map(u => u.id));
    const ownerIdOf        = a => (typeof a.user_id === 'object' ? a.user_id?.value : a.user_id);
    const activeRawActivities = allRawActivities.filter(a => activeUserIds.has(ownerIdOf(a)));
    const rawActivities = activeRawActivities.filter(a => {
      if (dateFrom && (!a.due_date || a.due_date < dateFrom)) return false;
      if (dateTo   && (!a.due_date || a.due_date > dateTo))   return false;
      return true;
    });

    ACTIVITIES = rawActivities.filter(a => PRESENT_TYPES.includes(a.type)).map(a => mapActivity(a, userMap));
    // Reunião Comercial (meeting) vem do mesmo conjunto acima — sem nova
    // consulta — e segue o mesmo corte de período (dateFrom/dateTo ou "todo o
    // histórico" se vazio). Usada para achar reuniões vencidas (ver completionByCloser).
    MEETINGS = rawActivities.filter(a => a.type === MEETING_TYPE).map(a => mapMeetingActivity(a, userMap));

    // ─── Atividades de abordagem (Whatsapp/Ligações/E-mail) ──────────────────
    // Sem corte de período aqui (ver nota em OUTREACH_TYPES) — o período da
    // tela (ou mês atual como padrão) é aplicado depois, no cliente, por
    // marked_as_done_time.
    const todayISO     = new Date().toISOString().slice(0, 10);
    const monthStartISO = todayISO.slice(0, 8) + '01';
    OUTREACH_FROM = dateFrom || monthStartISO;
    OUTREACH_TO   = dateTo   || todayISO;

    const rawOutreach = activeRawActivities.filter(a => OUTREACH_TYPES.includes(a.type));
    OUTREACH = rawOutreach.map(a => mapOutreachActivity(a, userMap)).filter(a => a.done);

    // Reconstruir nav
    buildNav();
    rebuildNavCounts();

    // KPIs
    updateKPIs();

    // Timestamp: hora da última sincronização bem-sucedida no Supabase (não a
    // hora de carregamento da página, já que os dados não são buscados em
    // tempo real — ver fetchLastSyncInfo).
    const lastSync = await fetchLastSyncInfo();
    const ts = new Date(lastSync || Date.now()).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    document.getElementById('last-update').textContent = ts;
    document.getElementById('footer-ts').textContent   = ts;
    document.getElementById('page-meta').textContent   = lastSync
      ? `Fonte: Supabase (sincronizado a cada 15 min) · todos os status · ${DEALS.length} negócios carregados · última sincronização ${ts}`
      : `Fonte: Supabase · todos os status · ${DEALS.length} negócios carregados · sincronização ainda não realizada`;

    showState('data');
    renderAll();
    setConnDot('ok');

  } catch (err) {
    document.getElementById('error-detail').textContent =
      err.message || 'Erro desconhecido. Tente novamente ou contate o administrador.';
    showState('error');
    setConnDot('err');
  } finally {
    setRefreshLoading(false);
  }
}

function setConnDot(state) {
  const dot = document.getElementById('conn-dot');
  if (!dot) return;
  dot.classList.remove('ok','err');
  if (state === 'ok') dot.classList.add('ok');
  if (state === 'err') dot.classList.add('err');
}

// ─── UI states ────────────────────────────────────────────────────────────────
function showState(s) {
  document.getElementById('state-loading').classList.toggle('visible', s === 'loading');
  document.getElementById('state-error').classList.toggle('visible',   s === 'error');
  document.getElementById('state-empty').classList.toggle('visible',   s === 'empty');
  if (s === 'data') {
    document.getElementById('state-loading').classList.remove('visible');
    document.getElementById('state-error').classList.remove('visible');
    document.getElementById('state-empty').classList.remove('visible');
  }
}
function setMsg(m) { document.getElementById('loading-msg').textContent = m; }
function setRefreshLoading(on) {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = on;
  btn.classList.toggle('loading', on);
  btn.innerHTML = on
    ? '<span class="ic-refresh">↻</span> Carregando…'
    : '<span class="ic-refresh">↻</span> Atualizar';
}

// ─── Construir nav lateral dinamicamente ──────────────────────────────────────
function buildNav() {
  const container      = document.getElementById('nav-closers');
  const emptyContainer = document.getElementById('nav-closers-empty');
  const specialSection = document.getElementById('nav-special-section');
  const specialContainer = document.getElementById('nav-special');
  const inactiveSection   = document.getElementById('nav-inactive-section');
  const inactiveContainer = document.getElementById('nav-inactive');

  let html = `<button class="nav-item active" onclick="navTo('todos',this)">
    <span class="nav-dot" style="background:#6366f1"></span>Todos
    <span class="nav-count" id="nav-count-todos">${DEALS.length}</span>
  </button>`;

  let withDeals = '';
  let empty     = '';

  CLOSERS.forEach(c => {
    const colors   = CLOSER_COLORS[c] || COLOR_PALETTE[0];
    const safeid   = 'nc-' + c.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    const initials = c.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const count    = DEALS.filter(d=>d.closer===c).length;
    const item = `<button class="nav-item${count===0?' dim':''}" onclick="navTo('${c.replace(/'/g,"\\'")}',this)">
      <span class="nav-dot" style="background:${colors.dot}"></span>${c}
      <span class="nav-count" id="${safeid}">${count}</span>
    </button>`;
    if (count > 0) withDeals += item; else empty += item;
  });

  container.innerHTML = html + withDeals;
  container.querySelector('.nav-item')?.classList.add('active');

  emptyContainer.innerHTML = empty;
  const nEmpty = CLOSERS.filter(c => DEALS.filter(d=>d.closer===c).length === 0).length;
  document.getElementById('empty-toggle-label').textContent = `Sem negócios no filtro (${nEmpty})`;
  document.getElementById('empty-toggle').style.display = nEmpty > 0 ? '' : 'none';

  // Papéis especiais
  if (SPECIAL_NAMES.length > 0) {
    specialSection.style.display = '';
    specialContainer.innerHTML = SPECIAL_NAMES.map(c => {
      const colors   = CLOSER_COLORS[c] || COLOR_PALETTE[0];
      const safeid   = 'nc-' + c.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
      const role     = specialRole(c) || '';
      const count    = DEALS.filter(d=>d.closer===c).length;
      return `<button class="nav-item${count===0?' dim':''}" onclick="navTo('${c.replace(/'/g,"\\'")}',this)">
        <span class="nav-dot" style="background:${colors.dot}"></span>${c}<span class="role-tag">${role}</span>
        <span class="nav-count" id="${safeid}">${count}</span>
      </button>`;
    }).join('');
  } else {
    specialSection.style.display = 'none';
  }

  // Inativos / ex-consultores: continuam navegáveis, só com marcador visual —
  // nenhum negócio deles é removido da navegação ou dos relatórios.
  if (INACTIVE_CLOSER_NAMES.length > 0) {
    inactiveSection.style.display = '';
    inactiveContainer.innerHTML = INACTIVE_CLOSER_NAMES.map(c => {
      const colors = CLOSER_COLORS[c] || COLOR_PALETTE[0];
      const safeid = 'nc-' + c.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
      const count  = DEALS.filter(d => d.closer===c).length;
      return `<button class="nav-item${count===0?' dim':''}" onclick="navTo('${c.replace(/'/g,"\\'")}',this)">
        <span class="nav-dot" style="background:${colors.dot}"></span>${c}<span class="inactive-tag">Inativo</span>
        <span class="nav-count" id="${safeid}">${count}</span>
      </button>`;
    }).join('');
  } else {
    inactiveSection.style.display = 'none';
  }
}

function toggleEmptyGroup() {
  // Delega para o mecanismo unificado de grupos retráteis (persiste em localStorage)
  toggleNavGroup('empty');
}

// ─── KPIs ────────────────────────────────────────────────────────────────────
function updateKPIs() {
  const scoped   = (statusFilter==='all' ? DEALS : DEALS.filter(d=>d.status===statusFilter))
                     .filter(d => funilFilter==='todos' || d.funil===funilFilter)
                     .filter(inDateRange);
  const vencidos = scoped.filter(isOverdue);
  const semData  = scoped.filter(d => !d.ec);
  const clientes = new Set(scoped.map(d => d.name.toLowerCase())).size;
  document.getElementById('k-total').textContent    = scoped.length;
  document.getElementById('k-venc').textContent     = vencidos.length;
  document.getElementById('k-semdata').textContent  = semData.length;
  document.getElementById('k-clientes').textContent = clientes;
  document.getElementById('nav-count-venc') && (document.getElementById('nav-count-venc').textContent = vencidos.length);

  // Quando "Todos" está selecionado, detalha o Total geral em abertos/ganhos/perdidos.
  const totalBreakdown = document.getElementById('k-total-breakdown');
  if (statusFilter === 'all') {
    const nOpen = scoped.filter(d => d.status === 'open').length;
    const nWon  = scoped.filter(d => d.status === 'won').length;
    const nLost = scoped.filter(d => d.status === 'lost').length;
    totalBreakdown.innerHTML = `<b class="open">${nOpen} abertos</b> · <b class="won">${nWon} ganhos</b> · <b class="lost">${nLost} perdidos</b>`;
    totalBreakdown.style.display = '';
  } else {
    totalBreakdown.style.display = 'none';
  }

  // ─── KPIs consolidados de valor (ganho/perda) ──────────────────────────────
  // Inclui papéis especiais (Felipe Gomes / Juliana Santiago): o que eles
  // geram conta para o resultado da equipe. Eles só não competem no
  // RANQUEAMENTO numerado (1º, 2º, 3º) — para isso, ficam sempre no final da
  // tabela, marcados como papel especial.
  const baseFiltered = DEALS
    .filter(d => funilFilter==='todos' || d.funil===funilFilter)
    .filter(inDateRange);

  const ganhos   = baseFiltered.filter(d => d.status === 'won');
  const perdidos = baseFiltered.filter(d => d.status === 'lost');

  const mrrTotal      = ganhos.reduce((s,d) => s + d.mrr, 0);
  const implantTotal  = ganhos.reduce((s,d) => s + d.implantacao, 0);
  const valorPerdido  = perdidos.reduce((s,d) => s + d.value, 0);
  // "Valor total ganho" = MRR - Valor perdido (a pedido do usuário).
  const valorGanho    = mrrTotal - valorPerdido;

  document.getElementById('k-mrr').textContent          = fmtCurrency(mrrTotal);
  document.getElementById('k-implant').textContent      = fmtCurrency(implantTotal);
  document.getElementById('k-valor-total').textContent  = fmtCurrency(valorGanho);
  document.getElementById('k-valor-perdido').textContent = fmtCurrency(valorPerdido);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function daysDiff(s) {
  if (!s) return null;
  return Math.floor((TODAY - new Date(s)) / 86400000);
}
function fmt(s) {
  if (!s) return '—';
  const [y,m,d] = s.split('-');
  return `${d}/${m}`;
}
function fmtCurrency(v) {
  return (v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}
function urgHtml(ec) {
  if (!ec) return '<span class="urg-none">sem data</span>';
  const d = daysDiff(ec);
  if (d > 0) return `<span class="urg-overdue">${d}d vencido</span>`;
  if (d === 0) return '<span class="urg-today">HOJE</span>';
  return `<span class="urg-ok">${fmt(ec)}</span>`;
}
function funilBadge(f) {
  const cls = f==='SITTAX'?'badge-sittax':f==='RECUPERA'?'badge-recupera':f==='SITTAX ST'?'badge-st':'badge-gray';
  const short = f==='SITTAX ST'?'ST':f;
  return `<span class="badge ${cls}">${short}</span>`;
}
function stageBadge(s) {
  return `<span class="badge badge-gray">${STAGES[s] || s}</span>`;
}
function isDup(d) {
  return DEALS.filter(x => x.name.toLowerCase() === d.name.toLowerCase()).length > 1;
}
function isOverdue(d) {
  return d.status === 'open' && d.ec && daysDiff(d.ec) > 0;
}

// ─── Apresentados reais via /activities, vinculados ao escopo de negócios filtrado ──
// CRÍTICO: sem o filtro por validDealIds, esta função contava contra TODO o
// histórico de ACTIVITIES carregado (ex: 17 mil negócios), produzindo números
// como "Apresentados: 1326" para um closer com 27 negócios criados no mês —
// totalmente descolado da coluna Ganho/Perdido/Aberto ao lado. A correção
// vincula cada atividade ao deal_id do conjunto JÁ FILTRADO pela tela (status +
// funil + data), garantindo que Apresentados sempre fale dos MESMOS negócios
// das outras colunas da mesma linha, qualquer que seja o filtro de status
// (Ganho usa won_time, Perdido usa lost_time, Aberto usa add_time, etc.) —
// não um segundo critério de data concorrente sobre a atividade em si.
function presentedDealIdsByCloser(validDealIds) {
  const map = {}; // { closer: Set(deal_id) }
  ACTIVITIES.forEach(a => {
    if (!a.closer || !a.deal_id) return;
    if (validDealIds && !validDealIds.has(a.deal_id)) return;
    if (a.type === 'd1' || a.type === 'apresentado_com_decisor') { // com decisor / sem decisor
      if (!map[a.closer]) map[a.closer] = new Set();
      map[a.closer].add(a.deal_id);
    }
  });
  return map;
}

// ─── Produtividade de Apresentações por due_date (independente do mês de criação do negócio) ──
// Diferente do ranking de conversão (que filtra negócio por add_time), aqui o
// recorte é pela própria atividade: quanto o time apresentou OPERACIONALMENTE
// no período, incluindo negócios "herdados" de meses anteriores. Conta cada
// atividade (não deduplicada por negócio), pois produtividade é volume de
// trabalho executado, e reapresentações pós no-show também contam.
function inActivityDateRange(a) {
  if (!dateFrom && !dateTo) return true;
  if (!a.due_date) return false;
  if (dateFrom && a.due_date < dateFrom) return false;
  if (dateTo   && a.due_date > dateTo)   return false;
  return true;
}
function activityProductivity() {
  let scope = ACTIVITIES.filter(inActivityDateRange);
  if (funilFilter !== 'todos') {
    // Atividade não tem funil próprio — cruza via deal_id contra DEALS
    const dealFunilById = {};
    DEALS.forEach(d => { dealFunilById[d.id] = d.funil; });
    scope = scope.filter(a => dealFunilById[a.deal_id] === funilFilter);
  }
  const map = {};
  scope.forEach(a => {
    const c = a.closer || 'Sem consultor';
    if (specialRole(c)) return; // papéis especiais não competem como closer padrão
    if (!map[c]) map[c] = { closer:c, comDecisor:0, semDecisor:0, naoApresentado:0, total:0 };
    const r = map[c];
    r.total++;
    if (a.type === 'd1') r.comDecisor++;
    else if (a.type === 'apresentado_com_decisor') r.semDecisor++;
    else r.naoApresentado++;
  });
  return Object.values(map).sort((a,b) => b.total - a.total);
}

// ─── No-show por PROSPECTOR (etapa REAGENDAR, não tipo de atividade) ─────────
// REAGENDAR (NO SHOW) por funil: S=59 · R=64 · ST=69. No-show é etapa, não
// atividade — não existe no /activities, por isso é calculado via stage_id.
// Dias sem atividade para considerar um negócio aberto "parado" (atualização de negócios)
const STALE_DAYS = 14;
const NOSHOW_STAGES = new Set([59,64,69]);
function isNoShow(d) {
  return NOSHOW_STAGES.has(Number(d.stage));
}
function noShowByProspector(deals) {
  const map = {}; // { prospector: { noshow, total } }
  deals.forEach(d => {
    const p = d.prospector || 'Sem prospector';
    if (!map[p]) map[p] = { prospector:p, noshow:0, total:0 };
    map[p].total++;
    if (isNoShow(d)) map[p].noshow++;
  });
  return Object.values(map).map(r => ({ ...r, taxa: r.total>0 ? r.noshow/r.total : 0 }));
}

// ─── Perdas agregadas por motivo (lost_reason) ────────────────────────────────
function lossReasonBreakdown(deals) {
  const perdidos = deals.filter(d => d.status === 'lost');
  const map = {};
  perdidos.forEach(d => {
    const motivo = d.lost_reason || 'Não informado';
    if (!map[motivo]) map[motivo] = { motivo, total:0, valor:0 };
    map[motivo].total++;
    map[motivo].valor += d.value;
  });
  const total = perdidos.length;
  return Object.values(map)
    .map(r => ({ ...r, pct: total>0 ? r.total/total : 0 }))
    .sort((a,b) => b.total - a.total);
}

// ─── Conversão por Prospector/SDR (origem do lead) ────────────────────────────
// Cruza canal de origem + qualificação para apontar se o gargalo é geração de
// lead (canal/SDR) ou execução comercial (closer) — perguntas distintas.
function prospectorRanking(deals) {
  // Cruzar atividades reais de "Apresentado com decisor" por prospector
  // (created_by_user_id da atividade = SDR/prospector que agendou)
  const validDealIds = new Set(deals.map(d => d.id));
  const dealById = {};
  deals.forEach(d => { dealById[d.id] = d; });

  // Conta atividades "Apresentado com decisor" (tipo d1) e "Apresentado sem
  // decisor" (tipo apresentado_com_decisor — nome do tipo no Pipedrive não
  // reflete o uso atual, ver type_label em mapActivity) por prospector,
  // restringindo aos negócios do escopo filtrado
  const apresComDecisorByProspector = {};
  const apresSemDecisorByProspector = {};
  ACTIVITIES.forEach(a => {
    if (a.type !== 'd1' && a.type !== 'apresentado_com_decisor') return;
    if (!validDealIds.has(a.deal_id)) return;
    const deal = dealById[a.deal_id];
    const p = deal?.prospector || 'Sem prospector';
    if (a.type === 'd1') {
      if (!apresComDecisorByProspector[p]) apresComDecisorByProspector[p] = new Set();
      apresComDecisorByProspector[p].add(a.id); // atividade única (volume real)
    } else {
      if (!apresSemDecisorByProspector[p]) apresSemDecisorByProspector[p] = new Set();
      apresSemDecisorByProspector[p].add(a.id);
    }
  });

  const map = {};
  deals.forEach(d => {
    const p = d.prospector || 'Sem prospector';
    if (!map[p]) map[p] = { prospector:p, criados:0, ganho:0, perdido:0, aberto:0, comPerfil:0, semPerfil:0, naoQualificado:0, apresComDecisor:0, apresSemDecisor:0, mrr:0, is_special: !!specialRole(p) };
    const r = map[p];
    r.criados++;
    if (d.status === 'won') { r.ganho++; r.mrr += d.mrr; }
    else if (d.status === 'lost') r.perdido++;
    else r.aberto++;
    if (Number(d.qualificacao) === 732) r.comPerfil++;
    else if (Number(d.qualificacao) === 733) r.semPerfil++;
    else r.naoQualificado++;
  });
  // Aplica contagem de apresentações com e sem decisor
  Object.values(map).forEach(r => {
    r.apresComDecisor = apresComDecisorByProspector[r.prospector]?.size || 0;
    r.apresSemDecisor = apresSemDecisorByProspector[r.prospector]?.size || 0;
  });
  return Object.values(map).map(r => ({
    ...r,
    conversao: r.criados > 0 ? r.ganho / r.criados : 0,
  }));
}

// ─── Conversão por Canal de Origem ────────────────────────────────────────────
function channelBreakdown(deals) {
  const map = {};
  deals.forEach(d => {
    const c = d.channel || 'Não informado';
    if (!map[c]) map[c] = { channel:c, criados:0, ganho:0, perdido:0, aberto:0 };
    const r = map[c];
    r.criados++;
    if (d.status === 'won') r.ganho++;
    else if (d.status === 'lost') r.perdido++;
    else r.aberto++;
  });
  return Object.values(map).map(r => ({
    ...r,
    conversao: r.criados > 0 ? r.ganho / r.criados : 0,
  })).sort((a,b) => b.criados - a.criados);
}

// ─── Abordagens (Whatsapp/Ligação/E-mail) por pessoa ─────────────────────────
// Cobre TODA abordagem do período, com ou sem negócio vinculado — na amostra
// analisada, só ~5% das abordagens têm deal_id (a maioria é prospecção
// "pré-negócio"). Por isso o cruzamento com negócios não é por join de
// deal_id, e sim por RAZÃO: abordagens ÷ negócios criados no mesmo período,
// pela mesma pessoa (decisão tomada com o gestor).

// Filtro exato por marked_as_done_time (quando a atividade foi concluída) —
// mesmo campo usado no relatório nativo do Pipedrive ("Marcado como feito
// em"), para que os totais batam com esse relatório. Se o filtro de período da
// tela estiver vazio, cai no período padrão (OUTREACH_FROM/OUTREACH_TO).
function inOutreachDateRange(a) {
  const from = dateFrom || OUTREACH_FROM;
  const to   = dateTo   || OUTREACH_TO;
  if (!a.marked_as_done_time) return false;
  if (from && a.marked_as_done_time < from) return false;
  if (to   && a.marked_as_done_time > to)   return false;
  return true;
}

// Lista explícita de consultores (proprietários de negócio) para fins de
// classificação nos painéis de Abordagens, confirmada pelo gestor. Quem não
// está nesta lista entra no painel de prospectores/SDR.
const OUTREACH_CLOSER_NAMES = ['Flávio Henrique', 'Sávio Coriolano', 'Kimbelly', 'Lucas Alberto', 'Felipe'];

function isCloserName(name) {
  return OUTREACH_CLOSER_NAMES.includes(name);
}

// Negócios criados (data de criação) dentro do mesmo período usado para as
// abordagens — denominador da razão abordagens ÷ negócios criados.
function dealsCreatedInOutreachPeriod() {
  const from = dateFrom || OUTREACH_FROM;
  const to   = dateTo   || OUTREACH_TO;
  return DEALS.filter(d => d.add && (!from || d.add >= from) && (!to || d.add <= to));
}

function outreachByPerson(scope, criadosByName) {
  const map = {};
  scope.forEach(a => {
    const p = a.owner || 'Sem responsável';
    if (!map[p]) map[p] = { person:p, whatsapp:0, ligacao_efetiva:0, ligacao_nao_efetiva:0, e_mail:0, total:0, is_special: !!specialRole(p) };
    const r = map[p];
    if (r[a.type] !== undefined) r[a.type]++;
    r.total++;
  });
  return Object.values(map).map(r => {
    const criados = criadosByName[r.person] || 0;
    return { ...r, criados, taxa: criados > 0 ? r.total / criados : null };
  });
}

function outreachProspectorRows() {
  const scope = OUTREACH.filter(inOutreachDateRange).filter(a => !isCloserName(a.owner || 'Sem responsável'));
  const criadosMap = {};
  dealsCreatedInOutreachPeriod().forEach(d => {
    const p = d.prospector || 'Sem prospector';
    criadosMap[p] = (criadosMap[p] || 0) + 1;
  });
  return outreachByPerson(scope, criadosMap);
}

function outreachCloserRows() {
  const scope = OUTREACH.filter(inOutreachDateRange).filter(a => isCloserName(a.owner || 'Sem responsável'));
  const criadosMap = {};
  dealsCreatedInOutreachPeriod().forEach(d => {
    const c = d.closer || 'Sem consultor';
    criadosMap[c] = (criadosMap[c] || 0) + 1;
  });
  return outreachByPerson(scope, criadosMap);
}

// ─── Qualidade de dados (Qualificação e Gravação preenchidas) ────────────────
function dataQuality(deals) {
  const total = deals.length;
  const qualiPreenchida = deals.filter(d => d.qualificacao).length;
  const gravPreenchida  = deals.filter(d => d.gravacao).length;

  const validDealIds = new Set(deals.map(d => d.id));
  const presentedMap = presentedDealIdsByCloser(validDealIds);
  const allPresentedIds = new Set();
  Object.values(presentedMap).forEach(s => s.forEach(id => allPresentedIds.add(id)));
  const gravApresentados = deals.filter(d => allPresentedIds.has(d.id));
  const gravPreenchidaApresentados = gravApresentados.filter(d => d.gravacao).length;

  return {
    total,
    qualiPreenchida, qualiPct: total>0 ? qualiPreenchida/total : 0,
    gravPreenchida,  gravPct: total>0 ? gravPreenchida/total : 0,
    gravApresentadosTotal: gravApresentados.length,
    gravPreenchidaApresentados,
    gravApresentadosPct: gravApresentados.length>0 ? gravPreenchidaApresentados/gravApresentados.length : 0,
  };
}

// ─── Ranking de conversão por closer ──────────────────────────────────────────
// Conversão = Ganho ÷ Total de negócios criados no período (não só apresentados).
// Regra definida pelo gestor: se o prospector gerou o negócio e ele não foi
// apresentado, a responsabilidade de correr atrás de reagendar é do closer —
// então todo negócio criado (aberto, ganho ou perdido) entra no denominador.
function closerRanking(deals) {
  const validDealIds = new Set(deals.map(d => d.id));
  const presentedMap = presentedDealIdsByCloser(validDealIds);
  const byCloser = {};
  deals.forEach(d => {
    if (!byCloser[d.closer]) byCloser[d.closer] = { closer: d.closer, ganho:0, perdido:0, aberto:0, criados:0, apresentados:0, mrr:0, implant:0, is_special: !!specialRole(d.closer) };
    const r = byCloser[d.closer];
    r.criados++;
    if (d.status === 'won') { r.ganho++; r.mrr += d.mrr; r.implant += d.implantacao; }
    else if (d.status === 'lost') r.perdido++;
    else r.aberto++;
  });
  Object.values(byCloser).forEach(r => {
    r.apresentados = presentedMap[r.closer] ? presentedMap[r.closer].size : 0;
  });
  return Object.values(byCloser).map(r => ({
    ...r,
    conversao: r.criados > 0 ? (r.ganho / r.criados) : 0,
  }));
}

// ─── Conclusão de Atividades por Consultor (quem conclui atividades) ─────────
// Usa o campo `done` já capturado em mapActivity. Cobre apenas atividades de
// apresentação (PRESENT_TYPES) — mesmo universo das outras métricas de
// produtividade desta tela, não o total de atividades do CRM.
//
// Cruzamento adicional ("Vencidas"): atividades do tipo Reunião Comercial
// (MEETINGS, slug 'meeting') com due_date já passado da data de hoje e que
// ainda não foram marcadas como concluídas — reunião agendada sem outcome
// registrado (não virou d1/apresentado_com_decisor/nfc_e__nf_e). Mesmo
// período/funil filtrado nesta tela, só muda o critério de "vencida" (due_date
// < hoje), pedido pelo gestor como sinal de reunião que ficou sem retorno.
function completionByCloser() {
  let scope = ACTIVITIES.filter(inActivityDateRange);
  let meetingScope = MEETINGS.filter(inActivityDateRange);
  if (funilFilter !== 'todos') {
    const dealFunilById = {};
    DEALS.forEach(d => { dealFunilById[d.id] = d.funil; });
    scope = scope.filter(a => dealFunilById[a.deal_id] === funilFilter);
    meetingScope = meetingScope.filter(a => dealFunilById[a.deal_id] === funilFilter);
  }
  const todayISO = new Date().toISOString().slice(0, 10);
  const map = {};
  function rowFor(c) {
    if (!map[c]) map[c] = { closer:c, done:0, pendente:0, total:0, vencidas:0 };
    return map[c];
  }
  scope.forEach(a => {
    const c = a.closer || 'Sem consultor';
    if (specialRole(c)) return;
    const r = rowFor(c);
    r.total++;
    if (a.done) r.done++; else r.pendente++;
  });
  meetingScope.forEach(a => {
    const c = a.closer || 'Sem consultor';
    if (specialRole(c)) return;
    if (a.done || !a.due_date || a.due_date >= todayISO) return; // só vencida: não concluída e due_date no passado
    rowFor(c).vencidas++;
  });
  return Object.values(map)
    .map(r => ({ ...r, taxa: r.total>0 ? r.done/r.total : 0 }))
    .sort((a,b) => b.total - a.total);
}

// ─── Atualização de Negócios por Consultor (quem atualiza negócios) ──────────
// Olha só negócios ABERTOS (só eles podem "ficar parados"). Independe do
// filtro de Status/Data da tela — sempre mostra a foto atual da carteira
// aberta de cada consultor — mas respeita o filtro de Funil.
function staleByCloser() {
  let opens = DEALS.filter(d => d.status === 'open' && !specialRole(d.closer));
  if (funilFilter !== 'todos') opens = opens.filter(d => d.funil === funilFilter);
  const map = {};
  opens.forEach(d => {
    const c = d.closer;
    if (!map[c]) map[c] = { closer:c, atualizado:0, parado:0, semAtividade:0, total:0 };
    const r = map[c];
    r.total++;
    if (!d.last_act) r.semAtividade++;
    else if (daysDiff(d.last_act) > STALE_DAYS) r.parado++;
    else r.atualizado++;
  });
  return Object.values(map)
    .map(r => ({ ...r, taxaParado: r.total>0 ? (r.parado + r.semAtividade)/r.total : 0 }))
    .sort((a,b) => b.taxaParado - a.taxaParado);
}

// ─── Índice de Risco por Consultor (quem está "maquiando" a operação) ────────
// Combina sinais já existentes na tela em um único score explicável (0-100):
// ganho cancelado pós-venda (peso 30) + duplicados (peso 20) + negócios
// parados (peso 25) + qualificação vazia (peso 15) + gravação vazia entre
// apresentados (peso 10). Ignora Status/Data (olha o histórico completo do
// consultor), respeita Funil e busca — ver riskScope().
function riskScope() {
  return DEALS
    .filter(d => funilFilter === 'todos' || d.funil === funilFilter)
    .filter(d => !searchTerm || d.name.toLowerCase().includes(searchTerm));
}
function riskBadgeClass(score) { return score>=40 ? 'badge-red' : score>=20 ? 'badge-amber' : 'badge-green'; }
function riskLabel(score)      { return score>=40 ? '🔴 Alto'   : score>=20 ? '🟡 Médio'    : '🟢 Baixo'; }

function riskIndexByCloser() {
  const scope = riskScope().filter(d => !specialRole(d.closer));
  const validIds = new Set(scope.map(d => d.id));
  const presentedMap = presentedDealIdsByCloser(validIds);

  const map = {};
  scope.forEach(d => {
    const c = d.closer;
    if (!map[c]) map[c] = { closer:c, total:0, won:0, wonCancel:0, dup:0, openTotal:0, openStale:0, qualiVazia:0 };
    const r = map[c];
    r.total++;
    if (d.status === 'won') {
      r.won++;
      if (hasCancelLabel(d)) r.wonCancel++;
    }
    if (isDup(d)) r.dup++;
    if (d.status === 'open') {
      r.openTotal++;
      if (!d.last_act || daysDiff(d.last_act) > STALE_DAYS) r.openStale++;
    }
    if (!d.qualificacao) r.qualiVazia++;
  });

  Object.values(map).forEach(r => {
    const presentedIds = presentedMap[r.closer] || new Set();
    r.presentedTotal = presentedIds.size;
    r.gravVazia = scope.filter(d => d.closer === r.closer && presentedIds.has(d.id) && !d.gravacao).length;

    const cancelPct     = r.won > 0       ? r.wonCancel / r.won       : 0;
    const dupPct         = r.total > 0     ? r.dup / r.total           : 0;
    const stalePct       = r.openTotal > 0 ? r.openStale / r.openTotal : 0;
    const qualiVaziaPct  = r.total > 0     ? r.qualiVazia / r.total    : 0;
    const gravVaziaPct   = r.presentedTotal > 0 ? r.gravVazia / r.presentedTotal : 0;

    r.score = Math.round(cancelPct*30 + dupPct*20 + stalePct*25 + qualiVaziaPct*15 + gravVaziaPct*10);
  });

  return Object.values(map).sort((a,b) => b.score - a.score);
}

// ─── Drill-down: popup com a lista de negócios por trás de um dado clicado ───
// Reaproveita o modal único (#dealModal/#m-title/#m-sub/#m-body) já usado por
// openModal(id) para detalhe de 1 negócio — aqui ele recebe uma LISTA.
function escAttr(s) { return String(s).replace(/'/g, "\\'"); }

function dealListItemHtml(d) {
  const cls   = d.status==='won' ? 'badge-green' : d.status==='lost' ? 'badge-red' : 'badge-blue';
  const label = d.status==='won' ? '✅ Ganho'     : d.status==='lost' ? '❌ Perdido' : '🔵 Aberto';
  return `<div class="deal-item">
    <div class="deal-item-header">
      <div class="deal-name">#${d.id} · ${d.name}</div>
      <span class="badge ${cls}">${label}</span>
    </div>
    <div class="deal-meta">
      <div>Funil <span>${d.funil}</span></div>
      <div>Etapa <span>${STAGES[d.stage]||d.stage}</span></div>
      <div>Consultor <span>${d.closer}</span></div>
      ${d.prospector ? `<div>Prospector <span>${d.prospector}</span></div>` : ''}
      ${d.status==='won' ? `<div>MRR <span style="color:var(--green)">${fmtCurrency(d.mrr)}</span></div>` : ''}
      ${d.status==='lost' && d.lost_reason ? `<div>Motivo <span>${d.lost_reason}</span></div>` : ''}
    </div>
    <div class="deal-link"><a class="pipe-link" href="${PIPE_BASE}${d.id}" target="_blank" rel="noopener">↗ Abrir no Pipedrive</a></div>
  </div>`;
}

function showDealListModal(title, sub, deals) {
  document.getElementById('m-title').textContent = title;
  document.getElementById('m-sub').textContent   = sub || '';
  const body = document.getElementById('m-body');
  body.innerHTML = (!deals || !deals.length)
    ? `<div style="color:var(--text3);font-size:13px;padding:12px 0;">Nenhum negócio encontrado para este recorte.</div>`
    : `<div class="deal-list">${deals.map(dealListItemHtml).join('')}</div>`;
  document.getElementById('dealModal').classList.add('open');
}

// Helpers de filtro por "balde" (bucket), reaproveitando o mesmo escopo já
// renderizado na tela (mesmos filtros de Status/Funil/Data/busca).
function dealsByCloserBucket(scope, closer, bucket) {
  let list = scope.filter(d => d.closer === closer);
  if (bucket === 'ganho') list = list.filter(d => d.status === 'won');
  else if (bucket === 'perdido') list = list.filter(d => d.status === 'lost');
  else if (bucket === 'aberto') list = list.filter(d => d.status === 'open');
  else if (bucket === 'apresentados') {
    const validIds = new Set(scope.map(d => d.id));
    const ids = presentedDealIdsByCloser(validIds)[closer] || new Set();
    list = list.filter(d => ids.has(d.id));
  }
  return list;
}
function dealsByProspectorBucket(scope, prospector, bucket) {
  let list = scope.filter(d => (d.prospector || 'Sem prospector') === prospector);
  if (bucket === 'ganho') list = list.filter(d => d.status === 'won');
  else if (bucket === 'perdido') list = list.filter(d => d.status === 'lost');
  else if (bucket === 'aberto') list = list.filter(d => d.status === 'open');
  else if (bucket === 'comPerfil') list = list.filter(d => Number(d.qualificacao) === 732);
  else if (bucket === 'semPerfil') list = list.filter(d => Number(d.qualificacao) === 733);
  else if (bucket === 'naoQualificado') list = list.filter(d => !d.qualificacao);
  else if (bucket === 'apresComDecisor' || bucket === 'apresSemDecisor') {
    const wantType = bucket === 'apresComDecisor' ? 'd1' : 'apresentado_com_decisor';
    const dealById = {};
    scope.forEach(d => { dealById[d.id] = d; });
    const ids = new Set();
    ACTIVITIES.forEach(a => {
      if (a.type !== wantType) return;
      const deal = dealById[a.deal_id];
      if (deal && (deal.prospector || 'Sem prospector') === prospector) ids.add(a.deal_id);
    });
    list = scope.filter(d => ids.has(d.id));
  }
  return list;
}
function dealsByChannelBucket(scope, channel, bucket) {
  let list = scope.filter(d => (d.channel || 'Não informado') === channel);
  if (bucket === 'ganho') list = list.filter(d => d.status === 'won');
  else if (bucket === 'perdido') list = list.filter(d => d.status === 'lost');
  else if (bucket === 'aberto') list = list.filter(d => d.status === 'open');
  return list;
}
function dealsForActivityBucket(closer, type) {
  let scope = ACTIVITIES.filter(inActivityDateRange).filter(a => (a.closer || 'Sem consultor') === closer);
  if (funilFilter !== 'todos') {
    const dealFunilById = {};
    DEALS.forEach(d => { dealFunilById[d.id] = d.funil; });
    scope = scope.filter(a => dealFunilById[a.deal_id] === funilFilter);
  }
  if (type === 'd1') scope = scope.filter(a => a.type === 'd1');
  else if (type === 'semDecisor') scope = scope.filter(a => a.type === 'apresentado_com_decisor');
  else if (type === 'naoApresentado') scope = scope.filter(a => a.type === 'nfc_e__nf_e');
  const ids = new Set(scope.map(a => a.deal_id).filter(Boolean));
  return DEALS.filter(d => ids.has(d.id));
}
function dealsForCompletionBucket(closer, doneFlag) {
  let scope = ACTIVITIES.filter(inActivityDateRange).filter(a => (a.closer || 'Sem consultor') === closer);
  if (funilFilter !== 'todos') {
    const dealFunilById = {};
    DEALS.forEach(d => { dealFunilById[d.id] = d.funil; });
    scope = scope.filter(a => dealFunilById[a.deal_id] === funilFilter);
  }
  scope = scope.filter(a => !!a.done === doneFlag);
  const ids = new Set(scope.map(a => a.deal_id).filter(Boolean));
  return DEALS.filter(d => ids.has(d.id));
}
// Reuniões Comerciais (MEETINGS) vencidas: due_date no passado e não concluídas.
function dealsForVencidasBucket(closer) {
  let scope = MEETINGS.filter(inActivityDateRange).filter(a => (a.closer || 'Sem consultor') === closer);
  if (funilFilter !== 'todos') {
    const dealFunilById = {};
    DEALS.forEach(d => { dealFunilById[d.id] = d.funil; });
    scope = scope.filter(a => dealFunilById[a.deal_id] === funilFilter);
  }
  const todayISO = new Date().toISOString().slice(0, 10);
  scope = scope.filter(a => !a.done && a.due_date && a.due_date < todayISO);
  const ids = new Set(scope.map(a => a.deal_id).filter(Boolean));
  return DEALS.filter(d => ids.has(d.id));
}
function dealsForStaleBucket(closer, bucket) {
  let list = DEALS.filter(d => d.status === 'open' && d.closer === closer);
  if (funilFilter !== 'todos') list = list.filter(d => d.funil === funilFilter);
  if (bucket === 'semAtividade') list = list.filter(d => !d.last_act);
  else if (bucket === 'parado')     list = list.filter(d => d.last_act && daysDiff(d.last_act) > STALE_DAYS);
  else if (bucket === 'atualizado') list = list.filter(d => d.last_act && daysDiff(d.last_act) <= STALE_DAYS);
  return list;
}
function dealsForRiskBucket(closer, bucket) {
  const scope = riskScope().filter(d => d.closer === closer);
  if (bucket === 'cancelPosVenda') return scope.filter(d => d.status==='won' && hasCancelLabel(d));
  if (bucket === 'duplicados')      return scope.filter(isDup);
  if (bucket === 'parados')         return scope.filter(d => d.status==='open' && (!d.last_act || daysDiff(d.last_act) > STALE_DAYS));
  if (bucket === 'qualiVazia')      return scope.filter(d => !d.qualificacao);
  if (bucket === 'gravVazia') {
    const validIds = new Set(scope.map(d => d.id));
    const ids = presentedDealIdsByCloser(validIds)[closer] || new Set();
    return scope.filter(d => ids.has(d.id) && !d.gravacao);
  }
  return scope;
}

// Funções "show*" chamadas direto pelos onclick das células — recomputam o
// escopo no momento do clique (mesmos filtros já visíveis na tela).
function showCloserDeals(closer, bucket) {
  const labels = { criados:'Negócios criados', ganho:'Ganhos', perdido:'Perdidos', aberto:'Abertos', apresentados:'Apresentados (atividade real)' };
  const list = dealsByCloserBucket(monthScope(), closer, bucket);
  showDealListModal(`${closer} — ${labels[bucket]||bucket}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showProspectorDeals(prospector, bucket) {
  const labels = { criados:'Negócios criados', ganho:'Ganhos', perdido:'Perdidos', aberto:'Abertos', comPerfil:'Com perfil', semPerfil:'Sem perfil', naoQualificado:'Não qualificado', apresComDecisor:'Apresentado com decisor', apresSemDecisor:'Apresentado sem decisor' };
  const list = dealsByProspectorBucket(monthScope(), prospector, bucket);
  showDealListModal(`${prospector} — ${labels[bucket]||bucket}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showChannelDeals(channel, bucket) {
  const labels = { criados:'Negócios criados', ganho:'Ganhos', perdido:'Perdidos', aberto:'Abertos' };
  const list = dealsByChannelBucket(monthScope(), channel, bucket);
  showDealListModal(`${channel} — ${labels[bucket]||bucket}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showLossReasonDeals(motivo) {
  const list = dealsByLossReason(monthScopeForLosses(), motivo);
  showDealListModal(`Perdidos — ${motivo}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function dealsByLossReason(perdidos, motivo) {
  return perdidos.filter(d => (d.lost_reason || 'Não informado') === motivo);
}
function showNoShowDeals(prospector, onlyNoShow) {
  let list = monthScope().filter(d => (d.prospector || 'Sem prospector') === prospector);
  if (onlyNoShow) list = list.filter(isNoShow);
  showDealListModal(`${prospector} — ${onlyNoShow?'No-show':'Total de negócios'}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showActivityDeals(closer, type) {
  const labels = { d1:'Apresentado com decisor', semDecisor:'Apresentado sem decisor', naoApresentado:'Não apresentado', total:'Total de atividades' };
  const list = dealsForActivityBucket(closer, type);
  showDealListModal(`${closer} — ${labels[type]}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showCompletionDeals(closer, doneFlag) {
  const list = dealsForCompletionBucket(closer, doneFlag);
  showDealListModal(`${closer} — ${doneFlag?'Atividades concluídas':'Atividades pendentes'}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showVencidasDeals(closer) {
  const list = dealsForVencidasBucket(closer);
  showDealListModal(`${closer} — Reuniões comerciais vencidas`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showStaleDeals(closer, bucket) {
  const labels = { atualizado:`Atualizados (≤${STALE_DAYS} dias)`, parado:`Parados (>${STALE_DAYS} dias)`, semAtividade:'Sem atividade registrada' };
  const list = dealsForStaleBucket(closer, bucket);
  showDealListModal(`${closer} — ${labels[bucket]}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}
function showRiskDeals(closer, bucket) {
  const labels = { cancelPosVenda:'Ganhos cancelados pós-venda', duplicados:'Negócios duplicados', parados:'Negócios parados', qualiVazia:'Qualificação vazia', gravVazia:'Gravação vazia (apresentados)' };
  const list = dealsForRiskBucket(closer, bucket);
  showDealListModal(`${closer} — ${labels[bucket]}`, `${list.length} negócio${list.length!==1?'s':''}`, list);
}

// ─── Render ──────────────────────────────────────────────────────────────────
// ─── Data de referência conforme status ───────────────────────────────────────
function dateFieldFor(d) {
  if (d.status === 'won')  return d.won_time;
  if (d.status === 'lost') return d.lost_time;
  return d.add; // open -> data de criação
}

function inDateRange(d) {
  if (!dateFrom && !dateTo) return true;
  const val = dateFieldFor(d);
  if (!val) return false;
  if (dateFrom && val < dateFrom) return false;
  if (dateTo   && val > dateTo)   return false;
  return true;
}

function getFiltered(closer) {
  let list = closer === 'todos' ? DEALS : DEALS.filter(d => d.closer === closer);
  if (statusFilter !== 'all') list = list.filter(d => d.status === statusFilter);
  if (funilFilter  !== 'todos') list = list.filter(d => d.funil === funilFilter);
  list = list.filter(inDateRange);
  if (onlyVenc)   list = list.filter(isOverdue);
  if (searchTerm) list = list.filter(d => d.name.toLowerCase().includes(searchTerm));
  return list;
}

let rankSortKey = 'mrr';
let rankSortDir = 'desc';

function setRankSort(key) {
  if (rankSortKey === key) rankSortDir = rankSortDir === 'desc' ? 'asc' : 'desc';
  else { rankSortKey = key; rankSortDir = 'desc'; }
  renderRanking();
}

// Mesma lógica de ranqueamento dinâmico do ranking de Consultor (setRankSort),
// aplicada à tabela de Conversão por Prospector / SDR.
let prospectorSortKey = 'apresComDecisor';
let prospectorSortDir = 'desc';

function setProspectorSort(key) {
  if (prospectorSortKey === key) prospectorSortDir = prospectorSortDir === 'desc' ? 'asc' : 'desc';
  else { prospectorSortKey = key; prospectorSortDir = 'desc'; }
  renderProspector();
}

// Mesmo padrão de ranqueamento dinâmico aplicado a todas as demais tabelas
// da tela (uma variável de estado + setter dedicado por tabela).
let noshowSortKey = 'taxa';
let noshowSortDir = 'desc';
function setNoshowSort(key) {
  if (noshowSortKey === key) noshowSortDir = noshowSortDir === 'desc' ? 'asc' : 'desc';
  else { noshowSortKey = key; noshowSortDir = 'desc'; }
  renderNoShow();
}

let channelSortKey = 'criados';
let channelSortDir = 'desc';
function setChannelSort(key) {
  if (channelSortKey === key) channelSortDir = channelSortDir === 'desc' ? 'asc' : 'desc';
  else { channelSortKey = key; channelSortDir = 'desc'; }
  renderChannel();
}

let outreachProspectorSortKey = 'total';
let outreachProspectorSortDir = 'desc';
function setOutreachProspectorSort(key) {
  if (outreachProspectorSortKey === key) outreachProspectorSortDir = outreachProspectorSortDir === 'desc' ? 'asc' : 'desc';
  else { outreachProspectorSortKey = key; outreachProspectorSortDir = 'desc'; }
  renderOutreachProspector();
}

let outreachCloserSortKey = 'total';
let outreachCloserSortDir = 'desc';
function setOutreachCloserSort(key) {
  if (outreachCloserSortKey === key) outreachCloserSortDir = outreachCloserSortDir === 'desc' ? 'asc' : 'desc';
  else { outreachCloserSortKey = key; outreachCloserSortDir = 'desc'; }
  renderOutreachCloser();
}

let productivitySortKey = 'total';
let productivitySortDir = 'desc';
function setProductivitySort(key) {
  if (productivitySortKey === key) productivitySortDir = productivitySortDir === 'desc' ? 'asc' : 'desc';
  else { productivitySortKey = key; productivitySortDir = 'desc'; }
  renderProductivity();
}

let lossreasonSortKey = 'total';
let lossreasonSortDir = 'desc';
function setLossreasonSort(key) {
  if (lossreasonSortKey === key) lossreasonSortDir = lossreasonSortDir === 'desc' ? 'asc' : 'desc';
  else { lossreasonSortKey = key; lossreasonSortDir = 'desc'; }
  renderLossReason();
}

// Padrão da Conclusão é ascendente (mostra primeiro quem está com a pior taxa).
let completionSortKey = 'taxa';
let completionSortDir = 'asc';
function setCompletionSort(key) {
  if (completionSortKey === key) completionSortDir = completionSortDir === 'desc' ? 'asc' : 'desc';
  else { completionSortKey = key; completionSortDir = key === 'taxa' ? 'asc' : 'desc'; }
  renderCompletion();
}

let stalenessSortKey = 'taxaParado';
let stalenessSortDir = 'desc';
function setStalenessSort(key) {
  if (stalenessSortKey === key) stalenessSortDir = stalenessSortDir === 'desc' ? 'asc' : 'desc';
  else { stalenessSortKey = key; stalenessSortDir = 'desc'; }
  renderStaleness();
}

let riskSortKey = 'score';
let riskSortDir = 'desc';
function setRiskSort(key) {
  if (riskSortKey === key) riskSortDir = riskSortDir === 'desc' ? 'asc' : 'desc';
  else { riskSortKey = key; riskSortDir = 'desc'; }
  renderRisk();
}

// ─── Gráficos (Chart.js) ───────────────────────────────────────────────────
// Instâncias guardadas em variáveis globais para destruir antes de redesenhar
// (renderRanking/renderProspector são chamados de novo a cada mudança de
// filtro, e o container.innerHTML recria o <canvas> do zero).
let rankingChartInst = null;
let prospectorChartInst = null;
let outreachProspectorChartInst = null;
let outreachCloserChartInst = null;

function fmtCompact(v) {
  v = v || 0;
  if (Math.abs(v) >= 1000) return 'R$' + (v/1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return 'R$' + Math.round(v);
}

function renderRankingChart(rows) {
  const canvas = document.getElementById('ranking-chart');
  if (!canvas) return;
  if (rankingChartInst) { rankingChartInst.destroy(); rankingChartInst = null; }
  const regular = rows.filter(r => !r.is_special);
  if (regular.length === 0) return;
  rankingChartInst = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: regular.map(r => r.closer),
      datasets: [{
        label: 'MRR gerado',
        data: regular.map(r => r.mrr),
        backgroundColor: regular.map(r => r.conversao>=0.3 ? 'rgba(74,222,128,0.75)' : r.conversao>=0.15 ? 'rgba(251,191,36,0.75)' : 'rgba(248,113,113,0.75)'),
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      onClick: (evt, elements) => {
        if (!elements.length) return;
        showCloserDeals(regular[elements[0].index].closer, 'ganho');
      },
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = regular[ctx.dataIndex];
              return `${fmtCurrency(r.mrr)} · conversão ${(r.conversao*100).toFixed(0)}%`;
            }
          }
        }
      },
      scales: {
        x: { beginAtZero:true, grid:{ color:'rgba(255,255,255,0.07)' }, ticks:{ color:'#9499b0', font:{size:10}, callback:(v)=>fmtCompact(v) } },
        y: { grid:{ display:false }, ticks:{ color:'#e8eaf0', font:{size:11} } }
      }
    }
  });
}

function renderProspectorChart(rows) {
  const canvas = document.getElementById('prospector-chart');
  if (!canvas) return;
  if (prospectorChartInst) { prospectorChartInst.destroy(); prospectorChartInst = null; }
  const regular = rows.filter(r => !r.is_special);
  if (regular.length === 0) return;
  prospectorChartInst = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: regular.map(r => r.prospector),
      datasets: [
        { label: 'Apres. c/ decisor', data: regular.map(r => r.apresComDecisor), backgroundColor: 'rgba(129,140,248,0.75)', borderRadius: 4 },
        { label: 'Apres. sem decisor', data: regular.map(r => r.apresSemDecisor), backgroundColor: 'rgba(251,191,36,0.75)', borderRadius: 4 },
        { label: 'Ganho', data: regular.map(r => r.ganho), backgroundColor: 'rgba(74,222,128,0.75)', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        const r = regular[el.index];
        const bucket = el.datasetIndex === 0 ? 'apresComDecisor' : el.datasetIndex === 1 ? 'apresSemDecisor' : 'ganho';
        showProspectorDeals(r.prospector, bucket);
      },
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { position:'top', labels:{ color:'#9499b0', usePointStyle:true, font:{size:11} } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}` } }
      },
      scales: {
        x: { grid:{ display:false }, ticks:{ color:'#9499b0', font:{size:10} } },
        y: { beginAtZero:true, grid:{ color:'rgba(255,255,255,0.07)' }, ticks:{ color:'#9499b0', font:{size:10}, precision:0 } }
      }
    }
  });
}

function renderRanking() {
  const container = document.getElementById('ranking-container');
  // Inclui papéis especiais nos dados, mas eles ficam SEMPRE no fim da tabela,
  // sem número de ranking — não competem como 1º/2º/3º.
  const scope = monthScope();

  if (scope.length === 0) { container.innerHTML = ''; return; }

  let rows = closerRanking(scope);

  // Critério primário de ranqueamento: MRR gerado. Desempate: ganho.
  // Quando o usuário clica em outra coluna (setRankSort), respeita a escolha
  // dele, mas papéis especiais sempre ficam no fim.
  const sortKey = rankSortKey;
  const sortDir = rankSortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (a.is_special !== b.is_special) return a.is_special ? 1 : -1; // especiais sempre no fim
    const primary = (a[sortKey] - b[sortKey]) * sortDir;
    if (primary !== 0) return primary;
    // Desempate: ganho (descendente)
    return b.ganho - a.ganho;
  });

  const arrow = (key) => rankSortKey===key ? `<span class="arr">${rankSortDir==='desc'?'▼':'▲'}</span>` : '';

  const criadosLabel = statusFilter==='all' ? 'Criados'
    : statusFilter==='won' ? 'Total (ganho)'
    : statusFilter==='lost' ? 'Total (perdido)'
    : 'Total (aberto)';
  const dataCriterio = statusFilter==='won' ? 'data de ganho'
    : statusFilter==='lost' ? 'data de perda'
    : 'data de criação';

  // Numerar posição apenas para closers regulares; especiais não recebem #
  let pos = 0;
  const numberFor = (r) => r.is_special ? '<span class="rank-pos" style="opacity:0.5;">—</span>' : `<span class="rank-pos">${++pos}</span>`;

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Ranking de Conversão por Consultor</div>
        <div class="ranking-sub">Ranqueamento por MRR gerado (desempate: ganho) · ${criadosLabel} usa ${dataCriterio} · Apresentados = atividade real via /activities · Felipe Gomes e Juliana Santiago aparecem mas não competem no ranqueamento (sempre no fim)</div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-box-title">MRR gerado por consultor · clique numa barra para ver os negócios ganhos</div>
      <div class="chart-box-wrap"><canvas id="ranking-chart"></canvas></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Consultor</th>
            <th class="sortable" onclick="setRankSort('criados')">${criadosLabel}${arrow('criados')}</th>
            <th class="sortable" onclick="setRankSort('apresentados')">Apresentados${arrow('apresentados')}</th>
            <th class="sortable" onclick="setRankSort('ganho')">Ganho${arrow('ganho')}</th>
            <th class="sortable" onclick="setRankSort('perdido')">Perdido${arrow('perdido')}</th>
            <th class="sortable" onclick="setRankSort('aberto')">Aberto${arrow('aberto')}</th>
            <th class="sortable" onclick="setRankSort('conversao')">Conversão${arrow('conversao')}</th>
            <th class="sortable" onclick="setRankSort('mrr')">MRR${arrow('mrr')}</th>
            <th class="sortable" onclick="setRankSort('implant')">Implantação${arrow('implant')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr onclick="navToCloserByName('${r.closer.replace(/'/g,"\\'")}')" style="${r.is_special?'opacity:0.75;border-top:0.5px dashed var(--border2);':''}">
              <td>${numberFor(r)}</td>
              <td class="td-name">${r.closer}${r.is_special ? `<span class="role-tag" style="margin-left:6px;">${specialRole(r.closer)||'Papel especial'}</span>` : ''}${(!r.is_special && INACTIVE_CLOSER_NAMES.includes(r.closer)) ? `<span class="inactive-tag" style="margin-left:6px;">Inativo</span>` : ''}</td>
              <td class="clk" style="color:var(--text2)" onclick="event.stopPropagation();showCloserDeals('${r.closer.replace(/'/g,"\\'")}','criados')">${r.criados}</td>
              <td class="clk" style="color:var(--text3)" title="Negócios únicos com ao menos 1 atividade de apresentação real" onclick="event.stopPropagation();showCloserDeals('${r.closer.replace(/'/g,"\\'")}','apresentados')">${r.apresentados}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="event.stopPropagation();showCloserDeals('${r.closer.replace(/'/g,"\\'")}','ganho')">${r.ganho}</td>
              <td class="clk" style="color:var(--red)" onclick="event.stopPropagation();showCloserDeals('${r.closer.replace(/'/g,"\\'")}','perdido')">${r.perdido}</td>
              <td class="clk" style="color:var(--text3)" onclick="event.stopPropagation();showCloserDeals('${r.closer.replace(/'/g,"\\'")}','aberto')">${r.aberto}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--text3)'}">${(r.conversao*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.conversao*100,100)}%;background:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--red)'}"></div></div>
                </div>
              </td>
              <td style="color:var(--green);font-weight:600">${fmtCurrency(r.mrr)}</td>
              <td style="color:var(--green)">${fmtCurrency(r.implant)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  renderRankingChart(rows);
}

// ─── No-show por Prospector (SDR) ─────────────────────────────────────────────
function renderNoShow() {
  const container = document.getElementById('noshow-container');
  const scope = monthScope();

  if (scope.length === 0) { container.innerHTML = ''; return; }

  let rows = noShowByProspector(scope).filter(r => r.prospector !== 'Sem prospector' || r.total > 0);
  const sortKey = noshowSortKey;
  const sortDir = noshowSortDir === 'desc' ? -1 : 1;
  rows.sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => noshowSortKey===key ? `<span class="arr">${noshowSortDir==='desc'?'▼':'▲'}</span>` : '';

  if (rows.every(r => r.noshow === 0)) {
    container.innerHTML = `
      <div class="ranking-hd"><div>
        <div class="ranking-title">No-show por Prospector</div>
        <div class="ranking-sub">Nenhum negócio em REAGENDAR (NO SHOW) no período/funil filtrado.</div>
      </div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">No-show por Prospector</div>
        <div class="ranking-sub">Etapa REAGENDAR (NO SHOW) por funil (S/R/ST) · atribuído ao campo PROSPECTOR, não ao criador do negócio</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Prospector</th>
            <th class="sortable" onclick="setNoshowSort('noshow')">No-show${arrow('noshow')}</th>
            <th class="sortable" onclick="setNoshowSort('total')">Total de negócios${arrow('total')}</th>
            <th class="sortable" onclick="setNoshowSort('taxa')">Taxa de no-show${arrow('taxa')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.prospector}</td>
              <td class="clk" style="color:var(--red);font-weight:600" onclick="showNoShowDeals('${r.prospector.replace(/'/g,"\\'")}',true)">${r.noshow}</td>
              <td class="clk" style="color:var(--text2)" onclick="showNoShowDeals('${r.prospector.replace(/'/g,"\\'")}',false)">${r.total}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.taxa>=0.3?'var(--red)':r.taxa>=0.15?'var(--amber)':'var(--text3)'}">${(r.taxa*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.taxa*100,100)}%;background:${r.taxa>=0.3?'var(--red)':r.taxa>=0.15?'var(--amber)':'var(--green)'}"></div></div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Escopo padrão dos painéis de gestão mensal ───────────────────────────────
// Respeita Status + Funil + Data + busca, com o MESMO critério de data já usado
// pelos KPIs e pela tabela por consultor: Ganho usa won_time, Perdido usa
// lost_time, Aberto usa add_time (ver dateFieldFor/inDateRange).
//
// Papéis especiais (Felipe Gomes / Juliana Santiago) ENTRAM nos dados — o que
// eles geram conta para o resultado da equipe. O que eles NÃO fazem é
// competir no ranqueamento (1º/2º/3º) — para isso, ficam sempre no fim da
// tabela, separados dos colocados, identificados por badge "papel especial".
// Por isso o parâmetro `includeSpecial` agora é true por padrão (na verdade,
// sempre incluído). A função foi mantida com a assinatura antiga para
// compatibilidade.
function monthScope() {
  let scope = DEALS;
  if (statusFilter !== 'all') scope = scope.filter(d => d.status === statusFilter);
  if (funilFilter  !== 'todos') scope = scope.filter(d => d.funil === funilFilter);
  scope = scope.filter(inDateRange);
  if (searchTerm) scope = scope.filter(d => d.name.toLowerCase().includes(searchTerm));
  return scope;
}

// Escopo dedicado para o painel de Perdas por Motivo: sempre olha negócios
// PERDIDOS no período/funil, independente do statusFilter ativo na tela.
function monthScopeForLosses() {
  return DEALS
    .filter(d => d.status === 'lost')
    .filter(d => funilFilter === 'todos' || d.funil === funilFilter)
    .filter(inDateRange)
    .filter(d => !searchTerm || d.name.toLowerCase().includes(searchTerm));
}

// ─── Conversão por Prospector/SDR ─────────────────────────────────────────────
function renderProspector() {
  const container = document.getElementById('prospector-container');
  const scope = monthScope();
  if (scope.length === 0) { container.innerHTML = ''; return; }

  let rows = prospectorRanking(scope);
  // Ordenação dinâmica (mesma lógica do Ranking de Conversão por Consultor,
  // ver setRankSort): papéis especiais sempre no fim; entre os demais,
  // ranqueia pela coluna escolhida pelo usuário (clique no cabeçalho).
  // Padrão: "Apresentado com decisor" (volume de atividade real qualificada).
  // Desempates em cascata quando a coluna primária empata: ganho → MRR.
  const sortKey = prospectorSortKey;
  const sortDir = prospectorSortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (a.is_special !== b.is_special) return a.is_special ? 1 : -1;
    const primary = (a[sortKey] - b[sortKey]) * sortDir;
    if (primary !== 0) return primary;
    if (b.ganho !== a.ganho) return b.ganho - a.ganho;
    return b.mrr - a.mrr;
  });

  const arrow = (key) => prospectorSortKey===key ? `<span class="arr">${prospectorSortDir==='desc'?'▼':'▲'}</span>` : '';

  const criadosLabel = statusFilter==='all' ? 'Criados'
    : statusFilter==='won' ? 'Total (ganho)'
    : statusFilter==='lost' ? 'Total (perdido)'
    : 'Total (aberto)';
  const subNota = statusFilter==='all' ? ''
    : ` · Conversão fica artificial (100%/0%) com filtro de Status diferente de "Todos" — mude para Todos para ver conversão real`;

  // Numeração só para prospectores regulares
  let pos = 0;
  const numberFor = (r) => r.is_special
    ? '<span class="rank-pos" style="opacity:0.5;">—</span>'
    : `<span class="rank-pos">${++pos}</span>`;

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Conversão por Prospector / SDR</div>
        <div class="ranking-sub">Ranqueamento por "Apresentado com decisor" (atividade real) · desempate: ganho → MRR · Felipe Gomes e Juliana Santiago aparecem mas não competem (sempre no fim)${subNota}</div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-box-title">Apres. c/ decisor vs. sem decisor vs. Ganho por prospector · clique numa barra para ver os negócios</div>
      <div class="chart-box-wrap"><canvas id="prospector-chart"></canvas></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Prospector</th>
            <th class="sortable" onclick="setProspectorSort('apresComDecisor')">Apres. c/ decisor${arrow('apresComDecisor')}</th>
            <th class="sortable" onclick="setProspectorSort('apresSemDecisor')">Apres. sem decisor${arrow('apresSemDecisor')}</th>
            <th class="sortable" onclick="setProspectorSort('criados')">${criadosLabel}${arrow('criados')}</th>
            <th class="sortable" onclick="setProspectorSort('ganho')">Ganho${arrow('ganho')}</th>
            <th class="sortable" onclick="setProspectorSort('perdido')">Perdido${arrow('perdido')}</th>
            <th class="sortable" onclick="setProspectorSort('aberto')">Aberto${arrow('aberto')}</th>
            <th class="sortable" onclick="setProspectorSort('conversao')">Conversão${arrow('conversao')}</th>
            <th class="sortable" onclick="setProspectorSort('mrr')">MRR${arrow('mrr')}</th>
            <th class="sortable" onclick="setProspectorSort('comPerfil')">Com perfil${arrow('comPerfil')}</th>
            <th class="sortable" onclick="setProspectorSort('semPerfil')">Sem perfil${arrow('semPerfil')}</th>
            <th class="sortable" onclick="setProspectorSort('naoQualificado')">Não qualificado${arrow('naoQualificado')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="${r.is_special?'opacity:0.75;border-top:0.5px dashed var(--border2);':''}">
              <td>${numberFor(r)}</td>
              <td class="td-name">${r.prospector}${r.is_special ? `<span class="role-tag" style="margin-left:6px;">Líder</span>` : ''}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','apresComDecisor')">${r.apresComDecisor}</td>
              <td class="clk" style="color:var(--amber)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','apresSemDecisor')">${r.apresSemDecisor}</td>
              <td class="clk" style="color:var(--text2)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','criados')">${r.criados}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','ganho')">${r.ganho}</td>
              <td class="clk" style="color:var(--red)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','perdido')">${r.perdido}</td>
              <td class="clk" style="color:var(--text3)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','aberto')">${r.aberto}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--text3)'}">${(r.conversao*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.conversao*100,100)}%;background:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--red)'}"></div></div>
                </div>
              </td>
              <td style="color:var(--green)">${fmtCurrency(r.mrr)}</td>
              <td class="clk" style="color:var(--green)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','comPerfil')">${r.comPerfil}</td>
              <td class="clk" style="color:var(--amber)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','semPerfil')">${r.semPerfil}</td>
              <td class="clk" style="color:var(--text3)" onclick="showProspectorDeals('${r.prospector.replace(/'/g,"\\'")}','naoQualificado')">${r.naoQualificado}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  renderProspectorChart(rows);
}

// ─── Conversão por Canal de Origem ────────────────────────────────────────────
function renderChannel() {
  const container = document.getElementById('channel-container');
  const scope = monthScope();
  if (scope.length === 0) { container.innerHTML = ''; return; }

  let rows = channelBreakdown(scope);
  const sortKey = channelSortKey;
  const sortDir = channelSortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => channelSortKey===key ? `<span class="arr">${channelSortDir==='desc'?'▼':'▲'}</span>` : '';

  const criadosLabel = statusFilter==='all' ? 'Criados'
    : statusFilter==='won' ? 'Total (ganho)'
    : statusFilter==='lost' ? 'Total (perdido)'
    : 'Total (aberto)';
  const subNota = statusFilter==='all' ? ''
    : ` · Conversão fica artificial (100%/0%) com filtro de Status diferente de "Todos"`;

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Conversão por Canal de Origem</div>
        <div class="ranking-sub">De onde vêm os negócios criados no período e qual canal converte melhor${subNota}</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Canal</th>
            <th class="sortable" onclick="setChannelSort('criados')">${criadosLabel}${arrow('criados')}</th>
            <th class="sortable" onclick="setChannelSort('ganho')">Ganho${arrow('ganho')}</th>
            <th class="sortable" onclick="setChannelSort('perdido')">Perdido${arrow('perdido')}</th>
            <th class="sortable" onclick="setChannelSort('aberto')">Aberto${arrow('aberto')}</th>
            <th class="sortable" onclick="setChannelSort('conversao')">Conversão${arrow('conversao')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.channel}</td>
              <td class="clk" style="color:var(--text2)" onclick="showChannelDeals('${r.channel.replace(/'/g,"\\'")}','criados')">${r.criados}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showChannelDeals('${r.channel.replace(/'/g,"\\'")}','ganho')">${r.ganho}</td>
              <td class="clk" style="color:var(--red)" onclick="showChannelDeals('${r.channel.replace(/'/g,"\\'")}','perdido')">${r.perdido}</td>
              <td class="clk" style="color:var(--text3)" onclick="showChannelDeals('${r.channel.replace(/'/g,"\\'")}','aberto')">${r.aberto}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--text3)'}">${(r.conversao*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.conversao*100,100)}%;background:${r.conversao>=0.3?'var(--green)':r.conversao>=0.15?'var(--amber)':'var(--red)'}"></div></div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Abordagens (Whatsapp/Ligação/E-mail) — Prospector/SDR e Consultor ───────
// Dois painéis separados (decisão tomada com o gestor), mesmo template visual
// dos demais painéis de ranking. Período regido por marked_as_done_time (bate
// com o relatório nativo do Pipedrive); cada painel exibe o período
// efetivamente coberto de forma explícita no subtítulo.
function fmtDateLong(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function outreachTableRows(rows) {
  let pos = 0;
  const numberFor = (r) => r.is_special
    ? '<span class="rank-pos" style="opacity:0.5;">—</span>'
    : `<span class="rank-pos">${++pos}</span>`;
  return rows.map(r => `
    <tr style="${r.is_special?'opacity:0.75;border-top:0.5px dashed var(--border2);':''}">
      <td>${numberFor(r)}</td>
      <td class="td-name">${r.person}${r.is_special ? `<span class="role-tag" style="margin-left:6px;">${specialRole(r.person) || 'Líder'}</span>` : ''}</td>
      <td style="color:var(--green)">${r.whatsapp}</td>
      <td style="color:var(--accent2)">${r.ligacao_efetiva}</td>
      <td style="color:var(--amber)">${r.ligacao_nao_efetiva}</td>
      <td style="color:var(--text2)">${r.e_mail}</td>
      <td style="font-weight:600">${r.total}</td>
      <td style="color:var(--text3)">${r.criados}</td>
      <td>${r.taxa === null ? '—' : r.taxa.toFixed(1)}</td>
    </tr>`).join('');
}

function renderOutreachChart(canvasId, rows) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const regular = rows.filter(r => !r.is_special);
  if (regular.length === 0) return null;
  return new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: regular.map(r => r.person),
      datasets: [
        { label: 'Whatsapp',             data: regular.map(r => r.whatsapp),            backgroundColor: 'rgba(74,222,128,0.8)',  borderRadius:4, stack:'s' },
        { label: 'Ligação efetiva',      data: regular.map(r => r.ligacao_efetiva),     backgroundColor: 'rgba(129,140,248,0.8)', borderRadius:4, stack:'s' },
        { label: 'Ligação não efetiva',  data: regular.map(r => r.ligacao_nao_efetiva), backgroundColor: 'rgba(251,191,36,0.8)',  borderRadius:4, stack:'s' },
        { label: 'E-mail',               data: regular.map(r => r.e_mail),              backgroundColor: 'rgba(248,113,113,0.8)', borderRadius:4, stack:'s' },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position:'top', labels:{ color:'#9499b0', usePointStyle:true, font:{size:11} } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}` } }
      },
      scales: {
        x: { stacked:true, grid:{ display:false }, ticks:{ color:'#9499b0', font:{size:10} } },
        y: { stacked:true, beginAtZero:true, grid:{ color:'rgba(255,255,255,0.07)' }, ticks:{ color:'#9499b0', font:{size:10}, precision:0 } }
      }
    }
  });
}

function renderOutreachProspector() {
  const container = document.getElementById('outreach-prospector-container');
  if (!container) return;
  let rows = outreachProspectorRows();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = outreachProspectorSortKey;
  const sortDir = outreachProspectorSortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (a.is_special !== b.is_special) return a.is_special ? 1 : -1;
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
    return (av - bv) * sortDir;
  });
  const arrow = (key) => outreachProspectorSortKey===key ? `<span class="arr">${outreachProspectorSortDir==='desc'?'▼':'▲'}</span>` : '';

  const periodo = `${fmtDateLong(OUTREACH_FROM)} a ${fmtDateLong(OUTREACH_TO)}`;
  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Abordagens por Prospector / SDR</div>
        <div class="ranking-sub">Whatsapp, Ligação efetiva/não efetiva e E-mail concluídos no período · período regido por <strong>marked_as_done_time</strong> · ${periodo} · "Abord./negócio" = abordagens ÷ negócios criados no mesmo período pela mesma pessoa</div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-box-title">Volume de abordagens por tipo, por prospector</div>
      <div class="chart-box-wrap"><canvas id="outreach-prospector-chart"></canvas></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Prospector</th>
            <th class="sortable" onclick="setOutreachProspectorSort('whatsapp')">Whatsapp${arrow('whatsapp')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('ligacao_efetiva')">Lig. efetiva${arrow('ligacao_efetiva')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('ligacao_nao_efetiva')">Lig. não efetiva${arrow('ligacao_nao_efetiva')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('e_mail')">E-mail${arrow('e_mail')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('total')">Total${arrow('total')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('criados')">Negócios criados${arrow('criados')}</th>
            <th class="sortable" onclick="setOutreachProspectorSort('taxa')">Abord./negócio${arrow('taxa')}</th>
          </tr>
        </thead>
        <tbody>${outreachTableRows(rows)}</tbody>
      </table>
    </div>`;
  if (outreachProspectorChartInst) { outreachProspectorChartInst.destroy(); outreachProspectorChartInst = null; }
  outreachProspectorChartInst = renderOutreachChart('outreach-prospector-chart', rows);
}

function renderOutreachCloser() {
  const container = document.getElementById('outreach-closer-container');
  if (!container) return;
  let rows = outreachCloserRows();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = outreachCloserSortKey;
  const sortDir = outreachCloserSortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    if (a.is_special !== b.is_special) return a.is_special ? 1 : -1;
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
    return (av - bv) * sortDir;
  });
  const arrow = (key) => outreachCloserSortKey===key ? `<span class="arr">${outreachCloserSortDir==='desc'?'▼':'▲'}</span>` : '';

  const periodo = `${fmtDateLong(OUTREACH_FROM)} a ${fmtDateLong(OUTREACH_TO)}`;
  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Abordagens por Consultor</div>
        <div class="ranking-sub">Whatsapp, Ligação efetiva/não efetiva e E-mail concluídos no período · período regido por <strong>marked_as_done_time</strong> · ${periodo} · "Abord./negócio" = abordagens ÷ negócios criados no mesmo período pelo mesmo consultor</div>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-box-title">Volume de abordagens por tipo, por consultor</div>
      <div class="chart-box-wrap"><canvas id="outreach-closer-chart"></canvas></div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>Consultor</th>
            <th class="sortable" onclick="setOutreachCloserSort('whatsapp')">Whatsapp${arrow('whatsapp')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('ligacao_efetiva')">Lig. efetiva${arrow('ligacao_efetiva')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('ligacao_nao_efetiva')">Lig. não efetiva${arrow('ligacao_nao_efetiva')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('e_mail')">E-mail${arrow('e_mail')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('total')">Total${arrow('total')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('criados')">Negócios criados${arrow('criados')}</th>
            <th class="sortable" onclick="setOutreachCloserSort('taxa')">Abord./negócio${arrow('taxa')}</th>
          </tr>
        </thead>
        <tbody>${outreachTableRows(rows)}</tbody>
      </table>
    </div>`;
  if (outreachCloserChartInst) { outreachCloserChartInst.destroy(); outreachCloserChartInst = null; }
  outreachCloserChartInst = renderOutreachChart('outreach-closer-chart', rows);
}

// ─── Produtividade de Apresentações (due_date da atividade, mês operacional) ──
function renderProductivity() {
  const container = document.getElementById('productivity-container');
  let rows = activityProductivity();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = productivitySortKey;
  const sortDir = productivitySortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => productivitySortKey===key ? `<span class="arr">${productivitySortDir==='desc'?'▼':'▲'}</span>` : '';

  const dateLabel = (dateFrom || dateTo)
    ? `período filtrado (${dateFrom || '…'} a ${dateTo || '…'})`
    : 'todo o histórico carregado (defina um período acima para recortar por mês)';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Produtividade de Apresentações</div>
        <div class="ranking-sub">Filtrado por due_date da atividade (não pela data de criação do negócio) · inclui negócios herdados de meses anteriores · ${dateLabel}</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Consultor</th>
            <th class="sortable" onclick="setProductivitySort('comDecisor')">Com decisor${arrow('comDecisor')}</th>
            <th class="sortable" onclick="setProductivitySort('semDecisor')">Sem decisor${arrow('semDecisor')}</th>
            <th class="sortable" onclick="setProductivitySort('naoApresentado')">Não apresentado${arrow('naoApresentado')}</th>
            <th class="sortable" onclick="setProductivitySort('total')">Total de atividades${arrow('total')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.closer}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showActivityDeals('${r.closer.replace(/'/g,"\\'")}','d1')">${r.comDecisor}</td>
              <td class="clk" style="color:var(--amber)" onclick="showActivityDeals('${r.closer.replace(/'/g,"\\'")}','semDecisor')">${r.semDecisor}</td>
              <td class="clk" style="color:var(--red)" onclick="showActivityDeals('${r.closer.replace(/'/g,"\\'")}','naoApresentado')">${r.naoApresentado}</td>
              <td class="clk" style="color:var(--text2);font-weight:600" onclick="showActivityDeals('${r.closer.replace(/'/g,"\\'")}','total')">${r.total}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderLossReason() {
  const container = document.getElementById('lossreason-container');
  const perdidos = monthScopeForLosses();
  if (perdidos.length === 0) { container.innerHTML = ''; return; }
  let rows = lossReasonBreakdown(perdidos);
  const sortKey = lossreasonSortKey;
  const sortDir = lossreasonSortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => lossreasonSortKey===key ? `<span class="arr">${lossreasonSortDir==='desc'?'▼':'▲'}</span>` : '';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Perdas por Motivo</div>
        <div class="ranking-sub">${perdidos.length} negócios perdidos no período/funil filtrado · agregado por motivo nativo (lost_reason) · sempre mostra perdas mesmo quando o Status filtrado é Ganho/Aberto</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Motivo da Perda</th>
            <th class="sortable" onclick="setLossreasonSort('total')">Qtd.${arrow('total')}</th>
            <th class="sortable" onclick="setLossreasonSort('pct')">% das perdas${arrow('pct')}</th>
            <th class="sortable" onclick="setLossreasonSort('valor')">Valor perdido${arrow('valor')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name clk" style="max-width:320px;" onclick="showLossReasonDeals('${r.motivo.replace(/'/g,"\\'")}')">${r.motivo}</td>
              <td class="clk" style="color:var(--red);font-weight:600" onclick="showLossReasonDeals('${r.motivo.replace(/'/g,"\\'")}')">${r.total}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:var(--text2)">${(r.pct*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.pct*100,100)}%;background:var(--red)"></div></div>
                </div>
              </td>
              <td style="color:var(--text2)">${fmtCurrency(r.valor)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Qualidade de Dados (Qualificação e Gravação) ─────────────────────────────
function renderDataQuality() {
  const container = document.getElementById('dataquality-container');
  const scope = monthScope();
  if (scope.length === 0) { container.innerHTML = ''; return; }

  const q = dataQuality(scope);
  const colorFor = (pct) => pct>=0.7 ? 'var(--green)' : pct>=0.4 ? 'var(--amber)' : 'var(--red)';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Qualidade de Dados</div>
        <div class="ranking-sub">Preenchimento de campos críticos de auditoria no período/funil filtrado (${q.total} negócios)</div>
      </div>
    </div>
    <div class="dq-grid">
      <div class="dq-card">
        <div class="dq-title">Qualificação preenchida</div>
        <div class="dq-value" style="color:${colorFor(q.qualiPct)}">${q.qualiPreenchida}/${q.total}</div>
        <div class="dq-sub">${(q.qualiPct*100).toFixed(0)}% dos negócios têm Com/Sem perfil registrado</div>
        <div class="dq-bar-track"><div class="dq-bar-fill" style="width:${Math.min(q.qualiPct*100,100)}%;background:${colorFor(q.qualiPct)}"></div></div>
      </div>
      <div class="dq-card">
        <div class="dq-title">Gravação preenchida (todos)</div>
        <div class="dq-value" style="color:${colorFor(q.gravPct)}">${q.gravPreenchida}/${q.total}</div>
        <div class="dq-sub">${(q.gravPct*100).toFixed(0)}% de todos os negócios do período</div>
        <div class="dq-bar-track"><div class="dq-bar-fill" style="width:${Math.min(q.gravPct*100,100)}%;background:${colorFor(q.gravPct)}"></div></div>
      </div>
      <div class="dq-card">
        <div class="dq-title">Gravação preenchida (apresentados)</div>
        <div class="dq-value" style="color:${colorFor(q.gravApresentadosPct)}">${q.gravPreenchidaApresentados}/${q.gravApresentadosTotal}</div>
        <div class="dq-sub">${(q.gravApresentadosPct*100).toFixed(0)}% dos negócios com apresentação real auditados — métrica que importa para CONA</div>
        <div class="dq-bar-track"><div class="dq-bar-fill" style="width:${Math.min(q.gravApresentadosPct*100,100)}%;background:${colorFor(q.gravApresentadosPct)}"></div></div>
      </div>
    </div>`;
}

// ─── Conclusão de Atividades por Consultor (quem conclui atividades) ─────────
function renderCompletion() {
  const container = document.getElementById('completion-container');
  let rows = completionByCloser();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = completionSortKey;
  const sortDir = completionSortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => completionSortKey===key ? `<span class="arr">${completionSortDir==='desc'?'▼':'▲'}</span>` : '';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Conclusão de Atividades por Consultor</div>
        <div class="ranking-sub">Campo "done" do Pipedrive · cobre apenas atividades de apresentação (d1 / apresentado com decisor / nfc-e-nf-e) no período/funil filtrado — não o total de atividades do CRM · "Vencidas" = Reuniões Comerciais agendadas com data já passada e ainda sem outcome registrado</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Consultor</th>
            <th class="sortable" onclick="setCompletionSort('done')">Concluídas${arrow('done')}</th>
            <th class="sortable" onclick="setCompletionSort('pendente')">Pendentes${arrow('pendente')}</th>
            <th class="sortable" onclick="setCompletionSort('vencidas')">Vencidas${arrow('vencidas')}</th>
            <th class="sortable" onclick="setCompletionSort('total')">Total${arrow('total')}</th>
            <th class="sortable" onclick="setCompletionSort('taxa')">Taxa de conclusão${arrow('taxa')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.closer}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showCompletionDeals('${r.closer.replace(/'/g,"\\'")}',true)">${r.done}</td>
              <td class="clk" style="color:var(--amber)" onclick="showCompletionDeals('${r.closer.replace(/'/g,"\\'")}',false)">${r.pendente}</td>
              <td class="clk" style="color:var(--red);font-weight:600" onclick="showVencidasDeals('${r.closer.replace(/'/g,"\\'")}')">${r.vencidas}</td>
              <td style="color:var(--text2)">${r.total}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.taxa>=0.7?'var(--green)':r.taxa>=0.4?'var(--amber)':'var(--red)'}">${(r.taxa*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.taxa*100,100)}%;background:${r.taxa>=0.7?'var(--green)':r.taxa>=0.4?'var(--amber)':'var(--red)'}"></div></div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Atualização de Negócios por Consultor (quem atualiza negócios) ──────────
function renderStaleness() {
  const container = document.getElementById('staleness-container');
  let rows = staleByCloser();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = stalenessSortKey;
  const sortDir = stalenessSortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => stalenessSortKey===key ? `<span class="arr">${stalenessSortDir==='desc'?'▼':'▲'}</span>` : '';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Atualização de Negócios por Consultor</div>
        <div class="ranking-sub">Apenas negócios ABERTOS · "Parado" = sem atividade registrada (last_activity_date) há mais de ${STALE_DAYS} dias · ignora filtro de Status/Data, respeita Funil</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Consultor</th>
            <th class="sortable" onclick="setStalenessSort('atualizado')">Atualizados${arrow('atualizado')}</th>
            <th class="sortable" onclick="setStalenessSort('parado')">Parados${arrow('parado')}</th>
            <th class="sortable" onclick="setStalenessSort('semAtividade')">Sem atividade${arrow('semAtividade')}</th>
            <th class="sortable" onclick="setStalenessSort('total')">Total abertos${arrow('total')}</th>
            <th class="sortable" onclick="setStalenessSort('taxaParado')">% parado${arrow('taxaParado')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.closer}</td>
              <td class="clk" style="color:var(--green);font-weight:600" onclick="showStaleDeals('${r.closer.replace(/'/g,"\\'")}','atualizado')">${r.atualizado}</td>
              <td class="clk" style="color:var(--red)" onclick="showStaleDeals('${r.closer.replace(/'/g,"\\'")}','parado')">${r.parado}</td>
              <td class="clk" style="color:var(--amber)" onclick="showStaleDeals('${r.closer.replace(/'/g,"\\'")}','semAtividade')">${r.semAtividade}</td>
              <td style="color:var(--text2)">${r.total}</td>
              <td>
                <div class="conv-bar-wrap">
                  <span class="conv-pct" style="color:${r.taxaParado>=0.3?'var(--red)':r.taxaParado>=0.15?'var(--amber)':'var(--green)'}">${(r.taxaParado*100).toFixed(0)}%</span>
                  <div class="conv-bar-track"><div class="conv-bar-fill" style="width:${Math.min(r.taxaParado*100,100)}%;background:${r.taxaParado>=0.3?'var(--red)':r.taxaParado>=0.15?'var(--amber)':'var(--green)'}"></div></div>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Índice de Risco por Consultor (quem está "maquiando" a operação) ────────
function renderRisk() {
  const container = document.getElementById('risk-container');
  let rows = riskIndexByCloser();
  if (rows.length === 0) { container.innerHTML = ''; return; }
  const sortKey = riskSortKey;
  const sortDir = riskSortDir === 'desc' ? -1 : 1;
  rows = rows.slice().sort((a,b) => (a[sortKey] - b[sortKey]) * sortDir);
  const arrow = (key) => riskSortKey===key ? `<span class="arr">${riskSortDir==='desc'?'▼':'▲'}</span>` : '';

  container.innerHTML = `
    <div class="ranking-hd">
      <div>
        <div class="ranking-title">Índice de Risco por Consultor</div>
        <div class="ranking-sub">Score 0–100 combinando sinais já existentes nesta tela: ganho cancelado pós-venda (peso 30) + duplicados (peso 20) + negócios parados há mais de ${STALE_DAYS}d (peso 25) + qualificação vazia (peso 15) + gravação vazia em apresentados (peso 10) · ignora Status/Data, respeita Funil/busca · maior score = mais sinais de risco acumulados</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Consultor</th>
            <th class="sortable" onclick="setRiskSort('wonCancel')">Cancelado pós-venda${arrow('wonCancel')}</th>
            <th class="sortable" onclick="setRiskSort('dup')">Duplicados${arrow('dup')}</th>
            <th class="sortable" onclick="setRiskSort('openStale')">Parados${arrow('openStale')}</th>
            <th class="sortable" onclick="setRiskSort('qualiVazia')">Qualif. vazia${arrow('qualiVazia')}</th>
            <th class="sortable" onclick="setRiskSort('gravVazia')">Gravação vazia${arrow('gravVazia')}</th>
            <th class="sortable" onclick="setRiskSort('score')">Score${arrow('score')}</th>
            <th>Nível</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="td-name">${r.closer}</td>
              <td class="clk" style="color:var(--red)" onclick="showRiskDeals('${r.closer.replace(/'/g,"\\'")}','cancelPosVenda')">${r.wonCancel}</td>
              <td class="clk" style="color:var(--red)" onclick="showRiskDeals('${r.closer.replace(/'/g,"\\'")}','duplicados')">${r.dup}</td>
              <td class="clk" style="color:var(--amber)" onclick="showRiskDeals('${r.closer.replace(/'/g,"\\'")}','parados')">${r.openStale}</td>
              <td class="clk" style="color:var(--amber)" onclick="showRiskDeals('${r.closer.replace(/'/g,"\\'")}','qualiVazia')">${r.qualiVazia}</td>
              <td class="clk" style="color:var(--text3)" onclick="showRiskDeals('${r.closer.replace(/'/g,"\\'")}','gravVazia')">${r.gravVazia}</td>
              <td style="font-weight:700;color:${r.score>=40?'var(--red)':r.score>=20?'var(--amber)':'var(--green)'}">${r.score}</td>
              <td><span class="badge ${riskBadgeClass(r.score)}">${riskLabel(r.score)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAll() {
  if (DEALS.length === 0) return;
  renderRanking();
  renderProspector();
  renderChannel();
  renderOutreachProspector();
  renderOutreachCloser();
  renderProductivity();
  renderLossReason();
  renderNoShow();
  renderDataQuality();
  renderCompletion();
  renderStaleness();
  renderRisk();
  const container  = document.getElementById('consultores-container');
  // Inclui inativos/ex-consultores em "Todos" — eles não competem como ativos,
  // mas seus negócios (incl. cancelados) continuam tendo bloco de detalhe.
  const closersToShow = activeCloser === 'todos' ? [...CLOSERS, ...INACTIVE_CLOSER_NAMES] : [activeCloser];

  let html = '';
  closersToShow.forEach(closer => {
    const list = getFiltered(closer);
    if (list.length === 0 && activeCloser !== 'todos') {
      html += `<div style="color:var(--text3);font-size:13px;padding:20px 0;">Nenhum negócio encontrado com o filtro atual.</div>`;
      return;
    }
    if (list.length === 0) return;

    const colors   = CLOSER_COLORS[closer] || COLOR_PALETTE[0];
    const overdue  = list.filter(isOverdue).length;
    const initials = closer.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();

    html += `<div class="consultor-block" id="bloco-${closer.replace(/\s/g,'-')}">
      <div class="consultor-header">
        <div class="consultor-avatar" style="background:${colors.avatar};color:${colors.text};">${initials}</div>
        <div>
          <div class="consultor-name">${closer}${INACTIVE_CLOSER_NAMES.includes(closer) ? '<span class="inactive-tag">Inativo</span>' : ''}</div>
          <div class="consultor-sub">${list.length} negócio${list.length!==1?'s':''} · ${(statusFilter==='all'?DEALS:DEALS.filter(d=>d.status===statusFilter)).filter(d=>d.closer===closer).filter(d=>funilFilter==='todos'||d.funil===funilFilter).length} no total (${statusFilter==='open'?'abertos':statusFilter==='won'?'ganhos':statusFilter==='lost'?'perdidos':'todos'})</div>
        </div>
        <div class="consultor-badges">
          ${overdue > 0
            ? `<span class="badge badge-red">⚠ ${overdue} vencido${overdue>1?'s':''}</span>`
            : '<span class="badge badge-green">Em dia</span>'}
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Empresa</th>
              <th>Funil</th>
              <th>SDR</th>
              <th>Etapa</th>
              <th>Criado</th>
              <th>${statusFilter==='won' ? 'Data Ganho' : statusFilter==='lost' ? 'Data Perda' : 'Prev. Fechamento'}</th>
              <th>Últ. Contato</th>
              <th>Atos</th>
              ${statusFilter==='won' ? '<th>Ciclo</th><th>MRR</th><th>Implantação</th>' : ''}
              ${statusFilter==='lost' ? '<th>Motivo da Perda</th>' : ''}
              ${(statusFilter==='lost' || statusFilter==='all') ? '<th>Valor</th>' : ''}
              <th>Pipe</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(d => {
              const dup = isDup(d) ? '<span class="dup-tag">dup</span>' : '';
              const od  = isOverdue(d);
              const cancelAlert = hasCancelLabel(d) ? '<span class="badge badge-red" style="margin-left:5px;" title="Ganho com etiqueta de cancelamento">⚠ cancelado pós-venda</span>' : '';
              return `<tr class="${od?'row-overdue':''}" onclick="openModal(${d.id})">
                <td class="td-id">#${d.id}</td>
                <td class="td-name">${d.name}${dup}</td>
                <td>${funilBadge(d.funil)}</td>
                <td style="font-size:11px;color:var(--text3)">${d.creator}</td>
                <td>${stageBadge(d.stage)}</td>
                <td style="font-size:11px;color:var(--text3)">${fmt(d.add)}</td>
                <td>${statusFilter==='won' ? (fmt(d.won_time) || '—') : statusFilter==='lost' ? (fmt(d.lost_time) || '—') : urgHtml(d.ec)}</td>
                <td style="font-size:11px;color:var(--text3)">${fmt(d.last_act)}</td>
                <td style="font-size:11px;color:var(--text3);text-align:center">${d.acts}</td>
                ${statusFilter==='won' ? `<td>${labelBadge(d.label_ids)}${cancelAlert}</td><td style="font-size:11px;color:var(--green)">${fmtCurrency(d.mrr)}</td><td style="font-size:11px;color:var(--green)">${fmtCurrency(d.implantacao)}</td>` : ''}
                ${statusFilter==='lost' ? `<td style="font-size:11px;color:var(--text2);max-width:200px;">${d.lost_reason ? d.lost_reason : '<span style="color:var(--text3);font-style:italic">não informado</span>'}</td>` : ''}
                ${(statusFilter==='lost' || statusFilter==='all') ? `<td style="font-size:11px;color:var(--text2)">${fmtCurrency(d.value)}</td>` : ''}
                <td onclick="event.stopPropagation()">
                  <a class="pipe-link" href="${PIPE_BASE}${d.id}" target="_blank" rel="noopener">↗ Pipe</a>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  });

  container.innerHTML = html || '<div style="color:var(--text3);padding:20px 0;font-size:13px;">Nenhum negócio encontrado.</div>';
}

// ─── Nav / filtros ────────────────────────────────────────────────────────────
function navTo(closer, el) {
  showDashboardPage();
  activeCloser = closer === 'vencidos' ? 'todos' : closer;
  if (closer === 'vencidos') { onlyVenc = true;  document.getElementById('btn-venc').classList.add('on'); }
  else                       { onlyVenc = false; document.getElementById('btn-venc').classList.remove('on'); }
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  renderAll();
  window.scrollTo({ top:0, behavior:'smooth' });
}

function navToCloserByName(name) {
  const safeid = 'nc-' + name.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  const countEl = document.getElementById(safeid);
  const btn = countEl ? countEl.closest('.nav-item') : null;
  navTo(name, btn);
}

function toggleVenc() {
  onlyVenc = !onlyVenc;
  document.getElementById('btn-venc').classList.toggle('on', onlyVenc);
  renderAll();
}

// ─── Filtro de status ──────────────────────────────────────────────────────────
function setStatusFilter(status) {
  statusFilter = status;
  ['open','won','lost','all'].forEach(s => {
    document.getElementById('status-'+s).classList.toggle('on', s === status);
  });

  const label = document.getElementById('date-filter-label');
  if (status === 'won')       label.textContent = 'Ganho em:';
  else if (status === 'lost') label.textContent = 'Perdido em:';
  else if (status === 'open') label.textContent = 'Criado em:';
  else                         label.textContent = 'Data de referência:';

  const titles = {
    open: 'Negócios Abertos por Consultor',
    won:  'Negócios Ganhos por Consultor',
    lost: 'Negócios Perdidos por Consultor',
    all:  'Todos os Negócios por Consultor',
  };
  document.getElementById('page-title').textContent = titles[status];

  // KPI labels dinâmicos
  const totalLabels = {
    open: 'Total abertos', won: 'Total ganhos', lost: 'Total perdidos', all: 'Total geral'
  };
  document.getElementById('k-total-label').textContent = totalLabels[status];

  const vencLabel = document.getElementById('k-venc-label');
  const semDataLabel = document.getElementById('k-semdata-label');
  if (status === 'open') {
    vencLabel.textContent = 'Vencidos';
    semDataLabel.textContent = 'Sem data prev.';
  } else {
    vencLabel.textContent = 'Vencidos (n/a)';
    semDataLabel.textContent = 'Sem data prev.';
  }

  // KPIs de valor: mostrar apenas quando relevante (won/lost/all)
  document.getElementById('kpi-valores').style.display = (status === 'open') ? 'none' : 'flex';
  document.getElementById('k-mrr').parentElement.style.display       = (status === 'lost') ? 'none' : '';
  document.getElementById('k-implant').parentElement.style.display   = (status === 'lost') ? 'none' : '';
  document.getElementById('k-valor-total').parentElement.style.display = (status === 'lost') ? 'none' : '';
  document.getElementById('k-valor-perdido').parentElement.style.display = (status === 'won') ? 'none' : '';

  const valorTotalLabel = document.getElementById('k-valor-total-label');
  valorTotalLabel.textContent = status === 'all' ? 'Valor total ganho' : 'Valor total ganho';

  renderAll();
  rebuildNavCounts();
  updateKPIs();
}

// ─── Filtro de funil ───────────────────────────────────────────────────────────
function setFunilFilter() {
  funilFilter = document.getElementById('funil-select').value;
  renderAll();
  rebuildNavCounts();
  updateKPIs();
}

// ─── Filtro de data: dropdown de período estilo Pipedrive ────────────────────
// activeDatePreset guarda qual opção do dropdown está selecionada. dateFrom/
// dateTo continuam sendo a fonte da verdade usada por inDateRange/getFiltered/
// rebuildNavCounts/loadData — o preset só é uma forma mais rápida de preenchê-los.
let activeDatePreset = 'este_mes';

const DATE_PRESET_LABELS = {
  hoje: 'Hoje',
  ontem: 'Ontem',
  esta_semana: 'Esta semana',
  semana_passada: 'Semana passada',
  este_mes: 'Este mês',
  mes_passado: 'Mês passado',
  este_trimestre: 'Este trimestre',
  este_ano: 'Este ano',
  todo_periodo: 'Todo o período',
  personalizado: 'Personalizado',
};

function pad2(n) { return String(n).padStart(2, '0'); }
function dateToISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoToBR(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Calcula {from, to} (strings ISO yyyy-mm-dd) para cada preset, sempre a
// partir do instante real ("agora"), não de TODAY (que só é atualizado a
// cada loadData() — aqui queremos sempre o dia corrente, mesmo antes do 1º load).
function computePresetRange(key) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  switch (key) {
    case 'hoje': {
      const t = new Date(y, m, d);
      return { from: dateToISO(t), to: dateToISO(t) };
    }
    case 'ontem': {
      const t = new Date(y, m, d - 1);
      return { from: dateToISO(t), to: dateToISO(t) };
    }
    case 'esta_semana': {
      const dow = now.getDay(); // 0=domingo
      const diffToMonday = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(y, m, d + diffToMonday);
      const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
      return { from: dateToISO(monday), to: dateToISO(sunday) };
    }
    case 'semana_passada': {
      const dow = now.getDay();
      const diffToMonday = dow === 0 ? -6 : 1 - dow;
      const thisMonday = new Date(y, m, d + diffToMonday);
      const lastMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
      const lastSunday = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() + 6);
      return { from: dateToISO(lastMonday), to: dateToISO(lastSunday) };
    }
    case 'este_mes': {
      return { from: dateToISO(new Date(y, m, 1)), to: dateToISO(new Date(y, m + 1, 0)) };
    }
    case 'mes_passado': {
      return { from: dateToISO(new Date(y, m - 1, 1)), to: dateToISO(new Date(y, m, 0)) };
    }
    case 'este_trimestre': {
      const q = Math.floor(m / 3);
      return { from: dateToISO(new Date(y, q * 3, 1)), to: dateToISO(new Date(y, q * 3 + 3, 0)) };
    }
    case 'este_ano': {
      return { from: dateToISO(new Date(y, 0, 1)), to: dateToISO(new Date(y, 11, 31)) };
    }
    case 'todo_periodo':
    default:
      return { from: null, to: null };
  }
}

function toggleDateDropdown() {
  const panel = document.getElementById('date-filter-panel');
  const trigger = document.getElementById('date-filter-trigger');
  if (!panel || !trigger) return;
  const open = panel.classList.toggle('open');
  trigger.classList.toggle('open', open);
}

function closeDateDropdown() {
  const panel = document.getElementById('date-filter-panel');
  const trigger = document.getElementById('date-filter-trigger');
  if (panel) panel.classList.remove('open');
  if (trigger) trigger.classList.remove('open');
}

function updateActivePresetItem() {
  document.querySelectorAll('.date-preset-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === activeDatePreset);
  });
}

function updateDateTriggerLabel() {
  const el = document.getElementById('date-filter-trigger-label');
  if (!el) return;
  if (activeDatePreset === 'personalizado') {
    el.textContent = (dateFrom || dateTo)
      ? `${isoToBR(dateFrom) || '…'} - ${isoToBR(dateTo) || '…'}`
      : 'Personalizar período';
  } else {
    el.textContent = DATE_PRESET_LABELS[activeDatePreset] || 'Período';
  }
}

// Usuário escolheu um item do dropdown. "personalizado" só abre o painel de
// datas manuais (a aplicação de fato acontece em applyCustomDateRange, ao
// clicar em "Aplicar período") — os demais presets aplicam e fecham na hora.
function selectDatePreset(key) {
  const customPanel = document.getElementById('date-custom-panel');
  if (key === 'personalizado') {
    activeDatePreset = 'personalizado';
    updateActivePresetItem();
    if (customPanel) customPanel.style.display = 'flex';
    const cur = (dateFrom || dateTo) ? { from: dateFrom, to: dateTo } : computePresetRange('este_mes');
    const fromEl = document.getElementById('date-from');
    const toEl   = document.getElementById('date-to');
    if (fromEl) fromEl.value = cur.from || '';
    if (toEl)   toEl.value   = cur.to   || '';
    updateDateTriggerLabel();
    return;
  }
  if (customPanel) customPanel.style.display = 'none';
  activeDatePreset = key;
  const range = computePresetRange(key);
  dateFrom = range.from;
  dateTo   = range.to;
  const fromEl = document.getElementById('date-from');
  const toEl   = document.getElementById('date-to');
  if (fromEl) fromEl.value = dateFrom || '';
  if (toEl)   toEl.value   = dateTo   || '';
  updateActivePresetItem();
  updateDateTriggerLabel();
  closeDateDropdown();
  renderAll();
  rebuildNavCounts();
  updateKPIs();
}

// Confirma o período manual (painel "Personalizar período…").
function applyCustomDateRange() {
  dateFrom = document.getElementById('date-from').value || null;
  dateTo   = document.getElementById('date-to').value   || null;
  activeDatePreset = 'personalizado';
  updateActivePresetItem();
  updateDateTriggerLabel();
  closeDateDropdown();
  renderAll();
  rebuildNavCounts();
  updateKPIs();
}

// Atualiza só o rótulo do botão enquanto o usuário ajusta as datas manuais —
// a filtragem real só roda ao clicar em "Aplicar período" (evita re-renderizar
// tudo a cada seleção parcial de data).
function onCustomDateInputChange() {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  const el = document.getElementById('date-filter-trigger-label');
  if (el) el.textContent = (from || to) ? `${isoToBR(from) || '…'} - ${isoToBR(to) || '…'}` : 'Personalizar período';
}

// Garante que o mês vigente já vem selecionado por padrão sempre que o app
// inicia — chamado antes do primeiro loadData() (afeta também o corte inicial
// da busca de atividades) e novamente após logout, para a próxima sessão
// começar limpa.
function applyDefaultDatePreset() {
  activeDatePreset = 'este_mes';
  const range = computePresetRange('este_mes');
  dateFrom = range.from;
  dateTo   = range.to;
  const fromEl = document.getElementById('date-from');
  const toEl   = document.getElementById('date-to');
  if (fromEl) fromEl.value = dateFrom || '';
  if (toEl)   toEl.value   = dateTo   || '';
  const customPanel = document.getElementById('date-custom-panel');
  if (customPanel) customPanel.style.display = 'none';
  updateActivePresetItem();
  updateDateTriggerLabel();
}

// Mantidos por compatibilidade (nomes antigos usados em algum momento por
// onchange/onclick) — agora apenas delegam para a lógica nova do dropdown.
function applyDateFilter() { applyCustomDateRange(); }
function clearDateFilter() { selectDatePreset('todo_periodo'); }

// Fecha o dropdown ao clicar fora dele ou pressionar Esc.
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('date-filter-wrap');
  if (wrap && !wrap.contains(e.target)) closeDateDropdown();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDateDropdown();
});

// ─── Recalcular contadores da nav conforme filtros ativos ─────────────────────
function rebuildNavCounts() {
  let base = DEALS;
  if (statusFilter !== 'all') base = base.filter(d => d.status === statusFilter);
  if (funilFilter  !== 'todos') base = base.filter(d => d.funil === funilFilter);
  base = base.filter(inDateRange);

  const totalEl = document.getElementById('nav-count-todos');
  if (totalEl) totalEl.textContent = base.length;

  [...CLOSERS, ...INACTIVE_CLOSER_NAMES, ...SPECIAL_NAMES].forEach(c => {
    const safeid = 'nc-' + c.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
    const el = document.getElementById(safeid);
    if (el) el.textContent = base.filter(d => d.closer === c).length;
  });

  // Re-segmentar quem tem/não tem negócios no escopo atual e atualizar contagem do grupo colapsável
  const nEmpty = CLOSERS.filter(c => base.filter(d=>d.closer===c).length === 0).length;
  const toggle = document.getElementById('empty-toggle');
  const label  = document.getElementById('empty-toggle-label');
  if (toggle && label) {
    label.textContent = `Sem negócios no filtro (${nEmpty})`;
    toggle.style.display = nEmpty > 0 ? '' : 'none';
  }
  CLOSERS.forEach(c => {
    const isEmpty = base.filter(d=>d.closer===c).length === 0;
    const btn = [...document.querySelectorAll('#nav-closers .nav-item, #nav-closers-empty .nav-item')]
      .find(b => b.getAttribute('onclick') === `navTo('${c.replace(/'/g,"\\'")}',this)`);
    if (btn) btn.classList.toggle('dim', isEmpty);
  });
  INACTIVE_CLOSER_NAMES.forEach(c => {
    const isEmpty = base.filter(d=>d.closer===c).length === 0;
    const btn = [...document.querySelectorAll('#nav-inactive .nav-item')]
      .find(b => b.getAttribute('onclick') === `navTo('${c.replace(/'/g,"\\'")}',this)`);
    if (btn) btn.classList.toggle('dim', isEmpty);
  });
}

function applySearch() {
  searchTerm = document.getElementById('globalSearch').value.toLowerCase();
  renderAll();
}

// ─── Modal ───────────────────────────────────────────────────────────────────
function openModal(id) {
  const d = DEALS.find(x => x.id === id);
  if (!d) return;
  const diff = d.ec ? daysDiff(d.ec) : null;
  let urgText = '—';
  if (diff === null) urgText = '<span style="color:var(--text3)">Sem data definida</span>';
  else if (diff === 0) urgText = '<span style="color:var(--amber);font-weight:600">HOJE</span>';
  else if (diff > 0)   urgText = `<span style="color:var(--red);font-weight:600">⚠ ${diff} dias vencido</span>`;
  else                 urgText = `<span style="color:var(--text3)">Faltam ${Math.abs(diff)} dias (${fmt(d.ec)})</span>`;

  const dups = DEALS.filter(x => x.name.toLowerCase() === d.name.toLowerCase() && x.id !== d.id);
  const dupSection = dups.length ? `
    <hr class="modal-divider">
    <div style="font-size:9px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--purple);margin-bottom:8px;">Outros negócios · mesmo cliente</div>
    ${dups.map(x => `<div style="font-size:11px;color:var(--text2);padding:3px 0;">#${x.id} · ${x.funil} · ${x.closer} · ${STAGES[x.stage]||x.stage}</div>`).join('')}` : '';

  document.getElementById('m-title').textContent = d.name;
  document.getElementById('m-sub').textContent   = `#${d.id} · ${d.funil} · ${STAGES[d.stage]||d.stage} · ${d.closer}`;
  document.getElementById('m-body').innerHTML = `
    <div class="modal-row"><span class="modal-key">Funil</span><span class="modal-val">${funilBadge(d.funil)}</span></div>
    <div class="modal-row"><span class="modal-key">Etapa</span><span class="modal-val">${stageBadge(d.stage)}</span></div>
    <div class="modal-row"><span class="modal-key">Consultor</span><span class="modal-val">${d.closer}</span></div>
    <div class="modal-row"><span class="modal-key">SDR / Criador</span><span class="modal-val">${d.creator}</span></div>
    <div class="modal-row"><span class="modal-key">Prospector</span><span class="modal-val">${d.prospector || '<span style="color:var(--text3)">não informado</span>'}</span></div>
    <div class="modal-row"><span class="modal-key">Criado em</span><span class="modal-val">${d.add}</span></div>
    <div class="modal-row"><span class="modal-key">Prev. fechamento</span><span class="modal-val">${urgText}</span></div>
    <div class="modal-row"><span class="modal-key">Último contato</span><span class="modal-val">${d.last_act||'Sem registro'}</span></div>
    <div class="modal-row"><span class="modal-key">Atividades</span><span class="modal-val">${d.acts}</span></div>
    <div class="modal-row"><span class="modal-key">Qualificação</span><span class="modal-val">${qualiBadge(d.qualificacao)}</span></div>
    <div class="modal-row"><span class="modal-key">Gravação</span><span class="modal-val">${gravBadge(d.gravacao)}</span></div>
    ${d.status==='lost' ? `<div class="modal-row"><span class="modal-key">Motivo da perda</span><span class="modal-val">${d.lost_reason || 'não informado'}</span></div>` : ''}
    ${d.status==='won' ? `<div class="modal-row"><span class="modal-key">Etiqueta de ciclo</span><span class="modal-val">${labelBadge(d.label_ids)}</span></div>` : ''}
    <hr class="modal-divider">
    <div class="modal-row"><span class="modal-key">Valor do negócio</span><span class="modal-val">${fmtCurrency(d.value)}</span></div>
    ${d.status==='won' ? `
    <div class="modal-row"><span class="modal-key">MRR (mensalidade inicial)</span><span class="modal-val">${fmtCurrency(d.mrr)}</span></div>
    <div class="modal-row"><span class="modal-key">Mensalidade atual</span><span class="modal-val">${fmtCurrency(d.mrr_atual)}</span></div>
    <div class="modal-row"><span class="modal-key">Implantação</span><span class="modal-val">${fmtCurrency(d.implantacao)}</span></div>
    ` : ''}
    ${dupSection}
    <div class="modal-cta">
      <a class="btn-pipe" href="${PIPE_BASE}${d.id}" target="_blank" rel="noopener">↗ Abrir no Pipedrive</a>
    </div>`;
  document.getElementById('dealModal').classList.add('open');
}

function closeModal(e) {
  if (e.target === document.getElementById('dealModal'))
    document.getElementById('dealModal').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Relatórios personalizados (estilo Pipedrive Insights) ─────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Catálogo de campos disponíveis por fonte de dados — espelha exatamente o
// whitelist de public._report_field_sql() no Supabase. Não adicionar chaves
// aqui sem adicionar o mapeamento correspondente na função SQL primeiro.
const DEALS_FIELDS = [
  { key:'id', label:'ID', type:'number' },
  { key:'title', label:'Título', type:'text' },
  { key:'value', label:'Valor', type:'number' },
  { key:'weighted_value', label:'Valor ponderado', type:'number' },
  { key:'status', label:'Status', type:'text' },
  { key:'stage', label:'Etapa', type:'text' },
  { key:'pipeline', label:'Funil', type:'text' },
  { key:'owner', label:'Responsável', type:'text' },
  { key:'creator', label:'Criador', type:'text' },
  { key:'person', label:'Pessoa', type:'text' },
  { key:'organization', label:'Organização', type:'text' },
  { key:'origin', label:'Origem', type:'text' },
  { key:'lost_reason', label:'Motivo da perda', type:'text' },
  { key:'add_time', label:'Criado em', type:'date' },
  { key:'update_time', label:'Atualizado em', type:'date' },
  { key:'close_time', label:'Fechado em', type:'date' },
  { key:'won_time', label:'Ganho em', type:'date' },
  { key:'expected_close_date', label:'Previsão de fechamento', type:'date' },
  { key:'probability', label:'Probabilidade', type:'number' },
  { key:'activities_count', label:'Qtd. atividades', type:'number' },
  { key:'products_count', label:'Qtd. produtos', type:'number' },
  { key:'is_archived', label:'Arquivado', type:'boolean' },
];
const ACTIVITIES_FIELDS = [
  { key:'id', label:'ID', type:'number' },
  { key:'type', label:'Tipo', type:'text' },
  { key:'done', label:'Concluída', type:'boolean' },
  { key:'owner', label:'Responsável', type:'text' },
  { key:'person', label:'Pessoa', type:'text' },
  { key:'organization', label:'Organização', type:'text' },
  { key:'due_date', label:'Data prevista', type:'date' },
  { key:'add_time', label:'Criada em', type:'date' },
  { key:'marked_as_done_time', label:'Concluída em', type:'date' },
  { key:'subject', label:'Assunto', type:'text' },
];
function fieldsFor(entity) { return entity === 'activities' ? ACTIVITIES_FIELDS : DEALS_FIELDS; }

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ─── Navegação entre Dashboard e Relatórios ────────────────────────────────
function showDashboardPage() {
  document.getElementById('dashboard-page').style.display = '';
  document.getElementById('reports-page').style.display = 'none';
}

function showReportsPage(el) {
  document.getElementById('dashboard-page').style.display = 'none';
  document.getElementById('reports-page').style.display = '';
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  backToReportsList();
  loadReportsList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function backToReportsList() {
  document.getElementById('report-viewer-view').style.display = 'none';
  document.getElementById('report-builder-view').style.display = 'none';
  document.getElementById('reports-list-view').style.display = '';
}
// ─── Listagem de relatórios ─────────────────────────────────────────────────
let REPORTS = [];

async function loadReportsList() {
  document.getElementById('reports-state-loading').classList.add('visible');
  document.getElementById('reports-state-error').classList.remove('visible');
  document.getElementById('reports-state-empty').classList.remove('visible');
  document.getElementById('reports-list-container').innerHTML = '';

  const { data, error } = await sb.from('reports').select('*').order('updated_at', { ascending: false });

  document.getElementById('reports-state-loading').classList.remove('visible');

  if (error) {
    document.getElementById('reports-state-error').classList.add('visible');
    document.getElementById('reports-state-error-desc').textContent = error.message;
    return;
  }

  REPORTS = data || [];
  if (!REPORTS.length) {
    document.getElementById('reports-state-empty').classList.add('visible');
    return;
  }
  renderReportsList();
}

function renderReportsList() {
  const c = document.getElementById('reports-list-container');
  c.innerHTML = REPORTS.map(r => {
    const isOwner = r.owner_id === CURRENT_USER.id;
    const badges = `<span class="badge ${isOwner ? 'badge-green' : 'badge-blue'}">${isOwner ? 'Meu relatório' : 'Compartilhado comigo'}</span>`
      + `<span class="badge badge-gray">${r.entity === 'deals' ? 'Negócios' : 'Atividades'}</span>`
      + (r.is_public ? '<span class="badge badge-amber">Link público</span>' : '');
    const updated = r.updated_at ? new Date(r.updated_at).toLocaleDateString('pt-BR') : '—';
    return `<div class="report-card" onclick="openReportFromList('${r.id}')">
      <div class="report-card-title">${escHtml(r.name || 'Sem título')}</div>
      <div class="report-card-desc">${escHtml(r.description || '')}</div>
      <div class="report-card-badges">${badges}</div>
      <div class="report-card-meta">Por ${escHtml(r.owner_email || '—')} · atualizado em ${updated}</div>
      ${isOwner ? `<div class="report-card-actions" onclick="event.stopPropagation()">
        <button class="btn-icon-sm" onclick="openReportBuilder('${r.id}')">✏️ Editar</button>
        <button class="btn-icon-sm" onclick="openShareDialogById('${r.id}')">🔗 Compartilhar</button>
        <button class="btn-icon-sm" onclick="deleteReportConfirm('${r.id}')">🗑️</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function openReportFromList(id) {
  const report = REPORTS.find(r => r.id === id);
  if (report) openReportViewer(report);
}

// ─── Visualizador de relatório ──────────────────────────────────────────────
async function openReportViewer(report) {
  document.getElementById('reports-list-view').style.display = 'none';
  document.getElementById('report-builder-view').style.display = 'none';
  document.getElementById('report-viewer-view').style.display = '';
  document.getElementById('rv-name').textContent = report.name || 'Sem título';
  document.getElementById('rv-description').textContent = report.description || '';
  const box = document.getElementById('rv-box');
  box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><div class="spinner"></div></div>';

  const { data, error } = await sb.rpc('run_report', { p_entity: report.entity, p_config: report.config || {} });
  if (error) { box.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro ao carregar: ${escHtml(error.message)}</span>`; return; }
  if (data && data.error) { box.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro: ${escHtml(data.error)}</span>`; return; }

  const chartType = (report.config && report.config.chart_type) || 'bar';
  const hasSeg = !!(report.config && report.config.segment_by && report.config.segment_by.field);
  renderReportOutput(box, data.rows || [], chartType, hasSeg, 'viewer');
}

// ─── Construtor de relatório ────────────────────────────────────────────────
let editingReportId = null;
let RB_FILTERS = [];
let RB_CHART_TYPE = 'bar';

function resetBuilderForm() {
  document.getElementById('rb-name').value = '';
  document.getElementById('rb-description').value = '';
  document.getElementById('rb-entity').value = 'deals';
  RB_FILTERS = [];
  populateFieldSelects();
  renderFilterRows();
  setChartType('bar');
  document.getElementById('rb-preview-box').innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><span style="color:var(--text3);font-size:12px;">Clique em "Atualizar prévia" para ver os dados.</span></div>';
}

function openReportBuilder(id) {
  editingReportId = id || null;
  document.getElementById('reports-list-view').style.display = 'none';
  document.getElementById('report-viewer-view').style.display = 'none';
  document.getElementById('report-builder-view').style.display = '';
  document.getElementById('rb-heading').textContent = id ? 'Editar Relatório' : 'Novo Relatório';

  if (!id) { resetBuilderForm(); return; }

  const report = REPORTS.find(r => r.id === id);
  if (!report) { closeReportBuilder(); return; }

  document.getElementById('rb-name').value = report.name || '';
  document.getElementById('rb-description').value = report.description || '';
  document.getElementById('rb-entity').value = report.entity;
  populateFieldSelects();

  const cfg = report.config || {};
  if (cfg.measure && cfg.measure.field) {
    document.getElementById('rb-measure-field').value = cfg.measure.field;
    onMeasureFieldChange();
    document.getElementById('rb-measure-agg').value = cfg.measure.agg || 'sum';
  }
  if (cfg.group_by && cfg.group_by.field) {
    document.getElementById('rb-group-field').value = cfg.group_by.field;
    onGroupFieldChange();
    if (cfg.group_by.date_part) document.getElementById('rb-group-datepart').value = cfg.group_by.date_part;
  }
  if (cfg.segment_by && cfg.segment_by.field) {
    document.getElementById('rb-seg-field').value = cfg.segment_by.field;
    onSegFieldChange();
    if (cfg.segment_by.date_part) document.getElementById('rb-seg-datepart').value = cfg.segment_by.date_part;
  }
  RB_FILTERS = (cfg.filters || []).map(f => ({
    field: f.field, op: f.op,
    value: (Array.isArray(f.value) && f.op === 'in') ? f.value.join(', ') : f.value,
  }));
  renderFilterRows();
  setChartType(cfg.chart_type || 'bar');
  document.getElementById('rb-preview-box').innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><span style="color:var(--text3);font-size:12px;">Clique em "Atualizar prévia" para ver os dados.</span></div>';
}

function closeReportBuilder() {
  editingReportId = null;
  document.getElementById('report-builder-view').style.display = 'none';
  document.getElementById('reports-list-view').style.display = '';
}

function populateFieldSelects() {
  const entity = document.getElementById('rb-entity').value;
  const fields = fieldsFor(entity);

  const measureSel = document.getElementById('rb-measure-field');
  measureSel.innerHTML = '<option value="">— Apenas contar registros —</option>' + fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');
  onMeasureFieldChange();

  const groupSel = document.getElementById('rb-group-field');
  groupSel.innerHTML = '<option value="">— Sem agrupamento (total geral) —</option>' + fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');
  onGroupFieldChange();

  const segSel = document.getElementById('rb-seg-field');
  segSel.innerHTML = '<option value="">— Nenhum —</option>' + fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');
  onSegFieldChange();
}

function onBuilderEntityChange() {
  populateFieldSelects();
  RB_FILTERS = [];
  renderFilterRows();
}

function aggOptionsFor(fieldKey, entity) {
  if (!fieldKey) return [{ key:'count', label:'Contagem de registros' }];
  const f = fieldsFor(entity).find(x => x.key === fieldKey);
  const t = f ? f.type : 'text';
  const opts = [{ key:'count', label:'Contagem' }, { key:'count_distinct', label:'Contagem distinta' }];
  if (t === 'number') opts.push({ key:'sum', label:'Soma' }, { key:'avg', label:'Média' }, { key:'min', label:'Mínimo' }, { key:'max', label:'Máximo' });
  if (t === 'date') opts.push({ key:'min', label:'Mais antigo' }, { key:'max', label:'Mais recente' });
  return opts;
}

function onMeasureFieldChange() {
  const entity = document.getElementById('rb-entity').value;
  const fieldKey = document.getElementById('rb-measure-field').value;
  const aggSel = document.getElementById('rb-measure-agg');
  const opts = aggOptionsFor(fieldKey, entity);
  aggSel.innerHTML = opts.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
  aggSel.value = !fieldKey ? 'count' : (opts.some(o => o.key === 'sum') ? 'sum' : opts[0].key);
}

function onGroupFieldChange() {
  const entity = document.getElementById('rb-entity').value;
  const fieldKey = document.getElementById('rb-group-field').value;
  const f = fieldsFor(entity).find(x => x.key === fieldKey);
  document.getElementById('rb-group-datepart-wrap').style.display = (f && f.type === 'date') ? 'flex' : 'none';
}

function onSegFieldChange() {
  const entity = document.getElementById('rb-entity').value;
  const fieldKey = document.getElementById('rb-seg-field').value;
  const f = fieldsFor(entity).find(x => x.key === fieldKey);
  document.getElementById('rb-seg-datepart-wrap').style.display = (f && f.type === 'date') ? 'flex' : 'none';
}

// ─── Filtros dinâmicos do construtor ───────────────────────────────────────
function FILTER_OPS_BY_TYPE(type) {
  const base = [
    { key:'eq', label:'igual a' }, { key:'neq', label:'diferente de' },
    { key:'is_null', label:'está vazio' }, { key:'is_not_null', label:'não está vazio' },
    { key:'in', label:'está na lista' },
  ];
  if (type === 'number' || type === 'date') {
    base.splice(2, 0,
      { key:'gt', label:'maior que' }, { key:'gte', label:'maior ou igual a' },
      { key:'lt', label:'menor que' }, { key:'lte', label:'menor ou igual a' },
      { key:'between', label:'entre' });
  }
  if (type === 'text') base.splice(2, 0, { key:'contains', label:'contém' });
  return base;
}

function renderFilterRows() {
  const c = document.getElementById('rb-filters-container');
  const entity = document.getElementById('rb-entity').value;
  const fields = fieldsFor(entity);
  if (!RB_FILTERS.length) {
    c.innerHTML = '<div style="font-size:11px;color:var(--text3);margin-bottom:8px;">Nenhum filtro adicionado.</div>';
    return;
  }
  c.innerHTML = RB_FILTERS.map((f, idx) => {
    const fieldOpts = fields.map(fl => `<option value="${fl.key}" ${f.field === fl.key ? 'selected' : ''}>${fl.label}</option>`).join('');
    const fieldDef = fields.find(fl => fl.key === f.field) || fields[0];
    const ftype = fieldDef ? fieldDef.type : 'text';
    const opOpts = FILTER_OPS_BY_TYPE(ftype).map(o => `<option value="${o.key}" ${f.op === o.key ? 'selected' : ''}>${o.label}</option>`).join('');
    const needsValue = !['is_null', 'is_not_null'].includes(f.op);
    const isBetween = f.op === 'between';
    let valueHtml = '';
    if (isBetween) {
      const parts = Array.isArray(f.value) ? f.value : ['', ''];
      const inputType = ftype === 'date' ? 'date' : 'text';
      valueHtml = `<input type="${inputType}" value="${escHtml(parts[0] || '')}" placeholder="de" onchange="updateFilterValue(${idx},0,this.value)" style="width:120px;">`
        + `<input type="${inputType}" value="${escHtml(parts[1] || '')}" placeholder="até" onchange="updateFilterValue(${idx},1,this.value)" style="width:120px;">`;
    } else if (needsValue && ftype === 'boolean') {
      valueHtml = `<select onchange="updateFilterValue(${idx},null,this.value)">
        <option value="true" ${f.value === 'true' ? 'selected' : ''}>Sim</option>
        <option value="false" ${f.value === 'false' ? 'selected' : ''}>Não</option>
      </select>`;
    } else if (needsValue) {
      const inputType = ftype === 'date' ? 'date' : (ftype === 'number' ? 'number' : 'text');
      valueHtml = `<input type="${inputType}" value="${escHtml(f.value == null ? '' : f.value)}" placeholder="${f.op === 'in' ? 'valor1, valor2, ...' : 'valor'}" onchange="updateFilterValue(${idx},null,this.value)" style="width:160px;">`;
    }
    return `<div class="filter-row">
      <select onchange="updateFilterField(${idx},this.value)">${fieldOpts}</select>
      <select onchange="updateFilterOp(${idx},this.value)">${opOpts}</select>
      ${valueHtml}
      <button class="rm-filter" onclick="removeFilterRow(${idx})" title="Remover">✕</button>
    </div>`;
  }).join('');
}

function addFilterRow() {
  const entity = document.getElementById('rb-entity').value;
  const fields = fieldsFor(entity);
  RB_FILTERS.push({ field: fields[0].key, op: 'eq', value: '' });
  renderFilterRows();
}

function removeFilterRow(idx) {
  RB_FILTERS.splice(idx, 1);
  renderFilterRows();
}

function updateFilterField(idx, val) {
  RB_FILTERS[idx].field = val;
  RB_FILTERS[idx].op = 'eq';
  RB_FILTERS[idx].value = '';
  renderFilterRows();
}

function updateFilterOp(idx, val) {
  RB_FILTERS[idx].op = val;
  RB_FILTERS[idx].value = val === 'between' ? ['', ''] : '';
  renderFilterRows();
}

function updateFilterValue(idx, subIdx, val) {
  if (subIdx === null || subIdx === undefined) {
    RB_FILTERS[idx].value = val;
  } else {
    if (!Array.isArray(RB_FILTERS[idx].value)) RB_FILTERS[idx].value = ['', ''];
    RB_FILTERS[idx].value[subIdx] = val;
  }
}

// ─── Tipo de visualização ───────────────────────────────────────────────────
function setChartType(type) {
  RB_CHART_TYPE = type;
  document.querySelectorAll('#rb-chart-type-row .chart-type-btn').forEach(b => b.classList.toggle('on', b.dataset.type === type));
}

function collectBuilderConfig() {
  const entity = document.getElementById('rb-entity').value;
  const measureField = document.getElementById('rb-measure-field').value || null;
  const measureAgg = document.getElementById('rb-measure-agg').value || 'count';
  const groupField = document.getElementById('rb-group-field').value || null;
  const groupPart = document.getElementById('rb-group-datepart').value;
  const segField = document.getElementById('rb-seg-field').value || null;
  const segPart = document.getElementById('rb-seg-datepart').value;
  const fields = fieldsFor(entity);

  const config = {
    measure: { field: measureField, agg: measureField ? measureAgg : 'count' },
    filters: RB_FILTERS.filter(f => f.field).map(f => {
      if (f.op === 'is_null' || f.op === 'is_not_null') return { field: f.field, op: f.op, value: null };
      if (f.op === 'in') {
        const arr = typeof f.value === 'string' ? f.value.split(',').map(s => s.trim()).filter(Boolean) : (f.value || []);
        return { field: f.field, op: f.op, value: arr };
      }
      return { field: f.field, op: f.op, value: f.value };
    }),
    chart_type: RB_CHART_TYPE,
  };
  if (groupField) {
    config.group_by = { field: groupField };
    const gf = fields.find(x => x.key === groupField);
    if (gf && gf.type === 'date') config.group_by.date_part = groupPart;
  }
  if (segField) {
    config.segment_by = { field: segField };
    const sf = fields.find(x => x.key === segField);
    if (sf && sf.type === 'date') config.segment_by.date_part = segPart;
  }
  return { entity, config };
}

async function previewBuilderReport() {
  const box = document.getElementById('rb-preview-box');
  box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><div class="spinner"></div></div>';
  const { entity, config } = collectBuilderConfig();
  const { data, error } = await sb.rpc('run_report', { p_entity: entity, p_config: config });
  if (error) { box.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro: ${escHtml(error.message)}</span>`; return; }
  if (data && data.error) { box.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro: ${escHtml(data.error)}</span>`; return; }
  renderReportOutput(box, data.rows || [], RB_CHART_TYPE, !!config.segment_by, 'preview');
}

async function saveReport() {
  const name = document.getElementById('rb-name').value.trim();
  if (!name) { showToast('Dê um nome ao relatório antes de salvar.'); return; }
  const { entity, config } = collectBuilderConfig();
  const description = document.getElementById('rb-description').value.trim() || null;

  if (editingReportId) {
    const { error } = await sb.from('reports').update({ name, description, entity, config, updated_at: new Date().toISOString() }).eq('id', editingReportId);
    if (error) { showToast('Erro ao salvar: ' + error.message); return; }
    showToast('Relatório atualizado.');
  } else {
    const { error } = await sb.from('reports').insert({ name, description, entity, config, owner_id: CURRENT_USER.id, owner_email: CURRENT_USER.email });
    if (error) { showToast('Erro ao salvar: ' + error.message); return; }
    showToast('Relatório criado.');
  }
  closeReportBuilder();
  loadReportsList();
}

async function deleteReportConfirm(id) {
  const report = REPORTS.find(r => r.id === id);
  if (!confirm(`Excluir o relatório "${report ? report.name : ''}"? Essa ação não pode ser desfeita.`)) return;
  const { error } = await sb.from('reports').delete().eq('id', id);
  if (error) { showToast('Erro ao excluir: ' + error.message); return; }
  showToast('Relatório excluído.');
  loadReportsList();
}

// ─── Compartilhamento ───────────────────────────────────────────────────────
let currentShareReportId = null;

function buildPublicReportUrl(token) {
  const base = location.origin + location.pathname;
  return `${base}?public_report=${token}`;
}

async function openShareDialogById(id) {
  const report = REPORTS.find(r => r.id === id);
  if (!report) return;
  currentShareReportId = id;
  document.getElementById('share-report-name').textContent = report.name || '—';
  document.getElementById('share-public-toggle').checked = !!report.is_public;
  document.getElementById('share-link-area').style.display = report.is_public ? '' : 'none';
  if (report.is_public) document.getElementById('share-link-input').value = buildPublicReportUrl(report.public_token);
  document.getElementById('share-email-input').value = '';
  document.getElementById('share-error').style.display = 'none';
  await loadShareUsersList(id);
  document.getElementById('shareModal').classList.add('open');
}

function closeShareModal() {
  document.getElementById('shareModal').classList.remove('open');
  currentShareReportId = null;
}

async function onTogglePublicLink(checked) {
  if (!currentShareReportId) return;
  const { data, error } = await sb.from('reports').update({ is_public: checked }).eq('id', currentShareReportId).select().single();
  if (error) { showToast('Erro: ' + error.message); document.getElementById('share-public-toggle').checked = !checked; return; }
  document.getElementById('share-link-area').style.display = checked ? '' : 'none';
  if (checked) document.getElementById('share-link-input').value = buildPublicReportUrl(data.public_token);
  const r = REPORTS.find(x => x.id === currentShareReportId);
  if (r) { r.is_public = checked; r.public_token = data.public_token; }
}

function copyPublicLink() {
  const input = document.getElementById('share-link-input');
  input.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(input.value).then(() => showToast('Link copiado.')).catch(() => showToast('Não foi possível copiar — selecione e copie manualmente.'));
  } else {
    showToast('Selecione o link e copie manualmente (Ctrl/Cmd+C).');
  }
}

async function loadShareUsersList(reportId) {
  const listEl = document.getElementById('share-users-list');
  listEl.innerHTML = '<div style="font-size:11px;color:var(--text3);">Carregando…</div>';
  const { data, error } = await sb.from('report_shares').select('*').eq('report_id', reportId);
  if (error) { listEl.innerHTML = `<div style="font-size:11px;color:var(--red);">${escHtml(error.message)}</div>`; return; }
  if (!data || !data.length) { listEl.innerHTML = '<div style="font-size:11px;color:var(--text3);">Ainda não compartilhado com ninguém.</div>'; return; }
  listEl.innerHTML = data.map(s => `<div class="share-row"><span style="font-size:12px;color:var(--text2);">${escHtml(s.shared_with_email || s.shared_with_user_id)}</span><button class="btn-icon-sm" onclick="removeShareRow('${s.id}')">Remover</button></div>`).join('');
}

async function shareWithEmailSubmit() {
  const email = document.getElementById('share-email-input').value.trim();
  const errEl = document.getElementById('share-error');
  errEl.style.display = 'none';
  if (!email || !currentShareReportId) return;
  const { data, error } = await sb.rpc('share_report_by_email', { p_report_id: currentShareReportId, p_email: email });
  if (error) { errEl.textContent = error.message; errEl.style.display = ''; return; }
  if (data && data.success === false) {
    const messages = {
      report_not_found: 'Relatório não encontrado.',
      not_owner: 'Só o criador do relatório pode compartilhá-lo.',
      user_not_found: 'Não encontramos um usuário com esse e-mail.',
      cannot_share_with_self: 'Você já é o criador deste relatório.',
    };
    errEl.textContent = messages[data.error] || ('Erro: ' + data.error);
    errEl.style.display = '';
    return;
  }
  document.getElementById('share-email-input').value = '';
  showToast('Relatório compartilhado.');
  loadShareUsersList(currentShareReportId);
}

async function removeShareRow(shareId) {
  const { error } = await sb.from('report_shares').delete().eq('id', shareId);
  if (error) { showToast('Erro ao remover: ' + error.message); return; }
  loadShareUsersList(currentShareReportId);
}

// ─── Renderização genérica de saída de relatório (gráfico/tabela/número) ──────
const REPORT_CHART_REGISTRY = {};
function destroyReportChart(key) {
  if (REPORT_CHART_REGISTRY[key]) { REPORT_CHART_REGISTRY[key].destroy(); REPORT_CHART_REGISTRY[key] = null; }
}

function chartOptionsCommon(showLegend) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: showLegend, labels: { color: '#9499b0', font: { size: 11 } } } },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: '#9499b0', font: { size: 10 } } },
      y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: '#9499b0', font: { size: 10 } } },
    },
  };
}

function fmtReportNumber(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v == null ? '—' : v);
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function renderReportTable(container, rows, hasSeg) {
  const cols = hasSeg ? ['Grupo', 'Segmento', 'Valor'] : ['Grupo', 'Valor'];
  container.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r => hasSeg
      ? `<tr><td>${escHtml(r.grp)}</td><td>${escHtml(r.seg)}</td><td>${fmtReportNumber(r.measure)}</td></tr>`
      : `<tr><td>${escHtml(r.grp)}</td><td>${fmtReportNumber(r.measure)}</td></tr>`
    ).join('')
    + '</tbody></table></div>';
}

function renderReportOutput(container, rows, chartType, hasSeg, key) {
  destroyReportChart(key);
  if (!rows.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><span style="color:var(--text3);font-size:12px;">Nenhum dado encontrado para esses filtros.</span></div>';
    return;
  }
  if (chartType === 'number') {
    container.innerHTML = `<div style="padding:20px 4px;"><div class="report-kpi-big">${fmtReportNumber(rows[0].measure)}</div><div class="report-kpi-label">${escHtml(rows[0].grp)}</div></div>`;
    return;
  }
  if (chartType === 'table') {
    renderReportTable(container, rows, hasSeg);
    return;
  }

  container.innerHTML = `<div class="report-chart-wrap"><canvas id="report-canvas-${key}"></canvas></div>`;
  const canvas = document.getElementById(`report-canvas-${key}`);
  const COLORS = ['#818cf8', '#4ade80', '#fbbf24', '#f87171', '#60a5fa', '#a78bfa', '#22d3ee', '#fb923c', '#e879f9', '#94a3b8'];
  let chartInst;

  if (hasSeg) {
    const groups = [...new Set(rows.map(r => r.grp))];
    const segs = [...new Set(rows.map(r => r.seg))];
    const datasets = segs.map((seg, i) => ({
      label: seg,
      data: groups.map(g => { const row = rows.find(r => r.grp === g && r.seg === seg); return row ? Number(row.measure) : 0; }),
      backgroundColor: chartType === 'line' ? 'transparent' : COLORS[i % COLORS.length],
      borderColor: COLORS[i % COLORS.length],
      borderRadius: 4, fill: false, tension: 0.3,
    }));
    chartInst = new Chart(canvas.getContext('2d'), {
      type: chartType === 'line' ? 'line' : 'bar',
      data: { labels: groups, datasets },
      options: chartOptionsCommon(true),
    });
  } else if (chartType === 'pie') {
    const labels = rows.map(r => r.grp);
    const values = rows.map(r => Number(r.measure));
    chartInst = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => COLORS[i % COLORS.length]), borderColor: 'rgba(20,20,30,1)', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#9499b0', font: { size: 11 } } } } },
    });
  } else {
    const labels = rows.map(r => r.grp);
    const values = rows.map(r => Number(r.measure));
    chartInst = new Chart(canvas.getContext('2d'), {
      type: chartType === 'line' ? 'line' : 'bar',
      data: { labels, datasets: [{ label: 'Valor', data: values, backgroundColor: chartType === 'line' ? 'rgba(99,102,241,0.18)' : 'rgba(99,102,241,0.75)', borderColor: '#818cf8', borderRadius: 4, fill: chartType === 'line', tension: 0.3 }] },
      options: chartOptionsCommon(false),
    });
  }
  REPORT_CHART_REGISTRY[key] = chartInst;
}

// ─── Visualização pública (sem login) ──────────────────────────────────────
async function initPublicReportView(token) {
  const appEl = document.querySelector('.app');
  if (appEl) appEl.style.display = 'none';
  document.getElementById('login-overlay').classList.remove('open');
  document.getElementById('public-report-page').style.display = '';
  const box = document.getElementById('pr-box');
  box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:228px;"><div class="spinner"></div></div>';

  const { data, error } = await sb.rpc('get_public_report', { p_token: token });
  if (error) { box.innerHTML = `<span style="color:var(--red);font-size:12px;">Erro ao carregar relatório: ${escHtml(error.message)}</span>`; return; }
  if (data && data.error) {
    document.getElementById('pr-name').textContent = 'Relatório não disponível';
    box.innerHTML = '<span style="color:var(--text3);font-size:12px;">Este link não é válido ou o relatório não é mais público.</span>';
    return;
  }
  const report = data.report || {};
  document.getElementById('pr-name').textContent = report.name || 'Sem título';
  document.getElementById('pr-description').textContent = report.description || '';
  const chartType = (report.config && report.config.chart_type) || 'bar';
  const hasSeg = !!(report.config && report.config.segment_by && report.config.segment_by.field);
  renderReportOutput(box, (data.data && data.data.rows) || [], chartType, hasSeg, 'public');
}

// ─── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  // Garante que o filtro de período já abre no mês vigente, antes de qualquer
  // outra coisa — afeta tanto a tela quanto o primeiro loadData() (que usa
  // dateFrom/dateTo para recortar a busca inicial de atividades).
  applyDefaultDatePreset();

  // Relatório público via link compartilhado: ignora login e dashboard normal.
  const publicToken = new URLSearchParams(location.search).get('public_report');
  if (publicToken) {
    await initPublicReportView(publicToken);
    return;
  }

  // Restaura estado salvo da sidebar (oculta/visível + grupos retráteis abertos)
  // antes de qualquer carregamento de dados — puramente visual, não afeta dados.
  document.body.classList.toggle('sidebar-hidden', UI_STATE.sidebarHidden);
  ['empty', 'special', 'inactive'].forEach(applyNavGroupState);

  // Sessão Supabase Auth: se já houver login válido (persistido pelo SDK),
  // pula a tela de login e carrega os dados direto.
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    showApp(session);
    loadData();
  } else {
    showLogin();
  }
})();

window.toggleSidebar = toggleSidebar;
window.handleLogout = handleLogout;
window.navTo = navTo;
window.navToCloserByName = navToCloserByName;
window.toggleEmptyGroup = toggleEmptyGroup;
window.toggleNavGroup = toggleNavGroup;
window.showReportsPage = showReportsPage;
window.loadData = loadData;
window.applySearch = applySearch;
window.toggleVenc = toggleVenc;
window.setStatusFilter = setStatusFilter;
window.setFunilFilter = setFunilFilter;
window.applyDateFilter = applyDateFilter;
window.clearDateFilter = clearDateFilter;
window.toggleDateDropdown = toggleDateDropdown;
window.selectDatePreset = selectDatePreset;
window.applyCustomDateRange = applyCustomDateRange;
window.onCustomDateInputChange = onCustomDateInputChange;
window.openReportBuilder = openReportBuilder;
window.onBuilderEntityChange = onBuilderEntityChange;
window.onMeasureFieldChange = onMeasureFieldChange;
window.onGroupFieldChange = onGroupFieldChange;
window.onSegFieldChange = onSegFieldChange;
window.addFilterRow = addFilterRow;
window.removeFilterRow = removeFilterRow;
window.updateFilterField = updateFilterField;
window.updateFilterOp = updateFilterOp;
window.updateFilterValue = updateFilterValue;
window.setChartType = setChartType;
window.previewBuilderReport = previewBuilderReport;
window.closeReportBuilder = closeReportBuilder;
window.saveReport = saveReport;
window.backToReportsList = backToReportsList;
window.handleLogin = handleLogin;
window.closeModal = closeModal;
window.closeShareModal = closeShareModal;
window.onTogglePublicLink = onTogglePublicLink;
window.copyPublicLink = copyPublicLink;
window.shareWithEmailSubmit = shareWithEmailSubmit;
window.openModal = openModal;
window.setRankSort = setRankSort;
window.setProspectorSort = setProspectorSort;
window.setNoshowSort = setNoshowSort;
window.setChannelSort = setChannelSort;
window.setOutreachProspectorSort = setOutreachProspectorSort;
window.setOutreachCloserSort = setOutreachCloserSort;
window.setProductivitySort = setProductivitySort;
window.setLossreasonSort = setLossreasonSort;
window.setCompletionSort = setCompletionSort;
window.setStalenessSort = setStalenessSort;
window.setRiskSort = setRiskSort;
window.showCloserDeals = showCloserDeals;
window.showProspectorDeals = showProspectorDeals;
window.showChannelDeals = showChannelDeals;
window.showLossReasonDeals = showLossReasonDeals;
window.showNoShowDeals = showNoShowDeals;
window.showActivityDeals = showActivityDeals;
window.showCompletionDeals = showCompletionDeals;
window.showVencidasDeals = showVencidasDeals;
window.showStaleDeals = showStaleDeals;
window.showRiskDeals = showRiskDeals;
window.openReportFromList = openReportFromList;
window.openShareDialogById = openShareDialogById;
window.deleteReportConfirm = deleteReportConfirm;
window.removeShareRow = removeShareRow;

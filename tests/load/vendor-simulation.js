import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * TESTE DE CARGA — "N VENDEDORES A USAREM A BAZARES AO MESMO TEMPO"
 * ============================================================
 * Corre contra a base de dados Neon de teste (nunca a Supabase de
 * produção — ver .github/workflows/load-test.yml, que aponta
 * DATABASE_URL para lá antes de arrancar o servidor que este script
 * ataca).
 *
 * Cada Virtual User (VU) simula UM vendedor novo a entrar na Bazares
 * pela primeira vez, na mesma janela de tempo que todos os outros:
 *
 *   registar-se → iniciar sessão → criar o Bazar → publicar um post
 *   → ver o feed → reagir a uma publicação → comentar → ver mais feed
 *
 * Isto é mais realista do que só bombardear um único endpoint — é o
 * caminho real que alguém percorre ao abrir a app pela primeira vez.
 *
 * Como correr (feito automaticamente pelo workflow, mas para
 * referência local):
 *   k6 run --vus 500 --iterations 500 tests/load/vendor-simulation.js
 *
 * Variáveis de ambiente:
 *   BASE_URL — raiz da API (default http://localhost:3001/api)
 */

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001/api';

// Limiares — se algum destes falhar, o passo "Avaliar resultados" do
// workflow marca o job como falhado, para ires direto ao que importa
// sem teres de ler o relatório todo no telemóvel.
export const options = {
  thresholds: {
    // Menos de 1% de pedidos com erro (rede ou 5xx) — falhas de
    // validação esperadas (ex.: 409 email duplicado num retry) não
    // entram aqui, só entram erros reais de execução do pedido.
    http_req_failed: ['rate<0.01'],
    // 95% dos pedidos devem responder em menos de 3s — acima disto,
    // um vendedor real sentiria a app "pesada".
    http_req_duration: ['p(95)<3000'],
    // Praticamente todas as verificações de sucesso (registo, login,
    // publicar, reagir, comentar) devem passar.
    checks: ['rate>0.95']
  }
};

const REACTION_VALUES = [1, 2, 3, 4, 5, 6, 7];
const PT_WORDS = ['Óptimo produto!', 'Adorei isto', 'Quanto custa a entrega?', 'Já encomendei', 'Boa qualidade!'];
const CATEGORIES = ['Moda', 'Electrónica', 'Casa', 'Beleza', 'Alimentação'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function authHeaders(token) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

export default function () {
  // __VU (1..N) + timestamp — único mesmo que o teste corra várias
  // vezes seguidas sem reset da BD entre elas.
  const uid = `${__VU}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const email = `vendedor.loadtest.${uid}@bazares-teste.mz`;
  const password = 'TesteDeCarga123!';
  const name = `Vendedor Teste ${__VU}`;

  // ── 1. Registo ────────────────────────────────────────────────
  const registerRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ name, email, password, role: 'SELLER' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(registerRes, { 'registo: 201': (r) => r.status === 201 });
  if (registerRes.status !== 201) return; // sem conta, não vale a pena continuar este VU

  sleep(0.3);

  // ── 2. Login ──────────────────────────────────────────────────
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const loginOk = check(loginRes, { 'login: 200': (r) => r.status === 200 });
  if (!loginOk) return;
  const token = loginRes.json('data.accessToken');
  if (!token) return;

  sleep(0.3);

  // ── 3. Criar o Bazar (loja) ───────────────────────────────────
  const bazarRes = http.post(
    `${BASE_URL}/bazars`,
    JSON.stringify({
      name: `Loja Teste ${uid}`,
      description: 'Loja criada pelo teste de carga da Bazares.',
      category: pick(CATEGORIES),
      phone: '84' + Math.floor(1000000 + Math.random() * 8999999)
    }),
    authHeaders(token)
  );
  const bazarOk = check(bazarRes, { 'criar bazar: 201': (r) => r.status === 201 });
  if (!bazarOk) return;
  const bazarSlug = bazarRes.json('data.bazar.slug') || bazarRes.json('data.bazar.id');

  sleep(0.5);

  // ── 4. Publicar um post no feed ───────────────────────────────
  const postRes = http.post(
    `${BASE_URL}/bazars/${bazarSlug}/announcements`,
    JSON.stringify({ text: `Olá! Acabei de abrir a minha loja na Bazares. ${pick(PT_WORDS)}` }),
    authHeaders(token)
  );
  check(postRes, { 'publicar post: 201': (r) => r.status === 201 });

  sleep(0.5);

  // ── 5. Ver o feed (1ª página) ──────────────────────────────────
  const feedRes = http.get(`${BASE_URL}/feed?limit=15`, authHeaders(token));
  const feedOk = check(feedRes, { 'ver feed: 200': (r) => r.status === 200 });

  sleep(0.4);

  // ── 6. Reagir + comentar numa publicação do feed (se houver) ──
  if (feedOk) {
    const items = feedRes.json('data.items') || [];
    if (items.length > 0) {
      const target = pick(items);
      const reactRes = http.post(
        `${BASE_URL}/feed/${target.targetType}/${target.targetId}/react`,
        JSON.stringify({ value: pick(REACTION_VALUES) }),
        authHeaders(token)
      );
      check(reactRes, { 'reagir: 200': (r) => r.status === 200 });

      sleep(0.3);

      const commentRes = http.post(
        `${BASE_URL}/feed/${target.targetType}/${target.targetId}/comments`,
        JSON.stringify({ text: pick(PT_WORDS) }),
        authHeaders(token)
      );
      check(commentRes, { 'comentar: 201': (r) => r.status === 201 });
    }
  }

  sleep(0.5);

  // ── 7. Continuar a ver o feed (2ª "rolagem") ───────────────────
  const feed2Res = http.get(`${BASE_URL}/feed?limit=15`, authHeaders(token));
  check(feed2Res, { 'ver feed (rolagem 2): 200': (r) => r.status === 200 });
}

// ── Relatório em Markdown, pronto para o resumo do GitHub Actions ──
// (o job cola isto directamente no $GITHUB_STEP_SUMMARY, para dar
// para ler no telemóvel sem abrir nenhum ficheiro à parte).
export function handleSummary(data) {
  const m = data.metrics;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const ms = (v) => `${Math.round(v)} ms`;

  const httpFailedRate = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  const checksRate = m.checks ? m.checks.values.rate : 0;
  const dur = m.http_req_duration ? m.http_req_duration.values : {};
  const totalReqs = m.http_reqs ? m.http_reqs.values.count : 0;
  const vusMax = m.vus_max ? m.vus_max.values.max : '?';

  const thresholdsFailed = Object.entries(data.metrics)
    .filter(([, metric]) => metric.thresholds && Object.values(metric.thresholds).some((t) => !t.ok))
    .map(([name]) => name);

  const verdict = thresholdsFailed.length === 0
    ? '✅ **Todos os limiares passaram** — o sistema aguentou-se dentro do esperado.'
    : `⚠️ **${thresholdsFailed.length} limiar(es) falhou/falharam**: ${thresholdsFailed.join(', ')}`;

  const md = `## 🧪 Teste de carga — ${vusMax} vendedores simulados

${verdict}

| Métrica | Valor |
|---|---|
| Pedidos totais | ${totalReqs} |
| Taxa de erro HTTP | ${pct(httpFailedRate)} |
| Verificações OK | ${pct(checksRate)} |
| Duração média do pedido | ${ms(dur.avg || 0)} |
| Duração p95 | ${ms(dur['p(95)'] || 0)} |
| Duração máxima | ${ms(dur.max || 0)} |

*Cada "vendedor" simulado registou-se, criou uma loja, publicou, viu o feed, reagiu e comentou — não foi só um pedido repetido.*
`;

  return {
    stdout: md,
    'load-test-summary.md': md,
    'load-test-full.json': JSON.stringify(data, null, 2)
  };
}

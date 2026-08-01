// ============================================================
// 用量监控 Worker - 支持单 Worker/全账户监控 + 分级告警 + 前端仪表盘
// ============================================================

// ============================================================
// 环境变量说明
// ============================================================
// CF_API_TOKEN      : Cloudflare API Token（需 Analytics:Read 权限）
// CF_ACCOUNT_ID     : Cloudflare 账户 ID
// WORKER_NAME       : 要监控的 Worker 名称。若留空，则监控整个账户所有 Worker 的总用量
// THRESHOLD_REQUESTS: 请求数阈值（如 100000，表示 10 万次）
// ALERT_EMAIL       : 告警邮件接收地址
// MAIL_WORKER_URL   : 已有邮件发送 Worker 的 URL
// ============================================================

export default {
  // ---------- Cron 定时触发（每 30 分钟） ----------
  async scheduled(event, env, ctx) {
    await checkUsageAndAlert(env);
  },

  // ---------- HTTP 请求 ----------
  async fetch(request, env) {
    const url = new URL(request.url);

    // 根路径 -> 前端仪表盘 HTML
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(getDashboardHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // API: 获取当前用量数据（供前端图表使用）
    if (url.pathname === '/api/usage' && request.method === 'GET') {
      const data = await getUsageData(env);
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // API: 手动触发一次检测
    if (url.pathname === '/api/check' && request.method === 'POST') {
      await checkUsageAndAlert(env);
      return new Response('检测已触发', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ============================================================
// 核心检测函数（含分级告警 + KV 去重）
// ============================================================
async function checkUsageAndAlert(env) {
  const usage = await getUsageData(env);
  const { requests } = usage;

  const threshold = parseInt(env.THRESHOLD_REQUESTS) || 100000;
  const percent = (requests / threshold) * 100;

  // 定义告警级别
  const levels = [
    { level: 80, label: '80%' },
    { level: 90, label: '90%' },
    { level: 95, label: '95%' },
    { level: 100, label: '100%' },
  ];

  // 计算当前所处的最高告警级别
  let currentLevel = 0;
  for (const lv of levels) {
    if (percent >= lv.level) {
      currentLevel = lv.level;
    } else {
      break;
    }
  }

  // 从 KV 读取上次告警级别
  const kv = env.USAGE_ALERT_STATE;
  let lastLevel = 0;
  if (kv) {
    const stored = await kv.get('alert_level', 'json');
    if (stored && typeof stored === 'number') {
      lastLevel = stored;
    }
  }

  // 如果当前级别 > 上次级别，则发送告警并更新 KV
  if (currentLevel > lastLevel) {
    const matched = levels.find(lv => lv.level === currentLevel);
    const label = matched ? matched.label : `${currentLevel}%`;

    await sendAlertEmail(env, {
      requests,
      percent,
      threshold,
      level: currentLevel,
      label,
    });

    if (kv) {
      await kv.put('alert_level', JSON.stringify(currentLevel));
    }
  }

  // 将用量数据存入 KV（供参考，可选）
  if (kv) {
    await kv.put('last_usage', JSON.stringify(usage), { expirationTtl: 3600 });
  }

  return usage;
}

// ============================================================
// 获取用量数据（GraphQL API）
// - 若 WORKER_NAME 为空，则监控整个账户所有 Worker 的总用量
// ============================================================
async function getUsageData(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const workerName = env.WORKER_NAME?.trim() || ''; // 若为空则监控全部

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startISO = startOfMonth.toISOString();
  const endISO = now.toISOString();

  // 构建过滤条件
  let filterStr = `datetime_gt: "${startISO}", datetime_lt: "${endISO}"`;
  if (workerName !== '') {
    filterStr += `, scriptName: "${workerName}"`;
  }

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          workersInvocationsAdaptive(
            filter: { ${filterStr} }
            limit: 10000
          ) {
            sum {
              requests
              cpuMs
            }
            dimensions {
              datetimeHour
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const result = await response.json();

  // 解析数据
  const data = result?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  const total = data.reduce(
    (acc, item) => ({
      requests: acc.requests + (item.sum?.requests || 0),
      cpuMs: acc.cpuMs + (item.sum?.cpuMs || 0),
    }),
    { requests: 0, cpuMs: 0 }
  );

  // 按天聚合（用于图表，保留最近 7 天）
  const dailyMap = {};
  data.forEach(item => {
    const date = item.dimensions?.datetimeHour?.split('T')[0];
    if (date) {
      if (!dailyMap[date]) dailyMap[date] = { requests: 0, cpuMs: 0 };
      dailyMap[date].requests += item.sum?.requests || 0;
      dailyMap[date].cpuMs += item.sum?.cpuMs || 0;
    }
  });

  const dates = Object.keys(dailyMap).sort().slice(-7);
  const daily = dates.map(d => ({
    date: d,
    requests: dailyMap[d].requests,
    cpuMs: dailyMap[d].cpuMs,
  }));

  return {
    requests: total.requests,
    cpuMs: total.cpuMs,
    daily,
  };
}

// ============================================================
// 发送告警邮件（调用已有的邮件 Worker）
// ============================================================
async function sendAlertEmail(env, alertInfo) {
  const { requests, percent, threshold, label } = alertInfo;
  const mailWorkerUrl = env.MAIL_WORKER_URL;
  if (!mailWorkerUrl) {
    console.error('未配置 MAIL_WORKER_URL');
    return;
  }

  const workerDisplay = env.WORKER_NAME?.trim() || '全部 Worker（账户总计）';

  const subject = `⚠️ Worker 用量已达 ${label} - ${new Date().toLocaleDateString()}`;
  const html = `
    <h2>⚠️ Worker 用量告警</h2>
    <p><strong>监控范围:</strong> ${workerDisplay}</p>
    <p><strong>检测时间:</strong> ${new Date().toLocaleString()}</p>
    <hr>
    <h3>📊 当前用量</h3>
    <ul>
      <li>请求数: <b>${requests.toLocaleString()}</b> (阈值: ${threshold.toLocaleString()})</li>
      <li>使用率: <b>${percent.toFixed(1)}%</b></li>
      <li>达到级别: <b style="color:red;">${label}</b></li>
    </ul>
    <p style="color: #666; font-size: 12px;">此邮件由监控系统自动发送，如需调整阈值请修改环境变量 THRESHOLD_REQUESTS。</p>
  `;

  await fetch(mailWorkerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: env.ALERT_EMAIL,
      subject: subject,
      html: html,
      text: `Worker 用量告警\n\n监控范围: ${workerDisplay}\n请求数: ${requests}/${threshold} (${percent.toFixed(1)}%)\n级别: ${label}`,
    }),
  });
}

// ============================================================
// 前端仪表盘 HTML（含 Chart.js）
// ============================================================
function getDashboardHTML() {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Worker 用量监控</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e0e0e0; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 20px; color: #f0f0f0; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 20px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1a1a2e; padding: 18px; border-radius: 12px; border: 1px solid #2a2a4a; }
    .card .label { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card .value.warning { color: #f59e0b; }
    .card .value.danger { color: #ef4444; }
    .card .value.success { color: #22c55e; }
    .card .sub { font-size: 14px; color: #aaa; margin-top: 4px; }
    .chart-container { background: #1a1a2e; padding: 20px; border-radius: 12px; border: 1px solid #2a2a4a; margin-bottom: 20px; }
    .status-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px 16px; background: #1a1a2e; border-radius: 8px; border: 1px solid #2a2a4a; }
    .status-bar .status { font-size: 14px; }
    .status-bar .status .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
    .status-bar .status .dot.green { background: #22c55e; }
    .status-bar .status .dot.yellow { background: #f59e0b; }
    .status-bar .status .dot.orange { background: #f97316; }
    .status-bar .status .dot.red { background: #ef4444; }
    .btn { background: #3b82f6; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .btn:hover { background: #2563eb; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .last-update { color: #666; font-size: 13px; }
    @media (max-width: 600px) { .cards { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <h1>📊 Worker 用量监控</h1>
  <div class="subtitle" id="monitorTarget">加载中...</div>

  <div class="cards" id="cards">
    <div class="card"><div class="label">📨 本月请求数</div><div class="value" id="requests">--</div></div>
    <div class="card"><div class="label">⚡ CPU 时间</div><div class="value" id="cpu">--</div><div class="sub">仅作参考</div></div>
    <div class="card"><div class="label">📈 使用率</div><div class="value" id="percent">--</div></div>
    <div class="card"><div class="label">🟢 状态</div><div class="value" id="status" style="font-size:20px;">--</div></div>
  </div>

  <div class="chart-container">
    <canvas id="chart"></canvas>
  </div>

  <div class="status-bar">
    <span class="status"><span class="dot green" id="statusDot"></span><span id="statusText">正常</span></span>
    <span class="last-update" id="lastUpdate">加载中...</span>
    <button class="btn" id="refreshBtn">🔄 刷新</button>
  </div>
</div>

<script>
  let chart = null;

  // 阈值（应与环境变量 THRESHOLD_REQUESTS 一致）
  const THRESHOLD = 100000;

  async function loadData() {
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();

      document.getElementById('requests').textContent = data.requests.toLocaleString();
      document.getElementById('cpu').textContent = (data.cpuMs / 1000).toFixed(1) + 's';

      const pct = Math.min((data.requests / THRESHOLD) * 100, 100);
      document.getElementById('percent').textContent = pct.toFixed(1) + '%';

      // 状态判断
      const statusEl = document.getElementById('status');
      const dotEl = document.getElementById('statusDot');
      const textEl = document.getElementById('statusText');

      if (pct >= 100) {
        statusEl.textContent = '🔴 已超限';
        dotEl.className = 'dot red';
        textEl.textContent = '请求数已达 100% 阈值！';
      } else if (pct >= 95) {
        statusEl.textContent = '🔴 高危';
        dotEl.className = 'dot red';
        textEl.textContent = '超过 95% 阈值，请立即关注！';
      } else if (pct >= 90) {
        statusEl.textContent = '🟠 警告';
        dotEl.className = 'dot orange';
        textEl.textContent = '超过 90% 阈值';
      } else if (pct >= 80) {
        statusEl.textContent = '🟡 注意';
        dotEl.className = 'dot yellow';
        textEl.textContent = '超过 80% 阈值';
      } else {
        statusEl.textContent = '🟢 正常';
        dotEl.className = 'dot green';
        textEl.textContent = '用量正常';
      }

      document.getElementById('lastUpdate').textContent = '更新时间: ' + new Date().toLocaleString();
      document.getElementById('monitorTarget').textContent = '监控范围: ' + (data.monitorTarget || '全部 Worker');

      // 更新图表（最近7天）
      if (data.daily && data.daily.length > 0) {
        const dates = data.daily.map(d => d.date);
        const reqData = data.daily.map(d => d.requests);
        const cpuData = data.daily.map(d => (d.cpuMs / 1000).toFixed(1));

        if (chart) chart.destroy();
        chart = new Chart(document.getElementById('chart'), {
          type: 'bar',
          data: {
            labels: dates,
            datasets: [
              {
                label: '请求数',
                data: reqData,
                backgroundColor: 'rgba(59, 130, 246, 0.6)',
                borderColor: '#3b82f6',
                borderWidth: 1,
                yAxisID: 'y',
              },
              {
                label: 'CPU (秒)',
                data: cpuData,
                backgroundColor: 'rgba(236, 72, 153, 0.6)',
                borderColor: '#ec4899',
                borderWidth: 1,
                yAxisID: 'y1',
              }
            ]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { labels: { color: '#e0e0e0' } }
            },
            scales: {
              x: { ticks: { color: '#888', maxTicksLimit: 15 }, grid: { color: '#2a2a4a' } },
              y: { type: 'linear', position: 'left', ticks: { color: '#888' }, grid: { color: '#2a2a4a' } },
              y1: { type: 'linear', position: 'right', ticks: { color: '#888' }, grid: { drawOnChartArea: false } }
            }
          }
        });
      }
    } catch (e) {
      console.error('加载失败:', e);
    }
  }

  document.getElementById('refreshBtn').addEventListener('click', loadData);
  loadData();
</script>
</body>
</html>
  `;
}

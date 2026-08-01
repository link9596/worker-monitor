// ============================================================
// Cloudflare Worker 监控仪表盘 + 多级告警 (SMTP via QQ)
// 基于 workersInvocationsAdaptive 获取数据
// ============================================================

import { connect } from 'cloudflare:sockets';

export default {
  // ---------- 定时任务（每30分钟执行） ----------
  async scheduled(event, env, ctx) {
    console.log('⏰ [Cron] 定时任务开始执行');
    const today = new Date().toISOString().slice(0, 10);
    const limit = parseInt(env.DAILY_LIMIT || '100000', 10);

    // 1. 获取今日请求数
    let totalRequests = 0;
    try {
      totalRequests = await getTodayTotalRequests(env);
      console.log(`📊 [Cron] 今日请求数: ${totalRequests}`);
    } catch (err) {
      console.error('❌ [Cron] 获取请求数失败:', err);
      return;
    }

    // 2. 存储今日数据到历史记录
    await storeHistory(env, today, totalRequests);
    console.log(`💾 [Cron] 已存储历史数据: ${today} -> ${totalRequests}`);

    // 3. 读取阈值列表
    const thresholds = await getThresholds(env);
    console.log(`⚙️ [Cron] 当前阈值: ${thresholds.join(', ')}%`);

    // 4. 检查每个阈值
    const percentage = (totalRequests / limit) * 100;
    console.log(`📈 [Cron] 使用占比: ${percentage.toFixed(2)}%`);

    for (const threshold of thresholds) {
      if (percentage >= threshold) {
        const alertKey = `alert_${threshold}_${today}`;
        const alreadySent = await env.MONITOR_DATA.get(alertKey);
        if (!alreadySent) {
          console.log(`📧 [Cron] 达到阈值 ${threshold}%，准备发送邮件...`);
          try {
            await sendAlertEmail(env, totalRequests, limit, percentage, threshold);
            await env.MONITOR_DATA.put(alertKey, 'sent', { expirationTtl: 86400 });
            console.log(`✅ [Cron] 已发送 ${threshold}% 告警邮件`);
          } catch (err) {
            console.error(`❌ [Cron] 发送 ${threshold}% 告警失败:`, err);
          }
        } else {
          console.log(`⏭️ [Cron] ${threshold}% 今天已告警过，跳过`);
        }
      }
    }
    console.log('🏁 [Cron] 定时任务执行完毕');
  },

  // ---------- HTTP 请求处理 ----------
  async fetch(request, env) {
    console.log(`🌐 [HTTP] 收到请求: ${request.method} ${request.url}`);
    const url = new URL(request.url);
    const path = url.pathname;

    // API 路由
    if (path === '/api/stats') {
      console.log('📡 [API] 请求 /api/stats');
      return await handleStatsAPI(env);
    }
    if (path === '/api/config' && request.method === 'POST') {
      console.log('📡 [API] 请求 /api/config (POST)');
      return await handleConfigAPI(request, env);
    }

    // 默认返回仪表盘 HTML
    console.log('📄 [HTTP] 返回仪表盘 HTML');
    return new Response(await getDashboardHTML(env), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

// ============================================================
// 核心函数：获取今日请求总数（使用 workersInvocationsAdaptive）
// ============================================================
async function getTodayTotalRequests(env) {
  const accountId = env.ACCOUNT_ID || env.CF_ACCOUNT_ID;
  const token = env.API_TOKEN || env.CF_API_TOKEN;
  const scriptName = env.WORKER_NAME || env.SCRIPT_NAME || '';

  if (!accountId || !token) {
    console.error('❌ [GraphQL] 环境变量缺失: ACCOUNT_ID 或 API_TOKEN');
    return 0;
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const datetimeStart = todayStart.toISOString();
  const datetimeEnd = now.toISOString();

  const query = `
    query {
      viewer {
        accounts(filter: {accountTag: "${accountId}"}) {
          workersInvocationsAdaptive(
            filter: {
              datetime_gt: "${datetimeStart}",
              datetime_leq: "${datetimeEnd}"
              ${scriptName ? `, scriptName: "${scriptName}"` : ''}
            }
            limit: 1
          ) {
            sum {
              requests
            }
          }
        }
      }
    }
  `;

  console.log(`🔍 [GraphQL] 查询参数: accountId=${accountId}, scriptName=${scriptName || '全部'}`);
  console.log(`📝 [GraphQL] Query: ${query.replace(/\s+/g, ' ').trim()}`);

  try {
    const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    const responseText = await resp.text();
    console.log(`📦 [GraphQL] HTTP 状态: ${resp.status}`);
    console.log(`📄 [GraphQL] 原始响应: ${responseText.substring(0, 500)}`);

    if (!resp.ok) {
      console.error(`❌ [GraphQL] API 返回错误状态: ${resp.status}`);
      return 0;
    }

    const data = JSON.parse(responseText);
    if (data.errors) {
      console.error('❌ [GraphQL] 查询错误:', JSON.stringify(data.errors, null, 2));
      return 0;
    }

    const requests = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum?.requests || 0;
    console.log(`✅ [GraphQL] 成功获取请求数: ${requests}`);
    return requests;
  } catch (err) {
    console.error('❌ [GraphQL] 请求失败:', err.message);
    return 0;
  }
}

// ============================================================
// 存储历史数据（按天存储）
// ============================================================
async function storeHistory(env, date, count) {
  const key = `history_${date}`;
  try {
    await env.MONITOR_DATA.put(key, String(count), { expirationTtl: 2592000 }); // 30天
    console.log(`💾 [KV] 已存储: ${key} = ${count}`);
  } catch (err) {
    console.error(`❌ [KV] 存储失败: ${key}`, err);
  }
}

// ============================================================
// 读取用户配置的阈值列表
// ============================================================
async function getThresholds(env) {
  try {
    const raw = await env.MONITOR_DATA.get('thresholds');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.sort((a, b) => a - b);
      }
    }
  } catch (err) {
    console.error('❌ [KV] 读取阈值失败:', err);
  }
  return [80, 90, 95, 100];
}

// ============================================================
// 发送告警邮件 (QQ SMTP) - 使用 cloudflare:sockets
// ============================================================
async function sendAlertEmail(env, total, limit, percentage, threshold) {
  console.log(`📧 [SMTP] 开始发送 ${threshold}% 告警邮件...`);
  const from = env.QQ_EMAIL;
  const authCode = env.QQ_AUTH_CODE;
  const to = env.ALERT_EMAIL;

  if (!from || !authCode || !to) {
    throw new Error('邮箱配置缺失: QQ_EMAIL, QQ_AUTH_CODE, ALERT_EMAIL');
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const workerName = env.WORKER_NAME || '所有 Workers (账户总计)';
  const subject = `[Cloudflare告警] Worker请求已达 ${percentage.toFixed(1)}% (超过${threshold}%)`;
  const htmlContent = `
    <h2>⚠️ Cloudflare Worker 请求数告警</h2>
    <p><strong>监控对象：</strong> ${workerName}</p>
    <p><strong>当前时间：</strong> ${now}</p>
    <p><strong>今日已用请求数：</strong> ${total.toLocaleString()}</p>
    <p><strong>每日限额：</strong> ${limit.toLocaleString()}</p>
    <p><strong>使用占比：</strong> <span style="color: red; font-size: 24px;">${percentage.toFixed(2)}%</span></p>
    <p><strong>触发阈值：</strong> ${threshold}%</p>
    <hr><p style="color: gray;">请及时关注，避免超过免费额度导致服务中断。</p>
  `;

  const mailData = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlContent
  ].join('\r\n');

  const socket = connect({ hostname: 'smtp.qq.com', port: 465, secure: true });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function readResponse() {
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.endsWith('\r\n')) break;
    }
    return buffer;
  }
  async function sendCommand(cmd) {
    await writer.write(encoder.encode(cmd + '\r\n'));
    const resp = await readResponse();
    const code = parseInt(resp.substring(0, 3), 10);
    if (code >= 400) throw new Error(`SMTP 错误 (${code}): ${resp}`);
    return resp;
  }

  try {
    await readResponse(); // 220
    await sendCommand('EHLO worker');
    await sendCommand('AUTH LOGIN');
    await sendCommand(btoa(from));
    await sendCommand(btoa(authCode));
    await sendCommand(`MAIL FROM: <${from}>`);
    await sendCommand(`RCPT TO: <${to}>`);
    await sendCommand('DATA');
    await writer.write(encoder.encode(mailData + '\r\n.\r\n'));
    await readResponse(); // 250
    await sendCommand('QUIT');
    console.log('✅ [SMTP] 邮件发送成功');
  } finally {
    try { writer.close(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
    try { socket.close(); } catch (_) {}
  }
}

// ============================================================
// API: 获取统计数据（供前端使用）
// ============================================================
async function handleStatsAPI(env) {
  const today = new Date().toISOString().slice(0, 10);
  const limit = parseInt(env.DAILY_LIMIT || '100000', 10);

  let todayCount = 0;
  try {
    todayCount = await getTodayTotalRequests(env);
  } catch (err) {
    console.error('❌ [API] 获取今日请求失败:', err);
  }

  // 获取近7天历史
  const history = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const val = await env.MONITOR_DATA.get(`history_${dateStr}`);
    history.push({
      date: dateStr,
      count: val ? parseInt(val, 10) : 0,
    });
  }

  const thresholds = await getThresholds(env);

  return new Response(JSON.stringify({
    today: todayCount,
    limit: limit,
    percentage: (todayCount / limit) * 100,
    history: history,
    thresholds: thresholds,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================
// API: 更新阈值配置
// ============================================================
async function handleConfigAPI(request, env) {
  try {
    const body = await request.json();
    let thresholds = body.thresholds;
    if (!Array.isArray(thresholds)) {
      return new Response('Invalid thresholds', { status: 400 });
    }
    thresholds = thresholds
      .map(Number)
      .filter(n => !isNaN(n) && n > 0 && n <= 100)
      .sort((a, b) => a - b);
    if (thresholds.length === 0) thresholds = [80, 90, 95, 100];

    await env.MONITOR_DATA.put('thresholds', JSON.stringify(thresholds));
    return new Response(JSON.stringify({ success: true, thresholds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_) {
    return new Response('Invalid request', { status: 400 });
  }
}

// ============================================================
// 仪表盘 HTML (服务端注入初始数据，前端仅加载一次)
// ============================================================
async function getDashboardHTML(env) {
  const limit = parseInt(env.DAILY_LIMIT || '100000', 10);
  let todayCount = 0;
  try {
    todayCount = await getTodayTotalRequests(env);
  } catch (_) {}
  const percentage = (todayCount / limit) * 100;
  const thresholds = await getThresholds(env);

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Worker 监控仪表盘</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; margin: 20px; }
    .container { max-width: 900px; margin: auto; background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 2px solid #f0a500; padding-bottom: 10px; }
    .stats-grid { display: flex; gap: 20px; flex-wrap: wrap; justify-content: space-around; margin: 20px 0; }
    .stat-card { background: #fafafa; padding: 15px 25px; border-radius: 8px; text-align: center; flex: 1; min-width: 120px; }
    .stat-card .number { font-size: 2em; font-weight: bold; color: #1a73e8; }
    .stat-card .label { color: #666; font-size: 0.9em; }
    .ring-container { display: flex; justify-content: center; margin: 20px 0; }
    canvas#ringChart { width: 150px; height: 150px; }
    .threshold-section { margin: 30px 0; padding: 15px; background: #f0f7ff; border-radius: 8px; }
    .threshold-section h3 { margin-top: 0; }
    .threshold-list { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .threshold-badge { background: #e0e0e0; padding: 5px 12px; border-radius: 20px; font-size: 0.9em; display: inline-flex; align-items: center; gap: 6px; }
    .threshold-badge .remove { cursor: pointer; color: red; font-weight: bold; }
    .threshold-input { display: flex; gap: 10px; margin-top: 10px; }
    .threshold-input input { width: 80px; padding: 6px; border: 1px solid #ccc; border-radius: 4px; }
    .threshold-input button { padding: 6px 15px; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .threshold-input button:hover { background: #1557b0; }
    #historyChart { margin-top: 20px; max-height: 250px; }
    .footer { margin-top: 30px; color: #999; font-size: 0.8em; text-align: center; }
  </style>
</head>
<body>
<div class="container">
  <h1>📊 Cloudflare Worker 请求监控</h1>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="number" id="todayCount">${todayCount.toLocaleString()}</div>
      <div class="label">今日请求数</div>
    </div>
    <div class="stat-card">
      <div class="number">${limit.toLocaleString()}</div>
      <div class="label">每日限额</div>
    </div>
    <div class="stat-card">
      <div class="number" id="percentDisplay">${percentage.toFixed(1)}%</div>
      <div class="label">使用占比</div>
    </div>
  </div>

  <div class="ring-container">
    <canvas id="ringChart" width="150" height="150"></canvas>
  </div>

  <div class="threshold-section">
    <h3>⚙️ 告警阈值设置（百分比）</h3>
    <div class="threshold-list" id="thresholdList">
      ${thresholds.map(t => '<span class="threshold-badge">' + t + '% <span class="remove" data-value="' + t + '">✕</span></span>').join('')}
    </div>
    <div class="threshold-input">
      <input type="number" id="newThreshold" placeholder="例如 85" min="1" max="100">
      <button id="addThreshold">添加</button>
    </div>
    <p style="font-size:0.9em; color:#666;">💡 每个阈值每天只会发送一次邮件，避免重复。</p>
  </div>

  <h3>📈 近7天请求趋势</h3>
  <canvas id="historyChart"></canvas>

  <div class="footer">后台每30分钟自动更新数据 · 最后加载: <span id="lastLoad">${new Date().toLocaleString()}</span></div>
</div>

<script>
  let currentThresholds = ${JSON.stringify(thresholds)};
  let currentPercent = ${percentage};

  const ctxRing = document.getElementById('ringChart').getContext('2d');
  const ringChart = new Chart(ctxRing, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [currentPercent, 100 - currentPercent],
        backgroundColor: ['#f0a500', '#e0e0e0'],
        borderWidth: 0,
      }]
    },
    options: {
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      responsive: false,
    }
  });

  const ctxHist = document.getElementById('historyChart').getContext('2d');
  let historyChart = new Chart(ctxHist, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: '请求数',
        data: [],
        backgroundColor: '#1a73e8',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });

  async function refreshData() {
    try {
      const resp = await fetch('/api/stats');
      const data = await resp.json();
      document.getElementById('todayCount').textContent = data.today.toLocaleString();
      document.getElementById('percentDisplay').textContent = data.percentage.toFixed(1) + '%';
      ringChart.data.datasets[0].data = [data.percentage, 100 - data.percentage];
      ringChart.update();
      const labels = data.history.map(h => h.date.slice(5));
      const values = data.history.map(h => h.count);
      historyChart.data.labels = labels;
      historyChart.data.datasets[0].data = values;
      historyChart.update();
      document.getElementById('lastLoad').textContent = new Date().toLocaleString();
      if (data.thresholds && JSON.stringify(data.thresholds) !== JSON.stringify(currentThresholds)) {
        currentThresholds = data.thresholds;
        renderThresholds(currentThresholds);
      }
    } catch (err) {
      console.error('加载数据失败:', err);
    }
  }

  document.getElementById('addThreshold').addEventListener('click', async function() {
    const input = document.getElementById('newThreshold');
    const val = parseInt(input.value);
    if (isNaN(val) || val < 1 || val > 100) {
      alert('请输入 1~100 之间的整数');
      return;
    }
    if (currentThresholds.includes(val)) {
      alert('该阈值已存在');
      return;
    }
    const newList = [...currentThresholds, val].sort((a,b) => a - b);
    await updateThresholds(newList);
    input.value = '';
  });

  document.getElementById('thresholdList').addEventListener('click', async function(e) {
    if (e.target.classList.contains('remove')) {
      const val = parseInt(e.target.dataset.value);
      const newList = currentThresholds.filter(t => t !== val);
      if (newList.length === 0) {
        alert('至少保留一个阈值');
        return;
      }
      await updateThresholds(newList);
    }
  });

  async function updateThresholds(newList) {
    try {
      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thresholds: newList })
      });
      if (resp.ok) {
        const result = await resp.json();
        currentThresholds = result.thresholds;
        renderThresholds(currentThresholds);
        alert('阈值已更新！');
      } else {
        alert('更新失败，请重试');
      }
    } catch (_) {
      alert('网络错误');
    }
  }

  function renderThresholds(list) {
    const container = document.getElementById('thresholdList');
    container.innerHTML = list.map(t =>
      '<span class="threshold-badge">' + t + '% <span class="remove" data-value="' + t + '">✕</span></span>'
    ).join('');
  }

  window.onload = function() {
    refreshData();
  };
</script>
</body>
</html>
  `;
}

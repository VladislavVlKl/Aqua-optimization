// process-queue.js — Обработка очереди ручных уведомлений
// Запускается каждые 15 минут через GitHub Actions

const BASE = process.env.SUPABASE_URL + '/rest/v1';
const KEY  = process.env.SUPABASE_ANON_KEY;
const BOT  = process.env.BOT_TOKEN;
const H    = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function get(path) {
  try {
    const r = await fetch(BASE + path, { headers: H });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { return []; }
    if (!r.ok) { console.error('API error:', JSON.stringify(d).slice(0,200)); return []; }
    return Array.isArray(d) ? d : [];
  } catch(e) { return []; }
}

async function patch(path, body) {
  try {
    await fetch(BASE + path, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  } catch(e) { console.error('PATCH error:', e.message); }
}

async function tg(chatId, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT + '/sendMessage', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const d = await r.json();
    return d.ok ? true : (console.error('TG error:', d.description), false);
  } catch(e) { return false; }
}

async function main() {
  const now = new Date().toISOString();
  console.log('=== Process Queue ===', now);

  // Берём все pending уведомления которые уже должны были уйти
  const pending = await get(
    '/notifications_queue?select=*' +
    '&status=eq.pending' +
    '&scheduled_for=lte.' + now +
    '&order=scheduled_for.asc&limit=50'
  );

  console.log('Pending notifications:', pending.length);

  let sent = 0, failed = 0;

  for (const n of pending) {
    const ok = await tg(n.recipient_tg_id, n.message);
    await patch(
      '/notifications_queue?id=eq.' + n.id,
      ok
        ? { status: 'sent',   sent_at: new Date().toISOString() }
        : { status: 'failed', error_text: 'Telegram delivery failed' }
    );
    if (ok) { sent++; console.log('Sent to:', n.recipient_name || n.recipient_tg_id); }
    else     { failed++; console.log('Failed:', n.recipient_name || n.recipient_tg_id); }
  }

  console.log('Done. Sent:', sent, '| Failed:', failed);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

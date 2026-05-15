// remind.js — Автоматические уведомления AquaDesk
const BASE = process.env.SUPABASE_URL + '/rest/v1';
const KEY  = process.env.SUPABASE_ANON_KEY;
const BOT  = process.env.BOT_TOKEN;
const H    = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };

async function get(path) {
  try {
    const r = await fetch(BASE + path, { headers: H });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { console.error('Not JSON:', t.slice(0,200)); return []; }
    if (!r.ok) { console.error('API error:', JSON.stringify(d).slice(0,200)); return []; }
    return Array.isArray(d) ? d : [];
  } catch(e) { console.error('Fetch:', e.message); return []; }
}

async function tg(chatId, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + BOT + '/sendMessage', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const d = await r.json();
    if (!d.ok) console.error('TG error:', d.description);
    return !!d.ok;
  } catch(e) { console.error('TG:', e.message); return false; }
}

async function isActive(key) {
  const r = await get('/notification_rules?select=active&rule_key=eq.' + key);
  return r[0]?.active === true;
}

async function ruleOpenSessions(dow, today) {
  if (!(await isActive('open_sessions_2200'))) return console.log('[open_sessions] disabled');
  const trainers = await get('/profiles?select=id,fio,tg_id&role=in.(trainer,senior_trainer)&tg_id=not.is.null');
  console.log('[open_sessions] trainers:', trainers.length);
  let sent = 0;
  for (const tr of trainers) {
    const slots = await get('/schedule_slots?select=id,slot_type,start_time&trainer_id=eq.' + tr.id + '&day_of_week=eq.' + dow + '&active=eq.true&slot_type=in.(pt,group)');
    if (!slots.length) continue;
    const ids = slots.map(s=>s.id).join(',');
    const confs = await get('/schedule_confirmations?select=slot_id&slot_id=in.(' + ids + ')&session_date=eq.' + today);
    const done = new Set(confs.map(c=>c.slot_id));
    const pend = slots.filter(s=>!done.has(s.id));
    if (!pend.length) continue;
    const lines = pend.map(s => '• ' + s.start_time.slice(0,5) + ' — ' + (s.slot_type==='pt'?'Персональная':'Групповое')).join('\n');
    const msg = '⚠️ <b>Незакрытые занятия</b>\n\n' + lines + '\n\nПодтвердите или отмените в AquaDesk.';
    if (await tg(tr.tg_id, msg)) { console.log('[open_sessions] sent to:', tr.fio); sent++; }
  }
  console.log('[open_sessions] sent:', sent);
}

async function ruleSubExpiring() {
  if (!(await isActive('sub_expiring_7d'))) return console.log('[sub_expiring] disabled');
  const today = new Date().toISOString().slice(0,10);
  const in7 = new Date(); in7.setDate(in7.getDate()+7);
  const in7str = in7.toISOString().slice(0,10);
  const clients = await get('/clients?select=fio,subscription_end,profiles!trainer_id(fio,tg_id)&subscription_end=gte.' + today + '&subscription_end=lte.' + in7str);
  console.log('[sub_expiring] expiring:', clients.length);
  for (const c of clients) {
    const tgId = c.profiles?.tg_id; if (!tgId) continue;
    const days = Math.ceil((new Date(c.subscription_end) - new Date()) / 86400000);
    const msg = '⏰ <b>Истекает абонемент</b>\n\nКлиент: <b>' + c.fio + '</b>\nОсталось дней: ' + days + '\n\nНапомните клиенту о продлении.';
    if (await tg(tgId, msg)) console.log('[sub_expiring] sent for:', c.fio);
  }
}

async function ruleDebtOverdue() {
  if (!(await isActive('debt_overdue_3d'))) return console.log('[debt_overdue] disabled');
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-3);
  const ws = await get('/workouts?select=workout_date,clients(fio),profiles!trainer_id(fio,tg_id)&is_debt=eq.true&debt_confirmed_at=is.null&created_at=lt.' + cutoff.toISOString());
  console.log('[debt_overdue] count:', ws.length);
  const byTrainer = {};
  for (const w of ws) {
    const tgId = w.profiles?.tg_id; if (!tgId) continue;
    if (!byTrainer[tgId]) byTrainer[tgId] = { name: w.profiles?.fio, items: [] };
    byTrainer[tgId].items.push(w.clients?.fio + ' (' + new Date(w.workout_date).toLocaleDateString('ru-RU') + ')');
  }
  for (const [tgId, data] of Object.entries(byTrainer)) {
    const msg = '❌ <b>Долг не подтверждён (3+ дня)</b>\n\n' + data.items.map(i=>'• '+i).join('\n') + '\n\nПодтвердите оплату в разделе Отчёт.';
    if (await tg(parseInt(tgId), msg)) console.log('[debt_overdue] sent to:', data.name);
  }
}

async function ruleInactive() {
  if (!(await isActive('trainer_inactive_5d'))) return console.log('[inactive] disabled');
  const admins = await get('/profiles?select=tg_id,fio&role=eq.admin&tg_id=not.is.null');
  if (!admins.length) return;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-5);
  const trainers = await get('/profiles?select=id,fio&role=in.(trainer,senior_trainer)');
  const inactive = [];
  for (const tr of trainers) {
    const ws = await get('/workouts?select=id&trainer_id=eq.' + tr.id + '&workout_date=gte.' + cutoff.toISOString() + '&limit=1');
    if (!ws.length) inactive.push(tr.fio);
  }
  if (!inactive.length) return;
  const msg = '💤 <b>Нет активности 5+ дней</b>\n\n' + inactive.map(f=>'• '+f).join('\n');
  for (const a of admins) { if (await tg(a.tg_id, msg)) console.log('[inactive] sent to admin:', a.fio); }
}

async function main() {
  const hourTashkent = (new Date().getUTCHours() + 5) % 24;
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const today = now.toISOString().slice(0,10);
  console.log('=== AquaDesk Reminder ===', now.toISOString(), '| Tashkent hour:', hourTashkent);
  if (hourTashkent === 22) await ruleOpenSessions(dow, today);
  if (hourTashkent === 9)  { await ruleSubExpiring(); await ruleDebtOverdue(); await ruleInactive(); }
  console.log('=== Done ===');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });

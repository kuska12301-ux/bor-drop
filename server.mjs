import http from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { FKPay, verifyFKWebhook } from './sdk/fk-pay.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const rawPage = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const paymentsScript = await readFile(new URL('./public/payments.js', import.meta.url));
const paymentUi = `<style>.payment-dialog{border:0;border-radius:22px;padding:24px;max-width:360px;width:calc(100% - 32px);box-shadow:0 24px 80px #10142633}.payment-dialog::backdrop{background:#11182788;backdrop-filter:blur(5px)}.dialog-close{float:right;background:#f1f3f7;border-radius:50%;width:32px;height:32px;font-size:20px}</style><dialog class="payment-dialog" id="deposit-dialog"><form method="dialog"><button class="dialog-close" aria-label="Закрыть">×</button></form><h2>Пополнение USDT</h2><p class="sub">Счёт создаётся через FK Pay. Оплата подтверждается в FK Wallet.</p><label class="smalltitle" for="deposit-amount">Сумма</label><div class="amount"><input id="deposit-amount" type="number" min="0.10" max="10000" step="0.01" value="10.00"><span class="unit">USDT</span></div><button class="primary" id="deposit-create">Создать счёт</button><p class="sub" id="deposit-status" role="status"></p></dialog><dialog class="payment-dialog" id="withdraw-dialog"><form method="dialog"><button class="dialog-close" aria-label="Закрыть">×</button></form><h2>Вывод USDT</h2><p class="sub">Автовыплата придёт на ваш @username в FK Wallet.</p><label class="smalltitle" for="withdraw-amount">Сумма</label><div class="amount"><input id="withdraw-amount" type="number" min="0.10" max="10000" step="0.01" value="5.00"><span class="unit">USDT</span></div><button class="primary" id="withdraw-create">Вывести</button><p class="sub" id="withdraw-status" role="status"></p></dialog><script src="/payments.js"></script>`;
const page = rawPage.includes('</body>')
  ? rawPage.replace('</body>', `${paymentUi}</body>`)
  : rawPage.replace('</html>', `${paymentUi}</html>`);
const dataDir = new URL('./data/', import.meta.url);
const dbFile = new URL('./data/ledger.json', import.meta.url);
await mkdir(dataDir, { recursive: true });
let db = { users: {}, invoices: {}, payouts: {}, webhookEvents: {} };
try { db = JSON.parse(await readFile(dbFile, 'utf8')); } catch {}
db.users ||= {}; db.invoices ||= {}; db.payouts ||= {}; db.webhookEvents ||= {};
let saveQueue = Promise.resolve();
function persist() {
  saveQueue = saveQueue.then(async () => {
    const temp = new URL('./data/ledger.tmp', import.meta.url);
    await writeFile(temp, JSON.stringify(db, null, 2));
    await rename(temp, dbFile);
  });
  return saveQueue;
}

const paymentsEnabled = Boolean(process.env.FK_PAY_BASE_URL && process.env.FK_PAY_API_KEY && process.env.FK_WEBHOOK_SECRET && process.env.TELEGRAM_BOT_TOKEN);
const pay = paymentsEnabled ? new FKPay({ baseUrl: process.env.FK_PAY_BASE_URL, apiKey: process.env.FK_PAY_API_KEY }) : null;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function getBody(req, limit = 64_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifyTelegram(initData) {
  if (!initData || !process.env.TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const received = params.get('hash');
  params.delete('hash'); params.delete('signature');
  const authDate = Number(params.get('auth_date'));
  if (!received || !authDate || Math.abs(Date.now() / 1000 - authDate) > 3600) return null;
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(received);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}
const userFrom = req => verifyTelegram(req.headers['x-telegram-init-data']);
const account = id => {
  const value = db.users[id] ||= { balance: '0.000000', creditedInvoices: [] };
  value.creditedInvoices ||= [];
  return value;
};
let moneyQueue = Promise.resolve();
function serializeMoney(operation) {
  const result = moneyQueue.then(operation, operation);
  moneyQueue = result.catch(() => {});
  return result;
}
const normalizeInvoice = value => value?.invoice || value?.data?.invoice || value?.data || value;
async function creditPaidInvoice(remoteInvoice) {
  const invoice = normalizeInvoice(remoteInvoice);
  if (!invoice?.id) return false;
  const local = db.invoices[invoice.id];
  if (!local || !['paid', 'completed', 'success'].includes(String(invoice.status).toLowerCase())) return false;
  const user = account(local.userId);
  if (user.creditedInvoices.includes(invoice.id)) return false;
  user.balance = (Number(user.balance) + Number(local.amount)).toFixed(6);
  user.creditedInvoices.push(invoice.id);
  local.status = 'paid'; local.paidAt = new Date().toISOString();
  await persist();
  return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', paymentsEnabled });
    if (req.method === 'POST' && url.pathname === '/api/fk/webhook') {
      if (!paymentsEnabled) return json(res, 503, { error: 'PAYMENTS_NOT_CONFIGURED' });
      const rawBody = await getBody(req);
      const valid = verifyFKWebhook({ secret: process.env.FK_WEBHOOK_SECRET, timestamp: req.headers['fk-timestamp'], signature: req.headers['fk-signature'], rawBody });
      if (!valid) return json(res, 401, { error: 'INVALID_SIGNATURE' });
      const event = JSON.parse(rawBody);
      const eventId = String(req.headers['fk-event-id'] || event.id || createHash('sha256').update(rawBody).digest('hex'));
      if (db.webhookEvents[eventId]) return json(res, 200, { ok: true, duplicate: true });
      db.webhookEvents[eventId] = new Date().toISOString();
      if (event.type === 'invoice.paid' || event.event === 'invoice.paid') await creditPaidInvoice(event.data?.invoice || event.invoice || event.data);
      await persist();
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!paymentsEnabled) return json(res, 503, { error: 'PAYMENTS_NOT_CONFIGURED', message: 'Set FK Pay and Telegram secrets on the server.' });
      const user = userFrom(req);
      if (!user?.id) return json(res, 401, { error: 'TELEGRAM_AUTH_REQUIRED' });
      if (req.method === 'GET' && url.pathname === '/api/balance') return json(res, 200, { balance: account(String(user.id)).balance, asset: 'USDT' });
      if (req.method === 'POST' && url.pathname === '/api/deposits') {
        const input = JSON.parse(await getBody(req) || '{}');
        const amount = Number(input.amount);
        if (!Number.isFinite(amount) || amount < 0.1 || amount > 10_000) return json(res, 400, { error: 'INVALID_AMOUNT' });
        const idempotencyKey = randomUUID();
        const result = await pay.createInvoice({ amount: amount.toFixed(6), asset: 'USDT', description: 'Пополнение BOR DROP', payload: `deposit:${user.id}:${idempotencyKey}`, expiresIn: 3600 }, idempotencyKey);
        const invoice = normalizeInvoice(result);
        if (!invoice?.id) throw new Error('FK Pay response has no invoice id');
        db.invoices[invoice.id] = { userId: String(user.id), amount: amount.toFixed(6), status: invoice.status || 'active', idempotencyKey, createdAt: new Date().toISOString() };
        await persist();
        return json(res, 201, { id: invoice.id, status: invoice.status, paymentUrl: invoice.telegramUrl || invoice.paymentUrl || invoice.payUrl });
      }
      if (req.method === 'POST' && url.pathname === '/api/withdrawals') {
        const input = JSON.parse(await getBody(req) || '{}');
        const amount = Number(input.amount);
        if (!Number.isFinite(amount) || amount < 0.1 || amount > 10_000) return json(res, 400, { error: 'INVALID_AMOUNT' });
        if (!user.username) return json(res, 400, { error: 'TELEGRAM_USERNAME_REQUIRED', message: 'Установите @username в Telegram для получения выплаты.' });
        const fixedAmount = amount.toFixed(6);
        const payout = await serializeMoney(async () => {
          const wallet = account(String(user.id));
          if (Number(wallet.balance) < amount) return { insufficient: true };
          const idempotencyKey = FKPay.idempotencyKey();
          const localId = randomUUID();
          wallet.balance = (Number(wallet.balance) - amount).toFixed(6);
          db.payouts[localId] = { userId: String(user.id), recipient: `@${user.username}`, amount: fixedAmount, status: 'processing', idempotencyKey, createdAt: new Date().toISOString() };
          await persist();
          try {
            const remote = await pay.createPayout({ recipient: `@${user.username}`, amount: fixedAmount, description: 'Вывод BOR DROP', payload: `withdrawal:${localId}` }, idempotencyKey);
            const value = remote?.payout || remote?.data?.payout || remote?.data || remote;
            db.payouts[localId].remoteId = value?.id;
            db.payouts[localId].status = value?.status || 'processing';
            await persist();
            return { id: value?.id || localId, status: db.payouts[localId].status, balance: wallet.balance };
          } catch (error) {
            wallet.balance = (Number(wallet.balance) + amount).toFixed(6);
            db.payouts[localId].status = 'failed';
            db.payouts[localId].error = error.message;
            await persist();
            throw error;
          }
        });
        if (payout.insufficient) return json(res, 409, { error: 'INSUFFICIENT_BALANCE', message: 'Недостаточно средств.' });
        return json(res, 201, payout);
      }
      const match = url.pathname.match(/^\/api\/deposits\/([^/]+)$/);
      if (req.method === 'GET' && match) {
        const id = decodeURIComponent(match[1]); const local = db.invoices[id];
        if (!local || local.userId !== String(user.id)) return json(res, 404, { error: 'NOT_FOUND' });
        const remote = normalizeInvoice(await pay.getInvoice(id));
        await creditPaidInvoice(remote);
        return json(res, 200, { id, status: db.invoices[id].status, balance: account(String(user.id)).balance });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    }
    if (req.method === 'GET' && url.pathname === '/payments.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(paymentsScript);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : page);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: 'REQUEST_FAILED', message: error.message });
  }
});
server.requestTimeout = 15_000; server.headersTimeout = 10_000;
server.listen(port, host, () => console.log(`BOR DROP: http://${host}:${port} (FK Pay ${paymentsEnabled ? 'enabled' : 'not configured'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

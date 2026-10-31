const telegramInitData = window.Telegram?.WebApp?.initData || '';
const paymentHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Telegram-Init-Data': telegramInitData,
});

const depositButton = document.querySelector('[data-info="Пополнение"]');
const depositDialog = document.getElementById('deposit-dialog');
const depositStatus = document.getElementById('deposit-status');
if (depositButton && depositDialog) {
  depositButton.removeAttribute('data-info');
  depositButton.addEventListener('click', () => depositDialog.showModal());
  document.getElementById('deposit-create').addEventListener('click', async () => {
    const amount = Number(document.getElementById('deposit-amount').value);
    if (!telegramInitData) {
      depositStatus.textContent = 'Открой приложение через Telegram-бота проекта.';
      return;
    }
    depositStatus.textContent = 'Создаём счёт…';
    try {
      const response = await fetch('/api/deposits', { method: 'POST', headers: paymentHeaders(), body: JSON.stringify({ amount }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error);
      depositStatus.textContent = 'Счёт создан. Подтверди оплату в FK Wallet.';
      if (data.paymentUrl) window.Telegram?.WebApp?.openTelegramLink?.(data.paymentUrl) || window.open(data.paymentUrl, '_blank', 'noopener');
    } catch (error) {
      depositStatus.textContent = error.message || 'Не удалось создать счёт.';
    }
  });
}

const withdrawButton = document.querySelector('[data-info="Вывод"]');
const withdrawDialog = document.getElementById('withdraw-dialog');
const withdrawStatus = document.getElementById('withdraw-status');
if (withdrawButton && withdrawDialog) {
  withdrawButton.removeAttribute('data-info');
  withdrawButton.addEventListener('click', () => withdrawDialog.showModal());
  document.getElementById('withdraw-create').addEventListener('click', async () => {
    const amount = Number(document.getElementById('withdraw-amount').value);
    if (!telegramInitData) {
      withdrawStatus.textContent = 'Открой приложение через Telegram-бота проекта.';
      return;
    }
    withdrawStatus.textContent = 'Создаём выплату…';
    try {
      const response = await fetch('/api/withdrawals', { method: 'POST', headers: paymentHeaders(), body: JSON.stringify({ amount }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error);
      withdrawStatus.textContent = `Выплата создана. Статус: ${data.status}.`;
      await refreshServerBalance();
    } catch (error) {
      withdrawStatus.textContent = error.message || 'Не удалось создать выплату.';
    }
  });
}

async function refreshServerBalance() {
  if (!telegramInitData) return;
  try {
    const response = await fetch('/api/balance', { headers: { 'X-Telegram-Init-Data': telegramInitData } });
    if (!response.ok) return;
    const data = await response.json();
    const balance = document.getElementById('balance');
    if (balance) balance.textContent = Number(data.balance).toFixed(2);
  } catch {}
}
refreshServerBalance();
setInterval(refreshServerBalance, 15_000);

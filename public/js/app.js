const STORAGE_KEY = "carddue.v1";
const NOTIFY_KEY = "carddue.notifications";
let state = loadState();

const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(n) || 0);
const fmtDate = (d) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
const isoDate = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { cards: [], bills: [] };
  } catch { return { cards: [], bills: [] }; }
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

function uid(prefix="id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function dueDateFor(card, statementDate) {
  const d = new Date(statementDate);
  d.setHours(12,0,0,0);
  d.setDate(d.getDate() + Number(card.dueDays || 0));
  return isoDate(d);
}

function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}

function billStatus(bill) {
  if (bill.status === "paid") return "paid";
  return daysUntil(bill.dueDate) < 0 ? "overdue" : "pending";
}

function cardBills(cardId) {
  return state.bills.filter(b => b.cardId === cardId).sort((a,b) => b.statementDate.localeCompare(a.statementDate));
}

function latestBill(card) {
  return cardBills(card.id)[0];
}

function render() {
  const pending = state.bills.filter(b => b.status !== "paid");
  $("totalUpcoming").textContent = money(pending.reduce((s,b) => s + Number(b.amount || 0), 0));
  $("cardCount").textContent = state.cards.length;

  renderCards();
  renderUpcoming();
  renderHistory();
}

function renderCards() {
  const el = $("cardCarousel");
  if (!state.cards.length) {
    el.innerHTML = `<div class="empty" style="min-width:100%">No cards yet.<br>Tap <b>+ Add card</b> to start.</div>`;
    $("carouselDots").innerHTML = "";
    return;
  }

  el.innerHTML = state.cards.map(card => {
    const bill = latestBill(card);
    const status = bill ? billStatus(bill) : "pending";
    const amount = bill ? money(bill.amount) : "—";
    const dueText = bill ? `${fmtDate(bill.dueDate)} • ${daysLabel(daysUntil(bill.dueDate))}` : "No statement recorded";
    return `
      <article class="credit-card">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(card.name)}</div>
            <div class="card-bank">${esc(card.issuer)}</div>
          </div>
          <div class="last4">•••• ${esc(card.last4 || "----")}</div>
        </div>
        <div class="card-middle">
          <div class="muted">Current statement</div>
          <div class="card-amount">${amount}</div>
          <div class="card-due">${dueText}</div>
        </div>
        <div class="card-bottom">
          <span class="status ${status}">${status === "paid" ? "PAID" : status === "overdue" ? "OVERDUE" : "PENDING"}</span>
          <div class="card-actions">
            <button class="small-btn" onclick="editCard('${card.id}')">Edit</button>
            ${bill && bill.status !== "paid" ? `<button class="small-btn" onclick="markPaid('${bill.id}')">Mark paid</button>` : `<button class="small-btn" onclick="addStatement('${card.id}')">Statement</button>`}
          </div>
        </div>
      </article>`;
  }).join("");

  const dots = state.cards.map((_,i) => `<span class="dot ${i===0?"active":""}"></span>`).join("");
  $("carouselDots").innerHTML = dots;

  el.addEventListener("scroll", updateDots, { passive: true });
  updateDots();
}

function updateDots() {
  const el = $("cardCarousel");
  const cards = [...el.querySelectorAll(".credit-card")];
  if (!cards.length) return;
  const index = Math.round(el.scrollLeft / cards[0].offsetWidth);
  [...$("carouselDots").children].forEach((d,i) => d.classList.toggle("active", i === index));
}

function renderUpcoming() {
  const bills = state.bills.filter(b => b.status !== "paid").sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  $("upcomingList").innerHTML = bills.length ? bills.slice(0,10).map(b => {
    const card = state.cards.find(c => c.id === b.cardId);
    const days = daysUntil(b.dueDate);
    return `<div class="list-row">
      <div class="row-icon">${days < 0 ? "🚨" : days <= 3 ? "⚠️" : "💳"}</div>
      <div class="row-main">
        <div class="row-title">${esc(card?.name || "Card")}</div>
        <div class="row-sub">Due ${fmtDate(b.dueDate)}</div>
      </div>
      <div class="row-right">
        <div class="row-amount">${money(b.amount)}</div>
        <div class="row-days">${daysLabel(days)}</div>
      </div>
    </div>`;
  }).join("") : `<div class="empty">No unpaid statements.</div>`;
}

function renderHistory() {
  const bills = state.bills.filter(b => b.status === "paid").sort((a,b) => (b.paidAt||"").localeCompare(a.paidAt||""));
  $("historyList").innerHTML = bills.length ? bills.slice(0,8).map(b => {
    const card = state.cards.find(c => c.id === b.cardId);
    return `<div class="list-row">
      <div class="row-icon">✓</div>
      <div class="row-main">
        <div class="row-title">${esc(card?.name || "Card")}</div>
        <div class="row-sub">Paid ${fmtDate(b.paidAt)}</div>
      </div>
      <div class="row-right"><div class="row-amount">${money(b.amount)}</div></div>
    </div>`;
  }).join("") : `<div class="empty">No payment history yet.</div>`;
}

function daysLabel(days) {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `${days}d left`;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function openCardModal(card=null) {
  $("modalTitle").textContent = card ? "Edit credit card" : "Add credit card";
  $("cardId").value = card?.id || "";
  $("cardName").value = card?.name || "";
  $("issuer").value = card?.issuer || "";
  $("last4").value = card?.last4 || "";
  $("statementDay").value = card?.statementDay || 15;
  $("dueDays").value = card?.dueDays ?? 20;
  $("reminderDays").value = (card?.reminderDays || [7,3,1,0]).join(",");
  $("active").checked = card?.active !== false;
  $("modalBackdrop").classList.remove("hidden");
}
function closeCardModal() { $("modalBackdrop").classList.add("hidden"); }

$("addCardBtn").onclick = () => openCardModal();
$("closeModal").onclick = closeCardModal;
$("refreshBtn").onclick = () => { state = loadState(); render(); toast("Refreshed"); };

$("cardForm").onsubmit = (e) => {
  e.preventDefault();
  const id = $("cardId").value || uid("card");
  const card = {
    id,
    name: $("cardName").value.trim(),
    issuer: $("issuer").value.trim(),
    last4: $("last4").value.trim(),
    statementDay: Math.min(31, Math.max(1, Number($("statementDay").value))),
    dueDays: Math.min(60, Math.max(0, Number($("dueDays").value))),
    reminderDays: $("reminderDays").value.split(",").map(x=>Number(x.trim())).filter(x=>Number.isFinite(x) && x>=0).sort((a,b)=>b-a),
    active: $("active").checked,
    createdAt: new Date().toISOString()
  };
  const index = state.cards.findIndex(c => c.id === id);
  if (index >= 0) state.cards[index] = { ...state.cards[index], ...card };
  else state.cards.push(card);
  save(); closeCardModal(); render(); toast(index >= 0 ? "Card updated" : "Card added");
};

window.editCard = (id) => {
  const card = state.cards.find(c => c.id === id);
  if (card) openCardModal(card);
};

window.addStatement = (cardId) => {
  const card = state.cards.find(c => c.id === cardId);
  if (!card) return;
  $("billCardId").value = cardId;
  $("billStatementDate").value = isoDate(new Date());
  $("billAmount").value = "";
  $("billMinimum").value = "";
  updateCalculatedDue();
  $("billModalBackdrop").classList.remove("hidden");
};

$("closeBillModal").onclick = () => $("billModalBackdrop").classList.add("hidden");
$("billStatementDate").oninput = updateCalculatedDue;
$("billCardId").onchange = updateCalculatedDue;

function updateCalculatedDue() {
  const card = state.cards.find(c => c.id === $("billCardId").value);
  const date = $("billStatementDate").value;
  $("calculatedDueDate").textContent = card && date ? fmtDate(dueDateFor(card, date)) : "—";
}

$("billForm").onsubmit = (e) => {
  e.preventDefault();
  const cardId = $("billCardId").value;
  const card = state.cards.find(c => c.id === cardId);
  const statementDate = $("billStatementDate").value;
  if (!card) return;
  const bill = {
    id: uid("bill"),
    cardId,
    statementDate,
    dueDate: dueDateFor(card, statementDate),
    amount: Number($("billAmount").value || 0),
    minimumDue: Number($("billMinimum").value || 0),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  state.bills.push(bill);
  save();
  $("billModalBackdrop").classList.add("hidden");
  render();
  scheduleLocalNotifications();
  toast("Statement saved");
};

window.markPaid = (billId) => {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  bill.status = "paid";
  bill.paidAt = isoDate(new Date());
  save(); render(); toast("Marked as paid");
};

$("notifyBtn").onclick = async () => {
  if (!("Notification" in window)) return toast("Notifications are not supported here");
  const permission = await Notification.requestPermission();
  toast(permission === "granted" ? "Notifications enabled" : "Notification permission not granted");
  if (permission === "granted") scheduleLocalNotifications();
};

function scheduleLocalNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // Browser timers are best-effort and may stop when the page is closed.
  // The production version should use Web Push + a server scheduler.
  const existing = JSON.parse(localStorage.getItem(NOTIFY_KEY) || "[]");
  const now = Date.now();
  const upcoming = state.bills.filter(b => b.status !== "paid");
  upcoming.forEach(b => {
    const card = state.cards.find(c => c.id === b.cardId);
    if (!card || card.active === false) return;
    const reminders = card.reminderDays || [7,3,1,0];
    reminders.forEach(daysBefore => {
      const fireAt = new Date(b.dueDate);
      fireAt.setHours(9,0,0,0);
      fireAt.setDate(fireAt.getDate() - daysBefore);
      const key = `${b.id}:${daysBefore}`;
      if (fireAt.getTime() <= now || existing.includes(key)) return;
      existing.push(key);
      setTimeout(() => {
        const current = loadState().bills.find(x => x.id === b.id);
        if (!current || current.status === "paid") return;
        new Notification(daysBefore === 0 ? "Payment due today" : `Payment due in ${daysBefore} days`, {
          body: `${card.name}: ${money(b.amount)} due ${fmtDate(b.dueDate)}`,
          tag: key
        });
      }, fireAt.getTime() - now);
    });
  });
  localStorage.setItem(NOTIFY_KEY, JSON.stringify(existing));
}

$("exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `carddue-backup-${isoDate(new Date())}.json`; a.click();
  URL.revokeObjectURL(url);
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(console.error));
}

render();
scheduleLocalNotifications();

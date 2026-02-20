/**
 * @file public/js/app.js
 * @description Frontend Application Controller (SPA Logic v10.9.9 Enterprise).
 * Управляет состоянием интерфейса, модальными окнами, OTP-авторизацией.
 * ДОБАВЛЕНО: Таймлайны (фильтрация по датам), Поиск CRM, Режим Read-Only для 'done'.
 * ДОБАВЛЕНО: Взятие заказа с биржи (Web), Метаданные (Адрес/Коммент), Создание Бригад.
 *
 * @module AppController
 * @version 10.9.9 (PWA, Chart.js, Cash Flow & Full ERP Control)
 */

import { API } from "./api.js";

// =============================================================================
// 1. 🛠 УТИЛИТЫ И ФОРМАТТЕРЫ (UTILITIES)
// =============================================================================

const Utils = {
  formatCurrency: (value) => {
    const num = parseFloat(value) || 0;
    return new Intl.NumberFormat("ru-KZ", {
      style: "currency",
      currency: "KZT",
      maximumFractionDigits: 0,
    }).format(num);
  },
  formatDate: (dateString) => {
    if (!dateString) return "—";
    const d = new Date(dateString);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  },
  showToast: (message, type = "info") => {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let icon =
      type === "success"
        ? "check-circle"
        : type === "error"
          ? "alert-circle"
          : "info";
    toast.innerHTML = `<i data-feather="${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    if (typeof feather !== "undefined") feather.replace();

    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },
  downloadBlob: (response, filename) => {
    response.blob().then((blob) => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    });
  },
};

// =============================================================================
// 2. 🧠 СТЭЙТ, ИНИЦИАЛИЗАЦИЯ И СОКЕТЫ (STATE & SOCKETS)
// =============================================================================

const State = {
  currentView: "dashboardView",
  user: null,
  orders: [],
  users: [],
  brigades: [],
  selectedOrderId: null,
  currentBOM: [],
  financeAccounts: [],
  timelineChartInstance: null,
  ordersTimelineChartInstance: null,
  // Глобальные фильтры
  dateStart: "",
  dateEnd: "",
  searchUserTerm: "",
};

const socket = typeof io !== "undefined" ? io() : null;

if (socket) {
  socket.on("connect", () => {
    document.getElementById("socketStatusDot").className =
      "pe-status-dot online";
    document.getElementById("socketStatusText").textContent = "Online";
  });
  socket.on("disconnect", () => {
    document.getElementById("socketStatusDot").className =
      "pe-status-dot offline";
    document.getElementById("socketStatusText").textContent = "Offline";
  });

  socket.on("order_updated", (data) => {
    if (State.currentView === "ordersView") loadOrders();
    if (State.currentView === "dashboardView") loadDashboard();
  });
  socket.on("expense_added", (data) => {
    Utils.showToast("Кто-то добавил новый чек к объекту!", "info");
    if (
      State.currentView === "ordersView" &&
      State.selectedOrderId === data.orderId
    )
      openOrderModal(data.orderId);
    if (State.currentView === "dashboardView") loadDashboard();
  });
  socket.on("settings_updated", () => {
    if (State.currentView === "settingsView") loadSettings();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindAuthEvents();
  bindMobileEvents();
  await checkSession();
});

// =============================================================================
// 3. 🔐 АВТОРИЗАЦИЯ, OTP И RBAC РОУТИНГ
// =============================================================================

async function checkSession() {
  try {
    const res = await API.checkAuth();
    if (res.authenticated) {
      State.user = res.user;
      document.getElementById("loginView").classList.remove("active");
      document.getElementById("appLayout").style.display = "flex";

      document.getElementById("currentUserName").textContent =
        State.user.name || "Boss";
      document.getElementById("currentUserRole").textContent = State.user.role
        ? State.user.role.toUpperCase()
        : "OWNER";

      applyRoleRestrictions(State.user.role);
      initApp();
    } else {
      showLogin();
    }
  } catch (e) {
    showLogin();
  }
}

function showLogin() {
  document.getElementById("loginView").classList.add("active");
  document.getElementById("appLayout").style.display = "none";
}

function applyRoleRestrictions(role) {
  const isAdmin = role === "owner" || role === "admin";

  document
    .querySelectorAll(".admin-only-nav, .admin-only-block")
    .forEach((el) => {
      el.style.display = isAdmin ? "" : "none";
    });

  document.querySelectorAll(".manager-only-block").forEach((el) => {
    el.style.display = isAdmin ? "none" : "";
  });

  if (!isAdmin) {
    const navOrdersText = document.getElementById("navOrdersText");
    if (navOrdersText) navOrdersText.textContent = "Мои Объекты / Биржа";

    const ordersPageTitle = document.getElementById("ordersPageTitle");
    if (ordersPageTitle) ordersPageTitle.textContent = "Мои Объекты / Биржа";

    const dashboardTitle = document.getElementById("dashboardMainTitle");
    if (dashboardTitle) dashboardTitle.textContent = "Моя Статистика";

    const dashboardSub = document.getElementById("dashboardSubTitle");
    if (dashboardSub) dashboardSub.textContent = "Ваши показатели и заработок";

    const priceBlock = document.getElementById("modalFinalPriceBlock");
    if (priceBlock) priceBlock.style.display = "flex";
  }
}

function bindAuthEvents() {
  const phoneForm = document.getElementById("phoneForm");
  const otpForm = document.getElementById("otpForm");
  const loginError = document.getElementById("loginError");

  phoneForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = document.getElementById("authPhone").value;
    const btn = document.getElementById("btnRequestOtp");

    try {
      loginError.style.display = "none";
      btn.disabled = true;
      btn.innerHTML = `<i data-feather="loader" class="spin"></i> Отправка...`;
      if (typeof feather !== "undefined") feather.replace();

      await API.requestOtp(phone);

      Utils.showToast("Код отправлен в Telegram", "success");
      phoneForm.style.display = "none";
      otpForm.style.display = "block";
    } catch (error) {
      loginError.textContent = error.message;
      loginError.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.innerHTML = `Получить код в Telegram <i data-feather="arrow-right"></i>`;
      if (typeof feather !== "undefined") feather.replace();
    }
  });

  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = document.getElementById("authPhone").value;
    const otp = document.getElementById("authOtp").value;
    const btn = document.getElementById("btnVerifyOtp");

    try {
      loginError.style.display = "none";
      btn.disabled = true;

      await API.verifyOtp(phone, otp);
      Utils.showToast("Авторизация успешна!", "success");
      checkSession();
    } catch (error) {
      loginError.textContent = error.message;
      loginError.style.display = "block";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btnBackToPhone").addEventListener("click", () => {
    otpForm.style.display = "none";
    phoneForm.style.display = "block";
    document.getElementById("authOtp").value = "";
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await API.logout();
      window.location.reload();
    } catch (e) {
      Utils.showToast("Ошибка при выходе", "error");
    }
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document
        .querySelectorAll(".nav-btn")
        .forEach((b) => b.classList.remove("active"));
      e.currentTarget.classList.add("active");

      const targetId = e.currentTarget.getAttribute("data-target");
      document.querySelectorAll(".view-section").forEach((v) => {
        v.style.display = v.id === targetId ? "block" : "none";
      });

      State.currentView = targetId;
      document.getElementById("appSidebar").classList.remove("mobile-active");
      loadViewData(targetId);
    });
  });
}

function bindMobileEvents() {
  document.getElementById("btnOpenSidebar").addEventListener("click", () => {
    document.getElementById("appSidebar").classList.add("mobile-active");
  });
  document.getElementById("btnCloseSidebar").addEventListener("click", () => {
    document.getElementById("appSidebar").classList.remove("mobile-active");
  });
}

function initApp() {
  if (typeof feather !== "undefined") feather.replace();
  loadViewData(State.currentView);
  bindGlobalEvents();
}

function loadViewData(viewId) {
  switch (viewId) {
    case "dashboardView":
      loadDashboard();
      break;
    case "ordersView":
      loadOrders();
      break;
    case "brigadesView":
      loadBrigades();
      break;
    case "financeView":
      loadFinance();
      break;
    case "settingsView":
      loadSettings();
      break;
    case "usersView":
      loadUsers();
      break;
  }
}

// =============================================================================
// 4. 📊 DEEP ANALYTICS, CHART.JS & DASHBOARD
// =============================================================================

async function loadDashboard() {
  try {
    const btn = document.getElementById("refreshStatsBtn");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i data-feather="loader" class="spin"></i> Загрузка...`;
      if (typeof feather !== "undefined") feather.replace();
    }

    // Читаем даты из UI
    State.dateStart = document.getElementById("filterDateStart")?.value || "";
    State.dateEnd = document.getElementById("filterDateEnd")?.value || "";

    const [stats, deepData] = await Promise.all([
      API.getStats(State.dateStart, State.dateEnd),
      API.getDeepAnalytics(State.dateStart, State.dateEnd),
    ]);

    const isAdmin =
      State.user &&
      (State.user.role === "owner" || State.user.role === "admin");

    if (isAdmin) {
      const elNetProfit = document.getElementById("statNetProfit");
      const elRevenue = document.getElementById("statRevenue");
      const elDebts = document.getElementById("statBrigadeDebts");

      if (elNetProfit)
        elNetProfit.textContent = Utils.formatCurrency(
          stats.overview.totalNetProfit,
        );
      if (elRevenue)
        elRevenue.textContent = Utils.formatCurrency(
          stats.overview.totalRevenue,
        );
      if (elDebts)
        elDebts.textContent = Utils.formatCurrency(
          deepData.economics.totalBrigadeDebts || 0,
        );
    } else {
      const myOrders = await API.getOrders("done"); // Менеджеру считаем только сделанное
      let myTotalEarned = 0;
      myOrders.forEach((o) => {
        const net = o.details?.financials?.net_profit || o.total_price;
        myTotalEarned += net;
      });
      const elManagerEarned = document.getElementById("statManagerEarned");
      if (elManagerEarned)
        elManagerEarned.textContent = Utils.formatCurrency(myTotalEarned);
    }

    const elAverageCheck = document.getElementById("statAverageCheck");
    if (elAverageCheck)
      elAverageCheck.textContent = Utils.formatCurrency(
        deepData.economics.averageCheck || 0,
      );

    renderFunnel(stats.funnel);
    renderExpensesChart(deepData.expenseBreakdown);

    if (isAdmin) {
      const [timelineData, brigadesData, ordersTimelineData] =
        await Promise.all([
          API.getTimeline(State.dateStart, State.dateEnd),
          API.getBrigadesAnalytics(State.dateStart, State.dateEnd),
          API.getOrdersTimeline(State.dateStart, State.dateEnd),
        ]);
      renderTimelineChart(timelineData);
      renderLeaderboard(brigadesData);
      renderOrdersTimelineChart(ordersTimelineData);
    } else {
      const ordersTimelineData = await API.getOrdersTimeline(
        State.dateStart,
        State.dateEnd,
      );
      renderOrdersTimelineChart(ordersTimelineData);
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-feather="refresh-cw"></i> Применить`;
      if (typeof feather !== "undefined") feather.replace();
    }
  } catch (e) {
    console.error(e);
    Utils.showToast("Ошибка загрузки аналитики", "error");
    const btn = document.getElementById("refreshStatsBtn");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-feather="refresh-cw"></i> Применить`;
      feather.replace();
    }
  }
}

function renderTimelineChart(data) {
  const canvas = document.getElementById("timelineChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (State.timelineChartInstance) {
    State.timelineChartInstance.destroy();
  }

  if (!Array.isArray(data) || data.length === 0) return;

  const sortedData = [...data].reverse();
  const labels = sortedData.map((d) => d.month);
  const revenue = sortedData.map((d) => parseFloat(d.gross_revenue));
  const netProfit = sortedData.map((d) => parseFloat(d.net_profit));

  State.timelineChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Оборот (Выручка)",
          data: revenue,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          borderWidth: 2,
          fill: true,
          tension: 0.4,
        },
        {
          label: "Чистая прибыль",
          data: netProfit,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.1)",
          borderWidth: 2,
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#f4f4f5" } } },
      scales: {
        x: {
          ticks: { color: "#a1a1aa" },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: { color: "#a1a1aa" },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
}

function renderOrdersTimelineChart(data) {
  const canvas = document.getElementById("ordersTimelineChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (State.ordersTimelineChartInstance) {
    State.ordersTimelineChartInstance.destroy();
  }

  if (!Array.isArray(data) || data.length === 0) return;

  const sortedData = [...data].reverse();
  const labels = sortedData.map((d) => d.month);
  const newOrders = sortedData.map((d) => parseInt(d.new_orders) || 0);
  const workOrders = sortedData.map((d) => parseInt(d.work_orders) || 0);
  const doneOrders = sortedData.map((d) => parseInt(d.done_orders) || 0);

  State.ordersTimelineChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        { label: "Новые", data: newOrders, backgroundColor: "#3b82f6" },
        { label: "В работе", data: workOrders, backgroundColor: "#f59e0b" },
        { label: "Завершено", data: doneOrders, backgroundColor: "#10b981" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#f4f4f5" } } },
      scales: {
        x: {
          stacked: true,
          ticks: { color: "#a1a1aa" },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          stacked: true,
          ticks: { color: "#a1a1aa", stepSize: 1 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
}

function renderLeaderboard(brigades) {
  const tbody = document.getElementById("leaderboardTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!Array.isArray(brigades) || brigades.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="pe-text-center pe-text-muted">Нет данных для рейтинга</td></tr>';
    return;
  }

  brigades.forEach((b) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${b.name || "Без названия"}</b></td>
      <td>${b.closed_orders_count} шт.</td>
      <td>${Utils.formatCurrency(b.total_revenue_brought)}</td>
      <td class="pe-text-success fw-bold">${Utils.formatCurrency(b.total_net_profit_brought)}</td>
      <td class="pe-text-right ${b.current_debt > 0 ? "pe-text-danger fw-bold" : ""}">${Utils.formatCurrency(b.current_debt)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderFunnel(funnelData) {
  const container = document.getElementById("funnelChart");
  if (!container) return;
  container.innerHTML = "";

  const statuses = [
    { key: "new", label: "Новые (Биржа)", color: "#3b82f6" },
    { key: "work", label: "В работе", color: "#f59e0b" },
    { key: "done", label: "Завершено (Выручка)", color: "#10b981" },
  ];

  statuses.forEach((s) => {
    const stat = Array.isArray(funnelData)
      ? funnelData.find((f) => f.status === s.key)
      : null;
    const count = stat ? stat.count : 0;
    const sum = stat ? stat.sum : 0;

    const row = document.createElement("div");
    row.className = "funnel-row pe-mb-2";
    row.innerHTML = `
      <div class="funnel-label" style="border-left: 4px solid ${s.color}; padding-left: 10px;">${s.label}</div>
      <div class="funnel-value"><b>${count}</b> шт.</div>
      <div class="funnel-sum">${Utils.formatCurrency(sum)}</div>
    `;
    container.appendChild(row);
  });
}

function renderExpensesChart(expensesData) {
  const container = document.getElementById("expensesChart");
  if (!container) return;
  container.innerHTML = "";

  if (!Array.isArray(expensesData) || expensesData.length === 0) {
    container.innerHTML = `<div class="pe-text-muted">Нет данных о расходах</div>`;
    return;
  }

  expensesData.forEach((exp) => {
    const row = document.createElement("div");
    row.className = "funnel-row pe-mb-2";
    row.innerHTML = `
      <div class="funnel-label" style="border-left: 4px solid #ef4444; padding-left: 10px;">${exp.category || "Прочее"}</div>
      <div class="funnel-sum pe-text-danger">-${Utils.formatCurrency(exp.total)}</div>
    `;
    container.appendChild(row);
  });
}

// =============================================================================
// 5. 🏗 УПРАВЛЕНИЕ БРИГАДАМИ И ИНКАССАЦИЯ (ERP)
// =============================================================================

async function loadBrigades() {
  try {
    State.brigades = await API.getBrigades();
    const tbody = document.getElementById("brigadesTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!Array.isArray(State.brigades) || State.brigades.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pe-text-center">Бригады не найдены</td></tr>';
      return;
    }

    State.brigades.forEach((b) => {
      const balance = b.balance || 0;
      const debt = balance < 0 ? Math.abs(balance) : 0;
      const debtClass = debt > 0 ? "pe-text-danger fw-bold" : "pe-text-success";

      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td><b>#${b.id}</b> ${b.name || "Без названия"}</td>
        <td><code>${b.brigadier_id}</code></td>
        <td>${b.profit_percentage || 0}%</td>
        <td class="${debtClass}">${Utils.formatCurrency(debt)}</td>
        <td><span class="pe-badge ${b.is_active ? "badge-done" : "badge-cancel"}">${b.is_active ? "Активна" : "Заблокирована"}</span></td>
        <td class="pe-text-right" style="display:flex; flex-direction:column; gap:0.5rem; align-items:flex-end;">
          ${debt > 0 ? `<button class="pe-btn pe-btn-sm pe-btn-success" onclick="openIncassationModal(${b.brigadier_id}, '${b.name || "Бригада"}')">Списать долг</button>` : ""}
          <div style="display:flex; gap:0.25rem;">
             <button class="pe-btn pe-btn-sm pe-btn-secondary" onclick="window.openEditBrigadeModal(${b.id}, ${b.profit_percentage})"><i data-feather="percent"></i></button>
             <button class="pe-btn pe-btn-sm ${b.is_active ? "pe-btn-danger" : "pe-btn-primary"}" onclick="window.toggleBrigadeStatus(${b.id}, ${!b.is_active})">
               ${b.is_active ? "🚫 Блок" : "✅ Акт"}
             </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
    if (typeof feather !== "undefined") feather.replace();
  } catch (e) {
    Utils.showToast("Ошибка загрузки бригад", "error");
  }
}

window.toggleBrigadeStatus = async (brigadeId, isActive) => {
  const actionText = isActive ? "АКТИВИРОВАТЬ" : "ЗАБЛОКИРОВАТЬ";
  if (!confirm(`Вы уверены, что хотите ${actionText} эту бригаду?`)) return;
  try {
    await API.updateBrigade(brigadeId, null, isActive);
    Utils.showToast(
      `Бригада успешно ${isActive ? "активирована" : "заблокирована"}`,
      "success",
    );
    loadBrigades();
  } catch (err) {
    Utils.showToast(err.message, "error");
  }
};

window.openEditBrigadeModal = (id, percent) => {
  document.getElementById("editBrigId").value = id;
  document.getElementById("editBrigProfit").value = percent;
  document.getElementById("editBrigadeModal").style.display = "flex";
};

window.openIncassationModal = (brigadierId, brigadeName) => {
  document.getElementById("incBrigadeId").value = brigadierId;
  document.getElementById("incBrigadeName").value = brigadeName;
  document.getElementById("incAmount").value = "";
  document.getElementById("incassationModal").style.display = "flex";
};

// =============================================================================
// 6. 📦 УПРАВЛЕНИЕ ОБЪЕКТАМИ (ORDER MANAGEMENT)
// =============================================================================

async function loadOrders() {
  try {
    const status = document.getElementById("orderStatusFilter").value;
    State.orders = await API.getOrders(status);
    const tbody = document.getElementById("ordersTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (
      State.user &&
      (State.user.role === "owner" || State.user.role === "admin")
    ) {
      State.brigades = await API.getBrigades();
    }

    if (!Array.isArray(State.orders) || State.orders.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="pe-text-center">Объектов не найдено</td></tr>';
      return;
    }

    State.orders.forEach((o) => {
      const financials = o.details?.financials || {};
      const netProfit =
        financials.net_profit !== undefined
          ? financials.net_profit
          : o.total_price;
      const area = o.area || o.details?.params?.area || 0;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b>#${o.id}</b><br><small class="pe-text-muted">${Utils.formatDate(o.created_at)}</small></td>
        <td>${o.client_name || "Неизвестно"}<br><small>${o.client_phone || "—"}</small></td>
        <td>${area} м²</td>
        <td>${o.brigade_name ? `<span class="pe-badge badge-processing">${o.brigade_name}</span>` : '<span class="pe-text-muted">Биржа</span>'}</td>
        <td><span class="pe-badge badge-${o.status}">${o.status.toUpperCase()}</span></td>
        <td class="pe-text-success fw-bold">${Utils.formatCurrency(netProfit)}</td>
        <td class="pe-text-right">
            <button class="pe-btn pe-btn-sm pe-btn-secondary" onclick="openOrderModal(${o.id})">
                Управление
            </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    Utils.showToast("Ошибка загрузки заказов", "error");
  }
}

window.openOrderModal = (orderId) => {
  const order = State.orders.find((o) => o.id === orderId);
  if (!order) return;
  State.selectedOrderId = order.id;

  const area = order.area || order.details?.params?.area || 0;
  document.getElementById("modalOrderTitle").textContent =
    `Объект #${order.id} (${area} м²)`;

  // Поля метаданных
  document.getElementById("modalOrderAddress").value =
    order.details?.address || "";
  document.getElementById("modalOrderComment").value =
    order.details?.admin_comment || "";

  const statusSelect = document.getElementById("modalOrderStatus");
  const isAdmin =
    State.user && (State.user.role === "owner" || State.user.role === "admin");
  const isDone = order.status === "done";

  // Кнопка взять в работу (Биржа)
  const btnTake = document.getElementById("btnTakeOrderWeb");
  if (!isAdmin && order.status === "new") {
    btnTake.style.display = "flex";
  } else {
    btnTake.style.display = "none";
  }

  if (isAdmin) {
    statusSelect.innerHTML = `
      <option value="new">Новый (Биржа)</option>
      <option value="processing">Взят в расчет / Замер</option>
      <option value="work">В работе (Монтаж)</option>
      <option value="done">Завершен</option>
      <option value="cancel">Отменен</option>
    `;
  } else {
    statusSelect.innerHTML = `
      <option value="processing">Взят в расчет / Замер</option>
      <option value="work">В работе (Монтаж)</option>
    `;
    if (!["processing", "work"].includes(order.status)) {
      statusSelect.innerHTML += `<option value="${order.status}" disabled>${order.status.toUpperCase()}</option>`;
    }
  }
  statusSelect.value = order.status;

  const brigadeSelect = document.getElementById("modalOrderBrigade");
  if (isAdmin) {
    brigadeSelect.disabled = false;
    brigadeSelect.innerHTML = `<option value="">-- Не назначена (Биржа) --</option>`;
    if (Array.isArray(State.brigades)) {
      State.brigades.forEach((b) => {
        brigadeSelect.innerHTML += `<option value="${b.id}" ${order.brigade_id === b.id ? "selected" : ""}>${b.name}</option>`;
      });
    }
  } else {
    brigadeSelect.innerHTML = `<option>${order.brigade_name || "Не назначена"}</option>`;
    brigadeSelect.disabled = true;
  }

  const btnFinalize = document.getElementById("btnFinalizeOrder");
  if (isAdmin && order.status === "work" && order.brigade_id) {
    btnFinalize.style.display = "flex";
  } else {
    btnFinalize.style.display = "none";
  }

  // 🔥 РЕЖИМ READ-ONLY ДЛЯ ЗАВЕРШЕННЫХ ОБЪЕКТОВ
  const warningDiv = document.getElementById("orderDoneWarning");
  const editables = document.querySelectorAll(".order-editable-field");

  if (isDone) {
    warningDiv.style.display = "block";
    editables.forEach((el) => (el.disabled = true));
  } else {
    warningDiv.style.display = "none";
    editables.forEach((el) => (el.disabled = false));
  }

  State.currentBOM = Array.isArray(order.details?.bom)
    ? JSON.parse(JSON.stringify(order.details.bom))
    : [];
  renderBOMEditor(isDone);
  renderOrderFinancials(order);

  document.getElementById("orderModal").style.display = "flex";
  if (typeof feather !== "undefined") feather.replace();
};

function renderOrderFinancials(order) {
  const details = order.details || {};
  const financials = details.financials || {
    final_price: order.total_price,
    total_expenses: 0,
    net_profit: order.total_price,
    expenses: [],
  };

  document.getElementById("modalCalcPrice").textContent = Utils.formatCurrency(
    details.total?.work || order.total_price,
  );
  document.getElementById("modalFinalPrice").value = financials.final_price;
  document.getElementById("modalTotalExpenses").textContent =
    Utils.formatCurrency(financials.total_expenses);
  document.getElementById("modalNetProfit").textContent = Utils.formatCurrency(
    financials.net_profit,
  );

  const expensesList = document.getElementById("modalExpensesList");
  expensesList.innerHTML = "";

  const expensesArray = Array.isArray(financials.expenses)
    ? financials.expenses
    : [];
  if (expensesArray.length === 0) {
    expensesList.innerHTML =
      '<div class="pe-text-muted text-center p-1">Нет чеков по объекту</div>';
  } else {
    expensesArray.forEach((exp) => {
      const div = document.createElement("div");
      div.className = "expense-item";
      div.innerHTML = `
        <div>
          <strong>${exp.category}</strong> <small class="pe-text-muted">${Utils.formatDate(exp.date)}</small>
          <div style="font-size:0.75rem;">${exp.comment || ""}</div>
        </div>
        <div class="pe-text-danger fw-bold">-${Utils.formatCurrency(exp.amount)}</div>
      `;
      expensesList.appendChild(div);
    });
  }
}

function renderBOMEditor(isDone) {
  const container = document.getElementById("modalBOMList");
  container.innerHTML = "";

  if (State.currentBOM.length === 0) {
    container.innerHTML =
      '<div class="pe-text-muted pe-mb-4" style="font-size: 0.875rem;">Спецификация пуста</div>';
  } else {
    State.currentBOM.forEach((item, index) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "0.5rem";
      row.style.marginBottom = "0.5rem";
      row.style.alignItems = "center";
      row.innerHTML = `
        <input type="text" class="pe-input pe-input-sm" style="flex:1;" value="${item.name}" placeholder="Наименование" onchange="window.updateBOMItem(${index}, 'name', this.value)" ${isDone ? "disabled" : ""}>
        <input type="number" class="pe-input pe-input-sm" style="width:70px;" value="${item.qty}" placeholder="Кол-во" onchange="window.updateBOMItem(${index}, 'qty', this.value)" ${isDone ? "disabled" : ""}>
        <input type="text" class="pe-input pe-input-sm" style="width:60px;" value="${item.unit}" placeholder="Ед." onchange="window.updateBOMItem(${index}, 'unit', this.value)" ${isDone ? "disabled" : ""}>
        ${!isDone ? `<button class="pe-btn pe-btn-danger pe-btn-sm pe-btn-icon" onclick="window.removeBOMItem(${index})"><i data-feather="trash-2"></i></button>` : ""}
      `;
      container.appendChild(row);
    });
  }

  if (!isDone) {
    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "0.5rem";
    controls.style.marginTop = "1rem";
    controls.innerHTML = `
      <button class="pe-btn pe-btn-secondary pe-btn-sm" onclick="window.addBOMItem()"><i data-feather="plus"></i> Добавить</button>
      <button class="pe-btn pe-btn-primary pe-btn-sm" onclick="window.saveBOMArray()"><i data-feather="save"></i> Сохранить BOM</button>
    `;
    container.appendChild(controls);
  }
  if (typeof feather !== "undefined") feather.replace();
}

window.updateBOMItem = (i, f, v) =>
  (State.currentBOM[i][f] = f === "qty" ? parseFloat(v) || 0 : v);
window.removeBOMItem = (i) => {
  State.currentBOM.splice(i, 1);
  renderBOMEditor(false);
};
window.addBOMItem = () => {
  State.currentBOM.push({ name: "", qty: 1, unit: "шт" });
  renderBOMEditor(false);
};
window.saveBOMArray = async () => {
  if (!State.selectedOrderId) return;
  try {
    await API.updateBOM(State.selectedOrderId, State.currentBOM);
    Utils.showToast("Спецификация сохранена", "success");
    loadOrders();
  } catch (err) {
    Utils.showToast(err.message, "error");
  }
};

// =============================================================================
// 7. 🏢 ГЛОБАЛЬНАЯ КАССА (CORPORATE FINANCE)
// =============================================================================

async function loadFinance() {
  try {
    const accounts = await API.getFinanceAccounts();
    State.financeAccounts = accounts;

    const grid = document.getElementById("financeAccountsGrid");
    const accountSelect = document.getElementById("txAccount");
    if (grid) grid.innerHTML = "";
    if (accountSelect) accountSelect.innerHTML = "";

    if (Array.isArray(accounts)) {
      accounts.forEach((acc) => {
        const icon =
          acc.type === "cash"
            ? "dollar-sign"
            : acc.type === "brigade_acc"
              ? "hard-hat"
              : "credit-card";
        const colorClass =
          acc.balance >= 0 ? "pe-kpi-primary" : "pe-kpi-danger";

        grid.innerHTML += `
          <div class="pe-card pe-card-kpi ${colorClass}">
            <div class="pe-kpi-icon"><i data-feather="${icon}"></i></div>
            <div class="pe-kpi-data">
              <span class="pe-kpi-label">${acc.name}</span>
              <h3 class="pe-kpi-value">${Utils.formatCurrency(acc.balance)}</h3>
            </div>
          </div>
        `;
        accountSelect.innerHTML += `<option value="${acc.id}">${acc.name} (Баланс: ${Utils.formatCurrency(acc.balance)})</option>`;
      });
    }

    const transactions = await API.getFinanceTransactions(50);
    const tbody = document.getElementById("transactionsTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!Array.isArray(transactions) || transactions.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pe-text-center pe-text-muted">Операций нет</td></tr>';
    } else {
      transactions.forEach((tx) => {
        const isIncome = tx.type === "income";
        const amountClass = isIncome ? "pe-text-success" : "pe-text-danger";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${Utils.formatDate(tx.created_at)}</td>
          <td><span class="pe-badge ${isIncome ? "badge-done" : "badge-cancel"}">${isIncome ? "ДОХОД" : "РАСХОД"}</span></td>
          <td><b>${tx.account_name || "Неизвестный счет"}</b></td>
          <td>${tx.category || "—"}</td>
          <td class="${amountClass} fw-bold">${isIncome ? "+" : "-"}${Utils.formatCurrency(tx.amount)}</td>
          <td>${tx.comment || "—"}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    if (typeof feather !== "undefined") feather.replace();
  } catch (e) {
    Utils.showToast("Ошибка загрузки финансового модуля", "error");
  }
}

// =============================================================================
// 8. 🎯 ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ СОБЫТИЙ (BINDINGS)
// =============================================================================

function bindGlobalEvents() {
  document
    .getElementById("refreshStatsBtn")
    ?.addEventListener("click", loadDashboard);
  document
    .getElementById("orderStatusFilter")
    ?.addEventListener("change", loadOrders);

  // Живой поиск по пользователям
  document.getElementById("searchUserInput")?.addEventListener("input", (e) => {
    State.searchUserTerm = e.target.value;
    // Дебаунс для поиска
    clearTimeout(window.searchTimeout);
    window.searchTimeout = setTimeout(() => {
      loadUsers();
    }, 500);
  });

  document
    .getElementById("btnCloseOrderModal")
    ?.addEventListener("click", () => {
      document.getElementById("orderModal").style.display = "none";
      State.selectedOrderId = null;
    });

  document
    .getElementById("btnTakeOrderWeb")
    ?.addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      try {
        await API.takeOrderWeb(State.selectedOrderId);
        Utils.showToast("Вы забрали заказ с биржи!", "success");
        document.getElementById("orderModal").style.display = "none";
        loadOrders();
      } catch (e) {
        Utils.showToast(e.message, "error");
      }
    });

  document
    .getElementById("btnSaveMetadata")
    ?.addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      const address = document.getElementById("modalOrderAddress").value;
      const comment = document.getElementById("modalOrderComment").value;
      try {
        await API.updateOrderMetadata(State.selectedOrderId, address, comment);
        Utils.showToast("Данные объекта сохранены", "success");
        loadOrders();
      } catch (e) {
        Utils.showToast(e.message, "error");
      }
    });

  document
    .getElementById("modalOrderBrigade")
    ?.addEventListener("change", async (e) => {
      if (!State.selectedOrderId || !e.target.value) return;
      try {
        await API.assignBrigade(State.selectedOrderId, e.target.value);
        Utils.showToast("Бригада назначена на объект", "success");
        loadOrders();
        document.getElementById("orderModal").style.display = "none";
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("modalOrderStatus")
    ?.addEventListener("change", async (e) => {
      if (!State.selectedOrderId) return;
      try {
        await API.updateOrderStatus(State.selectedOrderId, e.target.value);
        Utils.showToast("Статус обновлен", "success");
        loadOrders();
        document.getElementById("orderModal").style.display = "none"; // Закрываем, чтобы обновить UI (Read-Only)
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnFinalizeOrder")
    ?.addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      if (
        !confirm(
          "Вы уверены, что хотите закрыть объект? Будет произведен расчет долей и начислен долг на бригаду.",
        )
      )
        return;

      try {
        const btn = document.getElementById("btnFinalizeOrder");
        btn.disabled = true;
        btn.innerHTML = `<i data-feather="loader" class="spin"></i> Расчет...`;
        if (typeof feather !== "undefined") feather.replace();

        const res = await API.finalizeOrder(State.selectedOrderId);
        Utils.showToast(
          `Объект закрыт! Заработано бригадой: ${Utils.formatCurrency(res.distribution.brigadeShare)}. Долг Шефу: ${Utils.formatCurrency(res.distribution.ownerShare)}`,
          "success",
        );

        document.getElementById("orderModal").style.display = "none";
        loadOrders();
        if (State.currentView === "dashboardView") loadDashboard();
      } catch (err) {
        Utils.showToast(err.message, "error");
        const btn = document.getElementById("btnFinalizeOrder");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<i data-feather="check-circle"></i> ЗАКРЫТЬ И РАСПРЕДЕЛИТЬ ПРИБЫЛЬ`;
          if (typeof feather !== "undefined") feather.replace();
        }
      }
    });

  document
    .getElementById("btnUpdateFinalPrice")
    ?.addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      try {
        await API.updateOrderFinalPrice(
          State.selectedOrderId,
          document.getElementById("modalFinalPrice").value,
        );
        Utils.showToast("Итоговая цена зафиксирована", "success");
        loadOrders();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnAddExpense")
    ?.addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      const amount = document.getElementById("newExpenseAmount").value;
      const cat = document.getElementById("newExpenseCat").value;
      if (!amount || amount <= 0)
        return Utils.showToast("Введите корректную сумму", "error");
      try {
        await API.addOrderExpense(
          State.selectedOrderId,
          amount,
          cat,
          "Web CRM",
        );
        Utils.showToast("Расход добавлен", "success");
        document.getElementById("newExpenseAmount").value = "";
        document.getElementById("newExpenseCat").value = "";
        loadOrders();
        document.getElementById("orderModal").style.display = "none";
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // Модалка: Оффлайн заказ
  document
    .getElementById("btnOpenManualOrderModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("manualOrderModal").style.display = "flex"),
    );
  document
    .getElementById("btnCloseManualModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("manualOrderModal").style.display = "none"),
    );
  document
    .getElementById("formManualOrder")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {
        clientName: document.getElementById("manualName").value,
        clientPhone: document.getElementById("manualPhone").value,
        area: document.getElementById("manualArea").value,
        rooms: document.getElementById("manualRooms").value,
        wallType: document.getElementById("manualWallType").value,
      };
      try {
        await API.createManualOrder(data);
        document.getElementById("manualOrderModal").style.display = "none";
        document.getElementById("formManualOrder").reset();
        Utils.showToast("Оффлайн-заказ успешно создан!", "success");
        loadOrders();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // Модалка: Бригады
  document
    .getElementById("btnOpenBrigadeModal")
    ?.addEventListener(
      "click",
      () => (document.getElementById("brigadeModal").style.display = "flex"),
    );
  document
    .getElementById("btnCloseBrigadeModal")
    ?.addEventListener(
      "click",
      () => (document.getElementById("brigadeModal").style.display = "none"),
    );
  document
    .getElementById("formBrigade")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await API.createBrigade(
          document.getElementById("brigNewName").value,
          document.getElementById("brigNewId").value,
          document.getElementById("brigNewProfit").value,
        );
        document.getElementById("brigadeModal").style.display = "none";
        document.getElementById("formBrigade").reset();
        Utils.showToast("Бригада создана", "success");
        loadBrigades();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // Модалка: Редактирование % Бригады
  document
    .getElementById("btnCloseEditBrigadeModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("editBrigadeModal").style.display = "none"),
    );
  document
    .getElementById("formEditBrigade")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await API.updateBrigade(
          document.getElementById("editBrigId").value,
          document.getElementById("editBrigProfit").value,
          null,
        );
        document.getElementById("editBrigadeModal").style.display = "none";
        Utils.showToast("Процент успешно изменен", "success");
        loadBrigades();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnCloseIncassationModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("incassationModal").style.display = "none"),
    );
  document
    .getElementById("formIncassation")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const brigadierId = document.getElementById("incBrigadeId").value;
      const amount = document.getElementById("incAmount").value;
      try {
        await API.approveIncassation(brigadierId, amount);
        Utils.showToast("Деньги приняты, долг списан!", "success");
        document.getElementById("incassationModal").style.display = "none";
        loadBrigades();
        loadFinance();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnOpenTransactionModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("transactionModal").style.display = "flex"),
    );
  document
    .getElementById("btnCloseTransactionModal")
    ?.addEventListener(
      "click",
      () =>
        (document.getElementById("transactionModal").style.display = "none"),
    );
  document
    .getElementById("formTransaction")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {
        accountId: document.getElementById("txAccount").value,
        type: document.getElementById("txType").value,
        amount: document.getElementById("txAmount").value,
        category: document.getElementById("txCategory").value,
        comment: document.getElementById("txComment").value,
      };
      try {
        await API.addFinanceTransaction(data);
        document.getElementById("transactionModal").style.display = "none";
        document.getElementById("formTransaction").reset();
        Utils.showToast("Операция успешно проведена", "success");
        loadFinance();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnDownloadBackup")
    ?.addEventListener("click", async () => {
      try {
        Utils.showToast("Формирование дампа...", "info");
        const res = await API.downloadBackup();
        Utils.downloadBlob(
          res,
          `ProElectric_DB_${new Date().toISOString().slice(0, 10)}.json`,
        );
        Utils.showToast("Резервная копия скачана", "success");
      } catch (e) {
        Utils.showToast("Ошибка скачивания бекапа", "error");
      }
    });

  document
    .getElementById("btnSendBroadcast")
    ?.addEventListener("click", async () => {
      const text = document.getElementById("broadcastText").value;
      const target = document.getElementById("broadcastTarget").value;
      if (!text) return Utils.showToast("Введите текст рассылки", "error");
      try {
        const res = await API.sendBroadcast(text, null, target);
        Utils.showToast(res.message, "success");
        document.getElementById("broadcastText").value = "";
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });
}

// =============================================================================
// 9. ⚙️ НАСТРОЙКИ ПРАЙСА И ПЕРСОНАЛ
// =============================================================================

async function loadSettings() {
  try {
    const pricelist = await API.getPricelist();
    const container = document.getElementById("settingsFormContainer");
    if (!container) return;
    container.innerHTML = "";

    if (Array.isArray(pricelist)) {
      pricelist.forEach((section) => {
        const sectionDiv = document.createElement("div");
        sectionDiv.className = "pe-mb-6";
        sectionDiv.innerHTML = `<h4 class="pe-h4 pe-mb-4 pe-text-primary" style="border-bottom: 1px solid var(--pe-border); padding-bottom: 8px;">${section.category}</h4>`;

        const grid = document.createElement("div");
        grid.className = "pe-settings-grid";

        section.items.forEach((item) => {
          grid.innerHTML += `
            <div class="pe-form-group">
              <label>${item.name} (${item.unit})</label>
              <input type="number" class="pe-input setting-input" data-key="${item.key}" value="${item.currentPrice}">
            </div>
          `;
        });
        sectionDiv.appendChild(grid);
        container.appendChild(sectionDiv);
      });
    }
  } catch (e) {
    Utils.showToast("Ошибка загрузки прайс-листа", "error");
  }
}

document
  .getElementById("btnSaveSettings")
  ?.addEventListener("click", async () => {
    const inputs = document.querySelectorAll(".setting-input");
    const payload = [];
    inputs.forEach((input) =>
      payload.push({
        key: input.getAttribute("data-key"),
        value: parseFloat(input.value) || 0,
      }),
    );
    try {
      await API.updateBulkSettings(payload);
      Utils.showToast("Прайс-лист успешно обновлен", "success");
    } catch (e) {
      Utils.showToast("Ошибка при обновлении цен", "error");
    }
  });

async function loadUsers() {
  try {
    // Используем State.searchUserTerm для передачи в API
    State.users = await API.getUsers(State.searchUserTerm);
    const tbody = document.getElementById("usersTableBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!Array.isArray(State.users) || State.users.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="pe-text-center">Пользователи не найдены</td></tr>';
      return;
    }

    State.users.forEach((u) => {
      const isManager = u.role === "manager";
      const isAdmin = u.role === "admin" || u.role === "owner";
      const usernameDisplay = u.username ? `@${u.username}` : "нет username";
      const phoneDisplay = u.phone ? u.phone : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.telegram_id}</td>
        <td>${u.first_name || "Без имени"} <br> <small class="pe-text-muted">${usernameDisplay}</small></td>
        <td>${phoneDisplay}</td>
        <td>
          <select class="pe-input pe-input-sm role-select" data-uid="${u.telegram_id}" ${isAdmin && u.telegram_id === State.user.id ? "disabled" : ""}>
            <option value="user" ${u.role === "user" ? "selected" : ""}>Клиент</option>
            <option value="manager" ${isManager ? "selected" : ""}>Мастер (Бригадир)</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Администратор</option>
            ${u.role === "owner" ? `<option value="owner" selected>Владелец</option>` : ""}
          </select>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll(".role-select").forEach((select) => {
      select.addEventListener("change", async (e) => {
        try {
          await API.updateUserRole(
            e.target.getAttribute("data-uid"),
            e.target.value,
          );
          Utils.showToast("Роль успешно изменена", "success");
        } catch (err) {
          Utils.showToast(err.message, "error");
          loadUsers();
        }
      });
    });
  } catch (e) {
    Utils.showToast("Ошибка загрузки пользователей", "error");
  }
}

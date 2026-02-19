/**
 * @file public/js/app.js
 * @description Frontend Application Controller (SPA Logic v10.0.0).
 * Управляет состоянием интерфейса, модальными окнами, заказами и настройками.
 * Включает новый Глобальный Финансовый Модуль (Касса, Счета, Транзакции).
 *
 * @module AppController
 * @version 10.0.0 (Enterprise Finance Edition)
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
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let icon = "info";
    if (type === "success") icon = "check-circle";
    if (type === "error") icon = "alert-circle";

    toast.innerHTML = `<i data-feather="${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    if (typeof feather !== "undefined") feather.replace();

    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },
};

// =============================================================================
// 2. 🧠 СТЭЙТ И ИНИЦИАЛИЗАЦИЯ (STATE MANAGEMENT)
// =============================================================================

const State = {
  currentView: "dashboardView",
  orders: [],
  users: [],
  selectedOrderId: null,
  currentBOM: [], // Временное хранилище редактируемого массива спецификации
  financeAccounts: [], // Хранилище счетов (Касса)
};

document.addEventListener("DOMContentLoaded", async () => {
  bindAuthEvents();
  await checkSession();
});

// =============================================================================
// 3. 🔐 АВТОРИЗАЦИЯ И НАВИГАЦИЯ (AUTH & ROUTING)
// =============================================================================

async function checkSession() {
  try {
    const res = await API.checkAuth();
    if (res.authenticated) {
      document.getElementById("loginView").classList.remove("active");
      document.getElementById("appLayout").style.display = "flex";
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

function bindAuthEvents() {
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const l = document.getElementById("adminLogin").value;
    const p = document.getElementById("adminPassword").value;
    const errDiv = document.getElementById("loginError");

    try {
      errDiv.style.display = "none";
      await API.login(l, p);
      Utils.showToast("Успешный вход. Добро пожаловать, Босс!", "success");
      checkSession();
    } catch (error) {
      errDiv.textContent = error.message;
      errDiv.style.display = "block";
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await API.logout();
      window.location.reload();
    } catch (e) {
      Utils.showToast("Ошибка при выходе", "error");
    }
  });

  // Навигация
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
      loadViewData(targetId);
    });
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
    case "financeView":
      loadFinance(); // NEW: Инициализация Глобальной Кассы
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
// 4. 📊 ДАШБОРД (DASHBOARD LOGIC)
// =============================================================================

async function loadDashboard() {
  try {
    const data = await API.getStats();

    document.getElementById("statNetProfit").textContent = Utils.formatCurrency(
      data.overview.totalNetProfit,
    );
    document.getElementById("statRevenue").textContent = Utils.formatCurrency(
      data.overview.totalRevenue,
    );
    document.getElementById("statActiveOrders").textContent =
      data.overview.pendingOrders;
    document.getElementById("statTotalUsers").textContent =
      data.overview.totalUsers;

    renderFunnel(data.funnel);
  } catch (e) {
    Utils.showToast("Ошибка загрузки статистики", "error");
  }
}

function renderFunnel(funnelData) {
  const container = document.getElementById("funnelChart");
  container.innerHTML = "";

  const statuses = [
    { key: "new", label: "Новые лиды", color: "#3b82f6" },
    { key: "work", label: "В работе", color: "#f59e0b" },
    { key: "done", label: "Завершено", color: "#10b981" },
  ];

  statuses.forEach((s) => {
    const stat = funnelData[s.key] || { count: 0, sum: 0 };
    const row = document.createElement("div");
    row.className = "funnel-row";
    row.innerHTML = `
            <div class="funnel-label" style="border-left: 4px solid ${s.color}; padding-left: 10px;">${s.label}</div>
            <div class="funnel-value"><b>${stat.count}</b> шт.</div>
            <div class="funnel-sum">${Utils.formatCurrency(stat.sum)}</div>
        `;
    container.appendChild(row);
  });
}

// =============================================================================
// 5. 📦 УПРАВЛЕНИЕ ЗАКАЗАМИ (ORDERS & OFFLINE LEADS)
// =============================================================================

async function loadOrders() {
  try {
    const status = document.getElementById("orderStatusFilter").value;
    State.orders = await API.getOrders(status);
    const tbody = document.getElementById("ordersTableBody");
    tbody.innerHTML = "";

    State.orders.forEach((o) => {
      const financials = o.details?.financials || {};
      const netProfit =
        financials.net_profit !== undefined
          ? financials.net_profit
          : o.total_price;

      // Self-Healing: Защита от "null м²" для старых заказов
      const area = o.area || o.details?.params?.area || 0;

      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td><b>#${o.id}</b><br><small class="pe-text-muted">${Utils.formatDate(o.created_at)}</small></td>
                <td>${o.client_name || "Неизвестно"}<br><small>${o.client_phone || "—"}</small></td>
                <td>${area} м²</td>
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

  // Self-Healing: Защита от "null м²"
  const area = order.area || order.details?.params?.area || 0;

  // Инфо
  document.getElementById("modalOrderTitle").textContent =
    `Объект #${order.id} (${area} м²)`;
  document.getElementById("modalClientName").textContent =
    order.client_name || "Оффлайн клиент";
  document.getElementById("modalClientPhone").textContent =
    order.client_phone || "—";

  // Статус
  const statusSelect = document.getElementById("modalOrderStatus");
  statusSelect.innerHTML = `
        <option value="new">Новый (Лид)</option>
        <option value="processing">Взят в расчет (Замер)</option>
        <option value="work">В работе (Монтаж)</option>
        <option value="done">Завершен успешно</option>
        <option value="cancel">Отказ / Отмена</option>
    `;
  statusSelect.value = order.status;

  // 🚀 ИНИЦИАЛИЗАЦИЯ ИНТЕРАКТИВНОГО BOM
  State.currentBOM = Array.isArray(order.details?.bom)
    ? JSON.parse(JSON.stringify(order.details.bom))
    : [];
  renderBOMEditor();

  // Финансы (ERP Core)
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

  // Self-Healing: Гарантируем, что expenses - это массив
  const expensesArray = Array.isArray(financials.expenses)
    ? financials.expenses
    : [];

  if (expensesArray.length === 0) {
    expensesList.innerHTML =
      '<div class="pe-text-muted text-center p-1">Нет расходов по объекту</div>';
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

// =============================================================================
// 6. 🛠 РЕДАКТОР СПЕЦИФИКАЦИИ (BOM ARRAY MANAGER)
// =============================================================================

function renderBOMEditor() {
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
                <input type="text" class="pe-input pe-input-sm" style="flex:1;" value="${item.name}" placeholder="Наименование" onchange="window.updateBOMItem(${index}, 'name', this.value)">
                <input type="number" class="pe-input pe-input-sm" style="width:70px;" value="${item.qty}" placeholder="Кол-во" onchange="window.updateBOMItem(${index}, 'qty', this.value)">
                <input type="text" class="pe-input pe-input-sm" style="width:60px;" value="${item.unit}" placeholder="Ед." onchange="window.updateBOMItem(${index}, 'unit', this.value)">
                <button class="pe-btn pe-btn-danger pe-btn-sm pe-btn-icon" onclick="window.removeBOMItem(${index})" title="Удалить строку">
                    <i data-feather="trash-2"></i>
                </button>
            `;
      container.appendChild(row);
    });
  }

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.gap = "0.5rem";
  controls.style.marginTop = "1rem";
  controls.innerHTML = `
        <button class="pe-btn pe-btn-secondary pe-btn-sm" onclick="window.addBOMItem()"><i data-feather="plus"></i> Добавить</button>
        <button class="pe-btn pe-btn-primary pe-btn-sm" onclick="window.saveBOMArray()"><i data-feather="save"></i> Сохранить BOM</button>
    `;
  container.appendChild(controls);

  if (typeof feather !== "undefined") feather.replace();
}

window.updateBOMItem = (index, field, value) => {
  State.currentBOM[index][field] =
    field === "qty" ? parseFloat(value) || 0 : value;
};
window.removeBOMItem = (index) => {
  State.currentBOM.splice(index, 1);
  renderBOMEditor();
};
window.addBOMItem = () => {
  State.currentBOM.push({ name: "", qty: 1, unit: "шт" });
  renderBOMEditor();
};
window.saveBOMArray = async () => {
  if (!State.selectedOrderId) return;
  try {
    await API.updateOrderDetails(
      State.selectedOrderId,
      "bom",
      State.currentBOM,
    );
    Utils.showToast("Спецификация объекта успешно обновлена", "success");
    const order = State.orders.find((o) => o.id === State.selectedOrderId);
    if (order) order.details.bom = JSON.parse(JSON.stringify(State.currentBOM));
  } catch (err) {
    Utils.showToast(err.message || "Ошибка сохранения спецификации", "error");
  }
};

// =============================================================================
// 7. 🏢 ГЛОБАЛЬНАЯ КАССА (CORPORATE FINANCE v10.0)
// =============================================================================

async function loadFinance() {
  try {
    // 1. Загружаем балансы счетов
    const accounts = await API.getFinanceAccounts();
    State.financeAccounts = accounts; // Кешируем для селектора

    const grid = document.getElementById("financeAccountsGrid");
    grid.innerHTML = "";

    // Подготовка селектора счетов в модалке
    const accountSelect = document.getElementById("txAccount");
    accountSelect.innerHTML = "";

    accounts.forEach((acc) => {
      // Иконка и цвет в зависимости от типа
      const icon = acc.type === "cash" ? "dollar-sign" : "credit-card";
      const colorClass = acc.balance >= 0 ? "pe-kpi-primary" : "pe-kpi-warning";

      grid.innerHTML += `
        <div class="pe-card pe-card-kpi ${colorClass}">
            <div class="pe-kpi-icon"><i data-feather="${icon}"></i></div>
            <div class="pe-kpi-data">
                <span class="pe-kpi-label">${acc.name}</span>
                <h3 class="pe-kpi-value">${Utils.formatCurrency(acc.balance)}</h3>
            </div>
        </div>
      `;

      accountSelect.innerHTML += `<option value="${acc.id}">${acc.name} (Доступно: ${Utils.formatCurrency(acc.balance)})</option>`;
    });

    // 2. Загружаем историю транзакций
    const transactions = await API.getFinanceTransactions(50);
    const tbody = document.getElementById("transactionsTableBody");
    tbody.innerHTML = "";

    if (transactions.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="pe-text-center pe-text-muted">Финансовых операций пока нет</td></tr>';
    } else {
      transactions.forEach((tx) => {
        const isIncome = tx.type === "income";
        const amountStr = isIncome
          ? `+${Utils.formatCurrency(tx.amount)}`
          : `-${Utils.formatCurrency(tx.amount)}`;
        const amountClass = isIncome ? "pe-text-success" : "pe-text-danger";
        const typeLabel = isIncome ? "ДОХОД" : "РАСХОД";
        const badgeClass = isIncome ? "badge-done" : "badge-cancel";

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${Utils.formatDate(tx.created_at)}</td>
          <td><span class="pe-badge ${badgeClass}">${typeLabel}</span></td>
          <td><b>${tx.account_name || "Неизвестный счет"}</b></td>
          <td>${tx.category || "—"}</td>
          <td class="${amountClass} fw-bold">${amountStr}</td>
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
// 8. 💸 ФИНАНСОВЫЕ ОПЕРАЦИИ, МОДАЛКИ И ГЛОБАЛЬНЫЕ СОБЫТИЯ
// =============================================================================

function bindGlobalEvents() {
  document
    .getElementById("refreshStatsBtn")
    .addEventListener("click", loadDashboard);
  document
    .getElementById("orderStatusFilter")
    .addEventListener("change", loadOrders);

  // Управление заказами
  document
    .getElementById("btnCloseOrderModal")
    .addEventListener("click", () => {
      document.getElementById("orderModal").style.display = "none";
      State.selectedOrderId = null;
    });

  document
    .getElementById("btnCloseManualModal")
    .addEventListener("click", () => {
      document.getElementById("manualOrderModal").style.display = "none";
    });

  document
    .getElementById("btnOpenManualOrderModal")
    .addEventListener("click", () => {
      document.getElementById("manualOrderModal").style.display = "flex";
    });

  // УПРАВЛЕНИЕ КАССЕЙ (v10.0)
  document
    .getElementById("btnOpenTransactionModal")
    ?.addEventListener("click", () => {
      document.getElementById("transactionModal").style.display = "flex";
    });

  document
    .getElementById("btnCloseTransactionModal")
    ?.addEventListener("click", () => {
      document.getElementById("transactionModal").style.display = "none";
    });

  // Обработка отправки формы Глобальной транзакции
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
        loadFinance(); // Реактивное обновление таблицы и балансов
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // Обработка статусов и локальных расходов (Orders Level)
  document
    .getElementById("modalOrderStatus")
    .addEventListener("change", async (e) => {
      if (!State.selectedOrderId) return;
      try {
        await API.updateOrderStatus(State.selectedOrderId, e.target.value);
        Utils.showToast("Статус обновлен", "success");
        loadOrders();
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnUpdateFinalPrice")
    .addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      const newPrice = document.getElementById("modalFinalPrice").value;
      try {
        const newFinancials = await API.updateOrderFinalPrice(
          State.selectedOrderId,
          newPrice,
        );
        const order = State.orders.find((o) => o.id === State.selectedOrderId);
        order.details.financials = newFinancials;
        order.total_price = newFinancials.final_price;
        renderOrderFinancials(order);
        loadOrders();
        Utils.showToast("Итоговая цена зафиксирована", "success");
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("btnAddExpense")
    .addEventListener("click", async () => {
      if (!State.selectedOrderId) return;
      const amount = document.getElementById("expenseAmount").value;
      const category = document.getElementById("expenseCategory").value;
      const comment = document.getElementById("expenseComment").value;

      if (!amount || amount <= 0)
        return Utils.showToast("Введите корректную сумму", "error");

      try {
        const newFinancials = await API.addOrderExpense(
          State.selectedOrderId,
          amount,
          category,
          comment,
        );
        document.getElementById("expenseAmount").value = "";
        document.getElementById("expenseComment").value = "";

        const order = State.orders.find((o) => o.id === State.selectedOrderId);
        order.details.financials = newFinancials;
        renderOrderFinancials(order);
        loadOrders();
        Utils.showToast("Расход по объекту списан", "success");
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  document
    .getElementById("formManualOrder")
    .addEventListener("submit", async (e) => {
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

  document
    .getElementById("btnSendBroadcast")
    .addEventListener("click", async () => {
      const text = document.getElementById("broadcastText").value;
      const target = document.getElementById("broadcastTarget").value;
      const image = document.getElementById("broadcastImage").value;

      if (!text) return Utils.showToast("Введите текст рассылки", "error");

      try {
        const res = await API.sendBroadcast(text, image, target);
        Utils.showToast(res.message, "success");
        document.getElementById("broadcastText").value = "";
        document.getElementById("broadcastImage").value = "";
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
    container.innerHTML = "";

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
  } catch (e) {
    Utils.showToast("Ошибка загрузки динамического прайс-листа", "error");
  }
}

document
  .getElementById("btnSaveSettings")
  ?.addEventListener("click", async () => {
    const inputs = document.querySelectorAll(".setting-input");
    const payload = [];

    inputs.forEach((input) => {
      payload.push({
        key: input.getAttribute("data-key"),
        value: parseFloat(input.value) || 0,
      });
    });

    try {
      await API.updateBulkSettings(payload);
      Utils.showToast("Прайс-лист успешно обновлен", "success");
    } catch (e) {
      Utils.showToast("Ошибка при массовом обновлении цен", "error");
    }
  });

async function loadUsers() {
  try {
    State.users = await API.getUsers();
    const tbody = document.getElementById("usersTableBody");
    tbody.innerHTML = "";

    State.users.forEach((u) => {
      const isManager = u.role === "manager";
      const isAdmin = u.role === "admin" || u.role === "owner";

      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td>${u.telegram_id}</td>
                <td>${u.first_name} <br> <small class="pe-text-muted">@${u.username || "нет"}</small></td>
                <td>${u.phone || "—"}</td>
                <td>
                    <select class="pe-input pe-input-sm role-select" data-uid="${u.telegram_id}" ${isAdmin ? "disabled" : ""}>
                        <option value="user" ${u.role === "user" ? "selected" : ""}>Клиент</option>
                        <option value="manager" ${isManager ? "selected" : ""}>Мастер</option>
                        ${isAdmin ? `<option value="${u.role}" selected>${u.role.toUpperCase()}</option>` : ""}
                    </select>
                </td>
            `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll(".role-select").forEach((select) => {
      select.addEventListener("change", async (e) => {
        const uid = e.target.getAttribute("data-uid");
        const newRole = e.target.value;
        try {
          await API.updateUserRole(uid, newRole);
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

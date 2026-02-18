/**
 * @file public/js/app.js
 * @description Frontend Application Controller (SPA Logic v9.0.0).
 * Управляет состоянием интерфейса, модальными окнами, финансовыми операциями
 * и связывает разметку admin.html с методами api.js.
 *
 * @module AppController
 * @version 9.0.0 (Enterprise ERP Edition)
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
    feather.replace();

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
  feather.replace();
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

      const tr = document.createElement("tr");
      tr.innerHTML = `
                <td><b>#${o.id}</b><br><small class="text-muted">${Utils.formatDate(o.created_at)}</small></td>
                <td>${o.client_name || "Неизвестно"}<br><small>${o.client_phone || "—"}</small></td>
                <td>${o.area} м²</td>
                <td><span class="badge badge-${o.status}">${o.status.toUpperCase()}</span></td>
                <td class="text-success fw-bold">${Utils.formatCurrency(netProfit)}</td>
                <td>
                    <button class="btn btn-sm btn-outline" onclick="openOrderModal(${o.id})">
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

  // Инфо
  document.getElementById("modalOrderTitle").textContent =
    `Объект #${order.id} (${order.area} м²)`;
  document.getElementById("modalClientName").textContent =
    order.client_name || "Оффлайн клиент";
  document.getElementById("modalClientPhone").textContent =
    order.client_phone || "—";

  // Статус
  const statusSelect = document.getElementById("modalOrderStatus");
  statusSelect.innerHTML = `
        <option value="new">Новый (Лид)</option>
        <option value="processing">Взят в расчет</option>
        <option value="work">В работе</option>
        <option value="done">Завершен успешно</option>
        <option value="canceled">Отказ</option>
    `;
  statusSelect.value = order.status;

  // Спецификация (BOM)
  const bomList = document.getElementById("modalBOMList");
  bomList.innerHTML = "";
  if (order.details?.bom && Array.isArray(order.details.bom)) {
    order.details.bom.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${item.name}</span> <b>${item.qty} ${item.unit}</b>`;
      bomList.appendChild(li);
    });
  } else {
    bomList.innerHTML =
      '<li class="text-muted">Спецификация не сгенерирована</li>';
  }

  // Финансы (ERP Core)
  renderOrderFinancials(order);

  document.getElementById("orderModal").style.display = "flex";
  feather.replace();
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

  if (financials.expenses.length === 0) {
    expensesList.innerHTML =
      '<div class="text-muted text-center p-1">Нет расходов по объекту</div>';
  } else {
    financials.expenses.forEach((exp) => {
      const div = document.createElement("div");
      div.className = "expense-item";
      div.innerHTML = `
                <div>
                    <strong>${exp.category}</strong> <small class="text-muted">${Utils.formatDate(exp.date)}</small>
                    <div class="text-sm">${exp.comment || ""}</div>
                </div>
                <div class="text-danger fw-bold">-${Utils.formatCurrency(exp.amount)}</div>
            `;
      expensesList.appendChild(div);
    });
  }
}

// =============================================================================
// 6. 💸 ФИНАНСОВЫЕ ОПЕРАЦИИ И СОБЫТИЯ (ERP ACTIONS)
// =============================================================================

function bindGlobalEvents() {
  // --- ДАШБОРД ---
  document
    .getElementById("refreshStatsBtn")
    .addEventListener("click", loadDashboard);

  // --- ФИЛЬТР ЗАКАЗОВ ---
  document
    .getElementById("orderStatusFilter")
    .addEventListener("change", loadOrders);

  // --- ЗАКРЫТИЕ МОДАЛОК ---
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

  // --- ИЗМЕНЕНИЕ СТАТУСА ЗАКАЗА ---
  document
    .getElementById("modalOrderStatus")
    .addEventListener("change", async (e) => {
      if (!State.selectedOrderId) return;
      try {
        await API.updateOrderStatus(State.selectedOrderId, e.target.value);
        Utils.showToast("Статус обновлен", "success");
        loadOrders(); // Обновляем таблицу на фоне
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // --- ОБНОВЛЕНИЕ ФИНАЛЬНОЙ ЦЕНЫ ---
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
        // Обновляем локальный стейт
        const order = State.orders.find((o) => o.id === State.selectedOrderId);
        order.details.financials = newFinancials;
        order.total_price = newFinancials.final_price;
        renderOrderFinancials(order);
        loadOrders(); // Обновляем таблицу
        Utils.showToast("Итоговая цена зафиксирована", "success");
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // --- ДОБАВЛЕНИЕ РАСХОДА (ЧЕКА) ---
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

        // Очистка формы
        document.getElementById("expenseAmount").value = "";
        document.getElementById("expenseComment").value = "";

        // Обновляем UI
        const order = State.orders.find((o) => o.id === State.selectedOrderId);
        order.details.financials = newFinancials;
        renderOrderFinancials(order);
        loadOrders();
        Utils.showToast("Расход успешно списан", "success");
      } catch (err) {
        Utils.showToast(err.message, "error");
      }
    });

  // --- СОЗДАНИЕ РУЧНОГО ОФФЛАЙН ЛИДА ---
  document
    .getElementById("btnOpenManualOrderModal")
    .addEventListener("click", () => {
      document.getElementById("manualOrderModal").style.display = "flex";
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

  // --- РАССЫЛКА (BROADCAST) ---
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
// 7. ⚙️ НАСТРОЙКИ ПРАЙСА И ПЕРСОНАЛ (SETTINGS & USERS)
// =============================================================================

async function loadSettings() {
  try {
    const settings = await API.getSettings();
    const container = document.getElementById("settingsFormContainer");
    container.innerHTML = "";

    // Выводим только важные для ERP настройки (можно расширить)
    const keysToRender = [
      { key: "price_point_socket", label: "Точка: Розетка (₸)" },
      { key: "price_point_box", label: "Точка: Распредкоробка (₸)" },
      { key: "price_cable_base", label: "Кабель: База (₸/м)" },
      { key: "price_shield_base_24", label: "Щит: База до 24 мод. (₸)" },
    ];

    keysToRender.forEach((k) => {
      const val = settings[k.key] || "";
      container.innerHTML += `
                <div class="form-group">
                    <label>${k.label}</label>
                    <input type="number" class="form-control setting-input" data-key="${k.key}" value="${val}">
                </div>
            `;
    });
  } catch (e) {
    Utils.showToast("Ошибка загрузки настроек", "error");
  }
}

document
  .getElementById("btnSaveSettings")
  ?.addEventListener("click", async () => {
    const inputs = document.querySelectorAll(".setting-input");
    let errors = 0;

    for (let input of inputs) {
      const key = input.getAttribute("data-key");
      const val = input.value;
      try {
        await API.updateSetting(key, val);
      } catch (e) {
        errors++;
      }
    }

    if (errors === 0) Utils.showToast("Прайс успешно обновлен", "success");
    else Utils.showToast(`Обновлено с ошибками (${errors})`, "error");
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
                <td>${u.first_name} <br> <small class="text-muted">@${u.username || "нет"}</small></td>
                <td>${u.phone || "—"}</td>
                <td>
                    <select class="form-control form-sm role-select" data-uid="${u.telegram_id}" ${isAdmin ? "disabled" : ""}>
                        <option value="user" ${u.role === "user" ? "selected" : ""}>Клиент</option>
                        <option value="manager" ${isManager ? "selected" : ""}>Мастер</option>
                        ${isAdmin ? `<option value="${u.role}" selected>${u.role.toUpperCase()}</option>` : ""}
                    </select>
                </td>
            `;
      tbody.appendChild(tr);
    });

    // Биндинг смены роли
    document.querySelectorAll(".role-select").forEach((select) => {
      select.addEventListener("change", async (e) => {
        const uid = e.target.getAttribute("data-uid");
        const newRole = e.target.value;
        try {
          await API.updateUserRole(uid, newRole);
          Utils.showToast("Роль обновлена", "success");
        } catch (err) {
          Utils.showToast(err.message, "error");
          loadUsers(); // Откат при ошибке
        }
      });
    });
  } catch (e) {
    Utils.showToast("Ошибка загрузки пользователей", "error");
  }
}

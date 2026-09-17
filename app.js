/* Sorella Tea iPad Touch POS — frontend
 * Persistent business data (menu, categories, series, ingredients, recipes, expenses,
 * completed orders, held orders, inventory movements) lives in Netlify DB via /api/*.
 * Only the *in-progress* cart (state.order/discount/cash) is cached in localStorage so an
 * accidental refresh mid-sale doesn't lose it — it is never the source of truth for business data.
 */
const CART_KEY = "sorellaTeaPOS_cart_v1";
let state = {
  categories: [], series: [], products: [], ingredients: [], recipes: [], expenses: [],
  heldOrders: [], completedOrders: [], movements: [],
  order: [], discount: 0, cash: 0,
};
let selectedCategory = "ALL";
let selectedSeries = "ALL";
let manageTab = "menu";
let selectedItemConfig = null;
let submitting = false;
const SUGAR_LEVELS = ["0%", "25%", "50%", "75%", "100%", "125%"];
const ICE_LEVELS = ["No Ice", "Less Ice", "Regular Ice", "Extra Ice"];

function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY) || "null");
    if (c) { state.order = c.order || []; state.discount = Number(c.discount) || 0; state.cash = Number(c.cash) || 0; }
  } catch (e) {}
}
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify({ order: state.order, discount: state.discount, cash: state.cash }));
}

async function api(path, method = "GET", body) {
  const res = await fetch("/api/" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.status === 204 ? null : res.json();
}

const money = n => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2600); }
function nowDate() { return new Date().toISOString().slice(0, 10); }
function id(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

async function loadServerState() {
  try {
    const [s, orders] = await Promise.all([api("state"), api("orders")]);
    Object.assign(state, s); state.completedOrders = orders;
    await localStore.putState(state);
    for (const order of orders) await localStore.putOrder(order);
    await syncOfflineQueue();
  } catch (e) {
    const cached = await localStore.getState();
    if (!cached) throw e;
    Object.assign(state, cached);
    state.completedOrders = state.completedOrders || [];
    toast("Offline mode — local data loaded.");
  }
}

async function init() {
  loadCart();
  document.querySelectorAll(".nav").forEach(b => b.onclick = () => switchView(b.dataset.view));
  document.getElementById("discountApply").onclick = () => { state.discount = Math.max(0, Math.min(100, Number(document.getElementById("discount").value) || 0)); saveCart(); renderOrder(); };
  document.getElementById("cashApply").onclick = () => { state.cash = Number(document.getElementById("cash").value) || 0; saveCart(); renderOrder(); };
  document.querySelectorAll("[data-cash]").forEach(b => b.onclick = () => { state.cash = Number(b.dataset.cash); document.getElementById("cash").value = state.cash; saveCart(); renderOrder(); });
  document.getElementById("clearBtn").onclick = () => { if (state.order.length && !confirm("Clear the current order?")) return; state.order = []; state.discount = 0; state.cash = 0; saveCart(); renderAll(); };
  document.getElementById("reviewBtn").onclick = openReview;
  document.getElementById("doneBtn").onclick = () => completeOrder();
  document.getElementById("holdBtn").onclick = holdOrder;
  document.getElementById("heldBtn").onclick = openHeldOrders;
  document.getElementById("backupBtn").onclick = exportBackup;
  document.getElementById("importInput").onchange = importBackup;
  window.addEventListener("online", async () => { try { await syncOfflineQueue(); await loadServerState(); renderAll(); toast("Connection restored — sync complete."); } catch(e) { console.warn(e); } });
  setInterval(() => document.getElementById("clock").textContent = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), 1000);

  try {
    await loadServerState();
  } catch (e) {
    toast("Could not reach the server database — check your connection and reload.");
    console.error(e);
  }
  renderAll();
}

function switchView(v) {
  document.querySelectorAll(".view").forEach(x => x.classList.add("hidden"));
  document.getElementById(v + "View").classList.remove("hidden");
  document.querySelectorAll(".nav").forEach(x => x.classList.toggle("active", x.dataset.view === v));
  if (v === "order") renderOrderView(); if (v === "sales") renderSales(); if (v === "manage") renderManage(); if (v === "copilot") renderCopilot(); if (v === "reports") renderReports(); if (v === "settings") renderSettings();
}
function renderAll() { renderOrderView(); renderOrder(); renderSales(); renderManage(); renderCopilot(); renderReports(); renderSettings(); }

function activeCategories() { return state.categories.filter(c => c.active !== false).sort((a, b) => a.position - b.position); }
function activeSeries() { return state.series.filter(s => s.active !== false).sort((a, b) => a.position - b.position); }

const DRINK_SIZE_ORDER = ["TALL (12oz)", "GRANDE (16oz)", "VENTI (22oz)"];
const SNACK_SIZE_ORDER = ["SMALL", "MEDIUM", "LARGE"];
const DEFAULT_PRODUCT_IMAGE = "assets/sorella-default-product.svg";
const IMAGE_VERSION = "2026.08.28.2";
function canonicalCategory(p) {
  const name = String(p?.name || "").toLowerCase();
  if (p?.type === "snack" || /fries|snack/.test(name)) return "Snacks";
  if (/fruit\s+soda|\bsoda\b/.test(name)) return "Fruit Soda";
  if (/fruit\s+tea/.test(name)) return "Fruit Tea";
  if (p?.category === "Hot Coffee" && /iced|latte|americano|cappuccino|mocha|macchiato/.test(name)) return "Iced Coffee";
  return p?.category || "Milk Tea";
}

function orderedSizeKeys(p) {
  const keys = Object.keys(p?.sizes || {});
  const preferred = p?.type === "snack" ? SNACK_SIZE_ORDER : DRINK_SIZE_ORDER;
  const rank = new Map(preferred.map((key, index) => [key.toUpperCase(), index]));
  return keys.slice().sort((a, b) => {
    const ra = rank.has(String(a).toUpperCase()) ? rank.get(String(a).toUpperCase()) : 999;
    const rb = rank.has(String(b).toUpperCase()) ? rank.get(String(b).toUpperCase()) : 999;
    return ra - rb || String(a).localeCompare(String(b));
  });
}

function productImageUrl(p) {
  const src = p?.image || DEFAULT_PRODUCT_IMAGE;
  return src + (src.includes("?") ? "&" : "?") + "v=" + IMAGE_VERSION;
}

function productImageMarkup(p, className = "") {
  const src = productImageUrl(p);
  return `<img class="${className}" src="${esc(src)}" alt="${esc(p?.name || "Sorella Tea product")}" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_PRODUCT_IMAGE}'">`;
}

function renderOrderView() {
  const cb = document.getElementById("categoryBar");
  const cats = activeCategories();
  cb.innerHTML = `<button class="${selectedCategory === "ALL" ? "active" : ""}" data-cat="ALL">ALL</button>` + cats.map(c => `<button class="${selectedCategory === c.name ? "active" : ""}" data-cat="${esc(c.name)}">${esc(c.name)}</button>`).join("");
  cb.querySelectorAll("button").forEach(b => b.onclick = () => { selectedCategory = b.dataset.cat; selectedSeries = "ALL"; renderOrderView(); });
  const sb = document.getElementById("seriesBar");
  const ser = activeSeries();
  sb.innerHTML = `<span class="series-label">SERIES</span><button class="${selectedSeries === "ALL" ? "active" : ""}" data-series="ALL">All</button>` + ser.map(s => `<button class="${selectedSeries === s.name ? "active" : ""}" data-series="${esc(s.name)}">${esc(s.name)}</button>`).join("");
  sb.querySelectorAll("button").forEach(b => b.onclick = () => { selectedSeries = b.dataset.series; renderOrderView(); });
  let items = state.products.filter(p => p.active !== false && canonicalCategory(p) !== "__HIDDEN__" && (selectedCategory === "ALL" || canonicalCategory(p) === selectedCategory) && (selectedSeries === "ALL" || p.seriesName === selectedSeries));
  document.getElementById("sectionTitle").textContent = selectedCategory === "ALL" ? "ALL" : selectedCategory.toUpperCase();
  document.getElementById("itemCount").textContent = items.length + " items";
  document.getElementById("productGrid").innerHTML = items.map(p => {
    const sizes = orderedSizeKeys(p);
    const first = p.type === "snack"
      ? (Object.values(p.flavors || {})[0]?.[sizes[0]] ?? p.sizes?.[sizes[0]] ?? 0)
      : (p.sizes?.[sizes[0]] ?? 0);
    return `<button class="product-card" data-pid="${p.id}">
      <div class="product-img">${productImageMarkup(p)}</div>
      <div class="product-name">${esc(p.name)}</div>
      <div class="product-meta"><span class="price">${p.type === "snack" ? "From " : ""}${money(first)}</span><span class="mini">${p.type === "snack" ? "S / M / L" : p.type === "addon" ? "Per serving" : "12 / 16 / 22oz"}</span></div>
    </button>`;
  }).join("") || `<div class="empty">No items in this section yet.<br>Use Manage → Menu to add one.</div>`;
  document.querySelectorAll(".product-card").forEach(b => b.onclick = () => openItem(b.dataset.pid));
  document.getElementById("heldCount").textContent = state.heldOrders.length;
}

function openItem(pid) {
  const p = state.products.find(x => x.id === pid); if (!p) return;
  selectedItemConfig = { product: p, size: orderedSizeKeys(p)[0], flavor: p.type === "snack" ? Object.keys(p.flavors || {})[0] : null, sugar: "100%", ice: "Regular Ice", addons: [], qty: 1 };
  renderItemModal();
}
function renderItemModal() {
  const x = selectedItemConfig, p = x.product, sizes = orderedSizeKeys(p);
  const flavors = p.type === "snack" ? Object.keys(p.flavors || {}) : [];
  const addonProducts = state.products.filter(a => a.type === "addon" && a.active !== false);
  document.getElementById("itemModalCard").innerHTML = `
    <div class="item-modal-product-image">${productImageMarkup(p)}</div>
    <h2>${esc(p.name)}</h2>
    ${flavors.length ? `<div class="field"><label>FLAVOR</label><div class="choice-grid">${flavors.map(f => `<button class="choice ${x.flavor === f ? "active" : ""}" data-flavor="${esc(f)}">${esc(f)}</button>`).join("")}</div></div>` : ""}
    ${p.type !== "addon" ? `<div class="field" style="margin-top:12px"><label>SIZE</label><div class="choice-grid">${sizes.map(s => `<button class="choice ${x.size === s ? "active" : ""}" data-size="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>` : `<div class="field" style="margin-top:12px"><label>ADD-ON PRICE</label><div class="choice-grid"><button class="choice active">${money(p.sizes?.["ADD-ON"] || 0)} / serving</button></div></div>`}
    ${p.type === "drink" ? `<div class="form-grid" style="margin-top:12px"><div class="field"><label>SUGAR</label><div class="choice-grid">${SUGAR_LEVELS.map(v => `<button class="choice ${x.sugar === v ? "active" : ""}" data-sugar="${v}">${v}</button>`).join("")}</div></div><div class="field"><label>ICE</label><div class="choice-grid">${ICE_LEVELS.map(v => `<button class="choice ${x.ice === v ? "active" : ""}" data-ice="${esc(v)}">${esc(v)}</button>`).join("")}</div></div></div><div class="field" style="margin-top:12px"><label>ADD-ONS</label><div class="choice-grid">${addonProducts.map(a => `<button class="choice ${x.addons.includes(a.id) ? "active" : ""}" data-addon="${a.id}">${esc(a.name)} · ${money(a.sizes?.["ADD-ON"] || 0)}</button>`).join("")}</div></div>` : ""}
    <div class="form-grid" style="margin-top:12px">
      <div class="field"><label>QUANTITY</label><div class="modal-qty"><button type="button" id="qtyMinus">−</button><input id="modalQty" type="number" min="1" max="99" value="${x.qty}"><button type="button" id="qtyPlus">+</button></div></div>
      <div class="field"><label>PRICE</label><input id="modalPrice" type="number" min="0" value="${getPrice(p, x.size, x.flavor)}"><div class="form-note">Price is editable for this item/variant.</div></div>
    </div>
    <div class="modal-actions"><button class="close" id="itemClose">Cancel</button><button class="confirm" id="itemAdd">Add to Order</button></div>`;
  const m = document.getElementById("itemModal"); m.classList.remove("hidden");
  document.querySelectorAll("[data-size]").forEach(b => b.onclick = () => { x.size = b.dataset.size; renderItemModal(); });
  document.querySelectorAll("[data-flavor]").forEach(b => b.onclick = () => { x.flavor = b.dataset.flavor; renderItemModal(); });
  document.querySelectorAll("[data-sugar]").forEach(b => b.onclick = () => { x.sugar = b.dataset.sugar; renderItemModal(); });
  document.querySelectorAll("[data-ice]").forEach(b => b.onclick = () => { x.ice = b.dataset.ice; renderItemModal(); });
  document.querySelectorAll("[data-addon]").forEach(b => b.onclick = () => { const i=x.addons.indexOf(b.dataset.addon); if(i>=0)x.addons.splice(i,1); else x.addons.push(b.dataset.addon); renderItemModal(); });
  const qtyInput = document.getElementById("modalQty");
  qtyInput.oninput = () => { x.qty = Math.max(1, Math.min(99, Number(qtyInput.value) || 1)); qtyInput.value = x.qty; };
  document.getElementById("qtyMinus").onclick = () => { x.qty = Math.max(1, x.qty - 1); qtyInput.value = x.qty; };
  document.getElementById("qtyPlus").onclick = () => { x.qty = Math.min(99, x.qty + 1); qtyInput.value = x.qty; };
  document.getElementById("itemClose").onclick = () => m.classList.add("hidden");
  document.getElementById("itemAdd").onclick = () => {
    const basePrice = Number(document.getElementById("modalPrice").value) || 0;
    const addonTotal = x.addons.reduce((sum, aid) => sum + Number(state.products.find(a => a.id === aid)?.sizes?.["ADD-ON"] || 0), 0);
    const price = basePrice + addonTotal;
    const addonNames = x.addons.map(aid => state.products.find(a => a.id === aid)?.name).filter(Boolean);
    state.order.push({ id: id("line_"), productId: p.id, name: p.name, category: canonicalCategory(p), series: p.seriesName, size: x.size, flavor: x.flavor, sugar: p.type === "drink" ? x.sugar : null, ice: p.type === "drink" ? x.ice : null, addons: addonNames, qty: Math.max(1, Number(document.getElementById("modalQty").value) || 1), price });
    saveCart(); m.classList.add("hidden"); renderOrder();
  };
}
function getPrice(p, size, flavor) { if (p.type === "snack" && flavor && p.flavors?.[flavor]?.[size] != null) return p.flavors[flavor][size]; return p.sizes?.[size] ?? 0; }
function subtotal() { return state.order.reduce((a, x) => a + x.qty * x.price, 0); }

function renderOrder() {
  const list = document.getElementById("orderList");
  list.innerHTML = state.order.length ? state.order.map((x, i) => `<div class="order-item">
    <div class="oi-head"><span class="oi-name">${esc(x.name)}</span><b>${money(x.qty * x.price)}</b></div>
    <div class="oi-sub">${esc(x.size || "")} ${x.flavor ? ` · ${esc(x.flavor)}` : ""}${x.sugar ? ` · ${esc(x.sugar)} sugar` : ""}${x.ice ? ` · ${esc(x.ice)}` : ""}${x.addons?.length ? ` · + ${esc(x.addons.join(", "))}` : ""} · ${money(x.price)} each</div>
    <div class="oi-controls"><div class="qty"><button data-q="${i}" data-d="-1">−</button><b>${x.qty}</b><button data-q="${i}" data-d="1">+</button></div><button class="remove" data-remove="${i}">×</button></div>
  </div>`).join("") : `<div class="empty">Tap a menu item to start the order.</div>`;
  list.querySelectorAll("[data-q]").forEach(b => b.onclick = () => { let i = +b.dataset.q; state.order[i].qty = Math.max(1, state.order[i].qty + (+b.dataset.d)); saveCart(); renderOrder(); });
  list.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => { state.order.splice(+b.dataset.remove, 1); saveCart(); renderOrder(); });
  const sub = subtotal(), disc = sub * state.discount / 100, total = sub - disc, change = Math.max(0, state.cash - total);
  document.getElementById("subtotal").textContent = money(sub);
  document.getElementById("discount").value = state.discount;
  document.getElementById("discountAmt").textContent = "- " + money(disc);
  document.getElementById("total").textContent = money(total);
  document.getElementById("cash").value = state.cash || "";
  document.getElementById("change").textContent = money(change);
  document.getElementById("orderCount").textContent = state.order.reduce((a, x) => a + x.qty, 0);
  document.getElementById("heldCount").textContent = state.heldOrders.length;
}

function openReview() {
  if (!state.order.length) { toast("Add an item before reviewing."); return; }
  const sub = subtotal(), disc = sub * state.discount / 100, total = sub - disc;
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>Review Order</h2>
    <div class="form-note">Floating review window — scroll inside if the order is long. Tap Edit Order to change items, or Confirm to complete the sale.</div>
    <div>${state.order.map((x, i) => `<div class="review-summary"><div><b>${i + 1}. ${esc(x.name)}</b><div class="oi-sub">${x.qty} × ${esc(x.size || "")}${x.flavor ? ` · ${esc(x.flavor)}` : ""}${x.sugar ? ` · ${esc(x.sugar)} sugar` : ""}${x.ice ? ` · ${esc(x.ice)}` : ""}${x.addons?.length ? ` · + ${esc(x.addons.join(", "))}` : ""} · ${money(x.price)}</div></div><b>${money(x.qty * x.price)}</b></div>`).join("")}</div>
    <div class="review-summary"><b>Subtotal</b><b>${money(sub)}</b></div>
    <div class="review-summary"><b>Discount (${state.discount}%)</b><b>- ${money(disc)}</b></div>
    <div class="review-summary"><b class="review-total">TOTAL</b><b class="review-total">${money(total)}</b></div>
    <div class="review-actions"><button class="close" id="reviewCancel">Cancel</button><button class="close" id="reviewEdit">Edit Order</button><button class="confirm" id="reviewDone">Confirm Order</button></div>`;
  document.getElementById("reviewModal").classList.remove("hidden");
  document.getElementById("reviewCancel").onclick = () => document.getElementById("reviewModal").classList.add("hidden");
  document.getElementById("reviewEdit").onclick = () => document.getElementById("reviewModal").classList.add("hidden");
  document.getElementById("reviewDone").onclick = (e) => completeOrder(e.target);
}

async function completeOrder(btn) {
  if (submitting) return; // hard block on double-tap / double-submit
  if (!state.order.length) { toast("No order to complete."); return; }
  const sub = subtotal(), disc = sub * state.discount / 100, total = sub - disc;
  if (state.cash > 0 && state.cash < total) { toast("Cash received is less than the total."); return; }
  submitting = true;
  if (btn) btn.disabled = true;
  document.getElementById("doneBtn").disabled = true;
  try {
    const payload = {items: state.order, discountPercent: state.discount, cash: state.cash, payment: state.cash > 0 ? "Cash" : "GCash"};
    let order;
    if (navigator.onLine) {
      try { order = await api("orders", "POST", payload); }
      catch (e) { if (!/Failed to fetch|NetworkError|Load failed/i.test(String(e))) throw e; }
    }
    if (!order) {
      order = {id:id("LOCAL-"), date:nowDate(), time:new Date().toLocaleTimeString("en-PH"), items:payload.items, discountPercent:String(payload.discountPercent), cash:String(payload.cash), payment:payload.payment, localOnly:true};
      await localStore.putOrder(order);
      await localStore.queue({operationId:id("OP-"),type:"COMPLETE_ORDER",payload});
      toast("Saved offline — will sync when internet returns.");
    }
    state.completedOrders.push(order);
    state.order = []; state.discount = 0; state.cash = 0; saveCart();
    // Inventory was just deducted server-side — refresh ingredients so Manage → Inventory reflects it immediately.
    const s = await api("state");
    state.ingredients = s.ingredients;
    document.getElementById("reviewModal").classList.add("hidden");
    renderAll();
    toast("Order completed and saved.");
  } catch (e) {
    toast(e.message || "Could not complete the order — nothing was charged, please retry.");
  } finally {
    submitting = false;
    if (btn) btn.disabled = false;
    document.getElementById("doneBtn").disabled = false;
  }
}

async function holdOrder() {
  if (!state.order.length) { toast("Nothing to hold."); return; }
  try {
    await api("held-orders", "POST", { items: state.order, discountPercent: state.discount });
    state.heldOrders = await api("held-orders");
    state.order = []; state.discount = 0; state.cash = 0; saveCart();
    renderOrder(); renderOrderView();
    toast("Order held.");
  } catch (e) { toast(e.message || "Could not hold the order."); }
}
function openHeldOrders() {
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>Held Orders</h2>
    <div class="form-note">Resuming a held order loads it back into the current cart. Holding never deducts inventory.</div>
    <div>${state.heldOrders.map(h => `<div class="review-summary"><div><b>${esc(h.id)}</b><div class="oi-sub">${(h.items || []).reduce((a, x) => a + x.qty, 0)} items · held ${new Date(h.createdAt).toLocaleString()}</div></div><div style="display:flex;gap:6px"><button class="soft resumeHeld" data-h="${esc(h.id)}" style="padding:8px 10px;border-radius:9px">Resume</button><button class="remove deleteHeld" data-h="${esc(h.id)}">×</button></div></div>`).join("") || `<div class="empty">No held orders.</div>`}</div>
    <div class="review-actions"><button class="close" id="heldClose">Close</button></div>`;
  document.getElementById("reviewModal").classList.remove("hidden");
  document.getElementById("heldClose").onclick = () => document.getElementById("reviewModal").classList.add("hidden");
  card.querySelectorAll(".resumeHeld").forEach(b => b.onclick = async () => {
    if (state.order.length && !confirm("Replace the current cart with this held order?")) return;
    const h = state.heldOrders.find(x => x.id === b.dataset.h);
    state.order = h.items || []; state.discount = Number(h.discountPercent) || 0; state.cash = 0; saveCart();
    await api("held-orders/" + encodeURIComponent(b.dataset.h), "DELETE");
    state.heldOrders = await api("held-orders");
    document.getElementById("reviewModal").classList.add("hidden");
    renderAll(); toast("Held order resumed.");
  });
  card.querySelectorAll(".deleteHeld").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this held order permanently?")) return;
    await api("held-orders/" + encodeURIComponent(b.dataset.h), "DELETE");
    state.heldOrders = await api("held-orders");
    openHeldOrders();
  });
}

function renderSales() {
  const v = document.getElementById("salesView"), ord = state.completedOrders.slice().reverse();
  const sales = ord.reduce((a, o) => a + Number(o.total), 0);
  v.innerHTML = `<div class="manage-head"><h2>Sales</h2><div class="manage-actions"><button id="clearSales">Clear Saved Sales</button></div></div>
    <div class="kpi-grid"><div class="kpi"><small>Orders</small><b>${ord.length}</b></div><div class="kpi"><small>Sales</small><b>${money(sales)}</b></div><div class="kpi"><small>Discounts</small><b>${money(ord.reduce((a, o) => a + Number(o.discountAmount), 0))}</b></div><div class="kpi"><small>Held</small><b>${state.heldOrders.length}</b></div></div>
    <div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>Order</th><th>Date</th><th>Items</th><th>Discount</th><th>Total</th><th>Cash</th><th>Payment</th></tr></thead><tbody>${ord.map(o => `<tr><td>${esc(o.id)}</td><td>${esc(o.date)} ${esc(o.time)}</td><td>${(o.items || []).reduce((a, x) => a + x.qty, 0)}</td><td>${money(o.discountAmount)}</td><td><b>${money(o.total)}</b></td><td>${money(o.cash)}</td><td>${esc(o.payment)}</td></tr>`).join("") || `<tr><td colspan="7">No completed orders yet.</td></tr>`}</tbody></table></div>`;
  document.getElementById("clearSales").onclick = async () => { if (confirm("Clear ALL completed sales records? This cannot be undone — export a backup first.")) { await api("orders-clear", "POST"); state.completedOrders = []; renderSales(); } };
}

function renderManage() {
  const v = document.getElementById("manageView");
  v.innerHTML = `<div class="manage-head"><h2>Manage</h2><div class="manage-actions">
    <button id="addCat">+ Category</button><button id="addSeries">+ Series</button><button id="addItem">+ Menu Item</button><button id="addIng">+ Ingredient</button><button id="addRecipe">+ Recipe</button><button id="addExp">+ Expense</button><button id="addStock">+ Stock Movement</button>
  </div></div>
  <div class="manage-tabs">${["menu", "categories", "series", "ingredients", "inventory", "recipes", "expenses", "movements"].map(t => `<button class="${manageTab === t ? "active" : ""}" data-mtab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
  <div id="manageContent"></div>`;
  v.querySelectorAll("[data-mtab]").forEach(b => b.onclick = () => { manageTab = b.dataset.mtab; renderManage(); });
  document.getElementById("addCat").onclick = addCategory;
  document.getElementById("addSeries").onclick = addSeries;
  document.getElementById("addItem").onclick = () => openProductEditor();
  document.getElementById("addIng").onclick = addIngredient;
  document.getElementById("addRecipe").onclick = addRecipe;
  document.getElementById("addExp").onclick = addExpense;
  document.getElementById("addStock").onclick = openStockForm;
  const c = document.getElementById("manageContent");
  if (manageTab === "menu") renderMenuManager(c);
  if (manageTab === "categories") renderCategories(c);
  if (manageTab === "series") renderSeriesManager(c);
  if (manageTab === "ingredients") renderIngredients(c);
  if (manageTab === "inventory") renderInventory(c);
  if (manageTab === "recipes") renderRecipes(c);
  if (manageTab === "expenses") renderExpenses(c);
  if (manageTab === "movements") renderMovements(c);
}

function renderMenuManager(c) {
  c.innerHTML = `<div class="form-note">New menu items use a category dropdown, optional series dropdown, and the correct size selector. Drink sizes are TALL (12oz), GRANDE (16oz), VENTI (22oz); there is no 8oz. Snacks use SMALL / MEDIUM / LARGE.</div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Item</th><th>Category</th><th>Series</th><th>Sizes / Prices</th><th>Active</th><th></th></tr></thead><tbody>
  ${state.products.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(canonicalCategory(p))}</td><td>${esc(p.seriesName || "—")}</td><td>${Object.entries(p.sizes || {}).map(([s, v]) => `${esc(s)} ${money(v)}`).join(" · ")}</td><td>${p.active !== false ? "YES" : "NO"}</td><td><button class="soft editp" data-p="${p.id}" style="padding:7px 9px;border-radius:9px">Edit</button></td></tr>`).join("")}</tbody></table></div>`;
  c.querySelectorAll(".editp").forEach(b => b.onclick = () => openProductEditor(b.dataset.p));
}

function renderCategories(c) {
  const rows = state.categories.slice().sort((a, b) => a.position - b.position);
  c.innerHTML = `<div class="form-note">Categories determine which top navigation tab a product appears under. Disable a category to hide it from the order screen without deleting its products.</div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Order</th><th>Category</th><th>Active</th><th></th></tr></thead><tbody>${rows.map((cat, i) => `<tr>
    <td><button class="soft moveCat" data-dir="-1" data-id="${cat.id}" ${i === 0 ? "disabled" : ""} style="padding:5px 9px;border-radius:8px">↑</button> <button class="soft moveCat" data-dir="1" data-id="${cat.id}" ${i === rows.length - 1 ? "disabled" : ""} style="padding:5px 9px;border-radius:8px">↓</button></td>
    <td><b>${esc(cat.name)}</b></td>
    <td class="${cat.active !== false ? "ok" : "warn"}">${cat.active !== false ? "ACTIVE" : "DISABLED"}</td>
    <td><button class="soft renameCat" data-id="${cat.id}" style="padding:7px 9px;border-radius:9px">Rename</button> <button class="soft toggleCat" data-id="${cat.id}" style="padding:7px 9px;border-radius:9px">${cat.active !== false ? "Disable" : "Enable"}</button></td>
  </tr>`).join("")}</tbody></table></div>`;
  c.querySelectorAll(".moveCat").forEach(b => b.onclick = () => reorderCategory(Number(b.dataset.id), Number(b.dataset.dir)));
  c.querySelectorAll(".renameCat").forEach(b => b.onclick = () => renameCategory(Number(b.dataset.id)));
  c.querySelectorAll(".toggleCat").forEach(b => b.onclick = () => toggleCategory(Number(b.dataset.id)));
}
async function addCategory() {
  const n = prompt("New category name:"); if (!n?.trim()) return;
  if (state.categories.some(c => c.name.toLowerCase() === n.trim().toLowerCase())) { toast("That category already exists."); return; }
  const row = await api("categories", "POST", { name: n.trim(), position: state.categories.length, active: true });
  state.categories.push(row); renderAll(); toast("Category added.");
}
async function renameCategory(catId) {
  const cat = state.categories.find(c => c.id === catId); const n = prompt("Rename category:", cat.name); if (!n?.trim() || n.trim() === cat.name) return;
  const oldName = cat.name; cat.name = n.trim();
  await api("categories/" + catId, "POST", { name: cat.name });
  state.products.filter(p => p.category === oldName).forEach(p => { p.category = cat.name; api("products/" + p.id, "POST", { category: cat.name }).catch(() => {}); });
  renderAll(); toast("Category renamed.");
}
async function toggleCategory(catId) {
  const cat = state.categories.find(c => c.id === catId); cat.active = cat.active === false ? true : false;
  await api("categories/" + catId, "POST", { active: cat.active });
  renderAll();
}
async function reorderCategory(catId, dir) {
  const rows = state.categories.slice().sort((a, b) => a.position - b.position);
  const idx = rows.findIndex(c => c.id === catId); const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= rows.length) return;
  const a = rows[idx], b = rows[swapIdx]; const pa = a.position, pb = b.position;
  a.position = pb; b.position = pa;
  await Promise.all([api("categories/" + a.id, "POST", { position: a.position }), api("categories/" + b.id, "POST", { position: b.position })]);
  renderManage();
}

function renderSeriesManager(c) {
  const rows = state.series.slice().sort((a, b) => a.position - b.position);
  c.innerHTML = `<div class="form-note">Series are optional flavor collections (e.g. Matcha Series) shown as a secondary filter row above the menu.</div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Order</th><th>Series</th><th>Active</th><th></th></tr></thead><tbody>${rows.map((s, i) => `<tr>
    <td><button class="soft moveSer" data-dir="-1" data-id="${s.id}" ${i === 0 ? "disabled" : ""} style="padding:5px 9px;border-radius:8px">↑</button> <button class="soft moveSer" data-dir="1" data-id="${s.id}" ${i === rows.length - 1 ? "disabled" : ""} style="padding:5px 9px;border-radius:8px">↓</button></td>
    <td><b>${esc(s.name)}</b></td>
    <td class="${s.active !== false ? "ok" : "warn"}">${s.active !== false ? "ACTIVE" : "DISABLED"}</td>
    <td><button class="soft renameSer" data-id="${s.id}" style="padding:7px 9px;border-radius:9px">Rename</button> <button class="soft toggleSer" data-id="${s.id}" style="padding:7px 9px;border-radius:9px">${s.active !== false ? "Disable" : "Enable"}</button></td>
  </tr>`).join("")}</tbody></table></div>`;
  c.querySelectorAll(".moveSer").forEach(b => b.onclick = () => reorderSeries(Number(b.dataset.id), Number(b.dataset.dir)));
  c.querySelectorAll(".renameSer").forEach(b => b.onclick = () => renameSeries(Number(b.dataset.id)));
  c.querySelectorAll(".toggleSer").forEach(b => b.onclick = () => toggleSeries(Number(b.dataset.id)));
}
async function addSeries() {
  const n = prompt("New series name:"); if (!n?.trim()) return;
  if (state.series.some(s => s.name.toLowerCase() === n.trim().toLowerCase())) { toast("That series already exists."); return; }
  const row = await api("series", "POST", { name: n.trim(), position: state.series.length, active: true });
  state.series.push(row); renderAll(); toast("Series added.");
}
async function renameSeries(sid) {
  const s = state.series.find(x => x.id === sid); const n = prompt("Rename series:", s.name); if (!n?.trim() || n.trim() === s.name) return;
  const oldName = s.name; s.name = n.trim();
  await api("series/" + sid, "POST", { name: s.name });
  state.products.filter(p => p.seriesName === oldName).forEach(p => { p.seriesName = s.name; api("products/" + p.id, "POST", { seriesName: s.name }).catch(() => {}); });
  renderAll(); toast("Series renamed.");
}
async function toggleSeries(sid) { const s = state.series.find(x => x.id === sid); s.active = s.active === false ? true : false; await api("series/" + sid, "POST", { active: s.active }); renderAll(); }
async function reorderSeries(sid, dir) {
  const rows = state.series.slice().sort((a, b) => a.position - b.position);
  const idx = rows.findIndex(s => s.id === sid); const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= rows.length) return;
  const a = rows[idx], b = rows[swapIdx]; const pa = a.position, pb = b.position;
  a.position = pb; b.position = pa;
  await Promise.all([api("series/" + a.id, "POST", { position: a.position }), api("series/" + b.id, "POST", { position: b.position })]);
  renderManage();
}

function renderIngredients(c) {
  c.innerHTML = `<div class="form-note">Ingredients are editable. Use Edit to update the ingredient, unit, cost, minimum stock, supplier, active status, and current stock. Saving a stock change records a Correction movement.</div>
  <div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Ingredient</th><th>Category</th><th>Unit</th><th>Current Stock</th><th>Min Stock</th><th>Cost/Unit</th><th>Supplier</th><th>Active</th><th></th></tr></thead><tbody>${state.ingredients.map(i => `<tr><td>${esc(i.id)}</td><td><b>${esc(i.name)}</b></td><td>${esc(i.category)}</td><td>${esc(i.unit)}</td><td>${Number(i.currentStock).toFixed(2)}</td><td>${Number(i.minStock).toFixed(2)}</td><td>${money(i.costPerUnit)}</td><td>${esc(i.supplier || "—")}</td><td>${i.active !== false ? "YES" : "NO"}</td><td><button class="soft editIng" data-i="${esc(i.id)}" style="padding:7px 9px;border-radius:9px">Edit</button></td></tr>`).join("") || `<tr><td colspan="10">No ingredients yet.</td></tr>`}</tbody></table></div>`;
  c.querySelectorAll('.editIng').forEach(b => b.onclick = () => openIngredientEditor(b.dataset.i));
}
function renderInventory(c) {
  c.innerHTML = `<div class="form-note">Direct inventory editing is enabled. Enter the actual stock balance and Save. The difference is automatically recorded as a Correction in Inventory Movements.</div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Ingredient</th><th>Unit</th><th>Current Stock</th><th>Min Stock</th><th>Cost/Unit</th><th>Stock Value</th><th>Status</th><th></th></tr></thead><tbody>${state.ingredients.map(i => {
    const cur = Number(i.currentStock), min = Number(i.minStock), cpu = Number(i.costPerUnit);
    return `<tr><td><b>${esc(i.name)}</b></td><td>${esc(i.unit)}</td><td><b>${cur.toFixed(2)}</b></td><td>${min.toFixed(2)}</td><td>${money(cpu)}</td><td>${money(cur * cpu)}</td><td class="${cur <= min ? "warn" : "ok"}">${cur <= min ? "REORDER" : "OK"}</td><td><button class="soft editStock" data-i="${esc(i.id)}" style="padding:7px 9px;border-radius:9px">Edit Stock</button></td></tr>`;
  }).join("") || `<tr><td colspan="8">No ingredients yet.</td></tr>`}</tbody></table></div>`;
  c.querySelectorAll('.editStock').forEach(b => b.onclick = () => openIngredientEditor(b.dataset.i, true));
}
function renderMovements(c) {
  c.innerHTML = `<div class="form-note">Every inventory change is recorded here — completed sales deduct automatically; stock-in, waste, adjustments, returns and corrections are recorded via “+ Stock Movement”.</div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Date</th><th>Ingredient</th><th>Type</th><th>Qty</th><th>Note</th></tr></thead><tbody id="movementsBody"><tr><td colspan="5">Loading…</td></tr></tbody></table></div>`;
  api("movements").then(rows => {
    state.movements = rows;
    document.getElementById("movementsBody").innerHTML = rows.slice().reverse().map(m => `<tr><td>${new Date(m.createdAt).toLocaleString()}</td><td>${esc(m.ingredientName)}</td><td>${esc(m.type)}</td><td>${Number(m.qty) > 0 ? "+" : ""}${Number(m.qty)}</td><td>${esc(m.note || "")}</td></tr>`).join("") || `<tr><td colspan="5">No movements recorded yet.</td></tr>`;
  }).catch(() => { document.getElementById("movementsBody").innerHTML = `<tr><td colspan="5">Could not load movements.</td></tr>`; });
}
function renderRecipes(c) {
  c.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>Product</th><th>Size</th><th>Ingredient</th><th>Qty / Drink</th><th>Unit</th><th>Active</th></tr></thead><tbody>${state.recipes.map(r => `<tr><td>${esc(r.productName)}</td><td>${esc(r.sizeLabel)}</td><td>${esc(r.ingredientName)}</td><td>${r.qty}</td><td>${esc(r.unit)}</td><td>${r.active !== false ? "YES" : "NO"}</td></tr>`).join("") || `<tr><td colspan="6">No recipes yet.</td></tr>`}</tbody></table></div>`;
}
function renderExpenses(c) {
  const total = state.expenses.reduce((a, e) => a + Number(e.amount || 0), 0);
  c.innerHTML = `<div class="kpi"><small>Miscellaneous / operating expenses</small><b>${money(total)}</b></div>
  <div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Payment</th></tr></thead><tbody>${state.expenses.map(e => `<tr><td>${esc(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.description)}</td><td>${money(e.amount)}</td><td>${esc(e.payment || "")}</td></tr>`).join("") || `<tr><td colspan="5">No expenses yet.</td></tr>`}</tbody></table></div>`;
}

function openIngredientEditor(ingredientId, stockOnly = false) {
  const i = state.ingredients.find(x => x.id === ingredientId); if (!i) return;
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>${stockOnly ? "Edit Inventory" : "Edit Ingredient"}</h2><div class="form-grid">
    ${stockOnly ? "" : `<div class="field"><label>INGREDIENT NAME</label><input id="ie_name" value="${esc(i.name)}"></div><div class="field"><label>CATEGORY</label><select id="ie_category">${ingredientCategoryOptions(i.category || "Other")}</select></div><div class="field"><label>BASE UNIT</label><select id="ie_unit">${ingredientUnitOptions(i.unit || "piece")}</select></div>`}
    <div class="field"><label>CURRENT STOCK</label><input id="ie_stock" type="number" step="0.01" min="0" value="${Number(i.currentStock)}"></div>
    ${stockOnly ? "" : `<div class="field"><label>MINIMUM STOCK</label><input id="ie_min" type="number" step="0.01" min="0" value="${Number(i.minStock)}"></div><div class="field"><label>COST / UNIT</label><input id="ie_cost" type="number" step="0.01" min="0" value="${Number(i.costPerUnit)}"></div><div class="field"><label>SUPPLIER</label><input id="ie_supplier" value="${esc(i.supplier || "")}"></div><div class="field"><label>ACTIVE</label><select id="ie_active"><option value="true" ${i.active !== false ? "selected" : ""}>YES</option><option value="false" ${i.active === false ? "selected" : ""}>NO</option></select></div>`}
    <div class="field full"><label>NOTE</label><input id="ie_note" placeholder="Optional note for the inventory correction"></div>
  </div><div class="form-note">Changing Current Stock records the difference as a Correction movement so your inventory history remains auditable.</div><div class="modal-actions"><button class="close" id="ie_cancel">Cancel</button><button class="confirm" id="ie_save">Save Changes</button></div>`;
  const m=document.getElementById("reviewModal"); m.classList.remove("hidden");
  document.getElementById("ie_cancel").onclick=()=>m.classList.add("hidden");
  document.getElementById("ie_save").onclick=async()=>{try{
    const payload={ingredientId, currentStock:Number(document.getElementById("ie_stock").value), note:document.getElementById("ie_note").value};
    if(!stockOnly){payload.name=document.getElementById("ie_name").value.trim();payload.category=document.getElementById("ie_category").value.trim();payload.unit=document.getElementById("ie_unit").value.trim();payload.minStock=Number(document.getElementById("ie_min").value);payload.costPerUnit=Number(document.getElementById("ie_cost").value);payload.supplier=document.getElementById("ie_supplier").value.trim();payload.active=document.getElementById("ie_active").value==="true";}
    const saved=await api("ingredient-stock-set","POST",payload); const idx=state.ingredients.findIndex(x=>x.id===ingredientId); if(idx>=0) state.ingredients[idx]=saved; m.classList.add("hidden"); renderManage(); toast(stockOnly?"Inventory updated.":"Ingredient updated.");
  }catch(e){toast(e.message)}};
}

function ingredientCategoryOptions(selected = "Other") {
  const options = ["Dairy","Tea","Powder","Syrup","Fruit","Puree","Topping","Sweetener","Coffee","Sauce","Packaging","Snack","Add On","Other"];
  return options.map(x => `<option value="${esc(x)}" ${x === selected ? "selected" : ""}>${esc(x)}</option>`).join("") + (selected && !options.includes(selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} (current)</option>` : "");
}
function ingredientUnitOptions(selected = "piece") {
  const options = ["g","kg","ml","L","piece","serving"];
  return options.map(x => `<option value="${esc(x)}" ${x === selected ? "selected" : ""}>${esc(x)}</option>`).join("") + (selected && !options.includes(selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} (current)</option>` : "");
}
async function addIngredient() {
  openSimpleForm("Add Ingredient", [
    ["name", "Ingredient", "text"],
    ["category", "Category", "select", ["Dairy","Tea","Powder","Syrup","Fruit","Puree","Topping","Sweetener","Coffee","Sauce","Packaging","Snack","Add On","Other"]],
    ["unit", "Base Unit", "select", ["g","kg","ml","L","piece","serving"]],
    ["currentStock", "Current Stock", "number"], ["minStock", "Minimum Stock", "number"], ["costPerUnit", "Cost per Unit", "number"], ["supplier", "Supplier", "text"],
  ], async vals => {
    const row = await api("ingredients", "POST", { name: vals.name, category: vals.category || "Other", unit: vals.unit || "piece", currentStock: String(Number(vals.currentStock) || 0), minStock: String(Number(vals.minStock) || 0), costPerUnit: String(Number(vals.costPerUnit) || 0), supplier: vals.supplier || "", active: true });
    state.ingredients.push(row); renderManage(); toast("Ingredient added.");
  });
}
function addRecipe() { openRecipeForm(); }
async function addExpense() {
  openSimpleForm("Add Expense", [["date", "Date", "date"], ["category", "Expense Category (e.g. Electricity, Water, Packaging)", "text"], ["description", "Description", "text"], ["amount", "Amount", "number"], ["payment", "Payment Method", "text"]], async v => {
    const row = await api("expenses", "POST", { date: v.date || nowDate(), category: v.category || "Other", description: v.description || "", amount: String(Number(v.amount) || 0), payment: v.payment || "" });
    state.expenses.push(row); renderManage(); toast("Expense added.");
  });
}
function openStockForm() {
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>Stock Movement</h2><div class="form-grid">
  <div class="field"><label>INGREDIENT</label><select id="sm_ing">${state.ingredients.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("")}</select></div>
  <div class="field"><label>TYPE</label><select id="sm_type">${["Stock In", "Adjustment", "Waste", "Return", "Correction"].map(t => `<option>${t}</option>`).join("")}</select></div>
  <div class="field"><label>QUANTITY</label><input id="sm_qty" type="number" step="0.01"></div>
  <div class="field full"><label>NOTE</label><input id="sm_note" placeholder="Optional note"></div></div>
  <div class="form-note">Stock In / Return / Correction (positive) add to current stock; Waste always subtracts. Adjustment can go either way — enter a negative quantity to reduce stock.</div>
  <div class="modal-actions"><button class="close" id="sm_cancel">Cancel</button><button class="confirm" id="sm_save">Save</button></div>`;
  const m = document.getElementById("reviewModal"); m.classList.remove("hidden");
  document.getElementById("sm_cancel").onclick = () => m.classList.add("hidden");
  document.getElementById("sm_save").onclick = async () => {
    const ingredientId = document.getElementById("sm_ing").value, type = document.getElementById("sm_type").value, qty = Number(document.getElementById("sm_qty").value) || 0, note = document.getElementById("sm_note").value;
    if (!qty) { toast("Enter a quantity."); return; }
    await api("ingredient-stock-in", "POST", { ingredientId, type, qty, note });
    const s = await api("state"); state.ingredients = s.ingredients;
    m.classList.add("hidden"); renderManage(); toast("Stock movement recorded.");
  };
}
function openSimpleForm(title, fields, onSave) {
  const card = document.getElementById("reviewCard");
  const controls = fields.map(([k, l, t, opts]) => {
    if (t === "select") return `<div class="field"><label>${l}</label><select id="sf_${k}">${(opts || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select></div>`;
    return `<div class="field"><label>${l}</label><input id="sf_${k}" type="${t}" value="${t === "date" ? nowDate() : ""}"></div>`;
  }).join("");
  card.innerHTML = `<h2>${title}</h2><div class="form-grid">${controls}</div><div class="modal-actions"><button class="close" id="sfCancel">Cancel</button><button class="confirm" id="sfSave">Save</button></div>`;
  const m = document.getElementById("reviewModal"); m.classList.remove("hidden"); document.getElementById("sfCancel").onclick = () => m.classList.add("hidden");
  document.getElementById("sfSave").onclick = () => { const v = {}; fields.forEach(([k]) => v[k] = document.getElementById("sf_" + k).value); m.classList.add("hidden"); onSave(v); };
}
function openRecipeForm() {
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>Add Recipe</h2><div class="form-grid">
  <div class="field"><label>PRODUCT</label><select id="rf_product">${state.products.map(p => `<option>${esc(p.name)}</option>`).join("")}</select></div>
  <div class="field"><label>SIZE</label><select id="rf_size"><option>ALL</option>${["TALL (12oz)", "GRANDE (16oz)", "VENTI (22oz)", "SMALL", "MEDIUM", "LARGE"].map(s => `<option>${s}</option>`).join("")}</select></div>
  <div class="field"><label>INGREDIENT</label><select id="rf_ing">${state.ingredients.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("")}</select></div>
  <div class="field"><label>QTY USED / DRINK</label><input id="rf_qty" type="number" step="0.01"></div>
  <div class="field"><label>UNIT</label><input id="rf_unit" placeholder="g / ml / piece"></div></div>
  <div class="modal-actions"><button class="close" id="rf_cancel">Cancel</button><button class="confirm" id="rf_save">Save</button></div>`;
  const m = document.getElementById("reviewModal"); m.classList.remove("hidden");
  document.getElementById("rf_cancel").onclick = () => m.classList.add("hidden");
  document.getElementById("rf_save").onclick = async () => {
    const productName = document.getElementById("rf_product").value, product = state.products.find(p => p.name === productName);
    const ingredientId = document.getElementById("rf_ing").value, ingredient = state.ingredients.find(i => i.id === ingredientId);
    const row = await api("recipes", "POST", { productId: product?.id, productName, sizeLabel: document.getElementById("rf_size").value, ingredientId, ingredientName: ingredient?.name, qty: String(Number(document.getElementById("rf_qty").value) || 0), unit: document.getElementById("rf_unit").value || "piece", active: true });
    state.recipes.push(row); m.classList.add("hidden"); renderManage(); toast("Recipe added.");
  };
}

function openProductEditor(pid) {
  const p = pid ? state.products.find(x => x.id === pid) : { id: null, name: "", category: (activeCategories()[0] || {}).name || "", seriesName: "", type: "drink", sizes: { "TALL (12oz)": 0, "GRANDE (16oz)": 0, "VENTI (22oz)": 0 }, active: true };
  const isSnack = p.type === "snack";
  const card = document.getElementById("reviewCard");
  card.innerHTML = `<h2>${pid ? "Edit" : "Add"} Menu Item</h2><div class="form-grid">
    <div class="field"><label>ITEM NAME</label><input id="p_name" value="${esc(p.name)}"></div>
    <div class="field"><label>CATEGORY</label><select id="p_cat">${state.categories.map(c => `<option ${p.category === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
    <div class="field"><label>SERIES (OPTIONAL)</label><select id="p_series"><option value="">No Series</option>${state.series.map(s => `<option ${p.seriesName === s.name ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>
    <div class="field"><label>TYPE</label><select id="p_type"><option value="drink" ${!isSnack ? "selected" : ""}>Drink</option><option value="snack" ${isSnack ? "selected" : ""}>Snack</option></select></div>
    <div class="field"><label>SKU</label><input id="p_sku" value="${esc(p.sku || "")}"></div>
    <div class="field"><label>ACTIVE</label><select id="p_active"><option value="true" ${p.active !== false ? "selected" : ""}>Active</option><option value="false" ${p.active === false ? "selected" : ""}>Inactive</option></select></div>
    <div class="field full"><label>DESCRIPTION</label><input id="p_desc" value="${esc(p.description || "")}"></div>
    <div class="field full"><label>IMAGE PATH</label><input id="p_img" value="${esc(p.image || "")}"></div>
  </div>
  <div id="priceFields"></div>
  <div class="modal-actions"><button class="close" id="pe_cancel">Cancel</button><button class="confirm" id="pe_save">Save Item</button></div>`;
  const m = document.getElementById("reviewModal"); m.classList.remove("hidden");
  const renderPriceFields = () => {
    const snack = document.getElementById("p_type").value === "snack";
    document.getElementById("priceFields").innerHTML = snack ? `<div class="field" style="margin-top:12px"><label>FRIES / SNACK FLAVORS & SIZE PRICES</label>${["Cheese", "Barbecue", "Sour Cream"].map(f => `<div class="form-grid" style="margin-top:7px"><div class="field"><label>${f} — SMALL</label><input id="f_${f}" value="${p.flavors?.[f]?.SMALL ?? 45}"></div><div class="field"><label>MEDIUM</label><input id="m_${f}" value="${p.flavors?.[f]?.MEDIUM ?? 50}"></div><div class="field"><label>LARGE</label><input id="l_${f}" value="${p.flavors?.[f]?.LARGE ?? 55}"></div></div>`).join("")}</div>` :
      `<div class="field" style="margin-top:12px"><label>DRINK PRICES — TALL (12oz), GRANDE (16oz), VENTI (22oz)</label><div class="form-grid"><div class="field"><label>TALL</label><input id="s_tall" type="number" value="${p.sizes?.["TALL (12oz)"] ?? 0}"></div><div class="field"><label>GRANDE</label><input id="s_grande" type="number" value="${p.sizes?.["GRANDE (16oz)"] ?? 0}"></div><div class="field"><label>VENTI</label><input id="s_venti" type="number" value="${p.sizes?.["VENTI (22oz)"] ?? 0}"></div></div></div>`;
  };
  renderPriceFields(); document.getElementById("p_type").onchange = renderPriceFields;
  document.getElementById("pe_cancel").onclick = () => m.classList.add("hidden");
  document.getElementById("pe_save").onclick = async () => {
    const name = document.getElementById("p_name").value.trim();
    if (!name) { toast("Enter an item name."); return; }
    const type = document.getElementById("p_type").value;
    let sizes, flavors = null;
    if (type === "snack") {
      sizes = { SMALL: Number(document.getElementById("f_Cheese").value) || 0, MEDIUM: Number(document.getElementById("m_Cheese").value) || 0, LARGE: Number(document.getElementById("l_Cheese").value) || 0 };
      flavors = {}; ["Cheese", "Barbecue", "Sour Cream"].forEach(f => flavors[f] = { SMALL: Number(document.getElementById("f_" + f).value) || 0, MEDIUM: Number(document.getElementById("m_" + f).value) || 0, LARGE: Number(document.getElementById("l_" + f).value) || 0 });
    } else {
      sizes = { "TALL (12oz)": Number(document.getElementById("s_tall").value) || 0, "GRANDE (16oz)": Number(document.getElementById("s_grande").value) || 0, "VENTI (22oz)": Number(document.getElementById("s_venti").value) || 0 };
    }
    const payload = {
      id: pid || id("PROD_"), name, category: document.getElementById("p_cat").value, seriesName: document.getElementById("p_series").value,
      type, sizes, flavors, sku: document.getElementById("p_sku").value.trim(), description: document.getElementById("p_desc").value.trim(),
      image: document.getElementById("p_img").value.trim(), active: document.getElementById("p_active").value === "true",
    };
    const saved = await api("products" + (pid ? "/" + pid : ""), "POST", payload);
    if (pid) { const i = state.products.findIndex(x => x.id === pid); state.products[i] = saved; } else state.products.push(saved);
    m.classList.add("hidden"); renderAll(); toast("Menu item saved.");
  };
}

function ordersInRange(days) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  return state.completedOrders.filter(o => new Date(o.createdAt || o.date) >= cutoff);
}
function summarize(list) {
  const sales = list.reduce((a, o) => a + Number(o.total), 0);
  const discounts = list.reduce((a, o) => a + Number(o.discountAmount), 0);
  const cogs = list.reduce((a, o) => a + Number(o.ingredientCost || 0), 0);
  return { orders: list.length, sales, discounts, cogs, grossProfit: sales - cogs };
}
function renderReports() {
  const daily = summarize(ordersInRange(1)), weekly = summarize(ordersInRange(7)), monthly = summarize(ordersInRange(30));
  const all = summarize(state.completedOrders);
  const expenses = state.expenses.reduce((a, e) => a + Number(e.amount || 0), 0);
  const netProfit = all.grossProfit - expenses;
  const bestSellers = (() => {
    const m = new Map();
    for (const o of state.completedOrders) for (const item of o.items || []) m.set(item.name, (m.get(item.name) || 0) + item.qty);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  })();
  const lowStock = state.ingredients.filter(i => Number(i.currentStock) <= Number(i.minStock));
  document.getElementById("reportsView").innerHTML = `<div class="reports"><h2>Reports</h2>
  <div class="card" style="padding:14px;margin-top:10px"><b>Daily / Weekly / Monthly Sales</b>
    <div class="kpi-grid" style="margin-top:10px">
      <div class="kpi"><small>Today · Orders / Sales</small><b>${daily.orders} · ${money(daily.sales)}</b></div>
      <div class="kpi"><small>Last 7 Days · Orders / Sales</small><b>${weekly.orders} · ${money(weekly.sales)}</b></div>
      <div class="kpi"><small>Last 30 Days · Orders / Sales</small><b>${monthly.orders} · ${money(monthly.sales)}</b></div>
      <div class="kpi"><small>All-Time Discounts</small><b>${money(all.discounts)}</b></div>
    </div></div>
  <div class="kpi-grid" style="margin-top:12px"><div class="kpi"><small>Gross Sales (All-Time)</small><b>${money(all.sales)}</b></div><div class="kpi"><small>Cost of Goods Sold</small><b>${money(all.cogs)}</b></div><div class="kpi"><small>Gross Profit</small><b>${money(all.grossProfit)}</b></div><div class="kpi"><small>Expenses</small><b>${money(expenses)}</b></div></div>
  <div class="card" style="padding:15px;margin-top:12px"><b>Estimated Net Profit</b><p class="form-note">Revenue − Cost of Goods = Gross Profit (${money(all.grossProfit)}). Gross Profit − Miscellaneous Expenses = Estimated Net Profit.</p><div class="review-summary"><b class="review-total">NET PROFIT</b><b class="review-total">${money(netProfit)}</b></div></div>
  <div class="card" style="padding:15px;margin-top:12px"><b>Best Sellers</b><div class="table-wrap" style="margin-top:8px"><table class="data-table"><thead><tr><th>Product</th><th>Qty Sold</th></tr></thead><tbody>${bestSellers.map(([n, q]) => `<tr><td>${esc(n)}</td><td>${q}</td></tr>`).join("") || `<tr><td colspan="2">No sales yet.</td></tr>`}</tbody></table></div></div>
  <div class="card" style="padding:15px;margin-top:12px"><b>Low Stock</b><div class="table-wrap" style="margin-top:8px"><table class="data-table"><thead><tr><th>Ingredient</th><th>Current</th><th>Min</th></tr></thead><tbody>${lowStock.map(i => `<tr><td>${esc(i.name)}</td><td class="warn">${Number(i.currentStock).toFixed(2)}</td><td>${Number(i.minStock).toFixed(2)}</td></tr>`).join("") || `<tr><td colspan="3">Nothing below the reorder threshold.</td></tr>`}</tbody></table></div></div>
  </div>`;
}


let copilotMessages = [
  { role: "assistant", text: "Hi! I’m Sorella Copilot. I can inspect your menu, recipes, ingredients, inventory, sales and prices — and I can prepare safe changes for your confirmation." }
];
let copilotPending = null;

function copilotFindProduct(text) {
  const q = String(text || "").toLowerCase().trim();
  if (!q) return null;
  return state.products.find(p => p.name.toLowerCase() === q)
    || state.products.find(p => q.includes(p.name.toLowerCase()))
    || state.products.find(p => p.name.toLowerCase().includes(q));
}
function copilotMoney(n) { return money(Number(n) || 0); }
function copilotHelp() {
  return `<b>I can help with:</b><br>• Menu/category/series/product lookup<br>• Prices and price changes<br>• Recipes and ingredient lookup<br>• Inventory, low stock and stock value<br>• Today's sales, sales summary and best sellers<br>• Missing product images<br>• Add an ingredient to inventory<br>• Add a new menu flavor/product<br>• Add a new category or series<br>• Edit ingredient stock/cost/minimum stock<br>• Safe database changes with confirmation<br><br><b>Examples:</b><br>“Show ingredients for Taro”<br>“Add this ingredient in the inventory: Brown Sugar, unit kg, stock 5, cost 180”<br>“Add new flavor Strawberry Matcha to Matcha Series”<br>“Add new flavor Mango to Fruit Tea”<br>“Set pearl stock to 5 kg”<br>“Change Taro Grande to 99”`;
}
function copilotMenuSummary() {
  const active = state.products.filter(p => p.active !== false);
  const counts = {}; active.forEach(p => counts[p.category] = (counts[p.category] || 0) + 1);
  return `<b>${active.length} active menu items</b><br>${Object.entries(counts).map(([c,n]) => `• ${esc(c)}: <b>${n}</b>`).join("<br>")}`;
}
function copilotPriceQuery(text) {
  const p = copilotFindProduct(text); if (!p) return null;
  const sizes = ["TALL (12oz)","GRANDE (16oz)","VENTI (22oz)"];
  const wanted = sizes.find(s => text.toLowerCase().includes(s.toLowerCase().split(" ")[0])) || sizes.find(s => text.toLowerCase().includes(s.split(" ")[0].toLowerCase()));
  if (p.flavors && Object.keys(p.flavors).length) {
    const flavor = Object.keys(p.flavors).find(f => text.toLowerCase().includes(f.toLowerCase()));
    if (flavor && wanted && p.flavors[flavor]?.[wanted] != null) return `${esc(p.name)} — ${esc(flavor)} ${esc(wanted)}: <b>${copilotMoney(p.flavors[flavor][wanted])}</b>`;
    return `${esc(p.name)}:<br>${Object.keys(p.flavors).map(f => `• <b>${esc(f)}</b>: ${sizes.map(sz => `${esc(sz)} ${copilotMoney(p.flavors[f]?.[sz])}`).join(" · ")}`).join("<br>")}`;
  }
  if (wanted) return `${esc(p.name)} — <b>${esc(wanted)}</b>: ${copilotMoney(p.sizes?.[wanted])}`;
  return `${esc(p.name)} prices:<br>${sizes.map(s => `${esc(s)}: <b>${copilotMoney(p.sizes?.[s])}</b>`).join("<br>")}`;
}
function copilotLowStock() {
  const rows=state.ingredients.filter(i=>Number(i.currentStock)<=Number(i.minStock));
  return rows.length ? rows.map(i=>`• <b>${esc(i.name)}</b>: ${Number(i.currentStock).toFixed(2)} ${esc(i.unit)} (minimum ${Number(i.minStock).toFixed(2)})`).join("<br>") : "No ingredients are currently at or below the minimum stock level.";
}
function copilotTodaySales() {
  const today=new Date().toISOString().slice(0,10); const rows=state.completedOrders.filter(o=>o.date===today); const sales=rows.reduce((a,o)=>a+Number(o.total||0),0);
  return `<b>${rows.length} completed order(s)</b> today for <b>${copilotMoney(sales)}</b>.`;
}
function copilotInventorySummary() {
  const value=state.ingredients.reduce((a,i)=>a+Number(i.currentStock||0)*Number(i.costPerUnit||0),0);
  return `<b>${state.ingredients.length}</b> ingredients loaded.<br>Estimated inventory value: <b>${copilotMoney(value)}</b>.<br>Low stock: <b>${state.ingredients.filter(i=>Number(i.currentStock)<=Number(i.minStock)).length}</b>`;
}
function copilotSalesSummary() {
  const all=state.completedOrders; const sales=all.reduce((a,o)=>a+Number(o.total||0),0); const best={};
  all.forEach(o=>(o.items||[]).forEach(i=>best[i.name]=(best[i.name]||0)+Number(i.qty||0)));
  const top=Object.entries(best).sort((a,b)=>b[1]-a[1]).slice(0,5);
  return `<b>All loaded sales:</b> ${copilotMoney(sales)} across ${all.length} orders.<br><b>Best sellers:</b><br>${top.map(([n,q])=>`• ${esc(n)} — ${q}`).join("<br>")||"No sales yet."}`;
}
function copilotIngredientSearch(text) {
  const q=String(text).toLowerCase().replace(/show|list|ingredient|ingredients|stock|for|of|what|are|the/g," ").trim();
  const rows=q?state.ingredients.filter(i=>i.name.toLowerCase().includes(q)):state.ingredients;
  return rows.slice(0,30).map(i=>`• <b>${esc(i.name)}</b> — ${Number(i.currentStock).toFixed(2)} ${esc(i.unit)}, min ${Number(i.minStock).toFixed(2)}, cost ${copilotMoney(i.costPerUnit)}`).join("<br>") || null;
}
function copilotRecipeQuery(text) {
  const p=copilotFindProduct(text); if(!p) return null;
  const rows=state.recipes.filter(r=>r.active!==false && (r.productId===p.id || r.productName===p.name));
  return `<b>${esc(p.name)}</b><br>${rows.map(r=>`• ${esc(r.ingredientName)} — ${r.qty} ${esc(r.unit||"")} ${r.sizeLabel&&r.sizeLabel!=="ALL"?`(${esc(r.sizeLabel)})`:""}`).join("<br>")||"No recipe rows are linked to this product yet."}`;
}
function copilotProductSearch(text) {
  const q=String(text).toLowerCase().replace(/find|search|show|products|product|which|contain|menu|me/g," ").trim();
  const rows=q?state.products.filter(p=>(p.name+" "+p.category+" "+(p.seriesName||"")).toLowerCase().includes(q)):state.products;
  return rows.slice(0,40).map(p=>`• <b>${esc(p.name)}</b> — ${esc(p.category)}${p.seriesName?` · ${esc(p.seriesName)}`:""}`).join("<br>")||"No matching products found.";
}
function parseIngredientCreate(text) {
  let raw=String(text).trim().replace(/^add\s+(this\s+)?ingredient\s+(in|to)\s+(the\s+)?inventory\s*[:\-]?\s*/i,"").replace(/^add\s+ingredient\s*[:\-]?\s*/i,"");
  if(!raw) return null;
  const parts=raw.split(/\s*,\s*|\s*;\s*/).map(x=>x.trim()).filter(Boolean);
  let name=parts[0], unit="piece", currentStock=0, minStock=0, costPerUnit=0, supplier="";
  for(const part of parts.slice(1)){
    const m=part.match(/^(?:unit)\s*[:=]\s*(.+)$/i); if(m){unit=m[1].trim();continue;}
    const n=part.match(/^(?:stock|current stock|qty|quantity)\s*[:=]\s*(-?\d+(?:\.\d+)?)$/i); if(n){currentStock=Number(n[1]);continue;}
    const mn=part.match(/^(?:min|min stock|minimum)\s*[:=]\s*(\d+(?:\.\d+)?)$/i); if(mn){minStock=Number(mn[1]);continue;}
    const c=part.match(/^(?:cost|cost per unit|cpu)\s*[:=]\s*(\d+(?:\.\d+)?)$/i); if(c){costPerUnit=Number(c[1]);continue;}
    const sp=part.match(/^supplier\s*[:=]\s*(.+)$/i); if(sp){supplier=sp[1].trim();continue;}
  }
  return {name,category:"Other",unit,currentStock,minStock,costPerUnit,supplier,active:true};
}
function parseFlavorCreate(text) {
  const q=String(text).trim();
  let m=q.match(/add\s+(?:a\s+)?new\s+flavor\s+(.+?)\s+(?:to|under)\s+(.+?)(?:\s+series)?$/i);
  if(!m) m=q.match(/add\s+(?:a\s+)?new\s+flavor\s*[:\-]?\s*(.+?)\s+(?:to|under)\s+(.+)$/i);
  if(!m) return null;
  const name=m[1].trim(), target=m[2].trim();
  const category=state.categories.find(c=>c.name.toLowerCase()===target.toLowerCase())?.name || state.categories.find(c=>target.toLowerCase().includes(c.name.toLowerCase()))?.name;
  const seriesName=state.series.find(s=>s.name.toLowerCase()===target.toLowerCase() || s.name.toLowerCase().replace(/\s*series$/i,"")===target.toLowerCase().replace(/\s*series$/i,""))?.name || "";
  return {name,category:category||"Milk Tea",seriesName,type:"drink",sizes:{"TALL (12oz)":0,"GRANDE (16oz)":0,"VENTI (22oz)":0},flavors:null,sku:"",description:`New flavor: ${name}`,image:"",active:true};
}
function parseStockSet(text) {
  const m=String(text).match(/(?:set|change|update|make)\s+(.+?)\s+(?:stock|inventory)\s+(?:to|at)\s+(\d+(?:\.\d+)?)/i) || String(text).match(/(?:set|change|update)\s+(.+?)\s+to\s+(\d+(?:\.\d+)?)\s*(?:kg|g|ml|l|pcs|piece|pieces)?$/i);
  if(!m) return null;
  const ing=state.ingredients.find(i=>i.name.toLowerCase()===m[1].trim().toLowerCase()) || state.ingredients.find(i=>i.name.toLowerCase().includes(m[1].trim().toLowerCase()));
  if(!ing) return {error:`I couldn't find an ingredient matching <b>${esc(m[1].trim())}</b>.`};
  return {kind:"stock",ingredient:ing,currentStock:Number(m[2]),old:Number(ing.currentStock)};
}
function copilotParseChange(text) {
  const priceMatch = String(text).match(/(?:to|at)\s*[₱p]?\s*(\d+(?:\.\d+)?)/i); if(!priceMatch) return null;
  const lower=String(text).toLowerCase(); const size = lower.includes("venti") ? "VENTI (22oz)" : lower.includes("grande") ? "GRANDE (16oz)" : "TALL (12oz)";
  const stripped=String(text).replace(priceMatch[0],"").replace(/change|set|update|make|edit|price/gi,"").trim();
  const p=copilotFindProduct(stripped); if(!p) return null;
  return {kind:"price",p,size,old:Number(p.sizes?.[size]||0),price:Number(priceMatch[1])};
}
async function copilotApplyChange(change) {
  if(!change) return;
  if(change.kind==="price"){
    const p=change.p; const sizes={...(p.sizes||{})}; sizes[change.size]=change.price;
    const saved=await api("products/"+p.id,"POST",{sizes}); const idx=state.products.findIndex(x=>x.id===p.id); if(idx>=0) state.products[idx]=saved;
    copilotMessages.push({role:"assistant",text:`Done. <b>${esc(p.name)}</b> ${esc(change.size)} is now <b>${copilotMoney(change.price)}</b>.`});
  } else if(change.kind==="stock"){
    const saved=await api("ingredient-stock-set","POST",{ingredientId:change.ingredient.id,currentStock:change.currentStock,note:"Copilot stock update"});
    const idx=state.ingredients.findIndex(x=>x.id===change.ingredient.id); if(idx>=0) state.ingredients[idx]=saved;
    copilotMessages.push({role:"assistant",text:`Done. <b>${esc(saved.name)}</b> stock is now <b>${Number(saved.currentStock).toFixed(2)} ${esc(saved.unit)}</b>.`});
  } else if(change.kind==="addIngredient"){
    const row=await api("ingredients","POST",{...change.data,id:id("ING_")}); state.ingredients.push(row);
    copilotMessages.push({role:"assistant",text:`Added <b>${esc(row.name)}</b> to Inventory with ${Number(row.currentStock).toFixed(2)} ${esc(row.unit)}.`});
  } else if(change.kind==="addProduct"){
    const row=await api("products","POST",{...change.data,id:id("PROD_")}); state.products.push(row);
    copilotMessages.push({role:"assistant",text:`Added new flavor/product <b>${esc(row.name)}</b> under <b>${esc(row.category)}</b>${row.seriesName?` · ${esc(row.seriesName)}`:""}. Please add its recipe and image before selling it.`});
  }
  copilotPending=null; renderCopilot(); renderAll();
}
function copilotConfirmText(change){
  if(change.kind==="stock") return `I’m ready to set <b>${esc(change.ingredient.name)}</b> from <b>${Number(change.old).toFixed(2)} ${esc(change.ingredient.unit)}</b> to <b>${Number(change.currentStock).toFixed(2)} ${esc(change.ingredient.unit)}</b>.<br><span class="copilot-warning">This changes inventory in the database. Confirm before I apply it.</span>`;
  if(change.kind==="addIngredient") return `I’m ready to add <b>${esc(change.data.name)}</b> to Inventory with <b>${Number(change.data.currentStock).toFixed(2)} ${esc(change.data.unit)}</b>, minimum ${Number(change.data.minStock).toFixed(2)}, cost ${copilotMoney(change.data.costPerUnit)}.<br><span class="copilot-warning">This creates a new ingredient in the database. Confirm before I apply it.</span>`;
  if(change.kind==="addProduct") return `I’m ready to add new flavor/product <b>${esc(change.data.name)}</b> under <b>${esc(change.data.category)}</b>${change.data.seriesName?` · ${esc(change.data.seriesName)}`:""}. Prices will start at 0 until you edit them.<br><span class="copilot-warning">This creates a new menu item in the database. Confirm before I apply it.</span>`;
  return `I’m ready to change <b>${esc(change.p.name)}</b> <b>${esc(change.size)}</b> from <b>${copilotMoney(change.old)}</b> to <b>${copilotMoney(change.price)}</b>.<br><span class="copilot-warning">This changes the menu price in the database. Confirm before I apply it.</span>`;
}
function copilotRespond(text) {
  const q=String(text||"").trim(); if(!q)return; const l=q.toLowerCase();
  copilotMessages.push({role:"user",text:esc(q)});
  if(copilotPending && /^(confirm|yes|save|apply|do it|go ahead)$/i.test(q)){ return copilotApplyChange(copilotPending); }
  if(copilotPending && /^(cancel|no|stop|never mind)$/i.test(q)){ copilotPending=null; copilotMessages.push({role:"assistant",text:"Cancelled — no database change was made."}); return renderCopilot(); }
  if(/^(help|what can you do|commands)/.test(l)){copilotMessages.push({role:"assistant",text:copilotHelp()});return renderCopilot();}
  if(/add\s+(?:this\s+)?ingredient\s+(?:in|to)\s+(?:the\s+)?inventory|add\s+ingredient/.test(l)){
    const data=parseIngredientCreate(q); if(!data) copilotMessages.push({role:"assistant",text:'Try: <b>Add this ingredient in the inventory: Brown Sugar, unit kg, stock 5, cost 180</b>'});
    else { copilotPending={kind:"addIngredient",data}; copilotMessages.push({role:"assistant",text:copilotConfirmText(copilotPending),pending:true}); } return renderCopilot();
  }
  if(/add\s+(?:a\s+)?new\s+flavor/.test(l)){
    const data=parseFlavorCreate(q); if(!data) copilotMessages.push({role:"assistant",text:'Try: <b>Add new flavor Strawberry Matcha to Matcha Series</b> or <b>Add new flavor Mango to Fruit Tea</b>. A recipe and image can be added afterward.'});
    else if(state.products.some(p=>p.name.toLowerCase()===data.name.toLowerCase())) copilotMessages.push({role:"assistant",text:`<b>${esc(data.name)}</b> already exists in the menu.`});
    else {copilotPending={kind:"addProduct",data};copilotMessages.push({role:"assistant",text:copilotConfirmText(copilotPending),pending:true});} return renderCopilot();
  }
  const stockChange=parseStockSet(q); if(stockChange){ if(stockChange.error) copilotMessages.push({role:"assistant",text:stockChange.error}); else {copilotPending=stockChange;copilotMessages.push({role:"assistant",text:copilotConfirmText(stockChange),pending:true});} return renderCopilot(); }
  if(/inventory summary|stock value|how much inventory|inventory worth/.test(l)){copilotMessages.push({role:"assistant",text:copilotInventorySummary()});return renderCopilot();}
  if(/sales summary|sales report|total sales|best sellers/.test(l)){copilotMessages.push({role:"assistant",text:copilotSalesSummary()});return renderCopilot();}
  if(/recipe|ingredients.*(for|of)|what.*ingredients/.test(l)){const a=copilotRecipeQuery(q);if(a){copilotMessages.push({role:"assistant",text:a});return renderCopilot();}}
  if(/show.*ingredient|list.*ingredient|ingredient.*stock|stock.*ingredient/.test(l)){copilotMessages.push({role:"assistant",text:copilotIngredientSearch(q)||"No matching ingredients found."});return renderCopilot();}
  if(/find|search|which products|products.*(match|contain)/.test(l)&&!/price/.test(l)){copilotMessages.push({role:"assistant",text:copilotProductSearch(q)});return renderCopilot();}
  if(/(show|list).*(menu|products)|how many products|product count/.test(l)){copilotMessages.push({role:"assistant",text:copilotMenuSummary()});return renderCopilot();}
  if(/without (an )?image|missing image|no image/.test(l)){const missing=state.products.filter(p=>p.active!==false&&!p.image);copilotMessages.push({role:"assistant",text:missing.length?missing.map(p=>`• <b>${esc(p.name)}</b> (${esc(p.category)})`).join("<br>"):"Great — every active product has an image path."});return renderCopilot();}
  if(/low stock|reorder|stock alert/.test(l)){copilotMessages.push({role:"assistant",text:copilotLowStock()});return renderCopilot();}
  if(/today.*sales|sales.*today|today.*revenue/.test(l)){copilotMessages.push({role:"assistant",text:copilotTodaySales()});return renderCopilot();}
  if(/^(change|set|update|make|edit).*(price|₱|p\s*\d)|price.*(?:to|at)\s*[₱p]?\s*\d/.test(l)){
    const change=copilotParseChange(q); if(!change) copilotMessages.push({role:"assistant",text:"I couldn't safely identify the product, size, and new price. Example: <b>Change Taro Grande to 99</b>."}); else {copilotPending=change;copilotMessages.push({role:"assistant",text:copilotConfirmText(change),pending:true});} return renderCopilot();
  }
  const priceAnswer=/price|how much|cost/.test(l)?copilotPriceQuery(l):null; if(priceAnswer){copilotMessages.push({role:"assistant",text:priceAnswer});return renderCopilot();}
  copilotMessages.push({role:"assistant",text:`I can help with that, but I don't have a built-in action for that request yet.<br><br>${copilotHelp()}`}); renderCopilot();
}
function renderCopilot() {
  const v=document.getElementById("copilotView"); if(!v)return;
  v.innerHTML=`<div class="copilot-shell"><div class="copilot-head"><div><h2>🤖 Sorella Copilot</h2><p>Menu-aware assistant for safe POS administration.</p></div><div class="copilot-head-actions"><button class="copilot-new" id="copilotNew">＋ New Chat</button><span class="copilot-status">● Ready</span></div></div><div class="copilot-grid"><div class="copilot-chat"><div class="copilot-messages" id="copilotMessages">${copilotMessages.map(m=>`<div class="copilot-message ${m.role}"><div class="copilot-avatar">${m.role==="assistant"?"🤖":"👤"}</div><div class="copilot-bubble">${m.text}${m.pending&&copilotPending?`<div class="copilot-confirm"><button id="copilotConfirm">Confirm</button><button id="copilotCancel" class="soft">Cancel</button></div>`:""}</div></div>`).join("")}</div><form class="copilot-input" id="copilotForm"><textarea id="copilotInput" autocomplete="off" rows="1" placeholder="Type a request… e.g. Add this ingredient in the inventory: Pearl, unit kg, stock 5"></textarea><button type="submit" aria-label="Send request">➤ <span>Send</span></button></form><div class="copilot-hint">Press <b>Enter</b> to send · <b>Shift + Enter</b> for a new line</div></div><aside class="copilot-tools"><b>Quick actions</b><button data-copilot="Show my menu">📋 Menu summary</button><button data-copilot="Show products without images">🖼 Missing images</button><button data-copilot="What are today's sales?">📊 Today's sales</button><button data-copilot="Show low stock">📦 Low stock</button><button data-copilot="Show inventory summary">💰 Inventory value</button><button data-copilot="Show ingredients for Taro">🧪 Recipe lookup</button><button data-copilot="Show all ingredients">🧂 All ingredients</button><button data-copilot="Show best sellers">🏆 Best sellers</button><button data-copilot="Add this ingredient in the inventory: Pearl, unit kg, stock 0, cost 0">➕ Add ingredient</button><button data-copilot="Add new flavor Strawberry Matcha to Matcha Series">✨ Add new flavor</button><button data-copilot="What is the price of Taro Grande?">💰 Check price</button><div class="copilot-safety"><b>Safe by design</b><p>Copilot can read current POS data and prepare changes. Adding/editing inventory, ingredients, products and prices requires confirmation before saving.</p></div></aside></div></div>`;
  const msgs=document.getElementById("copilotMessages");msgs.scrollTop=msgs.scrollHeight;const form=document.getElementById("copilotForm"),input=document.getElementById("copilotInput");form.onsubmit=e=>{e.preventDefault();const value=input.value.trim();if(!value)return;copilotRespond(value);input.value="";setTimeout(()=>input.focus(),0)};input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();form.requestSubmit()}};document.getElementById("copilotNew").onclick=()=>{copilotMessages=[{role:"assistant",text:"New chat started. Tell me what you want to check or change in the Sorella Tea POS."}];copilotPending=null;renderCopilot();setTimeout(()=>document.getElementById("copilotInput")?.focus(),0)};v.querySelectorAll("[data-copilot]").forEach(b=>b.onclick=()=>copilotRespond(b.dataset.copilot));const confirm=document.getElementById("copilotConfirm");if(confirm)confirm.onclick=()=>copilotApplyChange(copilotPending);const cancel=document.getElementById("copilotCancel");if(cancel)cancel.onclick=()=>{copilotPending=null;copilotMessages.push({role:"assistant",text:"Cancelled — no database change was made."});renderCopilot()};
}

function renderSettings() {
  document.getElementById("settingsView").innerHTML = `<div class="manage-head"><h2>Settings</h2></div>
  <div class="card" style="padding:16px;max-width:700px"><div class="form-grid">
    <div class="field"><label>BUSINESS NAME</label><input value="Sorella Tea" disabled></div>
    <div class="field"><label>CURRENCY</label><input value="PHP (₱)" disabled></div>
    <div class="field full"><label>DATA STORAGE</label><div class="form-note">Menu, categories, series, ingredients, recipes, discounts, expenses, sales and inventory movements are stored in the Sorella Tea Netlify database — they survive browser refresh, closing the browser, and redeploying this site. Only the in-progress cart is cached in this browser so an accidental refresh mid-sale isn't lost.</div></div>
    <div class="field"><label>BACKUP</label><button class="manage-actions" id="settingsBackup">Export Backup JSON</button></div>
    <div class="field"><label>RESTORE</label><button class="manage-actions" id="settingsImport">Import Backup JSON</button></div>
  </div></div>`;
  document.getElementById("settingsBackup").onclick = exportBackup;
  document.getElementById("settingsImport").onclick = () => document.getElementById("importInput").click();
}
async function exportBackup() {
  try {
    const backup = await api("backup");
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sorella-tea-pos-backup-" + nowDate() + ".json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
    toast("Backup exported.");
  } catch (e) { toast("Could not export backup."); }
}
async function importBackup(e) {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (!f.name.toLowerCase().endsWith(".json")) { toast("Please choose a .json backup file exported from this POS."); return; }
  try {
    const data = JSON.parse(await f.text());
    if (!confirm("Restore will add/update records from this backup without deleting anything currently saved. Continue?")) return;
    await api("restore", "POST", data);
    await loadServerState();
    renderAll();
    toast("Backup restored.");
  } catch (err) { toast("Invalid backup JSON."); }
}

init();

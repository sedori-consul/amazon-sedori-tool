// === 注文分析ツール（在庫データ + 注文レポート） ===

// === 状態管理 ===
let inventoryMap = {};   // SKU → { asin, name, price }
let orderData = [];      // パース済み注文データ
let asinGroups = {};     // ASIN別集計
let costMap = {};        // ASIN/SKU → 仕入れ値
let currentSort = 'quantity-desc';
let searchQuery = '';

// === localStorageキー ===
const KEYS = {
  inventory: 'oa_inventory_map',
  orders: 'oa_order_data',
  costs: 'oa_cost_map',
};

// === 初期化 ===
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  setupDropZones();
  setupFileInputs();
  updateStepStatus();
  // 両方のデータがあれば分析表示
  if (orderData.length > 0) {
    buildAnalysis();
    showAnalysis();
  }
});

// === localStorage読み書き ===
function loadFromStorage() {
  try {
    const inv = localStorage.getItem(KEYS.inventory);
    if (inv) inventoryMap = JSON.parse(inv);
    const ord = localStorage.getItem(KEYS.orders);
    if (ord) {
      orderData = JSON.parse(ord);
      // 文字化けデータ検出 → 自動クリア
      if (orderData.length > 0 && !orderData.some(o => containsJapanese(o.productName || ''))) {
        orderData = [];
        localStorage.removeItem(KEYS.orders);
      }
    }
    const costs = localStorage.getItem(KEYS.costs);
    if (costs) costMap = JSON.parse(costs);
  } catch (e) {
    inventoryMap = {};
    orderData = [];
    costMap = {};
  }
}

function saveInventory() {
  localStorage.setItem(KEYS.inventory, JSON.stringify(inventoryMap));
}

function saveOrders() {
  try {
    localStorage.setItem(KEYS.orders, JSON.stringify(orderData));
  } catch (e) { /* 容量超過は無視 */ }
}

function saveCosts() {
  localStorage.setItem(KEYS.costs, JSON.stringify(costMap));
}

// === ファイルアップロード ===
function setupFileInputs() {
  document.getElementById('fileInventory').addEventListener('change', (e) => {
    if (e.target.files[0]) processFile(e.target.files[0], 'inventory');
  });
  document.getElementById('fileOrders').addEventListener('change', (e) => {
    if (e.target.files[0]) processFile(e.target.files[0], 'orders');
  });
}

function setupDropZones() {
  setupDrop('dropInventory', 'inventory');
  setupDrop('dropOrders', 'orders');
}

function setupDrop(zoneId, type) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;

  ['dragenter', 'dragover'].forEach(ev => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
  });
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0], type);
  });
  zone.addEventListener('click', (e) => {
    if (!e.target.closest('button')) {
      document.getElementById(type === 'inventory' ? 'fileInventory' : 'fileOrders').click();
    }
  });
}

// === ファイル処理（エンコード自動判定） ===
function processFile(file, type) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const sjisText = e.target.result;
    if (containsJapanese(sjisText)) {
      parseFile(sjisText, type);
    } else {
      const reader2 = new FileReader();
      reader2.onload = (e2) => parseFile(e2.target.result, type);
      reader2.readAsText(file, 'UTF-8');
    }
  };
  reader.readAsText(file, 'Shift_JIS');
}

function containsJapanese(text) {
  return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test((text || '').substring(0, 5000));
}

// === パース振り分け ===
function parseFile(text, type) {
  if (type === 'inventory') {
    parseInventory(text);
  } else {
    parseOrders(text);
  }
}

// === 在庫データパース ===
function parseInventory(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { showToast('在庫データが見つかりません', 'error'); return; }

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));

  // ヘッダーマッピング
  const colSku = findCol(headers, ['seller-sku', 'sku', 'SKU', '出品者SKU']);
  const colAsin = findCol(headers, ['asin1', 'asin', 'ASIN', 'product-id']);
  const colName = findCol(headers, ['item-name', 'product-name', '商品名', 'タイトル']);
  const colPrice = findCol(headers, ['price', '価格', 'your-price']);

  if (colSku === -1) { showToast('SKU列が見つかりません', 'error'); return; }
  if (colAsin === -1) { showToast('ASIN列が見つかりません', 'error'); return; }

  inventoryMap = {};
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i], delimiter);
    const sku = (vals[colSku] || '').replace(/^"|"$/g, '').trim();
    const asin = (vals[colAsin] || '').replace(/^"|"$/g, '').trim();
    if (!sku || !asin) continue;

    inventoryMap[sku] = {
      asin: asin,
      name: colName !== -1 ? (vals[colName] || '').replace(/^"|"$/g, '').trim() : '',
      price: colPrice !== -1 ? parsePrice((vals[colPrice] || '')) : 0,
    };
  }

  saveInventory();
  updateStepStatus();
  showToast(Object.keys(inventoryMap).length + '件の在庫データを読み込みました');

  // 注文データもあれば再集計
  if (orderData.length > 0) {
    buildAnalysis();
    showAnalysis();
  }
}

// === 注文レポートパース ===
function parseOrders(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { showToast('注文データが見つかりません', 'error'); return; }

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));

  const colMap = {
    orderId: findCol(headers, ['amazon-order-id', 'order-id', '注文番号']),
    date: findCol(headers, ['purchase-date', '注文日', '購入日']),
    sku: findCol(headers, ['sku', 'SKU', '出品者SKU', 'seller-sku']),
    name: findCol(headers, ['product-name', '商品名', 'タイトル', 'item-name']),
    qty: findCol(headers, ['quantity-purchased', 'quantity', '数量']),
    price: findCol(headers, ['item-price', '商品の価格', '商品価格', '価格']),
  };

  if (colMap.sku === -1) { showToast('SKU列が見つかりません', 'error'); return; }

  orderData = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i], delimiter);
    if (vals.length < 3) continue;

    const sku = (vals[colMap.sku] || '').replace(/^"|"$/g, '').trim();
    if (!sku) continue;

    orderData.push({
      orderId: colMap.orderId !== -1 ? vals[colMap.orderId] || '' : '',
      purchaseDate: colMap.date !== -1 ? vals[colMap.date] || '' : '',
      sku: sku,
      productName: colMap.name !== -1 ? (vals[colMap.name] || '').replace(/^"|"$/g, '').trim() : '',
      quantity: colMap.qty !== -1 ? (parseInt(vals[colMap.qty]) || 1) : 1,
      itemPrice: colMap.price !== -1 ? parsePrice(vals[colMap.price] || '') : 0,
    });
  }

  if (orderData.length === 0) { showToast('有効な注文データがありません', 'error'); return; }

  saveOrders();
  updateStepStatus();
  buildAnalysis();
  showAnalysis();
  showToast(orderData.length + '件の注文データを読み込みました');
}

// === 分析データ構築 ===
function buildAnalysis() {
  asinGroups = {};
  const hasInventory = Object.keys(inventoryMap).length > 0;

  for (const order of orderData) {
    // SKUから在庫データでASINを引く
    const inv = inventoryMap[order.sku];
    const asin = inv ? inv.asin : '';
    const groupKey = asin || order.sku; // ASINがあればASIN、なければSKU

    if (!asinGroups[groupKey]) {
      asinGroups[groupKey] = {
        groupKey: groupKey,
        asin: asin,
        productName: (inv ? inv.name : '') || order.productName || '',
        skus: new Set(),
        orders: [],
        totalQuantity: 0,
        totalRevenue: 0,
      };
    }

    const g = asinGroups[groupKey];
    g.orders.push(order);
    g.totalQuantity += order.quantity;
    g.totalRevenue += order.itemPrice;
    g.skus.add(order.sku);
    if (!g.productName && order.productName) g.productName = order.productName;
    if (!g.asin && asin) g.asin = asin;
  }
}

// === 表示制御 ===
function showAnalysis() {
  document.getElementById('uploadArea').style.display = 'none';
  document.getElementById('summaryCards').style.display = 'grid';
  document.getElementById('statusBar').style.display = 'flex';
  document.getElementById('tableCard').style.display = 'block';
  document.getElementById('btnExport').style.display = '';
  document.getElementById('btnClear').style.display = '';
  updatePeriod();
  updateSummary();
  renderTable();
  updateStatusBar();
}

function showUploadArea() {
  document.getElementById('uploadArea').style.display = '';
  document.getElementById('summaryCards').style.display = 'none';
  document.getElementById('statusBar').style.display = 'none';
  document.getElementById('tableCard').style.display = 'none';
  document.getElementById('btnExport').style.display = 'none';
  document.getElementById('btnClear').style.display = 'none';
  updateStepStatus();
}

function updateStepStatus() {
  const invCount = Object.keys(inventoryMap).length;
  const ordCount = orderData.length;

  const invBadge = document.getElementById('inventoryBadge');
  const ordBadge = document.getElementById('orderBadge');

  if (invCount > 0) {
    invBadge.textContent = invCount + '件読込済';
    invBadge.className = 'flow-step-badge loaded';
    document.getElementById('stepInventory').classList.add('step-done');
  } else {
    invBadge.textContent = '未読込';
    invBadge.className = 'flow-step-badge';
    document.getElementById('stepInventory').classList.remove('step-done');
  }

  if (ordCount > 0) {
    ordBadge.textContent = ordCount + '件読込済';
    ordBadge.className = 'flow-step-badge loaded';
    document.getElementById('stepOrders').classList.add('step-done');
  } else {
    ordBadge.textContent = '未読込';
    ordBadge.className = 'flow-step-badge';
    document.getElementById('stepOrders').classList.remove('step-done');
  }
}

function updatePeriod() {
  const dates = orderData.map(o => o.purchaseDate).filter(d => d).sort();
  if (dates.length > 0) {
    document.getElementById('orderPeriod').textContent =
      formatDate(dates[0]) + ' ~ ' + formatDate(dates[dates.length - 1]) + ' (' + orderData.length + '件)';
  }
}

function updateSummary() {
  const keys = Object.keys(asinGroups);
  let totalOrders = 0, totalQty = 0, totalRev = 0, totalCost = 0;
  let allCost = true;

  for (const k of keys) {
    const g = asinGroups[k];
    totalOrders += g.orders.length;
    totalQty += g.totalQuantity;
    totalRev += g.totalRevenue;
    if (costMap[k] !== undefined) {
      totalCost += costMap[k] * g.totalQuantity;
    } else {
      allCost = false;
    }
  }

  document.getElementById('totalOrders').textContent = totalOrders.toLocaleString();
  document.getElementById('totalAsins').textContent = keys.length.toLocaleString();
  document.getElementById('totalQuantity').textContent = totalQty.toLocaleString();
  document.getElementById('totalRevenue').textContent = yen(totalRev);
  document.getElementById('totalCost').textContent = allCost ? yen(totalCost) : '-';

  const profitEl = document.getElementById('totalProfit');
  if (allCost) {
    const p = totalRev - totalCost;
    profitEl.textContent = yen(p);
    profitEl.className = 'summary-value ' + (p >= 0 ? 'positive' : 'negative');
  } else {
    let partial = 0, any = false;
    for (const k of keys) {
      if (costMap[k] !== undefined) {
        partial += asinGroups[k].totalRevenue - costMap[k] * asinGroups[k].totalQuantity;
        any = true;
      }
    }
    profitEl.textContent = any ? yen(partial) + ' (一部)' : '-';
    profitEl.className = 'summary-value ' + (any ? (partial >= 0 ? 'positive' : 'negative') : '');
  }
}

function updateStatusBar() {
  const missing = Object.keys(asinGroups).filter(k => costMap[k] === undefined).length;
  const el = document.getElementById('statusText');
  const bar = document.getElementById('statusBar');
  if (missing === 0) {
    el.textContent = '全ASINの仕入れ値が入力済みです';
    bar.classList.add('status-complete');
    bar.classList.remove('status-warning');
  } else {
    el.innerHTML = '仕入れ値が未入力: <strong>' + missing + '</strong>件';
    bar.classList.add('status-warning');
    bar.classList.remove('status-complete');
  }
}

// === テーブル ===
function renderTable() {
  document.getElementById('tableBody').innerHTML = getSortedGroups().map(buildRow).join('');
  updateFooter();
}

function getSortedGroups() {
  let groups = Object.values(asinGroups);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    groups = groups.filter(g =>
      g.groupKey.toLowerCase().includes(q) ||
      (g.productName || '').toLowerCase().includes(q) ||
      (g.asin || '').toLowerCase().includes(q) ||
      Array.from(g.skus).some(s => s.toLowerCase().includes(q))
    );
  }
  const [key, dir] = currentSort.split('-');
  groups.sort((a, b) => {
    let va, vb;
    switch (key) {
      case 'quantity': va = a.totalQuantity; vb = b.totalQuantity; break;
      case 'revenue': va = a.totalRevenue; vb = b.totalRevenue; break;
      case 'profit':
        va = costMap[a.groupKey] !== undefined ? a.totalRevenue - costMap[a.groupKey] * a.totalQuantity : -Infinity;
        vb = costMap[b.groupKey] !== undefined ? b.totalRevenue - costMap[b.groupKey] * b.totalQuantity : -Infinity;
        break;
      case 'name':
        va = a.productName || ''; vb = b.productName || '';
        return dir === 'asc' ? va.localeCompare(vb, 'ja') : vb.localeCompare(va, 'ja');
      default: va = a.totalQuantity; vb = b.totalQuantity;
    }
    return dir === 'asc' ? va - vb : vb - va;
  });
  return groups;
}

function safeId(key) { return 'r-' + key.replace(/[^a-zA-Z0-9]/g, '_'); }

function buildRow(g) {
  const k = g.groupKey;
  const cost = costMap[k];
  const hasCost = cost !== undefined;
  const avg = g.totalQuantity > 0 ? Math.round(g.totalRevenue / g.totalQuantity) : 0;
  const tc = hasCost ? cost * g.totalQuantity : null;
  const profit = hasCost ? g.totalRevenue - tc : null;
  const margin = hasCost && g.totalRevenue > 0 ? Math.round((profit / g.totalRevenue) * 100) : null;
  const hasAsin = g.asin && /^(B0[A-Z0-9]{8}|\d{10})$/.test(g.asin);
  const skus = Array.from(g.skus);

  // 画像
  let img;
  if (hasAsin) {
    img = '<img class="order-thumb" src="https://images-na.ssl-images-amazon.com/images/P/' + g.asin + '.01._SCMZZZZZZZ_.jpg" onerror="this.outerHTML=\'<div class=order-thumb-placeholder><span class=material-symbols-outlined>image</span></div>\'">';
  } else {
    img = '<div class="order-thumb-placeholder"><span class="material-symbols-outlined">inventory_2</span></div>';
  }

  // 商品名
  const name = esc(g.productName || '(商品名不明)');
  let nameHtml = hasAsin
    ? '<a class="product-link" href="https://www.amazon.co.jp/dp/' + g.asin + '" target="_blank">' + name + '</a>'
    : '<span class="product-link" style="cursor:default">' + name + '</span>';

  // ID表示
  let idHtml = '';
  if (hasAsin) {
    idHtml = '<span class="asin-text" data-copy="' + g.asin + '" onclick="copyText(this)">ASIN: ' + g.asin + '</span>';
  }
  idHtml += '<span class="sku-text">SKU: ' + esc(skus.join(', ')) + '</span>';

  return '<tr id="' + safeId(k) + '">' +
    '<td class="col-img">' + img + '</td>' +
    '<td class="col-name"><div class="name-cell">' + nameHtml + idHtml + '</div></td>' +
    '<td class="col-qty cell-right">' + g.totalQuantity + '</td>' +
    '<td class="col-avg-price cell-right">' + yen(avg) + '</td>' +
    '<td class="col-revenue cell-right">' + yen(g.totalRevenue) + '</td>' +
    '<td class="col-cost"><div class="cost-input-group">' +
      '<input type="number" class="cost-input' + (hasCost ? ' has-value' : '') + '" ' +
        'value="' + (hasCost ? cost : '') + '" placeholder="0" ' +
        'data-key="' + escAttr(k) + '" onchange="setCostFromInput(this)" onkeydown="handleCostKey(event)">' +
      '<span class="cost-unit">円</span></div></td>' +
    '<td class="col-total-cost cell-right">' + (hasCost ? yen(tc) : dim('-')) + '</td>' +
    '<td class="col-gross cell-right">' + (hasCost ? pn(profit, yen(profit)) : dim('-')) + '</td>' +
    '<td class="col-margin cell-right">' + (margin !== null ? pn(margin, margin + '%') : dim('-')) + '</td>' +
  '</tr>';
}

function updateRow(k) {
  const g = asinGroups[k]; if (!g) return;
  const row = document.getElementById(safeId(k)); if (!row) return;
  const cost = costMap[k]; const hasCost = cost !== undefined;
  const tc = hasCost ? cost * g.totalQuantity : null;
  const profit = hasCost ? g.totalRevenue - tc : null;
  const margin = hasCost && g.totalRevenue > 0 ? Math.round((profit / g.totalRevenue) * 100) : null;
  const cells = row.querySelectorAll('td');
  cells[6].innerHTML = hasCost ? yen(tc) : dim('-');
  cells[7].innerHTML = hasCost ? pn(profit, yen(profit)) : dim('-');
  cells[8].innerHTML = margin !== null ? pn(margin, margin + '%') : dim('-');
  const input = row.querySelector('.cost-input');
  if (input) input.classList.toggle('has-value', hasCost);
}

function updateFooter() {
  const groups = getSortedGroups();
  let tq = 0, tr = 0, tc = 0, tp = 0, all = true;
  for (const g of groups) {
    tq += g.totalQuantity; tr += g.totalRevenue;
    if (costMap[g.groupKey] !== undefined) {
      tc += costMap[g.groupKey] * g.totalQuantity;
      tp += g.totalRevenue - costMap[g.groupKey] * g.totalQuantity;
    } else { all = false; }
  }
  document.getElementById('tableFoot').innerHTML = '<tr>' +
    '<td colspan="2" style="font-weight:700">合計 (' + groups.length + ' ASIN)</td>' +
    '<td class="cell-right" style="font-weight:700">' + tq + '</td><td></td>' +
    '<td class="cell-right" style="font-weight:700">' + yen(tr) + '</td><td></td>' +
    '<td class="cell-right" style="font-weight:700">' + (all ? yen(tc) : '-') + '</td>' +
    '<td class="cell-right" style="font-weight:700">' + (all ? pn(tp, yen(tp)) : '-') + '</td>' +
    '<td></td></tr>';
}

// === 仕入れ値 ===
function setCostFromInput(el) { setCost(el.dataset.key, el.value); }

function setCost(k, val) {
  const c = parseFloat(val);
  if (isNaN(c) || c < 0) { delete costMap[k]; } else { costMap[k] = c; }
  saveCosts();
  updateSummary();
  updateRow(k);
  updateFooter();
  updateStatusBar();
}

function handleCostKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    setCostFromInput(e.target);
    const next = e.target.closest('tr').nextElementSibling;
    if (next) { const inp = next.querySelector('.cost-input'); if (inp) inp.focus(); }
  } else if (e.key === 'Tab') {
    setCostFromInput(e.target);
  }
}

// === 検索・ソート ===
function filterTable() { searchQuery = document.getElementById('searchInput').value; renderTable(); }
function sortTable() { currentSort = document.getElementById('sortSelect').value; renderTable(); }

// === CSV出力 ===
function exportCsv() {
  const groups = getSortedGroups();
  const bom = '\uFEFF';
  const h = ['ASIN', 'SKU', '商品名', '販売数量', '平均単価', '売上合計', '仕入れ値(1個)', '仕入れ合計', '粗利合計', '利益率'].join(',');
  const rows = groups.map(g => {
    const c = costMap[g.groupKey]; const hc = c !== undefined;
    const avg = g.totalQuantity > 0 ? Math.round(g.totalRevenue / g.totalQuantity) : 0;
    const tc = hc ? c * g.totalQuantity : '';
    const p = hc ? g.totalRevenue - tc : '';
    const m = hc && g.totalRevenue > 0 ? Math.round((p / g.totalRevenue) * 100) + '%' : '';
    return [q(g.asin || ''), q(Array.from(g.skus).join('; ')), q(g.productName || ''),
      g.totalQuantity, avg, Math.round(g.totalRevenue), hc ? c : '', hc ? Math.round(tc) : '', hc ? Math.round(p) : '', m].join(',');
  });
  downloadFile('注文分析_' + today() + '.csv', bom + h + '\n' + rows.join('\n'), 'text/csv;charset=utf-8;');
}

// === データクリア ===
function clearAllData() {
  if (!confirm('全データをクリアしますか？')) return;
  orderData = []; inventoryMap = {}; asinGroups = {};
  Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  showUploadArea();
  document.getElementById('orderPeriod').textContent = '';
  showToast('全データをクリアしました');
}

// === ユーティリティ ===
function findCol(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h.toLowerCase().replace(/[\s\-_]/g, '') === c.toLowerCase().replace(/[\s\-_]/g, ''));
    if (i !== -1) return i;
  }
  return -1;
}

function parseLine(line, delim) {
  const r = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (c === delim && !inQ) { r.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  r.push(cur.trim()); return r;
}

function parsePrice(s) { return parseFloat((s || '').replace(/[^0-9.\-]/g, '')) || 0; }
function formatDate(s) { try { const d = new Date(s); return isNaN(d) ? s : d.getFullYear()+'/'+p2(d.getMonth()+1)+'/'+p2(d.getDate()); } catch(e) { return s; } }
function p2(n) { return String(n).padStart(2, '0'); }
function yen(n) { return '\xA5' + Math.round(n).toLocaleString(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }
function dim(s) { return '<span style="color:var(--outline)">' + s + '</span>'; }
function pn(val, html) { return '<span class="' + (val >= 0 ? 'cell-profit-positive' : 'cell-profit-negative') + '">' + html + '</span>'; }
function q(s) { return '"' + (s || '').replace(/"/g, '""') + '"'; }
function today() { return new Date().toISOString().slice(0, 10); }
function downloadFile(name, content, type) {
  const b = new Blob([content], {type}); const u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u);
}
function copyText(el) {
  navigator.clipboard.writeText(el.dataset.copy).then(() => {
    el.style.background = 'var(--success-light)'; el.style.color = 'var(--success)';
    setTimeout(() => { el.style.background = ''; el.style.color = ''; }, 1000);
  });
}
function showToast(msg, type) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + (type === 'error' ? 'toast-error' : 'toast-success');
  t.textContent = msg; c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut 300ms ease-in forwards'; setTimeout(() => t.remove(), 300); }, 3000);
}

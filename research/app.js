// === リサーチツール ===
// Amazonセラーの商品一覧をKeepa APIで取得・管理するツール

'use strict';

// === 定数 ===
const STORAGE_KEYS = {
  sellers: 'sr_sellers',
  settings: 'sr_settings',
  activeSeller: 'sr_active',
  presets: 'sr_presets',
  monitors: 'sr_monitors',
};

// Keepa CSV_TYPE定数（利益計算ツールと同じ）
const CSV_TYPE = {
  AMAZON: 0, NEW: 1, SALES_RANK: 3,
  COUNT_NEW: 11, RATING: 16, COUNT_REVIEWS: 17,
  BUY_BOX: 18, COUNT_NEW_FBA: 34, COUNT_NEW_FBM: 35,
};

// テーブル列定義
const COLUMNS = [
  { id: 'image',        label: '画像',       w: '50px' },
  { id: 'title',        label: '商品名' },
  { id: 'asin',         label: 'ASIN',       w: '100px' },
  { id: 'currentPrice', label: '現在価格',   w: '80px',  sortKey: 'currentPrice' },
  { id: 'avgPrice',     label: '平均価格',   w: '80px',  sortKey: 'avg90BuyBoxPrice' },
  { id: 'rank',         label: 'ランキング', w: '80px',  sortKey: 'avg90SalesRank' },
  { id: 'sales',        label: '販売数/月',  w: '70px',  sortKey: 'monthlySold' },
  { id: 'sellers',      label: '出品者数',   w: '60px',  sortKey: 'avg90NewSellerCount' },
  { id: 'category',     label: 'カテゴリ',   w: '120px' },
  { id: 'rating',       label: '評価',       w: '50px',  sortKey: 'rating' },
  { id: 'actions',      label: '',           w: '50px' },
];

// === 状態変数 ===
let sellers = [];
let settings = { keepaApiKey: '' };
let activeSellerIdState = null;
let sortState = { key: null, dir: 'asc' };
let searchQuery = '';
let currentMode = 'seller';
let currentProducts = []; // 条件検索結果用
let presets = []; // 保存済み検索条件
let monitors = []; // URL監視リスト

// === ユーティリティ ===

// 数値フォーマット（カンマ区切り）
function formatNum(n) {
  if (n === null || n === undefined) return null;
  return Number(n).toLocaleString('ja-JP');
}

// 価格表示
function formatPrice(n) {
  if (n === null || n === undefined) return null;
  return '\u00a5' + formatNum(n);
}

// トースト表示
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 300ms ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ローディング表示/非表示
function showLoading(showOrText, text) {
  const el = document.getElementById('loadingOverlay');
  // 互換性: showLoading(text) の形式もサポート
  if (typeof showOrText === 'boolean') {
    el.classList.toggle('active', showOrText);
    if (text) document.getElementById('loadingText').textContent = text;
    else if (!showOrText) document.getElementById('loadingText').textContent = 'データを取得中...';
  } else {
    // 従来の showLoading(text) 形式
    document.getElementById('loadingText').textContent = showOrText || 'データを取得中...';
    el.classList.add('active');
  }
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
  document.getElementById('loadingText').textContent = 'データを取得中...';
}

// === localStorage操作 ===

function loadSellers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sellers);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSellers() {
  localStorage.setItem(STORAGE_KEYS.sellers, JSON.stringify(sellers));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    return raw ? JSON.parse(raw) : { keepaApiKey: '' };
  } catch { return { keepaApiKey: '' }; }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function loadActiveSeller() {
  return localStorage.getItem(STORAGE_KEYS.activeSeller) || null;
}

function saveActiveSeller(id) {
  if (id) {
    localStorage.setItem(STORAGE_KEYS.activeSeller, id);
  } else {
    localStorage.removeItem(STORAGE_KEYS.activeSeller);
  }
}

// === セラーID抽出 ===
function extractSellerId(input) {
  input = input.trim();
  // URLからの抽出パターン
  const patterns = [
    /[?&]seller=([A-Z0-9]+)/i,
    /[?&]me=([A-Z0-9]+)/i,
    /\/sp\?.*seller=([A-Z0-9]+)/i,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1].toUpperCase();
  }
  // 直接IDが入力された場合（英数字10-14文字）
  if (/^[A-Z0-9]{10,14}$/i.test(input)) return input.toUpperCase();
  return null;
}

// === Keepa API ===

// Keepa商品データのパース（利益計算ツールと同じロジック）
function parseKeepaProduct(product) {
  const stats = product.stats || {};
  const g = (obj, i) => (!obj || !Array.isArray(obj) || obj[i] === undefined || obj[i] === -1) ? null : obj[i];

  // 画像URL
  let imageUrl = null;
  if (product.images && product.images.length) {
    const f = product.images[0].l || product.images[0].m;
    if (f) imageUrl = 'https://m.media-amazon.com/images/I/' + f;
  }

  // カテゴリ
  let category = '';
  if (product.categoryTree && product.categoryTree.length) {
    category = product.categoryTree.map(c => c.name).join(' > ');
  }

  // 評価
  const ratingRaw = g(stats.current, CSV_TYPE.RATING);

  // サイズ
  let sizeCm = null;
  let h = product.packageHeight, l = product.packageLength, w = product.packageWidth;
  if (h <= 0 && l <= 0 && w <= 0) {
    h = product.itemHeight;
    l = product.itemLength;
    w = product.itemWidth;
  }
  if (h > 0 || l > 0 || w > 0) {
    const toCm = v => v > 0 ? (v / 10).toFixed(1) : '?';
    sizeCm = toCm(l) + 'x' + toCm(w) + 'x' + toCm(h);
  }

  // 重量
  const weightG = (product.packageWeight > 0) ? product.packageWeight : (product.itemWeight > 0 ? product.itemWeight : null);

  // 現在価格（BuyBox > New）
  const currentBuyBox = stats.buyBoxPrice > 0 ? stats.buyBoxPrice : g(stats.current, CSV_TYPE.BUY_BOX);
  const currentNew = g(stats.current, CSV_TYPE.NEW);
  const currentPrice = currentBuyBox || currentNew;

  return {
    asin: product.asin,
    title: product.title || '不明',
    imageUrl,
    currentPrice,
    avg90BuyBoxPrice: g(stats.avg90, CSV_TYPE.BUY_BOX) ?? g(stats.avg90, CSV_TYPE.NEW),
    avg90SalesRank: g(stats.avg90, CSV_TYPE.SALES_RANK),
    salesRankDrops90: stats.salesRankDrops90 ?? null,
    monthlySold: product.monthlySold > 0 ? product.monthlySold : null,
    avg90NewSellerCount: g(stats.avg90, CSV_TYPE.COUNT_NEW),
    category,
    brand: product.brand || '',
    rating: ratingRaw !== null ? ratingRaw / 10 : null,
    reviewCount: g(stats.current, CSV_TYPE.COUNT_REVIEWS),
    sizeCm,
    weightG,
    lastUpdated: new Date().toISOString(),
  };
}

// セラー情報とASINリスト取得
async function fetchSellerFromKeepa(sellerId) {
  const apiKey = settings.keepaApiKey;
  if (!apiKey) {
    showToast('Keepa APIキーが設定されていません。左下の「設定」からAPIキーを入力してください', 'error');
    return null;
  }

  const url = 'https://api.keepa.com/seller?key=' + apiKey + '&domain=5&seller=' + sellerId;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    showToast('Keepaからデータを取得できませんでした。しばらく待ってから再試行してください', 'error');
    return null;
  }

  // セラーデータは sellers オブジェクトのキーとして返される
  const sellerData = data.sellers && data.sellers[sellerId];
  if (!sellerData) {
    showToast('セラーが見つかりませんでした: ' + sellerId, 'error');
    return null;
  }

  const sellerName = sellerData.sellerName || sellerId;
  const asinList = sellerData.asinList || [];

  return { sellerName, asinList, tokensLeft: data.tokensLeft };
}

// 商品詳細をバッチ取得（100件ずつ）
async function fetchProductsBatch(asinList, onProgress) {
  const apiKey = settings.keepaApiKey;
  const products = [];
  const total = asinList.length;

  for (let i = 0; i < total; i += 100) {
    const batch = asinList.slice(i, i + 100);
    const url = 'https://api.keepa.com/product?key=' + apiKey + '&domain=5&asin=' + batch.join(',') + '&stats=90';

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        showToast('データの取得に失敗しました。時間をおいて再試行してください', 'error');
        break;
      }

      if (data.products) {
        data.products.forEach(p => {
          products.push(parseKeepaProduct(p));
        });
      }

      // 進捗コールバック
      if (onProgress) {
        onProgress(Math.min(i + 100, total), total);
      }

      // レート制限対策（最後のバッチは待たない）
      if (i + 100 < total) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      showToast('インターネット接続を確認してください。接続できている場合はしばらく待ってから再試行してください', 'error');
      break;
    }
  }

  return products;
}

// === セラー操作 ===

// セラー追加
function addSeller() {
  const input = document.getElementById('sellerIdInput');
  const rawValue = input.value.trim();
  if (!rawValue) {
    showToast('セラーIDまたはURLを入力してください', 'error');
    return;
  }

  const sellerId = extractSellerId(rawValue);
  if (!sellerId) {
    showToast('有効なセラーIDを取得できませんでした。セラーIDまたはセラーページのURLを入力してください。', 'error');
    return;
  }

  // 重複チェック
  if (sellers.find(s => s.id === sellerId)) {
    showToast('このセラーは既に登録されています', 'error');
    selectSeller(sellerId);
    input.value = '';
    return;
  }

  const newSeller = {
    id: sellerId,
    name: sellerId,  // 初期値はID（Keepa取得後に更新）
    addedAt: new Date().toISOString(),
    lastFetched: null,
    products: [],
  };

  sellers.push(newSeller);
  saveSellers();
  input.value = '';

  // セラー名をKeepaから取得（バックグラウンド）
  fetchSellerName(sellerId);

  selectSeller(sellerId);
  renderSidebar();
  showToast('セラーを追加しました: ' + sellerId);
}

// セラー名をKeepaから非同期取得
async function fetchSellerName(sellerId) {
  if (!settings.keepaApiKey) return;

  try {
    const result = await fetchSellerFromKeepa(sellerId);
    if (result && result.sellerName) {
      const seller = sellers.find(s => s.id === sellerId);
      if (seller) {
        seller.name = result.sellerName;
        saveSellers();
        renderSidebar();
        // アクティブセラーの場合はヘッダーも更新
        if (activeSellerIdState === sellerId) {
          renderMainHeader();
        }
      }
    }
  } catch (err) {
    // セラー名取得失敗は無視（IDを表示し続ける）
  }
}

// セラー選択
function selectSeller(sellerId) {
  activeSellerIdState = sellerId;
  saveActiveSeller(sellerId);
  sortState = { key: null, dir: 'asc' };
  searchQuery = '';
  const searchEl = document.getElementById('searchInput');
  if (searchEl) searchEl.value = '';
  renderSidebar();
  renderMainArea();
}

// セラー削除確認
function confirmDeleteSeller(sellerId, event) {
  if (event) {
    event.stopPropagation();
  }

  const seller = sellers.find(s => s.id === sellerId);
  if (!seller) return;

  const overlay = document.getElementById('confirmOverlay');
  const body = document.getElementById('confirmBody');
  document.getElementById('confirmTitle').textContent = 'セラー削除';

  body.innerHTML =
    '<p style="margin-bottom:16px;">セラー「' + escapeHtml(seller.name) + '」を削除しますか？</p>' +
    '<p style="font-size:12px;color:var(--on-surface-variant);margin-bottom:20px;">保存されている商品データも全て削除されます。</p>' +
    '<div class="modal-footer">' +
      '<button class="btn-secondary" onclick="closeConfirm()">キャンセル</button>' +
      '<button class="btn-danger" onclick="deleteSeller(\'' + sellerId + '\')">削除する</button>' +
    '</div>';

  overlay.classList.add('active');
}

// セラー削除
function deleteSeller(sellerId) {
  sellers = sellers.filter(s => s.id !== sellerId);
  saveSellers();

  if (activeSellerIdState === sellerId) {
    activeSellerIdState = sellers.length > 0 ? sellers[0].id : null;
    saveActiveSeller(activeSellerIdState);
  }

  closeConfirm();
  renderSidebar();
  renderMainArea();
  showToast('セラーを削除しました');
}

// 全商品取得
async function fetchSellerProducts() {
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (!seller) return;

  if (!settings.keepaApiKey) {
    showToast('Keepa APIキーが設定されていません。左下の「設定」からAPIキーを入力してください', 'error');
    openSettings();
    return;
  }

  showLoading('セラー情報を取得中...');

  try {
    // 1. セラー情報とASINリスト取得
    const sellerResult = await fetchSellerFromKeepa(seller.id);
    if (!sellerResult) {
      hideLoading();
      return;
    }

    // セラー名を更新
    seller.name = sellerResult.sellerName;
    const asinList = sellerResult.asinList;

    if (asinList.length === 0) {
      hideLoading();
      showToast('このセラーには商品が見つかりませんでした');
      saveSellers();
      renderSidebar();
      renderMainArea();
      return;
    }

    // 2. 商品詳細をバッチ取得
    document.getElementById('loadingText').textContent =
      '商品データを取得中... (0/' + asinList.length + ')';

    const products = await fetchProductsBatch(asinList, (done, total) => {
      document.getElementById('loadingText').textContent =
        '商品データを取得中... (' + done + '/' + total + ')';
    });

    // 3. 保存
    seller.products = products;
    seller.lastFetched = new Date().toISOString();
    saveSellers();

    hideLoading();
    renderSidebar();
    renderMainArea();
    showToast(products.length + '件の商品を取得しました');

  } catch (err) {
    hideLoading();
    showToast('データの取得に失敗しました。時間をおいて再試行してください', 'error');
  }
}

// 商品更新（既存データを再取得）
async function refreshSellerProducts() {
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (!seller || seller.products.length === 0) {
    showToast('取得済みの商品がありません。「全商品取得」を実行してください。', 'error');
    return;
  }

  if (!settings.keepaApiKey) {
    showToast('Keepa APIキーが設定されていません。左下の「設定」からAPIキーを入力してください', 'error');
    return;
  }

  const asinList = seller.products.map(p => p.asin);
  showLoading('商品データを更新中... (0/' + asinList.length + ')');

  try {
    const products = await fetchProductsBatch(asinList, (done, total) => {
      document.getElementById('loadingText').textContent =
        '商品データを更新中... (' + done + '/' + total + ')';
    });

    seller.products = products;
    seller.lastFetched = new Date().toISOString();
    saveSellers();

    hideLoading();
    renderMainArea();
    showToast(products.length + '件の商品を更新しました');

  } catch (err) {
    hideLoading();
    showToast('データの更新に失敗しました。時間をおいて再試行してください', 'error');
  }
}

// === HTMLエスケープ ===
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// === モード切り替え ===

// サイドバーのセラー検索/条件検索/監視モード切り替え
function switchMode(mode, btn) {
  currentMode = mode;
  document.querySelectorAll('.sidebar-mode-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('sellerPanel').style.display = mode === 'seller' ? '' : 'none';
  document.getElementById('monitorPanel').style.display = mode === 'monitor' ? '' : 'none';
  document.getElementById('criteriaPanel').style.display = mode === 'criteria' ? '' : 'none';
}

// === 条件検索 ===

// Keepa Product Finder APIを使った条件検索
async function searchByCriteria() {
  const apiKey = settings.keepaApiKey;
  if (!apiKey) {
    showToast('Keepa APIキーが設定されていません。左下の「設定」からAPIキーを入力してください', 'error');
    openSettings();
    return;
  }

  // 検索条件を収集
  const category = document.getElementById('criteriaCategory').value;
  const priceMin = document.getElementById('criteriaPriceMin').value;
  const priceMax = document.getElementById('criteriaPriceMax').value;
  const salesMin = document.getElementById('criteriaSalesMin').value;
  const salesMax = document.getElementById('criteriaSalesMax').value;
  const sellersMin = document.getElementById('criteriaSellersMin').value;
  const sellersMax = document.getElementById('criteriaSellersMax').value;
  const rankMax = document.getElementById('criteriaRankMax').value;
  const reviewsMin = document.getElementById('criteriaReviewsMin').value;
  const sort = document.getElementById('criteriaSort').value;

  // Keepa Product Finder の selection パラメータを構築
  const selection = {};

  if (category) selection.categoryIds = [parseInt(category)];
  // domain=5（日本）では価格は円単位でそのまま指定
  if (priceMin) selection.current_NEW_MIN = parseInt(priceMin);
  if (priceMax) selection.current_NEW_MAX = parseInt(priceMax);
  if (salesMin) selection.monthlySold_MIN = parseInt(salesMin);
  if (salesMax) selection.monthlySold_MAX = parseInt(salesMax);
  if (sellersMin) selection.current_COUNT_NEW_MIN = parseInt(sellersMin);
  if (sellersMax) selection.current_COUNT_NEW_MAX = parseInt(sellersMax);
  if (rankMax) selection.current_SALES_RANK_MAX = parseInt(rankMax);
  if (reviewsMin) selection.current_COUNT_REVIEWS_MIN = parseInt(reviewsMin);

  // ソート設定
  selection.sort = [[sort, 'asc']];
  selection.perPage = 50;
  selection.page = 0;

  showLoading(true, '条件検索中...');

  try {
    const url = 'https://api.keepa.com/query?key=' + encodeURIComponent(apiKey) + '&domain=5&selection=' + encodeURIComponent(JSON.stringify(selection));
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      hideLoading();
      showToast('Keepaからデータを取得できませんでした。APIキーが正しいか確認し、しばらく待ってから再試行してください', 'error');
      return;
    }

    const asinList = data.asinList || [];
    if (!asinList.length) {
      hideLoading();
      showToast('条件に一致する商品が見つかりませんでした', 'error');
      return;
    }

    showLoading(true, asinList.length + '件の商品データを取得中...');

    // 商品詳細を取得（100件ずつ）
    const products = await fetchProductsBatch(asinList, (done, total) => {
      document.getElementById('loadingText').textContent =
        '商品データを取得中... (' + done + '/' + total + ')';
    });

    hideLoading();

    // 結果を表示（セラーと同じテーブルを使い回す）
    document.getElementById('mainHeader').style.display = 'flex';
    document.getElementById('sellerTitle').textContent = '条件検索結果';
    document.getElementById('sellerProductCount').textContent = products.length + '件';
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('tableCard').style.display = 'block';

    // セラー選択状態をリセット（条件検索結果表示中）
    activeSellerIdState = null;
    saveActiveSeller(null);
    renderSidebar();

    // currentProductsに設定してテーブル描画
    currentProducts = products;
    sortState = { key: null, dir: 'asc' };
    searchQuery = '';
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = '';
    renderTable(products);

    showToast(products.length + '件の商品が見つかりました');
  } catch (err) {
    hideLoading();
    showToast('検索に失敗しました。条件を変えて再試行してください', 'error');
  }
}

// === プリセット管理 ===

function loadPresets() {
  try { presets = JSON.parse(localStorage.getItem(STORAGE_KEYS.presets)) || []; }
  catch { presets = []; }
}
function savePresets() { localStorage.setItem(STORAGE_KEYS.presets, JSON.stringify(presets)); }

// 現在の条件をプリセットとして保存
function saveCurrentCriteria() {
  const name = prompt('検索条件の名前を入力してください:');
  if (!name) return;

  const criteria = collectCriteria();
  presets.push({
    id: Date.now(),
    name: name,
    criteria: criteria,
    createdAt: new Date().toISOString(),
  });
  savePresets();
  renderPresetList();
  showToast('「' + name + '」を保存しました');
}

// フォームから検索条件を収集
function collectCriteria() {
  return {
    category: document.getElementById('criteriaCategory').value,
    priceMin: document.getElementById('criteriaPriceMin').value,
    priceMax: document.getElementById('criteriaPriceMax').value,
    salesMin: document.getElementById('criteriaSalesMin').value,
    salesMax: document.getElementById('criteriaSalesMax').value,
    sellersMin: document.getElementById('criteriaSellersMin').value,
    sellersMax: document.getElementById('criteriaSellersMax').value,
    rankMax: document.getElementById('criteriaRankMax').value,
    reviewsMin: document.getElementById('criteriaReviewsMin').value,
    sort: document.getElementById('criteriaSort').value,
  };
}

// プリセットをフォームに読み込んで検索実行
function loadPreset(presetId) {
  const preset = presets.find(p => p.id === presetId);
  if (!preset) return;
  const c = preset.criteria;
  document.getElementById('criteriaCategory').value = c.category || '';
  document.getElementById('criteriaPriceMin').value = c.priceMin || '';
  document.getElementById('criteriaPriceMax').value = c.priceMax || '';
  document.getElementById('criteriaSalesMin').value = c.salesMin || '';
  document.getElementById('criteriaSalesMax').value = c.salesMax || '';
  document.getElementById('criteriaSellersMin').value = c.sellersMin || '';
  document.getElementById('criteriaSellersMax').value = c.sellersMax || '';
  document.getElementById('criteriaRankMax').value = c.rankMax || '';
  document.getElementById('criteriaReviewsMin').value = c.reviewsMin || '';
  document.getElementById('criteriaSort').value = c.sort || 'current_SALES';
  searchByCriteria();
}

function deletePreset(presetId, event) {
  if (event) event.stopPropagation();
  if (!confirm('この検索条件を削除しますか？')) return;
  presets = presets.filter(p => p.id !== presetId);
  savePresets();
  renderPresetList();
  showToast('削除しました');
}

// プリセット一覧を描画
function renderPresetList() {
  const list = document.getElementById('presetList');
  if (!list) return;
  if (!presets.length) {
    list.innerHTML = '<div class="preset-empty">保存済みの条件はありません</div>';
    return;
  }
  list.innerHTML = presets.map(p => {
    const desc = buildPresetDesc(p.criteria);
    return '<div class="preset-item" onclick="loadPreset(' + p.id + ')" title="クリックで検索実行">' +
      '<div class="preset-name">' + escapeHtml(p.name) + '</div>' +
      '<div class="preset-desc">' + escapeHtml(desc) + '</div>' +
      '<button class="preset-delete" onclick="deletePreset(' + p.id + ', event)" title="削除">x</button>' +
      '</div>';
  }).join('');
}

// プリセットの条件を短い説明文にする
function buildPresetDesc(c) {
  const parts = [];
  if (c.category) {
    const opt = document.querySelector('#criteriaCategory option[value="' + c.category + '"]');
    if (opt) parts.push(opt.textContent);
  }
  if (c.priceMin || c.priceMax) parts.push('¥' + (c.priceMin || '0') + '-' + (c.priceMax || ''));
  if (c.salesMin) parts.push('月' + c.salesMin + '個+');
  if (c.sellersMax) parts.push('出品者' + c.sellersMax + '人以下');
  if (c.rankMax) parts.push('ランク' + Number(c.rankMax).toLocaleString() + '以内');
  return parts.join(' / ') || '条件なし';
}

// === 監視機能 ===

// Keepa Product Finder URLから条件をパース
function parseKeepaFinderUrl(input) {
  try {
    let jsonStr = '';
    // パターン1: 完全URL（https://keepa.com/#!finder/...）
    const m1 = input.match(/#!finder\/(.+)/);
    if (m1) jsonStr = m1[1];
    // パターン2: finder/から始まる部分URL
    if (!jsonStr) {
      const m2 = input.match(/^finder\/(.+)/);
      if (m2) jsonStr = m2[1];
    }
    // パターン3: URLエンコードされたJSON（{で始まる）
    if (!jsonStr) {
      const m3 = input.match(/%7B.+%7D/i);
      if (m3) jsonStr = m3[0];
    }
    // パターン4: 生のJSON
    if (!jsonStr && input.includes('{')) jsonStr = input;

    if (!jsonStr) return null;
    const decoded = decodeURIComponent(jsonStr);
    return JSON.parse(decoded);
  } catch { return null; }
}

// モニター追加
function addMonitor() {
  const input = document.getElementById('monitorUrlInput');
  const url = input.value.trim();
  if (!url) {
    showToast('Keepa Product FinderのURLを貼り付けてください', 'error');
    return;
  }

  const criteria = parseKeepaFinderUrl(url);
  if (!criteria) {
    showToast('URLの解析に失敗しました。Keepa Product Finderのページで条件を設定した後、ブラウザのURLをそのままコピーして貼り付けてください', 'error');
    return;
  }
  const name = prompt('この監視条件の名前を入力してください:');
  if (!name) return;

  monitors.push({
    id: Date.now(),
    name: name,
    url: url,
    criteria: criteria,
    lastResults: [],
    lastProducts: [],
    lastFetched: null,
    history: [],
  });
  saveMonitors();
  input.value = '';
  renderMonitorList();
  showToast('「' + name + '」を追加しました');
}

// モニター選択・表示
function selectMonitor(monitorId) {
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor) return;

  activeSellerIdState = null;
  saveActiveSeller(null);
  renderSidebar();

  // メインエリアにモニター結果を表示
  document.getElementById('mainHeader').style.display = 'flex';
  document.getElementById('sellerTitle').textContent = monitor.name;
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('tableCard').style.display = 'block';

  if (monitor.lastProducts.length > 0) {
    document.getElementById('sellerProductCount').textContent = monitor.lastProducts.length + '件';
    currentProducts = monitor.lastProducts;
    renderTable(currentProducts);
  } else {
    document.getElementById('sellerProductCount').textContent = '未取得';
    document.getElementById('tableCard').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('emptyState').innerHTML =
      '<span class="material-symbols-outlined empty-icon">update</span>' +
      '<h3>まだデータがありません</h3>' +
      '<p>「最新データ取得」ボタンでデータを取得してください</p>';
  }

  // fetchBtnのonclickを監視更新に変更
  const fetchBtn = document.getElementById('fetchBtn');
  fetchBtn.onclick = () => updateMonitor(monitorId);
  fetchBtn.innerHTML = '<span class="material-symbols-outlined">sync</span> 最新データ取得';

  // 更新ボタンも同じ
  const refreshBtn = document.querySelector('.btn-fetch-secondary');
  if (refreshBtn) {
    refreshBtn.onclick = () => updateMonitor(monitorId);
  }

  // 監視アイテムをアクティブに
  document.querySelectorAll('.monitor-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector('.monitor-item[data-id="' + monitorId + '"]');
  if (activeEl) activeEl.classList.add('active');
}

// モニター更新（Product FinderのURL条件でKeepa APIを呼ぶ）
async function updateMonitor(monitorId) {
  const monitor = monitors.find(m => m.id === monitorId);
  if (!monitor) return;

  const apiKey = settings.keepaApiKey;
  if (!apiKey) {
    showToast('Keepa APIキーが設定されていません。左下の「設定」からAPIキーを入力してください', 'error');
    openSettings();
    return;
  }

  showLoading(true, '「' + monitor.name + '」を検索中...');

  try {
    // Keepa Product Finder APIで検索
    const selection = buildSelectionFromCriteria(monitor.criteria);
    selection.perPage = 100;
    selection.page = 0;

    const url = 'https://api.keepa.com/query?key=' + encodeURIComponent(apiKey) +
                '&domain=5&selection=' + encodeURIComponent(JSON.stringify(selection));
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      hideLoading();
      showToast('Keepaからデータを取得できませんでした。APIキーが正しいか確認し、しばらく待ってから再試行してください', 'error');
      return;
    }

    const newAsinList = data.asinList || [];
    if (!newAsinList.length) {
      hideLoading();
      showToast('条件に一致する商品が見つかりませんでした', 'error');
      return;
    }

    showLoading(true, newAsinList.length + '件の商品データを取得中...');

    // 商品詳細を取得
    const products = await fetchProductsBatch(newAsinList, (done, total) => {
      document.getElementById('loadingText').textContent =
        '商品データを取得中... (' + done + '/' + total + ')';
    });

    hideLoading();

    // 前回の結果と比較
    const prevAsins = new Set(monitor.lastResults);
    const newAsins = new Set(newAsinList);

    const brandNew = newAsinList.filter(a => !prevAsins.has(a));    // 新規
    const still = newAsinList.filter(a => prevAsins.has(a));        // 継続
    const disappeared = monitor.lastResults.filter(a => !newAsins.has(a)); // 消えた

    // 商品にステータスを付与
    products.forEach(p => {
      if (brandNew.includes(p.asin)) p._status = 'new';
      else p._status = 'existing';
    });

    // 消えた商品は前回のデータから取得
    const disappearedProducts = (monitor.lastProducts || [])
      .filter(p => disappeared.includes(p.asin))
      .map(p => ({ ...p, _status: 'disappeared' }));

    // 全商品を結合（新規 → 継続 → 消えた の順）
    const allProducts = [
      ...products.filter(p => p._status === 'new'),
      ...products.filter(p => p._status === 'existing'),
      ...disappearedProducts,
    ];

    // モニターデータを更新
    monitor.lastResults = newAsinList;
    monitor.lastProducts = products;
    monitor.lastFetched = new Date().toISOString();
    monitor.history.push({ date: new Date().toISOString().slice(0, 10), asins: newAsinList });
    // 履歴は30日分まで保持
    if (monitor.history.length > 30) monitor.history = monitor.history.slice(-30);
    saveMonitors();

    // 結果表示
    currentProducts = allProducts;
    document.getElementById('sellerTitle').textContent = monitor.name;

    // 差分サマリー表示
    let summaryText = allProducts.length + '件';
    if (monitor.history.length > 1) {
      summaryText += ' (';
      if (brandNew.length) summaryText += '新規' + brandNew.length + '件 ';
      if (disappeared.length) summaryText += '消えた' + disappeared.length + '件';
      summaryText += ')';
    }
    document.getElementById('sellerProductCount').textContent = summaryText;

    renderTable(allProducts);
    renderMonitorList();

    if (brandNew.length || disappeared.length) {
      showToast('新規' + brandNew.length + '件、消えた' + disappeared.length + '件');
    } else {
      showToast(products.length + '件取得しました（変動なし）');
    }

  } catch(err) {
    hideLoading();
    showToast('データの更新に失敗しました。時間をおいて再試行してください', 'error');
  }
}

// Keepa URLの条件をAPI用selectionに変換
function buildSelectionFromCriteria(criteria) {
  const selection = {};
  if (!criteria || !criteria.f) return selection;

  const f = criteria.f;

  // productType
  if (f.productType && f.productType.values) {
    selection.productType = f.productType.values.map(Number);
  }

  // 各フィルター（数値型）
  Object.keys(f).forEach(key => {
    const filter = f[key];
    if (filter.filterType === 'number') {
      if (filter.type === 'inRange') {
        selection[key + '_MIN'] = filter.filter;
        selection[key + '_MAX'] = filter.filterTo;
      } else if (filter.type === 'greaterThan' || filter.type === 'greaterThanOrEqual') {
        selection[key + '_MIN'] = filter.filter;
      } else if (filter.type === 'lessThan' || filter.type === 'lessThanOrEqual') {
        selection[key + '_MAX'] = filter.filter;
      }
    }
  });

  // ソート
  if (criteria.s && Array.isArray(criteria.s)) {
    selection.sort = criteria.s.map(s => [s.colId, s.sort || 'asc']);
  }

  return selection;
}

// モニター削除
function deleteMonitor(monitorId, event) {
  if (event) event.stopPropagation();
  if (!confirm('この監視条件を削除しますか？')) return;
  monitors = monitors.filter(m => m.id !== monitorId);
  saveMonitors();
  renderMonitorList();
  showToast('削除しました');
}

// モニターリスト描画
function renderMonitorList() {
  const list = document.getElementById('monitorList');
  if (!list) return;
  if (!monitors.length) {
    list.innerHTML = '<div class="sidebar-empty">Keepa Product FinderのURLを貼り付けて追加してください</div>';
    return;
  }
  list.innerHTML = monitors.map(m => {
    const fetchedText = m.lastFetched ? new Date(m.lastFetched).toLocaleDateString('ja-JP') + ' 取得' : '未取得';
    const count = m.lastResults ? m.lastResults.length + '件' : '';
    return '<div class="monitor-item seller-item" data-id="' + m.id + '" onclick="selectMonitor(' + m.id + ')">' +
      '<div class="seller-item-info">' +
        '<div class="seller-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="seller-meta">' + count + ' ' + fetchedText + '</div>' +
      '</div>' +
      '<button class="seller-delete-btn" onclick="deleteMonitor(' + m.id + ', event)" title="削除">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  }).join('');
}

// モニター保存・読み込み
function loadMonitors() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.monitors)) || []; }
  catch { return []; }
}
function saveMonitors() { localStorage.setItem(STORAGE_KEYS.monitors, JSON.stringify(monitors)); }

// === 描画 ===

// サイドバー描画
function renderSidebar() {
  const list = document.getElementById('sellerList');
  if (sellers.length === 0) {
    list.innerHTML = '<div style="padding:20px 16px;text-align:center;color:var(--on-surface-variant);font-size:12px;">セラーが登録されていません</div>';
    return;
  }

  list.innerHTML = sellers.map(s => {
    const isActive = s.id === activeSellerIdState;
    const productCount = s.products.length;
    const metaText = productCount > 0 ? productCount + '件' : '未取得';

    return '<div class="seller-item' + (isActive ? ' active' : '') + '" onclick="selectSeller(\'' + s.id + '\')">' +
      '<div class="seller-item-info">' +
        '<div class="seller-name">' + escapeHtml(s.name) + '</div>' +
        '<div class="seller-meta">' + s.id + ' / ' + metaText + '</div>' +
      '</div>' +
      '<button class="seller-delete-btn" onclick="confirmDeleteSeller(\'' + s.id + '\', event)" title="削除">' +
        '<span class="material-symbols-outlined">close</span>' +
      '</button>' +
    '</div>';
  }).join('');
}

// メインヘッダー描画
function renderMainHeader() {
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (!seller) return;

  document.getElementById('sellerTitle').textContent = seller.name;
  const count = seller.products.length;
  document.getElementById('sellerProductCount').textContent =
    count > 0 ? count + '件' : '未取得';
}

// メインエリア全体描画
function renderMainArea() {
  const header = document.getElementById('mainHeader');
  const empty = document.getElementById('emptyState');
  const tableCard = document.getElementById('tableCard');

  if (!activeSellerIdState) {
    // 条件検索・監視の結果が表示中の場合はそのまま維持
    if (currentProducts.length > 0 && (currentMode === 'criteria' || currentMode === 'monitor')) return;
    // セラー未選択
    header.style.display = 'none';
    empty.style.display = 'flex';
    tableCard.style.display = 'none';
    empty.innerHTML =
      '<span class="material-symbols-outlined empty-icon">search</span>' +
      '<h3>リサーチを始めましょう</h3>' +
      '<p>左のサイドバーからセラー検索または条件検索でリサーチできます</p>';
    return;
  }

  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (!seller) {
    activeSellerIdState = null;
    saveActiveSeller(null);
    renderMainArea();
    return;
  }

  header.style.display = 'flex';
  renderMainHeader();

  if (seller.products.length === 0) {
    // 商品未取得
    empty.style.display = 'flex';
    tableCard.style.display = 'none';
    empty.innerHTML =
      '<span class="material-symbols-outlined empty-icon">inventory_2</span>' +
      '<h3>商品がまだ取得されていません</h3>' +
      '<p>「全商品取得」ボタンをクリックしてKeepaからデータを取得してください</p>';
    return;
  }

  // 商品テーブル表示
  empty.style.display = 'none';
  tableCard.style.display = 'block';
  renderTable(seller.products);
}

// テーブル描画
function renderTable(products) {
  // フィルタリング
  let filtered = products;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = products.filter(p =>
      (p.title && p.title.toLowerCase().includes(q)) ||
      (p.asin && p.asin.toLowerCase().includes(q)) ||
      (p.brand && p.brand.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q))
    );
  }

  // ソート
  if (sortState.key) {
    filtered = [...filtered].sort((a, b) => {
      const av = a[sortState.key];
      const bv = b[sortState.key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortState.dir === 'asc' ? cmp : -cmp;
    });
  }

  // ヘッダー描画
  const thead = document.getElementById('productTableHead');
  thead.innerHTML = '<tr>' + COLUMNS.map(col => {
    const widthAttr = col.w ? ' style="width:' + col.w + '"' : '';
    if (col.sortKey) {
      const sortClass = sortState.key === col.sortKey
        ? (sortState.dir === 'asc' ? ' sorted-asc' : ' sorted-desc')
        : '';
      const sortIconText = sortState.key === col.sortKey
        ? (sortState.dir === 'asc' ? 'arrow_upward' : 'arrow_downward')
        : 'unfold_more';
      return '<th class="sortable' + sortClass + '" onclick="toggleSort(\'' + col.sortKey + '\')"' + widthAttr + '>' +
        col.label + ' <span class="material-symbols-outlined sort-icon">' + sortIconText + '</span></th>';
    }
    return '<th' + widthAttr + '>' + col.label + '</th>';
  }).join('') + '</tr>';

  // ボディ描画
  const tbody = document.getElementById('productTableBody');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="' + COLUMNS.length + '" style="text-align:center;padding:40px;color:var(--on-surface-variant);">該当する商品がありません</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    // 監視モード: ステータスに応じた行クラス
    const rowClass = p._status === 'new' ? ' class="row-new"' : p._status === 'disappeared' ? ' class="row-disappeared"' : '';
    return '<tr' + rowClass + '>' +
      // 画像
      '<td class="col-image">' + renderImageCell(p) + '</td>' +
      // 商品名
      '<td class="col-title"><a class="product-name" href="https://www.amazon.co.jp/dp/' + p.asin + '" target="_blank" rel="noopener" title="' + escapeHtml(p.title) + '">' + escapeHtml(p.title) + '</a></td>' +
      // ASIN
      '<td class="col-asin"><span class="asin-copy" onclick="copyAsin(\'' + p.asin + '\', this)" title="クリックでコピー">' + p.asin + '</span></td>' +
      // 現在価格
      '<td class="col-price"><span class="cell-price">' + (formatPrice(p.currentPrice) || '<span class="cell-null">--</span>') + '</span></td>' +
      // 平均価格
      '<td class="col-price"><span class="cell-price">' + (formatPrice(p.avg90BuyBoxPrice) || '<span class="cell-null">--</span>') + '</span></td>' +
      // ランキング
      '<td class="col-rank"><span class="cell-rank">' + (p.avg90SalesRank ? formatNum(p.avg90SalesRank) : '<span class="cell-null">--</span>') + '</span></td>' +
      // 販売数/月
      '<td class="col-sales"><span class="cell-number">' + (p.monthlySold !== null ? formatNum(p.monthlySold) : '<span class="cell-null">--</span>') + '</span></td>' +
      // 出品者数
      '<td class="col-sellers"><span class="cell-number">' + (p.avg90NewSellerCount !== null ? formatNum(p.avg90NewSellerCount) : '<span class="cell-null">--</span>') + '</span></td>' +
      // カテゴリ
      '<td class="col-category"><span class="cell-category" title="' + escapeHtml(p.category) + '">' + escapeHtml(truncateCategory(p.category)) + '</span></td>' +
      // 評価
      '<td class="col-rating">' + renderRatingCell(p) + '</td>' +
      // アクション
      '<td class="col-actions"><div class="action-btns">' +
        '<button class="btn-icon" onclick="copyAsin(\'' + p.asin + '\', null)" title="ASINコピー"><span class="material-symbols-outlined">content_copy</span></button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

// 画像セル描画
function renderImageCell(product) {
  if (product.imageUrl) {
    return '<img class="product-thumb" src="' + product.imageUrl + '" alt="" loading="lazy" onclick="openDetailModal(\'' + product.asin + '\')">';
  }
  return '<div class="product-thumb-placeholder" onclick="openDetailModal(\'' + product.asin + '\')"><span class="material-symbols-outlined">image</span></div>';
}

// 評価セル描画
function renderRatingCell(product) {
  if (product.rating === null) return '<span class="cell-null">--</span>';
  return '<span class="cell-rating"><span class="material-symbols-outlined">star</span>' + product.rating.toFixed(1) + '</span>';
}

// カテゴリ省略表示
function truncateCategory(cat) {
  if (!cat) return '';
  const parts = cat.split(' > ');
  if (parts.length <= 2) return cat;
  return parts[0] + ' > ... > ' + parts[parts.length - 1];
}

// === ソート ===
function toggleSort(key) {
  if (sortState.key === key) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = key;
    sortState.dir = 'asc';
  }
  // セラー選択中はセラーの商品、条件検索結果がある場合はそちらを使う
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (seller) {
    renderTable(seller.products);
  } else if (currentProducts.length > 0) {
    renderTable(currentProducts);
  }
}

// === ASINコピー ===
function copyAsin(asin, el) {
  navigator.clipboard.writeText(asin).then(() => {
    showToast('コピーしました: ' + asin);
    if (el) {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1500);
    }
  }).catch(() => {
    showToast('コピーに失敗しました', 'error');
  });
}

// === 検索 ===
function handleSearch(e) {
  searchQuery = e.target.value.trim();
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (seller && seller.products.length > 0) {
    renderTable(seller.products);
  } else if (currentProducts.length > 0) {
    renderTable(currentProducts);
  }
}

// === 商品詳細モーダル ===
function openDetailModal(asin) {
  // セラーの商品または条件検索結果から商品を探す
  let product = null;
  const seller = sellers.find(s => s.id === activeSellerIdState);
  if (seller) {
    product = seller.products.find(p => p.asin === asin);
  } else if (currentProducts.length > 0) {
    product = currentProducts.find(p => p.asin === asin);
  }
  if (!product) return;

  const overlay = document.getElementById('detailOverlay');
  document.getElementById('detailTitle').textContent = '商品詳細';
  const body = document.getElementById('detailBody');

  body.innerHTML =
    // 上部：画像と基本情報
    '<div class="detail-top">' +
      (product.imageUrl
        ? '<img class="detail-image" src="' + product.imageUrl + '" alt="">'
        : '<div class="detail-image" style="display:flex;align-items:center;justify-content:center;"><span class="material-symbols-outlined" style="font-size:48px;color:var(--outline);">image</span></div>'
      ) +
      '<div class="detail-info">' +
        '<h3>' + escapeHtml(product.title) + '</h3>' +
        '<div class="detail-meta">' +
          '<span class="detail-tag">ASIN: ' + product.asin + '</span>' +
          (product.brand ? '<span class="detail-tag">' + escapeHtml(product.brand) + '</span>' : '') +
          '<a class="detail-tag" href="https://www.amazon.co.jp/dp/' + product.asin + '" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none;">Amazon</a>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // 価格情報
    '<div class="detail-section-title">価格情報</div>' +
    '<div class="detail-grid">' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">現在価格</div>' +
        '<div class="detail-item-value price">' + (formatPrice(product.currentPrice) || '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">90日平均価格</div>' +
        '<div class="detail-item-value price">' + (formatPrice(product.avg90BuyBoxPrice) || '--') + '</div>' +
      '</div>' +
    '</div>' +

    // 販売データ
    '<div class="detail-section-title">販売データ</div>' +
    '<div class="detail-grid">' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">90日平均ランキング</div>' +
        '<div class="detail-item-value">' + (product.avg90SalesRank ? formatNum(product.avg90SalesRank) : '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">月間販売数</div>' +
        '<div class="detail-item-value">' + (product.monthlySold !== null ? formatNum(product.monthlySold) + '個' : '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">90日ランク下降回数</div>' +
        '<div class="detail-item-value">' + (product.salesRankDrops90 !== null ? formatNum(product.salesRankDrops90) + '回' : '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">出品者数 (90日平均)</div>' +
        '<div class="detail-item-value">' + (product.avg90NewSellerCount !== null ? formatNum(product.avg90NewSellerCount) + '人' : '--') + '</div>' +
      '</div>' +
    '</div>' +

    // 商品情報
    '<div class="detail-section-title">商品情報</div>' +
    '<div class="detail-grid">' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">カテゴリ</div>' +
        '<div class="detail-item-value" style="font-size:13px;font-weight:500;">' + (escapeHtml(product.category) || '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">評価</div>' +
        '<div class="detail-item-value">' +
          (product.rating !== null ? product.rating.toFixed(1) + ' / 5.0' : '--') +
          (product.reviewCount !== null ? ' <span style="font-size:12px;font-weight:400;color:var(--on-surface-variant);">(' + formatNum(product.reviewCount) + '件)</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">サイズ (cm)</div>' +
        '<div class="detail-item-value" style="font-size:14px;">' + (product.sizeCm || '--') + '</div>' +
      '</div>' +
      '<div class="detail-item">' +
        '<div class="detail-item-label">重量</div>' +
        '<div class="detail-item-value" style="font-size:14px;">' + (product.weightG !== null ? product.weightG + 'g' : '--') + '</div>' +
      '</div>' +
    '</div>';

  overlay.classList.add('active');
}

function closeDetailModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('detailOverlay').classList.remove('active');
}

// === CSVインポート ===

// CSVインポートダイアログを開く
function openCsvImport() {
  document.getElementById('csvFileInput').click();
}

// CSVファイルを読み込んで商品データに変換
function handleCsvFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const csv = e.target.result;
      const products = parseCsvToProducts(csv);
      if (!products.length) {
        showToast('CSVから商品データを取得できませんでした', 'error');
        return;
      }

      // 現在選択中のセラーに商品を設定
      if (activeSellerIdState) {
        const seller = sellers.find(s => s.id === activeSellerIdState);
        if (seller) {
          seller.products = products;
          seller.lastFetched = new Date().toISOString();
          saveSellers();
          renderMainArea();
          renderSidebar();
          showToast(products.length + '件の商品をインポートしました');
          return;
        }
      }

      // セラー未選択の場合は検索結果として表示
      currentProducts = products;
      document.getElementById('mainHeader').style.display = 'flex';
      document.getElementById('sellerTitle').textContent = 'CSVインポート';
      document.getElementById('sellerProductCount').textContent = products.length + '件';
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('tableCard').style.display = 'block';
      renderTable(products);
      showToast(products.length + '件の商品をインポートしました');
    } catch (err) {
      showToast('CSVファイルの読み込みに失敗しました。ファイルの形式を確認してください', 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// KeepaエクスポートCSVをパース
function parseCsvToProducts(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return [];

  // ヘッダー行を解析（タブ区切りまたはカンマ区切り）
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map(h => h.replace(/^"|"$/g, '').trim());

  // ヘッダー名からインデックスを特定（Keepaの英語ヘッダーに対応）
  const colMap = {};
  headers.forEach((h, i) => {
    const lower = h.toLowerCase();
    if (lower.includes('asin')) colMap.asin = i;
    else if (lower === 'title' || lower.includes('product name') || lower === 'locale') colMap.title = i;
    else if (lower.includes('sales rank') && lower.includes('current')) colMap.salesRankCurrent = i;
    else if (lower.includes('sales rank') && lower.includes('avg')) colMap.salesRankAvg = i;
    else if (lower.includes('buy box') && lower.includes('current')) colMap.buyBoxCurrent = i;
    else if (lower.includes('new') && lower.includes('current') && !lower.includes('count')) colMap.newPriceCurrent = i;
    else if (lower.includes('new') && lower.includes('count') && lower.includes('current')) colMap.newSellerCount = i;
    else if (lower.includes('count of') && lower.includes('new')) colMap.newSellerCount = i;
    else if (lower.includes('category')) colMap.category = i;
    else if (lower.includes('brand')) colMap.brand = i;
    else if (lower.includes('rating')) colMap.rating = i;
    else if (lower.includes('review') && lower.includes('count')) colMap.reviewCount = i;
    else if (lower.includes('monthly sold') || lower.includes('bought')) colMap.monthlySold = i;
    else if (lower.includes('drops') && lower.includes('90')) colMap.salesRankDrops90 = i;
    else if (lower.includes('image')) colMap.image = i;
    else if (lower.includes('title')) colMap.title = i;
  });

  if (colMap.asin === undefined) {
    // ASINカラムが見つからない場合、最初のカラムを試す
    colMap.asin = 0;
  }

  const products = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map(c => c.replace(/^"|"$/g, '').trim());
    const asin = cols[colMap.asin];
    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) continue;

    const parseNum = (idx) => {
      if (idx === undefined || !cols[idx]) return null;
      const n = parseFloat(cols[idx].replace(/[,¥$€£]/g, ''));
      return isNaN(n) ? null : Math.round(n);
    };

    products.push({
      asin: asin.toUpperCase(),
      title: cols[colMap.title] || '',
      imageUrl: cols[colMap.image] || null,
      currentPrice: parseNum(colMap.buyBoxCurrent) || parseNum(colMap.newPriceCurrent),
      avg90BuyBoxPrice: null,
      avg90SalesRank: parseNum(colMap.salesRankAvg),
      salesRankDrops90: parseNum(colMap.salesRankDrops90),
      monthlySold: parseNum(colMap.monthlySold),
      avg90NewSellerCount: parseNum(colMap.newSellerCount),
      category: cols[colMap.category] || '',
      brand: cols[colMap.brand] || '',
      rating: colMap.rating !== undefined ? parseFloat(cols[colMap.rating]) || null : null,
      reviewCount: parseNum(colMap.reviewCount),
      sizeCm: null,
      weightG: null,
      lastUpdated: new Date().toISOString(),
    });
  }
  return products;
}

// === 設定モーダル ===
function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  const body = document.getElementById('settingsBody');

  const maskedKey = settings.keepaApiKey
    ? settings.keepaApiKey.substring(0, 6) + '...' + settings.keepaApiKey.substring(settings.keepaApiKey.length - 4)
    : '未設定';

  body.innerHTML =
    '<div class="settings-section">' +
      '<div class="settings-label">Keepa APIキー</div>' +
      '<div class="settings-desc">' +
        '<a href="https://keepa.com/#!api" target="_blank" rel="noopener">Keepa</a>のAPIキーを設定してください。セラー情報や商品データの取得に必要です。' +
      '</div>' +
      '<div class="field-group">' +
        '<label>APIキー</label>' +
        '<input type="text" id="settingsApiKey" value="' + escapeHtml(settings.keepaApiKey) + '" placeholder="Keepa APIキーを入力" spellcheck="false" autocomplete="off">' +
      '</div>' +
      '<div class="settings-current">' +
        '<span class="settings-current-label">現在の設定:</span>' +
        '<span class="settings-current-value">' + maskedKey + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button class="btn-secondary" onclick="closeSettings()">キャンセル</button>' +
      '<button class="btn-primary" onclick="saveSettingsFromModal()">保存</button>' +
    '</div>';

  overlay.classList.add('active');
}

function saveSettingsFromModal() {
  const apiKey = document.getElementById('settingsApiKey').value.trim();
  settings.keepaApiKey = apiKey;
  saveSettings();
  closeSettings();
  showToast('設定を保存しました');
}

function closeSettings(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('settingsOverlay').classList.remove('active');
}

// === 確認モーダル ===
function closeConfirm(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('confirmOverlay').classList.remove('active');
}

// === 初回ユーザー向けガイド ===
function showOnboarding() {
  // APIキーが設定済みなら表示しない
  if (settings && settings.keepaApiKey) return;
  // 既にガイドを見た場合も表示しない
  if (localStorage.getItem('sedori_research_onboarding_done')) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:520px;">
      <div class="modal-header">
        <h2 class="modal-title">はじめに</h2>
      </div>
      <div class="modal-body" style="padding:24px;">
        <h3 style="margin:0 0 16px;font-size:16px;">セラーリサーチツールへようこそ</h3>
        <p style="margin:0 0 12px;line-height:1.7;font-size:14px;">
          このツールを使うには <strong>Keepa APIキー</strong> が必要です。
        </p>
        <div style="background:#f0f4ff;border-radius:12px;padding:16px;margin:0 0 16px;">
          <p style="margin:0 0 8px;font-weight:500;font-size:14px;">APIキーの取得方法:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.8;">
            <li><a href="https://keepa.com/#!api" target="_blank" rel="noopener" style="color:#1a73e8;">Keepa.com</a> にアクセスしてアカウントを作成</li>
            <li>ログイン後、APIページでキーを取得</li>
            <li>左下の「設定」ボタンからAPIキーを貼り付けて保存</li>
          </ol>
        </div>
        <div style="background:#f0fdf4;border-radius:12px;padding:16px;margin:0 0 20px;">
          <p style="margin:0 0 8px;font-weight:500;font-size:14px;">基本的な使い方:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.8;">
            <li>左のサイドバーの「セラー」タブでセラーIDまたはURLを入力</li>
            <li>「全商品取得」でそのセラーの商品一覧を取得</li>
            <li>「監視」タブでKeepa Product FinderのURLを登録して条件監視</li>
            <li>上部の「利益管理」タブで商品の利益計算もできます</li>
          </ol>
        </div>
        <p style="margin:0 0 16px;font-size:12px;color:#666;line-height:1.6;">
          <strong>セラーIDの探し方:</strong> Amazonの商品ページで出品者名をクリック → URLの中の「seller=」の後の英数字がセラーIDです。
        </p>
        <button onclick="localStorage.setItem('sedori_research_onboarding_done','1');this.closest('.modal-overlay').remove();"
          style="width:100%;padding:12px;background:#1a73e8;color:white;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;">
          始める
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// === 初期化 ===
document.addEventListener('DOMContentLoaded', () => {
  // データ読み込み
  sellers = loadSellers();
  settings = loadSettings();
  activeSellerIdState = loadActiveSeller();
  loadPresets();
  monitors = loadMonitors();

  // アクティブセラーが存在しない場合はリセット
  if (activeSellerIdState && !sellers.find(s => s.id === activeSellerIdState)) {
    activeSellerIdState = sellers.length > 0 ? sellers[0].id : null;
    saveActiveSeller(activeSellerIdState);
  }

  // イベントリスナー
  document.getElementById('sellerIdInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSeller();
  });

  document.getElementById('monitorUrlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMonitor();
  });

  document.getElementById('searchInput').addEventListener('input', handleSearch);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeDetailModal();
      closeSettings();
      closeConfirm();
    }
  });

  // 初期描画
  renderSidebar();
  renderPresetList();
  renderMonitorList();
  renderMainArea();

  // 初回ユーザー向けガイド表示
  showOnboarding();
});

/**
 * Distribuciones Castro - Admin Portal - Logic & Synchronizer
 */

// Global State
let state = {
  products: [],
  clients: [],
  discounts: [],
  cabysMap: {},
  images: {},
  vendedores: [],
  vendorData: {}, // VEN -> {products, clients, discounts, cabysMap} crudos
  vendorClients: {}, // VEN -> [clientes de su ruta]
  vendorCounts: {},  // VEN -> {products, clients, discounts, cabys, ok}
  maestros: { proveedores: {}, categorias: {} },
  companyName: "",
  brandLogo: "",
  devWhatsapp: localStorage.getItem('ecomdx_dev_whatsapp') || '',
  sheetsUrl: localStorage.getItem('ecomdx_sheets_url') || '',
  activeTab: 'welcome',
  photoFilter: 'all', // 'all', 'with-photo', 'without-photo'
  photoSearch: '',
  photoPage: 1,
  pageSize: 20,
  clientCatalogConfigs: {},
  selectedClientCatalogSeller: ''
};

// =============================================================
// ALMACENAMIENTO PERSISTENTE (INDEXEDDB - SIN LÍMITE DE 5MB)
// =============================================================
const IDB_NAME = 'ecomdx_admin_db';
const IDB_VERSION = 1;
const IDB_STORE = 'catalog_cache';

function openAdminDb() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.indexedDB) return resolve(null);
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

async function idbGet(key) {
  try {
    const db = await openAdminDb();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await openAdminDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch (e) {
    return false;
  }
}

async function idbDelete(key) {
  try {
    const db = await openAdminDb();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch (e) {
    return false;
  }
}

// Links privados de descarga: NO van quemados en código.
// Se cargan desde Google Sheet (pestaña Descargas) o caché local del equipo.
// Genéricos: products, clients, discounts, cabys.
// Por vendedor: vendors = {VEN: {products, clients, discounts, cabys}}
let API_ENDPOINTS = {
  products: "",
  clients: "",
  discounts: "",
  cabys: ""
};
let VENDOR_ENDPOINTS = {};

function getDownloadLinksCache() {
  try {
    const raw = localStorage.getItem('ecomdx_download_links');
    if (raw) {
      const j = JSON.parse(raw);
      return {
        products: String(j.products || "").trim(),
        clients: String(j.clients || "").trim(),
        discounts: String(j.discounts || "").trim(),
        cabys: String(j.cabys || "").trim(),
        vendors: (j.vendors && typeof j.vendors === "object") ? j.vendors : {}
      };
    }
  } catch (e) {}
  return { products: "", clients: "", discounts: "", cabys: "", vendors: {} };
}

function setDownloadLinksCache(links) {
  API_ENDPOINTS = {
    products: String(links.products || "").trim(),
    clients: String(links.clients || "").trim(),
    discounts: String(links.discounts || "").trim(),
    cabys: String(links.cabys || "").trim()
  };
  VENDOR_ENDPOINTS = (links.vendors && typeof links.vendors === "object") ? links.vendors : {};
  try {
    localStorage.setItem('ecomdx_download_links', JSON.stringify({ ...API_ENDPOINTS, vendors: VENDOR_ENDPOINTS }));
  } catch (e) {}
  updateDownloadLinksUI();
}

function getVendorCodes() {
  const fromSellers = (state.vendedores || []).map(v => String(v.codigo || "").trim().toUpperCase()).filter(Boolean);
  const fromLinks = Object.keys(VENDOR_ENDPOINTS || {}).map(k => String(k).trim().toUpperCase()).filter(Boolean);
  const all = {};
  fromSellers.concat(fromLinks).forEach(c => { all[c] = true; });
  return Object.keys(all).sort();
}

// Service Worker para modo 100% offline (solo en http/https)
if ('serviceWorker' in navigator && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => console.log('SW Admin Portal registrado correctamente (modo offline).'))
    .catch((err) => console.log('SW error:', err));
}

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  if (state.sheetsUrl) {
    const input = document.getElementById('input-sheets-url');
    if (input) input.value = state.sheetsUrl;
  }

  // Cargar caché local de links privados (sin exponerlos en código)
  setDownloadLinksCache(getDownloadLinksCache());
  
  await loadInitialData();
  await loadDownloadLinks();
  loadClientCatalogConfigs();
  try { if (state.sheetsUrl) await loadClientCatalogFromMainSheet(true); } catch (e) {}
  // Maestros desde el inicio para que siempre viajen al publicar
  try { await loadMaestros(); } catch (e) {}
  // Nombre de empresa para encabezado
  applyCompanyName();
  try { await loadCompanyName(); } catch (e) {}
  applyCompanyName();
  maybeShowFirstRun();
  maybeShowSetupChoice();
});

/**
 * Carga inicial: solo caché local o sincronización.
 * Sin caché ni conexión el panel arranca vacío (no se cargan paquetes incluidos).
 */
async function loadInitialData() {
  logSync("Iniciando carga de datos del catálogo...");

  let data = null;

  // 1. Intentar cargar desde IndexedDB (almacenamiento persistente sin límite de 5MB)
  try {
    data = await idbGet('published_catalog');
    if (data) {
      logSync("Datos cargados desde almacenamiento local persistente (IndexedDB).");
    }
  } catch (e) {}

  // 2. Fallback a localStorage si no estaba en IndexedDB (ej. versión previa)
  if (!data) {
    try {
      const raw = localStorage.getItem('ecomdx_published_catalog');
      if (raw) {
        data = JSON.parse(raw);
        logSync("Datos cargados desde la caché local (localStorage).");
        // Migrar a IndexedDB para que en adelante nunca falle
        idbSet('published_catalog', data).catch(() => {});
      }
    } catch (e) {}
  }

  // 3. Si no hay datos en caché local pero hay Sheets URL configurada, descargar del Sheet automáticamente
  if (!data && state.sheetsUrl && navigator.onLine) {
    logSync("Sin caché local previa. Cargando datos desde Google Sheet...");
    try {
      await syncFromSheetSnapshot();
      return;
    } catch (e) {
      logSync("No se pudo cargar desde Sheet en inicio: " + e.message);
    }
  }

  if (!data) {
    logSync("Sin caché local. Configure el link en Configuración y pulse Actualizar Información.");
    updateDashboardUI();
    renderPhotosTable();
    renderClientsTable();
    return;
  }

  if (data) {
    state.products = data.products || [];
    state.clients = data.clients || [];
    state.discounts = data.discounts || [];
    state.cabysMap = data.cabysMap || {};
    if (data.vendorClients) state.vendorClients = data.vendorClients;
    if (data.vendorCounts) state.vendorCounts = data.vendorCounts;
    if (data.vendorData) state.vendorData = data.vendorData;
    if (data.vendedores) state.vendedores = data.vendedores;
    logSync("Caché restaurada con datos por vendedor incluidos.");
    
    // Cargar imágenes: IndexedDB -> localStorage -> bundle
    const baseImages = data.sampleImages || data.images || {};
    let saved = {};
    try {
      saved = (await idbGet('images')) || {};
      if (!Object.keys(saved).length) {
        const savedImages = localStorage.getItem('ecomdx_images');
        if (savedImages) saved = JSON.parse(savedImages) || {};
      }
    } catch (e) { saved = {}; }
    state.images = { ...baseImages, ...saved };
    
    // Restaurar hora de última sincronización si viene en el snapshot
    if (data.publishedAt) {
      const lastRun = document.getElementById('sync-last-run');
      if (lastRun) lastRun.textContent = new Date(data.publishedAt).toLocaleString();
    }

    logSync(`Datos cargados con éxito: ${state.products.length} productos, ${state.clients.length} clientes, ${state.discounts.length} descuentos, ${Object.keys(state.cabysMap).length} CABYS.`);
    updateDashboardUI();
    renderPhotosTable();
    renderClientsTable();
  }
}

/**
 * Actualiza los contadores e indicadores visuales del Dashboard
 */
function updateDashboardUI() {
  const totalProducts = state.products.length;
  const productsWithStock = state.products.filter(p => parseFloat(p.pro_invent || 0) > 0).length;
  const totalClients = state.clients.length;
  const totalDiscounts = state.discounts.length;
  const totalCabys = Object.keys(state.cabysMap).length;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('stat-total-products', totalProducts.toLocaleString());
  setText('stat-products-stock', productsWithStock.toLocaleString());
  setText('stat-total-clients', totalClients.toLocaleString());
  setText('stat-total-discounts', totalDiscounts.toLocaleString());
  setText('stat-total-cabys', totalCabys.toLocaleString());
  
  // Nuevo cuadro Resumen: Actualización de Información (proceso interno)
  setText('sync-count-products', totalProducts.toLocaleString());
  setText('sync-count-clients', totalClients.toLocaleString());
  setText('sync-count-discounts', totalDiscounts.toLocaleString());
  setText('sync-count-cabys', totalCabys.toLocaleString());
  // Compatibilidad por si existe la vista anterior
  setText('api-count-products', totalProducts.toLocaleString());
  setText('api-count-clients', totalClients.toLocaleString());
  setText('api-count-discounts', totalDiscounts.toLocaleString());
  setText('api-count-cabys', totalCabys.toLocaleString());

  const checkStock = document.getElementById('check-stock-count');
  if (checkStock) checkStock.textContent = `${productsWithStock} productos con inventario`;

  // Photo statistics
  let withPhoto = 0;
  state.products.forEach(p => {
    if (state.images[p.pro_codigo] && state.images[p.pro_codigo].length > 0) {
      withPhoto++;
    }
  });
  const withoutPhoto = totalProducts - withPhoto;
  const percentPhoto = totalProducts > 0 ? Math.round((withPhoto / totalProducts) * 100) : 0;

  const bar = document.getElementById('progress-photos-bar');
  if (bar) bar.style.width = `${percentPhoto}%`;

  const lblAssigned = document.getElementById('label-photos-assigned');
  if (lblAssigned) lblAssigned.textContent = `${withPhoto} productos con foto HD (${percentPhoto}%)`;

  const lblMissing = document.getElementById('label-photos-missing');
  if (lblMissing) lblMissing.textContent = `${withoutPhoto} pendientes de foto`;

  const countWith = document.getElementById('count-with-photo');
  if (countWith) countWith.textContent = withPhoto;

  const countWithout = document.getElementById('count-without-photo');
  if (countWithout) countWithout.textContent = withoutPhoto;

  // Estadísticas para pantalla de bienvenida
  setText('welcome-stat-products', totalProducts.toLocaleString());
  setText('welcome-stat-clients', totalClients.toLocaleString());
  setText('welcome-stat-discounts', totalDiscounts.toLocaleString());
  setText('welcome-stat-images', withPhoto.toLocaleString());

  renderVendorSyncList();
}

/**
 * Pestañas / Tab Switcher
 */
function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active', 'text-blue-600', 'bg-blue-50');
    btn.classList.add('text-slate-600');
  });

  const activeContent = document.getElementById(`tab-${tabName}`);
  if (activeContent) activeContent.classList.remove('hidden');

  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) {
    activeBtn.classList.add('active', 'text-blue-600', 'bg-blue-50');
    activeBtn.classList.remove('text-slate-600');
  }

  if (tabName === 'images') {
    renderPhotosTable();
  } else if (tabName === 'config') {
    renderConfigStatus();
    if (state.sheetsUrl) loadDownloadLinks();
  } else if (tabName === 'clients') {
    renderClientsTable();
    if (state.vendedores.length === 0 && state.sheetsUrl) loadVendedores().then(() => renderClientsTable()).catch(() => {});
  } else if (tabName === 'maestros') {
    renderMaestrosTables();
    if (state.sheetsUrl) loadMaestros();
  } else if (tabName === 'sellers') {
    renderSellersTable();
    if (state.vendedores.length === 0) loadVendedores();
  } else if (tabName === 'client-catalog') {
    renderClientCatalogEditor();
    if (state.vendedores.length === 0 && state.sheetsUrl) loadVendedores().then(() => renderClientCatalogEditor()).catch(() => {});
    if (state.sheetsUrl) loadClientCatalogFromMainSheet(true).catch(() => {});
  }
}

/**
 * Carga ultra rápida de información directamente desde la hoja Snapshot del Google Sheet
 * en una sola petición HTTP (sin consultar el ERP ni ralentizar).
 */
async function syncFromSheetSnapshot() {
  const btn = document.getElementById('btn-sync-sheet');
  const originalLabel = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-amber-300"></i><span>Cargando del Sheet...</span>`;
  }

  const inputUrl = (document.getElementById('input-sheets-url')?.value || "").trim();
  if (inputUrl && inputUrl !== state.sheetsUrl) {
    state.sheetsUrl = inputUrl;
    try { localStorage.setItem('ecomdx_sheets_url', inputUrl); } catch (e) {}
  }
  if (!state.sheetsUrl) {
    showAlert("Primero configure el link de sincronización en la pestaña Configuración.", "warning");
    switchTab('config');
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
    return;
  }

  setSyncStatus('Consultando datos guardados en el Google Sheet...');
  logSync("========================================");
  logSync("[RÁPIDO] Descargando catálogo directamente desde Google Sheet...");

  try {
    try { await loadVendedores(); } catch (e) {}

    // 1. Obtener instantánea de la hoja Snapshot del Sheet
    const res = await fetch(`${state.sheetsUrl}?action=snapshot_all`);
    const json = await res.json();

    if (json.status !== "success" || !json.data || !json.data.vendors || Object.keys(json.data.vendors).length === 0) {
      logSync("[AVISO] El Sheet aún no tiene datos en la hoja Snapshot.");
      setSyncStatus('Sheet sin datos previos. Ejecuta "Descargar del ERP" para la primera carga.');
      showAlert("El Sheet aún no tiene datos guardados. Presiona 'Descargar del ERP y Guardar en Sheet' para la primera carga.", "warning");
      return;
    }

    state.vendorData = json.data.vendors;
    state.vendorCounts = {};
    state.vendorClients = {};

    Object.keys(state.vendorData).forEach(ven => {
      const d = state.vendorData[ven];
      state.vendorClients[ven] = d.clients || [];
      state.vendorCounts[ven] = {
        products: (d.products || []).length,
        clients: (d.clients || []).length,
        discounts: (d.discounts || []).length,
        cabys: Object.keys(d.cabysMap || {}).length,
        ok: true,
        fails: []
      };
    });

    consolidateVendorData();

    // 2. Traer fotos del Sheet
    try {
      const resImg = await fetch(`${state.sheetsUrl}?action=get_images`);
      const jsonImg = await resImg.json();
      if (jsonImg.status === "success" && jsonImg.images) {
        state.images = jsonImg.images;
        try { localStorage.setItem('ecomdx_images', JSON.stringify(state.images)); } catch (e) {}
      }
    } catch (e) {}

    // 3. Traer configuraciones de catálogos cliente del Sheet
    try {
      const resCC = await fetch(`${state.sheetsUrl}?action=get_client_catalogs`);
      const jsonCC = await resCC.json();
      if (jsonCC.status === "success" && jsonCC.clientCatalogs) {
        state.clientCatalogConfigs = { ...(state.clientCatalogConfigs || {}), ...jsonCC.clientCatalogs };
        try { localStorage.setItem('ecomdx_client_catalog_configs', JSON.stringify(state.clientCatalogConfigs)); } catch (e) {}
        renderClientCatalogEditor();
      }
    } catch (e) {}

    const now = new Date().toLocaleString();
    const lastRun = document.getElementById('sync-last-run');
    if (lastRun) lastRun.textContent = now;

    const nVen = Object.keys(state.vendorCounts).length;
    setSyncStatus(`¡Listo en segundos! ${state.products.length} prod. • ${state.clients.length} cli. • ${state.discounts.length} dto. • ${Object.keys(state.cabysMap).length} CABYS (desde Sheet).`);
    logSync(`[ÉXITO] ${state.products.length} productos y ${state.clients.length} clientes cargados desde el Sheet.`);
    showAlert(`Datos cargados desde Google Sheet con éxito (${nVen} vendedores).`, "success");

    updateDashboardUI();
    if (state.activeTab === 'images') renderPhotosTable();
    if (state.activeTab === 'clients') renderClientsTable();

    saveCachedSnapshot();
  } catch (err) {
    logSync(`[ERROR] No se pudo leer del Sheet: ${err.message}`);
    setSyncStatus('Error leyendo datos del Sheet. Verifica conexión.');
    showAlert(`Error leyendo del Sheet: ${err.message}`, "warning");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel || `<i class="fa-solid fa-bolt text-amber-300"></i><span>Cargar Información desde Sheet</span>`;
    }
  }
}

/**
 * Sincronización completa desde el ERP (descarga por vendedor y guarda en Sheet).
 */
async function syncAllApis(forceUpload = false) {
  const btn = document.getElementById('btn-sync-all');
  const originalLabel = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Descargando ERP...</span>`;
  }
  // Tomar la URL del campo por si no se pulsó Cargar antes
  const inputUrl = (document.getElementById('input-sheets-url')?.value || "").trim();
  if (inputUrl && inputUrl !== state.sheetsUrl) {
    state.sheetsUrl = inputUrl;
    try { localStorage.setItem('ecomdx_sheets_url', inputUrl); } catch (e) {}
  }
  // Sin link central no se descarga nada
  if (!state.sheetsUrl) {
    logSync("[ERROR] Sin conexión configurada. Bloqueado: configure el link en Configuración.");
    setSyncStatus('Sin conexión. Configure el link en la pestaña Configuración.');
    showAlert("Primero configure el link de sincronización en la pestaña Configuración.", "warning");
    switchTab('config');
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
    return;
  }
  setSyncStatus('Verificando links en Google Sheet (hoja Descargas)...');
  logSync("========================================");
  logSync("[INICIO] Descarga desde el ERP hacia Google Sheet...");

  try {
    // 1. Verificar links de vendedores frescos (solo vendedores, sin link central)
    await loadDownloadLinks();
    try { await loadVendedores(); } catch (e) {}
    const vendors = getVendorCodes().filter(v => {
      const l = (VENDOR_ENDPOINTS[v] || {});
      return l.products || l.clients || l.discounts || l.cabys;
    });
    if (vendors.length === 0) {
      logSync("[ERROR] Sin links por vendedor en Sheet > Descargas (api_<tipo>_<VENDEDOR>).");
      setSyncStatus('Sin links por vendedor. Péguelos en el Sheet (Descargas).');
      showAlert("No hay links por vendedor en el Sheet (hoja Descargas).", "warning");
      return;
    }

    // 2. Limpiar caché de datos antiguos (se conserva copia de respaldo por seguridad)
    if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Descargando...</span>`;
    setSyncStatus('Descargando datos por vendedor...');
    const backup = {
      products: state.products,
      clients: state.clients,
      discounts: state.discounts,
      cabysMap: state.cabysMap,
      vendorData: state.vendorData,
      vendorClients: state.vendorClients,
      vendorCounts: state.vendorCounts
    };
    state.products = [];
    state.clients = [];
    state.discounts = [];
    state.cabysMap = {};
    state.vendorData = {};
    state.vendorClients = {};
    state.vendorCounts = {};
    try { localStorage.removeItem('ecomdx_published_catalog'); } catch (e) {}

    // 3. Descarga por vendedor y consolidado
    await syncVendorsData(btn, backup);
    consolidateVendorData();

    if (state.products.length === 0 && state.clients.length === 0) {
      Object.assign(state, {
        products: backup.products,
        clients: backup.clients,
        discounts: backup.discounts,
        cabysMap: backup.cabysMap,
        vendorData: backup.vendorData,
        vendorClients: backup.vendorClients,
        vendorCounts: backup.vendorCounts
      });
      logSync("[ERROR] Descargas vacías. Se mantuvo toda la información anterior.");
      setSyncStatus('Descargas vacías. Se mantuvo la información anterior.');
      showAlert("Las descargas vinieron vacías. Se mantuvo la información anterior.", "warning");
      updateDashboardUI();
      return;
    }

    logSync("[ÉXITO] Información de vendedores descargada y consolidada.");
    const now = new Date().toLocaleString();
    const lastRun = document.getElementById('sync-last-run');
    if (lastRun) lastRun.textContent = now;
    const nVen = Object.keys(state.vendorCounts).length;
    setSyncStatus(`Actualizado: ${state.products.length} prod. • ${state.clients.length} cli. • ${state.discounts.length} dto. • ${Object.keys(state.cabysMap).length} CABYS.`);
    showAlert(`Información descargada del ERP y guardada en Sheet para ${nVen} vendedor(es).`, "success");
    updateDashboardUI();
    if (state.activeTab === 'images') renderPhotosTable();
    if (state.activeTab === 'clients') renderClientsTable();

    // 5. Fotos del Sheet
    if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Descargando fotos...</span>`;
    setSyncStatus('Descargando fotos del Sheet...');
    try {
      const res = await fetch(`${state.sheetsUrl}?action=get_images`);
      const json = await res.json();
      if (json.status === "success" && json.images) {
        state.images = json.images;
        try { localStorage.setItem('ecomdx_images', JSON.stringify(state.images)); } catch (e) {}
        logSync(`Fotos actualizadas: ${Object.keys(json.images).length} productos con foto en el Sheet.`);
      }
    } catch (e) {
      logSync(`Fotos: no se pudieron descargar (${e.message}), se conservan las locales.`);
    }
    updateDashboardUI();
    if (state.activeTab === 'images') renderPhotosTable();

    saveCachedSnapshot();
  } catch (err) {
    logSync(`[ERROR] Actualización con advertencia: ${err.message}`);
    setSyncStatus('No se pudo completar. Se mantiene la última información guardada.');
    showAlert("Se utilizó la última versión respaldada de los datos.", "warning");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel || `<i class="fa-solid fa-arrows-rotate"></i><span>Descargar del ERP y Guardar en Sheet</span>`;
    }
  }
}

/**
 * Descarga los datos propios de cada vendedor (links api_<tipo>_<VENDEDOR>)
 * y guarda el detalle completo por vendedor. Los tipos sin link se omiten.
 */
/**
 * Sube manualmente lo descargado a la hoja Snapshot del Sheet
 * (por vendedor y tipo). No va al ERP.
 */
async function uploadSnapshot() {
  if (!state.sheetsUrl) {
    showAlert("Primero configure el link en Configuración.", "warning");
    switchTab('config');
    return;
  }
  const vendors = Object.keys(state.vendorData || {});
  if (!vendors.length) {
    showAlert("No hay datos descargados. Pulse Actualizar Información primero.", "warning");
    return;
  }
  const btn = document.getElementById('btn-upload-snapshot');
  if (btn) btn.disabled = true;
  const toItems = (ven, type) => {
    const d = state.vendorData[ven] || {};
    if (type === 'cabys') {
      return Object.keys(d.cabysMap || {}).map(k => d.cabysMap[k]);
    }
    return d[type] || [];
  };
  try {
    for (const ven of vendors) {
      setSyncStatus(`Subiendo instantánea de ${ven}...`);
      for (const t of ["products", "clients", "discounts", "cabys"]) {
        await saveSnapshotChunked(t, ven, toItems(ven, t));
      }
      logSync(`[${ven}] Instantánea subida.`);
    }
    setSyncStatus(`Instantánea subida: ${vendors.length} vendedor(es).`);
    showAlert(`Instantánea subida al Sheet: ${vendors.join(", ")}.`, "success");
  } catch (e) {
    showAlert(`No se pudo subir: ${e.message}`, "warning");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Guarda instantánea en el Sheet; si el lote completo falla por tamaño,
 * reintenta por partes de 150 registros.
 */
async function saveSnapshotChunked(type, ven, items) {
  const post = async (chunk, append) => {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_snapshot", vendor: ven, tipo: type, items: chunk, append: !!append })
    });
    let json = null;
    try { json = await res.json(); } catch (e) { throw new Error("El GS no devolvió JSON (¿Nueva versión con save_snapshot?)"); }
    if (!json || json.status !== "success") {
      throw new Error((json && json.message) || "El GS rechazó el guardado");
    }
    return json.count || 0;
  };
  try {
    await post(items, false);
    return;
  } catch (e) {
    console.warn(`snapshot ${type}/${ven} lote completo falló, por partes:`, e.message);
  }
  for (let i = 0; i < items.length; i += 150) {
    await post(items.slice(i, i + 150), i > 0);
  }
}

async function fetchVendorType(type, vendor) {  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${state.sheetsUrl}?action=fetch&type=${type}&v=${encodeURIComponent(vendor)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.status !== "success" || !Array.isArray(json.items)) {
        throw new Error((json && json.message) || "Respuesta inválida del Sheet");
      }
      return json.items;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function syncVendorsData(btn, backup) {
  const prev = (backup && backup.vendorData) || {};
  const prevClients = (backup && backup.vendorClients) || {};
  const vendors = getVendorCodes().filter(v => {
    const l = (VENDOR_ENDPOINTS[v] || {});
    return l.products || l.clients || l.discounts || l.cabys;
  });
  state.vendorCounts = {};
  state.vendorClients = {};
  state.vendorData = {};
  if (vendors.length === 0) {
    logSync("Sin links por vendedor en Descargas.");
    renderVendorSyncList();
    return;
  }
  const TYPES = [["products", "productos"], ["clients", "clientes"], ["discounts", "descuentos"], ["cabys", "CABYS"]];
  logSync(`Descargando datos por vendedor: ${vendors.join(", ")}...`);
  for (const ven of vendors) {
    if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Vendedor ${ven}...</span>`;
    setSyncStatus(`Descargando ruta de ${ven}...`);
    const links = VENDOR_ENDPOINTS[ven] || {};
    const data = { products: [], clients: [], discounts: [], cabysMap: {} };
    const fails = [];
    for (const [type, label] of TYPES) {
      if (!(links[type] || "").trim()) {
        logSync(`[${ven}] Sin link de ${label}, se omite.`);
        continue;
      }
      try {
        const items = await fetchVendorType(type, ven);
        if (type === 'cabys') {
          items.forEach(c => {
            if (c && c.pro_codecom) data.cabysMap[String(c.pro_codecom).trim()] = c;
          });
        } else {
          data[type] = items;
        }
        // Guardar instantánea rápida en el Sheet (para no ir al ERP siempre)
        await saveSnapshotChunked(type, ven, items);
        if (!items.length) {
          // Vacío: conservar lo anterior de ese vendedor si había
          const old = type === 'cabys' ? prev[ven]?.cabysMap : (type === 'clients' ? prevClients[ven] : prev[ven]?.[type]);
          const hasOld = type === 'cabys' ? old && Object.keys(old).length : old && old.length;
          if (hasOld) {
            if (type === 'cabys') data.cabysMap = old;
            else data[type] = old;
            logSync(`[${ven}] ${label}: vacío, se conserva lo anterior (${type === 'cabys' ? Object.keys(old).length : old.length}).`);
          } else {
            logSync(`[${ven}] ${label}: vacío.`);
          }
        } else {
          logSync(`[${ven}] ${label}: ${items.length} registros.`);
        }
      } catch (e) {
        fails.push(label);
        logSync(`[${ven}] ${label} falló: ${e.message} (se conserva lo anterior).`);
        const old = type === 'cabys' ? prev[ven]?.cabysMap : (type === 'clients' ? prevClients[ven] : prev[ven]?.[type]);
        if (type === 'cabys') {
          if (old && Object.keys(old).length) data.cabysMap = old;
        } else if (old && old.length) {
          data[type] = old;
        }
      }
    }
    state.vendorData[ven] = data;
    state.vendorClients[ven] = data.clients;
    state.vendorCounts[ven] = {
      products: data.products.length,
      clients: data.clients.length,
      discounts: data.discounts.length,
      cabys: Object.keys(data.cabysMap).length,
      ok: fails.length === 0,
      fails: fails
    };
    renderVendorSyncList();
  }
  const okCount = vendors.filter(v => state.vendorCounts[v] && state.vendorCounts[v].ok).length;
  setSyncStatus(`Descargados ${okCount}/${vendors.length} vendedores.`);
}

/**
 * Consolida los datos de todos los vendedores en la vista principal.
 * Las existencias son las mismas en todos (no se suman): primer valor prevalece.
 */
function consolidateVendorData() {
  const prodMap = new Map();
  const cliMap = new Map();
  const seenDiscounts = new Set();
  const discounts = [];
  const cabysMap = {};
  let mergedProducts = 0;
  Object.keys(state.vendorData || {}).sort().forEach(ven => {
    const d = state.vendorData[ven] || {};
    (d.products || []).forEach(p => {
      const code = String(p.pro_codigo || '').trim();
      if (!code) return;
      if (!prodMap.has(code)) prodMap.set(code, p);
      else mergedProducts++;
    });
    (d.clients || []).forEach(c => {
      const code = String(c.cli_codigo || '').trim();
      if (code && !cliMap.has(code)) cliMap.set(code, c);
    });
    (d.discounts || []).forEach(x => {
      const key = JSON.stringify(x);
      if (!seenDiscounts.has(key)) { seenDiscounts.add(key); discounts.push(x); }
    });
    Object.assign(cabysMap, d.cabysMap || {});
  });
  state.products = Array.from(prodMap.values());
  state.clients = Array.from(cliMap.values());
  state.discounts = discounts;
  state.cabysMap = cabysMap;
  logSync(`Consolidado: ${state.products.length} prod. • ${state.clients.length} cli. • ${discounts.length} dto. • ${Object.keys(cabysMap).length} CABYS (${mergedProducts} duplicados fusionados).`);
}

function sellerName(code) {
  const v = (state.vendedores || []).find(x => String(x.codigo || "").trim().toUpperCase() === String(code || "").trim().toUpperCase());
  return v ? v.nombre : "";
}

function renderVendorSyncList() {
  const box = document.getElementById('vendor-sync-list');  if (!box) return;
  const vendors = getVendorCodes().filter(v => {
    const l = (VENDOR_ENDPOINTS[v] || {});
    return l.products || l.clients || l.discounts || l.cabys;
  });
  if (vendors.length === 0) {
    box.innerHTML = `<p class="text-[11px] text-slate-400">Sin vendedores con links propios. Crea el vendedor y pega sus links con su usuario= en Descargas.</p>`;
    return;
  }
  box.innerHTML = vendors.map(ven => {
    const c = state.vendorCounts[ven];
    const name = sellerName(ven);
    const badge = !c
      ? `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Pendiente</span>`
      : c.ok
        ? `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">${c.clients} clientes</span>`
        : `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">Error</span>`;
    const detail = c && c.ok ? `${c.products} prod. • ${c.discounts} dto. • ${c.cabys} CABYS` : (c ? `Falló: ${(c.fails || []).join(", ") || "ver log"}` : "Se descarga con Actualizar Información");
    return `
      <div class="flex items-center justify-between gap-2 text-xs p-2.5 rounded-xl bg-slate-50 border border-slate-100">
        <div class="min-w-0">
          <div class="font-bold text-slate-900 font-mono">${ven}${name ? ` <span class="font-sans font-medium text-slate-500">• ${name}</span>` : ""}</div>
          <div class="text-[11px] text-slate-400">${detail}</div>
        </div>
        ${badge}
      </div>`;
  }).join('');
  renderVendorClientsChart();
}

/**
 * Gráfico ejecutivo: cartera total vs clientes por vendedor (datos reales).
 */
function renderVendorClientsChart() {
  const chart = document.getElementById('vendor-clients-chart');
  if (!chart) return;
  const total = state.clients.length;
  const vendors = getVendorCodes().filter(v => {
    const l = (VENDOR_ENDPOINTS[v] || {});
    return l.products || l.clients || l.discounts || l.cabys;
  });
  const rows = vendors.map(ven => ({
    ven,
    name: sellerName(ven),
    count: (state.vendorClients[ven] || []).length,
    ok: !!(state.vendorCounts[ven] && state.vendorCounts[ven].ok),
    synced: !!state.vendorCounts[ven]
  }));
  const max = Math.max(total, ...rows.map(r => r.count), 1);
  const sumRoutes = rows.reduce((a, r) => a + r.count, 0);
  const coverage = total > 0 ? Math.round((sumRoutes / total) * 100) : 0;

  const bar = (value, color) => `
    <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
      <div class="${color} h-2.5 rounded-full transition-all duration-500" style="width: ${Math.max(0, Math.min(100, Math.round((value / max) * 100)))}%"></div>
    </div>`;

  chart.innerHTML = `
    <div class="space-y-3">
      <div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="font-bold text-slate-900">Cartera total (máster)</span>
          <span class="font-extrabold text-purple-700 text-sm">${total.toLocaleString()}</span>
        </div>
        ${bar(total, "bg-gradient-to-r from-purple-500 to-purple-700")}
      </div>
      ${rows.map(r => `
        <div>
          <div class="flex items-center justify-between text-xs mb-1 gap-2">
            <span class="font-semibold text-slate-700 truncate font-mono">${r.ven}${r.name ? `<span class="font-sans text-slate-400"> • ${r.name}</span>` : ""}${r.synced && !r.ok ? ` <span class="text-rose-500 font-bold">• error</span>` : ""}${!r.synced ? ` <span class="text-slate-400">• sin descargar</span>` : ""}</span>
            <span class="font-extrabold text-slate-900 whitespace-nowrap">${r.count.toLocaleString()} <span class="font-medium text-slate-400">(${total > 0 ? Math.round((r.count / total) * 100) : 0}%)</span></span>
          </div>
          ${bar(r.count, r.ok ? "bg-gradient-to-r from-blue-500 to-indigo-600" : "bg-slate-300")}
        </div>`).join('') || `<p class="text-[11px] text-slate-400">Sin vendedores con links propios.</p>`}
    </div>
    <div class="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
      <span>Suma de rutas: <strong class="text-slate-900">${sumRoutes.toLocaleString()}</strong></span>
      <span>Cartera total: <strong class="text-slate-900">${total.toLocaleString()}</strong></span>
      <span>Cobertura: <strong class="${coverage === 100 ? "text-emerald-600" : "text-amber-600"}">${coverage}%</strong></span>
    </div>
    <p class="text-[11px] text-slate-400 mt-1">Cobertura 100% = las rutas cubren toda la cartera. Menos = hay clientes sin vendedor. Más = rutas traslapadas.</p>`;
}

/**
 * Guarda la sincronización en este equipo para abrir con datos sin red.
 */
async function saveCachedSnapshot() {
  const snapshot = {
    version: "1.0.0",
    publishedAt: new Date().toISOString(),
    config: { sheetsUrl: state.sheetsUrl || "", maestros: state.maestros },
    products: state.products || [],
    clients: state.clients || [],
    discounts: state.discounts || [],
    cabysMap: state.cabysMap || {},
    images: state.images || {},
    vendedores: state.vendedores || [],
    vendorData: state.vendorData || {},
    vendorClients: state.vendorClients || {},
    vendorCounts: state.vendorCounts || {}
  };

  // 1. Guardar siempre en almacenamiento persistente IndexedDB (sin límite de 5MB)
  try {
    await idbSet('published_catalog', snapshot);
    if (state.images && Object.keys(state.images).length > 0) {
      await idbSet('images', state.images);
    }
    logSync("Sincronización guardada en almacenamiento persistente.");
  } catch (err) {
    console.warn("Error en IndexedDB:", err);
  }

  // 2. Intentar guardar en localStorage si cabe (fallback)
  try {
    localStorage.setItem('ecomdx_published_catalog', JSON.stringify(snapshot));
    logSync("Sincronización guardada en caché local.");
  } catch (e) {
    // Si localStorage excede su cuota de 5MB, IndexedDB ya tiene los datos completos guardados
  }
}

function applySyncedItems(type, items) {  if (type === 'products') state.products = items;
  if (type === 'clients') state.clients = items;
  if (type === 'discounts') state.discounts = items;
  if (type === 'cabys') {
    state.cabysMap = {};
    items.forEach(c => {
      if (c && c.pro_codecom) state.cabysMap[String(c.pro_codecom).trim()] = c;
    });
  }
}

function parseNdjsonOrJson(text) {
  const items = [];
  const lines = String(text || "").split('\n');
  for (let l of lines) {
    l = l.trim();
    if (!l) continue;
    try {
      items.push(JSON.parse(l));
    } catch(e) {}
  }
  if (items.length > 0) return items;
  try {
    const full = JSON.parse(String(text || "").trim());
    if (Array.isArray(full)) return full;
    if (full && Array.isArray(full.items)) return full.items;
    if (full && Array.isArray(full.data)) return full.data;
    if (full && typeof full === "object") {
      for (const k of Object.keys(full)) {
        if (Array.isArray(full[k])) return full[k];
      }
    }
  } catch(e) {}
  return items;
}

async function syncSpecificApi(type, updateUI = true) {
  // 1) Vía proxy del Sheet: el navegador nunca toca los links privados
  if (state.sheetsUrl) {
    try {
      logSync(`[API ${type.toUpperCase()}] Descargando vía Google Sheet...`);
      const res = await fetch(`${state.sheetsUrl}?action=fetch&type=${type}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.status === "success" && Array.isArray(json.items)) {
        applySyncedItems(type, json.items);
        logSync(`[API ${type.toUpperCase()}] ${json.items.length} registros obtenidos vía Sheet.`);
        if (updateUI) {
          updateDashboardUI();
          if (state.activeTab === 'images') renderPhotosTable();
          if (state.activeTab === 'clients') renderClientsTable();
        }
        return json.items.length;
      }
      throw new Error((json && json.message) || "Respuesta inválida del Sheet");
    } catch (e) {
      logSync(`[API ${type.toUpperCase()}] Proxy Sheet falló (${e.message}). Intentando directo...`);
    }
  }

  // 2) Fallback directo (caché local del equipo)
  const url = (API_ENDPOINTS[type] || "").trim();
  if (!url) {
    logSync(`[API ${type.toUpperCase()}] Sin link configurado. Configúralo en Google Sheet > Descargas.`);
    if (updateUI) showAlert("Falta configurar el link privado de descarga en Google Sheet (pestaña Descargas).", "warning");
    return 0;
  }
  logSync(`[API ${type.toUpperCase()}] Consultando fuente privada...`);
  
  try {
    // Intento de fetch directo a la fuente privada
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const items = parseNdjsonOrJson(text);
    applySyncedItems(type, items);

    logSync(`[API ${type.toUpperCase()}] ${items.length} registros obtenidos.`);
    if (updateUI) {
      updateDashboardUI();
      if (state.activeTab === 'images') renderPhotosTable();
      if (state.activeTab === 'clients') renderClientsTable();
    }
    return items.length;
  } catch (e) {
    logSync(`[API ${type.toUpperCase()}] Descarga directa bloqueada (${e.message}). El Sheet sí puede descargarlo sin CORS.`);
    if (updateUI) {
      updateDashboardUI();
      if (state.activeTab === 'images') renderPhotosTable();
      if (state.activeTab === 'clients') renderClientsTable();
    }
    return 0;
  }
}

/**
 * Configuración central: el único link de sincronización para todo.
 */
function renderConfigStatus() {
  const badge = document.getElementById('config-conn-badge');
  const ok = !!(state.sheetsUrl && state.sheetsUrl.length > 10);
  if (badge) {
    badge.textContent = ok ? "Configurado" : "Sin configurar";
    badge.className = ok
      ? "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
      : "text-[11px] font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200";
  }
  const input = document.getElementById('input-sheets-url');
  if (input && document.activeElement !== input && state.sheetsUrl && !input.value) {
    input.value = state.sheetsUrl;
  }
  const devInput = document.getElementById('input-dev-whatsapp');
  if (devInput && document.activeElement !== devInput && state.devWhatsapp && !devInput.value) {
    devInput.value = state.devWhatsapp;
  }

  const box = document.getElementById('config-links-master');
  if (box) {
    const defs = [["products", "Productos"], ["clients", "Clientes"], ["discounts", "Descuentos"], ["cabys", "CABYS"]];
    box.innerHTML = defs.map(([k, label]) => {
      const has = !!(API_ENDPOINTS[k] || "").trim();
      return `<div class="flex items-center justify-between text-xs p-2.5 rounded-xl ${has ? "bg-emerald-50 border border-emerald-100" : "bg-slate-50 border border-slate-100"}">
        <span class="font-medium ${has ? "text-emerald-800" : "text-slate-600"}">${label}</span>
        <span class="text-[10px] font-bold ${has ? "text-emerald-700" : "text-slate-400"}">${has ? "Listo" : "Pendiente"}</span>
      </div>`;
    }).join('');
  }

  const vbox = document.getElementById('config-links-vendors');
  if (vbox) {
    const vendors = getVendorCodes();
    if (!vendors.length) {
      vbox.innerHTML = `<p class="text-[11px] text-slate-400">Sin vendedores registrados. Créelos en Vendedores y pegue sus links con su usuario= en Descargas.</p>`;
    } else {
      vbox.innerHTML = vendors.map(ven => {
        const l = VENDOR_ENDPOINTS[ven] || {};
        const n = ["products", "clients", "discounts", "cabys"].filter(k => (l[k] || "").trim()).length;
        const name = sellerName(ven);
        return `<div class="flex items-center justify-between gap-2 text-xs p-2.5 rounded-xl ${n === 4 ? "bg-emerald-50 border border-emerald-100" : "bg-slate-50 border border-slate-100"}">
          <span class="font-mono font-bold text-slate-900 truncate">${ven}${name ? ` <span class="font-sans font-medium text-slate-500">• ${name}</span>` : ""}</span>
          <span class="text-[10px] font-bold ${n === 4 ? "text-emerald-700" : "text-slate-400"} whitespace-nowrap">${n}/4 links</span>
        </div>`;
      }).join('');
    }
  }
}

async function saveSheetsConnection() {
  const url = (document.getElementById('input-sheets-url')?.value || "").trim();
  if (!url) {
    showAlert("Pegue la URL de la aplicación web (/exec).", "warning");
    return;
  }
  if (!/\/exec(\?.*)?$/.test(url)) {
    showAlert("Esa URL no parece del Apps Script (debe terminar en /exec). Se guarda igual, verifique.", "warning");
  }
  state.sheetsUrl = url;
  try { localStorage.setItem('ecomdx_sheets_url', url); } catch (e) {}
  showAlert("Conexión guardada. Leyendo links del Sheet...", "success");
  await loadDownloadLinks();
  await loadCompanyName();
  renderConfigStatus();
  if ((state.products || []).length === 0) {
    runFirstLoad();
  }
}

async function forgetSheetsConnection() {
  if (!confirm("¿Olvidar la conexión y borrar TODA la caché de este equipo? Habrá que configurar el link de nuevo.")) return;
  state.sheetsUrl = "";
  try { localStorage.removeItem('ecomdx_sheets_url'); } catch (e) {}
  const input = document.getElementById('input-sheets-url');
  if (input) input.value = "";
  await clearAllCache();
  renderConfigStatus();
  switchTab('config');
}

/**
 * Manejo de Google Sheets & Fotos
 */
async function testAndLoadGoogleSheet() {
  const url = document.getElementById('input-sheets-url').value.trim();
  if (!url) {
    showAlert("Por favor ingresa la URL de la aplicación web de Google Apps Script.", "warning");
    return;
  }
  
  state.sheetsUrl = url;
  localStorage.setItem('ecomdx_sheets_url', url);
  logSync(`Conectando con Google Sheet...`);

  try {
    const res = await fetch(`${url}?action=get_images`);
    const json = await res.json();
    if (json.status === "success" && json.images) {
      state.images = json.images;
      localStorage.setItem('ecomdx_images', JSON.stringify(state.images));
      showAlert(`Fotos sincronizadas desde Google Sheet: ${Object.keys(state.images).length} productos tienen foto.`, "success");
      updateDashboardUI();
      renderPhotosTable();
    } else {
      throw new Error("Respuesta inválida de Google Sheets");
    }
  } catch (err) {
    showAlert("No se pudo conectar directamente al Google Sheet. Revisa los permisos de 'Cualquier persona' en la implementación de Apps Script.", "warning");
  }
  await loadDownloadLinks();
}

/**
 * Subida masiva administrativa: navegador -> Google Sheet.
 * Guarda/actualiza los links de cada producto en la pestaña Imagenes.
 */
async function uploadAllImagesToSheet() {
  const inputUrl = (document.getElementById('input-sheets-url')?.value || "").trim();
  if (inputUrl && inputUrl !== state.sheetsUrl) {
    state.sheetsUrl = inputUrl;
    try { localStorage.setItem('ecomdx_sheets_url', inputUrl); } catch (e) {}
  }
  if (!state.sheetsUrl) {
    showAlert("Primero configura la URL del Google Apps Script.", "warning");
    return;
  }
  const codes = Object.keys(state.images || {});
  if (codes.length === 0) {
    showAlert("No hay fotos en el navegador para subir.", "warning");
    return;
  }
  const btn = document.getElementById("btn-upload-images");
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Subiendo ${codes.length}...</span>`;
  }
  try {
    const descriptions = {};
    (state.products || []).forEach(p => {
      const c = String(p.pro_codigo || "").trim();
      if (c) descriptions[c] = String(p.pro_nombre || "");
    });
    // Normalizar a {codigo: [link]} para el backend (incluye links de Drive)
    const images = {};
    codes.forEach(c => {
      const v = state.images[c];
      let link = Array.isArray(v) ? (v[0] || "") : String(v || "");
      link = normalizeImageUrl(link);
      if (link) {
        images[String(c).trim()] = [link];
        state.images[c] = [link];
      }
    });
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      // text/plain evita preflight CORS en Apps Script (igual llega a e.postData.contents)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_images", images, descriptions })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}. Re-despliega el Code.gs como Nueva versión.`);
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error("Respuesta no JSON. Re-despliega el Code.gs como Nueva versión.");
    }
    if (!json || json.status !== "success") {
      const msg = (json && json.message) || "Error Sheet";
      if (String(msg).toLowerCase().includes("no reconocida")) {
        throw new Error(`${msg}. Re-despliega el Code.gs (Implementar > Nueva versión).`);
      }
      throw new Error(msg);
    }
    showAlert(`Fotos subidas al Sheet: ${json.count || codes.length} productos actualizados.`, "success");
    saveCachedSnapshot();
    updateDashboardUI();
    renderPhotosTable();
  } catch (e) {
    console.warn("uploadAllImagesToSheet:", e);
    showAlert(`No se pudo subir al Sheet: ${e.message}`, "warning");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

/**
 * Links privados de descarga (hoja nueva "Descargas" del Sheet).
 * Solo se pegan en el Excel/Sheet, nunca en la pestaña Fotos ni en código.
 * Aquí solo se leen para sincronizar; no se muestran.
 */
async function loadDownloadLinks() {
  updateDownloadLinksUI();
  if (!state.sheetsUrl || !navigator.onLine) return;
  try {
    const res = await fetch(`${state.sheetsUrl}?action=get_downloads`);
    const json = await res.json();
    if (json.status === "success" && json.downloads) {
      const d = json.downloads;
      const hasAny = (d.products || d.clients || d.discounts || d.cabys)
        || (d.vendors && Object.keys(d.vendors).length > 0);
      if (hasAny) setDownloadLinksCache(d);
    }
  } catch (e) {
    console.warn("No se pudieron leer los links privados del Sheet (modo offline):", e);
  }
  updateDownloadLinksUI();
}

function updateDownloadLinksUI() {
  const vals = [API_ENDPOINTS.products, API_ENDPOINTS.clients, API_ENDPOINTS.discounts, API_ENDPOINTS.cabys];
  const configured = vals.filter(v => v && v.length > 10).length;
  const syncMsg = document.getElementById("sync-status-msg");
  if (syncMsg) {
    syncMsg.textContent = configured === 4
      ? "Links listos desde Google Sheet (hoja Descargas)."
      : `Faltan ${4 - configured} links por pegar en el Sheet (hoja Descargas).`;
  }
  renderVendorSyncList();
  renderConfigStatus();
}

function filterPhotosList(filter) {
  state.photoFilter = filter;
  state.photoPage = 1;

  document.getElementById('btn-filter-all').className = filter === 'all' 
    ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700' 
    : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100';

  document.getElementById('btn-filter-with').className = filter === 'with-photo' 
    ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700' 
    : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100';

  document.getElementById('btn-filter-without').className = filter === 'without-photo' 
    ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700' 
    : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100';

  renderPhotosTable();
}

function renderPhotosTable() {
  const tbody = document.getElementById('photos-table-body');
  if (!tbody) return;

  const search = (document.getElementById('search-photos-input')?.value || '').toLowerCase().trim();

  let filtered = state.products.filter(p => {
    const hasPhoto = state.images[p.pro_codigo] && state.images[p.pro_codigo].length > 0;
    
    if (state.photoFilter === 'with-photo' && !hasPhoto) return false;
    if (state.photoFilter === 'without-photo' && hasPhoto) return false;

    if (search) {
      const codeMatch = String(p.pro_codigo).toLowerCase().includes(search);
      const nameMatch = String(p.pro_nombre || '').toLowerCase().includes(search);
      return codeMatch || nameMatch;
    }
    return true;
  });

  const total = filtered.length;
  const totalPages = Math.ceil(total / state.pageSize) || 1;
  if (state.photoPage > totalPages) state.photoPage = totalPages;

  const start = (state.photoPage - 1) * state.pageSize;
  const paged = filtered.slice(start, start + state.pageSize);

  if (paged.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">No se encontraron productos con el filtro aplicado.</td></tr>`;
    return;
  }

  tbody.innerHTML = paged.map(p => {
    const photos = state.images[p.pro_codigo] || [];
    const photoUrl = photos.length > 0 ? normalizeImageUrl(photos[0]) : '';
    const stock = parseFloat(p.pro_invent || 0);
    const stockBadge = stock > 0 
      ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">${stock} und</span>`
      : `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">Agotado</span>`;

    const imgPreview = photoUrl 
      ? `<div onclick="openPhotoPreview('${photoUrl}', '${p.pro_codigo}', '${p.pro_nombre}')" class="w-10 h-10 rounded-lg overflow-hidden border border-slate-200 cursor-pointer hover:opacity-80 transition bg-white flex items-center justify-center">
           <img src="${photoUrl}" class="w-full h-full object-cover">
         </div>`
      : `<div class="w-10 h-10 rounded-lg bg-slate-100 border border-dashed border-slate-300 flex items-center justify-center text-slate-400 text-xs">
           <i class="fa-solid fa-image"></i>
         </div>`;

    return `
      <tr class="hover:bg-slate-50/75 transition">
        <td class="p-3 text-center">${imgPreview}</td>
        <td class="p-3 font-mono font-bold text-slate-900">${p.pro_codigo}</td>
        <td class="p-3">
          <div class="font-medium text-slate-900">${p.pro_nombre}</div>
          <div class="text-[10px] text-slate-400">CABYS: ${state.cabysMap[p.pro_codigo]?.pro_cabys || 'Pendiente'} | IVA: ${state.cabysMap[p.pro_codigo]?.pro_poriva || p.pro_iva || 13}%</div>
        </td>
        <td class="p-3 text-center">${stockBadge}</td>
        <td class="p-3">
          <input type="text" id="img-input-${p.pro_codigo}" value="${photoUrl}" placeholder="Pega el link de la foto aquí..." class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
        </td>
        <td class="p-3 text-center">
          <button onclick="savePhotoLink('${p.pro_codigo}')" class="px-2.5 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-xs font-semibold transition">
            Guardar
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Pagination UI
  document.getElementById('photos-page-info').textContent = `Mostrando ${start + 1} a ${Math.min(start + state.pageSize, total)} de ${total} productos`;
  
  let pageBtns = '';
  for (let i = 1; i <= Math.min(totalPages, 5); i++) {
    pageBtns += `<button onclick="goToPhotoPage(${i})" class="w-7 h-7 rounded-lg text-xs ${i === state.photoPage ? 'bg-blue-600 text-white font-bold' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${i}</button>`;
  }
  document.getElementById('photos-page-buttons').innerHTML = pageBtns;
}

function goToPhotoPage(page) {
  state.photoPage = page;
  renderPhotosTable();
}

async function savePhotoLink(code) {
  const input = document.getElementById(`img-input-${code}`);
  if (!input) return;
  const link = normalizeImageUrl(input.value.trim());
  if (input.value.trim() !== link) input.value = link;

  if (link) {
    state.images[code] = [link];
  } else {
    delete state.images[code];
  }

  localStorage.setItem('ecomdx_images', JSON.stringify(state.images));
  updateDashboardUI();
  saveCachedSnapshot();
  showAlert(`Foto para producto ${code} guardada localmente.`, "success");

  // Si hay Google Sheets Web App configurado, enviar POST
  if (state.sheetsUrl) {
    try {
      await fetch(state.sheetsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'save_image',
          codigo: code,
          link: link,
          descripcion: state.products.find(p => p.pro_codigo === code)?.pro_nombre || ''
        })
      });
      showAlert(`Foto para producto ${code} sincronizada en Google Sheet.`, "success");
    } catch(e) {
      console.warn("No se pudo escribir directamente en Google Sheet por CORS:", e);
    }
  }

  // Réplica en los GS de cada vendedor (misma foto para sus catálogos)
  const vendorUrls = [];
  try {
    Object.keys(state.clientCatalogConfigs || {}).forEach(v => {
      const u = String((state.clientCatalogConfigs[v] || {}).sheetsUrl || "").trim();
      if (u) vendorUrls.push({ code: v, url: u });
    });
  } catch (e) {}
  if (vendorUrls.length && link) {
    const results = await Promise.allSettled(vendorUrls.map(v =>
      fetch(v.url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'save_image',
          codigo: code,
          link: link,
          descripcion: state.products.find(p => p.pro_codigo === code)?.pro_nombre || ''
        })
      })
    ));
    const ok = results.filter(r => r.status === "fulfilled").length;
    showAlert(`Foto replicada en ${ok}/${vendorUrls.length} GS de vendedores.`, ok === vendorUrls.length ? "success" : "warning");
  }

  renderPhotosTable();
}

/**
 * Tabla de Clientes & Reglas
 */
function renderClientsTable() {
  const tbody = document.getElementById('clients-table-body');
  if (!tbody) return;

  // Filtro por vendedor (usa los clientes descargados con su usuario=)
  const vendorSel = document.getElementById('filter-client-vendor');
  if (vendorSel) {
    const current = vendorSel.value || "ALL";
    const vendors = getVendorCodes();
    const opts = [`<option value="ALL">Todos los vendedores (${state.clients.length})</option>`].concat(
      vendors.map(v => {
        const n = (state.vendorClients[v] || []).length;
        const name = sellerName(v);
        return `<option value="${v}" ${current === v ? "selected" : ""}>${v}${name ? " • " + name : ""}${n ? ` (${n})` : ""}</option>`;
      })
    );
    vendorSel.innerHTML = opts.join('');
  }
  const vendorFilter = (document.getElementById('filter-client-vendor')?.value || "ALL").toUpperCase();
  const base = (vendorFilter !== "ALL" && state.vendorClients[vendorFilter])
    ? state.vendorClients[vendorFilter]
    : state.clients;

  const search = (document.getElementById('search-clients-input')?.value || '').toLowerCase().trim();

  // Deduplicar por código (el ERP puede traer el mismo cliente repetido)
  const seenCodes = new Set();
  const uniqueBase = [];
  for (const c of base) {
    const code = String(c.cli_codigo || '').trim();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    uniqueBase.push(c);
  }

  const filtered = uniqueBase.filter(c => {
    if (!search) return true;
    const nameMatch = String(c.cli_nombre || '').toLowerCase().includes(search);
    const codeMatch = String(c.cli_codigo || '').toLowerCase().includes(search);
    const docMatch = String(c.documento || '').toLowerCase().includes(search);
    return nameMatch || codeMatch || docMatch;
  });

  if (filtered.length === 0) {
    const hint = vendorFilter !== "ALL" && !(state.vendorClients[vendorFilter] || []).length
      ? `Sin datos de ${vendorFilter}. Pulsa Actualizar Información para descargar su ruta (usuario=).`
      : `No se encontraron clientes.`;
    tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">${hint}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.slice(0, 50).map(c => {
    const listNum = String(c.cli_lista || '1').trim();
    const clientDiscount = parseFloat(c.cli_descue || 0);

    // Calcular cuántos productos con stock > 0 tienen la lista de este cliente
    const visibleCount = state.products.filter(p => {
      const stock = parseFloat(p.pro_invent || 0);
      if (stock <= 0) return false;
      const listas = p.pro_listas || [];
      return listas.some(l => String(l.det_lista).trim() === listNum && parseFloat(l.det_valor || 0) > 0);
    }).length;

    return `
      <tr class="hover:bg-slate-50/75 transition">
        <td class="p-3 font-mono font-bold text-slate-900">${c.cli_codigo}</td>
        <td class="p-3">
          <div class="font-medium text-slate-900">${c.cli_nombre}</div>
          <div class="text-[10px] text-slate-400 truncate max-w-xs">${c.cli_direcc || 'Sin dirección registrada'}</div>
        </td>
        <td class="p-3 font-mono text-slate-600">${c.documento || '-'}</td>
        <td class="p-3 text-center">
          <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800">Lista ${listNum}</span>
        </td>
        <td class="p-3 text-center">
          <span class="px-2.5 py-1 rounded-full text-xs font-semibold ${clientDiscount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}">
            ${clientDiscount > 0 ? clientDiscount + '%' : '0%'}
          </span>
        </td>
        <td class="p-3 text-center font-bold text-emerald-600">
          ${visibleCount} productos
        </td>
        <td class="p-3 text-center">
          <a href="../preventa-app/index.html?clientCode=${c.cli_codigo}" target="_blank" class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-700 rounded-lg text-xs font-medium transition">
            <i class="fa-solid fa-eye"></i>
            <span>Ver</span>
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Vendedores: gestión desde Admin, almacenados en Sheet (hoja Vendedores).
 */
function requireSheetsUrl() {
  if (!state.sheetsUrl) {
    showAlert("Primero configura la URL del Google Apps Script en Fotos & Google Sheets.", "warning");
    return false;
  }
  return true;
}

async function loadVendedores() {
  if (!requireSheetsUrl()) return;
  try {
    const res = await fetch(`${state.sheetsUrl}?action=get_vendedores`);
    const json = await res.json();
    if (json.status === "success" && Array.isArray(json.vendedores)) {
      state.vendedores = json.vendedores;
      renderSellersTable();
      renderVendorSyncList();
      saveCachedSnapshot();
    } else {
      throw new Error((json && json.message) || "Respuesta inválida del Sheet");
    }
  } catch (e) {
    showAlert(`No se pudieron cargar vendedores: ${e.message}`, "warning");
  }
}

function renderSellersTable() {
  const tbody = document.getElementById('sellers-table-body');
  if (!tbody) return;
  const search = (document.getElementById('search-sellers-input')?.value || '').toLowerCase().trim();
  const filtered = (state.vendedores || []).filter(v => {
    if (!search) return true;
    return String(v.codigo || '').toLowerCase().includes(search)
      || String(v.nombre || '').toLowerCase().includes(search)
      || String(v.usuario || '').toLowerCase().includes(search);
  });
  const count = document.getElementById('sellers-count');
  if (count) count.textContent = String(state.vendedores.length);
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400">Sin vendedores. Agrégalos arriba o pulsa Recargar del Sheet.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(v => {
    const active = v.activo !== "N";
    return `
      <tr class="hover:bg-slate-50/75 transition">
        <td class="p-3 font-mono font-bold text-slate-900">${v.codigo}</td>
        <td class="p-3 font-medium text-slate-900">${v.nombre}</td>
        <td class="p-3 font-mono text-slate-600">${v.usuario}</td>
        <td class="p-3 text-center">
          <span class="px-2.5 py-1 rounded-full text-xs font-semibold ${active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
            ${active ? 'Activo' : 'Inactivo'}
          </span>
        </td>
        <td class="p-3 text-center">
          <div class="flex items-center justify-center gap-1.5 flex-wrap">
            <button onclick="editSeller('${v.codigo}')" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition">Editar</button>
            <button onclick="toggleSeller('${v.codigo}')" class="px-2.5 py-1 ${active ? 'bg-amber-50 hover:bg-amber-100 text-amber-700' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'} rounded-lg text-xs font-medium transition">${active ? 'Desactivar' : 'Activar'}</button>
            <button onclick="deleteSeller('${v.codigo}')" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-xs font-medium transition">Eliminar</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function clearSellerForm() {
  ["seller-codigo", "seller-nombre", "seller-usuario", "seller-password"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const act = document.getElementById("seller-activo");
  if (act) act.checked = true;
  const cod = document.getElementById("seller-codigo");
  if (cod) cod.disabled = false;
}

function editSeller(codigo) {
  const v = (state.vendedores || []).find(x => String(x.codigo) === String(codigo));
  if (!v) return;
  document.getElementById("seller-codigo").value = v.codigo;
  document.getElementById("seller-codigo").disabled = true;
  document.getElementById("seller-nombre").value = v.nombre;
  document.getElementById("seller-usuario").value = v.usuario;
  document.getElementById("seller-password").value = "";
  document.getElementById("seller-password").placeholder = "Vacío = conservar actual / Nuevo = cambiar";
  document.getElementById("seller-activo").checked = v.activo !== "N";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveVendedor() {
  if (!requireSheetsUrl()) return;
  const codigo = (document.getElementById("seller-codigo")?.value || "").trim();
  const nombre = (document.getElementById("seller-nombre")?.value || "").trim();
  const usuario = (document.getElementById("seller-usuario")?.value || "").trim();
  const password = (document.getElementById("seller-password")?.value || "");
  const activo = document.getElementById("seller-activo")?.checked ? "S" : "N";
  const isNew = !document.getElementById("seller-codigo")?.disabled;
  if (!codigo || !nombre || !usuario || (isNew && !password)) {
    showAlert("Código, nombre, usuario y contraseña son obligatorios.", "warning");
    return;
  }
  const btn = document.getElementById("btn-save-seller");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_vendedor", vendedor: { codigo, nombre, usuario, password, activo } })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Error Sheet");
    showAlert(`Vendedor ${codigo} guardado en Google Sheet.`, "success");
    clearSellerForm();
    await loadVendedores();
  } catch (e) {
    showAlert(`No se pudo guardar: ${e.message}`, "warning");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleSeller(codigo) {
  if (!requireSheetsUrl()) return;
  const v = (state.vendedores || []).find(x => String(x.codigo) === String(codigo));
  if (!v) return;
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_vendedor", vendedor: { codigo: v.codigo, nombre: v.nombre, usuario: v.usuario, password: "", activo: v.activo === "N" ? "S" : "N" } })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Error Sheet");
    showAlert(`Vendedor ${codigo} ${v.activo === "N" ? "activado" : "desactivado"}.`, "success");
    await loadVendedores();
  } catch (e) {
    showAlert(`No se pudo actualizar: ${e.message}`, "warning");
  }
}

async function deleteSeller(codigo) {
  if (!requireSheetsUrl()) return;
  if (!confirm(`¿Eliminar al vendedor ${codigo}? Ya no podrá ingresar.`)) return;
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "delete_vendedor", codigo })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Error Sheet");
    showAlert(`Vendedor ${codigo} eliminado.`, "success");
    await loadVendedores();
  } catch (e) {
    showAlert(`No se pudo eliminar: ${e.message}`, "warning");
  }
}

/**
 * Jerarquías del producto (el ERP las trae como arreglo de 1 objeto).
 */
function prodJer(p) {
  const j = p && p.pro_jerarquias;
  if (Array.isArray(j)) return j[0] || {};
  return j || {};
}

function provCode(p) { return String(prodJer(p).det_provee || "").trim(); }
function catCode(p) { return String(prodJer(p).det_catego || "").trim(); }
function provName(code) { return (state.maestros.proveedores || {})[String(code || "").trim()] || ""; }
function catName(code) { return (state.maestros.categorias || {})[String(code || "").trim()] || ""; }

/**
 * Maestros: códigos del catálogo + nombres del Sheet (hojas Proveedores/Categorias).
 */
function detectMaestroCodes() {
  const provs = {}, cats = {};
  (state.products || []).forEach(p => {
    const pv = provCode(p), ct = catCode(p);
    if (pv) provs[pv] = (provs[pv] || 0) + 1;
    if (ct) cats[ct] = (cats[ct] || 0) + 1;
  });
  const m = state.maestros;
  Object.keys(provs).forEach(c => { if (!(c in m.proveedores)) m.proveedores[c] = ""; });
  Object.keys(cats).forEach(c => { if (!(c in m.categorias)) m.categorias[c] = ""; });
  state._maestroCounts = { provs, cats };
  renderMaestrosTables();
  showAlert(`Detectados ${Object.keys(provs).length} proveedores y ${Object.keys(cats).length} categorías.`, "success");
}

async function loadMaestros() {
  try {
    const cached = localStorage.getItem('ecomdx_maestros');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && (Object.keys(parsed.proveedores || {}).length || Object.keys(parsed.categorias || {}).length)) {
        state.maestros = parsed;
        renderMaestrosTables();
      }
    }
  } catch (e) {}

  if (!state.sheetsUrl || !navigator.onLine) return;
  try {
    const res = await fetch(`${state.sheetsUrl}?action=get_maestros`);
    const json = await res.json();
    if (json.status === "success" && json.maestros) {
      state.maestros = {
        proveedores: json.maestros.proveedores || {},
        categorias: json.maestros.categorias || {}
      };
      try { localStorage.setItem('ecomdx_maestros', JSON.stringify(state.maestros)); } catch (e) {}
      renderMaestrosTables();
    }
  } catch (e) {
    console.warn("maestros offline:", e);
  }
}

function renderMaestrosTables() {
  const pb = document.getElementById('prov-table-body');
  const cb = document.getElementById('cat-table-body');
  if (!pb || !cb) return;
  const counts = state._maestroCounts || { provs: {}, cats: {} };
  const provCodes = Object.keys(state.maestros.proveedores).sort((a, b) => (counts.provs[b] || 0) - (counts.provs[a] || 0));
  const catCodes = Object.keys(state.maestros.categorias).sort((a, b) => (counts.cats[b] || 0) - (counts.cats[a] || 0));
  const pc = document.getElementById('prov-count');
  if (pc) pc.textContent = `(${provCodes.length})`;
  const cc = document.getElementById('cat-count');
  if (cc) cc.textContent = `(${catCodes.length})`;
  pb.innerHTML = provCodes.length ? provCodes.map(c => `
    <tr class="hover:bg-slate-50/75">
      <td class="p-3 font-mono font-bold text-slate-900">${c}</td>
      <td class="p-3 text-center text-slate-500">${counts.provs[c] || 0}</td>
      <td class="p-3"><input type="text" data-prov="${c}" value="${String(state.maestros.proveedores[c] || "").replace(/"/g, '&quot;')}" placeholder="Nombre del proveedor..." class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"></td>
    </tr>`).join('')
    : `<tr><td colspan="3" class="p-8 text-center text-slate-400">Pulsa Detectar códigos del catálogo.</td></tr>`;
  cb.innerHTML = catCodes.length ? catCodes.map(c => `
    <tr class="hover:bg-slate-50/75">
      <td class="p-3 font-mono font-bold text-slate-900">${c}</td>
      <td class="p-3 text-center text-slate-500">${counts.cats[c] || 0}</td>
      <td class="p-3"><input type="text" data-cat="${c}" value="${String(state.maestros.categorias[c] || "").replace(/"/g, '&quot;')}" placeholder="Nombre de la categoría..." class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"></td>
    </tr>`).join('')
    : `<tr><td colspan="3" class="p-8 text-center text-slate-400">Pulsa Detectar códigos del catálogo.</td></tr>`;
}

async function saveMaestros() {
  if (!state.sheetsUrl) {
    showAlert("Primero configura la URL del Google Apps Script.", "warning");
    return;
  }
  const proveedores = [], categorias = [];
  document.querySelectorAll('[data-prov]').forEach(el => {
    proveedores.push({ codigo: el.getAttribute('data-prov'), nombre: el.value.trim() });
  });
  document.querySelectorAll('[data-cat]').forEach(el => {
    categorias.push({ codigo: el.getAttribute('data-cat'), nombre: el.value.trim() });
  });
  if (!proveedores.length && !categorias.length) {
    showAlert("Primero detecta los códigos del catálogo.", "warning");
    return;
  }
  const btn = document.getElementById('btn-save-maestros');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_maestros", proveedores, categorias })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Error Sheet");
    proveedores.forEach(p => { state.maestros.proveedores[p.codigo] = p.nombre; });
    categorias.forEach(c => { state.maestros.categorias[c.codigo] = c.nombre; });
    showAlert("Maestros guardados en Google Sheet.", "success");
    saveCachedSnapshot();
    renderMaestrosTables();
  } catch (e) {
    showAlert(`No se pudo guardar: ${e.message}`, "warning");
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Catálogo cliente: configuración por vendedor. Estas preferencias viven en el
 * panel privado; al publicar se convierten en un paquete estrictamente público.
 */
function loadClientCatalogConfigs() {
  try {
    state.clientCatalogConfigs = JSON.parse(localStorage.getItem('ecomdx_client_catalog_configs') || '{}') || {};
  } catch (e) { state.clientCatalogConfigs = {}; }
}

function clientCatalogSellerList() {
  const sellers = (state.vendedores || []).map(v => ({ code: String(v.codigo || '').trim().toUpperCase(), name: String(v.nombre || '').trim() })).filter(v => v.code);
  const known = Object.keys(state.clientCatalogConfigs || {}).filter(code => !sellers.some(v => v.code === code)).map(code => ({ code, name: '' }));
  return sellers.concat(known);
}

function defaultClientCatalogConfig(code, sellerName) {
  return {
    sellerCode: code,
    sellerName: sellerName || '',
    whatsapp: '',
    sheetsUrl: '',
    headline: 'Descubrí lo que tenemos para vos',
    offer: { enabled: false, image: '', title: 'Oferta especial', cta: 'Ver productos', start: '', end: '' }
  };
}

function currentClientCatalogConfig() {
  const list = clientCatalogSellerList();
  const seller = list.find(s => s.code === state.selectedClientCatalogSeller) || list[0];
  if (!seller) return null;
  const saved = state.clientCatalogConfigs[seller.code] || {};
  return { ...defaultClientCatalogConfig(seller.code, seller.name), ...saved, offer: { ...defaultClientCatalogConfig(seller.code, seller.name).offer, ...(saved.offer || {}) } };
}

function renderClientCatalogEditor() {
  const box = document.getElementById('client-catalog-vendors');
  const sellers = clientCatalogSellerList();
  if (!state.selectedClientCatalogSeller || !sellers.some(s => s.code === state.selectedClientCatalogSeller)) {
    state.selectedClientCatalogSeller = sellers.length ? sellers[0].code : '';
  }
  if (box) {
    box.innerHTML = sellers.length ? sellers.map(s => {
      const active = s.code === state.selectedClientCatalogSeller;
      const hasGs = !!((state.clientCatalogConfigs[s.code] || {}).sheetsUrl || "").trim();
      return `<button onclick="selectClientCatalogSeller('${s.code}')" class="px-3 py-1.5 rounded-full text-xs font-semibold transition flex items-center gap-1.5 ${active ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
        <span class="w-1.5 h-1.5 rounded-full ${hasGs ? 'bg-emerald-400' : 'bg-amber-400'}"></span>
        <span>${s.code}${s.name ? ' • ' + s.name : ''}</span>
      </button>`;
    }).join('') : `<p class="text-xs text-slate-400">Sin vendedores — créalos en la pestaña Vendedores.</p>`;
  }
  if (!sellers.length) {
    ["client-catalog-name", "client-catalog-whatsapp", "client-catalog-headline", "client-catalog-offer-image", "client-catalog-offer-title", "client-catalog-offer-cta", "client-catalog-offer-start", "client-catalog-offer-end", "client-catalog-sheets-url"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { if (el.type === "checkbox") el.checked = false; else el.value = ""; }
    });
    updateClientCatalogPreview(defaultClientCatalogConfig("", ""));
    const link = document.getElementById('client-catalog-link');
    if (link) link.textContent = "";
    return;
  }
  const cfg = currentClientCatalogConfig();
  document.getElementById('client-catalog-name').value = cfg.sellerName || '';
  document.getElementById('client-catalog-whatsapp').value = cfg.whatsapp || '';
  document.getElementById('client-catalog-headline').value = cfg.headline || '';
  const gsInput = document.getElementById('client-catalog-sheets-url');
  if (gsInput && document.activeElement !== gsInput) gsInput.value = cfg.sheetsUrl || '';
  document.getElementById('client-catalog-offer-enabled').checked = Boolean(cfg.offer.enabled);
  document.getElementById('client-catalog-offer-image').value = cfg.offer.image || '';
  autoGrow(document.getElementById('client-catalog-offer-image'));
  document.getElementById('client-catalog-offer-title').value = cfg.offer.title || '';
  document.getElementById('client-catalog-offer-cta').value = cfg.offer.cta || '';
  document.getElementById('client-catalog-offer-start').value = cfg.offer.start || '';
  document.getElementById('client-catalog-offer-end').value = cfg.offer.end || '';
  updateClientCatalogPreview(cfg);
  updateClientCatalogLink();
}

function selectClientCatalogSeller(code) {
  state.selectedClientCatalogSeller = String(code || '').trim().toUpperCase();
  renderClientCatalogEditor();
  pullVendorGsIntoForm();
}

/**
 * Lee el Excel del vendedor (su GS) y prellena el formulario,
 * para ver en el admin lo que hay guardado allá.
 */
async function pullVendorGsIntoForm() {
  const cfg = currentClientCatalogConfig();
  const url = cfg && (cfg.sheetsUrl || "").trim();
  if (!url || !cfg || !cfg.sellerCode) return;
  const st = document.getElementById('client-gs-status');
  try {
    const res = await fetch(`${url}?action=get_public&v=${encodeURIComponent(cfg.sellerCode)}`);
    const json = await res.json();
    if (json.status !== "success" || !json.public) return;
    const pub = json.public;
    const s = pub.seller || {}, o = pub.offer || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    set('client-catalog-name', s.name || '');
    set('client-catalog-whatsapp', String(s.whatsapp || '').replace(/\D/g, ''));
    set('client-catalog-headline', s.headline || '');
    const chk = document.getElementById('client-catalog-offer-enabled');
    if (chk && o.enabled !== undefined) chk.checked = Boolean(o.enabled);
    set('client-catalog-offer-image', o.image || '');
    set('client-catalog-offer-title', o.title || '');
    set('client-catalog-offer-cta', o.cta || '');
    set('client-catalog-offer-start', o.start || '');
    set('client-catalog-offer-end', o.end || '');
    updateClientCatalogDraft();
    if (st) {
      const n = (pub.products || []).length;
      st.textContent = `Su Excel tiene ${n} productos publicados${pub.publishedAt ? ` (${new Date(pub.publishedAt).toLocaleString()})` : ""}.`;
      st.className = "mt-2 text-xs font-semibold text-slate-500";
    }
  } catch (e) {
    if (st) { st.textContent = `No se pudo leer su Excel: ${e.message}`; st.className = "mt-2 text-xs font-semibold text-rose-600"; }
  }
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function updateClientCatalogDraft() {
  const cfg = currentClientCatalogConfig();
  if (!cfg || !cfg.sellerCode) return;
  cfg.sellerName = document.getElementById('client-catalog-name')?.value.trim() || '';
  cfg.whatsapp = (document.getElementById('client-catalog-whatsapp')?.value || '').replace(/\D/g, '');
  cfg.sheetsUrl = (document.getElementById('client-catalog-sheets-url')?.value || '').trim();
  cfg.headline = document.getElementById('client-catalog-headline')?.value.trim() || '';
  cfg.offer = {
    enabled: Boolean(document.getElementById('client-catalog-offer-enabled')?.checked),
    image: (document.getElementById('client-catalog-offer-image')?.value || '').split(/[,\n]+/).map(s => normalizeImageUrl(s)).filter(Boolean).join(', '),
    title: document.getElementById('client-catalog-offer-title')?.value.trim() || '',
    cta: document.getElementById('client-catalog-offer-cta')?.value.trim() || '',
    start: document.getElementById('client-catalog-offer-start')?.value || '',
    end: document.getElementById('client-catalog-offer-end')?.value || ''
  };
  // Nota: no se reescribe el campo al escribir (rompería comas/espacios a medias);
  // la normalización se aplica al leer (arriba) al guardar y publicar.
  state.clientCatalogConfigs[cfg.sellerCode] = cfg;
  updateClientCatalogPreview(cfg);
  updateClientCatalogLink();
}

function updateClientCatalogPreview(cfg) {
  cfg = cfg || defaultClientCatalogConfig("", "");
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('preview-advisor', `Tu asesor: ${cfg.sellerName || cfg.sellerCode || '—'}`);
  set('preview-headline', cfg.headline || 'Descubrí lo que tenemos para vos');
  set('preview-offer-title', cfg.offer.title || 'Oferta especial');
  set('preview-offer-cta', cfg.offer.cta || 'Ver productos');
  const offer = document.getElementById('preview-offer');
  const image = document.getElementById('preview-offer-image');
  if (offer) offer.classList.toggle('hidden', !cfg.offer.enabled);
  if (image) {
    const offerSrc = normalizeImageUrl(cfg.offer.image || '');
    image.classList.toggle('hidden', !offerSrc);
    image.src = offerSrc;
  }
  const plogo = document.getElementById('preview-logo');
  if (plogo) {
    const burl = normalizeImageUrl((state.brandLogo || "").trim());
    if (burl) { plogo.src = burl; plogo.classList.remove('hidden'); }
    else plogo.classList.add('hidden');
  }
  // Vista previa con productos reales del catálogo (sin datos simulados)
  const chipsBox = document.getElementById('preview-chips');
  const prodsBox = document.getElementById('preview-products');
  const withStock = (state.products || []).filter(p => parseFloat(p.pro_invent || 0) > 0);
  const sample = (withStock.length ? withStock : (state.products || [])).slice(0, 2);
  if (chipsBox) {
    const cats = [];
    sample.forEach(p => {
      const j = Array.isArray(p.pro_jerarquias) ? (p.pro_jerarquias[0] || {}) : (p.pro_jerarquias || {});
      const c = String(j.det_catego || '').trim();
      const n = ((state.maestros || {}).categorias || {})[c] || (c ? 'Cat ' + c : '');
      if (n && !cats.includes(n)) cats.push(n);
    });
    chipsBox.innerHTML = `<span class="px-2.5 py-1 text-[10px] font-bold rounded-full bg-slate-900 text-white">Todos</span>` +
      cats.slice(0, 2).map(n => `<span class="px-2.5 py-1 text-[10px] font-bold rounded-full bg-slate-100 text-slate-600">${n}</span>`).join('');
  }
  if (prodsBox) {
    prodsBox.innerHTML = sample.length ? sample.map(p => {
      const code = String(p.pro_codigo || '').trim();
      const img = (((state.images || {})[code] || [])[0]) || '';
      return `<div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div class="aspect-square bg-slate-100 flex items-center justify-center overflow-hidden">${img ? `<img src="${img}" class="w-full h-full object-cover" loading="lazy">` : ''}</div>
        <div class="p-2"><p class="text-[9px] text-blue-700 font-bold">CÓD. ${code}</p><p class="text-[10px] font-bold text-slate-700 mt-1 truncate">${String(p.pro_nombre || '').trim()}</p></div>
      </div>`;
    }).join('') : `<p class="col-span-2 text-[11px] text-slate-400 text-center p-4">Sin productos cargados todavía.</p>`;
  }
}

function clientCatalogUrl(code) {
  const base = `${new URL('../catalogo-cliente/', window.location.href).href}?v=${encodeURIComponent(code)}`;
  const gs = ((state.clientCatalogConfigs[code] || {}).sheetsUrl || "").trim();
  return gs ? `${base}&gs=${encodeURIComponent(gs)}` : base;
}

function updateClientCatalogLink() {
  const el = document.getElementById('client-catalog-link');
  if (el) el.textContent = state.selectedClientCatalogSeller ? clientCatalogUrl(state.selectedClientCatalogSeller) : "";
}

async function saveClientCatalogDraft() {
  const cfg = currentClientCatalogConfig();
  if (!cfg || !cfg.sellerCode) {
    showAlert("Primero crea o selecciona un vendedor para configurar su catálogo.", "warning");
    return;
  }
  updateClientCatalogDraft();
  try { localStorage.setItem('ecomdx_client_catalog_configs', JSON.stringify(state.clientCatalogConfigs)); } catch (e) {}

  const btn = document.getElementById('btn-save-client-draft');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Guardando en Sheet...`;
  }
  const st = document.getElementById('client-gs-status');

  const mainUrl = (state.sheetsUrl || (document.getElementById('input-sheets-url')?.value || "")).trim();
  if (!mainUrl) {
    showAlert('Borrador guardado localmente (sin link de Google Sheet configurado).', 'success');
    renderClientCatalogEditor();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml || `<i class="fa-solid fa-floppy-disk mr-1.5"></i>Guardar borrador`;
    }
    return;
  }

  try {
    const res = await fetch(mainUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "save_client_catalogs",
        configs: state.clientCatalogConfigs
      })
    });
    const json = await res.json();
    if (json.status === "success") {
      showAlert(`Borrador y datos de ${cfg.sellerName || cfg.sellerCode} guardados en Google Sheet con éxito.`, "success");
      if (st) {
        st.textContent = `Guardado localmente y subido al Google Sheet principal (${new Date().toLocaleTimeString()}).`;
        st.className = "mt-2 text-xs font-semibold text-emerald-600";
      }
    } else {
      throw new Error(json.message || "Error al guardar en el Sheet");
    }
  } catch (err) {
    showAlert(`Borrador guardado localmente (aviso Sheet: ${err.message})`, "warning");
    if (st) {
      st.textContent = `Guardado local. Aviso al subir al Sheet: ${err.message}`;
      st.className = "mt-2 text-xs font-semibold text-amber-600";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml || `<i class="fa-solid fa-floppy-disk mr-1.5"></i>Guardar borrador`;
    }
    renderClientCatalogEditor();
  }
}

const saveClientCatalogToMainSheet = saveClientCatalogDraft;

/**
 * Carga las configuraciones de los catálogos cliente de todos los vendedores
 * desde la hoja principal de Google Sheets (pestaña Catalogo_Clientes).
 */
async function loadClientCatalogFromMainSheet(silent = false) {
  const mainUrl = (state.sheetsUrl || (document.getElementById('input-sheets-url')?.value || "")).trim();
  if (!mainUrl) {
    if (!silent) showAlert("No hay URL de Google Sheet principal configurada.", "warning");
    return;
  }
  const btn = document.getElementById('btn-load-client-sheet');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn && !silent) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Cargando...`;
  }
  try {
    const res = await fetch(`${mainUrl}?action=get_client_catalogs`);
    const json = await res.json();
    if (json.status === "success" && json.clientCatalogs) {
      state.clientCatalogConfigs = { ...(state.clientCatalogConfigs || {}), ...json.clientCatalogs };
      try { localStorage.setItem('ecomdx_client_catalog_configs', JSON.stringify(state.clientCatalogConfigs)); } catch (e) {}
      renderClientCatalogEditor();
      if (!silent) showAlert("Configuraciones de catálogos cliente cargadas desde Google Sheet principal.", "success");
    } else {
      throw new Error(json.message || "No se recibieron configuraciones del Sheet");
    }
  } catch (err) {
    if (!silent) showAlert(`Error al cargar del Sheet principal: ${err.message}`, "warning");
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.innerHTML = originalHtml || `<i class="fa-solid fa-arrows-rotate mr-1.5"></i>Recargar del Sheet`;
    }
  }
}

/**
 * Prueba el GS propio del vendedor (script público en su hoja)
 * y publica su catálogo (código, descripción, foto).
 */
async function testClientCatalogGs() {
  const cfg = currentClientCatalogConfig();
  const url = cfg && (cfg.sheetsUrl || "").trim();
  const st = document.getElementById('client-gs-status');
  const paint = (msg, ok) => {
    if (st) {
      st.textContent = msg;
      st.className = "mt-2 text-xs font-semibold " + (ok === true ? "text-emerald-600" : ok === false ? "text-rose-600" : "text-slate-500");
    }
  };
  if (!url) {
    paint("Pega primero el /exec del GS propio de este vendedor.", false);
    showAlert("Pega primero el /exec del GS propio de este vendedor.", "warning");
    return;
  }
  if (!/^https:\/\/script\.google(usercontent)?\.com\/macros\/s\/.+\/exec/.test(url)) {
    paint("Esa URL no parece un /exec válido. Revísala.", false);
    return;
  }
  const btn = document.getElementById('btn-test-client-gs');
  if (btn) btn.disabled = true;
  paint("Probando conexión con su GS...", null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(`${url}?action=get_config`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} (¿despliegue activo?)`);
    let json = null;
    try { json = await res.json(); }
    catch (e) { throw new Error("No devolvió JSON. ¿Es la URL del despliegue web (/exec)?"); }
    if (json.status !== "success") {
      const m = String(json.message || "Respuesta inválida");
      if (/acci[oó]n no disponible/i.test(m)) {
        throw new Error("Ese GS es el público (solo ?action=catalog). Despliega ahí el Code.gs PRINCIPAL como Nueva versión.");
      }
      throw new Error(m + (/no reconocida/i.test(m) ? " Re-despliega el principal como Nueva versión." : ""));
    }
    paint(`Correcto: su GS responde${json.config && json.config.companyName ? ` (${json.config.companyName})` : ""}.`, true);
    showAlert("Su GS responde correctamente.", "success");
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === "AbortError"
      ? "Sin respuesta en 25s (¿internet? ¿URL correcta?)."
      : /failed to fetch/i.test(e.message)
        ? "Sin conexión con Google (¿internet? ¿abierto como archivo local? usa el servidor o hosting)."
        : e.message;
    paint(`Error: ${msg} Revisa despliegue (Nueva versión) y acceso Cualquiera.`, false);
    showAlert(`Su GS no responde: ${msg}`, "warning");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function publishClientCatalogToGs() {
  const cfg = currentClientCatalogConfig();
  const url = cfg && (cfg.sheetsUrl || "").trim();
  if (!url) {
    showAlert("Este vendedor no tiene GS propio configurado.", "warning");
    return;
  }
  const btn = document.getElementById('btn-publish-client-gs');
  const st = document.getElementById('client-gs-status');
  if (btn) btn.disabled = true;
  if (st) { st.textContent = `Publicando catálogo de ${cfg.sellerCode} en su GS...`; st.className = "mt-2 text-xs font-semibold text-slate-500"; }
  try {
    updateClientCatalogDraft();
    // Logo y empresa: los mismos del admin (link público del Sheet principal)
    if ((!state.brandLogo || !state.companyName) && state.sheetsUrl) {
      try {
        const cfgRes = await fetch(`${state.sheetsUrl}?action=get_config`);
        const cfgJson = await cfgRes.json();
        if (cfgJson.status === "success" && cfgJson.config) {
          if (cfgJson.config.companyName) state.companyName = String(cfgJson.config.companyName).trim();
          if (cfgJson.config.logoUrl) state.brandLogo = String(cfgJson.config.logoUrl).trim();
        }
      } catch (e) {}
    }
    const payload = publicClientCatalogPayload();
    if (!payload.products.length) {
      showAlert("No hay productos con inventario disponibles para publicar.", "warning");
      return;
    }
    if (st) { st.textContent = `Borrando productos anteriores y subiendo ${payload.products.length} productos con inventario a su GS...`; st.className = "mt-2 text-xs font-semibold text-slate-500"; }
    // no-cors: el POST de Apps Script redirige y el navegador bloquearía leer
    // la respuesta; se envía igual y se verifica con un GET posterior
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_public", clearAll: true, data: payload })
    });
    await new Promise(r => setTimeout(r, 2000));
    const check = await fetch(`${url}?action=get_public&v=${encodeURIComponent(payload.seller.code)}`);
    const checkJson = await check.json();
    const n = checkJson.status === "success" && checkJson.public ? (checkJson.public.products || []).length : 0;
    if (!n) throw new Error("Su GS no reflejó los datos (¿Nueva versión desplegada con save_public?)");
    if (st) { st.textContent = `Publicado en su GS: ${n} productos con inventario (reemplazo total limpio).`; st.className = "mt-2 text-xs font-semibold text-emerald-600"; }
    showAlert(`Publicado con éxito en su GS: ${n} productos con inventario (productos anteriores eliminados).`, "success");
    // Respaldar automáticamente la configuración del vendedor en el Sheet principal
    if (state.sheetsUrl) {
      saveClientCatalogToMainSheet(true).catch(() => {});
    }
  } catch (e) {
    if (st) { st.textContent = `Error: ${e.message}`; st.className = "mt-2 text-xs font-semibold text-rose-600"; }
    showAlert(`No se pudo publicar en su GS: ${e.message}`, "warning");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function publicClientCatalogPayload() {
  const cfg = currentClientCatalogConfig() || {};
  const hierarchy = (p) => Array.isArray(p.pro_jerarquias) ? (p.pro_jerarquias[0] || {}) : (p.pro_jerarquias || {});
  
  // Subir ÚNICAMENTE productos que tienen inventario > 0 (sin exponer la cifra de inventario)
  const products = (state.products || [])
    .filter(p => parseFloat(p.pro_invent || 0) > 0)
    .map(p => {
      const h = hierarchy(p);
      const code = String(p.pro_codigo || '').trim();
      return {
        code,
        name: String(p.pro_nombre || '').trim(),
        image: ((state.images || {})[code] || [])[0] || '',
        category: String(h.det_catego || '').trim(),
        supplier: String(h.det_provee || '').trim(),
        categoryName: ((state.maestros.categorias || {})[String(h.det_catego || '').trim()] || ''),
        supplierName: ((state.maestros.proveedores || {})[String(h.det_provee || '').trim()] || '')
      };
    }).filter(p => p.code && p.name);

  return {
    version: '1.0.0',
    publishedAt: new Date().toISOString(),
    clearAll: true,
    seller: { code: cfg.sellerCode || '', name: cfg.sellerName || '', whatsapp: cfg.whatsapp || '', headline: cfg.headline || '' },
    company: { name: state.companyName || '', logo: state.brandLogo || '' },
    offer: cfg.offer || { enabled: false },
    products
  };
}

async function copyClientCatalogLink() {
  if (!state.selectedClientCatalogSeller) {
    showAlert("Primero crea vendedores para generar su enlace.", "warning");
    return;
  }
  updateClientCatalogDraft();
  const link = clientCatalogUrl(state.selectedClientCatalogSeller);
  try { await navigator.clipboard.writeText(link); showAlert('Enlace copiado. Compártelo con los clientes de este vendedor.', 'success'); }
  catch (e) { showAlert(`Copia este enlace: ${link}`, 'info'); }
}

/**
 * Respaldo de configuración (exportar/importar archivo local).
 * Incluye links privados: archivo sensible, no compartir.
 */
function exportConfigBackup() {
  const data = {
    app: "admin-portal",
    version: "1.0.0",
    exportedAt: new Date().toISOString(),
    sheetsUrl: state.sheetsUrl || "",
    downloadLinks: { ...API_ENDPOINTS, vendors: VENDOR_ENDPOINTS },
    companyName: state.companyName || "",
    brandLogo: state.brandLogo || "",
    devWhatsapp: state.devWhatsapp || "",
    clientCatalogConfigs: state.clientCatalogConfigs || {}
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `respaldo_config_admin_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showAlert("Respaldo exportado. Guárdelo en un lugar seguro.", "success");
}

function importConfigBackup(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== "object" || data.app !== "admin-portal") {
        throw new Error("Archivo inválido (no es respaldo del admin).");
      }
      if (data.sheetsUrl) {
        state.sheetsUrl = String(data.sheetsUrl).trim();
        try { localStorage.setItem('ecomdx_sheets_url', state.sheetsUrl); } catch (e) {}
        const urlInput = document.getElementById('input-sheets-url');
        if (urlInput) urlInput.value = state.sheetsUrl;
      }
      if (data.downloadLinks) setDownloadLinksCache(data.downloadLinks);
      if (data.companyName !== undefined) {
        state.companyName = String(data.companyName || "");
        state.brandLogo = String(data.brandLogo || "");
        try { localStorage.setItem('ecomdx_company_config', JSON.stringify({ companyName: state.companyName, logoUrl: state.brandLogo })); } catch (e) {}
        applyCompanyName();
      }
      if (data.devWhatsapp !== undefined) {
        state.devWhatsapp = String(data.devWhatsapp || "").replace(/\D/g, "");
        try { localStorage.setItem('ecomdx_dev_whatsapp', state.devWhatsapp); } catch (e) {}
        const devInput = document.getElementById('input-dev-whatsapp');
        if (devInput) devInput.value = state.devWhatsapp;
      }
      if (data.clientCatalogConfigs) {
        state.clientCatalogConfigs = data.clientCatalogConfigs;
        try { localStorage.setItem('ecomdx_client_catalog_configs', JSON.stringify(state.clientCatalogConfigs)); } catch (e) {}
      }
      renderConfigStatus();
      if (state.activeTab === 'client-catalog') renderClientCatalogEditor();
      closeSetupChoice();
      maybeShowFirstRun();
      showAlert("Respaldo importado. Verifique en Configuración y sincronice.", "success");
    } catch (e) {
      showAlert(`No se pudo importar: ${e.message}`, "warning");
    } finally {
      input.value = "";
    }
  };
  reader.readAsText(file);
}
function applyCompanyName() {
  const name = (state.companyName || "").trim();
  const h1 = document.getElementById('admin-company-name');
  if (h1) h1.textContent = name || "Tu empresa";
  document.title = name ? `${name} | Panel de Administración del Catálogo` : `Panel de Administración del Catálogo`;
  const input = document.getElementById('input-company-name');
  if (input && document.activeElement !== input && !input.value) input.value = state.companyName || "";
  const logoInput = document.getElementById('input-logo-url');
  if (logoInput && document.activeElement !== logoInput && !logoInput.value) logoInput.value = state.brandLogo || "";
  const logo = document.getElementById('admin-logo');
  const fallback = document.getElementById('admin-logo-fallback');
  const preview = document.getElementById('brand-preview');
  // Logo desde la misma carpeta del admin (no por link): logo-castro.png
  const repoLogos = ['./logo-castro.png', '../images/logo-castro.png', '../images/logo.png'];
  if (preview) {
    preview.onerror = () => preview.classList.add('hidden');
    preview.src = repoLogos[0];
    preview.classList.remove('hidden');
  }
  const welcomeBadge = document.getElementById('welcome-badge-company');
  if (welcomeBadge) welcomeBadge.textContent = name || "Tu empresa";
  const welcomeLogo = document.getElementById('welcome-logo');
  const welcomeFallback = document.getElementById('welcome-logo-fallback');
  const showRepoLogo = (img, fb) => {
    if (!img) return;
    img.dataset.repoIdx = '0';
    img.onerror = () => {
      const i = parseInt(img.dataset.repoIdx || '0', 10);
      if (i < repoLogos.length) {
        img.dataset.repoIdx = String(i + 1);
        img.src = repoLogos[i];
      } else {
        img.onerror = null;
        img.classList.add('hidden');
        if (fb) fb.classList.remove('hidden');
      }
    };
    img.src = repoLogos[0];
    img.classList.remove('hidden');
    if (fb) fb.classList.add('hidden');
  };
  showRepoLogo(welcomeLogo, welcomeFallback);

  if (logo && fallback) {
    logo.dataset.repoIdx = '0';
    logo.onerror = () => {
      const i = parseInt(logo.dataset.repoIdx || '0', 10);
      if (i < repoLogos.length) {
        logo.dataset.repoIdx = String(i + 1);
        logo.src = repoLogos[i];
      } else {
        logo.onerror = null;
        logo.classList.add('hidden');
        fallback.classList.remove('hidden');
      }
    };
    logo.src = repoLogos[0];
    logo.classList.remove('hidden');
    fallback.classList.add('hidden');
  }
}

/**
 * Nombre de empresa: caché local + Sheet.
 */

async function loadCompanyName() {
  try {
    const cached = localStorage.getItem('ecomdx_company_config');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.companyName) state.companyName = parsed.companyName;
      if (parsed.logoUrl) state.brandLogo = parsed.logoUrl;
      applyCompanyName();
    }
  } catch (e) {}

  if (!state.sheetsUrl || !navigator.onLine) return;
  try {
    const res = await fetch(`${state.sheetsUrl}?action=get_config`);
    const json = await res.json();
    if (json.status === "success" && json.config) {
      if (json.config.companyName) state.companyName = String(json.config.companyName).trim();
      state.brandLogo = String(json.config.logoUrl || "").trim();
      try { localStorage.setItem('ecomdx_company_config', JSON.stringify({ companyName: state.companyName, logoUrl: state.brandLogo })); } catch (e) {}
      applyCompanyName();
    }
  } catch (e) {
    console.warn("company offline:", e);
  }
}

async function saveCompanyName() {
  const name = (document.getElementById('input-company-name')?.value || "").trim();
  const logoUrl = normalizeImageUrl((document.getElementById('input-logo-url')?.value || "").trim());
  const logoInput = document.getElementById('input-logo-url');
  if (logoInput && logoInput.value.trim() !== logoUrl) logoInput.value = logoUrl;
  if (!name) {
    showAlert("Escriba el nombre de la empresa.", "warning");
    return;
  }
  if (!state.sheetsUrl) {
    showAlert("Primero configure el link en Configuración.", "warning");
    return;
  }
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "save_config", config: { companyName: name, logoUrl } })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Error Sheet");
    state.companyName = name;
    state.brandLogo = logoUrl;
    try { localStorage.setItem('ecomdx_company_config', JSON.stringify({ companyName: name, logoUrl })); } catch (e) {}
    applyCompanyName();
    showAlert("Marca guardada. Se mostrará en preventa y catálogo de clientes.", "success");
  } catch (e) {
    showAlert(`No se pudo guardar: ${e.message}`, "warning");
  }
}

/**
 * Primer uso en el navegador: solicita nombre y logo, y los guarda en caché.
 */
function maybeShowFirstRun() {
  let has = false;
  try {
    const raw = localStorage.getItem('ecomdx_company_config');
    if (raw) {
      const j = JSON.parse(raw);
      has = !!(j && (j.companyName || j.logoUrl));
    }
  } catch (e) {}
  if (!has && !(state.companyName || "").trim() && !(state.brandLogo || "").trim()) {
    const m = document.getElementById('first-run-modal');
    if (m) m.classList.remove('hidden');
  }
}

function closeFirstRun() {
  document.getElementById('first-run-modal')?.classList.add('hidden');
  applyCompanyName();
}

/**
 * Carga inicial guiada: con el link recién guardado, trae todo
 * (empresa, links, vendedores, maestros, catálogo y fotos) con progreso.
 */
function prepStep(boxId, id, label) {
  const box = document.getElementById(boxId || 'prep-steps');
  if (!box) return;
  let row = document.getElementById(id);
  if (!row || row.parentElement !== box) {
    row = document.createElement('div');
    row.id = id;
    row.className = "flex items-center gap-2.5 text-xs p-2.5 rounded-xl bg-slate-50 border border-slate-100";
    box.appendChild(row);
  }
  row.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-blue-500"></i><span class="font-medium text-slate-600">${label}...</span>`;
  return row;
}

function prepDone(id, ok, detail) {
  const row = document.getElementById(id);
  if (!row) return;
  row.className = `flex items-center gap-2.5 text-xs p-2.5 rounded-xl ${ok ? "bg-emerald-50 border border-emerald-100" : "bg-rose-50 border border-rose-100"}`;
  row.innerHTML = `<i class="fa-solid ${ok ? "fa-circle-check text-emerald-500" : "fa-circle-exclamation text-rose-500"}"></i><span class="font-medium ${ok ? "text-emerald-800" : "text-rose-800"}">${detail}</span>`;
}

/**
 * Primeros pasos dentro de la misma ventana: guarda el link y
 * prepara todo (empresa, links, vendedores, maestros, catálogo y fotos).
 */
async function startSetupWithLink() {
  const url = (document.getElementById('setup-sheets-url')?.value || "").trim();
  const btn = document.getElementById('btn-setup-start');
  if (!url) {
    showAlert("Pegue la URL del Google Apps Script (/exec).", "warning");
    return;
  }
  state.sheetsUrl = url;
  try { localStorage.setItem('ecomdx_sheets_url', url); } catch (e) {}
  const cfgInput = document.getElementById('input-sheets-url');
  if (cfgInput) cfgInput.value = url;
  if (btn) btn.disabled = true;
  document.getElementById('setup-steps').innerHTML = '';

  prepStep('setup-steps', 'ss-company', 'Empresa y marca');
  try {
    await loadCompanyName();
    prepDone('ss-company', !!(state.companyName || "").trim(), (state.companyName || "").trim() || "Sin nombre en el Sheet");
  } catch (e) { prepDone('ss-company', false, "No se pudo leer"); }

  prepStep('setup-steps', 'ss-links', 'Links de descarga');
  try {
    await loadDownloadLinks();
    const n = ["products", "clients", "discounts", "cabys"].filter(k => (API_ENDPOINTS[k] || "").trim()).length;
    const nv = Object.keys(VENDOR_ENDPOINTS || {}).length;
    prepDone('ss-links', n === 4 || nv > 0, `${n}/4 genéricos • ${nv} vendedor(es) con links`);
  } catch (e) { prepDone('ss-links', false, "No se pudieron leer"); }

  prepStep('setup-steps', 'ss-sellers', 'Vendedores');
  try {
    await loadVendedores();
    prepDone('ss-sellers', true, `${(state.vendedores || []).length} vendedor(es)`);
  } catch (e) { prepDone('ss-sellers', false, "No se pudieron cargar"); }

  prepStep('setup-steps', 'ss-catalog', 'Maestros y catálogo');
  try {
    await loadMaestros();
    await syncAllApis();
    // Primer arranque en frío del Sheet puede fallar: reintentar una vez si quedó vacío
    if ((state.products.length === 0 || state.clients.length === 0) && navigator.onLine) {
      await new Promise(r => setTimeout(r, 2000));
      await syncAllApis();
    }
    prepDone('ss-catalog', state.products.length > 0, `${state.products.length} prod. • ${state.clients.length} cli. • ${Object.keys(state.images || {}).length} fotos`);
  } catch (e) { prepDone('ss-catalog', false, String(e.message || e)); }

  if (btn) btn.disabled = false;
  maybeShowFirstRun();
}

async function runFirstLoad() {
  const modal = document.getElementById('prep-modal');
  const box = document.getElementById('prep-steps');
  const close = document.getElementById('prep-close');
  if (box) box.innerHTML = '';
  if (close) close.classList.add('hidden');
  if (modal) modal.classList.remove('hidden');

  prepStep('prep-steps', 'ps-company', 'Empresa y marca');
  try {
    await loadCompanyName();
    prepDone('ps-company', !!(state.companyName || "").trim(), (state.companyName || "").trim() || "Sin nombre en el Sheet");
  } catch (e) { prepDone('ps-company', false, "No se pudo leer"); }

  prepStep('prep-steps', 'ps-links', 'Links de descarga');
  try {
    await loadDownloadLinks();
    const n = ["products", "clients", "discounts", "cabys"].filter(k => (API_ENDPOINTS[k] || "").trim()).length;
    const nv = Object.keys(VENDOR_ENDPOINTS || {}).length;
    prepDone('ps-links', n === 4 || nv > 0, `${n}/4 genéricos • ${nv} vendedor(es) con links`);
  } catch (e) { prepDone('ps-links', false, "No se pudieron leer"); }

  prepStep('prep-steps', 'ps-sellers', 'Vendedores');
  try {
    await loadVendedores();
    prepDone('ps-sellers', true, `${(state.vendedores || []).length} vendedor(es)`);
  } catch (e) { prepDone('ps-sellers', false, "No se pudieron cargar"); }

  prepStep('prep-steps', 'ps-masters', 'Maestros y catálogo');
  try {
    await loadMaestros();
    await syncAllApis();
    if ((state.products.length === 0 || state.clients.length === 0) && navigator.onLine) {
      await new Promise(r => setTimeout(r, 2000));
      await syncAllApis();
    }
    prepDone('ps-masters', state.products.length > 0, `${state.products.length} prod. • ${state.clients.length} cli. • ${Object.keys(state.images || {}).length} fotos`);
  } catch (e) { prepDone('ps-masters', false, String(e.message || e)); }

  if (close) close.classList.remove('hidden');
}
function maybeShowSetupChoice() {
  if (state.sheetsUrl) return;
  const m = document.getElementById('setup-choice-modal');
  if (m) m.classList.remove('hidden');
}

function closeSetupChoice() {
  document.getElementById('setup-choice-modal')?.classList.add('hidden');
}

async function saveFirstRunBrand() {
  const name = (document.getElementById('first-company-name')?.value || "").trim();
  const logoUrl = normalizeImageUrl((document.getElementById('first-logo-url')?.value || "").trim());
  const err = document.getElementById('first-run-error');
  if (!name) {
    if (err) { err.textContent = "Escriba el nombre de la empresa para continuar."; err.classList.remove('hidden'); }
    return;
  }
  state.companyName = name;
  state.brandLogo = logoUrl;
  try { localStorage.setItem('ecomdx_company_config', JSON.stringify({ companyName: name, logoUrl })); } catch (e) {}
  closeFirstRun();
  if (state.sheetsUrl && navigator.onLine) {
    try {
      await fetch(state.sheetsUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "save_config", config: { companyName: name, logoUrl } })
      });
    } catch (e) {}
  }
}

function saveDevWhatsapp() {
  const num = (document.getElementById('input-dev-whatsapp')?.value || "").replace(/\D/g, "");
  if (!num) {
    showAlert("Escriba el WhatsApp del desarrollador (solo números, con código de país).", "warning");
    return;
  }
  state.devWhatsapp = num;
  try { localStorage.setItem('ecomdx_dev_whatsapp', num); } catch (e) {}
  showAlert("WhatsApp del desarrollador guardado en este equipo.", "success");
}

function notifyDeveloper(kind) {
  if (!state.devWhatsapp) {
    showAlert("Primero configure el WhatsApp del desarrollador en Configuración.", "warning");
    switchTab('config');
    return;
  }
  const now = new Date().toLocaleString();
  const company = (state.companyName || "").trim() || "mi empresa";
  let msg = "";
  if (kind === 'clientes') {
    const cfg = (typeof currentClientCatalogConfig === "function") ? currentClientCatalogConfig() : null;
    const n = Object.keys(state.clientCatalogConfigs || {}).length;
    msg = `Hola, soy del panel administrativo (${company}). Solicito SUBIR cambios del CATÁLOGO DE CLIENTES (${now}): ` +
      `${n} vendedor(es) configurado(s)` +
      (cfg && cfg.sellerCode ? `, actual: ${cfg.sellerCode} ${cfg.sellerName || ''}`.trim() : "") +
      `. Quedo atento a la confirmación.`;
  } else {
    const withPhoto = state.products.filter(p => state.images[p.pro_codigo] && state.images[p.pro_codigo].length > 0).length;
    msg = `Hola, soy del panel administrativo (${company}). Solicito SUBIR cambios del catálogo preventa (${now}): ` +
      `${state.products.length} productos (${withPhoto} con foto), ` +
      `${state.clients.length} clientes, ${state.discounts.length} descuentos, ` +
      `${Object.keys(state.cabysMap).length} CABYS, ${(state.vendedores || []).length} vendedores. ` +
      `Quedo atento a la confirmación.`;
  }
  window.open(`https://wa.me/${state.devWhatsapp}?text=${encodeURIComponent(msg)}`, "_blank");
}

/**
 * Normaliza links de Drive (vista /file/d/...) a imagen directa,
 * igual que las fotos de productos. El archivo debe estar compartido
 * ("Cualquier persona con el enlace").
 */
function normalizeImageUrl(url) {
  const u = String(url || "").trim();
  if (!u) return u;
  let m = u.match(/drive\.google\.com\/file\/d\/([^/]+)/)
    || u.match(/drive\.google\.com\/open\?.*[?&]id=([^&]+)/)
    || u.match(/drive\.google\.com\/uc\?.*[?&]id=([^&]+)/)
    || u.match(/drive\.google\.com\/thumbnail\?id=([^&]+)/);
  if (m && m[1]) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w2000`;
  return u;
}
function openPhotoPreview(url, code, name) {
  document.getElementById('preview-img').src = normalizeImageUrl(url);
  document.getElementById('preview-title').textContent = `${code} - ${name}`;
  document.getElementById('preview-subtitle').textContent = `Resolución HD original`;
  document.getElementById('photo-preview-modal').classList.remove('hidden');
}

function closePhotoPreview() {
  document.getElementById('photo-preview-modal').classList.add('hidden');
}

/**
 * Utilidades
 */
function setSyncStatus(msg) {
  const el = document.getElementById('sync-status-msg');
  if (el) el.textContent = msg;
}

/**
 * Borra TODA la caché vieja del navegador para cargar todo desde cero.
 * Incluye datos, fotos, rutas de vendedores, borradores y cachés del
 * service worker. La URL del Sheet se conserva para poder volver a descargar.
 */
async function clearAllCache() {
  const keys = [
    'ecomdx_published_catalog',
    'ecomdx_images',
    'ecomdx_download_links',
    'ecomdx_selected_client_code',
    'ecomdx_client_catalog_configs',
    'ecomdx_vendor_catalog',
    'ecomdx_vendedor_session',
    'ecomdx_vendor_refresh_ts',
    'ecomdx_brand_logo_data'
  ];
  keys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });

  // Cachés del service worker (archivos y fotos guardadas)
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names
        .filter(n => /ecomdx|castro/i.test(n))
        .map(n => caches.delete(n)));
    }
  } catch (e) {}

  // Limpiar almacenamiento persistente IndexedDB
  try {
    await idbDelete('published_catalog');
    await idbDelete('images');
  } catch (e) {}

  state.products = [];
  state.clients = [];
  state.discounts = [];
  state.cabysMap = {};
  state.images = {};
  state.vendorData = {};
  state.vendorClients = {};
  state.vendorCounts = {};
  state.clientCatalogConfigs = {};
  state.selectedClientCatalogSeller = '';
  VENDOR_ENDPOINTS = {};
  API_ENDPOINTS = { products: "", clients: "", discounts: "", cabys: "" };

  const lastRun = document.getElementById('sync-last-run');
  if (lastRun) lastRun.textContent = 'Pendiente';
  setSyncStatus('Caché borrada. Presiona Actualizar Información para cargar todo desde cero.');
  logSync("Caché del navegador borrada por el administrador.");
  updateDashboardUI();
  renderPhotosTable();
  renderClientsTable();
  renderSellersTable();
  renderMaestrosTables();
  renderClientCatalogEditor();
  showAlert("Caché borrada. Ahora presiona Actualizar Información para cargar todo desde cero.", "success");
}

function logSync(msg) {
  const consoleEl = document.getElementById('sync-console-log');
  if (!consoleEl) return;
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.textContent = `[${time}] ${msg}`;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function clearSyncLog() {
  const consoleEl = document.getElementById('sync-console-log');
  if (consoleEl) consoleEl.innerHTML = '';
}

function showAlert(message, type = 'info') {
  const banner = document.getElementById('alert-banner');
  const msgEl = document.getElementById('alert-message');
  const icon = document.getElementById('alert-icon');
  if (!banner) return;

  msgEl.textContent = message;
  banner.className = 'mb-6 p-4 rounded-xl text-xs flex items-center justify-between transition-all ';

  if (type === 'success') {
    banner.classList.add('bg-emerald-50', 'text-emerald-800', 'border', 'border-emerald-200');
    icon.className = 'fa-solid fa-circle-check text-emerald-600';
  } else if (type === 'warning') {
    banner.classList.add('bg-amber-50', 'text-amber-800', 'border', 'border-amber-200');
    icon.className = 'fa-solid fa-triangle-exclamation text-amber-600';
  } else {
    banner.classList.add('bg-blue-50', 'text-blue-800', 'border', 'border-blue-200');
    icon.className = 'fa-solid fa-circle-info text-blue-600';
  }

  banner.classList.remove('hidden');
  setTimeout(() => hideAlert(), 6000);
}

function hideAlert() {
  const banner = document.getElementById('alert-banner');
  if (banner) banner.classList.add('hidden');
}

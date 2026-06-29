// ── API Base URL ──────────────────────────────────────────────
// Dynamically detect API URL to support different environments
const API_BASE = (() => {
  const { protocol, hostname, host } = window.location;
  const configuredBase = window.__CLN_API_BASE__;

  if (configuredBase) {
    return configuredBase.replace(/\/$/, '') + '/api';
  }

  // If frontend is opened as a local file, target local backend.
  if (protocol === 'file:') {
    return 'http://localhost:5000/api';
  }

  // In local dev, use the local backend. Preserve same-origin when already on :5000.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    if (host.endsWith(':5000')) {
      return `${protocol}//${host}/api`;
    }

    return `${protocol}//${hostname}:5000/api`;
  }

  // In production, use same-origin API.
  return `${protocol}//${host}/api`;
})();

// Base URL for serving uploads (same host as API without the /api suffix)
const UPLOADS_BASE = API_BASE.replace(/\/api$/i, '');

// ── Theme controls ─────────────────────────────────────────────
const THEME_STORAGE_KEY = 'cln_theme';

function getStoredTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY);
}

function getResolvedTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeToggleButtons() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? 'Light' : 'Dark';
  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.textContent = label;
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  updateThemeToggleButtons();
}

function svgIcon(inner) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
}

const ICON_SVG = {
  chartColumn: svgIcon('<path d="M4 20V10"/><path d="M4 20H20"/><path d="M8 20V7"/><path d="M12 20V4"/><path d="M16 20v-9"/>'),
  users: svgIcon('<path d="M17 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-1A4.5 4.5 0 0 0 7 19.5V21"/><circle cx="11.5" cy="8" r="3.5"/><path d="M19 21v-1a3.5 3.5 0 0 0-2.5-3.35"/><path d="M16.5 4.75a3 3 0 0 1 0 5.9"/>'),
  clipboardList: svgIcon('<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5h6v3H9z"/><path d="M8 11h8"/><path d="M8 15h8"/>'),
  briefcase: svgIcon('<path d="M10 7V6a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 12h18"/><path d="M9 12v2h6v-2"/>'),
  fileLines: svgIcon('<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 12h6"/><path d="M9 16h6"/>'),
  chartLine: svgIcon('<path d="M4 19h16"/><path d="M6 16l4-4 3 3 5-7"/><path d="M18 8h-3"/><path d="M18 8v3"/>'),
  search: svgIcon('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.5-3.5"/>'),
  clock: svgIcon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
  user: svgIcon('<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>'),
  envelope: svgIcon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>'),
  lock: svgIcon('<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  arrowLeft: svgIcon('<path d="M10 6 4 12l6 6"/><path d="M4 12h16"/>'),
  plus: svgIcon('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  checkCircle: svgIcon('<circle cx="12" cy="12" r="9"/><path d="m8 12 2.8 2.8L16 9.5"/>'),
  xCircle: svgIcon('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>'),
  download: svgIcon('<path d="M12 3v10"/><path d="m8 10 4 4 4-4"/><path d="M5 20h14"/>'),
  rotateLeft: svgIcon('<path d="M4 4v6h6"/><path d="M20 20a8.5 8.5 0 1 1 0-12"/>'),
  logout: svgIcon('<path d="M10 17l5-5-5-5"/><path d="M15 12H4"/><path d="M20 4v16"/>'),
  bars: svgIcon('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  hourglass: svgIcon('<path d="M6 4h12"/><path d="M6 20h12"/><path d="M8 4c0 3 4 4 4 8s-4 5-4 8"/><path d="M16 4c0 3-4 4-4 8s4 5 4 8"/>'),
  eye: svgIcon('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
  eyeOff: svgIcon('<path d="M3 3l18 18"/><path d="M10.5 10.5a2.5 2.5 0 1 0 3 3"/><path d="M6.2 6.2C3.9 7.9 2 12 2 12s3.5 6 10 6c1.3 0 2.5-.2 3.6-.6"/><path d="M14.6 4.6C13.8 4.2 12.9 4 12 4c-6.5 0-10 8-10 8a20.1 20.1 0 0 0 4.8 5.7"/>'),
  upload: svgIcon('<path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M4 20h16"/>'),
  folder: svgIcon('<path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  bank: svgIcon('<path d="M4 10h16"/><path d="M6 10V7l6-3 6 3v3"/><path d="M5 20h14"/><path d="M7 20v-7"/><path d="M12 20v-7"/><path d="M17 20v-7"/>'),
  cube: svgIcon('<path d="M12 2 4 6v12l8 4 8-4V6z"/><path d="M12 2v8l8-4"/><path d="M4 6l8 4 8-4"/>'),
  calculator: svgIcon('<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="16" y1="14" x2="16" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>'),
  message: svgIcon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')
};

const LUCIDE_MAP = {
  chartColumn: 'layout-dashboard',
  users: 'users',
  clipboardList: 'clipboard-list',
  briefcase: 'briefcase',
  fileLines: 'file-text',
  chartLine: 'line-chart',
  search: 'search',
  clock: 'clock',
  user: 'user',
  info: 'info',
  envelope: 'mail',
  lock: 'lock',
  arrowLeft: 'arrow-left',
  plus: 'plus',
  checkCircle: 'check-circle',
  xCircle: 'x-circle',
  download: 'download',
  rotateLeft: 'rotate-ccw',
  logout: 'log-out',
  bars: 'menu',
  hourglass: 'hourglass',
  eye: 'eye',
  eyeOff: 'eye-off',
  upload: 'upload',
  folder: 'folder',
  bank: 'landmark',
  cube: 'box',
  calculator: 'calculator',
  message: 'message-square'
};

function iconMarkup(name) {
  if (window.lucide) {
    const lucideName = LUCIDE_MAP[name] || name;
    return `<i data-lucide="${lucideName}"></i>`;
  }
  return ICON_SVG[name] || ICON_SVG.chartColumn;
}

window.clnIcon = iconMarkup;

const ICON_TEXT_MAP = new Map([
  ['📊', 'chartColumn'],
  ['👥', 'users'],
  ['📋', 'clipboardList'],
  ['💼', 'briefcase'],
  ['📄', 'fileLines'],
  ['📈', 'chartLine'],
  ['🔎', 'search'],
  ['🕒', 'clock'],
  ['👤', 'user'],
  ['ℹ️', 'info'],
  ['📧', 'envelope'],
  ['🔐', 'lock'],
  ['🔙', 'arrowLeft'],
  ['➕', 'plus'],
  ['✅', 'checkCircle'],
  ['❌', 'xCircle'],
  ['📥', 'download'],
  ['↺', 'rotateLeft'],
  ['🚪', 'logout'],
  ['☰', 'bars'],
  ['⏳', 'hourglass'],
  ['🏦', 'bank'],
  ['📁', 'folder'],
  ['📤', 'upload'],
  ['show', 'eye'],
  ['hide', 'eyeOff'],
  ['l', 'briefcase'],
  ['a', 'checkCircle'],
  ['c', 'users'],
  ['search', 'search'],
  ['cln', 'bank'],
  ['🧮', 'calculator'],
  ['💬', 'message']
]);

function resolveIconName(el) {
  const rawText = (el.textContent || '').trim();
  const normalized = rawText.toLowerCase();

  if (el.classList.contains('logo-icon')) return 'bank';
  if (el.classList.contains('search-icon')) return 'search';
  // Check if the element itself or its parent is the toggle-password button
  const toggleBtn = el.classList.contains('toggle-password') ? el : el.closest('.toggle-password');
  if (toggleBtn) return toggleBtn.classList.contains('visible') ? 'eyeOff' : 'eye';

  if (ICON_TEXT_MAP.has(rawText)) return ICON_TEXT_MAP.get(rawText);
  if (ICON_TEXT_MAP.has(normalized)) return ICON_TEXT_MAP.get(normalized);

  if (el.classList.contains('stat-icon')) {
    if (rawText === 'L') return 'briefcase';
    if (rawText === 'A') return 'checkCircle';
    if (rawText === 'C') return 'users';
  }

  return null;
}

function applyIconography(root = document) {
  if (window.lucide) {
    try {
      window.lucide.createIcons();
    } catch (err) {
      console.error('Lucide error:', err);
    }
  }

  const selector = '.emoji, .emoji-sm, .nav-icon, .stat-icon, .search-icon, .upload-icon, .empty-icon, .logo-icon, .toggle-password .eye-icon';
  const elements = root.querySelectorAll ? root.querySelectorAll(selector) : [];

  elements.forEach((el) => {
    if (el.querySelector('svg') || el.querySelector('i[data-lucide]')) return;
    // Skip .toggle-password buttons that already have SVG rendered directly inside them
    const parentToggle = el.closest ? el.closest('.toggle-password') : null;
    if (parentToggle && parentToggle.querySelector('svg')) return;
    const iconName = resolveIconName(el);
    if (!iconName) return;
    el.innerHTML = iconMarkup(iconName);
    el.dataset.iconized = iconName;
  });

  if (window.lucide) {
    try {
      window.lucide.createIcons();
    } catch (err) {}
  }
}

function applyActionButtonIcons(root = document) {
  const buttons = root.querySelectorAll ? root.querySelectorAll('.logout-btn, .mobile-menu-btn') : [];

  buttons.forEach((button) => {
    if (button.dataset.iconized === 'true') return;
    if (button.classList.contains('logout-btn')) {
      button.innerHTML = `${iconMarkup('logout')}<span>Logout</span>`;
      button.setAttribute('aria-label', 'Logout');
    } else if (button.classList.contains('mobile-menu-btn')) {
      button.innerHTML = `${iconMarkup('bars')}<span>Menu</span>`;
      button.setAttribute('aria-label', 'Open menu');
    }
    button.dataset.iconized = 'true';
  });

  if (window.lucide && buttons.length > 0) {
    try {
      window.lucide.createIcons();
    } catch (err) {}
  }
}

const THREE_CDN_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
let threeLibraryPromise = null;
let modelViewerState = null;

function isAdminPage() {
  return window.location.pathname.startsWith('/admin/');
}

function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing && existing.dataset.loaded === 'true') {
      resolve();
      return;
    }

    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

async function ensureThreeLibrary() {
  if (window.THREE) return window.THREE;
  if (!threeLibraryPromise) {
    threeLibraryPromise = loadExternalScript(THREE_CDN_URL);
  }
  await threeLibraryPromise;
  return window.THREE;
}

function createModelViewerButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-sm model-viewer-btn';
  btn.innerHTML = `${iconMarkup('cube')}<span>3D Model</span>`;
  btn.setAttribute('aria-label', 'Open 3D model viewer');
  btn.addEventListener('click', openModelViewer);
  return btn;
}

function ensureModelViewerModal() {
  let overlay = document.getElementById('model-viewer-overlay');
  if (overlay) return overlay;
  if (!isAdminPage()) return null;

  overlay = document.createElement('div');
  overlay.className = 'modal-overlay model-viewer-overlay';
  overlay.id = 'model-viewer-overlay';
  overlay.innerHTML = `
    <div class="model-viewer-dock" role="dialog" aria-modal="true" aria-labelledby="model-viewer-title">
      <div class="model-viewer-dock-header">
        <div>
          <p class="model-viewer-kicker">Admin-only scene</p>
          <h3 id="model-viewer-title">3D Model</h3>
        </div>
        <button class="modal-close" type="button" data-close-model-viewer aria-label="Close 3D viewer">Close</button>
      </div>
      <div class="model-viewer-stage">
        <div class="model-viewer-canvas" id="model-viewer-canvas"></div>
        <div class="model-viewer-hud">
          <span>Drag</span>
          <span>Zoom</span>
          <span>Reset</span>
        </div>
      </div>
      <div class="model-viewer-dock-footer">
        <button class="btn btn-secondary btn-sm" type="button" data-reset-model-viewer>Reset view</button>
        <button class="btn btn-secondary btn-sm" type="button" data-close-model-viewer>Close</button>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeModelViewer();
  });
  overlay.querySelectorAll('[data-close-model-viewer]').forEach((button) => {
    button.addEventListener('click', closeModelViewer);
  });
  overlay.querySelector('[data-reset-model-viewer]')?.addEventListener('click', resetModelViewer);
  document.body.appendChild(overlay);
  return overlay;
}

function buildAvatarModel(THREE) {
  const group = new THREE.Group();

  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xf7cdbd, roughness: 0.42, metalness: 0.015 });
  const hairMaterial = new THREE.MeshStandardMaterial({ color: 0x5a345d, roughness: 0.66, metalness: 0.04 });
  const clothingMaterial = new THREE.MeshStandardMaterial({ color: 0x6b89d6, roughness: 0.7, metalness: 0.04 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0xffb6d0, roughness: 0.28, metalness: 0.08, emissive: 0x361323, emissiveIntensity: 0.08 });
  const blushMaterial = new THREE.MeshStandardMaterial({ color: 0xff9dbf, roughness: 0.55, metalness: 0.02, transparent: true, opacity: 0.7 });
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1a2f, roughness: 0.3, metalness: 0.06 });
  const eyeWhiteMaterial = new THREE.MeshStandardMaterial({ color: 0xfdf9f7, roughness: 0.45, metalness: 0.01 });
  const lipMaterial = new THREE.MeshStandardMaterial({ color: 0xde6b8a, roughness: 0.44, metalness: 0.01 });

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.12, 1.9, 32, 1, true), clothingMaterial);
  torso.position.y = -1.52;
  group.add(torso);

  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(1.26, 32, 24, 0, Math.PI * 2, 0, Math.PI / 2.2), clothingMaterial);
  shoulders.scale.set(1.0, 0.6, 0.84);
  shoulders.position.y = -0.65;
  group.add(shoulders);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.5, 18), skinMaterial);
  neck.position.y = 0.15;
  group.add(neck);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.88, 40, 32), skinMaterial);
  face.position.y = 1.02;
  face.scale.set(1.03, 1.12, 0.92);
  group.add(face);

  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.96, 40, 32), hairMaterial);
  hairCap.position.set(0, 1.16, -0.05);
  hairCap.scale.set(1.0, 0.98, 0.95);
  group.add(hairCap);

  const sideHairLeft = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 8, 16), hairMaterial);
  sideHairLeft.position.set(-0.72, 0.9, -0.02);
  sideHairLeft.rotation.z = 0.15;
  group.add(sideHairLeft);

  const sideHairRight = sideHairLeft.clone();
  sideHairRight.position.x = 0.72;
  sideHairRight.rotation.z = -0.15;
  group.add(sideHairRight);

  const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.94, 32, 24), hairMaterial);
  backHair.position.set(0, 0.92, -0.22);
  backHair.scale.set(1.05, 1.12, 0.95);
  group.add(backHair);

  const topBunLeft = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 16), hairMaterial);
  topBunLeft.position.set(-0.34, 1.62, -0.02);
  group.add(topBunLeft);

  const topBunRight = topBunLeft.clone();
  topBunRight.position.x = 0.34;
  group.add(topBunRight);

  const bowLeft = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), accentMaterial);
  bowLeft.position.set(-0.12, 1.64, 0.54);
  bowLeft.scale.set(1.2, 0.8, 0.45);
  group.add(bowLeft);

  const bowRight = bowLeft.clone();
  bowRight.position.x = 0.12;
  group.add(bowRight);

  const bowCenter = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 12), accentMaterial);
  bowCenter.position.set(0, 1.64, 0.56);
  bowCenter.scale.set(0.65, 0.65, 0.5);
  group.add(bowCenter);

  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), eyeMaterial);
  leftEye.position.set(-0.25, 1.0, 0.75);
  group.add(leftEye);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.23;
  group.add(rightEye);
  const leftHighlight = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), eyeWhiteMaterial);
  leftHighlight.position.set(-0.21, 1.03, 0.83);
  group.add(leftHighlight);
  const rightHighlight = leftHighlight.clone();
  rightHighlight.position.x = 0.26;
  group.add(rightHighlight);

  const leftLash = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.02), eyeMaterial);
  leftLash.position.set(-0.25, 1.12, 0.72);
  leftLash.rotation.z = -0.12;
  group.add(leftLash);
  const rightLash = leftLash.clone();
  rightLash.position.x = 0.25;
  rightLash.rotation.z = 0.12;
  group.add(rightLash);

  const blushLeft = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), blushMaterial);
  blushLeft.position.set(-0.42, 0.82, 0.68);
  blushLeft.scale.set(1.2, 0.8, 0.6);
  group.add(blushLeft);
  const blushRight = blushLeft.clone();
  blushRight.position.x = 0.42;
  group.add(blushRight);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), skinMaterial);
  nose.position.set(0, 0.88, 0.82);
  nose.scale.set(1.0, 0.8, 0.7);
  group.add(nose);

  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 10, 20, Math.PI), lipMaterial);
  smile.position.set(0, 0.72, 0.82);
  smile.rotation.z = Math.PI;
  group.add(smile);

  const necklaceChain = new THREE.Group();
  [0.02, -0.03, 0.05].forEach((yOffset, index) => {
    const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(index === 2 ? 0.1 : 0.08, 0), accentMaterial);
    gem.position.set(0, 0.0 - index * 0.2, 0.74 - index * 0.06);
    gem.rotation.set(index * 0.3, index * 0.5, index * 0.2);
    necklaceChain.add(gem);
  });
  necklaceChain.position.set(0, 0.06, 0);
  group.add(necklaceChain);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.07, 16, 36), clothingMaterial);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.34, 0.1);
  group.add(collar);

  const glow = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.02, 12, 64), new THREE.MeshStandardMaterial({ color: 0xffc5dd, roughness: 0.34, metalness: 0.08, emissive: 0x6f2c58, emissiveIntensity: 0.15 }));
  glow.rotation.x = Math.PI / 2;
  glow.position.set(0, 0.12, -0.92);
  group.add(glow);

  group.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return group;
}

function initializeModelViewer() {
  const overlay = ensureModelViewerModal();
  if (!overlay) return null;

  const canvasHost = overlay.querySelector('#model-viewer-canvas');
  if (!canvasHost) return null;

  if (modelViewerState) {
    modelViewerState.canvasHost = canvasHost;
    if (modelViewerState.renderer && modelViewerState.renderer.domElement.parentElement !== canvasHost) {
      canvasHost.innerHTML = '';
      canvasHost.appendChild(modelViewerState.renderer.domElement);
    }
    modelViewerState.resize?.();
    return modelViewerState;
  }

  modelViewerState = {
    canvasHost,
    renderer: null,
    scene: null,
    camera: null,
    frameId: null,
    avatar: null,
    floatingRing: null,
    sparkleGroup: null,
    rotation: { x: -0.04, y: 0.3 },
    drag: { active: false, startX: 0, startY: 0, rotationX: 0, rotationY: 0 },
    zoom: 4.1,
    resize: null,
    reset: null,
    destroy: null
  };

  ensureThreeLibrary().then((THREE) => {
    if (!modelViewerState || modelViewerState.scene) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1220);
    scene.fog = new THREE.Fog(0x0a1220, 6, 12);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.55, 4.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(1, 1, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvasHost.innerHTML = '';
    canvasHost.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0x9ec1ff, 2.5);
    keyLight.position.set(4, 5, 6);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffd4ad, 1.5);
    fillLight.position.set(-4, 1.5, 4);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0x5dd4c7, 1.6);
    rimLight.position.set(0, 3, -5);
    scene.add(rimLight);

    const avatar = buildAvatarModel(THREE);
    avatar.position.y = -0.22;
    scene.add(avatar);

    const floatingRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.15, 0.04, 16, 96),
      new THREE.MeshStandardMaterial({ color: 0x213a61, roughness: 0.3, metalness: 0.18, emissive: 0x0d1c31, emissiveIntensity: 0.25 })
    );
    floatingRing.rotation.x = Math.PI / 2;
    floatingRing.position.y = -0.18;
    scene.add(floatingRing);

    const sparkleGroup = new THREE.Group();
    for (let i = 0; i < 10; i += 1) {
      const sparkle = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.04 + (i % 3) * 0.01, 0),
        new THREE.MeshStandardMaterial({ color: 0xa5d6ff, roughness: 0.25, metalness: 0.35, emissive: 0x14304f, emissiveIntensity: 0.45 })
      );
      const angle = (Math.PI * 2 * i) / 10;
      sparkle.position.set(Math.cos(angle) * 2.7, 1.6 + Math.sin(i) * 0.25, Math.sin(angle) * 0.65);
      sparkle.rotation.set(i * 0.2, i * 0.3, i * 0.4);
      sparkleGroup.add(sparkle);
    }
    scene.add(sparkleGroup);

    const state = modelViewerState;
    state.scene = scene;
    state.camera = camera;
    state.renderer = renderer;
    state.avatar = avatar;
    state.floatingRing = floatingRing;
    state.sparkleGroup = sparkleGroup;

    state.reset = () => {
      state.rotation.x = 0;
      state.rotation.y = 0;
      state.zoom = 4.4;
      camera.position.set(0, 0.74, state.zoom);
      avatar.rotation.set(0, 0, 0);
      if (renderer) renderer.render(scene, camera);
    };

    state.resize = () => {
      const rect = canvasHost.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      renderer.setSize(rect.width, rect.height, false);
      renderer.render(scene, camera);
    };

    state.destroy = () => {
      if (state.frameId) cancelAnimationFrame(state.frameId);
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };

    const onPointerDown = (event) => {
      state.drag.active = true;
      state.drag.startX = event.clientX;
      state.drag.startY = event.clientY;
      state.drag.rotationX = state.rotation.x;
      state.drag.rotationY = state.rotation.y;
      canvasHost.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event) => {
      if (!state.drag.active) return;
      const deltaX = (event.clientX - state.drag.startX) * 0.006;
      const deltaY = (event.clientY - state.drag.startY) * 0.005;
      state.rotation.y = state.drag.rotationY + deltaX;
      state.rotation.x = Math.max(-0.35, Math.min(0.25, state.drag.rotationX + deltaY));
    };

    const onPointerUp = (event) => {
      state.drag.active = false;
      canvasHost.releasePointerCapture?.(event.pointerId);
    };

    const onWheel = (event) => {
      event.preventDefault();
      state.zoom = Math.max(3.2, Math.min(6.0, state.zoom + event.deltaY * 0.002));
    };

    renderer.domElement.classList.add('model-viewer-canvas-element');
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    const animate = () => {
      if (!modelViewerState || modelViewerState.scene !== scene) return;
      state.frameId = requestAnimationFrame(animate);
      avatar.rotation.y += (state.rotation.y - avatar.rotation.y) * 0.12;
      avatar.rotation.x += (state.rotation.x - avatar.rotation.x) * 0.12;
      avatar.position.y = -0.22 + Math.sin(Date.now() * 0.0012) * 0.02;
      floatingRing.rotation.z += 0.0018;
      sparkleGroup.rotation.y += 0.0015;
      camera.position.z += (state.zoom - camera.position.z) * 0.08;
      camera.lookAt(0, 0.72, 0.2);
      renderer.render(scene, camera);
    };

    window.addEventListener('resize', state.resize);
    state.resize();
    animate();
  }).catch((err) => {
    const host = overlay.querySelector('#model-viewer-canvas');
    if (host) {
      host.innerHTML = `<div class="model-viewer-error">${err.message || 'Failed to load 3D viewer.'}</div>`;
    }
  });

  return modelViewerState;
}

function openModelViewer() {
  if (!isAdminPage()) return;
  const overlay = ensureModelViewerModal();
  if (!overlay) return;
  overlay.classList.add('show');
  initializeModelViewer();
  requestAnimationFrame(() => {
    modelViewerState?.resize?.();
  });
}

function closeModelViewer() {
  const overlay = document.getElementById('model-viewer-overlay');
  if (!overlay) return;
  overlay.classList.remove('show');
}

function resetModelViewer() {
  modelViewerState?.reset?.();
}

let iconObserverStarted = false;

function startIconObserver() {
  if (iconObserverStarted || !document.body || !window.MutationObserver) return;
  iconObserverStarted = true;

  const observer = new MutationObserver((mutations) => {
    let ranLucide = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        applyIconography(node);
        applyActionButtonIcons(node);
        if (window.lucide) ranLucide = true;
      }
    }
    if (ranLucide) {
      try {
        window.lucide.createIcons();
      } catch (err) {}
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function createThemeToggleButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-sm theme-toggle';
  btn.addEventListener('click', toggleTheme);
  return btn;
}

function mountThemeToggle() {
  if (document.querySelector('.topbar')) {
    const topbar = document.querySelector('.topbar');
    let actions = topbar.querySelector('.topbar-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'topbar-actions';
      topbar.appendChild(actions);
    }
    const themeToggle = actions.querySelector('.theme-toggle');

    if (!themeToggle) {
      const createdThemeToggle = createThemeToggleButton();
      actions.prepend(createdThemeToggle);
    }
  } else if (!document.querySelector('.theme-toggle-floating')) {
    const floatingBtn = createThemeToggleButton();
    floatingBtn.classList.add('theme-toggle-floating');
    document.body.appendChild(floatingBtn);
  }

  updateThemeToggleButtons();
}

function initTheme() {
  applyTheme(getResolvedTheme());
  mountThemeToggle();
  applyIconography();
  applyActionButtonIcons();
  startIconObserver();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      registration.unregister();
    });
  }).catch(() => {});

  if (window.caches && typeof window.caches.keys === 'function') {
    window.caches.keys().then((keys) => {
      keys.forEach((key) => window.caches.delete(key));
    }).catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTheme);
} else {
  initTheme();
}

registerServiceWorker();

// ── Token helpers ─────────────────────────────────────────────
const getToken = () => localStorage.getItem('cln_token');
const getUser  = () => JSON.parse(localStorage.getItem('cln_user') || 'null');

const setSession = (token, user) => {
  localStorage.setItem('cln_token', token);
  localStorage.setItem('cln_user', JSON.stringify(user));
};

const clearSession = () => {
  localStorage.removeItem('cln_token');
  localStorage.removeItem('cln_user');
};

// ── Core fetch wrapper ────────────────────────────────────────
async function apiRequest(method, path, body = null, isFormData = false) {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const opts = { method, headers };
  if (body) opts.body = isFormData ? body : JSON.stringify(body);

  try {
    const res = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json().catch(() => ({ message: res.statusText }));

    if (res.status === 401) {
      clearSession();
      window.location.href = '/index.html';
      return;
    }

    if (res.status === 403) {
      const user = getUser();
      if (user && user.role === 'employee') {
        clearSession();
        localStorage.setItem('login_error', data?.message || 'Access denied. Account is inactive or outside working hours.');
        window.location.href = '/index.html';
        return;
      }
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, data: { message: 'Network error. Is the server running?' } };
  }
}

const api = {
  get:    (path)         => apiRequest('GET',    path),
  post:   (path, body)   => apiRequest('POST',   path, body),
  put:    (path, body)   => apiRequest('PUT',    path, body),
  patch:  (path, body)   => apiRequest('PATCH',  path, body),
  delete: (path)         => apiRequest('DELETE', path),
  upload: (path, form)   => apiRequest('POST',   path, form, true),
  // Expose base URLs for other UI code
  base: API_BASE,
  uploadsBase: UPLOADS_BASE,
};

// ── Auth guard ────────────────────────────────────────────────
function requireRole(role) {
  const user = getUser();
  if (!getToken() || !user) {
    window.location.href = '/index.html';
    return null;
  }
  if (role && user.role !== role) {
    window.location.href = '/index.html';
    return null;
  }
  return user;
}

// ── Render sidebar user ───────────────────────────────────────
function renderSidebarUser() {
  const user = getUser();
  if (!user) return;
  const nameEl   = document.getElementById('sidebar-user-name');
  const roleEl   = document.getElementById('sidebar-user-role');
  const avatarEl = document.getElementById('sidebar-user-avatar');
  if (nameEl) nameEl.textContent = user.name;
  if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Administrator' : user.role;

  if (avatarEl) {
    const pic = user.profile_picture;
    if (pic) {
      avatarEl.style.backgroundImage = `url('${pic}')`;
      avatarEl.style.backgroundSize  = 'cover';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = user.name.charAt(0).toUpperCase();
    }
  }

  // Make user-info block clickable → profile page
  const userInfoEl = document.querySelector('.user-info');
  if (userInfoEl && !userInfoEl.dataset.profileLinked) {
    userInfoEl.dataset.profileLinked = '1';
    userInfoEl.style.cursor = 'pointer';
    userInfoEl.title = 'View Profile';
    userInfoEl.addEventListener('click', () => {
      const role = user.role;
      window.location.href = role === 'admin' ? '/admin/profile.html' : '/employee/profile.html';
    });
  }

  // Note: profile picture is read from the cached cln_user object in localStorage.
  // Call refreshSidebarAvatar() from profile pages after uploading a new avatar.
}

// ── Refresh sidebar avatar from localStorage cache ────────────
function refreshSidebarAvatar(profilePicUrl) {
  const avatarEl = document.getElementById('sidebar-user-avatar');
  if (!avatarEl) return;
  if (profilePicUrl) {
    avatarEl.style.backgroundImage = `url('${profilePicUrl}')`;
    avatarEl.style.backgroundSize  = 'cover';
    avatarEl.style.backgroundPosition = 'center';
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    const user = getUser();
    avatarEl.textContent = user ? user.name.charAt(0).toUpperCase() : '?';
  }
  // Persist to localStorage cln_user
  const user = getUser();
  if (user) {
    user.profile_picture = profilePicUrl || null;
    localStorage.setItem('cln_user', JSON.stringify(user));
  }
}

// ── FormData POST helper (uses correct cln_token key) ─────────
async function apiPostForm(endpoint, formData) {
  try {
    const token = getToken();
    const resp = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401) { clearSession(); window.location.href = '/index.html'; return; }
    if (resp.status === 403) {
      const user = getUser();
      if (user && user.role === 'employee') {
        clearSession();
        localStorage.setItem('login_error', data?.message || 'Access denied. Account is inactive or outside working hours.');
        window.location.href = '/index.html';
        return;
      }
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) { return { ok: false, data: { message: err.message } }; }
}

// ── Logout ────────────────────────────────────────────────────
async function logout() {
  try {
    await api.post('/auth/logout');
  } catch (err) {}
  clearSession();
  window.location.href = '/index.html';
}

// ── Mobile Sidebar Toggle ─────────────────────────────────────
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  
  if (sidebar) {
    sidebar.classList.toggle('mobile-open');
  }
  
  if (overlay) {
    overlay.classList.toggle('show');
  }
}

// Close sidebar when a nav item is clicked (for mobile)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.querySelector('.sidebar-overlay');
      
      if (window.innerWidth <= 768) {
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.remove('show');
      }
    });
  });
});

// ── Show toast-style alert ────────────────────────────────────
function showAlert(id, message, type = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `alert alert-${type} show`;
  el.textContent = message;
  if (type !== 'error') setTimeout(() => { el.classList.remove('show'); }, 4000);
}

// ── Format helpers ────────────────────────────────────────────
function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 0 });
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata'
  });
}

function statusBadge(status) {
  const cls = {
    Pending: 'badge-pending',
    'Under Review': 'badge-under-review',
    'Documents Pending': 'badge-documents-pending',
    Approved: 'badge-approved',
    'Loan Disbursed': 'badge-loan-disbursed',
    Cancelled: 'badge-cancelled',
    Rejected: 'badge-rejected',
    Hold: 'badge-hold',
    ABND: 'badge-abnd',
    Other: 'badge-other'
  };
  return `<span class="badge ${cls[status] || ''}">${status}</span>`;
}

function buildQueryString(params) {
  const qs = Object.entries(params).filter(([,v]) => v).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return qs ? `?${qs}` : '';
}

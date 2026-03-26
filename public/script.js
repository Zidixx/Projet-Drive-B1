/**
 * Drive – logique côté client (menus + multi-organisations local)
 */
(function () {
  let token = localStorage.getItem('drive_token');
  if (!token) {
    window.location.href = '/';
    return;
  }

  const api = (path, options = {}) => {
    const headers = { ...options.headers, Authorization: 'Bearer ' + token };
    return fetch(path, { ...options, headers });
  };

  function updateToken(newTok) {
    if (newTok) {
      token = newTok;
      localStorage.setItem('drive_token', token);
    }
  }

  async function switchBackendOrganization(orgIdStr) {
    const id = parseInt(String(orgIdStr), 10);
    if (!id || Number.isNaN(id)) return;
    try {
      const res = await api('/organizations/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: id }),
      });
      const data = await res.json();
      if (!res.ok) return;
      if (data.token) updateToken(data.token);
      await loadMe();
      await loadBackendData();
      renderList();
      renderStorage();
    } catch (e) {
      console.warn('switch org', e);
    }
  }

  const LS_ORGS = 'drive_org_memberships_v1';
  const LS_ACTIVE_CONTEXT = 'drive_active_context_v1';
  const LS_CONTEXT_DATA = 'drive_context_data_v1';
  const LS_PROTECTED_ITEMS = 'drive_protected_items_v1';
  const LS_SETTINGS = 'drive_ui_settings_v1';
  const LS_THEME = 'drive_theme_v1';

  let currentUser = { id: null, email: null, role: null, org_id: null, organization: null };
  let currentView = 'accueil';
  let activeContext = localStorage.getItem(LS_ACTIVE_CONTEXT) || 'personal';
  let selectedOrgSettingsId = null;
  let orgMemberships = [];
  let contextData = {};
  let backendFolders = [];
  let backendFiles = [];
  let backendTrashFiles = [];
  let backendStorage = null;
  let totalStorage = null;
  let activeFolderId = null;
  let protectedItems = {};
  let contextMenuTarget = null;
  let contextMenuMode = 'contextmenu';
  let passwordModalState = null;
  let longPressSuppressNextOpen = false;
  let moveModalTarget = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function roleRank(role) {
    if (role === 'PDG' || role === 'OWNER') return 3;
    if (role === 'ADMIN') return 2;
    return 1;
  }

  function canManageMembers(org) {
    return roleRank((org && org.role) || 'MEMBRE') >= 2;
  }

  function canManageOrg(org) {
    return roleRank((org && org.role) || 'MEMBRE') >= 3;
  }

  function genId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.round(Math.random() * 1e6);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s || '';
    return div.innerHTML;
  }

  function formatDate(d) {
    if (!d) return '–';
    return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatSize(bytes) {
    if (bytes == null || bytes === 0) return '–';
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
    return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
  }

  function loadProtectionState() {
    const raw = localStorage.getItem(LS_PROTECTED_ITEMS);
    protectedItems = raw ? JSON.parse(raw) : {};
  }

  function saveProtectionState() {
    localStorage.setItem(LS_PROTECTED_ITEMS, JSON.stringify(protectedItems));
  }

  function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function randomSaltHex() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return toHex(bytes.buffer);
  }

  async function hashPassword(password, saltHex) {
    const normalized = String(password || '');
    const payload = new TextEncoder().encode(saltHex + ':' + normalized);
    const digest = await window.crypto.subtle.digest('SHA-256', payload);
    return toHex(digest);
  }

  function protectionKey(contextId, itemType, itemId) {
    return String(contextId) + '::' + String(itemType) + '::' + String(itemId);
  }

  function getProtectionEntry(contextId, itemType, itemId) {
    return protectedItems[protectionKey(contextId, itemType, itemId)] || null;
  }

  function isItemProtected(itemType, item) {
    if (!item) return false;
    return !!getProtectionEntry(activeContext, itemType, item.id);
  }

  function setItemProtection(itemType, itemId, entry) {
    protectedItems[protectionKey(activeContext, itemType, itemId)] = entry;
    saveProtectionState();
  }

  function clearItemProtection(itemType, itemId) {
    delete protectedItems[protectionKey(activeContext, itemType, itemId)];
    saveProtectionState();
  }

  function saveMemberships() {
    localStorage.setItem(LS_ORGS, JSON.stringify(orgMemberships));
  }

  function saveContextData() {
    localStorage.setItem(LS_CONTEXT_DATA, JSON.stringify(contextData));
  }

  function getContextMeta(contextId) {
    if (contextId === 'personal') return { label: 'Mon Drive', role: null, isOrg: false };
    const m = orgMemberships.find((o) => String(o.id) === String(contextId));
    if (!m) return { label: 'Organisation', role: null, isOrg: true };
    return { label: m.name, role: m.role, isOrg: true, org: m };
  }

  function ensureContextBucket(contextId) {
    if (!contextData[contextId]) contextData[contextId] = { folders: [], files: [], trash: [] };
    return contextData[contextId];
  }

  function isBackendContext() {
    return activeContext === 'personal' || (currentUser.org_id && String(activeContext) === String(currentUser.org_id));
  }

  function getCurrentData() {
    if (isBackendContext()) {
      return {
        folders: backendFolders,
        files: backendFiles,
        trash: backendTrashFiles,
      };
    }
    return ensureContextBucket(String(activeContext));
  }

  async function loadMe() {
    const r = await api('/me');
    if (r.status === 401) {
      localStorage.removeItem('drive_token');
      window.location.href = '/';
      return;
    }
    const data = await r.json();
    if (!data || !data.user) return;
    currentUser = data.user;

    hydrateMembershipsFromUser();
    if (activeContext !== 'personal' && !orgMemberships.some((o) => String(o.id) === String(activeContext))) {
      activeContext = 'personal';
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
    }
    updateUserUi();
    renderOrgSidebar();
    renderSettingsOrganizations();
  }

  /** Si le contexte local dit « org X » mais le JWT n’est pas encore aligné, l’API renvoie vide et isBackendContext() est faux → liste vide sans message. On aligne le token avant loadBackendData. */
  async function ensureOrgSync() {
    if (activeContext === 'personal') return;
    if (!orgMemberships.some((o) => String(o.id) === String(activeContext))) return;
    if (String(currentUser.org_id || '') === String(activeContext)) return;
    const id = parseInt(String(activeContext), 10);
    if (!id || Number.isNaN(id)) return;
    try {
      const res = await api('/organizations/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: id }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) return;
      updateToken(data.token);
      await loadMe();
    } catch (e) {
      console.warn('ensureOrgSync', e);
    }
  }

  function hydrateMembershipsFromUser() {
    const rawCtx = localStorage.getItem(LS_CONTEXT_DATA);
    contextData = rawCtx ? JSON.parse(rawCtx) : {};

    if (Array.isArray(currentUser.organizations)) {
      const prevRaw = localStorage.getItem(LS_ORGS);
      const prev = prevRaw ? JSON.parse(prevRaw) : [];
      const byId = {};
      prev.forEach((o) => {
        byId[String(o.id)] = o;
      });
      orgMemberships = currentUser.organizations.map((o) => {
        const old = byId[String(o.id)];
        const role = o.role || 'MEMBRE';
        return {
          id: String(o.id),
          name: o.name,
          code: o.code != null && o.code !== '' ? String(o.code) : old && old.code ? old.code : '----',
          role,
          members:
            old && old.members && old.members.length
              ? old.members
              : [
                  {
                    id: currentUser.id || 'me',
                    email: currentUser.email || localStorage.getItem('drive_email') || 'moi',
                    role,
                  },
                ],
        };
      });
      saveMemberships();
      return;
    }

    const raw = localStorage.getItem(LS_ORGS);
    orgMemberships = raw ? JSON.parse(raw) : [];
    if (currentUser.org_id) {
      const exists = orgMemberships.some((o) => String(o.id) === String(currentUser.org_id));
      if (!exists) {
        orgMemberships.unshift({
          id: String(currentUser.org_id),
          name: currentUser.organization ? currentUser.organization.name : 'Organisation',
          code: currentUser.organization ? currentUser.organization.code || '----' : '----',
          role: currentUser.role === 'PDG' ? 'PDG' : 'MEMBRE',
          members: [
            {
              id: currentUser.id || 'me',
              email: currentUser.email || localStorage.getItem('drive_email') || 'moi',
              role: currentUser.role === 'PDG' ? 'PDG' : 'MEMBRE',
            },
          ],
        });
      }
    }
    saveMemberships();
  }

  function updateUserUi() {
    const banner = document.getElementById('noOrgBanner');
    if (banner) banner.style.display = orgMemberships.length === 0 ? 'block' : 'none';
    const avatar = document.getElementById('userAvatar');
    const email = currentUser.email || localStorage.getItem('drive_email') || '';
    if (avatar) avatar.textContent = (email.charAt(0) || 'U').toUpperCase();
    const profileEmailEl = document.getElementById('profileEmail');
    if (profileEmailEl) profileEmailEl.textContent = email || '—';
    const profileRoleEl = document.getElementById('profileRole');
    const meta = getContextMeta(activeContext);
    if (profileRoleEl) {
      const roleTxt = meta.isOrg ? (meta.role || 'MEMBRE') : 'Drive personnel';
      profileRoleEl.textContent = roleTxt + ' · ' + meta.label;
    }
    const monOrgBtn = document.getElementById('menuProfileOrg');
    if (monOrgBtn) monOrgBtn.style.display = orgMemberships.length > 0 ? '' : 'none';
  }

  async function loadBackendData() {
    try {
      const scope = String(activeContext) === 'personal' ? 'personal' : 'org';
      const [foldersRes, filesRes, trashRes, storageRes, totalStorageRes] = await Promise.all([
        api('/folders?scope=' + encodeURIComponent(scope)),
        api('/api/files?scope=' + encodeURIComponent(scope)),
        api('/api/files?trash=1&scope=' + encodeURIComponent(scope)),
        api('/api/storage?scope=' + encodeURIComponent(scope)),
        api('/api/storage?scope=all'),
      ]);
      backendFolders = foldersRes.ok ? (await foldersRes.json()).folders || [] : [];
      backendFiles = filesRes.ok ? (await filesRes.json()).files || [] : [];
      backendTrashFiles = trashRes.ok ? (await trashRes.json()).files || [] : [];
      backendStorage = storageRes.ok ? await storageRes.json() : null;
      totalStorage = totalStorageRes.ok ? await totalStorageRes.json() : null;
    } catch (e) {
      backendFolders = [];
      backendFiles = [];
      backendTrashFiles = [];
      backendStorage = null;
    }
  }

  function renderStorage() {
    const bar = document.getElementById('storageBarInner');
    const text = document.getElementById('storageText');
    if (totalStorage) {
      const used = totalStorage.usedBytes || 0;
      const limit = totalStorage.limitBytes || 15 * 1024 * 1024 * 1024;
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = (totalStorage.usedFormatted || '0 o') + ' utilisés sur ' + (totalStorage.limitFormatted || '15 Go');
      return;
    }
    const ctx = getCurrentData();
    const used = (ctx.files || []).reduce((acc, f) => acc + (f.size || 0), 0);
    const limit = 15 * 1024 * 1024 * 1024;
    const pct = Math.min(100, (used / limit) * 100);
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = formatSize(used) + ' utilisés sur 15 Go';
  }

  function setMainTitle() {
    const titles = {
      accueil: 'Accueil',
      'mon-drive': activeContext === 'personal' ? 'Mon Drive' : getContextMeta(activeContext).label,
      partages: 'Mes organisations',
      'org-settings': 'Paramètres de l’organisation',
      recents: 'Récents',
      corbeille: 'Corbeille',
    };
    const mainTitleText = document.getElementById('mainTitleText');
    if (mainTitleText) mainTitleText.textContent = titles[currentView] || 'Drive';
  }

  function setView(view) {
    currentView = view;
    if (view !== 'mon-drive') activeFolderId = null;
    document.querySelectorAll('.nav-item[data-view]').forEach((el) => el.classList.remove('active'));
    const nav = document.querySelector('.nav-item[data-view="' + view + '"]');
    if (nav) nav.classList.add('active');
    setMainTitle();
    const tableWrap = document.querySelector('.table-wrap');
    const toolbar = document.querySelector('.toolbar');
    const orgPage = document.getElementById('orgSettingsPage');
    if (view === 'org-settings') {
      if (tableWrap) tableWrap.style.display = 'none';
      if (toolbar) toolbar.style.display = 'none';
      if (orgPage) orgPage.classList.add('open');
      renderOrgSettingsPage();
    } else {
      if (tableWrap) tableWrap.style.display = '';
      if (toolbar) toolbar.style.display = '';
      if (orgPage) orgPage.classList.remove('open');
      renderList();
    }
    renderStorage();
  }

  function renderOrgSidebar() {
    const box = document.getElementById('orgNavList');
    if (!box) return;
    box.innerHTML = '';
    orgMemberships.forEach((org) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'org-nav-item' + (String(activeContext) === String(org.id) ? ' active' : '');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 7V3H2v18h20V7H12z"/></svg>
        <span>${escapeHtml(org.name)}</span>
      `;
      btn.addEventListener('click', async () => {
        activeContext = String(org.id);
        localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
        selectedOrgSettingsId = null;
        setView('mon-drive');
        updateUserUi();
        renderOrgSidebar();
        await switchBackendOrganization(org.id);
      });
      box.appendChild(btn);
    });
  }

  function getDisplayCollections() {
    const data = getCurrentData();
    const search = (document.getElementById('searchInput') || {}).value || '';
    const q = search.trim().toLowerCase();
    let folders = data.folders || [];
    let files = data.files || [];
    let trash = data.trash || [];

    if (q) {
      folders = folders.filter((f) => (f.name || '').toLowerCase().includes(q));
      files = files.filter((f) => (f.original_name || '').toLowerCase().includes(q));
      trash = trash.filter((f) => (f.original_name || '').toLowerCase().includes(q));
    }
    return { folders, files, trash };
  }

  function renderList() {
    const tbody = document.getElementById('filesTable');
    if (!tbody) return;
    const emptyRow = tbody.querySelector('.empty-row');
    const emptyMessage = document.getElementById('emptyMessage');
    const emptyHint = document.getElementById('emptyHint');
    if (!emptyRow) return;
    const collections = getDisplayCollections();
    const emptyBtn = document.getElementById('btnEmptyTrash');
    if (emptyBtn) {
      const shouldShow = currentView === 'corbeille';
      emptyBtn.style.display = shouldShow ? '' : 'none';
      emptyBtn.disabled = !shouldShow || (collections.trash || []).length === 0;
      emptyBtn.style.opacity = emptyBtn.disabled ? '0.55' : '';
    }

    let foldersToShow = [];
    let filesToShow = [];
    if (currentView === 'corbeille') {
      filesToShow = collections.trash;
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier dans la corbeille.';
      if (emptyHint) emptyHint.textContent = 'Les fichiers supprimés apparaissent ici.';
    } else if (currentView === 'recents') {
      const combined = [
        ...collections.folders.map((f) => ({ ...f, _type: 'folder', _date: f.created_at })),
        ...collections.files.map((f) => ({ ...f, _type: 'file', _date: f.created_at })),
      ].sort((a, b) => new Date(b._date || 0) - new Date(a._date || 0)).slice(0, 25);
      foldersToShow = combined.filter((x) => x._type === 'folder');
      filesToShow = combined.filter((x) => x._type === 'file');
      if (emptyMessage) emptyMessage.textContent = 'Aucun élément récent.';
      if (emptyHint) emptyHint.textContent = 'Vos dernières activités apparaissent ici.';
    } else if (currentView === 'partages') {
      foldersToShow = orgMemberships.map((o) => ({ id: o.id, name: o.name, created_at: nowIso(), type: 'org-entry' }));
      if (emptyMessage) emptyMessage.textContent = 'Aucune organisation.';
      if (emptyHint) emptyHint.textContent = 'Créez ou rejoignez une organisation dans Paramètres.';
    } else {
      foldersToShow = collections.folders;
      filesToShow = collections.files;
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier ni dossier.';
      if (emptyHint) emptyHint.textContent = 'Cliquez sur « NOUVEAU » pour ajouter un dossier ou importer des fichiers.';
    }

    if (activeFolderId && currentView === 'mon-drive') {
      foldersToShow = [];
      filesToShow = filesToShow.filter((f) => String(f.folder_id || '') === String(activeFolderId));
      const opened = (collections.folders || []).find((f) => String(f.id) === String(activeFolderId));
      if (emptyMessage) emptyMessage.textContent = opened ? 'Ce dossier est vide.' : 'Dossier introuvable.';
      if (emptyHint) emptyHint.textContent = opened ? 'Importez des fichiers dans ce dossier.' : 'Revenez au niveau racine.';
    }

    tbody.querySelectorAll('.file-row').forEach((r) => r.remove());
    emptyRow.style.display = foldersToShow.length === 0 && filesToShow.length === 0 ? '' : 'none';

    foldersToShow.forEach((f) => {
      const tr = document.createElement('tr');
      tr.className = 'file-row folder-row';
      tr.dataset.folderId = f.id;
      tr.dataset.folderType = f.type || 'normal';
      tr.dataset.folderName = f.name || '';
      const protectedBadge = isItemProtected('folder', f) ? ' <span class="badge-protected">🔒 Protégé</span>' : '';
      tr.innerHTML = `
        <td><div class="cell-name"><svg class="icon folder" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg><span>${escapeHtml(f.name)}</span>${f.type === 'confidential' ? ' <span class="badge-confidential">Confidentiel</span>' : ''}${protectedBadge}</div></td>
        <td>${f.type === 'org-entry' ? 'organisation' : (f.owner_space === 'organization' ? 'organisation' : 'moi')}</td>
        <td>${formatDate(f.created_at)}</td>
        <td>–</td>
      `;
      if (f.type === 'org-entry') {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', async () => {
          activeContext = String(f.id);
          localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
          selectedOrgSettingsId = null;
          setView('mon-drive');
          renderOrgSidebar();
          updateUserUi();
          await switchBackendOrganization(f.id);
        });
      }
      if (currentView === 'mon-drive' && f.type !== 'org-entry') {
        tr.style.cursor = 'pointer';
        tr.addEventListener('dblclick', () => openItem({ type: 'folder', id: f.id }));
        tr.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openContextMenu(e.clientX, e.clientY, {
            type: 'folder',
            id: f.id,
            name: f.name || 'Dossier',
            isProtected: !!getProtectionEntry(activeContext, 'folder', f.id),
          });
        });
      }
      tbody.appendChild(tr);
    });

    filesToShow.forEach((f) => {
      const tr = document.createElement('tr');
      tr.className = 'file-row file-row-id';
      tr.dataset.fileId = f.id;
      const downloadUrl = f.id && isBackendContext() ? '/api/files/' + f.id + '/download?token=' + encodeURIComponent(token) : '#';
      const protectedBadge = isItemProtected('file', f) ? ' <span class="badge-protected">🔒 Protégé</span>' : '';
      const ownerLabel = f.owner_space === 'organization' ? 'organisation' : 'moi';
      tr.innerHTML = `
        <td><div class="cell-name"><svg class="icon file" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>${downloadUrl === '#' ? '<span>' + escapeHtml(f.original_name) + '</span>' : '<a href="' + downloadUrl + '" class="file-link" download>' + escapeHtml(f.original_name) + '</a>'}${protectedBadge}</div></td>
        <td>${ownerLabel}</td>
        <td>${formatDate(f.created_at)}</td>
        <td><span class="cell-size">${formatSize(f.size)}</span>${currentView !== 'corbeille' ? ' <button type="button" class="btn-delete" title="Supprimer">🗑</button>' : ''}</td>
      `;
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, {
          type: 'file',
          id: f.id,
          name: f.original_name || 'Fichier',
          isProtected: !!getProtectionEntry(activeContext, 'file', f.id),
        });
      });
      // Appui long (mobile/trackpad): ouvre le menu avec l'action "Déplacer"
      let holdTimer = null;
      const holdMs = 450;
      const startHold = (e) => {
        if (currentView !== 'mon-drive') return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // On stoppe la sélection de texte pendant le maintien
        e.preventDefault();
        if (holdTimer) window.clearTimeout(holdTimer);
        holdTimer = window.setTimeout(() => {
          longPressSuppressNextOpen = true;
          window.setTimeout(() => {
            longPressSuppressNextOpen = false;
          }, 500);
          openContextMenu(e.clientX, e.clientY, {
            type: 'file',
            id: f.id,
            name: f.original_name || 'Fichier',
            isProtected: !!getProtectionEntry(activeContext, 'file', f.id),
          }, 'longpress');
        }, holdMs);
      };
      const cancelHold = () => {
        if (holdTimer) window.clearTimeout(holdTimer);
        holdTimer = null;
      };
      tr.addEventListener('pointerdown', startHold);
      tr.addEventListener('pointerup', cancelHold);
      tr.addEventListener('pointercancel', cancelHold);
      tr.addEventListener('pointerleave', cancelHold);
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.file-link').forEach((link) => {
      link.addEventListener('click', async (e) => {
        if (longPressSuppressNextOpen) return;
        e.preventDefault();
        const row = link.closest('.file-row-id');
        const fileId = row && row.dataset.fileId;
        if (!fileId) return;
        await openItem({ type: 'file', id: fileId });
      });
    });

    tbody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.file-row-id');
        const id = row && row.dataset.fileId;
        if (!id || !confirm('Supprimer ce fichier ?')) return;
        if (isBackendContext()) {
          const resp = await api('/api/files/' + id, { method: 'DELETE' });
          const data = await resp.json();
          if (!data.message) {
            alert(data.error || 'Erreur');
            return;
          }
          await loadBackendData();
        } else {
          const bucket = ensureContextBucket(activeContext);
          const idx = bucket.files.findIndex((f) => String(f.id) === String(id));
          if (idx >= 0) {
            const file = bucket.files.splice(idx, 1)[0];
            file.deleted_at = nowIso();
            bucket.trash.unshift(file);
            saveContextData();
          }
        }
        renderList();
        renderStorage();
      });
    });

    const backFolderBtn = document.getElementById('btnBackFolder');
    if (backFolderBtn) {
      const showBack = currentView === 'mon-drive' && !!activeFolderId;
      backFolderBtn.style.display = showBack ? '' : 'none';
    }
  }

  function closeNouveauDropdown() {
    const dd = document.getElementById('nouveauDropdown');
    if (dd) dd.classList.remove('open');
  }

  async function createFolder(type, name, password) {
    if (!name || !name.trim()) return;
    if (isBackendContext()) {
      const ownerSpace = String(activeContext) === 'personal' ? 'personal' : 'organization';
      const body = { name: name.trim(), type: type || 'normal' };
      body.ownerSpace = ownerSpace;
      if (password) body.folderPassword = password;
      const r = await api('/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.folder) {
        alert(data.error || 'Erreur');
        return;
      }
      await loadBackendData();
    } else {
      const bucket = ensureContextBucket(activeContext);
      bucket.folders.unshift({
        id: genId('folder'),
        name: name.trim(),
        type: type || 'normal',
        created_at: nowIso(),
      });
      saveContextData();
    }
    renderList();
  }

  async function importSingleFile(file) {
    if (!file) return;
    if (isBackendContext()) {
      const fd = new FormData();
      fd.append('file', file);
      if (activeFolderId) fd.append('folderId', String(activeFolderId));
      fd.append('ownerSpace', String(activeContext) === 'personal' ? 'personal' : 'organization');
      const r = await api('/api/upload', { method: 'POST', body: fd });
      const data = await r.json();
      if (!data.message) {
        alert(data.error || 'Erreur');
        return;
      }
      await loadBackendData();
    } else {
      const bucket = ensureContextBucket(activeContext);
      bucket.files.unshift({
        id: genId('file'),
        original_name: file.name,
        size: file.size || 0,
        folder_id: activeFolderId || null,
        created_at: nowIso(),
      });
      saveContextData();
    }
    renderList();
    renderStorage();
  }

  async function importFolderFiles(files) {
    if (!files || !files.length) return;
    if (isBackendContext()) {
      for (let i = 0; i < files.length; i++) {
        const fd = new FormData();
        fd.append('file', files[i]);
        if (activeFolderId) fd.append('folderId', String(activeFolderId));
        fd.append('ownerSpace', String(activeContext) === 'personal' ? 'personal' : 'organization');
        await api('/api/upload', { method: 'POST', body: fd });
      }
      await loadBackendData();
    } else {
      const bucket = ensureContextBucket(activeContext);
      for (let i = 0; i < files.length; i++) {
        bucket.files.unshift({
          id: genId('file'),
          original_name: files[i].webkitRelativePath || files[i].name,
          size: files[i].size || 0,
          folder_id: activeFolderId || null,
          created_at: nowIso(),
        });
      }
      saveContextData();
    }
    renderList();
    renderStorage();
  }

  function closeHeaderMenus() {
    document.getElementById('settingsDropdown').classList.remove('open');
    document.getElementById('profileDropdown').classList.remove('open');
  }

  function closeContextMenu() {
    const menu = document.getElementById('driveContextMenu');
    if (menu) menu.classList.remove('open');
    contextMenuTarget = null;
    contextMenuMode = 'contextmenu';
  }

  function toggleContextMenuItem(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  }

  function renderContextMenuForTarget() {
    const isItem = !!contextMenuTarget;
    toggleContextMenuItem('ctxOpenItem', isItem);
    toggleContextMenuItem('ctxRenameItem', isItem);
    const isFileTarget = isItem && contextMenuTarget && contextMenuTarget.type === 'file';
    const showMove = isFileTarget && contextMenuMode === 'longpress';
    toggleContextMenuItem('ctxMoveFile', showMove);
    toggleContextMenuItem('ctxPutFileInFolder', showMove);
    toggleContextMenuItem('ctxToggleProtection', isItem);
    toggleContextMenuItem('ctxDeleteItem', isItem);
    const sep = document.getElementById('ctxItemSeparator');
    if (sep) sep.classList.toggle('hidden', !isItem);
    const toggleBtn = document.getElementById('ctxToggleProtection');
    if (isItem && toggleBtn) {
      toggleBtn.textContent = contextMenuTarget.isProtected ? 'Retirer le mot de passe' : 'Ajouter un mot de passe';
    }
  }

  function openContextMenu(x, y, target = null, mode = 'contextmenu') {
    contextMenuTarget = target;
    contextMenuMode = mode;
    renderContextMenuForTarget();
    const menu = document.getElementById('driveContextMenu');
    if (!menu) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.classList.add('open');
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, vw - rect.width - 8));
    const top = Math.max(8, Math.min(y, vh - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function setPasswordModalError(text) {
    const errEl = document.getElementById('itemPasswordError');
    const okEl = document.getElementById('itemPasswordSuccess');
    if (okEl) okEl.style.display = 'none';
    if (!errEl) return;
    errEl.textContent = text || '';
    errEl.style.display = text ? 'block' : 'none';
  }

  function setPasswordModalSuccess(text) {
    const okEl = document.getElementById('itemPasswordSuccess');
    const errEl = document.getElementById('itemPasswordError');
    if (errEl) errEl.style.display = 'none';
    if (!okEl) return;
    okEl.textContent = text || '';
    okEl.style.display = text ? 'block' : 'none';
  }

  function closePasswordModal() {
    const modal = document.getElementById('itemPasswordModal');
    if (modal) modal.classList.remove('open');
    passwordModalState = null;
    setPasswordModalError('');
    setPasswordModalSuccess('');
  }

  function openPasswordModal(config) {
    const modal = document.getElementById('itemPasswordModal');
    const title = document.getElementById('itemPasswordTitle');
    const label1 = document.getElementById('itemPasswordLabel1');
    const label2 = document.getElementById('itemPasswordLabel2');
    const input1 = document.getElementById('itemPasswordInput1');
    const input2 = document.getElementById('itemPasswordInput2');
    const row2 = document.getElementById('itemPasswordSecondRow');
    const confirmBtn = document.getElementById('itemPasswordConfirm');
    if (!modal || !title || !label1 || !label2 || !input1 || !input2 || !row2 || !confirmBtn) return;

    passwordModalState = config;
    title.textContent = config.title;
    label1.textContent = config.label1;
    label2.textContent = config.label2 || 'Confirmer le mot de passe';
    confirmBtn.textContent = config.confirmText || 'Confirmer';
    input1.value = '';
    input2.value = '';
    row2.style.display = config.needConfirm ? '' : 'none';
    setPasswordModalError('');
    setPasswordModalSuccess('');
    modal.classList.add('open');
    setTimeout(() => input1.focus(), 0);
  }

  function getItemFromTarget(target) {
    const data = getCurrentData();
    if (!target) return null;
    if (target.type === 'folder') {
      return (data.folders || []).find((f) => String(f.id) === String(target.id)) || null;
    }
    return (data.files || []).find((f) => String(f.id) === String(target.id)) || null;
  }

  async function ensureAccessForItem(target, onAllowed) {
    const item = getItemFromTarget(target);
    if (!item) return;
    const protection = getProtectionEntry(activeContext, target.type, target.id);
    if (!protection) {
      onAllowed(item);
      return;
    }
    openPasswordModal({
      mode: 'unlock',
      title: 'Accès protégé',
      label1: 'Mot de passe',
      needConfirm: false,
      confirmText: 'Ouvrir',
      target,
      async onSubmit(password) {
        const hash = await hashPassword(password, protection.salt);
        if (hash !== protection.hash) {
          setPasswordModalError('Mot de passe incorrect');
          return;
        }
        closePasswordModal();
        onAllowed(item);
      },
    });
  }

  async function openItem(target) {
    if (!target) return;
    await ensureAccessForItem(target, (item) => {
      if (target.type === 'folder') {
        activeFolderId = String(item.id);
        renderList();
        return;
      }
      if (!isBackendContext()) return;
      const url = '/api/files/' + item.id + '/download?token=' + encodeURIComponent(token);
      window.location.href = url;
    });
  }

  async function deleteItem(target) {
    if (!target) return;
    const item = getItemFromTarget(target);
    if (!item) return;
    const label = target.type === 'folder' ? 'ce dossier' : 'ce fichier';
    if (!confirm('Supprimer ' + label + ' ?')) return;

    if (isBackendContext()) {
      if (target.type === 'file') {
        const resp = await api('/api/files/' + target.id, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Erreur');
      } else {
        const resp = await api('/folders/' + target.id, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Erreur');
        if (String(activeFolderId || '') === String(target.id)) activeFolderId = null;
      }
      await loadBackendData();
    } else {
      const bucket = ensureContextBucket(activeContext);
      if (target.type === 'file') {
        const idx = bucket.files.findIndex((f) => String(f.id) === String(target.id));
        if (idx >= 0) {
          const file = bucket.files.splice(idx, 1)[0];
          file.deleted_at = nowIso();
          bucket.trash.unshift(file);
        }
      } else {
        bucket.folders = bucket.folders.filter((f) => String(f.id) !== String(target.id));
        bucket.files = bucket.files.filter((f) => String(f.folder_id || '') !== String(target.id));
        if (String(activeFolderId || '') === String(target.id)) activeFolderId = null;
      }
      saveContextData();
    }

    renderList();
    renderStorage();
  }

  function closeMoveModal() {
    const modal = document.getElementById('moveFileModal');
    if (modal) modal.classList.remove('open');
    const errEl = document.getElementById('moveFileError');
    if (errEl) {
      errEl.textContent = '';
      errEl.style.display = 'none';
    }
    moveModalTarget = null;
  }

  function setMoveModalError(text) {
    const errEl = document.getElementById('moveFileError');
    if (!errEl) return;
    errEl.textContent = text || '';
    errEl.style.display = text ? 'block' : 'none';
  }

  function openMoveModalForFile(target) {
    if (!target || target.type !== 'file') return;
    moveModalTarget = target;

    const fileItem = getItemFromTarget(target);
    const fileOwnerSpace = (fileItem && fileItem.owner_space)
      ? fileItem.owner_space
      : (String(activeContext) === 'personal' ? 'personal' : 'organization');

    const select = document.getElementById('moveDestinationFolderSelect');
    if (!select) return;
    select.innerHTML = '';

    const rootOpt = document.createElement('option');
    rootOpt.value = '';
    rootOpt.textContent = 'Racine';
    select.appendChild(rootOpt);

    const data = getCurrentData();
    const folders = (data && data.folders) ? data.folders : [];
    folders
      .filter((d) => {
        const ds = d.owner_space ? d.owner_space : (String(activeContext) === 'personal' ? 'personal' : 'organization');
        return ds === fileOwnerSpace;
      })
      .forEach((folder) => {
        const opt = document.createElement('option');
        opt.value = String(folder.id);
        opt.textContent = folder.name;
        select.appendChild(opt);
      });

    setMoveModalError('');
    const modal = document.getElementById('moveFileModal');
    if (modal) modal.classList.add('open');
  }

  async function submitMoveModal() {
    if (!moveModalTarget || moveModalTarget.type !== 'file') return;
    const fileId = moveModalTarget.id;
    const select = document.getElementById('moveDestinationFolderSelect');
    const raw = select ? select.value : '';
    const folderId = raw === '' ? null : parseInt(String(raw), 10);

    try {
      if (isBackendContext()) {
        const resp = await api('/api/files/' + fileId + '/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Erreur');
        await loadBackendData();
      } else {
        const bucket = ensureContextBucket(activeContext);
        const idx = bucket.files.findIndex((x) => String(x.id) === String(fileId));
        if (idx >= 0) {
          bucket.files[idx].folder_id = folderId;
          saveContextData();
        }
      }
      closeMoveModal();
      renderList();
      renderStorage();
    } catch (e) {
      setMoveModalError(e.message || 'Erreur');
    }
  }

  function switchSettingsSection(section) {
    const general = document.getElementById('settingsGeneralSection');
    const org = document.getElementById('settingsOrganizationsSection');
    const tabGeneral = document.getElementById('tabGeneralSettings');
    const tabOrg = document.getElementById('tabOrgSettings');
    if (!general || !org || !tabGeneral || !tabOrg) return;
    const isGeneral = section === 'general';
    general.classList.toggle('open', isGeneral);
    org.classList.toggle('open', !isGeneral);
    tabGeneral.classList.toggle('active', isGeneral);
    tabOrg.classList.toggle('active', !isGeneral);
  }

  function openSettings(section) {
    document.getElementById('settingsModal').classList.add('open');
    document.getElementById('joinError').style.display = 'none';
    document.getElementById('createError').style.display = 'none';
    document.getElementById('createdCode').style.display = 'none';
    switchSettingsSection(section === 'organizations' ? 'organizations' : 'general');
    const darkToggle = document.getElementById('toggleDarkMode');
    if (darkToggle) darkToggle.checked = document.body.classList.contains('dark');
    const email = currentUser.email || localStorage.getItem('drive_email') || '—';
    const meta = getContextMeta(activeContext);
    const accountEmail = document.getElementById('settingsAccountEmail');
    const activeCtx = document.getElementById('settingsActiveContext');
    if (accountEmail) accountEmail.textContent = email;
    if (activeCtx) activeCtx.textContent = meta.label;
    renderSettingsOrganizations();
  }

  function renderSettingsOrganizations() {
    const switcher = document.getElementById('orgSwitcherSelect');
    const list = document.getElementById('orgList');
    if (!switcher || !list) return;
    switcher.innerHTML = '<option value="personal">Mon Drive personnel</option>';
    orgMemberships.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = String(o.id);
      opt.textContent = o.name + ' (' + (o.role || 'MEMBRE') + ')';
      switcher.appendChild(opt);
    });
    switcher.value = String(activeContext);

    list.innerHTML = '';
    orgMemberships.forEach((org) => {
      const card = document.createElement('div');
      card.className = 'org-item';
      const canManageRoles = roleRank(org.role) >= 2;
      const canManageOrg = roleRank(org.role) >= 3;
      card.innerHTML = `
        <div class="org-item-head">
          <strong>${escapeHtml(org.name)}</strong>
          <span>${escapeHtml(org.role || 'MEMBRE')}</span>
        </div>
        <div class="org-members">Code: <strong>${escapeHtml(org.code || '----')}</strong></div>
        <div class="org-members">Membres: ${(org.members || []).map((m) => escapeHtml(m.email) + ' (' + escapeHtml(m.role || 'MEMBRE') + ')').join(', ') || 'aucun'}</div>
        <div class="org-actions">
          <button type="button" data-action="copy-code" data-org-id="${escapeHtml(String(org.id))}">Copier code</button>
          <button type="button" data-action="switch" data-org-id="${escapeHtml(String(org.id))}">Ouvrir ce drive</button>
          <button type="button" data-action="open-settings" data-org-id="${escapeHtml(String(org.id))}">Paramètres de l'organisation</button>
          ${canManageRoles ? '<button type="button" data-action="promote" data-org-id="' + escapeHtml(String(org.id)) + '">Promouvoir 1er membre Admin</button>' : ''}
          ${canManageOrg ? '<button type="button" data-action="rename" data-org-id="' + escapeHtml(String(org.id)) + '">Renommer</button>' : ''}
          <button type="button" data-action="leave" data-org-id="${escapeHtml(String(org.id))}">Quitter</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleOrgAction(btn.dataset.action, btn.dataset.orgId));
    });
  }

  async function handleOrgAction(action, orgId) {
    const org = orgMemberships.find((o) => String(o.id) === String(orgId));
    if (!org) return;
    if (action === 'copy-code') {
      navigator.clipboard.writeText(org.code || '').then(() => alert('Code copié.'));
      return;
    }
    if (action === 'switch') {
      activeContext = String(org.id);
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      selectedOrgSettingsId = null;
      renderOrgSidebar();
      updateUserUi();
      setView('mon-drive');
      renderSettingsOrganizations();
      switchBackendOrganization(org.id);
      return;
    }
    if (action === 'open-settings') {
      selectedOrgSettingsId = String(org.id);
      activeContext = String(org.id);
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      renderOrgSidebar();
      updateUserUi();
      setView('org-settings');
      renderSettingsOrganizations();
      switchBackendOrganization(org.id);
      return;
    }
    if (action === 'rename') {
      if (roleRank(org.role) < 3) return;
      const n = prompt("Nouveau nom de l'organisation :", org.name);
      if (!n || !n.trim()) return;
      org.name = n.trim();
      saveMemberships();
      renderOrgSidebar();
      updateUserUi();
      renderSettingsOrganizations();
      setMainTitle();
      return;
    }
    if (action === 'promote') {
      if (roleRank(org.role) < 2 || !org.members || org.members.length < 2) {
        alert('Aucun membre à promouvoir.');
        return;
      }
      org.members[1].role = 'ADMIN';
      saveMemberships();
      renderSettingsOrganizations();
      return;
    }
    if (action === 'leave') {
      if (!confirm('Quitter cette organisation ?')) return;
      try {
        await leaveOrganization(org.id);
      } catch (e) {
        alert(e.message || 'Erreur');
      }
    }
  }

  function renderOrgSettingsPage() {
    const orgId = selectedOrgSettingsId || activeContext;
    const org = orgMemberships.find((o) => String(o.id) === String(orgId));
    const nameEl = document.getElementById('orgPageName');
    const codeEl = document.getElementById('orgPageCode');
    const roleEl = document.getElementById('orgPageRole');
    const countEl = document.getElementById('orgPageMembersCount');
    const membersBody = document.getElementById('orgMembersTableBody');
    const renameInput = document.getElementById('orgRenameInput');
    const btnRename = document.getElementById('btnOrgRename');
    const btnDelete = document.getElementById('btnDeleteOrg');
    const btnLeave = document.getElementById('btnLeaveOrg');
    const btnCopy = document.getElementById('btnCopyOrgCode');
    if (!nameEl || !membersBody) return;

    if (!org) {
      nameEl.textContent = 'Organisation introuvable';
      codeEl.textContent = '—';
      roleEl.textContent = '—';
      countEl.textContent = '0';
      membersBody.innerHTML = '<tr><td colspan="3">Aucune organisation sélectionnée.</td></tr>';
      return;
    }

    nameEl.textContent = org.name;
    codeEl.textContent = org.code || '----';
    roleEl.textContent = org.role || 'MEMBRE';
    countEl.textContent = String((org.members || []).length);

    const canMembers = canManageMembers(org);
    const canOrg = canManageOrg(org);
    btnRename.style.display = canOrg ? '' : 'none';
    renameInput.style.display = canOrg ? '' : 'none';
    btnDelete.style.display = canOrg ? '' : 'none';
    btnLeave.style.display = '';

    membersBody.innerHTML = '';
    (org.members || []).forEach((m) => {
      const tr = document.createElement('tr');
      const roleOptions = ['PDG', 'ADMIN', 'MEMBRE']
        .map((r) => '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + r + '</option>')
        .join('');
      const canEditMember = canMembers && String(m.id) !== String(currentUser.id);
      tr.innerHTML = `
        <td>
          <div class="member-cell">
            <span class="member-avatar">${escapeHtml((m.email || 'U').charAt(0).toUpperCase())}</span>
            <span>${escapeHtml(m.name || m.email || 'Membre')}</span>
          </div>
        </td>
        <td>
          ${canEditMember ? '<select data-action="role" data-member-id="' + escapeHtml(String(m.id)) + '">' + roleOptions + '</select>' : '<span class="role-badge">' + escapeHtml(m.role || 'MEMBRE') + '</span>'}
        </td>
        <td>
          ${canEditMember ? '<button type="button" class="danger" data-action="remove" data-member-id="' + escapeHtml(String(m.id)) + '">Exclure</button>' : '—'}
        </td>
      `;
      membersBody.appendChild(tr);
    });

    membersBody.querySelectorAll('select[data-action="role"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const member = org.members.find((x) => String(x.id) === String(sel.dataset.memberId));
        if (!member || !canMembers) return;
        member.role = sel.value;
        saveMemberships();
        renderSettingsOrganizations();
        renderOrgSettingsPage();
      });
    });
    membersBody.querySelectorAll('button[data-action="remove"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canMembers) return;
        if (!confirm('Exclure ce membre de l’organisation ?')) return;
        org.members = org.members.filter((x) => String(x.id) !== String(btn.dataset.memberId));
        saveMemberships();
        renderSettingsOrganizations();
        renderOrgSettingsPage();
      });
    });

    btnCopy.onclick = () => navigator.clipboard.writeText(org.code || '').then(() => alert('Code copié.'));
    btnRename.onclick = () => {
      if (!canOrg) return;
      const n = (renameInput.value || '').trim();
      if (!n) return;
      org.name = n;
      renameInput.value = '';
      saveMemberships();
      renderOrgSidebar();
      renderSettingsOrganizations();
      renderOrgSettingsPage();
      setMainTitle();
    };
    btnLeave.onclick = () => {
      if (!confirm('Quitter cette organisation ?')) return;
      leaveOrganization(org.id).catch((e) => alert(e.message || 'Erreur'));
    };
    btnDelete.onclick = () => {
      if (!canOrg) return;
      if (!confirm("Supprimer l'organisation ? Cette action est définitive.")) return;
      orgMemberships = orgMemberships.filter((o) => String(o.id) !== String(org.id));
      saveMemberships();
      if (String(activeContext) === String(org.id)) {
        activeContext = 'personal';
        localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      }
      selectedOrgSettingsId = null;
      renderOrgSidebar();
      renderSettingsOrganizations();
      updateUserUi();
      setView('partages');
    };
  }

  function logout() {
    localStorage.removeItem('drive_token');
    localStorage.removeItem('drive_email');
    window.location.href = '/';
  }

  function setTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark', isDark);
    localStorage.setItem(LS_THEME, isDark ? 'dark' : 'light');
    const glass = document.getElementById('toggleGlass');
    if (glass) glass.checked = !isDark;
  }

  function toggleTheme() {
    const isDark = document.body.classList.contains('dark');
    setTheme(isDark ? 'light' : 'dark');
  }

  async function joinOrganizationByCode(code) {
    const errEl = document.getElementById('joinError');
    errEl.style.display = 'none';
    if (!code || !code.trim()) {
      errEl.textContent = 'Code requis.';
      errEl.style.display = 'block';
      return;
    }
    const cleaned = code.trim().replace(/\s/g, '');
    try {
      const res = await api('/organizations/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cleaned.replace(/\D/g, '').slice(0, 4) || cleaned }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || 'Erreur';
        errEl.style.display = 'block';
        return;
      }
      if (data.token) {
        updateToken(data.token);
        activeContext = String(data.organization.id);
        localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      }
      await loadMe();
      await loadBackendData();
      renderOrgSidebar();
      renderSettingsOrganizations();
      updateUserUi();
      setView('mon-drive');
    } catch (e) {
      errEl.textContent = e.message || 'Erreur';
      errEl.style.display = 'block';
    }
  }

  async function createOrganization(name) {
    const errEl = document.getElementById('createError');
    const codeEl = document.getElementById('createdCode');
    errEl.style.display = 'none';
    codeEl.style.display = 'none';
    if (!name || !name.trim()) {
      errEl.textContent = "Indiquez le nom de l'organisation.";
      errEl.style.display = 'block';
      return;
    }
    try {
      const res = await api('/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur');
      if (data.token) updateToken(data.token);
      const org = {
        id: String(data.organization.id),
        name: data.organization.name,
        code: data.code || '----',
        role: 'PDG',
        members: [
          { id: currentUser.id || 'me', email: currentUser.email || localStorage.getItem('drive_email') || 'moi', role: 'PDG' },
          { id: 'member_' + Date.now(), email: 'membre@org.local', role: 'MEMBRE' },
        ],
      };
      orgMemberships = [org, ...orgMemberships.filter((o) => String(o.id) !== String(org.id))];
      saveMemberships();
      activeContext = String(org.id);
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      codeEl.textContent = 'Organisation créée. Code: ' + org.code;
      codeEl.style.display = 'block';
      await loadMe();
      await loadBackendData();
      renderOrgSidebar();
      renderSettingsOrganizations();
      setView('mon-drive');
    } catch (e) {
      errEl.textContent = e.message || 'Erreur';
      errEl.style.display = 'block';
    }
  }

  async function leaveOrganization(orgId) {
    const parsedOrgId = parseInt(String(orgId), 10);
    if (!parsedOrgId || Number.isNaN(parsedOrgId)) throw new Error('Organisation invalide');
    const res = await api('/organizations/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: parsedOrgId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la sortie');

    if (data.token) updateToken(data.token);

    if (String(activeContext) === String(parsedOrgId)) {
      if (data.activeOrganization && data.activeOrganization.id != null) {
        activeContext = String(data.activeOrganization.id);
      } else {
        activeContext = 'personal';
      }
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      selectedOrgSettingsId = null;
    }

    await loadMe();
    await loadBackendData();
    renderOrgSidebar();
    renderSettingsOrganizations();
    updateUserUi();
    setView('mon-drive');
  }

  function bindEvents() {
    document.getElementById('searchInput').addEventListener('input', renderList);

    document.getElementById('btnNouveau').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('nouveauDropdown').classList.toggle('open');
    });
    document.getElementById('nouveauDropdown').addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      closeNouveauDropdown();
      closeHeaderMenus();
      closeContextMenu();
    });

    document.getElementById('menuNouveauDossier').addEventListener('click', async () => {
      closeNouveauDropdown();
      const name = prompt('Nom du dossier :');
      await createFolder('normal', name);
    });

    document.getElementById('btnConfidentialFolder').addEventListener('click', () => {
      document.getElementById('confidentialModal').classList.add('open');
      document.getElementById('confFolderName').value = '';
      document.getElementById('confFolderPassword').value = '';
      document.getElementById('confError').style.display = 'none';
    });
    document.getElementById('btnCreateConfidential').addEventListener('click', async () => {
      const name = document.getElementById('confFolderName').value.trim();
      const pwd = document.getElementById('confFolderPassword').value;
      const errEl = document.getElementById('confError');
      if (!name || !pwd) {
        errEl.textContent = 'Nom et mot de passe requis.';
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';
      await createFolder('confidential', name, pwd);
      document.getElementById('confidentialModal').classList.remove('open');
    });
    document.getElementById('confidentialModal').addEventListener('click', (e) => {
      if (e.target.id === 'confidentialModal') e.target.classList.remove('open');
    });

    const uploadInput = document.getElementById('uploadFileInput');
    const uploadFolderInput = document.getElementById('uploadFolderInput');
    document.getElementById('menuImporterFichier').addEventListener('click', () => {
      closeNouveauDropdown();
      uploadInput.click();
    });
    uploadInput.addEventListener('change', async () => {
      const files = Array.from(uploadInput.files);
      uploadInput.value = '';
      if (!files.length) return;
      for (const file of files) {
        await importSingleFile(file);
      }
    });
    document.getElementById('menuImporterDossier').addEventListener('click', () => {
      closeNouveauDropdown();
      uploadFolderInput.click();
    });
    uploadFolderInput.addEventListener('change', async () => {
      const files = uploadFolderInput.files;
      uploadFolderInput.value = '';
      if (!files || files.length === 0) return;
      await importFolderFiles(files);
    });

    document.getElementById('btnSettings').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('profileDropdown').classList.remove('open');
      document.getElementById('settingsDropdown').classList.toggle('open');
    });
    document.getElementById('userAvatar').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('settingsDropdown').classList.remove('open');
      document.getElementById('profileDropdown').classList.toggle('open');
    });
    document.getElementById('settingsWrap').addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('profileWrap').addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('menuSettingsGeneral').addEventListener('click', () => {
      openSettings('general');
      closeHeaderMenus();
    });
    document.getElementById('menuSettingsAppearance').addEventListener('click', () => {
      openSettings('general');
      closeHeaderMenus();
    });
    document.getElementById('menuSettingsNotifications').addEventListener('click', () => openSettings('general'));
    document.getElementById('menuSettingsOrg').addEventListener('click', () => openSettings('organizations'));
    document.getElementById('menuSettingsLogout').addEventListener('click', logout);
    document.getElementById('menuMonProfil').addEventListener('click', () => alert('Profil: ' + (currentUser.email || 'Utilisateur')));
    document.getElementById('menuProfileOrg').addEventListener('click', () => {
      closeHeaderMenus();
      if (activeContext === 'personal' && orgMemberships[0]) {
        activeContext = String(orgMemberships[0].id);
        localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      }
      selectedOrgSettingsId = activeContext !== 'personal' ? String(activeContext) : null;
      if (!selectedOrgSettingsId) {
        openSettings('organizations');
        return;
      }
      setView('org-settings');
      renderOrgSidebar();
      updateUserUi();
    });
    document.getElementById('menuProfileSettings').addEventListener('click', () => openSettings('general'));
    document.getElementById('menuSwitchOrg').addEventListener('click', () => openSettings('organizations'));
    document.getElementById('menuLogout').addEventListener('click', logout);

    document.getElementById('settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') e.target.classList.remove('open');
    });
    document.getElementById('tabGeneralSettings').addEventListener('click', () => switchSettingsSection('general'));
    document.getElementById('tabOrgSettings').addEventListener('click', () => switchSettingsSection('organizations'));
    document.getElementById('btnCreateOrg').addEventListener('click', () => {
      createOrganization(document.getElementById('createOrgName').value);
      document.getElementById('createOrgName').value = '';
    });
    document.getElementById('btnJoinOrg').addEventListener('click', () => {
      joinOrganizationByCode(document.getElementById('joinCode').value);
      document.getElementById('joinCode').value = '';
    });
    document.getElementById('btnSwitchOrg').addEventListener('click', async () => {
      const v = document.getElementById('orgSwitcherSelect').value;
      activeContext = String(v);
      localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
      renderOrgSidebar();
      updateUserUi();
      setView('mon-drive');
      renderSettingsOrganizations();
      if (v !== 'personal') await switchBackendOrganization(v);
    });

    const backFolderBtn = document.getElementById('btnBackFolder');
    if (backFolderBtn) {
      backFolderBtn.addEventListener('click', () => {
        activeFolderId = null;
        renderList();
      });
    }

    const darkToggle = document.getElementById('toggleDarkMode');
    if (darkToggle) {
      darkToggle.checked = document.body.classList.contains('dark');
      darkToggle.addEventListener('change', () => setTheme(darkToggle.checked ? 'dark' : 'light'));
    }

    const ctxMenu = document.getElementById('driveContextMenu');
    const main = document.querySelector('.main');
    if (main && ctxMenu) {
      main.addEventListener('contextmenu', (e) => {
        if (currentView === 'org-settings') return;
        e.preventDefault();
        closeHeaderMenus();
        closeNouveauDropdown();
        const row = e.target && e.target.closest ? e.target.closest('tr.file-row') : null;
        let target = null;
        if (row && currentView === 'mon-drive') {
          const folderId = row.dataset && row.dataset.folderId;
          const folderType = row.dataset && row.dataset.folderType;
          const folderName = row.dataset && row.dataset.folderName;
          const fileId = row.dataset && row.dataset.fileId;
          if (folderId && folderType !== 'org-entry') {
            target = {
              type: 'folder',
              id: folderId,
              name: folderName || 'Dossier',
              isProtected: !!getProtectionEntry(activeContext, 'folder', folderId),
            };
          } else if (fileId) {
            target = {
              type: 'file',
              id: fileId,
              name: 'Fichier',
              isProtected: !!getProtectionEntry(activeContext, 'file', fileId),
            };
          }
        }
        openContextMenu(e.clientX, e.clientY, target);
      });
    }
    document.getElementById('ctxCreateFolder').addEventListener('click', async () => {
      closeContextMenu();
      const name = prompt('Nom du dossier :');
      await createFolder('normal', name);
    });
    document.getElementById('ctxImportFile').addEventListener('click', () => {
      closeContextMenu();
      uploadInput.click();
    });
    document.getElementById('ctxImportFolder').addEventListener('click', () => {
      closeContextMenu();
      uploadFolderInput.click();
    });
    document.getElementById('ctxRefresh').addEventListener('click', async () => {
      closeContextMenu();
      await loadBackendData();
      renderList();
      renderStorage();
    });

    const emptyBtn = document.getElementById('btnEmptyTrash');
    if (emptyBtn) {
      emptyBtn.addEventListener('click', async () => {
        const scope = 'all';
        if (!confirm('Vider définitivement la corbeille ? Cette action est irréversible.')) return;
        try {
          const resp = await api('/api/files/trash/empty?scope=' + encodeURIComponent(scope), { method: 'DELETE' });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Erreur');
          alert('Corbeille vidée avec succès.');
          await loadBackendData();
          renderList();
          renderStorage();
        } catch (e) {
          alert(e.message || 'Erreur');
        }
      });
    }
    document.getElementById('ctxOpenItem').addEventListener('click', async () => {
      const target = contextMenuTarget;
      closeContextMenu();
      await openItem(target);
    });
    document.getElementById('ctxRenameItem').addEventListener('click', () => {
      const target = contextMenuTarget;
      closeContextMenu();
      if (!target) return;
      const item = getItemFromTarget(target);
      if (!item) return;
      const currentName = target.type === 'folder' ? item.name : item.original_name;
      const next = prompt('Nouveau nom :', currentName || '');
      if (!next || !next.trim()) return;
      if (target.type === 'folder') {
        item.name = next.trim();
      } else {
        item.original_name = next.trim();
      }
      if (!isBackendContext()) saveContextData();
      renderList();
    });
    document.getElementById('ctxToggleProtection').addEventListener('click', () => {
      const target = contextMenuTarget;
      closeContextMenu();
      if (!target) return;
      if (!target.isProtected) {
        openPasswordModal({
          mode: 'add',
          title: 'Ajouter un mot de passe',
          label1: 'Nouveau mot de passe',
          label2: 'Confirmer le mot de passe',
          needConfirm: true,
          confirmText: 'Protéger',
          target,
          async onSubmit(password, confirmPassword) {
            if (!password) {
              setPasswordModalError('Mot de passe requis');
              return;
            }
            if (password !== confirmPassword) {
              setPasswordModalError('Les mots de passe ne correspondent pas');
              return;
            }
            const salt = randomSaltHex();
            const hash = await hashPassword(password, salt);
            setItemProtection(target.type, target.id, {
              salt,
              hash,
              updatedAt: nowIso(),
            });
            setPasswordModalSuccess('Protection ajoutée avec succès');
            setTimeout(() => {
              closePasswordModal();
              renderList();
            }, 250);
          },
        });
        return;
      }
      const protection = getProtectionEntry(activeContext, target.type, target.id);
      if (!protection) return;
      openPasswordModal({
        mode: 'remove',
        title: 'Retirer le mot de passe',
        label1: 'Mot de passe actuel',
        needConfirm: false,
        confirmText: 'Retirer',
        target,
        async onSubmit(password) {
          if (!password) {
            setPasswordModalError('Mot de passe requis');
            return;
          }
          const hash = await hashPassword(password, protection.salt);
          if (hash !== protection.hash) {
            setPasswordModalError('Mot de passe incorrect');
            return;
          }
          clearItemProtection(target.type, target.id);
          setPasswordModalSuccess('Mot de passe retiré avec succès');
          setTimeout(() => {
            closePasswordModal();
            renderList();
          }, 250);
        },
      });
    });
    document.getElementById('ctxDeleteItem').addEventListener('click', async () => {
      const target = contextMenuTarget;
      closeContextMenu();
      try {
        await deleteItem(target);
      } catch (e) {
        alert(e.message || 'Erreur');
      }
    });

    const ctxMove = document.getElementById('ctxMoveFile');
    if (ctxMove) {
      ctxMove.addEventListener('click', () => {
        const target = contextMenuTarget;
        closeContextMenu();
        openMoveModalForFile(target);
      });
    }
    const ctxPut = document.getElementById('ctxPutFileInFolder');
    if (ctxPut) {
      ctxPut.addEventListener('click', () => {
        const target = contextMenuTarget;
        closeContextMenu();
        openMoveModalForFile(target);
      });
    }

    const moveModal = document.getElementById('moveFileModal');
    if (moveModal) {
      moveModal.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'moveFileModal') closeMoveModal();
      });
    }
    const moveCancel = document.getElementById('moveFileCancel');
    if (moveCancel) moveCancel.addEventListener('click', closeMoveModal);
    const moveConfirm = document.getElementById('moveFileConfirm');
    if (moveConfirm) moveConfirm.addEventListener('click', submitMoveModal);

    const passwordModal = document.getElementById('itemPasswordModal');
    const passwordCancel = document.getElementById('itemPasswordCancel');
    const passwordConfirm = document.getElementById('itemPasswordConfirm');
    const passwordInput1 = document.getElementById('itemPasswordInput1');
    const passwordInput2 = document.getElementById('itemPasswordInput2');
    if (passwordCancel) passwordCancel.addEventListener('click', closePasswordModal);
    if (passwordModal) {
      passwordModal.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'itemPasswordModal') closePasswordModal();
      });
    }
    const submitPasswordModal = async () => {
      if (!passwordModalState || !passwordModalState.onSubmit) return;
      const p1 = passwordInput1 ? passwordInput1.value : '';
      const p2 = passwordInput2 ? passwordInput2.value : '';
      try {
        await passwordModalState.onSubmit(p1, p2);
      } catch (err) {
        setPasswordModalError(err && err.message ? err.message : 'Erreur');
      }
    };
    if (passwordConfirm) passwordConfirm.addEventListener('click', submitPasswordModal);
    if (passwordInput1) {
      passwordInput1.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        await submitPasswordModal();
      });
    }
    if (passwordInput2) {
      passwordInput2.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        await submitPasswordModal();
      });
    }

    document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
      el.addEventListener('click', async () => {
        if (el.dataset.view === 'mon-drive') {
          activeContext = 'personal';
          localStorage.setItem(LS_ACTIVE_CONTEXT, activeContext);
          selectedOrgSettingsId = null;
          activeFolderId = null;
          await loadBackendData();
        }
        setView(el.dataset.view);
      });
    });

    const rawSettings = localStorage.getItem(LS_SETTINGS);
    const uiSettings = rawSettings ? JSON.parse(rawSettings) : { compact: false, glass: true, notifications: true };
    const compact = document.getElementById('toggleCompact');
    const glass = document.getElementById('toggleGlass');
    const notif = document.getElementById('toggleNotifications');
    compact.checked = !!uiSettings.compact;
    glass.checked = uiSettings.glass !== false;
    notif.checked = uiSettings.notifications !== false;
    const saveUiSettings = () => {
      const next = { compact: compact.checked, glass: glass.checked, notifications: notif.checked };
      localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
      document.body.style.fontSize = next.compact ? '14px' : '';
      document.body.classList.toggle('no-glass', !next.glass);
    };
    compact.addEventListener('change', saveUiSettings);
    glass.addEventListener('change', saveUiSettings);
    notif.addEventListener('change', saveUiSettings);
    saveUiSettings();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const ctx = document.getElementById('driveContextMenu');
      if (ctx && ctx.classList.contains('open')) {
        closeContextMenu();
        return;
      }
      const confidential = document.getElementById('confidentialModal');
      if (confidential && confidential.classList.contains('open')) {
        confidential.classList.remove('open');
        return;
      }
      const settings = document.getElementById('settingsModal');
      if (settings && settings.classList.contains('open')) {
        settings.classList.remove('open');
        return;
      }
      const itemPassword = document.getElementById('itemPasswordModal');
      if (itemPassword && itemPassword.classList.contains('open')) {
        closePasswordModal();
        return;
      }
      const moveModal = document.getElementById('moveFileModal');
      if (moveModal && moveModal.classList.contains('open')) {
        closeMoveModal();
        return;
      }
      const profile = document.getElementById('profileDropdown');
      const headerSettings = document.getElementById('settingsDropdown');
      if ((profile && profile.classList.contains('open')) || (headerSettings && headerSettings.classList.contains('open'))) {
        closeHeaderMenus();
        return;
      }
      const nouveau = document.getElementById('nouveauDropdown');
      if (nouveau && nouveau.classList.contains('open')) {
        closeNouveauDropdown();
      }
    });
  }

  async function init() {
    const savedTheme = localStorage.getItem(LS_THEME);
    setTheme(savedTheme === 'dark' ? 'dark' : 'light');
    loadProtectionState();
    await loadMe();
    await ensureOrgSync();
    await loadBackendData();
    bindEvents();
    renderOrgSidebar();
    updateUserUi();
    setView('accueil');
    renderSettingsOrganizations();
  }

  init();
})();

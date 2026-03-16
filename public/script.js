/**
 * Drive – logique côté client (sans rechargement de page)
 */
(function () {
  let token = localStorage.getItem('drive_token');
  if (!token) {
    window.location.href = '/';
    return;
  }

  const api = (path, options = {}) => {
    const headers = { ...options.headers, 'Authorization': 'Bearer ' + token };
    return fetch(path, { ...options, headers });
  };

  let currentUser = { org_id: null, organization: null, role: null };
  let allFolders = [];
  let allFiles = [];
  let allFilesTrash = [];
  let currentView = 'accueil';

  function updateToken(newToken) {
    if (newToken) {
      token = newToken;
      localStorage.setItem('drive_token', token);
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
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

  function loadMe() {
    api('/me')
      .then((r) => {
        if (r.status === 401) {
          localStorage.removeItem('drive_token');
          window.location.href = '/';
          return;
        }
        return r.json();
      })
      .then((data) => {
        if (data && data.user) {
          currentUser = data.user;
          const banner = document.getElementById('noOrgBanner');
          const btnNouveau = document.getElementById('btnNouveau');
          const btnConfidential = document.getElementById('btnConfidentialFolder');
          const badgeAdmin = document.getElementById('badgeAdmin');
          if (badgeAdmin) {
            badgeAdmin.style.display = currentUser.role === 'PDG' ? 'inline-flex' : 'none';
          }
          if (currentUser.org_id == null) {
            if (banner) banner.style.display = 'block';
            if (btnNouveau) {
              btnNouveau.style.opacity = '0.6';
              btnNouveau.title = "Rejoignez ou créez une organisation d'abord";
            }
            if (btnConfidential) btnConfidential.style.display = 'none';
          } else {
            if (banner) banner.style.display = 'none';
            if (btnNouveau) {
              btnNouveau.style.opacity = '1';
              btnNouveau.title = '';
            }
            if (btnConfidential) btnConfidential.style.display = 'flex';
          }
          const profileEmailEl = document.getElementById('profileEmail');
          const profileRoleEl = document.getElementById('profileRole');
          if (profileEmailEl) profileEmailEl.textContent = currentUser.email || localStorage.getItem('drive_email') || '—';
          if (profileRoleEl) {
            const roleLabel = currentUser.role === 'PDG' ? 'PDG' : 'Collaborateur';
            const orgName = currentUser.organization && currentUser.organization.name ? ' · ' + currentUser.organization.name : '';
            profileRoleEl.textContent = roleLabel + orgName;
          }
        }
      });
  }

  function loadFolders() {
    api('/folders')
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((data) => {
        allFolders = (data && data.folders) ? data.folders : [];
        renderList();
      })
      .catch(() => {
        allFolders = [];
        renderList();
      });
  }

  function loadFiles(trash) {
    const url = trash ? '/api/files?trash=1' : '/api/files';
    api(url)
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((data) => {
        const list = (data && data.files) ? data.files : [];
        if (trash) allFilesTrash = list;
        else allFiles = list;
        renderList();
      })
      .catch(() => {
        if (trash) allFilesTrash = [];
        else allFiles = [];
        renderList();
      });
  }

  function loadStorage() {
    api('/api/storage')
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((data) => {
        if (!data || data.error) return;
        const used = data.usedBytes || 0;
        const limit = data.limitBytes || 15 * 1024 * 1024 * 1024;
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const bar = document.getElementById('storageBarInner');
        const text = document.getElementById('storageText');
        if (bar) bar.style.width = pct + '%';
        if (text) text.textContent = (data.usedFormatted || '0 Mo') + ' utilisés sur ' + (data.limitFormatted || '15 Go');
      })
      .catch(() => {});
  }

  function setView(view) {
    currentView = view;
    document.querySelectorAll('.nav-item[data-view]').forEach((el) => el.classList.remove('active'));
    const nav = document.querySelector('.nav-item[data-view="' + view + '"]');
    if (nav) nav.classList.add('active');
    const titles = { accueil: 'Accueil', 'mon-drive': 'Mon Drive', partages: 'Partagés avec moi', recents: 'Récents', corbeille: 'Corbeille' };
    const mainTitleText = document.getElementById('mainTitleText');
    if (mainTitleText) mainTitleText.textContent = titles[view] || view;
    if (view === 'corbeille') {
      loadFiles(true);
      loadStorage();
    } else if (view === 'partages') {
      allFolders = [];
      allFiles = [];
      renderList();
      loadStorage();
    } else {
      loadFolders();
      loadFiles(false);
      loadStorage();
    }
  }

  function refreshAll() {
    loadFolders();
    loadFiles(false);
    loadFiles(true);
    loadStorage();
  }

  function renderList() {
    const tbody = document.getElementById('filesTable');
    const emptyRow = tbody.querySelector('.empty-row');
    const emptyMessage = document.getElementById('emptyMessage');
    const emptyHint = document.getElementById('emptyHint');
    const search = (document.getElementById('searchInput') || {}).value || '';
    const q = search.trim().toLowerCase();

    let foldersToShow = [];
    let filesToShow = [];

    if (currentView === 'corbeille') {
      foldersToShow = [];
      filesToShow = q ? allFilesTrash.filter((f) => (f.original_name || '').toLowerCase().includes(q)) : allFilesTrash;
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier dans la corbeille.';
      if (emptyHint) emptyHint.textContent = 'Les fichiers supprimés apparaissent ici. Vous pouvez les restaurer ou les supprimer définitivement.';
    } else if (currentView === 'partages') {
      foldersToShow = [];
      filesToShow = [];
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier partagé avec vous.';
      if (emptyHint) emptyHint.textContent = 'Les fichiers que d\'autres utilisateurs partagent avec vous apparaîtront ici.';
    } else if (currentView === 'recents') {
      const combined = [
        ...allFolders.map((f) => ({ ...f, _date: f.created_at, _type: 'folder' })),
        ...allFiles.map((f) => ({ ...f, _date: f.created_at, _type: 'file' })),
      ].sort((a, b) => new Date(b._date || 0) - new Date(a._date || 0)).slice(0, 25);
      foldersToShow = combined.filter((x) => x._type === 'folder').map(({ _type, _date, ...r }) => r);
      filesToShow = combined.filter((x) => x._type === 'file').map(({ _type, _date, ...r }) => r);
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier récent.';
      if (emptyHint) emptyHint.textContent = 'Vos derniers fichiers et dossiers modifiés apparaissent ici.';
    } else {
      foldersToShow = q ? allFolders.filter((f) => (f.name || '').toLowerCase().includes(q)) : allFolders;
      filesToShow = q ? allFiles.filter((f) => (f.original_name || '').toLowerCase().includes(q)) : allFiles;
      if (emptyMessage) emptyMessage.textContent = 'Aucun fichier ni dossier.';
      if (emptyHint) emptyHint.textContent = 'Cliquez sur « NOUVEAU » pour ajouter un dossier ou importer des fichiers.';
    }

    const filteredFolders = foldersToShow;
    const filteredFiles = currentView === 'corbeille' ? filesToShow : filesToShow;

    tbody.querySelectorAll('.file-row').forEach((r) => r.remove());
    emptyRow.style.display = filteredFolders.length === 0 && filteredFiles.length === 0 ? '' : 'none';

    if (currentView === 'corbeille') {
      filteredFiles.forEach((f) => {
        const tr = document.createElement('tr');
        tr.className = 'file-row file-row-id file-row-trash';
        tr.dataset.fileId = f.id;
        tr.innerHTML = `
          <td><div class="cell-name"><svg class="icon file" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><span>${escapeHtml(f.original_name)}</span></div></td>
          <td>moi</td>
          <td>${formatDate(f.deleted_at || f.created_at)}</td>
          <td><span class="cell-size">${formatSize(f.size)}</span> <button type="button" class="btn-restore" title="Restaurer">↩</button> <button type="button" class="btn-delete-permanent" title="Supprimer définitivement">🗑</button></td>
        `;
        tbody.appendChild(tr);
      });
      tbody.querySelectorAll('.btn-restore').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.closest('.file-row-id') && btn.closest('.file-row-id').dataset.fileId;
          if (!id) return;
          api('/api/files/' + id + '/restore', { method: 'POST' })
            .then((r) => r.json())
            .then((data) => {
              if (data.message) {
                loadFiles(true);
                loadFiles(false);
                loadStorage();
              } else alert(data.error || 'Erreur');
            });
        });
      });
      tbody.querySelectorAll('.btn-delete-permanent').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.closest('.file-row-id') && btn.closest('.file-row-id').dataset.fileId;
          if (!id || !confirm('Supprimer définitivement ce fichier ? Cette action est irréversible.')) return;
          api('/api/files/' + id + '/permanent', { method: 'DELETE' })
            .then((r) => r.json())
            .then((data) => {
              if (data.message) {
                loadFiles(true);
                loadStorage();
              } else alert(data.error || 'Erreur');
            });
        });
      });
    } else {
    filteredFolders.forEach((f) => {
      const tr = document.createElement('tr');
      tr.className = 'file-row folder-row';
      tr.dataset.folderId = f.id;
      tr.dataset.folderType = f.type || 'normal';
      tr.dataset.folderName = f.name || '';
      tr.innerHTML = `
        <td><div class="cell-name"><svg class="icon folder" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg><span>${escapeHtml(f.name)}</span>${f.type === 'confidential' ? ' <span class="badge-confidential">Confidentiel</span>' : ''}</div></td>
        <td>moi</td>
        <td>${formatDate(f.created_at)}</td>
        <td>–</td>
      `;
      tbody.appendChild(tr);
    });

    filteredFiles.forEach((f) => {
      const tr = document.createElement('tr');
      tr.className = 'file-row file-row-id';
      tr.dataset.fileId = f.id;
      tr.dataset.fileName = f.original_name || '';
      const canDelete = currentUser.role === 'PDG' || f.uploaded_by === currentUser.id;
      const downloadUrl = '/api/files/' + f.id + '/download?token=' + encodeURIComponent(token);
      tr.innerHTML = `
        <td><div class="cell-name"><svg class="icon file" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg><a href="${downloadUrl}" class="file-link" download>${escapeHtml(f.original_name)}</a></div></td>
        <td>${currentUser.role === 'PDG' && f.uploaded_by !== currentUser.id ? 'autre' : 'moi'}</td>
        <td>${formatDate(f.created_at)}</td>
        <td><span class="cell-size">${formatSize(f.size)}</span>${canDelete ? ' <button type="button" class="btn-delete" title="Supprimer">🗑</button>' : ''}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.file-row-id');
        const id = row && row.dataset.fileId;
        if (!id || !confirm('Supprimer ce fichier ?')) return;
        api('/api/files/' + id, { method: 'DELETE' })
          .then((r) => r.json())
          .then((data) => {
            if (data.message) { loadFiles(false); loadStorage(); }
            else alert(data.error || 'Erreur');
          });
      });
    });

    tbody.querySelectorAll('.folder-row').forEach((row) => {
      row.addEventListener('click', () => {
        const type = row.dataset.folderType;
        const id = row.dataset.folderId;
        const name = row.dataset.folderName;
        if (type === 'confidential') {
          const pwd = prompt('Mot de passe du dossier "' + name + '" :');
          if (pwd === null) return;
          api('/api/folders/' + id + '/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPassword: pwd }),
          })
            .then((r) => r.json())
            .then((data) => {
              if (data.unlocked) alert('Dossier déverrouillé.');
              else alert(data.error || 'Mot de passe incorrect.');
            });
        }
      });
    });
    }
  }

  document.getElementById('searchInput').addEventListener('input', renderList);

  function closeNouveauDropdown() {
    const dd = document.getElementById('nouveauDropdown');
    if (dd) dd.classList.remove('open');
  }

  function openNewFolder() {
    closeNouveauDropdown();
    if (currentUser.org_id == null) {
      document.getElementById('settingsModal').classList.add('open');
      return;
    }
    const name = prompt('Nom du dossier :');
    if (!name || !name.trim()) return;
    api('/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), type: 'normal' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.folder) refreshAll();
        else alert(data.error || 'Erreur');
      });
  }

  document.getElementById('btnNouveau').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('nouveauDropdown').classList.toggle('open');
  });

  document.addEventListener('click', () => closeNouveauDropdown());

  document.getElementById('nouveauDropdown').addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('menuNouveauDossier').addEventListener('click', openNewFolder);

  document.getElementById('btnConfidentialFolder').addEventListener('click', () => {
    if (currentUser.org_id == null) return;
    document.getElementById('confidentialModal').classList.add('open');
    document.getElementById('confFolderName').value = '';
    document.getElementById('confFolderPassword').value = '';
    document.getElementById('confError').style.display = 'none';
  });

  document.getElementById('btnCreateConfidential').addEventListener('click', () => {
    const name = document.getElementById('confFolderName').value.trim();
    const pwd = document.getElementById('confFolderPassword').value;
    const errEl = document.getElementById('confError');
    if (!name) {
      errEl.textContent = 'Nom du dossier requis.';
      errEl.style.display = 'block';
      return;
    }
    if (!pwd) {
      errEl.textContent = 'Mot de passe du dossier requis.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    api('/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'confidential', folderPassword: pwd }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.folder) {
          document.getElementById('confidentialModal').classList.remove('open');
          refreshAll();
        } else {
          errEl.textContent = data.error || 'Erreur';
          errEl.style.display = 'block';
        }
      });
  });

  document.getElementById('confidentialModal').addEventListener('click', (e) => {
    if (e.target.id === 'confidentialModal') e.target.classList.remove('open');
  });

  const uploadInput = document.getElementById('uploadFileInput');
  const uploadFolderInput = document.getElementById('uploadFolderInput');

  document.getElementById('menuImporterFichier').addEventListener('click', () => {
    closeNouveauDropdown();
    if (currentUser.org_id == null) {
      document.getElementById('settingsModal').classList.add('open');
      return;
    }
    uploadInput.click();
  });

  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    api('/api/upload', { method: 'POST', body: fd })
      .then((r) => r.json())
      .then((data) => {
        if (data.message) {
          loadFiles(false);
          loadStorage();
          uploadInput.value = '';
        } else alert(data.error || 'Erreur');
      });
  });

  document.getElementById('menuImporterDossier').addEventListener('click', () => {
    closeNouveauDropdown();
    if (currentUser.org_id == null) {
      document.getElementById('settingsModal').classList.add('open');
      return;
    }
    uploadFolderInput.click();
  });

  uploadFolderInput.addEventListener('change', () => {
    const files = uploadFolderInput.files;
    if (!files || files.length === 0) return;
    let done = 0;
    const total = files.length;
    const next = (i) => {
      if (i >= total) {
        loadFiles(false);
        loadStorage();
        uploadFolderInput.value = '';
        if (total > 1) alert(total + ' fichiers importés.');
        return;
      }
      const fd = new FormData();
      fd.append('file', files[i]);
      api('/api/upload', { method: 'POST', body: fd })
        .then((r) => r.json())
        .then((data) => {
          if (data.message) done++;
          next(i + 1);
        })
        .catch(() => next(i + 1));
    };
    next(0);
  });

  function closeHeaderMenus() {
    document.getElementById('settingsDropdown').classList.remove('open');
    document.getElementById('profileDropdown').classList.remove('open');
  }

  document.getElementById('btnSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('settingsDropdown');
    document.getElementById('profileDropdown').classList.remove('open');
    dd.classList.toggle('open');
  });

  document.getElementById('userAvatar').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('profileDropdown');
    document.getElementById('settingsDropdown').classList.remove('open');
    dd.classList.toggle('open');
  });

  document.addEventListener('click', () => closeHeaderMenus());
  document.getElementById('settingsWrap').addEventListener('click', (e) => e.stopPropagation());
  document.getElementById('profileWrap').addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('menuSettingsOrg').addEventListener('click', () => {
    closeHeaderMenus();
    openSettings();
  });
  document.getElementById('menuProfileOrg').addEventListener('click', () => {
    closeHeaderMenus();
    openSettings();
  });
  document.getElementById('menuLogout').addEventListener('click', () => {
    closeHeaderMenus();
    localStorage.removeItem('drive_token');
    localStorage.removeItem('drive_email');
    window.location.href = '/';
  });

  function openSettings() {
    const modal = document.getElementById('settingsModal');
    modal.classList.add('open');
    document.getElementById('joinError').style.display = 'none';
    document.getElementById('createError').style.display = 'none';
    document.getElementById('createdCode').style.display = 'none';
    document.getElementById('joinCode').value = '';
    document.getElementById('createOrgName').value = '';
    if (currentUser.org_id == null) {
      document.getElementById('settingsNoOrg').style.display = 'block';
      document.getElementById('settingsHasOrg').style.display = 'none';
    } else {
      document.getElementById('settingsNoOrg').style.display = 'none';
      document.getElementById('settingsHasOrg').style.display = 'block';
      document.getElementById('orgName').textContent = currentUser.organization ? currentUser.organization.name : 'Organisation';
      const codeEl = document.getElementById('orgCodeLabel');
      const codeVal = document.getElementById('orgCode');
      if (currentUser.role === 'PDG' && currentUser.organization && currentUser.organization.code) {
        codeEl.style.display = 'block';
        codeVal.textContent = currentUser.organization.code;
      } else {
        codeEl.style.display = 'none';
      }
    }
  }

  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') e.target.classList.remove('open');
  });

  document.getElementById('btnJoinOrg').addEventListener('click', async () => {
    const code = document.getElementById('joinCode').value.trim().replace(/\D/g, '').slice(0, 4);
    const errEl = document.getElementById('joinError');
    if (code.length !== 4) {
      errEl.textContent = 'Le code doit faire 4 chiffres.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    const res = await api('/organizations/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (res.ok && data.token) {
      updateToken(data.token);
      currentUser = { org_id: data.organization.id, organization: data.organization, role: 'COLLABORATEUR' };
      document.getElementById('settingsModal').classList.remove('open');
      loadMe();
      refreshAll();
    } else {
      errEl.textContent = data.error || 'Erreur';
      errEl.style.display = 'block';
    }
  });

  document.getElementById('btnCreateOrg').addEventListener('click', async () => {
    const name = document.getElementById('createOrgName').value.trim();
    const errEl = document.getElementById('createError');
    const codeEl = document.getElementById('createdCode');
    if (!name) {
      errEl.textContent = "Indiquez le nom de l'organisation.";
      errEl.style.display = 'block';
      codeEl.style.display = 'none';
      return;
    }
    errEl.style.display = 'none';
    const res = await api('/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok && data.token) {
      updateToken(data.token);
      currentUser = { org_id: data.organization.id, organization: { name: data.organization.name, code: data.code }, role: 'PDG' };
      codeEl.textContent = 'Code à partager : ' + data.code;
      codeEl.style.display = 'block';
      setTimeout(() => {
        document.getElementById('settingsModal').classList.remove('open');
        loadMe();
        refreshAll();
      }, 2000);
    } else {
      errEl.textContent = data.error || 'Erreur';
      errEl.style.display = 'block';
      codeEl.style.display = 'none';
    }
  });

  const email = localStorage.getItem('drive_email') || '';
  const avatar = document.getElementById('userAvatar');
  if (avatar) avatar.textContent = (email.charAt(0) || 'U').toUpperCase();

  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => setView(el.dataset.view));
  });

  loadMe();
  setView('accueil');
})();

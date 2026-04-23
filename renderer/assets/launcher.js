(() => {
  const grid = document.getElementById('grid');
  const gridCount = document.getElementById('grid-count');
  const gridTitle = document.getElementById('grid-title');
  const updateBanner = document.getElementById('update-banner');

  const coveAPI = window.coveAPI || null;
  const IS_DESKTOP = !!coveAPI;

  const categoryLabels = {
    'cat-media': 'Media',
    'cat-docs': 'Documents',
    'cat-utils': 'Utilities',
    'cat-create': 'Create',
  };

  let state = {
    filter: 'all',
    busy: {},
    installedOverride: {},
    updated: {},
    onDisk: new Set(),
    manifests: {},
    remoteUpdates: new Set(),
    appVersion: '',
    rateLimitedUntil: 0,
    hasGithubToken: false,
  };

  function iconFor(name) {
    return (window.ICONS && window.ICONS[name]) || window.ICONS.upscale;
  }

  function isInstalled(p) {
    if (state.installedOverride[p.slug] !== undefined) return state.installedOverride[p.slug];
    if (IS_DESKTOP) return state.onDisk.has(p.slug);
    return p.installed;
  }
  function hasUpdate(p) {
    if (state.updated[p.slug]) return false;
    if (!isInstalled(p)) return false;
    if (IS_DESKTOP) return state.remoteUpdates.has(p.slug);
    return !!p.hasUpdate;
  }

  function filtered() {
    return window.PROGRAMS.filter(p => {
      if (state.filter === 'installed' && !isInstalled(p)) return false;
      if (state.filter === 'notinstalled' && isInstalled(p)) return false;
      if (state.filter === 'updates' && !hasUpdate(p)) return false;
      if (state.filter.startsWith('cat-') && p.category !== state.filter) return false;
      return true;
    });
  }

  // Primary button: Install (not installed) or Launch (installed, regardless
  // of whether an update is available — the Update button is separate so the
  // user can launch the current version without first updating).
  function primaryButton(p) {
    const busy = state.busy[p.slug];
    const installed = isInstalled(p);

    if (busy === 'installing') return { label: 'Installing…', disabled: true, spin: true };
    if (busy === 'launching')  return { label: 'Launching…',  disabled: true, spin: true };
    if (busy === 'updating')   return { label: 'Updating…',   disabled: true, spin: true };
    if (!installed) return { label: 'Install', action: 'install' };
    return { label: 'Launch', action: 'launch' };
  }

  // Returns { kind: 'ok'|'update'|'none', text: string } for the status pill.
  function statusFor(p) {
    const installed = isInstalled(p);
    if (!installed) return { kind: 'none', text: 'Not installed' };
    const version = p.version ? `v${p.version.replace(/^v/, '')}` : 'installed';
    return { kind: hasUpdate(p) ? 'update' : 'ok', text: version };
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function card(p) {
    const installed = isInstalled(p);
    const update = hasUpdate(p);
    const btn = primaryButton(p);
    const status = statusFor(p);
    const busy = state.busy[p.slug];

    const categoryLabel = categoryLabels[p.category] || '';
    const description = p.desc || '';

    const updateBtnHtml = (installed && update && !busy)
      ? `<button class="btn-update-icon" data-action="update" title="Update${p.latestTag ? ` to ${p.latestTag}` : ''}" aria-label="Update">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
         </button>`
      : '';

    return `
      <article class="card ${update ? 'pending' : ''}" data-slug="${p.slug}">
        <div class="card-top">
          <div class="app-icon">${iconFor(p.icon)}</div>
          <div class="card-title-row">
            <div class="row1">
              <h4>${p.name}</h4>
            </div>
          </div>
        </div>

        ${categoryLabel ? `<div class="card-meta"><span class="chip">${categoryLabel}</span></div>` : ''}

        <div class="card-desc" title="${escapeAttr(description)}">${description}</div>

        <div class="card-bottom">
          <span class="status-pill ${status.kind}" title="${status.kind === 'update' ? 'Update available' : status.kind === 'ok' ? 'Up to date' : 'Not installed'}">
            <span class="dot"></span>${status.text}
          </span>
          <div style="display:flex;gap:6px;align-items:center;">
            ${updateBtnHtml}
            <button class="btn btn-sm btn-primary" data-action="${btn.action || ''}" ${btn.disabled ? 'disabled style="opacity:.6;cursor:default"' : ''}>
              ${btn.spin ? '<svg class="ico spin-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.55"/></svg>' : ''}
              ${btn.label}
            </button>
            <button class="icon-btn" data-action="menu" aria-label="More">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function render() {
    const list = filtered();
    grid.innerHTML = list.map(card).join('');
    gridCount.textContent = list.length;

    const filterLabels = {
      all: 'All programs',
      installed: 'Installed',
      notinstalled: 'Not installed',
      updates: 'Available updates',
    };
    gridTitle.textContent = filterLabels[state.filter] || categoryLabels[state.filter] || 'Programs';

    const updates = window.PROGRAMS.filter(hasUpdate);
    updateBanner.style.display = updates.length ? 'flex' : 'none';

    const all = window.PROGRAMS.length;
    const installed = window.PROGRAMS.filter(isInstalled).length;
    const notinstalled = all - installed;
    const updatesCount = updates.length;
    document.querySelectorAll('#nav-library button').forEach(b => {
      const f = b.dataset.filter;
      const countEl = b.querySelector('.count');
      if (!countEl) return;
      if (f === 'all') countEl.textContent = all;
      if (f === 'installed') countEl.textContent = installed;
      if (f === 'notinstalled') countEl.textContent = notinstalled;
      if (f === 'updates') countEl.textContent = updatesCount;
    });

    const brandMeta = document.getElementById('brand-meta');
    if (brandMeta) {
      const v = state.appVersion ? `v${state.appVersion}` : '';
      const unit = all === 1 ? 'app' : 'apps';
      brandMeta.textContent = [v, `${all} ${unit}`].filter(Boolean).join(' — ');
    }

    renderUpdateBanner(updates);
    renderFeatured();
  }

  function renderUpdateBanner(updates) {
    const title = document.getElementById('ub-title');
    const detail = document.getElementById('ub-detail');
    if (!title || !detail) return;
    if (!updates.length) { detail.textContent = ''; return; }
    const n = updates.length;
    title.textContent = `${n} ${n === 1 ? 'program has' : 'programs have'} updates available.`;
    detail.textContent = updates.map(p => p.name).join(', ');
  }

  function renderFeatured() {
    const prog = window.PROGRAMS.find(p => p.featured) || window.PROGRAMS.find(hasUpdate) || window.PROGRAMS[0];
    if (!prog) return;
    const title = document.getElementById('ft-title');
    const desc = document.getElementById('ft-desc');
    const version = document.getElementById('ft-version');
    const date = document.getElementById('ft-date');
    const shot = document.getElementById('ft-screenshot');
    const primaryLabel = document.getElementById('ft-primary-label');
    if (title) title.textContent = prog.version ? `${prog.name} ${prog.version}` : prog.name;
    if (desc) desc.textContent = prog.desc || '';
    if (version) version.textContent = prog.version ? `v${prog.version}` : '';
    if (date) date.textContent = prog.updated || '';
    if (shot) {
      if (prog.preview) { shot.src = prog.preview; shot.style.display = ''; }
      else { shot.style.display = 'none'; }
    }
    if (primaryLabel) {
      const busy = state.busy[prog.slug];
      if (busy === 'installing') primaryLabel.textContent = 'Installing…';
      else if (busy === 'launching') primaryLabel.textContent = 'Launching…';
      else if (busy === 'updating') primaryLabel.textContent = 'Updating…';
      else if (!isInstalled(prog)) primaryLabel.textContent = 'Install';
      else if (hasUpdate(prog)) primaryLabel.textContent = 'Update now';
      else primaryLabel.textContent = 'Launch';
    }
  }

  function toast(msg, kind = 'info') {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:80;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = msg;
    const border = kind === 'error' ? 'rgba(255,107,107,0.4)' : 'var(--border-strong)';
    el.style.cssText = `pointer-events:auto;background:#0f0f17;color:var(--text);border:1px solid ${border};border-radius:10px;padding:10px 14px;font-size:12.5px;max-width:360px;box-shadow:0 20px 40px -20px rgba(0,0,0,0.8);opacity:0;transition:opacity 160ms, transform 160ms;transform:translateY(-4px);`;
    host.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, kind === 'error' ? 6000 : 2600);
  }

  async function doInstall(prog) {
    const slug = prog.slug;
    state.busy[slug] = 'installing';
    render();
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.install(slug);
        if (!res.ok) throw new Error(res.error || 'install failed');
        state.onDisk.add(slug);
        toast(`${prog.name} installed`);
      } else {
        await new Promise(r => setTimeout(r, 1200));
      }
      state.installedOverride[slug] = true;
    } catch (e) {
      toast(`Install failed: ${e.message}`, 'error');
    } finally {
      state.busy[slug] = null;
      render();
      // Pick up manifest/update state on the freshly cloned repo.
      if (IS_DESKTOP) { rescan().then(render); }
    }
  }

  async function doLaunch(prog) {
    const slug = prog.slug;
    state.busy[slug] = 'launching';
    render();
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.launch(slug);
        if (!res.ok) throw new Error(res.error || 'launch failed');
        toast(`${prog.name} launched (${res.kind})`);
      } else {
        await new Promise(r => setTimeout(r, 900));
      }
    } catch (e) {
      toast(`Launch failed: ${e.message}`, 'error');
    } finally {
      state.busy[slug] = null;
      render();
    }
  }

  async function doUpdate(prog) {
    const slug = prog.slug;
    state.busy[slug] = 'updating';
    render();
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.update(slug);
        if (!res.ok) throw new Error(res.error || 'update failed');
        toast(`${prog.name} up to date`);
      } else {
        await new Promise(r => setTimeout(r, 1200));
      }
      state.remoteUpdates.delete(slug);
      state.updated[slug] = true;
      prog.version = prog.newVersion || prog.version;
    } catch (e) {
      toast(`Update failed: ${e.message}`, 'error');
    } finally {
      state.busy[slug] = null;
      render();
      if (IS_DESKTOP) { rescan().then(render); }
    }
  }

  async function doUninstall(prog) {
    const slug = prog.slug;
    try {
      if (IS_DESKTOP) {
        const res = await coveAPI.uninstall(slug);
        if (res.cancelled) return;
        if (!res.ok) throw new Error(res.error || 'uninstall failed');
        state.onDisk.delete(slug);
      }
      state.installedOverride[slug] = false;
      toast(`${prog.name} removed`);
      render();
    } catch (e) {
      toast(`Uninstall failed: ${e.message}`, 'error');
    }
  }

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    const slug = cardEl.dataset.slug;
    const prog = window.PROGRAMS.find(p => p.slug === slug);
    if (!prog) return;
    const action = btn.dataset.action;

    if (action === 'install') doInstall(prog);
    else if (action === 'launch') doLaunch(prog);
    else if (action === 'update') doUpdate(prog);
    else if (action === 'menu') openCardMenu(btn, prog);
  });

  function openCardMenu(anchor, prog) {
    document.getElementById('card-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'card-menu';
    const installed = isInstalled(prog);
    const pinned = prog.pinnedTag || '';
    // For Release notes, prefer the tag we'd land on next:
    //   - hasUpdate → latestTag (what an Update would bring)
    //   - installed, no update → current version (what you have)
    //   - not installed → /releases/latest
    const update = hasUpdate(prog);
    const releaseTag = update ? (prog.latestTag || '') : (installed && prog.version ? `v${prog.version.replace(/^v/, '')}` : '');
    const releaseUrl = releaseTag
      ? `https://github.com/Sin213/${prog.slug}/releases/tag/${releaseTag}`
      : `https://github.com/Sin213/${prog.slug}/releases/latest`;

    const items = [
      { label: 'Open GitHub', onClick: () => window.open(`https://github.com/Sin213/${prog.slug}`, '_blank') },
      { label: 'Release notes', onClick: () => window.open(releaseUrl, '_blank') },
    ];
    if (IS_DESKTOP) {
      items.push({
        label: pinned ? `Pinned to ${pinned} — change…` : 'Pin version…',
        onClick: () => openPinModal(prog),
      });
      items.push({
        label: 'Change path…',
        onClick: () => doChangePath(prog),
      });
      if (installed) {
        items.push({ label: 'Show install folder', onClick: () => coveAPI.revealInstall(prog.slug) });
        items.push({ label: 'Uninstall', danger: true, onClick: () => doUninstall(prog) });
      }
    }
    menu.innerHTML = items.map((it, i) =>
      `<button data-i="${i}" style="all:unset;cursor:pointer;display:block;width:100%;padding:8px 12px;font-size:12.5px;color:${it.danger ? '#ff6b6b' : 'var(--text)'};border-radius:6px;">${it.label}</button>`
    ).join('');
    menu.style.cssText = 'position:fixed;z-index:70;background:#0f0f17;border:1px solid var(--border-strong);border-radius:10px;padding:4px;min-width:200px;box-shadow:0 20px 40px -16px rgba(0,0,0,0.8);';
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - 220, r.bottom + 6)}px`;
    menu.style.left = `${Math.min(window.innerWidth - 220, r.right - 200)}px`;
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      const i = Number(b.dataset.i);
      items[i]?.onClick?.();
      menu.remove();
    });
    setTimeout(() => {
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  }

  async function doChangePath(prog) {
    if (!IS_DESKTOP) return;
    try {
      const res = await coveAPI.setCustomPath(prog.slug);
      if (res?.cancelled) return;
      if (!res?.ok) throw new Error(res?.error || 'failed');
      toast(`${prog.name}: using ${res.path.split('/').pop() || res.path}${res.tag ? ` (${res.tag})` : ''}`);
      state.installedOverride[prog.slug] = true;
      await rescan();
      render();
    } catch (e) {
      toast(`Couldn't set path: ${e.message}`, 'error');
    }
  }

  document.querySelectorAll('#nav-library button, #nav-categories button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#nav-library button, #nav-categories button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.filter = b.dataset.filter;
      render();
    });
  });

  updateBanner.querySelector('button')?.addEventListener('click', () => {
    const btn = document.querySelector('#nav-library button[data-filter="updates"]');
    btn?.click();
  });

  function currentFeatured() {
    return window.PROGRAMS.find(p => p.featured) || window.PROGRAMS.find(hasUpdate) || window.PROGRAMS[0];
  }
  document.getElementById('ft-primary')?.addEventListener('click', () => {
    const prog = currentFeatured();
    if (!prog) return;
    if (!isInstalled(prog)) doInstall(prog);
    else if (hasUpdate(prog)) doUpdate(prog);
    else doLaunch(prog);
  });
  document.getElementById('ft-notes')?.addEventListener('click', () => {
    const prog = currentFeatured();
    if (!prog) return;
    window.open(`https://github.com/Sin213/${prog.slug}/releases`, '_blank');
  });

  const tweaksPanel = document.getElementById('tweaks');
  function applyTweaks(t) {
    if (t.accent) {
      document.documentElement.style.setProperty('--accent', t.accent);
      const hex = t.accent.replace('#','');
      const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
      document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.14)`);
      document.documentElement.style.setProperty('--accent-ring', `rgba(${r},${g},${b},0.35)`);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      document.documentElement.style.setProperty('--accent-on', lum > 0.55 ? '#0b0b10' : '#ffffff');
      document.querySelectorAll('#swatches button').forEach(b => b.classList.toggle('active', b.dataset.accent.toLowerCase() === t.accent.toLowerCase()));
    }
    if (t.density) {
      document.body.dataset.density = t.density;
      document.querySelectorAll('#density-seg button').forEach(b => b.classList.toggle('active', b.dataset.density === t.density));
    }
    if (t.chrome) {
      document.body.dataset.chrome = t.chrome;
      document.querySelectorAll('#chrome-seg button').forEach(b => b.classList.toggle('active', b.dataset.chrome === t.chrome));
    }
  }

  let savedTweaks = {};
  try { savedTweaks = JSON.parse(localStorage.getItem('cove-tweaks') || '{}'); } catch {}
  const initialTweaks = { ...(window.TWEAK_DEFAULTS || {}), ...savedTweaks };
  applyTweaks(initialTweaks);
  let currentTweaks = { ...initialTweaks };

  function persistTweaks() {
    try { localStorage.setItem('cove-tweaks', JSON.stringify(currentTweaks)); } catch {}
  }

  document.querySelectorAll('#swatches button').forEach(b => {
    b.addEventListener('click', () => {
      currentTweaks.accent = b.dataset.accent;
      applyTweaks({ accent: currentTweaks.accent });
      persistTweaks();
    });
  });
  document.querySelectorAll('#density-seg button').forEach(b => {
    b.addEventListener('click', () => {
      currentTweaks.density = b.dataset.density;
      applyTweaks({ density: currentTweaks.density });
      persistTweaks();
    });
  });
  document.querySelectorAll('#chrome-seg button').forEach(b => {
    b.addEventListener('click', () => {
      currentTweaks.chrome = b.dataset.chrome;
      applyTweaks({ chrome: currentTweaks.chrome });
      persistTweaks();
    });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      tweaksPanel.classList.toggle('show');
    }
    if (e.key === 'Escape' && tweaksPanel.classList.contains('show')) {
      tweaksPanel.classList.remove('show');
    }
  });

  const style = document.createElement('style');
  style.textContent = `
    .spin-svg { animation: spin 900ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  // ——— window controls ———
  document.querySelectorAll('.traffic span[data-wbtn]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!IS_DESKTOP) return;
      const w = btn.dataset.wbtn;
      if (w === 'close')    coveAPI.win.close();
      if (w === 'minimize') coveAPI.win.minimize();
      if (w === 'maximize') coveAPI.win.maximizeToggle();
    });
  });

  // ——— GitHub auto-discovery ———
  // Merge repos from github.com/Sin213 matching cove-* into window.PROGRAMS.
  // Static entries in programs.js win for icon/category; new repos get defaults.
  const DEFAULT_ICON = 'upscale'; // fallback until you add it to programs.js
  async function discoverAndMerge({ force = false } = {}) {
    if (!IS_DESKTOP) return;
    try {
      const res = await coveAPI.discover({ force });
      if (!res.ok) { toast(`Discovery failed: ${res.error}`, 'error'); return; }
      const bySlug = new Map(window.PROGRAMS.map(p => [p.slug, p]));
      let added = 0;
      for (const r of res.repos) {
        const existing = bySlug.get(r.slug);
        if (existing) {
          // refresh description + updated from GitHub, keep our icon/category/etc.
          if (r.desc) existing.desc = r.desc;
          if (r.updated) existing.updated = r.updated;
          if (r.lang && existing.lang === undefined) existing.lang = r.lang;
        } else {
          window.PROGRAMS.push({
            name: r.name,
            slug: r.slug,
            desc: r.desc || 'Auto-discovered from github.com/Sin213.',
            icon: DEFAULT_ICON,
            category: 'cat-utils',
            lang: r.lang || '—',
            version: r.version || '—',
            updated: r.updated || '—',
            installed: false,
            hasUpdate: false,
            discovered: true,
          });
          bySlug.set(r.slug, window.PROGRAMS[window.PROGRAMS.length - 1]);
          added++;
        }
      }
      if (added > 0 && !res.cached) toast(`Found ${added} new repo${added === 1 ? '' : 's'} on github.com/Sin213`);
      render();
    } catch (e) {
      toast(`Discovery failed: ${e.message}`, 'error');
    }
  }

  // Merge a .cove.json manifest into the program entry.
  // Static/registered fields don't get overwritten if the manifest is absent;
  // when present, manifest wins for fields it sets (authoritative per-repo).
  function applyManifest(prog, manifest) {
    if (!manifest || typeof manifest !== 'object') return;
    if (typeof manifest.name === 'string')        prog.name = manifest.name;
    if (typeof manifest.icon === 'string')        prog.icon = manifest.icon;
    if (typeof manifest.category === 'string')    prog.category = manifest.category;
    if (typeof manifest.description === 'string') prog.desc = manifest.description;
    if (typeof manifest.version === 'string')     prog.version = manifest.version;
    prog.hasManifest = true;
  }

  async function rescan() {
    if (!IS_DESKTOP) return;
    try {
      const s = await coveAPI.scan({ checkUpdates: true });
      state.onDisk = new Set((s.installed || []).map(x => x.slug));
      state.manifests = {};
      state.remoteUpdates = new Set();
      state.rateLimitedUntil = s.rateLimitedUntil || 0;
      for (const row of s.installed || []) {
        if (row.manifest) state.manifests[row.slug] = row.manifest;
        if (row.hasUpdate) state.remoteUpdates.add(row.slug);
        const prog = window.PROGRAMS.find(p => p.slug === row.slug);
        if (prog && row.manifest) applyManifest(prog, row.manifest);
        if (prog) {
          prog.pinnedTag = row.pinnedTag || '';
          prog.latestTag = row.latestTag || '';
          prog.source = row.source || '';
          if (row.version) prog.version = row.version.replace(/^v/, '');
        }
      }
      renderRateLimitBanner();
    } catch (e) {
      // Don't spam the toast while we're rate-limited — the banner is enough.
      if (!/rate-limited/i.test(e.message || '')) {
        toast(`Scan failed: ${e.message}`, 'error');
      }
      renderRateLimitBanner();
    }
  }

  function renderRateLimitBanner() {
    const banner = document.getElementById('rate-banner');
    const text = document.getElementById('rate-banner-text');
    if (!banner || !text) return;
    const until = state.rateLimitedUntil || 0;
    if (!until || Date.now() >= until) { banner.style.display = 'none'; return; }
    const when = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const tokenMsg = state.hasGithubToken
      ? ' Even with a token, you\'re at the limit — try again shortly.'
      : ' Add a GitHub token in Settings for a higher limit (5000/hr instead of 60/hr).';
    text.textContent = `GitHub rate-limited until ${when}.${tokenMsg}`;
    banner.style.display = 'flex';
  }

  async function doRefresh(opts = {}) {
    const btn = document.getElementById('btn-refresh');
    if (btn && btn.classList.contains('spinning')) return;
    btn?.classList.add('spinning');
    try {
      // Manual refresh force-clears the GitHub cache; auto-refresh doesn't.
      if (opts.force !== false && IS_DESKTOP) {
        try { await coveAPI.refresh(); } catch {}
      }
      await rescan();
      await discoverAndMerge({ force: true });
      render();
    } finally {
      btn?.classList.remove('spinning');
    }
  }

  document.getElementById('btn-refresh')?.addEventListener('click', doRefresh);

  // Settings modal
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsPath = document.getElementById('settings-programs-root');
  const settingsConfigPath = document.getElementById('settings-config-dir');

  async function refreshSettingsPaths() {
    if (!IS_DESKTOP) return;
    try {
      const cfg = await coveAPI.config.get();
      if (settingsPath) settingsPath.textContent = cfg.programsRoot || '—';
      if (settingsConfigPath) settingsConfigPath.textContent = cfg.userData || '—';
      state.hasGithubToken = !!cfg.hasGithubToken;
      state.rateLimitedUntil = cfg.rateLimitedUntil || state.rateLimitedUntil || 0;
      const statusEl = document.getElementById('settings-token-status');
      const tokenInput = document.getElementById('settings-token');
      if (tokenInput) tokenInput.value = cfg.hasGithubToken ? '••••••••••••••••' : '';
      if (statusEl) statusEl.textContent = cfg.hasGithubToken ? 'Token saved. Cleared cache; next scan uses the token.' : 'No token set — using 60/hr unauthenticated limit.';
      renderRateLimitBanner();
    } catch {}
  }
  function openSettings() {
    if (!settingsOverlay) return;
    refreshSettingsPaths();
    settingsOverlay.classList.add('open');
  }
  function closeSettings() { settingsOverlay?.classList.remove('open'); }

  document.getElementById('btn-settings')?.addEventListener('click', openSettings);
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  settingsOverlay?.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeSettings();
    if (typeof closePinModal === 'function') closePinModal();
  });

  document.getElementById('settings-change')?.addEventListener('click', async () => {
    if (!IS_DESKTOP) return;
    const res = await coveAPI.config.setProgramsRoot();
    if (res?.ok) {
      toast(`Programs folder → ${res.programsRoot}`);
      await refreshSettingsPaths();
      await rescan();
      render();
    } else if (res?.error) {
      toast(`Couldn't change folder: ${res.error}`, 'error');
    }
  });
  document.getElementById('settings-open')?.addEventListener('click', () => {
    if (IS_DESKTOP) coveAPI.config.revealProgramsRoot();
  });
  document.getElementById('settings-open-config')?.addEventListener('click', () => {
    if (IS_DESKTOP) coveAPI.config.revealConfigDir();
  });
  document.getElementById('settings-token-save')?.addEventListener('click', async () => {
    if (!IS_DESKTOP) return;
    const input = document.getElementById('settings-token');
    const val = (input?.value || '').trim();
    // The placeholder dots mean "token already saved, left untouched". Don't
    // overwrite a real token with masked dots.
    if (/^•+$/.test(val)) return;
    if (!val) return;
    try {
      const res = await coveAPI.config.setGithubToken(val);
      if (!res?.ok) throw new Error('save failed');
      toast('GitHub token saved — cache cleared.');
      if (input) input.value = '••••••••••••••••';
      await refreshSettingsPaths();
      await rescan();
      render();
    } catch (e) {
      toast(`Couldn't save token: ${e.message}`, 'error');
    }
  });
  document.getElementById('settings-token-clear')?.addEventListener('click', async () => {
    if (!IS_DESKTOP) return;
    try {
      const res = await coveAPI.config.setGithubToken('');
      if (!res?.ok) throw new Error('clear failed');
      toast('GitHub token cleared.');
      const input = document.getElementById('settings-token');
      if (input) input.value = '';
      await refreshSettingsPaths();
    } catch (e) {
      toast(`Couldn't clear token: ${e.message}`, 'error');
    }
  });

  // Pin-version modal
  const pinOverlay   = document.getElementById('pin-overlay');
  const pinList      = document.getElementById('pin-tag-list');
  const pinConfirm   = document.getElementById('pin-confirm');
  const pinUnpin     = document.getElementById('pin-unpin');
  const pinCancel    = document.getElementById('pin-cancel');
  const pinTitle     = document.getElementById('pin-title');
  const pinSub       = document.getElementById('pin-sub');
  let pinProg = null;
  let pinSelectedTag = '';

  function closePinModal() { pinOverlay?.classList.remove('open'); pinProg = null; pinSelectedTag = ''; }

  async function openPinModal(prog) {
    if (!IS_DESKTOP || !pinOverlay) return;
    pinProg = prog;
    pinSelectedTag = '';
    pinTitle.textContent = `Pin ${prog.name}`;
    pinSub.textContent = 'Select a release to install. Cove Nexus will stay on this version until you unpin.';
    pinList.innerHTML = '<div class="empty">Loading releases…</div>';
    pinConfirm.disabled = true;
    pinUnpin.style.display = prog.pinnedTag ? 'inline-block' : 'none';
    pinOverlay.classList.add('open');

    try {
      const res = await coveAPI.releases(prog.slug);
      if (!res?.ok) throw new Error(res?.error || 'failed');
      const rows = res.releases.filter(r => r.hasAsset);
      if (!rows.length) { pinList.innerHTML = '<div class="empty">No releases with compatible assets for this platform.</div>'; return; }
      const currentTag = res.current || '';
      const pinnedTag = res.pinned || '';
      pinList.innerHTML = rows.map(r => {
        const chips = [];
        if (r.tag === currentTag) chips.push('<span class="tag-chip current">installed</span>');
        if (r.tag === pinnedTag)  chips.push('<span class="tag-chip current">pinned</span>');
        if (r.prerelease)         chips.push('<span class="tag-chip">pre-release</span>');
        const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }) : '';
        return `<div class="tag-row" data-tag="${r.tag}">
          <div class="tag-name">${r.tag}</div>
          <div class="tag-meta">${date}</div>
          ${chips.join('')}
        </div>`;
      }).join('');
      pinList.querySelectorAll('.tag-row').forEach(row => {
        row.addEventListener('click', () => {
          pinList.querySelectorAll('.tag-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          pinSelectedTag = row.dataset.tag;
          pinConfirm.disabled = false;
        });
      });
    } catch (e) {
      pinList.innerHTML = `<div class="empty">Couldn't load releases: ${e.message}</div>`;
    }
  }

  pinCancel?.addEventListener('click', closePinModal);
  pinOverlay?.addEventListener('click', (e) => { if (e.target === pinOverlay) closePinModal(); });
  pinConfirm?.addEventListener('click', async () => {
    if (!pinProg || !pinSelectedTag) return;
    const slug = pinProg.slug;
    const prog = pinProg;
    pinConfirm.disabled = true;
    pinConfirm.textContent = 'Pinning…';
    try {
      const res = await coveAPI.pin(slug, pinSelectedTag);
      if (!res?.ok) throw new Error(res?.error || 'pin failed');
      toast(`${prog.name} pinned to ${res.tag}`);
      state.installedOverride[slug] = true;
      state.remoteUpdates.delete(slug);
      closePinModal();
      await rescan();
      render();
    } catch (e) {
      toast(`Pin failed: ${e.message}`, 'error');
      pinConfirm.disabled = false;
    } finally {
      pinConfirm.textContent = 'Pin';
    }
  });
  async function doUpdateAll() {
    const updates = window.PROGRAMS.filter(hasUpdate);
    if (!updates.length) return;
    if (IS_DESKTOP) {
      const names = updates.map(p => `${p.name}${p.latestTag ? ` → ${p.latestTag}` : ''}`);
      const confirmed = await coveAPI.confirmUpdateAll(names);
      if (!confirmed?.ok) return;
    }
    // Sequential updates keep the network calm and surface failures one at
    // a time in toasts rather than as a pile.
    for (const prog of updates) {
      // eslint-disable-next-line no-await-in-loop
      await doUpdate(prog);
    }
    toast(`Updated ${updates.length} ${updates.length === 1 ? 'program' : 'programs'}`);
  }
  document.getElementById('btn-update-all')?.addEventListener('click', doUpdateAll);

  pinUnpin?.addEventListener('click', async () => {
    if (!pinProg) return;
    const slug = pinProg.slug;
    const prog = pinProg;
    try {
      const res = await coveAPI.unpin(slug);
      if (!res?.ok) throw new Error(res?.error || 'unpin failed');
      toast(`${prog.name} unpinned`);
      closePinModal();
      await rescan();
      render();
    } catch (e) {
      toast(`Unpin failed: ${e.message}`, 'error');
    }
  });

  // Auto-refresh is intentionally conservative to stay under the GitHub
  // unauthenticated rate limit (60/hr) with ~9 installed tools. Main
  // process caches each /releases/latest response for 10 min, so even a
  // manual refresh between ticks costs nothing.
  if (IS_DESKTOP) {
    const THIRTY_MIN = 30 * 60 * 1000;
    setInterval(() => { doRefresh({ force: false }); }, THIRTY_MIN);
    let lastBlur = 0;
    window.addEventListener('blur', () => { lastBlur = Date.now(); });
    window.addEventListener('focus', () => {
      if (lastBlur && Date.now() - lastBlur > 10 * 60 * 1000) doRefresh({ force: false });
    });
  }

  async function init() {
    if (IS_DESKTOP) {
      try {
        const info = await coveAPI.appInfo();
        if (info?.version) state.appVersion = info.version;
      } catch {}
    }
    await rescan();
    render();
    discoverAndMerge();
  }
  init();
})();

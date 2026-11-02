/* 知乎收藏夹批量管理 - 管理器页面逻辑 */

const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  collections: [],
  current: null,
  items: [],
  selected: new Set(),
  filter: '',
  busy: false,
  editingCollection: null,
  deletingCollection: null,
};

function api(method, url, body, bodyType) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'zhihu-api', method, url, body, bodyType }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, status: 0, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, status: 0 });
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  await checkLogin();
}

async function checkLogin() {
  const resp = await api('GET', 'https://www.zhihu.com/api/v4/me');
  if (resp.ok && resp.data && resp.data.url_token) {
    state.me = resp.data;
    $('#userInfo').textContent = `已登录：${resp.data.name || resp.data.url_token}`;
    $('#loginView').hidden = true;
    $('#mainView').hidden = false;
    await loadCollections();
  } else {
    $('#userInfo').textContent = '未登录';
    $('#loginView').hidden = false;
    $('#mainView').hidden = true;
  }
}

function bindEvents() {
  $('#loginBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.zhihu.com/signin' });
  });
  $('#refreshCollectionsBtn').addEventListener('click', async () => {
    if (!state.me) { await checkLogin(); return; }
    await loadCollections();
  });
  $('#collectionFilter').addEventListener('input', (e) => renderCollections(e.target.value.trim()));
  $('#createCollectionBtn').addEventListener('click', openCreateCollectionModal);
  $('#reloadItemsBtn').addEventListener('click', () => state.current && !state.busy && loadItems(state.current));
  $('#selectAll').addEventListener('change', onSelectAll);
  $('#invertBtn').addEventListener('click', onInvert);
  $('#itemFilter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    renderItems();
  });
  $('#removeBtn').addEventListener('click', batchRemove);
  $('#moveBtn').addEventListener('click', openMoveModal);
  $('#exportLinksBtn').addEventListener('click', exportTitleLinks);
  $('#exportContentBtn').addEventListener('click', exportContentsZip);
  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportItems(btn.dataset.fmt));
  });
  $('#moveCancel').addEventListener('click', closeMoveModal);
  $('#moveModal').addEventListener('click', (e) => {
    if (e.target.id === 'moveModal') closeMoveModal();
  });
  $('#moveConfirm').addEventListener('click', () => {
    const sel = document.querySelector('input[name="moveTarget"]:checked');
    if (!sel) return;
    const target = state.collections.find((c) => String(c.id) === sel.value);
    closeMoveModal();
    if (target) batchMove(target);
  });
  $('#collectionModalCancel').addEventListener('click', closeCollectionModal);
  $('#collectionModal').addEventListener('click', (e) => {
    if (e.target.id === 'collectionModal') closeCollectionModal();
  });
  $('#collectionModalConfirm').addEventListener('click', () => {
    if (state.editingCollection) handleEditCollection();
    else handleCreateCollection();
  });
  $('#deleteCancel').addEventListener('click', closeDeleteModal);
  $('#deleteModal').addEventListener('click', (e) => {
    if (e.target.id === 'deleteModal') closeDeleteModal();
  });
  $('#deleteConfirm').addEventListener('click', () => handleDeleteCollection());
}

async function loadCollections() {
  setStatus('正在加载收藏夹…');
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `https://www.zhihu.com/api/v4/people/${state.me.url_token}/collections?offset=${offset}&limit=20`;
    const resp = await api('GET', url);
    if (!resp.ok || !resp.data || !Array.isArray(resp.data.data)) {
      setStatus(`收藏夹加载失败（HTTP ${resp.status || '网络错误'}）`);
      return;
    }
    all.push(...resp.data.data);
    setStatus(`正在加载收藏夹… ${all.length}`);
    if ((resp.data.paging && resp.data.paging.is_end) || resp.data.data.length === 0) break;
    offset += resp.data.data.length;
  }
  state.collections = all;
  renderCollections($('#collectionFilter').value.trim());
  setStatus(`共 ${all.length} 个收藏夹，点击左侧查看内容`);
}

function renderCollections(filter = '') {
  const ul = $('#collectionList');
  ul.innerHTML = '';
  const kw = filter.toLowerCase();
  const list = state.collections.filter((c) => !kw || (c.title || '').toLowerCase().includes(kw));
  for (const c of list) {
    const li = document.createElement('li');
    if (state.current && state.current.id === c.id) li.classList.add('active');
    const main = document.createElement('div');
    main.style.display = 'flex';
    main.style.alignItems = 'center';
    main.style.gap = '8px';
    main.style.flex = '1';
    main.style.minWidth = '0';
    const title = document.createElement('span');
    title.className = 'c-title';
    title.textContent = c.title || '(未命名)';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = c.item_count ?? '';
    main.append(title, count);
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'item-action-btn';
    editBtn.textContent = '编辑';
    editBtn.title = '编辑收藏夹';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditCollectionModal(c); });
    const delBtn = document.createElement('button');
    delBtn.className = 'item-action-btn delete';
    delBtn.textContent = '删除';
    delBtn.title = '删除收藏夹';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteModal(c); });
    actions.append(editBtn, delBtn);
    li.append(main, actions);
    li.title = c.title || '';
    li.addEventListener('click', () => selectCollection(c));
    ul.appendChild(li);
  }
}

async function selectCollection(c) {
  if (state.busy) return;
  state.current = c;
  renderCollections($('#collectionFilter').value.trim());
  await loadItems(c);
}

async function loadItems(collection) {
  state.items = [];
  state.selected.clear();
  renderItems();
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `https://www.zhihu.com/api/v4/collections/${collection.id}/items?offset=${offset}&limit=20`;
    const resp = await api('GET', url);
    if (!resp.ok || !resp.data || !Array.isArray(resp.data.data)) {
      setStatus(`「${collection.title}」加载失败（HTTP ${resp.status || '网络错误'}）`);
      break;
    }
    all.push(...resp.data.data);
    setStatus(`正在加载「${collection.title}」… ${all.length}/${collection.item_count || '?'}`);
    if ((resp.data.paging && resp.data.paging.is_end) || resp.data.data.length === 0) break;
    offset += resp.data.data.length;
  }
  state.items = all.map((item, idx) => normalizeItem(item, idx));
  setStatus(`「${collection.title}」已加载 ${state.items.length} 条收藏`);
  renderItems();
}

function normalizeItem(item, idx) {
  const c = item.content || {};
  const type = c.type || 'unknown';
  let title = '';
  let url = '';
  if (type === 'answer') {
    title = (c.question && c.question.title) || '(无标题回答)';
    url = c.url ? (c.url.startsWith('http') ? c.url : 'https://www.zhihu.com' + c.url) : `https://www.zhihu.com/question/${c.question && c.question.id}/answer/${c.id}`;
  } else if (type === 'article') {
    title = c.title || '(无标题文章)';
    url = c.url || `https://zhuanlan.zhihu.com/p/${c.id}`;
  } else {
    title = c.title || (c.question && c.question.title) || '(其他内容)';
    url = c.url || '';
    if (url && url.startsWith('/')) url = 'https://www.zhihu.com' + url;
  }
  return {
    uid: `${type}_${c.id != null ? c.id : `idx${idx}`}`,
    contentId: c.id,
    type,
    title,
    url,
    author: (c.author && c.author.name) || '',
  };
}

function filteredItems() {
  if (!state.filter) return state.items;
  return state.items.filter((it) => it.title.toLowerCase().includes(state.filter) || it.author.toLowerCase().includes(state.filter));
}

function renderItems() {
  const tbody = $('#itemsBody');
  tbody.innerHTML = '';
  const list = filteredItems();
  $('#emptyTip').hidden = list.length > 0;
  for (const it of list) {
    const tr = document.createElement('tr');
    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(it.uid);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(it.uid);
      else state.selected.delete(it.uid);
      updateSelectionUI();
    });
    tdCheck.appendChild(cb);
    const tdType = document.createElement('td');
    const badge = document.createElement('span');
    const typeName = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
    badge.className = `badge badge-${it.type === 'answer' ? 'answer' : it.type === 'article' ? 'article' : 'other'}`;
    badge.textContent = typeName;
    tdType.appendChild(badge);
    const tdTitle = document.createElement('td');
    tdTitle.className = 'item-title';
    if (it.url) {
      const a = document.createElement('a');
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = it.title;
      tdTitle.appendChild(a);
    } else {
      tdTitle.textContent = it.title;
    }
    const tdAuthor = document.createElement('td');
    tdAuthor.className = 'author-cell';
    tdAuthor.textContent = it.author;
    tr.append(tdCheck, tdType, tdTitle, tdAuthor);
    tbody.appendChild(tr);
  }
  updateSelectionUI();
}

function onSelectAll(e) {
  const checked = e.target.checked;
  for (const it of filteredItems()) {
    if (checked) state.selected.add(it.uid);
    else state.selected.delete(it.uid);
  }
  renderItems();
}

function onInvert() {
  for (const it of filteredItems()) {
    if (state.selected.has(it.uid)) state.selected.delete(it.uid);
    else state.selected.add(it.uid);
  }
  renderItems();
}

function updateSelectionUI() {
  $('#selCount').textContent = `已选 ${state.selected.size} 项`;
  $('#removeBtn').disabled = state.selected.size === 0 || state.busy;
  $('#moveBtn').disabled = state.selected.size === 0 || state.busy;
  const list = filteredItems();
  const allChecked = list.length > 0 && list.every((it) => state.selected.has(it.uid));
  $('#selectAll').checked = allChecked;
}

async function batchRemove() {
  if (!state.current || state.busy) return;
  const targets = state.items.filter((it) => state.selected.has(it.uid));
  if (targets.length === 0) return;
  if (!confirm(`确定从「${state.current.title}」中移除 ${targets.length} 条收藏吗？\n（仅从收藏夹移除，不影响原内容）`)) return;
  state.busy = true;
  updateSelectionUI();
  const failed = [];
  let done = 0;
  await runPool(targets, 3, async (it) => {
    const url = `https://www.zhihu.com/api/v4/collections/${state.current.id}/contents/${it.contentId}`;
    const resp = await api('DELETE', url);
    if (resp.ok) {
      state.selected.delete(it.uid);
      state.items = state.items.filter((x) => x.uid !== it.uid);
    } else {
      failed.push(it);
    }
    done++;
    setStatus(`正在移除… ${done}/${targets.length}`);
    if (done % 5 === 0) renderItems();
  });
  renderItems();
  state.busy = false;
  if (state.current && typeof state.current.item_count === 'number') {
    state.current.item_count = Math.max(0, state.current.item_count - (targets.length - failed.length));
    renderCollections($('#collectionFilter').value.trim());
  }
  if (failed.length) {
    setStatus(`完成：成功 ${targets.length - failed.length} 条，失败 ${failed.length} 条（可能被知乎限流，稍后可重试）`);
    alert(`有 ${failed.length} 条移除失败，可能是接口限流。请稍后重试。`);
  } else {
    setStatus(`已成功移除 ${targets.length} 条收藏`);
  }
  updateSelectionUI();
}

function openMoveModal() {
  if (!state.current || state.busy || state.selected.size === 0) return;
  const others = state.collections.filter((c) => c.id !== state.current.id);
  const ul = $('#moveList');
  ul.innerHTML = '';
  if (others.length === 0) {
    const li = document.createElement('li');
    li.className = 'move-empty';
    li.textContent = '暂无其他收藏夹可移动';
    ul.appendChild(li);
  }
  for (const c of others) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'moveTarget';
    radio.value = c.id;
    radio.addEventListener('change', () => { $('#moveConfirm').disabled = false; });
    const span = document.createElement('span');
    span.textContent = `${c.title || '(未命名)'}（${c.item_count ?? 0} 条）`;
    label.append(radio, span);
    li.appendChild(label);
    ul.appendChild(li);
  }
  $('#moveTip').textContent = `将选中的 ${state.selected.size} 条内容移动到：`;
  $('#moveConfirm').disabled = true;
  $('#moveModal').hidden = false;
}

function closeMoveModal() {
  $('#moveModal').hidden = true;
}

async function batchMove(target) {
  if (!state.current || state.busy) return;
  const targets = state.items.filter((it) => state.selected.has(it.uid));
  if (targets.length === 0) return;
  if (!confirm(`将 ${targets.length} 条内容从「${state.current.title}」移动到「${target.title}」？`)) return;
  state.busy = true;
  updateSelectionUI();
  const failed = [];
  const failStatuses = new Set();
  let addedOnly = 0;
  let done = 0;
  await runPool(targets, 2, async (it) => {
    const r = await moveOneItem(it, state.current.id, target.id);
    if (r.ok) {
      state.items = state.items.filter((x) => x.uid !== it.uid);
      state.selected.delete(it.uid);
      if (typeof state.current.item_count === 'number') state.current.item_count = Math.max(0, state.current.item_count - 1);
      if (typeof target.item_count === 'number') target.item_count++;
      if (r.addedOnly) addedOnly++;
    } else {
      failed.push(it);
      if (r.status) failStatuses.add(r.status);
    }
    done++;
    setStatus(`正在移动… ${done}/${targets.length}`);
    if (done % 4 === 0) renderItems();
  });
  renderItems();
  renderCollections($('#collectionFilter').value.trim());
  state.busy = false;
  const okCount = targets.length - failed.length - addedOnly;
  let msg = `移动完成：成功 ${okCount} 条`;
  if (addedOnly) msg += `，${addedOnly} 条已加入「${target.title}」但从当前夹移除失败（内容同时存在于两个收藏夹）`;
  if (failed.length) msg += `，失败 ${failed.length} 条`;
  setStatus(msg);
  if (failed.length) {
    const codes = failStatuses.size ? `（HTTP ${[...failStatuses].join('/')}）` : '';
    alert(`有 ${failed.length} 条移动失败${codes}，可能是接口限流或不支持的类型，请稍后重试。`);
  }
  updateSelectionUI();
}

async function moveOneItem(it, srcId, targetId) {
  if (it.type !== 'answer' && it.type !== 'article') return { ok: false, status: 0 };
  const path = `/collections/contents/${it.type}/${it.contentId}`;
  const bases = [`https://www.zhihu.com/api/v4${path}`, `https://api.zhihu.com${path}`];
  let lastStatus = 0;
  for (const base of bases) {
    const add = await api('PUT', base, `add_collections=${targetId}`, 'form');
    if (!add.ok) {
      lastStatus = add.status || 0;
      continue;
    }
    const rm = await api('PUT', base, `remove_collections=${srcId}`, 'form');
    if (rm.ok) return { ok: true };
    return { ok: true, addedOnly: true };
  }
  return { ok: false, status: lastStatus };
}

async function runPool(tasks, limit, worker) {
  const queue = [...tasks];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try { await worker(t); } catch { }
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  await Promise.all(runners);
}

function exportItems(fmt) {
  if (state.busy) return;
  const targets = state.selected.size ? state.items.filter((it) => state.selected.has(it.uid)) : state.items;
  if (!targets.length) { alert('没有可导出的内容'); return; }
  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;
  let content, mime, ext;
  if (fmt === 'json') {
    content = JSON.stringify(targets.map(({ type, title, author, url }) => ({ type, title, author, url })), null, 2);
    mime = 'application/json'; ext = 'json';
  } else if (fmt === 'markdown') {
    const lines = targets.map((it) => {
      const tn = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
      return `- [${it.title}](${it.url})（${tn} · ${it.author || '未知作者'}）`;
    });
    content = `# ${state.current ? state.current.title : '知乎收藏'}\n\n` + lines.join('\n') + '\n';
    mime = 'text/markdown'; ext = 'md';
  } else {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['类型', '标题', '作者', '链接'].map(esc).join(',')];
    for (const it of targets) {
      const tn = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
      rows.push([tn, it.title, it.author, it.url].map(esc).join(','));
    }
    content = '\uFEFF' + rows.join('\r\n');
    mime = 'text/csv'; ext = 'csv';
  }
  downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), `${name}.${ext}`);
  setStatus(`已导出 ${targets.length} 条（${ext.toUpperCase()}）`);
}

function exportTitleLinks() {
  if (state.busy) return;
  const targets = state.selected.size ? state.items.filter((it) => state.selected.has(it.uid)) : state.items;
  if (!targets.length) { alert('没有可导出的内容'); return; }
  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;
  const content = targets.map((it) => `${it.title}\n${it.url || '(无链接)'}`).join('\n\n') + '\n';
  downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
  setStatus(`已导出 ${targets.length} 条标题和链接（TXT）`);
}

async function exportContentsZip() {
  if (state.busy) return;
  const targets = state.selected.size ? state.items.filter((it) => state.selected.has(it.uid)) : state.items;
  if (!targets.length) { alert('没有可导出的内容'); return; }
  if (targets.length > 30 && !confirm(`将抓取 ${targets.length} 篇内容的正文，可能需要较长时间，继续？`)) return;
  state.busy = true;
  updateSelectionUI();
  const files = []; const failed = []; let done = 0;
  const usedNames = new Map(); const encoder = new TextEncoder();
  await runPool(targets, 2, async (it) => {
    let apiUrl = null;
    if (it.type === 'answer') apiUrl = `https://www.zhihu.com/api/v4/answers/${it.contentId}?include=content`;
    else if (it.type === 'article') apiUrl = `https://www.zhihu.com/api/v4/articles/${it.contentId}`;
    if (apiUrl) {
      const resp = await api('GET', apiUrl);
      if (resp.ok && resp.data) {
        const md = buildMarkdownFile(it, resp.data.content || '');
        const base = uniqueName(sanitizeFileName(it.title), usedNames);
        files.push({ name: `${base}.md`, data: encoder.encode(md) });
      } else failed.push(it);
    } else failed.push(it);
    done++;
    setStatus(`正在抓取正文… ${done}/${targets.length}`);
  });
  state.busy = false; updateSelectionUI();
  if (!files.length) { setStatus('正文抓取失败'); alert('正文抓取全部失败，请稍后重试。'); return; }
  const blob = makeZip(files);
  downloadBlob(blob, `知乎收藏正文_${files.length}篇.zip`);
  setStatus(`已导出 ${files.length} 篇正文（ZIP）${failed.length ? `，失败 ${failed.length} 条` : ''}`);
}

function buildMarkdownFile(it, html) {
  const tn = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
  const body = html ? htmlToMd(html) : '（正文为空）';
  return `# ${it.title}\n\n> 类型：${tn}　作者：${it.author || '未知'}\n> 原文：${it.url}\n\n${body}\n`;
}

function sanitizeFileName(name) {
  const clean = (name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80);
  return clean || '未命名';
}

function uniqueName(base, used) {
  const n = (used.get(base) || 0) + 1; used.set(base, n);
  return n === 1 ? base : `${base}_${n}`;
}

function htmlToMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
  const md = convBlockChildren(doc.body, 0);
  return md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function convBlockChildren(node, depth) {
  let out = '';
  for (const child of node.childNodes) out += convBlock(child, depth);
  return out;
}

function convBlock(node, depth) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const text = convInline(node);
      return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
    }
    case 'p': {
      const text = convInline(node);
      return text ? `\n\n${text}\n\n` : '\n';
    }
    case 'hr': return '\n\n---\n\n';
    case 'blockquote': {
      const inner = convBlockChildren(node, depth).trim();
      if (!inner) return '';
      return '\n\n' + inner.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
    }
    case 'pre': {
      const code = node.textContent.replace(/^\n+|\s+$/g, '');
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    }
    case 'ul': case 'ol': {
      let i = 0; let out = '\n';
      for (const li of node.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        i++;
        const marker = tag === 'ul' ? '-' : `${i}.`;
        const body = convBlockChildren(li, depth + 1).trim().replace(/\n{2,}/g, '\n  ');
        out += `${'  '.repeat(depth)}${marker} ${body}\n`;
      }
      return out;
    }
    case 'figure': {
      const img = node.querySelector('img');
      const src = img ? pickImgSrc(img) : '';
      return src ? `\n\n![${img.getAttribute('alt') || '图片'}](${src})\n\n` : '';
    }
    case 'img': {
      const src = pickImgSrc(node);
      return src ? `\n\n![图片](${src})\n\n` : '';
    }
    case 'table': {
      const t = tableToMd(node);
      return t ? `\n\n${t}\n\n` : '';
    }
    case 'br': return '\n';
    case 'b': case 'strong': case 'i': case 'em': case 'a': case 'code': case 'span': case 'sup': case 'sub':
      return convInlineNode(node);
    default: return convBlockChildren(node, depth);
  }
}

function convInline(node) {
  let out = '';
  for (const child of node.childNodes) out += convInlineNode(child);
  return out.replace(/\s+/g, ' ').trim();
}

function convInlineNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case 'b': case 'strong': {
      const t = convInline(node);
      return t ? `**${t}**` : '';
    }
    case 'i': case 'em': {
      const t = convInline(node);
      return t ? `*${t}*` : '';
    }
    case 'code':
      return '`' + node.textContent.replace(/`/g, "'") + '`';
    case 'a': {
      const text = convInline(node) || node.textContent.trim();
      const href = decodeZhihuLink(node.getAttribute('href') || '');
      if (!href || href.startsWith('javascript:')) return text;
      return `[${text}](${href})`;
    }
    case 'img': {
      const src = pickImgSrc(node);
      return src ? `![${node.getAttribute('alt') || '图片'}](${src})` : '';
    }
    case 'br': return '\n';
    case 'noscript': case 'script': case 'style': return '';
    default: {
      let out = '';
      for (const child of node.childNodes) out += convInlineNode(child);
      return out;
    }
  }
}

function tableToMd(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [];
    for (const cell of tr.children) {
      const t = cell.tagName.toLowerCase();
      if (t !== 'td' && t !== 'th') continue;
      cells.push(convInline(cell).replace(/\|/g, '\\|'));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const header = rows[0];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const r of rows.slice(1)) {
    while (r.length < header.length) r.push('');
    lines.push(`| ${r.join(' | ')} |`);
  }
  return lines.join('\n');
}

function pickImgSrc(img) {
  for (const attr of ['data-original', 'data-actualsrc', 'data-src', 'src']) {
    const v = img.getAttribute(attr);
    if (v && !v.startsWith('data:')) return v;
  }
  return '';
}

function decodeZhihuLink(href) {
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href, 'https://www.zhihu.com');
    if (u.hostname === 'link.zhihu.com' && u.searchParams.get('target')) {
      return decodeURIComponent(u.searchParams.get('target'));
    }
    return u.href;
  } catch { return href; }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);
  const u32 = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF]);
  const push = (u8) => { chunks.push(u8); offset += u8.length; };
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  const UTF8_FLAG = 0x0800;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const localOffset = offset;
    const header = [
      u32(0x04034B50), u16(20), u16(UTF8_FLAG), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameBytes.length), u16(0),
    ];
    for (const part of header) push(part);
    push(nameBytes);
    push(f.data);
    central.push({ nameBytes, crc, size: f.data.length, localOffset });
  }
  const centralStart = offset;
  for (const f of central) {
    const rec = [
      u32(0x02014B50), u16(20), u16(20), u16(UTF8_FLAG), u16(0), u16(dosTime), u16(dosDate),
      u32(f.crc), u32(f.size), u32(f.size), u16(f.nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(f.localOffset),
    ];
    for (const part of rec) push(part);
    push(f.nameBytes);
  }
  const centralSize = offset - centralStart;
  const eocd = [
    u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(centralStart), u16(0),
  ];
  for (const part of eocd) push(part);
  return new Blob(chunks, { type: 'application/zip' });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function setStatus(text) {
  $('#statusBar').textContent = text;
}

function openCreateCollectionModal() {
  if (state.busy) return;
  state.editingCollection = null;
  $('#collectionModalTitle').textContent = '新建收藏夹';
  $('#collectionNameInput').value = '';
  $('#collectionDescInput').value = '';
  $('#collectionPublicInput').checked = false;
  $('#collectionModal').hidden = false;
  setTimeout(() => $('#collectionNameInput').focus(), 50);
}

function openEditCollectionModal(collection) {
  if (state.busy) return;
  state.editingCollection = collection;
  $('#collectionModalTitle').textContent = '编辑收藏夹';
  $('#collectionNameInput').value = collection.title || '';
  $('#collectionDescInput').value = collection.description || '';
  $('#collectionPublicInput').checked = !!collection.is_public;
  $('#collectionModal').hidden = false;
  setTimeout(() => $('#collectionNameInput').focus(), 50);
}

function closeCollectionModal() {
  $('#collectionModal').hidden = true;
  state.editingCollection = null;
}

async function handleCreateCollection() {
  const title = $('#collectionNameInput').value.trim();
  const description = $('#collectionDescInput').value.trim();
  const isPublic = $('#collectionPublicInput').checked;
  if (!title) { alert('请输入收藏夹名称'); $('#collectionNameInput').focus(); return; }
  state.busy = true; setStatus('正在创建收藏夹…');
  const endpoints = [
    { url: 'https://www.zhihu.com/api/v4/collections', method: 'POST', body: { title, description, is_public: isPublic } },
    { url: 'https://www.zhihu.com/api/v4/people/' + state.me.url_token + '/collections', method: 'POST', body: { title, description, is_public: isPublic } },
  ];
  let resp = null; let lastError = '';
  for (const ep of endpoints) {
    resp = await api(ep.method, ep.url, ep.body);
    if (resp.ok) break;
    lastError = `HTTP ${resp.status || '网络错误'}`;
  }
  state.busy = false;
  if (!resp || !resp.ok) {
    setStatus(`创建收藏夹失败（${lastError}）`);
    alert(`创建收藏夹失败：${lastError}\n可能知乎 API 已变更，或网络异常。`);
    return;
  }
  closeCollectionModal();
  const newCollection = resp.data && resp.data.data ? resp.data.data : resp.data;
  if (newCollection && newCollection.id) {
    state.collections.unshift(newCollection);
    renderCollections($('#collectionFilter').value.trim());
    setStatus(`已成功创建收藏夹「${title}」`);
  } else {
    await loadCollections();
    setStatus(`已创建收藏夹「${title}」`);
  }
}

async function handleEditCollection() {
  const collection = state.editingCollection;
  if (!collection) return;
  const title = $('#collectionNameInput').value.trim();
  const description = $('#collectionDescInput').value.trim();
  const isPublic = $('#collectionPublicInput').checked;
  if (!title) { alert('请输入收藏夹名称'); $('#collectionNameInput').focus(); return; }
  state.busy = true; setStatus('正在更新收藏夹…');
  const endpoints = [
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'PUT', body: { title, description, is_public: isPublic } },
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'PATCH', body: { title, description, is_public: isPublic } },
  ];
  let resp = null; let lastError = '';
  for (const ep of endpoints) {
    resp = await api(ep.method, ep.url, ep.body);
    if (resp.ok) break;
    lastError = `HTTP ${resp.status || '网络错误'}`;
  }
  state.busy = false;
  if (!resp || !resp.ok) {
    setStatus(`更新收藏夹失败（${lastError}）`);
    alert(`更新收藏夹失败：${lastError}\n可能知乎 API 已变更，或网络异常。`);
    return;
  }
  collection.title = title; collection.description = description; collection.is_public = isPublic;
  closeCollectionModal();
  renderCollections($('#collectionFilter').value.trim());
  setStatus(`已成功更新收藏夹「${title}」`);
}

function openDeleteModal(collection) {
  if (state.busy) return;
  state.deletingCollection = collection;
  $('#deleteTip').textContent = `确定要删除收藏夹「${collection.title || '(未命名)'}」吗？（共 ${collection.item_count ?? 0} 条内容）`;
  $('#deleteModal').hidden = false;
}

function closeDeleteModal() {
  $('#deleteModal').hidden = true;
  state.deletingCollection = null;
}

async function handleDeleteCollection() {
  const collection = state.deletingCollection;
  if (!collection) return;
  state.busy = true; setStatus('正在删除收藏夹…');
  const endpoints = [
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'DELETE' },
  ];
  let resp = null; let lastError = '';
  for (const ep of endpoints) {
    resp = await api(ep.method, ep.url);
    if (resp.ok) break;
    lastError = `HTTP ${resp.status || '网络错误'}`;
  }
  state.busy = false;
  if (!resp || !resp.ok) {
    setStatus(`删除收藏夹失败（${lastError}）`);
    alert(`删除收藏夹失败：${lastError}\n可能知乎 API 已变更，或网络异常。`);
    return;
  }
  if (state.current && state.current.id === collection.id) {
    state.current = null; state.items = []; state.selected.clear();
    $('#itemsBody').innerHTML = ''; $('#emptyTip').hidden = false;
    setStatus(`收藏夹「${collection.title || '(未命名)'}」已删除，请选择其他收藏夹`);
  }
  state.collections = state.collections.filter((c) => c.id !== collection.id);
  closeDeleteModal();
  renderCollections($('#collectionFilter').value.trim());
  updateSelectionUI();
}

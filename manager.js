/* 知乎收藏夹批量管理 - 管理器页面逻辑 */

const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  scope: 'mine',                 // 'mine' | 'favlists_follow' | 'questions_follow' | 'columns_follow' | 'videos_follow'
  collections: [],
  followCollections: [],        // 关注的收藏夹
  followQuestions: [],           // 关注的问题
  followColumns: [],             // 关注的专栏
  followVideos: [],              // 关注的视频
  current: null,                 // 当前选中的侧栏对象（收藏夹 / 关注项）
  items: [],                     // 右侧表格的 items
  selected: new Set(),           // 右侧表格的选中 uid
  listSelected: new Set(),       // 左侧侧栏列表的选中 uid（批量取关用）
  filter: '',
  busy: false,
  editingCollection: null,
  deletingCollection: null,
};

/* ---------- API 代理 ---------- */

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

/* ---------- 初始化 ---------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  await checkLogin();
}

async function checkLogin() {
  const resp = await api('GET', 'https://www.zhihu.com/api/v4/me');
  if (resp.ok && resp.data && resp.data.url_token) {
    state.me = resp.data;
    state.scope = 'mine';
    $('#userInfo').textContent = `已登录：${resp.data.name || resp.data.url_token}`;
    $('#loginView').hidden = true;
    $('#mainView').hidden = false;
    await switchScope('mine', true);
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
    await switchScope(state.scope, true);
  });
  // 域切换 Tab
  document.querySelectorAll('.scope-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.busy) return;
      switchScope(btn.dataset.scope);
    });
  });
  $('#listFilter').addEventListener('input', (e) => renderSidebar(e.target.value.trim()));
  $('#createCollectionBtn').addEventListener('click', openCreateCollectionModal);
  $('#reloadItemsBtn').addEventListener('click', () => state.current && !state.busy && loadCurrentContent());
  $('#selectAll').addEventListener('change', onSelectAll);
  $('#invertBtn').addEventListener('click', onInvert);
  $('#itemFilter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    renderItems();
  });
  $('#removeBtn').addEventListener('click', batchRemove);
  $('#unfollowBtn').addEventListener('click', batchUnfollow);
  $('#moveBtn').addEventListener('click', openMoveModal);
  $('#exportLinksBtn').addEventListener('click', exportTitleLinks);
  $('#exportContentBtn').addEventListener('click', exportContentsZip);
  document.querySelectorAll('.export-btn').forEach((btn) => {
    btn.addEventListener('click', () => exportItems(btn.dataset.fmt));
  });
  // 移动弹窗
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
  // 收藏夹创建/编辑弹窗
  $('#collectionModalCancel').addEventListener('click', closeCollectionModal);
  $('#collectionModal').addEventListener('click', (e) => {
    if (e.target.id === 'collectionModal') closeCollectionModal();
  });
  $('#collectionModalConfirm').addEventListener('click', () => {
    if (state.editingCollection) handleEditCollection();
    else handleCreateCollection();
  });
  // 删除收藏夹弹窗
  $('#deleteCancel').addEventListener('click', closeDeleteModal);
  $('#deleteModal').addEventListener('click', (e) => {
    if (e.target.id === 'deleteModal') closeDeleteModal();
  });
  $('#deleteConfirm').addEventListener('click', () => handleDeleteCollection());
}

/* ---------- 域切换 ---------- */

// 分页加载通用工具，返回完整数组
async function fetchPaginatedList(endpoint) {
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `https://www.zhihu.com/api/v4${endpoint}?offset=${offset}&limit=20`;
    const resp = await api('GET', url);
    if (!resp.ok || !resp.data || !Array.isArray(resp.data.data)) {
      return { ok: false, status: resp.status || 0, data: all };
    }
    all.push(...resp.data.data);
    if ((resp.data.paging && resp.data.paging.is_end) || resp.data.data.length === 0) break;
    offset += resp.data.data.length;
  }
  return { ok: true, data: all };
}

// 按 scope 加载左侧列表数据
async function loadSidebarByScope(scope) {
  const meUrl = state.me.url_token;
  if (scope === 'mine') {
    setStatus('正在加载收藏夹…');
    const r = await fetchPaginatedList(`/people/${meUrl}/collections`);
    if (!r.ok) { setStatus(`收藏夹加载失败（HTTP ${r.status}）`); return false; }
    state.collections = r.data;
    setStatus(`共 ${r.data.length} 个收藏夹`);
    return true;
  }
  if (scope === 'favlists_follow') {
    setStatus('正在加载关注的收藏夹…');
    const r = await fetchPaginatedList(`/members/${meUrl}/following-favlists`);
    if (!r.ok) { setStatus(`关注收藏夹加载失败（HTTP ${r.status}）`); return false; }
    state.followCollections = r.data;
    setStatus(`共关注 ${r.data.length} 个收藏夹`);
    return true;
  }
  if (scope === 'questions_follow') {
    setStatus('正在加载关注的问题…');
    const r = await fetchPaginatedList(`/members/${meUrl}/following-questions`);
    if (!r.ok) { setStatus(`关注问题加载失败（HTTP ${r.status}）`); return false; }
    state.followQuestions = r.data;
    setStatus(`共关注 ${r.data.length} 个问题`);
    return true;
  }
  if (scope === 'columns_follow') {
    setStatus('正在加载关注的专栏…');
    const r = await fetchPaginatedList(`/members/${meUrl}/following-columns`);
    if (!r.ok) { setStatus(`关注专栏加载失败（HTTP ${r.status}）`); return false; }
    state.followColumns = r.data;
    setStatus(`共关注 ${r.data.length} 个专栏`);
    return true;
  }
  if (scope === 'videos_follow') {
    setStatus('正在加载关注的视频…');
    const r = await fetchPaginatedList(`/members/${meUrl}/following-videos`);
    if (!r.ok) { setStatus(`关注视频加载失败（HTTP ${r.status}），可能当前知乎 API 不支持该端点`); return false; }
    state.followVideos = r.data;
    setStatus(`共关注 ${r.data.length} 个视频`);
    return true;
  }
  return false;
}

// 切域：更新 Tab、加载侧栏、重置右侧
async function switchScope(scope, force = false) {
  if (!force && scope === state.scope) return;
  state.scope = scope;
  state.current = null;
  state.items = [];
  state.selected.clear();
  state.listSelected.clear();

  // 更新 Tab 高亮
  document.querySelectorAll('.scope-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scope === scope);
  });

  // 控制"新建收藏夹"按钮只在 mine 域可见
  $('#createCollectionBtn').style.display = scope === 'mine' ? '' : 'none';

  // 加载侧栏
  await loadSidebarByScope(scope);
  renderSidebar($('#listFilter').value.trim());

  // 切换右侧工具栏显示
  updateToolbarByScope();

  // 清空右侧表格
  $('#itemsBody').innerHTML = '';
  $('#emptyTip').hidden = false;
  $('#emptyTip').textContent = scope === 'mine'
    ? '请点击左侧的收藏夹查看内容'
    : '请点击左侧的关注对象查看详情';
  $('#itemFilter').value = '';
  state.filter = '';
}

// 根据 scope 显示/隐藏工具栏按钮
function updateToolbarByScope() {
  const isFollow = state.scope !== 'mine';
  // 取消收藏 / 移动 只在 mine 域显示且已选中收藏夹时启用
  $('#removeBtn').style.display = isFollow ? 'none' : '';
  $('#moveBtn').style.display = isFollow ? 'none' : '';
  // 批量取关 只在 follow 域显示
  $('#unfollowBtn').style.display = isFollow ? '' : 'none';
  // 顶部工具栏里"全选 / 反选"只在 mine 域有意义（follow 域多选在左侧列表项里做）
  // 保留显示，follow 域下点击右侧表格全选也不影响（空表格）
  updateSelectionUI();
}

/* ---------- 侧栏列表渲染 ---------- */

// 根据 scope 返回侧栏原始数据
function getSidebarRawList() {
  if (state.scope === 'mine') return state.collections;
  if (state.scope === 'favlists_follow') return state.followCollections;
  if (state.scope === 'questions_follow') return state.followQuestions;
  if (state.scope === 'columns_follow') return state.followColumns;
  if (state.scope === 'videos_follow') return state.followVideos;
  return [];
}

// 统一渲染侧栏（根据 scope 走不同列表 + 不同 item 样式）
function renderSidebar(filter = '') {
  const ul = $('#collectionList');
  ul.innerHTML = '';
  const kw = filter.toLowerCase();
  const rawList = getSidebarRawList();
  const isMine = state.scope === 'mine';

  for (const raw of rawList) {
    const li = document.createElement('li');

    // follow 域：列表项带 checkbox（支持侧栏多选批量取关）
    if (!isMine) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'list-cb';
      cb.checked = state.listSelected.has(rawSidebarUid(raw));
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const uid = rawSidebarUid(raw);
        if (cb.checked) state.listSelected.add(uid);
        else state.listSelected.delete(uid);
        updateUnfollowBtnUI();
      });
      li.appendChild(cb);
    }

    // 标题 + 数量徽标
    const main = document.createElement('div');
    main.style.display = 'flex';
    main.style.alignItems = 'center';
    main.style.gap = '8px';
    main.style.flex = '1';
    main.style.minWidth = '0';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'c-title';
    titleSpan.textContent = sidebarItemTitle(raw);

    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = sidebarItemCount(raw);

    main.append(titleSpan, countSpan);

    // mine 域：hover 显示编辑/删除按钮
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    if (isMine) {
      const editBtn = document.createElement('button');
      editBtn.className = 'item-action-btn';
      editBtn.textContent = '编辑';
      editBtn.title = '编辑收藏夹';
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditCollectionModal(raw); });
      const delBtn = document.createElement('button');
      delBtn.className = 'item-action-btn delete';
      delBtn.textContent = '删除';
      delBtn.title = '删除收藏夹';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteModal(raw); });
      actions.append(editBtn, delBtn);
    }

    if (state.current && sidebarsMatch(state.current, raw)) li.classList.add('active');
    if (!kw || (sidebarItemTitle(raw) || '').toLowerCase().includes(kw)) {
      li.append(main, actions);
      li.title = sidebarItemTitle(raw) || '';
      li.addEventListener('click', () => selectSidebarItem(raw));
      ul.appendChild(li);
    }
  }
  updateUnfollowBtnUI();
}

function rawSidebarUid(raw) {
  if (state.scope === 'mine' || state.scope === 'favlists_follow') return `fav_${raw.id}`;
  if (state.scope === 'questions_follow') return `q_${raw.id}`;
  if (state.scope === 'columns_follow') return `col_${raw.id || raw.url_token}`;
  if (state.scope === 'videos_follow') return `v_${raw.id}`;
  return String(raw.id);
}

function sidebarItemTitle(raw) {
  if (state.scope === 'mine' || state.scope === 'favlists_follow') return raw.title || '(未命名收藏夹)';
  if (state.scope === 'questions_follow') return raw.title || '(未命名问题)';
  if (state.scope === 'columns_follow') return raw.title || '(未命名专栏)';
  if (state.scope === 'videos_follow') return raw.title || '(未命名视频)';
  return '';
}

function sidebarItemCount(raw) {
  if (state.scope === 'mine') return raw.item_count ?? '';
  if (state.scope === 'favlists_follow') return raw.item_count ?? '';
  if (state.scope === 'questions_follow') {
    if (typeof raw.follower_count === 'number') return `${raw.follower_count}关注`;
    if (typeof raw.answer_count === 'number') return `${raw.answer_count}回答`;
    return '';
  }
  if (state.scope === 'columns_follow') {
    if (typeof raw.articles_count === 'number') return `${raw.articles_count}篇`;
    return '';
  }
  if (state.scope === 'videos_follow') {
    if (typeof raw.play_count === 'number') return `${raw.play_count}播放`;
    if (typeof raw.duration === 'number') return `${Math.round(raw.duration / 1000)}s`;
    return '';
  }
  return '';
}

function sidebarsMatch(a, b) {
  if (!a || !b) return false;
  return String(a.id) === String(b.id) && (a.url_token == null || a.url_token === b.url_token);
}

// 侧栏 item 被点击
async function selectSidebarItem(raw) {
  if (state.busy) return;
  state.current = raw;
  renderSidebar($('#listFilter').value.trim());

  if (state.scope === 'mine') {
    await loadCurrentContent();
  } else {
    renderFollowDetail(raw);
  }
}

/* ---------- mine 域：加载收藏内容 ---------- */

async function loadCurrentContent() {
  if (!state.current) return;
  state.items = [];
  state.selected.clear();
  renderItems();
  const all = [];
  let offset = 0;
  for (;;) {
    const url = `https://www.zhihu.com/api/v4/collections/${state.current.id}/items?offset=${offset}&limit=20`;
    const resp = await api('GET', url);
    if (!resp.ok || !resp.data || !Array.isArray(resp.data.data)) {
      setStatus(`「${state.current.title}」加载失败（HTTP ${resp.status || '网络错误'}）`);
      break;
    }
    all.push(...resp.data.data);
    setStatus(`正在加载「${state.current.title}」… ${all.length}/${state.current.item_count || '?'}`);
    if ((resp.data.paging && resp.data.paging.is_end) || resp.data.data.length === 0) break;
    offset += resp.data.data.length;
  }
  state.items = all.map((item, idx) => normalizeMineItem(item, idx));
  setStatus(`「${state.current.title}」已加载 ${state.items.length} 条收藏`);
  renderItems();
}

function normalizeMineItem(item, idx) {
  const c = item.content || {};
  const type = c.type || 'unknown';
  let title = '';
  let url = '';
  if (type === 'answer') {
    title = (c.question && c.question.title) || '(无标题回答)';
    url = c.url
      ? (c.url.startsWith('http') ? c.url : 'https://www.zhihu.com' + c.url)
      : `https://www.zhihu.com/question/${c.question && c.question.id}/answer/${c.id}`;
  } else if (type === 'article') {
    title = c.title || '(无标题文章)';
    url = c.url || `https://zhuanlan.zhihu.com/p/${c.id}`;
  } else if (type === 'pin') {
    // 想法：没有标题，用正文前 40 字作为展示
    title = c.content || '(无标题想法)';
    // 去掉 HTML 标签
    title = title.replace(/<[^>]*>/g, '').trim();
    if (title.length > 40) title = title.slice(0, 40) + '…';
    url = c.url || `https://www.zhihu.com/pin/${c.id}`;
  } else if (type === 'video' || type === 'zvideo') {
    title = c.title || '(无标题视频)';
    url = c.url || '';
    if (!url && c.id) url = `https://www.zhihu.com/video/${c.id}`;
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

/* ---------- follow 域：右侧详情卡 ---------- */

function renderFollowDetail(raw) {
  // 清空右侧表格，换成详情视图
  const tbody = $('#itemsBody');
  tbody.innerHTML = '';
  $('#emptyTip').hidden = true;

  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.style.padding = '16px';

  const typeLabel = state.scope === 'favlists_follow' ? '收藏夹'
    : state.scope === 'questions_follow' ? '问题'
    : state.scope === 'columns_follow' ? '专栏'
    : state.scope === 'videos_follow' ? '视频' : '内容';

  // 标题
  const h2 = document.createElement('h3');
  h2.style.cssText = 'margin:0 0 12px 0;font-size:15px;font-weight:600;color:#1a1a1a;';
  const link = document.createElement('a');
  link.href = followDetailUrl(raw);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.color = '#056de8';
  link.textContent = followDetailTitle(raw);
  h2.appendChild(link);

  // 元信息
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:13px;color:#646464;margin-bottom:12px;line-height:1.8;';
  const metaParts = [`类型：${typeLabel}`];
  if (state.scope === 'favlists_follow' && raw.creator) metaParts.push(`创建者：${raw.creator.name || '(匿名)'}`);
  if (state.scope === 'questions_follow' && raw.author) metaParts.push(`提问者：${raw.author.name || '(匿名)'}`);
  if (state.scope === 'columns_follow' && raw.author) metaParts.push(`作者：${raw.author.name || '(匿名)'}`);
  if (typeof raw.item_count === 'number') metaParts.push(`内容数：${raw.item_count}`);
  if (typeof raw.follower_count === 'number') metaParts.push(`关注数：${raw.follower_count}`);
  if (typeof raw.answer_count === 'number') metaParts.push(`回答数：${raw.answer_count}`);
  if (typeof raw.articles_count === 'number') metaParts.push(`文章数：${raw.articles_count}`);
  if (raw.description) { metaParts.push(`描述：${raw.description}`); }
  meta.textContent = metaParts.join('　|　');

  // 操作按钮
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;';
  const unfollowBtn = document.createElement('button');
  unfollowBtn.className = 'btn btn-danger';
  unfollowBtn.textContent = '取消关注';
  unfollowBtn.addEventListener('click', async () => {
    if (!confirm(`确定取消关注这个${typeLabel}吗？`)) return;
    state.busy = true;
    const r = await unfollowOne(raw, state.scope);
    state.busy = false;
    if (r.ok) {
      setStatus(`已取消关注「${followDetailTitle(raw)}」`);
      // 从侧栏移除
      removeFromSidebar(raw);
      state.current = null;
      renderSidebar($('#listFilter').value.trim());
      $('#itemsBody').innerHTML = '';
      $('#emptyTip').hidden = false;
      $('#emptyTip').textContent = `已取消关注${typeLabel}，请选择其他关注对象`;
    } else {
      alert(`取消关注失败（HTTP ${r.status || '网络错误'}），请稍后重试`);
    }
  });
  const openBtn = document.createElement('button');
  openBtn.className = 'btn btn-ghost';
  openBtn.textContent = '在新标签页打开';
  openBtn.addEventListener('click', () => window.open(followDetailUrl(raw), '_blank'));
  actions.append(unfollowBtn, openBtn);

  td.append(h2, meta, actions);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function followDetailTitle(raw) {
  if (state.scope === 'favlists_follow') return raw.title || '(未命名收藏夹)';
  if (state.scope === 'questions_follow') return raw.title || '(未命名问题)';
  if (state.scope === 'columns_follow') return raw.title || '(未命名专栏)';
  if (state.scope === 'videos_follow') return raw.title || '(未命名视频)';
  return '';
}

function followDetailUrl(raw) {
  if (state.scope === 'favlists_follow') return `https://www.zhihu.com/collection/${raw.id}`;
  if (state.scope === 'questions_follow') return `https://www.zhihu.com/question/${raw.id}`;
  if (state.scope === 'columns_follow') {
    if (raw.url_token) return `https://zhuanlan.zhihu.com/${raw.url_token}`;
    return `https://zhuanlan.zhihu.com/p/${raw.id}`;
  }
  if (state.scope === 'videos_follow') return `https://www.zhihu.com/video/${raw.id}`;
  return '';
}

function removeFromSidebar(raw) {
  if (state.scope === 'favlists_follow') state.followCollections = state.followCollections.filter((x) => x.id !== raw.id);
  if (state.scope === 'questions_follow') state.followQuestions = state.followQuestions.filter((x) => x.id !== raw.id);
  if (state.scope === 'columns_follow') state.followColumns = state.followColumns.filter((x) => String(x.id || x.url_token) !== String(raw.id || raw.url_token));
  if (state.scope === 'videos_follow') state.followVideos = state.followVideos.filter((x) => x.id !== raw.id);
}

/* ---------- 批量取消关注 ---------- */

// 取关单个对象，根据 scope 拼不同端点
// 问题：DELETE /api/v4/questions/{id}/followers
// 专栏：DELETE /api/v4/columns/{id}/followers
// 收藏夹：DELETE /api/v4/collections/{id}/followers
async function unfollowOne(raw, scope) {
  let endpoint = null;
  if (scope === 'questions_follow') {
    endpoint = `/questions/${raw.id}/followers`;
  } else if (scope === 'columns_follow') {
    const id = raw.id || raw.url_token;
    endpoint = `/columns/${id}/followers`;
  } else if (scope === 'favlists_follow') {
    endpoint = `/collections/${raw.id}/followers`;
  } else if (scope === 'videos_follow') {
    // 视频取关端点推测，知乎 v4 未公开，请求失败会降级尝试下一个 host
    endpoint = `/videos/${raw.id}/followers`;
  }
  if (!endpoint) return { ok: false, status: 0 };

  const bases = [
    `https://www.zhihu.com/api/v4${endpoint}`,
    `https://api.zhihu.com${endpoint}`,
  ];
  let lastStatus = 0;
  for (const base of bases) {
    const resp = await api('DELETE', base);
    if (resp.ok) return { ok: true };
    lastStatus = resp.status || 0;
    console.warn('[unfollow] failed', base, resp.status, resp.data);
  }
  return { ok: false, status: lastStatus };
}

// 侧栏多选批量取关
async function batchUnfollow() {
  if (state.busy) return;
  if (state.listSelected.size === 0) return;
  const rawList = getSidebarRawList();
  const targets = rawList.filter((r) => state.listSelected.has(rawSidebarUid(r)));
  if (targets.length === 0) return;
  if (!confirm(`确定批量取消关注这 ${targets.length} 项吗？`)) return;

  state.busy = true;
  const failed = [];
  const failStatuses = new Set();
  let done = 0;

  await runPool(targets, 3, async (raw) => {
    const r = await unfollowOne(raw, state.scope);
    if (r.ok) {
      state.listSelected.delete(rawSidebarUid(raw));
    } else {
      failed.push(raw);
      if (r.status) failStatuses.add(r.status);
    }
    done++;
    setStatus(`正在取关… ${done}/${targets.length}`);
  });

  // 从侧栏数据源移除成功项
  const okSet = new Set(targets.filter((t) => !failed.includes(t)).map((t) => rawSidebarUid(t)));
  if (state.scope === 'favlists_follow') state.followCollections = state.followCollections.filter((r) => !okSet.has(rawSidebarUid(r)));
  if (state.scope === 'questions_follow') state.followQuestions = state.followQuestions.filter((r) => !okSet.has(rawSidebarUid(r)));
  if (state.scope === 'columns_follow') state.followColumns = state.followColumns.filter((r) => !okSet.has(rawSidebarUid(r)));
  if (state.scope === 'videos_follow') state.followVideos = state.followVideos.filter((r) => !okSet.has(rawSidebarUid(r)));

  // 如果当前选中的对象被移除了
  if (state.current && !failed.includes(state.current) && okSet.has(rawSidebarUid(state.current))) {
    state.current = null;
  }

  state.busy = false;
  renderSidebar($('#listFilter').value.trim());
  if (failed.length) {
    const codes = failStatuses.size ? `（HTTP ${[...failStatuses].join('/')}）` : '';
    setStatus(`取关完成：成功 ${targets.length - failed.length} 项，失败 ${failed.length} 项${codes}`);
    alert(`有 ${failed.length} 项取关失败${codes}，可能是接口限流，请稍后重试。`);
  } else {
    setStatus(`已成功取关 ${targets.length} 项`);
  }
  updateUnfollowBtnUI();
}

function updateUnfollowBtnUI() {
  const btn = $('#unfollowBtn');
  if (!btn) return;
  btn.disabled = state.listSelected.size === 0 || state.busy;
  btn.textContent = state.listSelected.size > 0 ? `批量取关 (${state.listSelected.size})` : '批量取关选中项';
}

/* ---------- 收藏内容 ---------- */

function filteredItems() {
  if (!state.filter) return state.items;
  return state.items.filter(
    (it) => it.title.toLowerCase().includes(state.filter) || it.author.toLowerCase().includes(state.filter)
  );
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
    const typeMap = {
      answer: { n: '回答', c: 'answer' },
      article: { n: '文章', c: 'article' },
      pin: { n: '想法', c: 'pin' },
      video: { n: '视频', c: 'video' },
      zvideo: { n: '视频', c: 'video' },
    };
    const t = typeMap[it.type] || { n: '其他', c: 'other' };
    badge.className = `badge badge-${t.c}`;
    badge.textContent = t.n;
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

/* ---------- 选择 ---------- */

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
  // follow 域下 removeBtn/moveBtn 被隐藏但这里也要保证 disabled
  const inMine = state.scope === 'mine';
  $('#removeBtn').disabled = !inMine || state.selected.size === 0 || state.busy;
  $('#moveBtn').disabled = !inMine || state.selected.size === 0 || state.busy;
  const list = filteredItems();
  const allChecked = list.length > 0 && list.every((it) => state.selected.has(it.uid));
  $('#selectAll').checked = allChecked;
}

/* ---------- 批量取消收藏 ---------- */

async function batchRemove() {
  if (!state.current || state.busy) return;
  const targets = state.items.filter((it) => state.selected.has(it.uid));
  if (targets.length === 0) return;
  if (!confirm(`确定从「${state.current.title}」中移除 ${targets.length} 条收藏吗？\n（仅从收藏夹移除，不影响原内容）`)) return;

  state.busy = true;
  updateSelectionUI();
  const failed = [];
  const failStatuses = new Set();
  let done = 0;

  await runPool(targets, 3, async (it) => {
    const r = await removeOneItem(it, state.current.id);
    if (r.ok) {
      state.selected.delete(it.uid);
      state.items = state.items.filter((x) => x.uid !== it.uid);
    } else {
      failed.push(it);
      if (r.status) failStatuses.add(r.status);
    }
    done++;
    setStatus(`正在移除… ${done}/${targets.length}`);
    if (done % 5 === 0) renderItems();
  });

  renderItems();
  state.busy = false;
  if (state.current && typeof state.current.item_count === 'number') {
    state.current.item_count = Math.max(0, state.current.item_count - (targets.length - failed.length));
    renderSidebar($('#listFilter').value.trim());
  }
  if (failed.length) {
    const codes = failStatuses.size ? `（HTTP ${[...failStatuses].join('/')}）` : '';
    setStatus(`完成：成功 ${targets.length - failed.length} 条，失败 ${failed.length} 条${codes}`);
    alert(`有 ${failed.length} 条移除失败${codes}，可能是接口限流或不支持的类型。请稍后重试。`);
  } else {
    setStatus(`已成功移除 ${targets.length} 条收藏`);
  }
  updateSelectionUI();
}

// 从收藏夹移除单条内容
// 接口：PUT /collections/contents/{type}/{contentId} + form remove_collections=收藏夹ID
// type 支持 answer / article / pin / video (含 zvideo)
async function removeOneItem(it, collectionId) {
  const supported = ['answer', 'article', 'pin', 'video', 'zvideo'];
  if (!supported.includes(it.type)) return { ok: false, status: 0 };
  const apiType = it.type === 'zvideo' ? 'video' : it.type;

  const path = `/collections/contents/${apiType}/${it.contentId}`;
  const bases = [`https://www.zhihu.com/api/v4${path}`, `https://api.zhihu.com${path}`];

  let lastStatus = 0;
  for (const base of bases) {
    const resp = await api('PUT', base, `remove_collections=${collectionId}`, 'form');
    if (resp.ok) return { ok: true };
    lastStatus = resp.status || 0;
    console.warn('[remove] failed', base, resp.status, resp.data);
  }
  return { ok: false, status: lastStatus };
}

/* ---------- 移动到其他收藏夹 ---------- */

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
      if (typeof state.current.item_count === 'number') {
        state.current.item_count = Math.max(0, state.current.item_count - 1);
      }
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
  renderSidebar($('#listFilter').value.trim());
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

// 移动单条内容到目标收藏夹
// 接口：PUT /collections/contents/{type}/{contentId}，type 支持 answer / article / pin / video
// 表单体 add_collections=收藏夹ID 加入；remove_collections=收藏夹ID 移出
async function moveOneItem(it, srcId, targetId) {
  const supported = ['answer', 'article', 'pin', 'video', 'zvideo'];
  if (!supported.includes(it.type)) return { ok: false, status: 0 };
  const apiType = it.type === 'zvideo' ? 'video' : it.type;

  const path = `/collections/contents/${apiType}/${it.contentId}`;
  const bases = [`https://www.zhihu.com/api/v4${path}`, `https://api.zhihu.com${path}`];

  let lastStatus = 0;
  for (const base of bases) {
    // 先加入目标收藏夹
    const add = await api('PUT', base, `add_collections=${targetId}`, 'form');
    if (!add.ok) {
      lastStatus = add.status || 0;
      console.warn('[move] add failed', base, add.status, add.data);
      continue; // 换备用 host 重试
    }
    // 成功加入后再移出当前收藏夹
    const rm = await api('PUT', base, `remove_collections=${srcId}`, 'form');
    if (rm.ok) return { ok: true };
    console.warn('[move] added but not removed', rm.status, rm.data);
    return { ok: true, addedOnly: true };
  }
  return { ok: false, status: lastStatus };
}

// 简单并发池：限制并发数，避免触发限流
async function runPool(tasks, limit, worker) {
  const queue = [...tasks];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        await worker(t);
      } catch { /* 单条失败不中断整体 */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  });
  await Promise.all(runners);
}

/* ---------- 导出列表 ---------- */

function exportItems(fmt) {
  if (state.busy) return;
  const targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }
  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;

  let content, mime, ext;
  if (fmt === 'json') {
    content = JSON.stringify(
      targets.map(({ type, title, author, url }) => ({ type, title, author, url })),
      null,
      2
    );
    mime = 'application/json';
    ext = 'json';
  } else if (fmt === 'markdown') {
    const lines = targets.map((it) => {
      const typeName = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
      return `- [${it.title}](${it.url})（${typeName} · ${it.author || '未知作者'}）`;
    });
    content = `# ${state.current ? state.current.title : '知乎收藏'}\n\n` + lines.join('\n') + '\n';
    mime = 'text/markdown';
    ext = 'md';
  } else {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['类型', '标题', '作者', '链接'].map(esc).join(',')];
    for (const it of targets) {
      const typeName = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
      rows.push([typeName, it.title, it.author, it.url].map(esc).join(','));
    }
    content = '﻿' + rows.join('\r\n');
    mime = 'text/csv';
    ext = 'csv';
  }

  downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), `${name}.${ext}`);
  setStatus(`已导出 ${targets.length} 条（${ext.toUpperCase()}）`);
}

/* ---------- 仅导出标题和链接 (TXT) ---------- */

function exportTitleLinks() {
  if (state.busy) return;
  const targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }
  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;
  const content = targets
    .map((it) => `${it.title}\n${it.url || '(无链接)'}`)
    .join('\n\n') + '\n';
  downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
  setStatus(`已导出 ${targets.length} 条标题和链接（TXT）`);
}

/* ---------- 导出正文为 Markdown (ZIP) ---------- */

async function exportContentsZip() {
  if (state.busy) return;
  const targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }
  if (targets.length > 30 && !confirm(`将抓取 ${targets.length} 篇内容的正文，可能需要较长时间，继续？`)) return;

  state.busy = true;
  updateSelectionUI();
  const files = [];
  const failed = [];
  let done = 0;
  const usedNames = new Map();
  const encoder = new TextEncoder();

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
      } else {
        failed.push(it);
      }
    } else {
      failed.push(it); // 不支持的类型
    }
    done++;
    setStatus(`正在抓取正文… ${done}/${targets.length}`);
  });

  state.busy = false;
  updateSelectionUI();

  if (!files.length) {
    setStatus('正文抓取失败');
    alert('正文抓取全部失败，可能是接口限流，请稍后重试。');
    return;
  }
  const blob = makeZip(files);
  downloadBlob(blob, `知乎收藏正文_${files.length}篇.zip`);
  setStatus(`已导出 ${files.length} 篇正文（ZIP）${failed.length ? `，失败 ${failed.length} 条` : ''}`);
}

function buildMarkdownFile(it, html) {
  const typeName = it.type === 'answer' ? '回答' : it.type === 'article' ? '文章' : '其他';
  const body = html ? htmlToMd(html) : '（正文为空）';
  return `# ${it.title}\n\n> 类型：${typeName}　作者：${it.author || '未知'}\n> 原文：${it.url}\n\n${body}\n`;
}

function sanitizeFileName(name) {
  const clean = (name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim().slice(0, 80);
  return clean || '未命名';
}

function uniqueName(base, used) {
  const n = (used.get(base) || 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}_${n}`;
}

/* ---------- HTML → Markdown ---------- */

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
      let i = 0;
      let out = '\n';
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
    default:
      return convBlockChildren(node, depth);
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
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const r of rows.slice(1)) {
    while (r.length < header.length) r.push('');
    lines.push(`| ${r.join(' | ')} |`);
  }
  return lines.join('\n');
}

// 知乎图片真实地址优先取 data-* 属性（页面中 src 常为占位图）
function pickImgSrc(img) {
  for (const attr of ['data-original', 'data-actualsrc', 'data-src', 'src']) {
    const v = img.getAttribute(attr);
    if (v && !v.startsWith('data:')) return v;
  }
  return '';
}

// 解开知乎外链跳转包装 link.zhihu.com/?target=...
function decodeZhihuLink(href) {
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href, 'https://www.zhihu.com');
    if (u.hostname === 'link.zhihu.com' && u.searchParams.get('target')) {
      return decodeURIComponent(u.searchParams.get('target'));
    }
    return u.href;
  } catch {
    return href;
  }
}

/* ---------- 零依赖 ZIP（store 模式，无压缩） ---------- */

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

/* ---------- 工具 ---------- */

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

/* ---------- 创建收藏夹 ---------- */

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

  if (!title) {
    alert('请输入收藏夹名称');
    $('#collectionNameInput').focus();
    return;
  }

  state.busy = true;
  setStatus('正在创建收藏夹…');

  // 尝试多个可能的 API 端点
  const endpoints = [
    { url: 'https://www.zhihu.com/api/v4/collections', method: 'POST', body: { title, description, is_public: isPublic } },
    { url: 'https://www.zhihu.com/api/v4/people/' + state.me.url_token + '/collections', method: 'POST', body: { title, description, is_public: isPublic } },
  ];

  let resp = null;
  let lastError = '';
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

  // 关闭弹窗并刷新列表
  closeCollectionModal();
  const newCollection = resp.data && resp.data.data ? resp.data.data : resp.data;
  if (newCollection && newCollection.id) {
    state.collections.unshift(newCollection);
    renderSidebar($('#listFilter').value.trim());
    setStatus(`已成功创建收藏夹「${title}」`);
  } else {
    // API 返回异常，刷新列表
    await loadSidebarByScope('mine');
    renderSidebar($('#listFilter').value.trim());
    setStatus(`已创建收藏夹「${title}」`);
  }
}

async function handleEditCollection() {
  const collection = state.editingCollection;
  if (!collection) return;

  const title = $('#collectionNameInput').value.trim();
  const description = $('#collectionDescInput').value.trim();
  const isPublic = $('#collectionPublicInput').checked;

  if (!title) {
    alert('请输入收藏夹名称');
    $('#collectionNameInput').focus();
    return;
  }

  state.busy = true;
  setStatus('正在更新收藏夹…');

  // 尝试多个可能的 API 端点
  const endpoints = [
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'PUT', body: { title, description, is_public: isPublic } },
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'PATCH', body: { title, description, is_public: isPublic } },
  ];

  let resp = null;
  let lastError = '';
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

  // 更新本地数据
  collection.title = title;
  collection.description = description;
  collection.is_public = isPublic;

  closeCollectionModal();
  renderSidebar($('#listFilter').value.trim());
  setStatus(`已成功更新收藏夹「${title}」`);
}

/* ---------- 删除收藏夹 ---------- */

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

  state.busy = true;
  setStatus('正在删除收藏夹…');

  // 尝试多个可能的 API 端点
  const endpoints = [
    { url: `https://www.zhihu.com/api/v4/collections/${collection.id}`, method: 'DELETE' },
  ];

  let resp = null;
  let lastError = '';
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

  // 如果删除的是当前选中的收藏夹，清除选中状态
  if (state.current && state.current.id === collection.id) {
    state.current = null;
    state.items = [];
    state.selected.clear();
    $('#itemsBody').innerHTML = '';
    $('#emptyTip').hidden = false;
    setStatus(`收藏夹「${collection.title || '(未命名)'}」已删除，请选择其他收藏夹`);
  }

  // 从列表中移除
  state.collections = state.collections.filter((c) => c.id !== collection.id);
  closeDeleteModal();
  renderSidebar($('#listFilter').value.trim());
  updateSelectionUI();
}

/* 知乎收藏夹批量管理 - 管理器页面逻辑 */

const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  scope: 'mine',                 // 'mine' | 'questions_follow' | 'columns_follow'
  collections: [],
  followQuestions: [],           // 关注的问题
  followColumns: [],             // 关注的专栏
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
  // 取消收藏 / 移动 只在 mine 域显示
  $('#removeBtn').style.display = isFollow ? 'none' : '';
  $('#moveBtn').style.display = isFollow ? 'none' : '';
  // 批量取关 只在 follow 域显示
  $('#unfollowBtn').style.display = isFollow ? '' : 'none';
  // 导出工具栏 只在 mine 域显示
  $('#exportToolbar').style.display = isFollow ? 'none' : '';
  updateSelectionUI();
}

/* ---------- 侧栏列表渲染 ---------- */

// 根据 scope 返回侧栏原始数据
function getSidebarRawList() {
  if (state.scope === 'mine') return state.collections;
  if (state.scope === 'questions_follow') return state.followQuestions;
  if (state.scope === 'columns_follow') return state.followColumns;
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
  if (state.scope === 'mine') return `fav_${raw.id}`;
  if (state.scope === 'questions_follow') return `q_${raw.id}`;
  if (state.scope === 'columns_follow') return `col_${raw.id || raw.url_token}`;
  return String(raw.id);
}

function sidebarItemTitle(raw) {
  if (state.scope === 'mine') return raw.title || '(未命名收藏夹)';
  if (state.scope === 'questions_follow') return raw.title || '(未命名问题)';
  if (state.scope === 'columns_follow') return raw.title || '(未命名专栏)';
  return '';
}

function sidebarItemCount(raw) {
  if (state.scope === 'mine') return raw.item_count ?? '';
  if (state.scope === 'questions_follow') {
    if (typeof raw.follower_count === 'number') return `${raw.follower_count}关注`;
    if (typeof raw.answer_count === 'number') return `${raw.answer_count}回答`;
    return '';
  }
  if (state.scope === 'columns_follow') {
    if (typeof raw.articles_count === 'number') return `${raw.articles_count}篇`;
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

// 知乎 v4 收藏夹内容只用一个端点：/collections/{cid}/items
// 分类型端点（/answers /articles /videos /pins）全部 404，已废弃
async function loadCurrentContent() {
  if (!state.current) return;
  state.items = [];
  state.selected.clear();
  renderItems();

  const cid = state.current.id;
  const allRaw = [];
  let offset = 0;

  for (;;) {
    const url = `https://www.zhihu.com/api/v4/collections/${cid}/items?offset=${offset}&limit=20`;
    const resp = await api('GET', url);
    if (!resp.ok || !resp.data || !Array.isArray(resp.data.data)) {
      setStatus(`「${state.current.title}」加载失败（HTTP ${resp.status || '网络错误'}）`);
      break;
    }
    allRaw.push(...resp.data.data);
    const typeCounts = {};
    allRaw.forEach((d) => {
      const t = d.content?.type || '?';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    setStatus(`正在加载「${state.current.title}」… ${allRaw.length} 条（${Object.entries(typeCounts).map(([t, n]) => `${typeLabel(t)} ${n}`).join('，')}）`);
    if ((resp.data.paging && resp.data.paging.is_end) || resp.data.data.length === 0) break;
    offset += resp.data.data.length;
  }

  state.items = allRaw.map((item, idx) => normalizeMineItem(item, idx));

  if (state.items.length === 0) {
    setStatus(`「${state.current.title}」加载完成（0 条内容）`);
  } else {
    const counts = {};
    state.items.forEach((it) => { counts[it.type] = (counts[it.type] || 0) + 1; });
    const label = Object.entries(counts).map(([t, n]) => `${typeLabel(t)} ${n}`).join('，');
    setStatus(`「${state.current.title}」已加载 ${state.items.length} 条（${label}）`);
  }
  renderItems();
}

function typeLabel(t) {
  return { answer: '回答', article: '文章', pin: '想法', video: '视频', zvideo: '视频' }[t] || t;
}

// pin 富文本 content 是 Array（block 结构），遍历提取纯文本
function extractPinText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(block);
    } else if (typeof block === 'object') {
      // 可能的字段：content / text / value / excerpt / body
      const txt = block.content || block.text || block.value || block.excerpt || block.body || block.title || '';
      if (txt) parts.push(String(txt));
      // 递归嵌套（少数 pin block 里还有子数组）
      if (Array.isArray(block.blocks) || Array.isArray(block.children)) {
        const sub = extractPinText(block.blocks || block.children);
        if (sub) parts.push(sub);
      }
    }
  }
  return parts.join('').replace(/<[^>]*>/g, '').trim();
}

// 检测 content 是否是「pin 内嵌视频」（知乎 API 仍返回 type=pin，但有这些特征）
function isPinWithVideo(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.video_info || c.video || c.zvideo_id || c.video_id || c.media_id) return true;
  if (c.is_video === true || c.has_video === true) return true;
  if (c.video_thumbnail) return true;
  // immersion/feed 是 pin 内嵌视频的标志路径，不是独立视频
  if (typeof c.url === 'string' && c.url.includes('/video/immersion/feed/')) return true;
  return false;
}

// 检测 content 是否是「独立视频实体」（原生 video/zvideo）
function isStandaloneVideo(rawType, c) {
  if (rawType === 'video' || rawType === 'zvideo') return true;
  if (!c || typeof c !== 'object') return false;
  // 独立视频不会有 excerpt_title（那是 pin 的字段）
  if (c.excerpt_title) return false;
  // 独立视频有 zvideo_id/video_id/media_id 之一（但不是嵌套在 video_info 里的）
  return !!(c.zvideo_id || c.video_id || c.media_id);
}

// 从 c.url 提取 pin ID（兼容各种 pin URL 格式）
function extractPinIdFromUrl(u) {
  if (typeof u !== 'string') return null;
  const m1 = u.match(/\/pin\/(\d+)/);
  if (m1) return m1[1];
  // immersion/feed/{pinId}?object_type=pin
  const m2 = u.match(/\/video\/immersion\/feed\/(\d+)/);
  if (m2) return m2[1];
  return null;
}

function normalizeMineItem(item, idx) {
  const c = item.content || {};
  // 兜底：如果 item 本身就是 answer/article 结构（分类型端点包装失败）
  const originalType = c.type || item.type || 'unknown'; // API 原始类型，永不修改
  let rawType = originalType;  // 可被展示纠正覆盖
  let isEmbeddedVideo = false; // pin 内嵌视频标记
  // 知乎 pin 类型可以内嵌视频，但 API 仍返回 type=pin —— 标记为视频并单独处理 URL
  if (rawType === 'pin' && isPinWithVideo(c)) {
    console.info('[normalizeMineItem] idx=' + idx + ' pin 内嵌视频标记 (c.id=', c.id,
      ', url=', c.url, ')');
    isEmbeddedVideo = true;
    rawType = 'video';
  } else if (rawType === 'pin' || rawType === 'video' || rawType === 'zvideo' || rawType === 'unknown') {
    console.info('[normalizeMineItem] idx=' + idx + ' rawType=' + rawType,
      'c.type=', c.type, 'c.id=', c.id, 'c.url=', c.url,
      'keys=', Object.keys(c).slice(0, 15));
  }
  const type = rawType;
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
    // pin 有 excerpt_title 作为展示摘要，直接用
    let rawBody = c.excerpt_title || '';
    // 如果 excerpt_title 不够长，从 content Array 提取更多纯文本拼接
    if (!rawBody || rawBody.length < 10) {
      rawBody = extractPinText(c.content);
    }
    title = rawBody ? String(rawBody).trim() : '(无内容想法)';
    if (title.length > 40) title = title.slice(0, 40) + '…';

    // URL：pin 结构自带 url（形如 https://www.zhihu.com/pin/{id}?native=0）
    const pinId = c.id ?? item.id;
    url = c.url || (pinId ? `https://www.zhihu.com/pin/${pinId}` : '');
  } else if (type === 'video' || type === 'zvideo') {
    // ---- 标题 ----
    if (c.title) {
      title = c.title;
    } else if (c.excerpt_title) {
      title = c.excerpt_title;
    } else {
      const fromContent = extractPinText(c.content);
      title = fromContent || '(无标题视频)';
    }
    if (title.length > 60) title = title.slice(0, 60) + '…';

    // ---- URL ----
    if (isEmbeddedVideo) {
      // pin 内嵌视频：必须打开 pin 页面（带 video_pin 参数可直接定位视频）
      const pinId = extractPinIdFromUrl(c.url) || c.id;
      if (pinId) {
        url = `https://www.zhihu.com/pin/${pinId}?page=video_pin`;
      } else if (c.url) {
        url = c.url;
      }
      console.info('[video normalize] idx=' + idx, '内嵌视频 URL=' + url);
    } else {
      // 独立视频实体：优先用 content 自带的合法 URL
      if (c.url && !c.url.includes('/immersion/feed/')) {
        url = c.url;
      }
      // 否则尝试用 zvideo_id / video_id 构造
      if (!url) {
        const vid = c.zvideo_id || c.video_id || (c.video_info && c.video_info.video_id);
        if (vid) {
          url = `https://www.zhihu.com/video/${vid}`;
        }
      }
      console.info('[video normalize] idx=' + idx, '独立视频 URL=' + url);
    }
    if (url && url.startsWith('/')) url = 'https://www.zhihu.com' + url;
  } else {
    title = c.title || (c.question && c.question.title) || '(其他内容)';
    url = c.url || '';
    if (url && url.startsWith('/')) url = 'https://www.zhihu.com' + url;
  }
  return {
    uid: `${type}_${c.id != null ? c.id : `idx${idx}`}`,
    contentId: c.id,
    type,          // 展示用（pin 内嵌视频纠正为 video，让标签正确）
    entityType: originalType, // API 调用用（底层真实实体类型：answer/article/pin/video，永远不被展示纠正覆盖）
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

  const typeLabel = state.scope === 'questions_follow' ? '问题'
    : state.scope === 'columns_follow' ? '专栏'
    : "内容";

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
  openBtn.addEventListener('click', () => openInNewTab(followDetailUrl(raw)));
  actions.append(unfollowBtn, openBtn);

  td.append(h2, meta, actions);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function followDetailTitle(raw) {
  if (state.scope === 'questions_follow') return raw.title || '(未命名问题)';
  if (state.scope === 'columns_follow') return raw.title || '(未命名专栏)';
  return '';
}

function followDetailUrl(raw) {
  if (state.scope === 'questions_follow') return `https://www.zhihu.com/question/${raw.id}`;
  if (state.scope === 'columns_follow') {
    // 专栏路由：www.zhihu.com/column/{id}
    // 直接开 zhuanlan.zhihu.com 会触发 resolv 环境校验（被 CORS 拦截导致空白/404）
    // 注意：API 返回的 url 字段是 API endpoint（如 /api/v4/columns/c_xxx），不是页面 URL
    // id 字段本身就是 "c_123456..." 格式，直接拼即可
    if (!raw.id) return '';
    return `https://www.zhihu.com/column/${raw.id}`;
  }
  return '';
}

// 统一用 chrome.tabs.create 打开链接，避免 window.open 被拦截或开成弹窗
function openInNewTab(url) {
  if (!url) return;
  chrome.tabs.create({ url });
}

function removeFromSidebar(raw) {
  if (state.scope === 'questions_follow') state.followQuestions = state.followQuestions.filter((x) => x.id !== raw.id);
  if (state.scope === 'columns_follow') state.followColumns = state.followColumns.filter((x) => String(x.id || x.url_token) !== String(raw.id || raw.url_token));
}

/* ---------- 批量取消关注 ---------- */

// 递归搜索对象中 is_following / relationship.following 字段位置
function findIsFollowing(obj, path = 'root', found = []) {
  if (!obj || typeof obj !== 'object') return found;
  if ('is_following' in obj) found.push({ path: path + '.is_following', value: obj.is_following });
  if (obj.relationship && typeof obj.relationship === 'object') {
    if ('following' in obj.relationship) found.push({ path: path + '.relationship.following', value: obj.relationship.following });
  }
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) {
      findIsFollowing(obj[k], path + '.' + k, found);
    }
  }
  return found;
}

// 验证取关是否真的生效（GET 接口看 is_following）
async function verifyUnfollow(raw, scope) {
  const id = raw.id || raw.url_token;
  if (!id) return false;
  let endpoint = null;
  if (scope === 'questions_follow') {
    endpoint = `/questions/${id}`;
  } else if (scope === 'columns_follow') {
    endpoint = `/columns/${id}`;
  }
  if (!endpoint) return false;
  // 只用 www.zhihu.com（api.zhihu.com 对 collections 域部分无效）
  const resp = await api('GET', 'https://www.zhihu.com/api/v4' + endpoint);
  if (resp.ok && resp.data) {
    const d = resp.data;
    const found = findIsFollowing(d);
    console.info('[unfollow-verify] keys=', Object.keys(d).slice(0, 10), 'is_following@=', JSON.stringify(found));
    for (const f of found) {
      if (f.value === false) return true;
    }
  }
  return false;
}

// 取关单个对象
// 问题/专栏的 DELETE /{type}/{id}/followers 是已验证可用的
async function unfollowOne(raw, scope) {
  const id = raw.id || raw.url_token;
  if (!id) return { ok: false, status: 0 };

  let type;
  if (scope === 'questions_follow') type = 'questions';
  else if (scope === 'columns_follow') type = 'columns';
  if (!type) return { ok: false, status: 0 };

  const url = `https://www.zhihu.com/api/v4/${type}/${id}/followers`;
  console.info('[unfollow] DELETE', url);
  const resp = await api('DELETE', url);
  if (resp.ok) {
    console.info('[unfollow] ✅ SUCCESS', url);
    return { ok: true };
  }
  console.warn('[unfollow] ❌ FAILED', url, resp.status, resp.data);
  return { ok: false, status: resp.status };
}

// 侧栏多选批量取关
async function batchUnfollow() {
  console.info('[batchUnfollow] 入口, scope=', state.scope, 'selected.size=', state.listSelected.size, 'busy=', state.busy);
  if (state.busy) return;
  if (state.listSelected.size === 0) return;
  const rawList = getSidebarRawList();
  const targets = rawList.filter((r) => state.listSelected.has(rawSidebarUid(r)));
  console.info('[batchUnfollow] targets:', targets.map(t => ({ id: t.id, name: t.title || t.name || t.token })));
  if (targets.length === 0) return;
  if (!confirm(`确定批量取消关注这 ${targets.length} 项吗？`)) return;

  state.busy = true;

  // 问题/专栏：逐个走 DELETE API（并发 3）
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
  if (state.scope === 'questions_follow') state.followQuestions = state.followQuestions.filter((r) => !okSet.has(rawSidebarUid(r)));
  if (state.scope === 'columns_follow') state.followColumns = state.followColumns.filter((r) => !okSet.has(rawSidebarUid(r)));

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

  // 调试：每次渲染都打印全量条目，确保能在扩展页面的 Console 看到
  console.info('[renderItems] 共 ' + list.length + ' 条',
    list.map((it) => ({ type: it.type, title: (it.title || '').slice(0, 30), url: it.url, uid: it.uid })));

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
// 注意：pin 内嵌视频的 type 被纠正为 'video'（展示用），但 entityType 仍是 'pin'（API 必须用 pin）
async function removeOneItem(it, collectionId) {
  // API 路径用 entityType（底层真实实体），不是 type（展示纠正后的值）
  const realType = it.entityType || it.type;
  const supported = ['answer', 'article', 'pin', 'video', 'zvideo'];
  if (!supported.includes(realType)) return { ok: false, status: 0 };
  const apiType = realType === 'zvideo' ? 'video' : realType;

  const path = `/collections/contents/${apiType}/${it.contentId}`;
  const bases = [`https://www.zhihu.com/api/v4${path}`, `https://api.zhihu.com${path}`];

  let lastStatus = 0;
  for (const base of bases) {
    const resp = await api('PUT', base, `remove_collections=${collectionId}`, 'form');
    if (resp.ok) return { ok: true };
    lastStatus = resp.status || 0;
    console.warn('[remove] failed', base, resp.status, resp.data, 'entityType=', realType, 'contentId=', it.contentId);
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
// 注意：pin 内嵌视频的 type 被纠正为 'video'（展示用），但 entityType 仍是 'pin'（API 必须用 pin）
async function moveOneItem(it, srcId, targetId) {
  // API 路径用 entityType（底层真实实体），不是 type（展示纠正后的值）
  const realType = it.entityType || it.type;
  const supported = ['answer', 'article', 'pin', 'video', 'zvideo'];
  if (!supported.includes(realType)) return { ok: false, status: 0 };
  const apiType = realType === 'zvideo' ? 'video' : realType;

  const path = `/collections/contents/${apiType}/${it.contentId}`;
  const bases = [`https://www.zhihu.com/api/v4${path}`, `https://api.zhihu.com${path}`];

  let lastStatus = 0;
  for (const base of bases) {
    // 先加入目标收藏夹
    const add = await api('PUT', base, `add_collections=${targetId}`, 'form');
    if (!add.ok) {
      lastStatus = add.status || 0;
      console.warn('[move] add failed', base, add.status, add.data, 'entityType=', realType, 'contentId=', it.contentId);
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

// 类型白名单：所有类型都能导出元数据（JSON/MD/CSV/TXT）
// 只有 answer / article 能导出正文（ZIP），因为知乎 v4 没 pin/video 正文 API
const EXPORTABLE_META_TYPES = new Set(['answer', 'article', 'pin', 'video', 'zvideo', 'unknown']);
const EXPORTABLE_CONTENT_TYPES = new Set(['answer', 'article']);

// 返回不可导出的条目列表（按 filterSet 判断），以及按类型分组的统计
function filterUnsupported(items, filterSet) {
  const unsupported = items.filter((it) => !filterSet.has(it.type));
  const byType = {};
  unsupported.forEach((it) => { byType[it.type] = (byType[it.type] || 0) + 1; });
  return { unsupported, byType };
}

// 不可导出类型的中文名
const TYPE_NAME = { answer: '回答', article: '文章', pin: '想法', video: '视频', zvideo: '视频', unknown: '其他' };
function typeName(t) { return TYPE_NAME[t] || t; }

function exportItems(fmt) {
  if (state.busy || state.scope !== 'mine') return;
  let targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }

  // 元数据导出：任何类型都能导出（含 pin/video），只是提醒用户
  const { unsupported, byType } = filterUnsupported(targets, EXPORTABLE_META_TYPES);
  if (unsupported.length > 0) {
    const msg = `以下 ${unsupported.length} 条内容可能导出不完整：\n` +
      Object.entries(byType).map(([t, n]) => `· ${typeName(t)} × ${n}`).join('\n') +
      `\n\n建议取消勾选这些条目后重新导出。\n\n是否仍要继续导出？`;
    if (!confirm(msg)) return;
  }

  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;

  let content, mime, ext;
  if (fmt === 'json') {
    content = JSON.stringify(
      targets.map(({ type, title, author, url }) => ({ type: typeName(type), title, author, url })),
      null,
      2
    );
    mime = 'application/json';
    ext = 'json';
  } else if (fmt === 'markdown') {
    const lines = targets.map((it) => `- [${it.title}](${it.url})（${typeName(it.type)} · ${it.author || '未知作者'}）`);
    content = `# ${state.current ? state.current.title : '知乎收藏'}\n\n` + lines.join('\n') + '\n';
    mime = 'text/markdown';
    ext = 'md';
  } else {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['类型', '标题', '作者', '链接'].map(esc).join(',')];
    for (const it of targets) {
      rows.push([typeName(it.type), it.title, it.author, it.url].map(esc).join(','));
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
  if (state.busy || state.scope !== 'mine') return;
  let targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }

  const { unsupported, byType } = filterUnsupported(targets, EXPORTABLE_META_TYPES);
  if (unsupported.length > 0) {
    const msg = `以下 ${unsupported.length} 条内容可能导出不完整：\n` +
      Object.entries(byType).map(([t, n]) => `· ${typeName(t)} × ${n}`).join('\n') +
      `\n\n建议取消勾选这些条目后重新导出。\n\n是否仍要继续导出？`;
    if (!confirm(msg)) return;
  }

  const name = `知乎收藏_${state.current ? state.current.title : 'export'}_${targets.length}条`;
  const content = targets
    .map((it) => `${typeName(it.type)}｜${it.title}\n${it.url || '(无链接)'}`)
    .join('\n\n') + '\n';
  downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
  setStatus(`已导出 ${targets.length} 条标题和链接（TXT）`);
}

/* ---------- 导出正文为 Markdown (ZIP) ---------- */

// 正文接口：必须带 include=content。文章接口还会强制校验 x-zse-96 签名，
// 签名由 background.js 统一附加；备用地址走移动端接口
const CONTENT_API_URLS = {
  answer: [
    (id) => `https://www.zhihu.com/api/v4/answers/${id}?include=content`,
    (id) => `https://api.zhihu.com/v4/answers/${id}?include=content`,
  ],
  article: [
    (id) => `https://www.zhihu.com/api/v4/articles/${id}?include=content`,
    (id) => `https://api.zhihu.com/articles/${id}?include=content`,
  ],
};

async function fetchContent(it) {
  const builders = CONTENT_API_URLS[it.type];
  if (!builders || it.contentId == null) return null;
  let fallback = null;
  for (const build of builders) {
    const resp = await api('GET', build(it.contentId));
    if (!resp.ok || !resp.data) {
      const detail = (resp.data && resp.data.error) || resp.error || '';
      console.warn('[export] content failed', it.type, resp.status, detail);
      continue;
    }
    const content = typeof resp.data.content === 'string' ? resp.data.content : '';
    if (content.trim()) return resp.data;
    fallback = resp.data; // 接口通了但正文为空，继续试备用地址
  }
  return fallback;
}

async function exportContentsZip() {
  if (state.busy || state.scope !== 'mine') return;
  let targets = state.selected.size
    ? state.items.filter((it) => state.selected.has(it.uid))
    : state.items;
  if (!targets.length) {
    alert('没有可导出的内容（请先加载收藏夹或勾选内容）');
    return;
  }

  // 正文导出：只有 answer/article 支持
  const { unsupported, byType } = filterUnsupported(targets, EXPORTABLE_CONTENT_TYPES);
  if (unsupported.length > 0) {
    const msg = `以下 ${unsupported.length} 条内容不支持正文抓取（知乎无对应 API）：\n` +
      Object.entries(byType).map(([t, n]) => `· ${typeName(t)} × ${n}`).join('\n') +
      `\n\n这些条目将被跳过，仅导出 ${targets.length - unsupported.length} 条可抓取的内容。\n\n建议取消勾选不支持的条目后再导出。\n\n是否仍要继续？`;
    if (!confirm(msg)) return;
    // 跳过不支持的条目
    targets = targets.filter((it) => EXPORTABLE_CONTENT_TYPES.has(it.type));
    if (!targets.length) {
      alert('剩余条目全部不支持正文抓取，请取消导出。');
      return;
    }
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
    const data = await fetchContent(it);
    if (data) {
      const md = buildMarkdownFile(it, typeof data.content === 'string' ? data.content : '');
      const base = uniqueName(sanitizeFileName(it.title), usedNames);
      files.push({ name: `${base}.md`, data: encoder.encode(md) });
    } else {
      failed.push(it); // 接口失败或不支持的类型
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

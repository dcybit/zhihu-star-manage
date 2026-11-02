const openBtn = document.getElementById('openBtn');
const loginBtn = document.getElementById('loginBtn');
const statusEl = document.getElementById('status');

openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
  window.close();
});

loginBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.zhihu.com/signin' });
  window.close();
});

chrome.runtime.sendMessage(
  { type: 'zhihu-api', method: 'GET', url: 'https://www.zhihu.com/api/v4/me' },
  (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = '无法连接知乎 API';
      return;
    }
    if (resp && resp.ok && resp.data && resp.data.url_token) {
      statusEl.textContent = `已登录：${resp.data.name || resp.data.url_token}`;
    } else {
      statusEl.textContent = '未登录知乎，批量管理功能不可用';
      loginBtn.style.display = 'block';
    }
  }
);

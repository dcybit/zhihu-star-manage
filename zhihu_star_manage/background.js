// 后台 Service Worker：代理知乎 API 请求
// 自动携带登录 Cookie，写操作时附加 x-xsrftoken 头

const ZHIHU_ORIGIN = 'https://www.zhihu.com';

async function getXsrfToken() {
  try {
    const cookie = await chrome.cookies.get({ url: ZHIHU_ORIGIN, name: '_xsrf' });
    return cookie ? cookie.value : '';
  } catch (e) {
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'zhihu-api') return false;

  (async () => {
    try {
      const method = (msg.method || 'GET').toUpperCase();
      const headers = { 'x-requested-with': 'fetch' };
      if (method !== 'GET') {
        headers['x-xsrftoken'] = await getXsrfToken();
      }
      let body;
      if (msg.body !== undefined && msg.body !== null) {
        if (msg.bodyType === 'form') {
          headers['content-type'] = 'application/x-www-form-urlencoded';
          body = String(msg.body);
        } else {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(msg.body);
        }
      }
      const resp = await fetch(msg.url, {
        method,
        credentials: 'include',
        headers,
        body
      });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      sendResponse({ ok: resp.ok, status: resp.status, data });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e && e.message || e) });
    }
  })();

  return true; // 异步响应
});

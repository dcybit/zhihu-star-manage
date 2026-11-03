// 后台 Service Worker：代理知乎 API 请求
// 自动携带登录 Cookie，写操作时附加 x-xsrftoken 头
// 文章正文接口强制校验 x-zse-96 签名，这里按需生成

const ZHIHU_ORIGIN = 'https://www.zhihu.com';

async function getCookie(name) {
  try {
    const cookie = await chrome.cookies.get({ url: ZHIHU_ORIGIN, name });
    return cookie ? cookie.value : '';
  } catch (e) {
    return '';
  }
}

/* ---------- MD5（仅用于生成 x-zse-96，UTF-8 输入，输出小写 hex） ---------- */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const total = (((len + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (len * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor(len / 536870912), true); // len*8 的高 32 位

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < total; chunk += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl32((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- x-zse-96 加密（算法与 RSSHub x-zse-96-v3 一致） ---------- */

const ZSE_ALPHABET = '6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE';
const ZSE_KEYS = [
  1170614578, 1024848638, 1413669199, -343334464, -766094290, -1373058082, -143119608, -297228157,
  1933479194, -971186181, -406453910, 460404854, -547427574, -1891326262, -1679095901, 2119585428,
  -2029270069, 2035090028, -1521520070, -5587175, -77751101, -2094365853, -1243052806, 1579901135,
  1321810770, 456816404, -1391643889, -229302305, 330002838, -788960546, 363569021, -1947871109
];
const ZSE_SBOX = [
  20, 223, 245, 7, 248, 2, 194, 209, 87, 6, 227, 253, 240, 128, 222, 91, 237, 9, 125, 157, 230, 93,
  252, 205, 90, 79, 144, 199, 159, 197, 186, 167, 39, 37, 156, 198, 38, 42, 43, 168, 217, 153, 15,
  103, 80, 189, 71, 191, 97, 84, 247, 95, 36, 69, 14, 35, 12, 171, 28, 114, 178, 148, 86, 182, 32,
  83, 158, 109, 22, 255, 94, 238, 151, 85, 77, 124, 254, 18, 4, 26, 123, 176, 232, 193, 131, 172,
  143, 142, 150, 30, 10, 146, 162, 62, 224, 218, 196, 229, 1, 192, 213, 27, 110, 56, 231, 180, 138,
  107, 242, 187, 54, 120, 19, 44, 117, 228, 215, 203, 53, 239, 251, 127, 81, 11, 133, 96, 204, 132,
  41, 115, 73, 55, 249, 147, 102, 48, 122, 145, 106, 118, 74, 190, 29, 16, 174, 5, 177, 129, 63,
  113, 99, 31, 161, 76, 246, 34, 211, 13, 60, 68, 207, 160, 65, 111, 82, 165, 67, 169, 225, 57,
  112, 244, 155, 51, 236, 200, 233, 58, 61, 47, 100, 137, 185, 64, 17, 70, 234, 163, 219, 108, 170,
  166, 59, 149, 52, 105, 24, 212, 78, 173, 45, 0, 116, 226, 119, 136, 206, 135, 175, 195, 25, 92,
  121, 208, 126, 139, 3, 75, 141, 21, 130, 98, 241, 40, 154, 66, 184, 49, 181, 46, 243, 88, 101,
  183, 8, 23, 72, 188, 104, 179, 210, 134, 250, 201, 164, 89, 216, 202, 220, 50, 221, 152, 140, 33,
  235, 214
];

function zsePut(value, out, offset) {
  out[offset] = 255 & (value >>> 24);
  out[offset + 1] = 255 & (value >>> 16);
  out[offset + 2] = 255 & (value >>> 8);
  out[offset + 3] = 255 & value;
}

function zseGet(bytes, offset) {
  return ((255 & bytes[offset]) << 24) | ((255 & bytes[offset + 1]) << 16) |
    ((255 & bytes[offset + 2]) << 8) | (255 & bytes[offset + 3]);
}

function zseRotl(value, shift) {
  return (((value & 0xffffffff) << shift) | (value >>> (32 - shift))) >>> 0;
}

function zseTransform(value) {
  const a = new Array(4);
  const b = new Array(4);
  zsePut(value, a, 0);
  b[0] = ZSE_SBOX[255 & a[0]];
  b[1] = ZSE_SBOX[255 & a[1]];
  b[2] = ZSE_SBOX[255 & a[2]];
  b[3] = ZSE_SBOX[255 & a[3]];
  const r = zseGet(b, 0);
  return r ^ zseRotl(r, 2) ^ zseRotl(r, 10) ^ zseRotl(r, 18) ^ zseRotl(r, 24);
}

function zseRound(input) {
  const out = new Array(16);
  const words = new Array(36);
  words[0] = zseGet(input, 0);
  words[1] = zseGet(input, 4);
  words[2] = zseGet(input, 8);
  words[3] = zseGet(input, 12);
  for (let i = 0; i < 32; i++) {
    words[i + 4] = words[i] ^ zseTransform(words[i + 1] ^ words[i + 2] ^ words[i + 3] ^ ZSE_KEYS[i]);
  }
  zsePut(words[35], out, 0);
  zsePut(words[34], out, 4);
  zsePut(words[33], out, 8);
  zsePut(words[32], out, 12);
  return out;
}

function zseXorBlocks(bytes, seed) {
  let result = [];
  let blockIndex = 0;
  for (let left = bytes.length; left > 0; left -= 16) {
    const block = new Array(16);
    const slice = bytes.slice(16 * blockIndex, 16 * (blockIndex + 1));
    for (let i = 0; i < 16; i++) block[i] = slice[i] ^ seed[i];
    seed = zseRound(block);
    result = result.concat(seed);
    blockIndex++;
  }
  return result;
}

function zsePreProcess(md5Str) {
  const codes = [];
  for (let i = 0; i < md5Str.length; i++) codes.push(md5Str.charCodeAt(i));
  codes.unshift(0);
  codes.unshift(Math.floor(Math.random() * 127));
  for (let i = 0; i < 15; i++) codes.push(14);

  const fixArr = [48, 53, 57, 48, 53, 51, 102, 55, 100, 49, 53, 101, 48, 49, 100, 55];
  const front = codes.slice(0, 16).map((v, i) => v ^ fixArr[i] ^ 42);
  const head = zseRound(front);
  return head.concat(zseXorBlocks(codes.slice(16, 48), head));
}

function zseEncrypt(md5Str) {
  const processed = zsePreProcess(md5Str);
  let current = 0;
  let result = '';
  for (let i = 0; i < processed.length; i++) {
    const value = processed[processed.length - i - 1] ^ ((58 >>> (8 * (i % 4))) & 255);
    current |= value << (8 * (i % 3));
    if (i % 3 === 2) {
      for (const shift of [0, 6, 12, 18]) {
        result += ZSE_ALPHABET.charAt((current >>> shift) & 63);
      }
      current = 0;
    }
  }
  return result;
}

// 文章类接口需要签名，其余接口不校验，保持原样避免回归
// 2026-11 实测：知乎签名源串用 pathname（不含 query），d_c0 用完整 cookie 值（含 | 时间戳）
// 为防将来变更，对 pathname-only 和 pathname+search 两种源串都做变体签名重试
function makeSignHeaders(url, dc0, pathOnly) {
  const u = new URL(url);
  const apiPath = pathOnly ? u.pathname : (u.pathname + u.search);
  return {
    'x-api-version': '3.0.91',
    'x-app-za': 'OS=Web',
    'x-zse-93': '101_3_3.0',
    'x-zse-96': '2.0_' + zseEncrypt(md5Hex(`101_3_3.0+${apiPath}+${dc0}`))
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'zhihu-api') return false;

  (async () => {
    try {
      const method = (msg.method || 'GET').toUpperCase();
      const headers = { 'x-requested-with': 'fetch' };
      if (method !== 'GET') {
        headers['x-xsrftoken'] = await getCookie('_xsrf');
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
      const doFetch = (h) => fetch(msg.url, { method, credentials: 'include', headers: h, body });

      // 文章类接口强制校验 x-zse-96：api.zhihu.com 的文章也会 40362
      const needsArticleSign = method === 'GET' &&
        (msg.url.includes('/api/v4/articles/') || msg.url.includes('/api/articles/'));

      let resp;
      if (needsArticleSign) {
        const dc0 = await getCookie('d_c0');
        if (dc0) {
          // 四种签名变体，覆盖 pathname-only / pathname+search × 完整d_c0 / 截断d_c0
          const dc0Variants = [dc0, dc0.split('|')[0]];
          const pathVariants = [true, false]; // true=pathname-only, false=pathname+search
          let last403 = null;
          for (const dv of dc0Variants) {
            for (const pv of pathVariants) {
              resp = await doFetch(Object.assign({}, headers, makeSignHeaders(msg.url, dv, pv)));
              if (resp.status !== 403) break;
              last403 = resp;
            }
            if (resp && resp.status !== 403) break;
          }
          if (!resp) resp = last403;
        } else {
          resp = await doFetch(headers);
        }
      } else {
        resp = await doFetch(headers);
      }
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

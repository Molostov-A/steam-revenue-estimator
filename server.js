const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT || 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function extractAppId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/(?:app|agecheck\/app)\/(\d+)/i);
    if (m) return m[1];
  } catch (e) {
    const m = s.match(/app\/(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept': 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function getAppDetails(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english&filters=basic,price_overview,release_date,genres,categories,platforms`;
  const json = await fetchJson(url);
  const entry = json && json[appid];
  if (!entry || !entry.success) {
    const err = new Error('App not found');
    err.status = 404;
    throw err;
  }
  return entry.data;
}

async function getAppReviews(appid) {
  const url = `https://store.steampowered.com/appreviews/${appid}?json=1&filter=all&language=all&num_per_page=0&purchase_type=all`;
  const json = await fetchJson(url);
  return json && json.query_summary ? json.query_summary : null;
}

async function handleApp(req, res, query) {
  const appid = extractAppId(query.get('url') || query.get('appid'));
  if (!appid) {
    return sendJson(res, 400, { ok: false, error: 'Не удалось определить App ID. Укажите ссылку вида https://store.steampowered.com/app/XXXX или сам App ID.' });
  }

  try {
    const [details, reviews] = await Promise.all([getAppDetails(appid), getAppReviews(appid)]);

    const priceOverview = details.price_overview || null;
    const result = {
      ok: true,
      appid,
      name: details.name || null,
      type: details.type || null,
      isFree: !!details.is_free,
      price: priceOverview ? {
        currency: priceOverview.currency,
        initial: priceOverview.initial,          // cents
        final: priceOverview.final,              // cents
        discountPercent: priceOverview.discount_percent || 0,
      } : null,
      releaseDate: details.release_date ? details.release_date.date : null,
      comingSoon: !!(details.release_date && details.release_date.coming_soon),
      genres: (details.genres || []).map(g => g.description),
      reviews: reviews ? {
        total: reviews.total_reviews,
        positive: reviews.total_positive,
        negative: reviews.total_negative,
        score: reviews.review_score,
        scoreDesc: reviews.review_score_desc,
      } : null,
    };
    sendJson(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { ok: false, error: status === 404 ? 'Игра с таким App ID не найдена на Steam.' : 'Не удалось получить данные Steam: ' + err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(reqUrl.pathname);

  if (req.method === 'GET' && pathname === '/api/app') {
    return handleApp(req, res, reqUrl.searchParams);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { ok: false, error: 'Forbidden' });
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Steam Revenue Estimator running at http://localhost:${PORT}`);
});

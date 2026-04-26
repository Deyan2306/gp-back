/**
 * GP — Гошо от Почивка · Dev server
 * Static files + Spotify token proxy + Last.fm proxy
 *
 * Usage:
 *   node server.js   → http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

/* ── Load .env ── */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length) process.env[k] = v.join('=');
  });
}

const PORT             = process.env.PORT              || 3000;
const SP_CLIENT_ID     = process.env.SP_CLIENT_ID      || '';
const SP_CLIENT_SECRET = process.env.SP_CLIENT_SECRET  || '';
const LASTFM_KEY       = process.env.LASTFM_API_KEY    || '';
const SP_ARTIST_ID     = '3fXwhnOqetiNuGFnMhzwKM';
const LASTFM_ARTIST    = 'Gosho%20Ot%20Pochivka';

/* ── MIME types ── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'text/javascript',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.txt' : 'text/plain',
  '.woff2':'font/woff2',
};

/* ── helpers ── */
function json(res, data, status = 200, cache = 'no-store') {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function httpsGet(hostname, pathStr, cb) {
  const req = https.request(
    { hostname, path: pathStr, method: 'GET', headers: { 'User-Agent': 'Node.js/GP-Site' } },
    r => { let d = ''; r.on('data', c => d += c); r.on('end', () => cb(null, d)); }
  );
  req.on('error', cb);
  req.end();
}

/* ── Spotify token proxy ── */
function spotifyToken(res) {
  if (!SP_CLIENT_ID || !SP_CLIENT_SECRET) {
    return json(res, { error: 'Spotify credentials not configured' }, 503);
  }
  const body    = 'grant_type=client_credentials';
  const authB64 = Buffer.from(SP_CLIENT_ID + ':' + SP_CLIENT_SECRET).toString('base64');
  const req = https.request({
    hostname: 'accounts.spotify.com', path: '/api/token', method: 'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Authorization':  'Basic ' + authB64,
      'Content-Length': Buffer.byteLength(body),
    },
  }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => {
      try {
        const { access_token, expires_in } = JSON.parse(d);
        if (!access_token) throw new Error();
        json(res, { access_token, expires_in }, 200, 'no-store');
      } catch { json(res, { error: 'Bad Spotify response' }, 500); }
    });
  });
  req.on('error', () => json(res, { error: 'Spotify unreachable' }, 502));
  req.write(body); req.end();
}

/* ── Spotify artist image (oEmbed — no Premium needed) ── */
function spotifyArtist(res) {
  httpsGet('open.spotify.com',
    '/oembed?url=https://open.spotify.com/artist/' + SP_ARTIST_ID,
    (err, d) => {
      if (err) return json(res, { thumbnail: null }, 200, 'public, max-age=3600');
      try {
        const j = JSON.parse(d);
        json(res, { thumbnail: j.thumbnail_url || null, title: j.title || 'GP' },
          200, 'public, max-age=3600');
      } catch { json(res, { thumbnail: null }, 200, 'public, max-age=3600'); }
    });
}

/* ── Last.fm top tracks proxy ── */
function lastFmTracks(res) {
  if (!LASTFM_KEY) {
    return json(res, { error: 'LASTFM_API_KEY not set in .env' }, 503);
  }
  const p = `/2.0/?method=artist.gettoptracks&artist=${LASTFM_ARTIST}&api_key=${LASTFM_KEY}&format=json&limit=50&autocorrect=1`;
  httpsGet('ws.audioscrobbler.com', p, (err, d) => {
    if (err) return json(res, {}, 502, 'no-store');
    json(res, d, 200, 'public, max-age=1800');
  });
}

/* ── Last.fm album info proxy (for per-track art) ── */
function lastFmAlbumInfo(trackName, artistName, res) {
  const p = `/2.0/?method=track.getInfo&track=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json&autocorrect=1`;
  httpsGet('ws.audioscrobbler.com', p, (err, d) => {
    if (err) return json(res, {}, 502, 'no-store');
    json(res, d, 200, 'public, max-age=3600');
  });
}

/* ── Static file server ── */
const server = http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (req.method === 'GET') {
    if (pathname === '/api/spotify-token')  return spotifyToken(res);
    if (pathname === '/api/spotify-artist') return spotifyArtist(res);
    if (pathname === '/api/lastfm-tracks')  return lastFmTracks(res);
    if (pathname === '/api/lastfm-track')   return lastFmAlbumInfo(query.track || '', query.artist || LASTFM_ARTIST.replace(/%20/g,' '), res);
  }

  /* Block sensitive files */
  const base = path.basename(pathname);
  if (base.startsWith('.') || base === 'server.js') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  if (!path.extname(filePath)) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  GP — Гошо от Почивка');
  console.log('  ─────────────────────────────────────');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Spotify : ${SP_CLIENT_ID  ? '✓ configured' : '✗ missing (check .env)'}`);
  console.log(`  Last.fm : ${LASTFM_KEY    ? '✓ configured' : '✗ add LASTFM_API_KEY to .env'}`);
  console.log('');
  console.log('  Stop: Ctrl+C');
  console.log('');
});

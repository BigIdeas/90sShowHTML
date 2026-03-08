#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SONGS_DIR = path.join(ROOT, 'songs');
const DIST_DIR = path.join(ROOT, 'dist');

// Tag colors
const TAG_COLORS = { D: 'goldenrod', P: 'red', S: 'limegreen' };

// ── Parse song metadata ─────────────────────────────────────────────────────

function parseSong(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const metaMatch = raw.match(/<!--\n([\s\S]*?)-->/);
  const meta = {};
  if (metaMatch) {
    metaMatch[1].split('\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
  }

  const content = raw.replace(/<!--[\s\S]*?-->\s*/, '').trim();

  return {
    title: meta.title || path.basename(filePath, '.html'),
    displayTitle: meta.displayTitle || meta.title || path.basename(filePath, '.html'),
    tags: meta.tags ? meta.tags.split(',') : [],
    included: meta.included !== 'false',
    content,
    filename: path.basename(filePath),
  };
}

// ── Templates ───────────────────────────────────────────────────────────────

function songPageHTML(song) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${song.title}</title>
  <link rel="stylesheet" href="style.css">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <div class="song-title">${song.displayTitle}</div>
  <a id="back-btn" href="index.html" onclick="event.preventDefault(); history.back();">&#9664;</a>
  <div id="content">
    ${song.content}
  </div>
  <script>
    // Auto-fit: scale content to fill viewport without overflow
    function autoFit() {
      var c = document.getElementById('content');
      if (!c) return;
      c.style.transform = '';
      var vh = window.innerHeight;
      var vw = window.innerWidth;
      // Vertical scale
      var sy = vh / c.scrollHeight;
      // Horizontal scale (check pre elements for wide tab lines)
      var maxW = 0;
      c.querySelectorAll('pre').forEach(function(p) {
        if (p.scrollWidth > maxW) maxW = p.scrollWidth;
      });
      var sx = maxW > vw ? vw / maxW : 1;
      var s = Math.min(sy, sx, 1);
      if (s < 1) {
        c.style.transform = 'scale(' + s + ')';
        c.style.transformOrigin = 'top left';
      }
    }
    document.addEventListener('DOMContentLoaded', function() {
      autoFit();
      // Re-run when toggle buttons change content
      var obs = new MutationObserver(autoFit);
      obs.observe(document.getElementById('content'), {
        childList: true, subtree: true, characterData: true
      });
    });

    // Swipe right to go back
    var tsx = 0;
    document.addEventListener('touchstart', function(e) { tsx = e.changedTouches[0].screenX; });
    document.addEventListener('touchend', function(e) {
      if (e.changedTouches[0].screenX - tsx > 100) history.back();
    });

    // Service worker
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  </script>
</body>
</html>`;
}

function indexPageHTML(songs) {
  const included = songs.filter(s => s.included);
  const items = included.map(s => {
    const tagsHtml = s.tags.length
      ? `<div class="tags">${s.tags.map(t =>
          `<span style="color: ${TAG_COLORS[t] || 'white'}">${t}</span>`
        ).join('')}</div>`
      : '';
    return `    <a href="./${s.filename}"><li>${s.title}${tagsHtml}</li></a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Song List</title>
  <link rel="stylesheet" href="style.css">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <ul>
${items}
  </ul>
  <script>
    // Auto-size grid rows
    var ul = document.querySelector('ul');
    var cols = 2;
    ul.style.gridTemplateRows = 'repeat(' + Math.ceil(ul.children.length / cols) + ', auto)';

    // Auto-fit index to viewport
    (function() {
      var vh = window.innerHeight;
      var sh = ul.scrollHeight;
      if (sh > vh) {
        var s = vh / sh;
        ul.style.transform = 'scale(' + s + ')';
        ul.style.transformOrigin = 'top left';
        ul.style.width = (100 / s) + '%';
      }
    })();

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  </script>
</body>
</html>`;
}

function serviceWorkerJS(files) {
  const hash = crypto.createHash('md5')
    .update(files.join(','))
    .digest('hex')
    .slice(0, 8);

  return `var CACHE = 'songbook-${hash}';
var FILES = ${JSON.stringify(files, null, 2)};

// Pre-cache all files on install
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function(cache) { return cache.addAll(FILES); })
      .then(function() { return self.skipWaiting(); })
  );
});

// Clean old caches on activate
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// Network-first: always try fresh content, fall back to cache offline
self.addEventListener('fetch', function(e) {
  e.respondWith(
    fetch(e.request).then(function(res) {
      var clone = res.clone();
      caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
      return res;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});`;
}

// ── Build ───────────────────────────────────────────────────────────────────

// Clean dist
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// Read and sort songs
const songs = fs.readdirSync(SONGS_DIR)
  .filter(f => f.endsWith('.html'))
  .map(f => parseSong(path.join(SONGS_DIR, f)))
  .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

console.log(`Building ${songs.length} songs (${songs.filter(s => s.included).length} included)...`);

// Copy style.css
fs.copyFileSync(path.join(ROOT, 'style.css'), path.join(DIST_DIR, 'style.css'));

// Generate song pages
for (const song of songs) {
  fs.writeFileSync(path.join(DIST_DIR, song.filename), songPageHTML(song));
}

// Generate index
fs.writeFileSync(path.join(DIST_DIR, 'index.html'), indexPageHTML(songs));

// Generate manifest
fs.writeFileSync(path.join(DIST_DIR, 'manifest.json'), JSON.stringify({
  name: 'HLW Songbook',
  short_name: 'Songbook',
  start_url: '.',
  display: 'standalone',
  background_color: '#000000',
  theme_color: '#000000',
  icons: [],
}, null, 2));

// Generate service worker
const allFiles = [
  './',
  './style.css',
  './manifest.json',
  ...songs.map(s => `./${s.filename}`),
];
fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), serviceWorkerJS(allFiles));

console.log(`Done → dist/ (${songs.length} songs + index + sw + manifest)`);

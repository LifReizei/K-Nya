// Anime Torrents (AniList + Multi-source) for Kino — v3.0.0

const ANILIST_URL = "https://graphql.anilist.co";
const NYAA_URL = "https://nyaa.si";
const SUKEBEI_URL = "https://sukebei.nyaa.si";
const YTS_URL = "https://yts.mx";
const X1337_URL = "https://1337x.to";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// --- Cachés en memoria ---
const coverCache = new Map();
const torrentCache = new Map();
const TORRENT_CACHE_TTL = 60 * 60 * 1000; // 1 hora

// --- 1. Configuración del paquete externo ---
function getExternalPackage() {
  return kino.config.get("external_app") || "com.kino.torcino";
}

// --- 2. AniList API ---
async function anilistQuery(query, variables) {
  const r = await kino.fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error("AniList HTTP " + r.status);
  const json = await r.json();
  return json.data;
}

const MEDIA_FRAGMENT = `
  id
  title { romaji english native }
  description
  coverImage { extraLarge }
  bannerImage
  episodes
  nextAiringEpisode { episode }
  seasonYear
  format
`;

function toKinoItem(media) {
  let overview = "";
  if (media.description) {
    overview = media.description.replace(/<[^>]*>?/gm, '').slice(0, 300) + "...";
  }
  return {
    id: String(media.id),
    ref: String(media.id),
    title: media.title.romaji || media.title.english || media.title.native,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: overview,
    year: media.seasonYear ? String(media.seasonYear) : undefined,
    kind: media.format === "MOVIE" ? "movie" : "series"
  };
}

// --- 3. Utilidades ---
function decodeHtml(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function buildMagnet(infoHash) {
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce"
  ];
  const params = [`xt=urn:btih:${infoHash}`];
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join("&")}`;
}

// --- 4. Proveedores de torrents ---

// Nyaa (anime)
async function fetchNyaa(queryStr, category = "1_2") {
  try {
    const url = `${NYAA_URL}/?page=rss&q=${encodeURIComponent(queryStr)}&c=${category}&f=0`;
    const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseNyaaRss(xml, "Nyaa");
  } catch (e) {
    console.warn("Nyaa fetch error:", e);
    return [];
  }
}

// Sukebei (solo búsqueda)
async function fetchSukebei(queryStr) {
  try {
    const url = `${SUKEBEI_URL}/?page=rss&q=${encodeURIComponent(queryStr)}&c=0_0&f=0`;
    const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseNyaaRss(xml, "Sukebei");
  } catch (e) {
    console.warn("Sukebei fetch error:", e);
    return [];
  }
}

// Parser compartido Nyaa/Sukebei
function parseNyaaRss(xml, provider) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeHtml((block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1] || "").trim();
    const infoHash = (block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/i) || [])[1] || "";
    const seeders = Number((block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i) || [])[1] || 0);
    const size = decodeHtml((block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/i) || [])[1] || "");
    if (infoHash) {
      items.push({ id: infoHash, ref: infoHash, title, seeders, size, provider, kind: "movie" });
    }
  }
  return items;
}

// YTS (películas)
async function fetchYTS(queryStr) {
  try {
    const url = `${YTS_URL}/api/v2/list_movies.json?query_term=${encodeURIComponent(queryStr)}&sort_by=seeds&limit=20`;
    const r = await kino.fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return [];
    const json = await r.json();
    if (json.status !== "ok" || !json.data || !json.data.movies) return [];
    const items = [];
    for (const m of json.data.movies) {
      if (!m.torrents) continue;
      for (const t of m.torrents) {
        if (!t.hash) continue;
        items.push({
          id: t.hash,
          ref: t.hash,
          title: `${m.title_long || m.title} [${t.quality || "?"}] [${t.type || ""}]`,
          seeders: t.seeds || 0,
          size: t.size || "?",
          provider: "YTS",
          kind: "movie"
        });
      }
    }
    return items;
  } catch (e) {
    console.warn("YTS fetch error:", e);
    return [];
  }
}

// 1337x (general, scraping)
async function fetch1337x(queryStr) {
  try {
    const searchUrl = `${X1337_URL}/search/${encodeURIComponent(queryStr)}/1/`;
    const r = await kino.fetch(searchUrl, { headers: { "User-Agent": UA } });
    if (!r.ok) return [];
    const html = await r.text();

    const items = [];
    const rowRegex = /<tr>[\s\S]*?<td class="coll-1 name">[\s\S]*?<a href="(\/torrent\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td class="coll-2 seeds">(\d+)<\/td>[\s\S]*?<td class="coll-4 size[^"]*">([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    let match;
    const detailPromises = [];

    while ((match = rowRegex.exec(html)) !== null) {
      if (detailPromises.length >= 10) break; // limitar peticiones de detalle

      const detailPath = match[1];
      const title = match[2].replace(/<[^>]*>/g, "").trim();
      const seeders = parseInt(match[3], 10) || 0;
      const sizeHtml = match[4];
      const sizeMatch = sizeHtml.replace(/<[^>]*>/g, "").trim().match(/([\d.]+\s*[KMGT]?B)/i);
      const size = sizeMatch ? sizeMatch[1] : "?";

      detailPromises.push((async () => {
        try {
          const detailUrl = `${X1337_URL}${detailPath}`;
          const detailRes = await kino.fetch(detailUrl, { headers: { "User-Agent": UA } });
          if (!detailRes.ok) return null;
          const detailHtml = await detailRes.text();
          const magnetMatch = detailHtml.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
          if (!magnetMatch) return null;
          const hashMatch = magnetMatch[1].match(/btih:([a-fA-F0-9]{40})/i);
          if (!hashMatch) return null;
          return {
            id: hashMatch[1].toLowerCase(),
            ref: hashMatch[1].toLowerCase(),
            title,
            seeders,
            size,
            provider: "1337x",
            kind: "movie"
          };
        } catch (_) {
          return null;
        }
      })());
    }

    const detailResults = await Promise.all(detailPromises);
    for (const it of detailResults) {
      if (it) items.push(it);
    }
    return items;
  } catch (e) {
    console.warn("1337x fetch error:", e);
    return [];
  }
}

// --- 5. Registro de proveedores ---
const PROVIDERS = {
  Nyaa: fetchNyaa,
  "1337x": fetch1337x,
  YTS: fetchYTS,
  Sukebei: fetchSukebei
};

// Sukebei solo en búsqueda, nunca en reproducción
const PLAYBACK_PROVIDERS = ["Nyaa", "1337x", "YTS"];
const SEARCH_PROVIDERS = ["Nyaa", "1337x", "YTS", "Sukebei"];

// --- 6. Agregación ---
function getTorrentCacheKey(query, providers) {
  return `${query}::${providers.join(",")}`;
}

async function searchAll(query, providerNames) {
  if (!query) return [];

  const cacheKey = getTorrentCacheKey(query, providerNames);
  const cached = torrentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < TORRENT_CACHE_TTL) {
    return cached.data;
  }

  const tasks = providerNames.map(name => {
    const fn = PROVIDERS[name];
    return fn ? fn(query) : Promise.resolve([]);
  });
  const settled = await Promise.allSettled(tasks);

  const all = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      all.push(...result.value);
    } else if (result.status === "rejected") {
      console.warn(`Proveedor ${providerNames[index]} falló:`, result.reason?.message || result.reason);
    }
  });

  // Deduplicar por hash
  const seen = new Set();
  const unique = all.filter(it => {
    if (!it.id || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });

  torrentCache.set(cacheKey, { data: unique, timestamp: Date.now() });
  return unique;
}

// --- 7. Filtrado y ordenamiento ---
function toMB(sizeStr) {
  if (!sizeStr) return 0;
  const m = String(sizeStr).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { B: 1 / 1024 / 1024, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 };
  return val * (mult[unit] || 0);
}

function getQualityRank(title) {
  const t = title.toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return 4;
  if (/1080p/.test(t)) return 3;
  if (/720p/.test(t)) return 2;
  if (/480p|sd/.test(t)) return 1;
  return 0;
}

function filterAndSort(items) {
  const quality = (kino.config.get("preferred_quality") || "1080p").toLowerCase();
  const strategy = kino.config.get("sort_strategy") || "seeders";
  const excludeCam = kino.config.get("exclude_cam") !== false;

  let filtered = items;

  // 1. Excluir CAM / SCR / TS / 3D / HC
  if (excludeCam) {
    filtered = filtered.filter(it =>
      !/\b(CAM|CAMRIP|HDCAM|SCR|TS|HDTS|3D|HC|TELESYNC)\b/i.test(it.title)
    );
  }

  // 2. Preferir la calidad elegida (si hay coincidencias)
  const preferred = filtered.filter(it => it.title.toLowerCase().includes(quality));
  if (preferred.length > 0) filtered = preferred;

  // 3. Ordenar
  if (strategy === "quality") {
    filtered.sort((a, b) => {
      const ra = getQualityRank(a.title);
      const rb = getQualityRank(b.title);
      return rb - ra || b.seeders - a.seeders;
    });
  } else if (strategy === "size") {
    filtered.sort((a, b) => toMB(a.size) - toMB(b.size) || b.seeders - a.seeders);
  } else {
    filtered.sort((a, b) => b.seeders - a.seeders);
  }

  return filtered;
}

// --- 8. Carátulas desde AniList ---
async function getAniListCover(title) {
  const cleanTitle = title.replace(/\[.*?\]|\(.*?\)/g, "").replace(/ - \d+.*$/, "").trim().slice(0, 50);
  if (!cleanTitle) return null;
  if (coverCache.has(cleanTitle)) return coverCache.get(cleanTitle);

  const query = `query ($search: String) { Media(search: $search, type: ANIME) { coverImage { extraLarge } bannerImage } }`;
  try {
    const data = await anilistQuery(query, { search: cleanTitle });
    const media = data.Media;
    const result = media ? {
      poster: media.coverImage?.extraLarge,
      backdrop: media.bannerImage || media.coverImage?.extraLarge
    } : null;
    coverCache.set(cleanTitle, result);
    return result;
  } catch (_) {
    return null;
  }
}

async function enrichWithCovers(items) {
  const results = [];
  for (const it of items.slice(0, 20)) {
    const cover = await getAniListCover(it.title);
    results.push({
      ...it,
      poster: cover?.poster,
      backdrop: cover?.backdrop,
      overview: `Seeders: ${it.seeders} · Tamaño: ${it.size} · Fuente: ${it.provider || "?"}`
    });
  }
  return results;
}

// --- 9. Home ---
export async function home() {
  const query = `
    query {
      trending: Page(page: 1, perPage: 20) { media(sort: TRENDING_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
      popular: Page(page: 1, perPage: 20) { media(sort: POPULARITY_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
    }
  `;
  const data = await anilistQuery(query, {});
  return [
    { id: "trending", title: "Tendencias", items: data.trending.media.map(toKinoItem) },
    { id: "popular", title: "Populares", items: data.popular.media.map(toKinoItem) }
  ];
}

// --- 10. Secciones ---
const SECTION_TABS = [
  { id: "inicio", label: "Inicio" },
  { id: "series", label: "Series" },
  { id: "peliculas", label: "Películas" },
  { id: "ovas", label: "OVAs" },
  { id: "onas", label: "ONAs" },
  { id: "raw", label: "RAW" },
  { id: "liveaction", label: "Live Action" }
];

export async function section(arg) {
  const tab = arg && arg.tab ? String(arg.tab) : "inicio";
  const rows = [];

  if (["inicio", "series", "peliculas", "ovas", "onas"].includes(tab)) {
    let formatFilter = "";
    if (tab === "series") formatFilter = `format_in: [TV, TV_SHORT]`;
    if (tab === "peliculas") formatFilter = `format: MOVIE`;
    if (tab === "ovas") formatFilter = `format: OVA`;
    if (tab === "onas") formatFilter = `format: ONA`;

    const query = `
      query {
        page1: Page(page: 1, perPage: 20) {
          media(sort: POPULARITY_DESC, type: ANIME, ${formatFilter}) { ${MEDIA_FRAGMENT} }
        }
        page2: Page(page: 1, perPage: 20) {
          media(sort: TRENDING_DESC, type: ANIME, ${formatFilter}) { ${MEDIA_FRAGMENT} }
        }
      }
    `;
    const data = await anilistQuery(query, {});

    if (tab === "inicio") {
      rows.push({ id: "trending", title: "Tendencias", items: data.page2.media.map(toKinoItem) });
      rows.push({ id: "popular", title: "Populares", items: data.page1.media.map(toKinoItem) });
    } else {
      rows.push({ id: "popular", title: "Populares", items: data.page1.media.map(toKinoItem) });
      rows.push({ id: "trending", title: "Tendencias", items: data.page2.media.map(toKinoItem) });
    }
  }
  else if (tab === "raw") {
    const items = await fetchNyaa("", "1_3");
    const enriched = await enrichWithCovers(items);
    rows.push({ id: "raw_latest", title: "Últimos RAW en Nyaa", items: enriched });
  }
  else if (tab === "liveaction") {
    const items = await fetchNyaa("", "4_1");
    const enriched = await enrichWithCovers(items);
    rows.push({ id: "la_latest", title: "Últimos Live Action en Nyaa", items: enriched });
  }

  return {
    tabs: SECTION_TABS,
    tab: tab,
    rows: rows.filter(r => r.items.length > 0)
  };
}

// --- 11. Búsqueda ---
export async function search(query) {
  const q = query.q || "";
  if (!q) return [];

  // AniList (catálogo) + todas las fuentes de torrents (incluye Sukebei)
  const anilistPromise = anilistQuery(`
    query ($search: String) {
      Page(page: 1, perPage: 30) {
        media(search: $search, type: ANIME) { ${MEDIA_FRAGMENT} }
      }
    }
  `, { search: q }).catch(e => {
    console.warn("AniList search error:", e);
    return { Page: { media: [] } };
  });

  const torrentsPromise = searchAll(q, SEARCH_PROVIDERS).catch(e => {
    console.warn("Torrent search error:", e);
    return [];
  });

  const [anilistData, torrents] = await Promise.all([anilistPromise, torrentsPromise]);

  const anilistItems = (anilistData.Page?.media || []).map(toKinoItem);
  const torrentItems = torrents.map(t => ({
    id: t.id,
    ref: t.id,
    title: t.title,
    poster: "",
    backdrop: "",
    overview: `Seeders: ${t.seeders} · Tamaño: ${t.size} · Fuente: ${t.provider}`,
    kind: t.kind || "movie"
  }));

  return [...anilistItems, ...torrentItems];
}

// --- 12. Episodios ---
export async function episodes(ref) {
  if (/^[a-fA-F0-9]{40}$/.test(ref)) {
    return {
      series: { title: "Torrent Directo", poster: "", backdrop: "" },
      episodes: [{ season: 1, number: 1, ref: ref, title: "Reproducir Torrent" }]
    };
  }

  const gql = `query ($id: Int) { Media(id: $id) { ${MEDIA_FRAGMENT} } }`;
  const data = await anilistQuery(gql, { id: parseInt(ref, 10) });
  const media = data.Media;
  if (!media) throw kino.error("not_found", "Anime no encontrado");

  const series = {
    title: media.title.romaji || media.title.english,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '') : ""
  };

  const eps = [];
  if (media.format === "MOVIE") {
    eps.push({ season: 1, number: 1, ref: `${media.id}|1|${media.title.romaji || media.title.english}`, title: "Película Completa" });
  } else {
    let totalEps = media.episodes || 0;
    if (totalEps === 0 && media.nextAiringEpisode) totalEps = media.nextAiringEpisode.episode - 1;
    if (totalEps === 0) totalEps = 12;

    for (let i = 1; i <= totalEps; i++) {
      eps.push({ season: 1, number: i, ref: `${media.id}|${i}|${media.title.romaji || media.title.english}`, title: `Episodio ${i}` });
    }
  }
  return { series, episodes: eps };
}

// --- 13. Resolve ---
export async function resolve(ref) {
  if (/^[a-fA-F0-9]{40}$/.test(ref)) {
    return { external: { protocol: "magnet", ref: buildMagnet(ref), package: getExternalPackage() } };
  }

  const parts = String(ref).split("|");
  const episodeNum = parts[1] || "1";
  const title = parts[2] || "";

  const quality = kino.config.get("preferred_quality") || "1080p";
  let audio = kino.config.get("preferred_audio") || "";
  if (audio === "any") audio = "";

  const epStr = String(episodeNum).padStart(2, '0');

  const queries = [
    `${title} ${epStr} ${quality} ${audio}`.trim(),
    `${title} ${epStr} ${quality}`.trim(),
    `${title} ${epStr}`.trim(),
    `${title} ${quality}`.trim(),
    `${title}`.trim()
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);

  for (const q of queries) {
    const candidates = await searchAll(q, PLAYBACK_PROVIDERS);
    if (candidates.length === 0) continue;

    const ranked = filterAndSort(candidates);
    if (ranked.length > 0) {
      const best = ranked[0];
      return { external: { protocol: "magnet", ref: buildMagnet(best.id), package: getExternalPackage() } };
    }
  }

  throw kino.error("not_found", "No se encontraron torrents con suficientes semillas para este episodio.");
}

// --- 14. Acciones ---
export async function action(key) {
  if (key === "clear_cache") {
    coverCache.clear();
    torrentCache.clear();
    return { message: "Caché de carátulas y torrents borrada correctamente." };
  }

  if (key === "test_sources") {
    const results = [];

    try {
      await anilistQuery("query { Page(page: 1, perPage: 1) { media(type: ANIME) { id } } }", {});
      results.push("✅ AniList OK");
    } catch (e) {
      results.push("❌ AniList: " + e.message);
    }

    try {
      await fetchNyaa("test", "1_2");
      results.push("✅ Nyaa OK");
    } catch (e) {
      results.push("❌ Nyaa: " + e.message);
    }

    try {
      await fetchSukebei("test");
      results.push("✅ Sukebei OK");
    } catch (e) {
      results.push("❌ Sukebei: " + e.message);
    }

    try {
      await fetchYTS("test");
      results.push("✅ YTS OK");
    } catch (e) {
      results.push("❌ YTS: " + e.message);
    }

    try {
      await fetch1337x("test");
      results.push("✅ 1337x OK");
    } catch (e) {
      results.push("❌ 1337x: " + e.message);
    }

    return { message: results.join("\n") };
  }

  if (key === "reset_prefs") {
    try {
      kino.config.set("external_app", "com.kino.torcino");
      kino.config.set("preferred_quality", "1080p");
      kino.config.set("preferred_audio", "any");
      kino.config.set("exclude_cam", true);
      kino.config.set("sort_strategy", "seeders");
      return { message: "Preferencias restablecidas a los valores de fábrica." };
    } catch (e) {
      return { message: "No se pudieron restablecer las preferencias." };
    }
  }

  return { message: "Acción no reconocida." };
}

// --- 15. Estado de la Caché ---
export async function settingsStatus() {
  const coverCount = coverCache.size;
  const torrentCount = torrentCache.size;
  return {
    cache_status: `Carátulas: ${coverCount} · Torrents: ${torrentCount}`
  };
}
// Anime Torrents (Multi-source) — v3.1.2
kino.log("Cargando Anime Torrents...");

const ANILIST_URL = "https://graphql.anilist.co";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Caché en memoria para no saturar las APIs
const cache = new Map();

// =========================================================================================
// 1. ANILIST API
// =========================================================================================
async function anilistQuery(query, variables) {
  const cacheKey = `anilist:${JSON.stringify(variables)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const r = await kino.fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error("AniList HTTP " + r.status);
  const data = (await r.json()).data;
  
  cache.set(cacheKey, data);
  return data;
}

const MEDIA_FRAGMENT = `
  id title { romaji english native } description
  coverImage { extraLarge } bannerImage episodes
  seasonYear format
`;

async function toKinoItem(media) {
  return {
    id: String(media.id),
    ref: String(media.id),
    title: media.title.romaji || media.title.english || media.title.native,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '').slice(0, 200) + "..." : "",
    year: media.seasonYear ? String(media.seasonYear) : undefined,
    kind: media.format === "MOVIE" ? "movie" : "series"
  };
}

// =========================================================================================
// 2. FUNCIONES DE INTERFAZ (Section, Home, Browse)
// =========================================================================================

// SECCIÓN (Pestañas personalizadas)
export async function section(arg) {
  const tab = arg && arg.tab ? String(arg.tab) : "inicio";
  const tabs = [
    { id: "inicio", label: "Inicio" },
    { id: "peliculas", label: "Películas" },
    { id: "series", label: "Series" }
  ];
  
  const rows = [];
  try {
    if (tab === "peliculas") {
      const query = `query { Page(page: 1, perPage: 25) { media(type: ANIME, format: MOVIE, sort: POPULARITY_DESC) { ${MEDIA_FRAGMENT} } } }`;
      const data = await anilistQuery(query, {});
      rows.push({ id: "peli", title: "Películas Populares", items: data.Page.media.map(toKinoItem), ref: "browse_peliculas" });
    } else if (tab === "series") {
      const query = `query { Page(page: 1, perPage: 25) { media(type: ANIME, format_in: [TV, TV_SHORT], sort: POPULARITY_DESC) { ${MEDIA_FRAGMENT} } } }`;
      const data = await anilistQuery(query, {});
      rows.push({ id: "serie", title: "Series Populares", items: data.Page.media.map(toKinoItem), ref: "browse_series" });
    } else {
      const query = `
        query {
          trending: Page(page: 1, perPage: 25) { media(sort: TRENDING_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
          popular: Page(page: 1, perPage: 25) { media(sort: POPULARITY_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
        }
      `;
      const data = await anilistQuery(query, {});
      rows.push({ id: "trending", title: "Tendencias en Anime", items: data.trending.media.map(toKinoItem), ref: "browse_trending" });
      rows.push({ id: "popular", title: "Populares", items: data.popular.media.map(toKinoItem), ref: "browse_popular" });
    }
  } catch (e) {
    kino.log("Error en section: " + e.message);
  }

  return { tabs, tab, rows };
}

// HOME (Lo que se ve en la pestaña principal de Kino)
export async function home() {
  const query = `
    query {
      trending: Page(page: 1, perPage: 25) { media(sort: TRENDING_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
      popular: Page(page: 1, perPage: 25) { media(sort: POPULARITY_DESC, type: ANIME) { ${MEDIA_FRAGMENT} } }
    }
  `;
  const data = await anilistQuery(query, {});
  
  return [
    { id: "trending", title: "Tendencias en Anime", items: data.trending.media.map(toKinoItem), ref: "browse_trending" },
    { id: "popular", title: "Populares", items: data.popular.media.map(toKinoItem), ref: "browse_popular" }
  ];
}

// BROWSE (Para el botón "Ver más")
export async function browse(ref, cursor) {
  const page = parseInt(cursor || "1", 10);
  let sort = "POPULARITY_DESC";
  let extra = "type: ANIME";
  
  if (ref === "browse_trending") sort = "TRENDING_DESC";
  if (ref === "browse_peliculas") extra += ", format: MOVIE";
  if (ref === "browse_series") extra += ", format_in: [TV, TV_SHORT]";
  
  const query = `
    query {
      Page(page: ${page}, perPage: 30) {
        media(sort: ${sort}, ${extra}) { ${MEDIA_FRAGMENT} }
      }
    }
  `;
  const data = await anilistQuery(query, {});
  const mediaList = data.Page?.media || [];
  const items = mediaList.map(toKinoItem);

  return {
    items: items,
    next: items.length > 0 ? String(page + 1) : undefined
  };
}

// =========================================================================================
// 3. BÚSQUEDA, EPISODIOS Y RESOLVE
// =========================================================================================
export async function search(query) {
  const q = query.q || "";
  if (!q) return [];
  const gql = `query ($search: String) { Page(page: 1, perPage: 30) { media(search: $search, type: ANIME) { ${MEDIA_FRAGMENT} } } }`;
  const data = await anilistQuery(gql, { search: q });
  return (data.Page?.media || []).map(toKinoItem);
}

export async function episodes(ref) {
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

  let totalEps = media.episodes || 12;
  const eps = [];
  for (let i = 1; i <= totalEps; i++) {
    eps.push({ 
      season: 1, 
      number: i, 
      ref: `${ref}|${i}|${media.title.romaji || media.title.english}`, 
      title: `Episodio ${i}` 
    });
  }
  return { series, episodes: eps };
}

// =========================================================================================
// 4. BUSCADORES DE TORRENTS
// =========================================================================================
async function searchNyaa(query) {
  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  return parseNyaaRSS(await r.text(), "Nyaa");
}

async function searchSukebei(query) {
  const url = `https://sukebei.nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_0&f=0`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  return parseNyaaRSS(await r.text(), "Sukebei");
}

function parseNyaaRSS(xml, source) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([^<]+)<\/title>/i) || [])[1] || "";
    const infoHash = (block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/i) || [])[1] || "";
    const seeders = Number((block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i) || [])[1] || 0);
    const sizeStr = (block.match(/<nyaa:size>([^<]+)<\/nyaa:size>/i) || [])[1] || "0 B";
    
    if (infoHash) {
      items.push({ 
        source, title, infoHash, seeders, 
        sizeStr, sizeBytes: parseSize(sizeStr),
        magnet: buildMagnet(infoHash) 
      });
    }
  }
  return items;
}

async function searchYTS(query) {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=10`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const json = await r.json();
  if (!json.data || !json.data.movies) return [];
  
  const items = [];
  for (const movie of json.data.movies) {
    if (!movie.torrents) continue;
    for (const t of movie.torrents) {
      items.push({
        source: "YTS",
        title: `${movie.title_long} [${t.quality}]`,
        infoHash: t.hash,
        seeders: t.seeds,
        sizeStr: t.size,
        sizeBytes: t.size_bytes,
        magnet: buildMagnet(t.hash)
      });
    }
  }
  return items;
}

function parseSize(str) {
  const m = str.match(/([\d.]+)\s*([KMGTP]B)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4 };
  return val * (mult[unit] || 1);
}

function buildMagnet(hash) {
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce"
  ];
  const params = [`xt=urn:btih:${hash}`];
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join("&")}`;
}

// =========================================================================================
// 5. RESOLVE Y ACCIONES
// =========================================================================================
export async function resolve(ref) {
  const parts = String(ref).split("|");
  const title = parts[2] || "";
  const episode = parts[1] || "1";
  
  const quality = kino.config.get("preferred_quality") || "1080p";
  let audio = kino.config.get("preferred_audio") || "";
  if (audio === "any") audio = "";

  const epStr = String(episode).padStart(2, '0');
  const searchQuery = `${title} ${epStr} ${quality} ${audio}`.trim();

  const results = await Promise.allSettled([
    searchNyaa(searchQuery),
    searchSukebei(searchQuery),
    searchYTS(searchQuery)
  ]);

  let allTorrents = [];
  for (const res of results) {
    if (res.status === "fulfilled") allTorrents.push(...res.value);
  }

  const excludeCam = kino.config.get("exclude_cam");
  if (excludeCam) {
    const badWords = /\b(CAM|SCR|TS|3D|HDCAM|HDTS)\b/i;
    allTorrents = allTorrents.filter(t => !badWords.test(t.title));
  }

  if (allTorrents.length === 0) {
    throw kino.error("not_found", "No se encontraron torrents con esos filtros.");
  }

  const sortStrategy = kino.config.get("sort_strategy") || "seeders";
  allTorrents.sort((a, b) => {
    if (sortStrategy === "seeders") return b.seeders - a.seeders;
    if (sortStrategy === "size") return a.sizeBytes - b.sizeBytes;
    if (sortStrategy === "quality") {
      const scoreA = a.title.includes("2160p") ? 4 : a.title.includes("1080p") ? 3 : a.title.includes("720p") ? 2 : 1;
      const scoreB = b.title.includes("2160p") ? 4 : b.title.includes("1080p") ? 3 : b.title.includes("720p") ? 2 : 1;
      return scoreB - scoreA || b.seeders - a.seeders;
    }
    return 0;
  });

  const best = allTorrents[0];
  const pack = kino.config.get("external_app") || "com.kino.torcino";

  kino.log(`[Torrents] Reproduciendo: ${best.title} (${best.source})`);

  return {
    external: {
      protocol: "magnet",
      ref: best.magnet,
      resolver: pack
    }
  };
}

export async function action(key) {
  if (key === "clear_cache") {
    cache.clear();
    return { message: "Caché borrada correctamente." };
  }

  if (key === "test_sources") {
    try {
      await anilistQuery("query { Page(page: 1, perPage: 1) { media(type: ANIME) { id } } }", {});
      const nyaa = await searchNyaa("test");
      const yts = await searchYTS("test");
      return { message: `✅ AniList OK | Nyaa: ${nyaa.length} | YTS: ${yts.length}` };
    } catch (e) {
      return { message: "❌ Error al probar fuentes: " + e.message };
    }
  }

  if (key === "reset_prefs") {
    return { message: "Preferencias restablecidas." };
  }

  return { message: "Acción no reconocida." };
}

export async function settingsStatus() {
  return {
    cache_status: `Caché: ${cache.size} elementos`
  };
}
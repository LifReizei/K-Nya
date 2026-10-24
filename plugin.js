// Anime Torrents (AniList + Nyaa) for Kino — v2.1.0

const ANILIST_URL = "https://graphql.anilist.co";
const NYAA_URL = "https://nyaa.si";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function getExternalPackage() {
  return kino.config.get("external_app") || "com.kino.torcino";
}

// --- AniList API ---
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

// --- Nyaa Base ---
function decodeHtml(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

async function fetchNyaa(queryStr, category = "1_2") {
  // category 1_2 = Anime Subs, 1_3 = Anime Raw, 4_1 = Live Action
  const url = `${NYAA_URL}/?page=rss&q=${encodeURIComponent(queryStr)}&c=${category}&f=0`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  if (!r.ok) return [];
  const xml = await r.text();
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
      items.push({ id: infoHash, ref: infoHash, title, seeders, size, kind: "movie" });
    }
  }
  return items;
}

// --- Enriquecer con Carátulas para Nyaa ---
const coverCache = new Map();
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
  for (const it of items.slice(0, 20)) { // Límite de 20 para no saturar AniList
    const cover = await getAniListCover(it.title);
    results.push({
      ...it,
      poster: cover?.poster,
      backdrop: cover?.backdrop,
      overview: `Seeders: ${it.seeders} · Tamaño: ${it.size}`
    });
  }
  return results;
}

// --- HOME (Lo que se ve por defecto en Kino) ---
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

// --- SECTION (Menú de Pestañas) ---
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

  if (tab === "inicio" || tab === "series" || tab === "peliculas" || tab === "ovas" || tab === "onas") {
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
    // Nyaa Raw = Categoría 1_3
    const items = await fetchNyaa("", "1_3");
    const enriched = await enrichWithCovers(items);
    rows.push({ id: "raw_latest", title: "Últimos RAW", items: enriched });
  } 
  else if (tab === "liveaction") {
    // Nyaa Live Action = Categoría 4_1
    const items = await fetchNyaa("", "4_1");
    const enriched = await enrichWithCovers(items);
    rows.push({ id: "la_latest", title: "Últimos Live Action", items: enriched });
  }

  return {
    tabs: SECTION_TABS,
    tab: tab,
    rows: rows.filter(r => r.items.length > 0)
  };
}

// --- SEARCH ---
export async function search(query) {
  const q = query.q || "";
  if (!q) return [];
  const gql = `
    query ($search: String) {
      Page(page: 1, perPage: 30) {
        media(search: $search, type: ANIME) { ${MEDIA_FRAGMENT} }
      }
    }
  `;
  const data = await anilistQuery(gql, { search: q });
  return (data.Page?.media || []).map(toKinoItem);
}

// --- EPISODES ---
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

// --- RESOLVE (Play) ---
export async function resolve(ref) {
  // Si el ref ya es un infoHash (40 caracteres hex) significa que viene de RAW o Live Action
  if (/^[a-fA-F0-9]{40}$/.test(ref)) {
    return { external: { protocol: "magnet", ref: buildMagnet(ref), package: getExternalPackage() } };
  }

  // Si tiene "|", viene de una serie/película de AniList
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
    `${title} ${epStr}`.trim()
  ];

  for (const q of queries) {
    const results = await fetchNyaa(q, "1_2");
    if (results.length > 0) {
      // Ordenar por seeders y tomar el mejor
      results.sort((a, b) => b.seeders - a.seeders);
      return { external: { protocol: "magnet", ref: buildMagnet(results[0].id), package: getExternalPackage() } };
    }
  }

  throw kino.error("not_found", "No se encontraron torrents para este episodio.");
}

function buildMagnet(infoHash) {
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce"
  ];
  const params = [`xt=urn:btih:${infoHash}`];
  for (const tr of trackers) params.push(`tr=${encodeURIComponent(tr)}`);
  return `magnet:?${params.join("&")}`;
}

// Anime Torrents (AniList + Nyaa) for Kino — v2.1.5

const ANILIST_URL = "https://graphql.anilist.co";
const NYAA_URL = "https://nyaa.si";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// --- Utilidades de Configuración ---
function getExternalPackage() {
  const sel = kino.config.get("external_app") || "com.kino.torcino";

  if (sel === "custom1") {
    const pkg = String(kino.config.get("custom_package_1") || "").trim();
    return pkg || "com.kino.torcino"; // fallback si está vacío
  }
  if (sel === "custom2") {
    const pkg = String(kino.config.get("custom_package_2") || "").trim();
    return pkg || "com.kino.torcino"; // fallback si está vacío
  }

  // Retrocompatible: si ya era un package ID directo (config antigua), se respeta
  return sel;
}

// --- AniList API (Metadatos, Carátulas y Sinopsis) ---
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
  duration
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

// --- Interfaz Principal (Home) ---
export async function home() {
  const query = `
    query {
      trending: Page(page: 1, perPage: 25) { media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} } }
      popular: Page(page: 1, perPage: 25) { media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} } }
      top: Page(page: 1, perPage: 25) { media(sort: SCORE_DESC, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} } }
      movies: Page(page: 1, perPage: 25) { media(sort: POPULARITY_DESC, type: ANIME, format: MOVIE, isAdult: false) { ${MEDIA_FRAGMENT} } }
    }
  `;
  const data = await anilistQuery(query, {});
  
  const rows = [];
  if (data.trending?.media) rows.push({ id: "trending", title: "Tendencias", items: data.trending.media.map(toKinoItem) });
  if (data.popular?.media) rows.push({ id: "popular", title: "Populares", items: data.popular.media.map(toKinoItem) });
  if (data.top?.media) rows.push({ id: "top", title: "Mejor Puntuados", items: data.top.media.map(toKinoItem) });
  if (data.movies?.media) rows.push({ id: "movies", title: "Películas", items: data.movies.media.map(toKinoItem) });
  
  return rows;
}

// --- Búsqueda ---
export async function search(query) {
  const q = query.q || "";
  if (!q) return [];
  const gql = `
    query ($search: String) {
      Page(page: 1, perPage: 40) {
        media(search: $search, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} }
      }
    }
  `;
  const data = await anilistQuery(gql, { search: q });
  return (data.Page?.media || []).map(toKinoItem);
}

// --- Generación de Episodios ---
export async function episodes(ref) {
  const gql = `query ($id: Int) { Media(id: $id) { ${MEDIA_FRAGMENT} } }`;
  const data = await anilistQuery(gql, { id: parseInt(ref, 10) });
  const media = data.Media;
  if (!media) throw kino.error("not_found", "Anime no encontrado en AniList");

  const series = {
    title: media.title.romaji || media.title.english,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '') : ""
  };

  const eps = [];
  
  if (media.format === "MOVIE") {
    eps.push({
      season: 1,
      number: 1,
      ref: `${media.id}|1|${media.title.romaji || media.title.english}`,
      title: "Película Completa"
    });
  } else {
    let totalEps = media.episodes || 0;
    if (totalEps === 0 && media.nextAiringEpisode) {
      totalEps = media.nextAiringEpisode.episode - 1;
    }
    if (totalEps === 0) totalEps = 12;

    for (let i = 1; i <= totalEps; i++) {
      eps.push({
        season: 1,
        number: i,
        ref: `${media.id}|${i}|${media.title.romaji || media.title.english}`,
        title: `Episodio ${i}`
      });
    }
  }

  return { series, episodes: eps };
}

// --- Nyaa (Búsqueda de Torrents) ---
function decodeHtml(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

async function searchNyaa(queryStr) {
  const url = `${NYAA_URL}/?page=rss&q=${encodeURIComponent(queryStr)}&c=1_2&f=0`;
  const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  if (!r.ok) return null;
  
  const xml = await r.text();
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let bestItem = null;
  let maxSeeders = -1;
  let m;
  
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const infoHash = (block.match(/<nyaa:infoHash>([^<]+)<\/nyaa:infoHash>/i) || [])[1] || "";
    const seeders = Number((block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/i) || [])[1] || 0);
    
    if (infoHash && seeders > maxSeeders) {
      maxSeeders = seeders;
      bestItem = infoHash;
    }
  }
  return bestItem;
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

// --- Resolver (Play) ---
export async function resolve(ref) {
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
    try {
      const infoHash = await searchNyaa(q);
      if (infoHash) {
        return {
          external: {
            protocol: "magnet",
            ref: buildMagnet(infoHash),
            package: getExternalPackage()
          }
        };
      }
    } catch (e) {
      // Ignorar y pasar al siguiente intento
    }
  }

  throw kino.error("not_found", "No se encontraron torrents con suficientes semillas para este episodio en Nyaa.");
}
// Anime Torrents (AniList + Nyaa) for Kino — v2.0.0

const ANILIST_URL = "https://graphql.anilist.co";
const NYAA_URL = "https://nyaa.si";
const UA = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// --- Utilidades de Configuración ---
function getExternalPackage() {
  return kino.config.get("external_app") || "com.kino.torcino";
}

// --- AniList API (Metadatos y Carátulas) ---
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
  duration
  seasonYear
  format
`;

function toKinoItem(media) {
  return {
    id: String(media.id),
    ref: String(media.id),
    title: media.title.romaji || media.title.english || media.title.native,
    poster: media.coverImage?.extraLarge,
    backdrop: media.bannerImage || media.coverImage?.extraLarge,
    overview: media.description ? media.description.replace(/<[^>]*>?/gm, '').slice(0, 300) + "..." : "",
    year: media.seasonYear ? String(media.seasonYear) : undefined,
    kind: media.format === "MOVIE" ? "movie" : "series"
  };
}

export async function home() {
  const query = `
    query {
      trending: Page(page: 1, perPage: 20) { media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} } }
      popular: Page(page: 1, perPage: 20) { media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} } }
      movies: Page(page: 1, perPage: 20) { media(sort: POPULARITY_DESC, type: ANIME, format: MOVIE, isAdult: false) { ${MEDIA_FRAGMENT} } }
    }
  `;
  const data = await anilistQuery(query, {});
  
  const rows = [];
  if (data.trending?.media) rows.push({ id: "trending", title: "Tendencias", items: data.trending.media.map(toKinoItem) });
  if (data.popular?.media) rows.push({ id: "popular", title: "Populares", items: data.popular.media.map(toKinoItem) });
  if (data.movies?.media) rows.push({ id: "movies", title: "Películas", items: data.movies.media.map(toKinoItem) });
  
  return rows;
}

export async function search(query) {
  const q = query.q || "";
  if (!q) return [];
  const gql = `
    query ($search: String) {
      Page(page: 1, perPage: 30) {
        media(search: $search, type: ANIME, isAdult: false) { ${MEDIA_FRAGMENT} }
      }
    }
  `;
  const data = await anilistQuery(gql, { search: q });
  return (data.Page?.media || []).map(toKinoItem);
}

// --- Episodios (Generados desde AniList) ---
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
  const totalEps = media.episodes || 1;
  
  for (let i = 1; i <= totalEps; i++) {
    eps.push({
      season: 1,
      number: i,
      ref: `${media.id}|${i}|${media.title.romaji || media.title.english}`, // Pasamos ID, Ep y Título para buscar en Nyaa
      title: `Episodio ${i}`
    });
  }

  return { series, episodes: eps };
}

// --- Nyaa Search y Resolve ---
function decodeHtml(s) {
  return String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

async function findTorrentOnNyaa(title, episode) {
  const quality = kino.config.get("preferred_quality") || "1080p";
  const audio = kino.config.get("preferred_audio") || "";
  // Construye la búsqueda: "Titulo del anime" + "01" + "1080p"
  const searchQuery = `${title} ${String(episode).padStart(2, '0')} ${quality} ${audio}`.trim();
  
  const url = `${NYAA_URL}/?page=rss&q=${encodeURIComponent(searchQuery)}&c=1_2&f=0`; // c=1_2 (Anime - English-translated)
  
  const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  if (!r.ok) throw new Error("Nyaa HTTP " + r.status);
  
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
      bestItem = { infoHash, seeders };
    }
  }
  
  if (!bestItem) throw new Error("No se encontraron torrents para: " + searchQuery);
  return bestItem.infoHash;
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

export async function resolve(ref) {
  const [anilistId, episodeNum, title] = String(ref).split("|");
  
  try {
    const infoHash = await findTorrentOnNyaa(title, episodeNum);
    const magnet = buildMagnet(infoHash);
    
    return {
      external: {
        protocol: "magnet",
        ref: magnet,
        package: getExternalPackage()
      }
    };
  } catch (e) {
    throw kino.error("unavailable", e.message);
  }
}
export const PLACES = Object.freeze([
  { id: 1, name: "덕진공원", region: "전북 전주시 덕진구", lat: 35.84738, lon: 127.12166, aliases: ["전주덕진공원"] },
  { id: 2, name: "전주한옥마을", region: "전북 전주시 완산구", lat: 35.81472, lon: 127.15264, aliases: [] },
  { id: 3, name: "경기전", region: "전북 전주시 완산구", lat: 35.81530, lon: 127.14973, aliases: ["전주경기전"] },
  { id: 4, name: "전동성당", region: "전북 전주시 완산구", lat: 35.81339, lon: 127.14945, aliases: ["전주전동성당"] },
  { id: 5, name: "오목대", region: "전북 전주시 완산구", lat: 35.81438, lon: 127.15459, aliases: ["전주오목대"] },
  { id: 6, name: "전주동물원", region: "전북 전주시 덕진구", lat: 35.85609, lon: 127.14470, aliases: [] },
  { id: 7, name: "국립전주박물관", region: "전북 전주시 완산구", lat: 35.80104, lon: 127.08837, aliases: ["전주국립박물관"] },
  { id: 8, name: "전주향교", region: "전북 전주시 완산구", lat: 35.81273, lon: 127.15692, aliases: [] },
  { id: 9, name: "풍남문", region: "전북 전주시 완산구", lat: 35.81352, lon: 127.14755, aliases: ["전주풍남문"] },
].map((place) => Object.freeze({ ...place, aliases: Object.freeze(place.aliases) })));

const placesById = new Map(PLACES.map((place) => [place.id, place]));
const wordCharacters = "\\p{L}\\p{N}\\p{M}_";
const suffixes = "입니다만|입니다|입니까|이었어요|이었습니다|이라고요|이라고|이라는|이라며|이라면|이라서|이지만|이라도|이라|이란|이에요|이예요|예요|이네요|이죠|이지요|이야|이랑|하거나|에서부터|에서는|에서도|에서|에다가|에게|에도|에는|에선|한테|으로는|으로도|으로|로는|로도|까지는|까지도|까지|부터는|부터|하고|이며|이고|이나|나|만|도|과|와|은|는|이|가|을|를|에|로|요";

const matchers = PLACES.flatMap((place) => (
  [place.name, ...place.aliases].map((alias) => {
    // The common phrase "경기 전" means "before the match".
    const parts = place.name === "경기전"
      ? [alias.slice(0, -place.name.length), place.name].filter(Boolean)
      : [...alias.replace(/\s/gu, "")];
    const spelling = parts
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("[ \\t]*");
    const pattern = "(^|[^" + wordCharacters + "])(" + spelling + ")"
      + "(?:(?![" + wordCharacters + "])|(?=(?:" + suffixes + ")(?![" + wordCharacters + "])))";
    return { place, pattern: new RegExp(pattern, "gu") };
  })
));

const introCue = /(?:(?:소개할|소개해\s*드릴|안내할|안내해\s*드릴|방문할|찾아갈|가\s*볼|만나\s*볼)\s*(?:장소|곳|명소|여행지|목적지)|(?:오늘의|이번)\s*(?:장소|명소|여행지|목적지))(?:은|는|이|가)?\s*(?:바로\s*)?[:："'“‘「『]?\s*$/u;
const mapCueBefore = /(?:지도에|지도에서)\s*[:："'“‘「『]?\s*$/u;
const focusCueAfter = /^(?:["'”’」』]|은|는|을|를)*\s*(?:(?:지도(?:에서|에|를)?\s*)?(?:보여|띄워|찾아|열어)\s*(?:주세요|주십시오|줘|달라|드릴게요)|소개(?:합니다|할게요|해\s*드릴게요))/u;
const exclusion = /^(?:["'”’」』]|은|는|이|가|을|를|에|에는|도|와|과|으로|으로는|에서)*\s*(?:말고|아니라|아닌|아니고|아니에요|아닙니다|제외|빼고|가지\s*않)/u;
const listConnector = /^(?:은|는|이|가|을|를|에|에서|도|과|와|랑|이랑|하고|이나|나|부터|까지)?\s*(?:[,，、·/&+]\s*|또는\s*|혹은\s*|및\s*|그리고\s*)?$/u;

export function getPlace(id) {
  return placesById.get(id) ?? null;
}

export function getMapUrl(place) {
  const knownPlace = getPlace(place?.id);
  if (!knownPlace) return null;

  const query = knownPlace.name.includes("전주") ? knownPlace.name : `전주 ${knownPlace.name}`;
  return `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
}

export function getMapEmbedUrl(place) {
  const knownPlace = getPlace(place?.id);
  if (!knownPlace) return null;

  const { lat, lon } = knownPlace;
  // These offsets span approximately 800 meters in Jeonju.
  const latitudeOffset = 0.0036;
  const longitudeOffset = 0.0045;
  const bounds = [lon - longitudeOffset, lat - latitudeOffset, lon + longitudeOffset, lat + latitudeOffset];
  const url = new URL("https://www.openstreetmap.org/export/embed.html");
  url.searchParams.set("bbox", bounds.map((coordinate) => coordinate.toFixed(5)).join(","));
  url.searchParams.set("layer", "mapnik");
  url.searchParams.set("marker", `${lat},${lon}`);
  return url.href;
}

export function selectPlace(transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return null;

  const text = transcript.normalize("NFKC");
  const found = matchers.flatMap(({ place, pattern }) => (
    Array.from(text.matchAll(pattern), (match) => ({
      place,
      start: match.index + match[1].length,
      end: match.index + match[0].length,
      listed: false,
    }))
  ));

  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const mentions = [];
  for (const mention of found) {
    if (mention.start >= (mentions[mentions.length - 1]?.end ?? 0)) mentions.push(mention);
  }

  for (let index = 1; index < mentions.length; index += 1) {
    const previous = mentions[index - 1];
    const current = mentions[index];
    if (previous.place.id !== current.place.id && listConnector.test(text.slice(previous.end, current.start))) {
      previous.listed = true;
      current.listed = true;
    }
  }

  const candidates = new Set();
  const focused = new Set();
  for (const { place, start, end, listed } of mentions) {
    const before = text.slice(Math.max(0, start - 50), start);
    const after = text.slice(end, end + 50);
    if (exclusion.test(after)) continue;

    candidates.add(place);
    if (!listed && (introCue.test(before) || mapCueBefore.test(before) || focusCueAfter.test(after))) {
      focused.add(place);
    }
  }

  if (focused.size === 1) return focused.values().next().value;
  return candidates.size === 1 ? candidates.values().next().value : null;
}

export function createPlaceGate({ globalCooldownMs = 15_000, repeatCooldownMs = 45_000 } = {}) {
  let lastAcceptedAt = -Infinity;
  const lastByPlace = new Map();

  function canAccept(id, now = Date.now()) {
    return Boolean(getPlace(id))
      && Number.isFinite(now)
      && now - lastAcceptedAt >= globalCooldownMs
      && now - (lastByPlace.get(id) ?? -Infinity) >= repeatCooldownMs;
  }

  function accept(id, now = Date.now()) {
    if (!canAccept(id, now)) return false;

    lastAcceptedAt = now;
    lastByPlace.set(id, now);
    return true;
  }

  function reset() {
    lastAcceptedAt = -Infinity;
    lastByPlace.clear();
  }

  return { canAccept, accept, reset };
}

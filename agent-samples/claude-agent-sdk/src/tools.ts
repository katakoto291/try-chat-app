// エージェントに持たせる「道具」の中身。
// 3 つのサンプル（Vercel AI SDK / Claude Agent SDK / Strands）で同じ動きをする関数を用意しています。
// 本物の天気 API の代わりに、都市名から決まる「それっぽい」ダミーの値を返します（API キー不要）。

const CITIES: Record<string, { timeZone: string; aliases: string[] }> = {
  東京: { timeZone: "Asia/Tokyo", aliases: ["tokyo"] },
  大阪: { timeZone: "Asia/Tokyo", aliases: ["osaka"] },
  札幌: { timeZone: "Asia/Tokyo", aliases: ["sapporo"] },
  ニューヨーク: { timeZone: "America/New_York", aliases: ["new york", "nyc"] },
  ロンドン: { timeZone: "Europe/London", aliases: ["london"] },
  パリ: { timeZone: "Europe/Paris", aliases: ["paris"] },
  シドニー: { timeZone: "Australia/Sydney", aliases: ["sydney"] },
};

function findCity(name: string) {
  const key = name.trim().toLowerCase();
  for (const [city, info] of Object.entries(CITIES)) {
    if (city === name.trim() || info.aliases.includes(key)) return { city, ...info };
  }
  return undefined;
}

const supported = Object.keys(CITIES).join("、");

/** 天気（ダミー）。同じ都市・同じ日なら同じ結果になる */
export function getWeather(cityName: string) {
  const found = findCity(cityName);
  if (!found) return { error: `「${cityName}」は未対応です。対応都市: ${supported}` };

  const seed = [...`${found.city}${new Date().toDateString()}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  const conditions = ["晴れ", "くもり", "雨", "晴れ時々くもり", "雪"];
  return {
    city: found.city,
    condition: conditions[seed % conditions.length],
    temperatureC: (seed % 30) - 2,
    note: "これは学習用のダミーデータです",
  };
}

/** 現地時刻。こちらは本物の時計を使う */
export function getLocalTime(cityName: string) {
  const found = findCity(cityName);
  if (!found) return { error: `「${cityName}」は未対応です。対応都市: ${supported}` };

  const localTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: found.timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());
  return { city: found.city, timeZone: found.timeZone, localTime };
}

export const INSTRUCTIONS = `あなたは旅行の相談にのるアシスタントです。
天気や現地時刻を聞かれたら、必ずツールで調べてから答えてください。
答えは日本語で、短く分かりやすくまとめてください。`;

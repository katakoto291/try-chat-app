// エージェント自身が持つツールの中身（天気）。旅行アシスタントのサンプルと同じダミーデータです。
// 観光スポットの情報はこのエージェントは持っておらず、MCP サーバーに聞きに行きます（src/mcp.ts）。

const CITIES: Record<string, string[]> = {
  東京: ["tokyo"],
  大阪: ["osaka"],
  ロンドン: ["london"],
};

/** 天気（ダミー）。同じ都市・同じ日なら同じ結果になる */
export function getWeather(cityName: string) {
  const key = cityName.trim().toLowerCase();
  const city = Object.keys(CITIES).find((c) => c === cityName.trim() || CITIES[c]!.includes(key));
  if (!city) return { error: `「${cityName}」は未対応です。対応都市: ${Object.keys(CITIES).join("、")}` };

  const seed = [...`${city}${new Date().toDateString()}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  const conditions = ["晴れ", "くもり", "雨", "晴れ時々くもり", "雨"];
  return {
    city,
    condition: conditions[seed % conditions.length],
    temperatureC: (seed % 25) + 2,
    note: "これは学習用のダミーデータです",
  };
}

export const INSTRUCTIONS = `あなたは日帰り観光のプランを作るアシスタントです。
次の順番で考えてください。
1. get_weather でその日の天気を調べる
2. search_spots で観光スポットを探す（雨なら indoorOnly: true で屋内のスポットを優先する）
3. 気になるスポットは get_spot_details で営業時間と滞在時間を確かめる
4. 移動のしやすさも考えて、時間つきの回る順番を作る
答えは日本語で、見出しと箇条書きを使って短くまとめてください。
ツールで確かめていない営業時間などは書かないでください。`;

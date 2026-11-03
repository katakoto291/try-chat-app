// MCP サーバーが提供する「データ」と「処理」。普通の関数とデータで、MCP のことは何も知りません。
// 本物の観光情報 API の代わりに、学習用の小さな固定データを使います。

export type Category = "観光" | "グルメ" | "自然" | "買い物";

export interface Spot {
  id: string;
  city: string;
  name: string;
  category: Category;
  area: string;
  hours: string;
  stayMinutes: number; // 目安の滞在時間
  indoor: boolean; // 雨の日でも楽しめるか
  description: string;
}

export const SPOTS: Spot[] = [
  { id: "tokyo-asakusa", city: "東京", name: "浅草寺", category: "観光", area: "浅草", hours: "6:00-17:00", stayMinutes: 90, indoor: false, description: "東京最古の寺。雷門と仲見世通りの食べ歩きが定番。" },
  { id: "tokyo-teamlab", city: "東京", name: "デジタルアート美術館", category: "観光", area: "豊洲", hours: "9:00-21:00", stayMinutes: 120, indoor: true, description: "光と映像の没入型ミュージアム。雨の日にもおすすめ。" },
  { id: "tokyo-tsukiji", city: "東京", name: "築地場外市場", category: "グルメ", area: "築地", hours: "5:00-14:00", stayMinutes: 90, indoor: false, description: "海鮮丼や卵焼きなど、朝から食べ歩きができる市場。" },
  { id: "tokyo-shinjuku-gyoen", city: "東京", name: "新宿御苑", category: "自然", area: "新宿", hours: "9:00-17:30", stayMinutes: 90, indoor: false, description: "都心の広い庭園。桜と紅葉の名所。" },
  { id: "tokyo-ginza", city: "東京", name: "銀座のデパート巡り", category: "買い物", area: "銀座", hours: "10:00-20:00", stayMinutes: 120, indoor: true, description: "老舗デパートと路面店が集まる買い物の街。" },
  { id: "osaka-dotonbori", city: "大阪", name: "道頓堀", category: "グルメ", area: "なんば", hours: "終日", stayMinutes: 120, indoor: false, description: "たこ焼き・お好み焼きの食べ歩きとグリコの看板。" },
  { id: "osaka-castle", city: "大阪", name: "大阪城", category: "観光", area: "大阪城公園", hours: "9:00-17:00", stayMinutes: 90, indoor: false, description: "天守閣は博物館になっていて、展望台から街を一望できる。" },
  { id: "osaka-kaiyukan", city: "大阪", name: "海遊館", category: "観光", area: "天保山", hours: "10:00-20:00", stayMinutes: 150, indoor: true, description: "ジンベエザメが泳ぐ大きな水族館。雨の日の定番。" },
  { id: "london-museum", city: "ロンドン", name: "大英博物館", category: "観光", area: "ブルームズベリー", hours: "10:00-17:00", stayMinutes: 180, indoor: true, description: "入館無料の世界的な博物館。ロゼッタ・ストーンが有名。" },
  { id: "london-borough", city: "ロンドン", name: "バラ・マーケット", category: "グルメ", area: "サザーク", hours: "10:00-17:00", stayMinutes: 60, indoor: false, description: "ロンドン最古級の食品市場。屋台の食べ歩きが楽しい。" },
  { id: "london-hydepark", city: "ロンドン", name: "ハイド・パーク", category: "自然", area: "ウェストミンスター", hours: "5:00-24:00", stayMinutes: 60, indoor: false, description: "中心部の巨大な公園。ボート遊びもできる。" },
];

export const CITIES = [...new Set(SPOTS.map((s) => s.city))];

export function searchSpots(city: string, category?: Category, indoorOnly = false) {
  return SPOTS.filter(
    (s) => s.city === city && (!category || s.category === category) && (!indoorOnly || s.indoor),
  ).map(({ id, name, category, area, stayMinutes, indoor }) => ({ id, name, category, area, stayMinutes, indoor }));
}

export function getSpot(id: string) {
  return SPOTS.find((s) => s.id === id);
}

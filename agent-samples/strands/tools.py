"""エージェントに持たせる「道具」の中身（TypeScript 版の src/tools.ts と同じ動き）。

本物の天気 API の代わりに、都市名から決まる「それっぽい」ダミーの値を返します（API キー不要）。
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

CITIES: dict[str, dict] = {
    "東京": {"time_zone": "Asia/Tokyo", "aliases": ["tokyo"]},
    "大阪": {"time_zone": "Asia/Tokyo", "aliases": ["osaka"]},
    "札幌": {"time_zone": "Asia/Tokyo", "aliases": ["sapporo"]},
    "ニューヨーク": {"time_zone": "America/New_York", "aliases": ["new york", "nyc"]},
    "ロンドン": {"time_zone": "Europe/London", "aliases": ["london"]},
    "パリ": {"time_zone": "Europe/Paris", "aliases": ["paris"]},
    "シドニー": {"time_zone": "Australia/Sydney", "aliases": ["sydney"]},
}
SUPPORTED = "、".join(CITIES)

INSTRUCTIONS = """あなたは旅行の相談にのるアシスタントです。
天気や現地時刻を聞かれたら、必ずツールで調べてから答えてください。
答えは日本語で、短く分かりやすくまとめてください。"""


def _find_city(name: str) -> tuple[str, dict] | None:
    key = name.strip().lower()
    for city, info in CITIES.items():
        if city == name.strip() or key in info["aliases"]:
            return city, info
    return None


def get_weather(city_name: str) -> dict:
    """天気（ダミー）。同じ都市・同じ日なら同じ結果になる。"""
    found = _find_city(city_name)
    if not found:
        return {"error": f"「{city_name}」は未対応です。対応都市: {SUPPORTED}"}
    city, _ = found
    seed = sum(ord(c) for c in f"{city}{date.today().isoformat()}")
    conditions = ["晴れ", "くもり", "雨", "晴れ時々くもり", "雪"]
    return {
        "city": city,
        "condition": conditions[seed % len(conditions)],
        "temperatureC": (seed % 30) - 2,
        "note": "これは学習用のダミーデータです",
    }


def get_local_time(city_name: str) -> dict:
    """現地時刻。こちらは本物の時計を使う。"""
    found = _find_city(city_name)
    if not found:
        return {"error": f"「{city_name}」は未対応です。対応都市: {SUPPORTED}"}
    city, info = found
    now = datetime.now(ZoneInfo(info["time_zone"]))
    return {"city": city, "timeZone": info["time_zone"], "localTime": now.strftime("%Y/%m/%d %H:%M")}

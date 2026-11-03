"""サーバーを立てずに、ターミナルからエージェントを 1 回だけ動かす。

  python cli.py "東京とロンドンの天気と時刻を教えて"
"""

import asyncio
import json
import sys

import agent


async def main() -> None:
    prompt = " ".join(sys.argv[1:]) or "東京とロンドンの、今の天気と現地時刻を教えて"
    print(f"> {prompt}  (provider={agent.PROVIDER}, model={agent.MODEL_ID})\n")
    async for event in agent.stream(prompt):
        if event["type"] == "text":
            print(event["text"], end="", flush=True)
        elif event["type"] == "tool_call":
            print(f"\n[ツール呼び出し] {event['name']} {json.dumps(event['input'], ensure_ascii=False)}")
    print()


if __name__ == "__main__":
    asyncio.run(main())

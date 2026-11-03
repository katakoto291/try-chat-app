// サーバーを立てずに、ターミナルからエージェントを 1 回だけ動かす。
//   npm run ask -- "大阪で日帰り観光するプランを作って"

import { modelId, provider, streamAgent } from "./agent.js";

const prompt = process.argv.slice(2).join(" ") || "東京で日帰り観光するプランを作って";
console.log(`> ${prompt}  (provider=${provider}, model=${modelId})\n`);

for await (const ev of streamAgent(prompt)) {
  if (ev.type === "text") process.stdout.write(ev.text);
  else if (ev.type === "tool_call") console.log(`\n[ツール呼び出し] ${ev.name} ${JSON.stringify(ev.input)}`);
}
console.log();

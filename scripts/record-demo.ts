/**
 * サンプル動画（デモ動画）を自動で撮影するスクリプト。
 *
 *   npm run demo:video                                   # 用意済みのシナリオをすべて撮影（モックモード）
 *   npm run demo:video -- --scenario call-mcp            # 用意済みのシナリオを 1 つだけ撮影
 *   npm run demo:video -- -q "Rust で素数判定を書いて" --topology call --protocol a2a --name rust-a2a
 *                                                        # 任意の質問・設定で撮影
 *   npm run demo:video -- --file scripts/demo-scenarios.example.json
 *                                                        # JSON に書いたシナリオで撮影（複数の質問の会話も可）
 *   npm run demo:video -- --mp4                          # webm に加えて mp4 も作る（ffmpeg が必要）
 *   npm run demo:video -- --real                         # .env の ANTHROPIC_API_KEY で本物の Claude を使う
 *   npm run demo:video -- --url http://localhost:5173    # 起動済みのアプリを撮る
 *
 * 流れ: フロントエンドをビルド → 撮影用のサーバーを別ポートで起動 → Playwright のブラウザで
 * 設定の切り替え・質問の入力・トレースの確認を自動操作し、その様子を録画する。
 * 動画は videos/<name>.webm に保存される。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

type Topology = "call" | "handoff" | "pubsub";
type Protocol = "direct" | "mcp" | "a2a";
type Transport = "sse" | "agui";

/** 1 本の動画の内容 */
export interface Scenario {
  /** ファイル名（videos/<name>.webm） */
  name: string;
  /** 連携パターン（既定: call） */
  topology?: Topology;
  /** プロトコル。topology が call のときだけ使う（既定: direct） */
  protocol?: Protocol;
  /** 画面との通信（既定: sse） */
  transport?: Transport;
  /** 送る質問。複数書くと、同じ会話の中で順番に送る */
  questions: string[];
  /** 返答のあとにトレース（通信ログなど）を見せるか（既定: true） */
  showTrace?: boolean;
  /** 1 文字ずつ入力する間隔 ms（既定: 45。0 なら一瞬で入力） */
  typingDelay?: number;
}

const LABELS = {
  topology: { call: "呼び出し", handoff: "ハンドオフ", pubsub: "Pub/Sub" },
  protocol: { direct: "直接呼び出し", mcp: "MCP", a2a: "A2A" },
  transport: { sse: "独自 SSE", agui: "AG-UI" },
} as const;

const PRESETS: Scenario[] = [
  { name: "call-direct", topology: "call", protocol: "direct", questions: ["量子コンピュータについて、初心者向けに調べてわかりやすく説明して"] },
  { name: "call-mcp", topology: "call", protocol: "mcp", questions: ["Python で FizzBuzz を書くコードを作って"] },
  { name: "call-a2a", topology: "call", protocol: "a2a", questions: ["TypeScript で配列を重複なくマージする関数を実装して"] },
  { name: "handoff", topology: "handoff", questions: ["量子コンピュータについて、初心者向けに調べてわかりやすく説明して"] },
  { name: "pubsub-agui", topology: "pubsub", transport: "agui", questions: ["Python で FizzBuzz を書くコードを作って"] },
];

// ---- 引数 ----
const args = process.argv.slice(2);
const flag = (...names: string[]) => names.some((n) => args.includes(n));
/** 同じオプションを複数回書いたときは全部返す（-q を何度も書けるように） */
const options = (...names: string[]) => args.flatMap((a, i) => (names.includes(a) && i + 1 < args.length ? [args[i + 1]] : []));
const option = (...names: string[]) => options(...names)[0];

const HELP = `使い方: npm run demo:video -- [オプション]

■ 何を撮るか（どれも指定しなければ、用意済みのシナリオをすべて撮影）
  -q, --question <文>  任意の質問で撮影する。何度も書くと、同じ会話の中で順番に送る
      --topology <id>  連携パターン: call | handoff | pubsub（既定: call）
      --protocol <id>  プロトコル: direct | mcp | a2a（既定: direct。call のときだけ）
      --transport <id> 画面との通信: sse | agui（既定: sse）
      --name <名前>    保存するファイル名（既定: custom）
      --no-trace       返答のあとにトレースを見せない
      --typing <ms>    1 文字ずつ入力する間隔（既定: 45。0 なら一瞬で入力）
  --file <json>        JSON に書いたシナリオで撮影する（書き方は scripts/demo-scenarios.example.json）
  --scenario <名前>    用意済みのシナリオから選ぶ（カンマ区切りで複数可）
                       ${PRESETS.map((s) => s.name).join(", ")}

■ 撮り方
  --out <dir>          保存先（既定: videos）
  --mp4                mp4 にも変換する（ffmpeg が必要）
  --real               .env の API キーで本物の Claude を使う（既定はモックモード）
  --url <url>          起動済みのアプリを撮る（ビルドとサーバー起動を省略）
  --port <port>        撮影用サーバーのポート（既定: 3100）
  --width <px> / --height <px>   画面サイズ（既定: 1440 x 900）
  --headed             ブラウザを表示して撮影する`;

function pick<T extends string>(kind: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${kind} に "${value}" は使えません（${allowed.join(" | ")}）`);
  }
  return value as T;
}

function validate(s: Scenario, where: string): Scenario {
  if (!s || typeof s.name !== "string" || !s.name) throw new Error(`${where}: name を指定してください`);
  if (!/^[\w.-]+$/.test(s.name)) throw new Error(`${where}: name に使えるのは英数字と - _ . だけです（${s.name}）`);
  if (!Array.isArray(s.questions) || s.questions.length === 0 || s.questions.some((q) => typeof q !== "string" || !q.trim())) {
    throw new Error(`${where}: questions に 1 つ以上の質問を書いてください`);
  }
  pick(`${where}: topology`, s.topology, ["call", "handoff", "pubsub"]);
  pick(`${where}: protocol`, s.protocol, ["direct", "mcp", "a2a"]);
  pick(`${where}: transport`, s.transport, ["sse", "agui"]);
  return s;
}

function loadScenarios(): Scenario[] {
  const list: Scenario[] = [];

  const questions = options("-q", "--question");
  if (questions.length > 0) {
    list.push(
      validate(
        {
          name: option("--name") ?? "custom",
          topology: pick("--topology", option("--topology"), ["call", "handoff", "pubsub"]),
          protocol: pick("--protocol", option("--protocol"), ["direct", "mcp", "a2a"]),
          transport: pick("--transport", option("--transport"), ["sse", "agui"]),
          questions,
          showTrace: !flag("--no-trace"),
          typingDelay: option("--typing") !== undefined ? Number(option("--typing")) : undefined,
        },
        "コマンドライン",
      ),
    );
  }

  for (const file of options("--file")) {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    const items = Array.isArray(json) ? json : [json];
    items.forEach((s, i) => list.push(validate(s as Scenario, `${file} の ${i + 1} 番目`)));
  }

  const preset = option("--scenario");
  if (preset) {
    const names = preset.split(",");
    const unknown = names.filter((n) => n !== "all" && !PRESETS.some((p) => p.name === n));
    if (unknown.length) throw new Error(`シナリオが見つかりません: ${unknown.join(", ")}（${PRESETS.map((p) => p.name).join(", ")}）`);
    list.push(...(names.includes("all") ? PRESETS : PRESETS.filter((p) => names.includes(p.name))));
  }

  return list.length > 0 ? list : PRESETS;
}

// ---- 撮影用サーバー ----
async function startServer(port: number, real: boolean): Promise<{ url: string; server?: ChildProcess }> {
  const external = option("--url");
  if (external) return { url: external };

  console.log("フロントエンドをビルドしています…");
  const build = spawnSync("npx", ["vite", "build", "--logLevel", "warn"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) throw new Error("ビルドに失敗しました");

  // npx や tsx コマンドを挟むと、終了時に孫プロセス（サーバー本体）が残ってしまうので、node を直接起動する
  const server = spawn(
    process.execPath,
    ["--import", "tsx", ...(real ? ["--env-file-if-exists=.env"] : []), "server/index.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        // 撮影中にログイン画面が出ないよう、合言葉は無効にする（.env より環境変数が優先される）
        APP_PASSWORD: "",
        LLM_MODE: real ? "anthropic" : "mock",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("サーバーの起動に失敗しました");
    try {
      if ((await fetch(`${url}/api/config`)).ok) return { url, server };
    } catch {
      // まだ起動中
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  server.kill();
  throw new Error("サーバーが起動しませんでした");
}

// ---- 1 本分の操作 ----
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function play(page: Page, url: string, s: Scenario, real: boolean) {
  const topology = s.topology ?? "call";
  await page.goto(url);
  await page.getByRole("heading", { name: "何を手伝いましょうか？" }).waitFor();
  await pause(page, 1200);

  // 設定を切り替える
  const choose = async (group: string, name: string) => {
    const radio = page.getByRole("radiogroup", { name: group }).getByRole("radio", { name, exact: true });
    await radio.hover();
    await pause(page, 300);
    await radio.click();
    await pause(page, 700);
  };
  await choose("連携パターン", LABELS.topology[topology]);
  if (topology === "call") await choose("プロトコル", LABELS.protocol[s.protocol ?? "direct"]);
  await choose("画面との通信", LABELS.transport[s.transport ?? "sse"]);

  const input = page.getByPlaceholder(/メッセージを入力/);
  const stop = page.getByRole("button", { name: "停止" });
  for (const question of s.questions) {
    // 質問を入力して送信する
    await input.click();
    const delay = s.typingDelay ?? 45;
    if (delay > 0) await input.pressSequentially(question, { delay });
    else await input.fill(question);
    await pause(page, 600);
    await input.press("Enter");

    // 返答が終わるまで待つ（停止ボタンが消えたら完了）
    await stop.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await stop.waitFor({ state: "detached", timeout: real ? 300_000 : 60_000 });
    await pause(page, 1500);
  }

  if (s.showTrace === false) return;

  // トレースの中身を見せる
  const trace = page.locator("aside.trace");
  const body = trace.locator(".trace-body");
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  await pause(page, 1500);
  await body.evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(page, 800);

  await trace.getByRole("tab", { name: /通信ログ/ }).click();
  await pause(page, 1200);
  // 中身のある最初の通信を開いて、実際のメッセージ（JSON など）を見せる
  const firstWire = trace.locator("button.wire-head:not([disabled])").first();
  if (await firstWire.count()) {
    await firstWire.click();
    await pause(page, 2000);
  }

  if (s.transport === "agui") {
    await trace.getByRole("tab", { name: /AG-UI イベント/ }).click();
    await pause(page, 2000);
  }

  await trace.getByRole("tab", { name: "呼び出しツリー" }).click();
  await pause(page, 1500);
}

// ---- メイン ----
async function main() {
  if (flag("-h", "--help")) {
    console.log(HELP);
    return;
  }
  const scenarios = loadScenarios();
  const outDir = path.resolve(option("--out") ?? "videos");
  const port = Number(option("--port") ?? 3100);
  const size = { width: Number(option("--width") ?? 1440), height: Number(option("--height") ?? 900) };
  const real = flag("--real");
  const wantMp4 = flag("--mp4");
  const hasFfmpeg = wantMp4 && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (wantMp4 && !hasFfmpeg) console.warn("ffmpeg が見つからないため、mp4 への変換は省略します。");

  mkdirSync(outDir, { recursive: true });
  const { url, server } = await startServer(port, real);
  let failed = 0;
  try {
    const browser = await chromium.launch({ headless: !flag("--headed") });
    try {
      for (const s of scenarios) {
        console.log(`撮影中: ${s.name}`);
        const tmpDir = path.join(outDir, `.tmp-${s.name}`);
        const context = await browser.newContext({ viewport: size, recordVideo: { dir: tmpDir, size }, locale: "ja-JP" });
        const page = await context.newPage();
        try {
          await play(page, url, s, real);
        } catch (err) {
          failed++;
          console.error(`  ✗ 失敗しました: ${err instanceof Error ? err.message : err}`);
        } finally {
          const video = page.video();
          await context.close(); // close したときに動画ファイルが書き出される
          if (video) {
            const webm = path.join(outDir, `${s.name}.webm`);
            rmSync(webm, { force: true });
            renameSync(await video.path(), webm);
            console.log(`  → ${path.relative(process.cwd(), webm)}`);
            if (hasFfmpeg) {
              const mp4 = webm.replace(/\.webm$/, ".mp4");
              const r = spawnSync(
                "ffmpeg",
                ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
                { stdio: "inherit" },
              );
              if (r.status === 0) console.log(`  → ${path.relative(process.cwd(), mp4)}`);
            }
          }
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server?.kill();
  }
  console.log(`完了しました（${scenarios.length - failed}/${scenarios.length} 本成功）。保存先: ${path.relative(process.cwd(), outDir) || "."}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

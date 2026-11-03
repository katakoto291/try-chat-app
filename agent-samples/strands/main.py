"""コンテナの入り口。HOSTING で、どの実行基盤向けのサーバーを起動するかを選びます。

  HOSTING=agentcore（既定） … app_agentcore.py（ポート 8080）
  HOSTING=foundry           … app_foundry.py  （ポート 8088）

同じイメージをそのまま両方に持っていけるように、1 つのイメージに両方を入れています。
"""

import os

hosting = os.environ.get("HOSTING", "agentcore").lower()

if hosting == "foundry":
    from app_foundry import app

    app.run()
elif hosting == "agentcore":
    from app_agentcore import app

    app.run(port=int(os.environ.get("PORT", "8080")))
else:
    raise SystemExit(f"HOSTING は agentcore か foundry にしてください（今: {hosting}）")

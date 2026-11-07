# 地震モニター PWA

GitHub Pages + Google Apps Script (GAS) で動かす、個人利用向けの地震モニターです。

## 構成

- GitHub Pages: 画面、地図、1秒ごとのカウントダウン、PWA
- Google Apps Script: 気象庁 XML の取得・解析・キャッシュと JSONP API
- Cloudflare Workers + Durable Objects（任意）: P2P地震情報 WebSocket の受信・中継、Web Push の送信
- Service Worker: アプリ終了中のプッシュ通知を受信・表示

## 重要な注意

このアプリは防災情報の補助表示です。**気象庁の緊急地震速報や公式の予報・警報ではありません。**
P波・S波の到達時刻は、震源・発震時刻・平均速度を使った単純化した目安です。実際の地盤、地殻構造、震源深さ、観測遅延などを十分に反映しません。安全判断や避難判断は、必ず気象庁・自治体・公式防災情報を優先してください。

ブラウザー画面は1秒ごとに更新できますが、気象庁の情報自体が毎秒更新されるわけではありません。GASへの問い合わせ間隔は初期値15秒です。GASの実行回数・外部取得回数を抑えるため、必要以上に短くしないでください。

PWAを閉じている間、画面側の定期取得・カウントダウンは動作しません。Cloudflare Workerを別途デプロイし、Web Pushを登録した場合は、サーバー側でP2P地震情報を受信してiPadへ通知できます。ただし、Cloudflare・P2P地震情報・Appleのプッシュ配信・通信環境の影響を受けるため、常時監視や即時配信は保証されません。P2P地震情報の緊急地震速報データは無保証であり、公式の緊急地震速報やJ-Alertの代替にはなりません。

## ファイル

- index.html: 画面構造
- styles.css: レスポンシブ・iPad向けスタイル
- app.js: 地図、GAS接続、現在地、波の推定、通知
- manifest.webmanifest: PWA設定
- sw.js: アプリシェルのキャッシュとWeb Push受信
- cloudflare/: Cloudflare Worker / Durable Objectのバックエンドとセットアップ手順
- icons/icon.svg: アプリアイコン

## 1. GitHub Pagesを有効化

1. GitHubでこのリポジトリを開く
2. Settings → Pages
3. Build and deployment の Source を Deploy from a branch にする
4. Branch を main、フォルダーを /(root) にして Save
5. 公開URL: https://a09848281-prog.github.io/earthquake-monitor-pwa/

反映まで少し時間がかかる場合があります。

## 2. GASを用意

GAS側のWebアプリは、GETリクエストに対して JSONP を返すAPIにしてください。ブラウザーからGitHub Pagesをまたいで読み取るため、通常のJSON fetchではなくJSONPを使います。

### 呼び出し形式

```
https://script.google.com/macros/s/＜デプロイID＞/exec?callback=earthquakeMonitorCallback&action=latest
```

アプリは設定画面に登録されたURLに callback、action=latest、キャッシュ回避用の _= を付けて呼び出します。

GASは callback 名を英数字・アンダースコア・ドットなどの安全な形式に制限し、次のようなJavaScriptレスポンスを返してください。

```js
earthquakeMonitorCallback({
  "ok": true,
  "serverTime": "2026-11-07T12:00:00.000Z",
  "updatedAt": "2026-11-07T11:59:50.000Z",
  "events": []
});
```

### イベントデータ形式

events は新しい地震情報から順に配列にしてください。各プロパティは、値が不明なら null または空文字にします。

```json
{
  "id": "一意な報道資料ID",
  "title": "地震情報（例）",
  "publishedAt": "2026-11-07T11:59:50+09:00",
  "originTime": "2026-11-07T11:59:20+09:00",
  "hypocenter": "震央地名",
  "latitude": 35.68,
  "longitude": 139.76,
  "depthKm": 50,
  "magnitude": 4.2,
  "maxIntensity": "3",
  "kind": "earthquake",
  "url": "https://www.jma.go.jp/"
}
```

必須に近い項目は id、title、publishedAt です。波の到達目安には originTime、latitude、longitude が必要です。震源座標が取得できない情報は、一覧には表示しても波の計算・地図への震源表示は行いません。

推奨フィールド:
- ok: API成功時 true
- serverTime: GASが応答を作った時刻 (ISO 8601)
- updatedAt: 元データを最後に取得した時刻
- events: 地震情報配列
- source: JMA などデータ元の表示名

GASはJMAのXMLの階層・要素名を正しく解析し、震源地名・震源座標・深さ・マグニチュード・最大震度を別々に取得してください。XML内の最初の Name 要素を無条件で震源地名に使わないでください。

## 3. アプリにGAS URLを登録

1. GitHub Pagesのアプリを開く
2. 設定を開く
3. GAS WebアプリのURLを貼り付けて保存
4. 接続テストまたは更新を押す
5. 必要なら現在地を取得を押して位置情報を許可
6. 通知を使う場合は設定で通知を有効化し、ブラウザーの許可を与える

GASはWebアプリAPIとして呼び出せる公開設定が必要です。URLには秘密情報やAPIキーを含めないでください。

## 4. Cloudflareのリアルタイム受信・バックグラウンド通知（任意）

1. `cloudflare/README.md` の手順でCloudflare Workerをデプロイします。
2. VAPID鍵は `cloudflare/generate-vapid.html` で端末内生成し、Cloudflare Secretに登録します。
3. WorkerのURLをコピーします。
4. アプリの設定画面でCloudflare Worker URLを登録します。

Cloudflareの設定が完了していない場合でも、従来のGAS経由の地震情報表示は利用できます。

## 5. iPadにインストール

1. iPadのSafariでGitHub Pages URLを開く
2. 共有ボタン → ホーム画面に追加
3. 追加したアイコンから起動

位置情報はユーザーがボタンを押したときだけ取得します。位置情報はこのブラウザー内の端末ストレージに保存され、GASには送信しません。

## 通知・更新仕様

- 画面内の経過時間、波の位置、到達目安: 1秒ごとに更新
- GASからの地震情報取得: 初期値15秒ごと（設定で変更可）
- 新着地震情報: GAS更新時の画面内通知
- P波/S波の到達目安: 設定した残り時間の範囲に入ったときに画面内通知
- Cloudflare Workerを設定した場合: P2P地震情報の地震情報・緊急地震速報をWeb Pushで通知（アプリ終了中も受信可能。ただし配信保証なし）

## 地図について

地図表示には Leaflet と OpenStreetMap のタイルを利用します。地図上に OpenStreetMap の帰属表示を残してください。タイル提供元には利用ポリシー・容量制限があります。大量アクセスやタイルの一括取得は行わないでください。

外部APIの応答がない場合は、画面に接続エラーを表示します。架空の地震情報を実データのように表示するデモ動作は行いません。

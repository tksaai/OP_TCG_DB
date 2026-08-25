# OP-TCG DB

ONE PIECE カードゲームのカード検索・デッキ構築・コレクション管理を、スマホ 1 台で
完結させるための PWA です。ホーム画面に追加するとアプリのように起動でき、
カードデータは端末内に保存されるのでオフラインでも動きます。

**アプリ:** https://tksaai.github.io/OP_TCG_DB/
**使い方:** アプリ内の各画面に沿って操作できます（Cards / Decks / NEW / Settings）

> 非公式の個人開発ツールです。株式会社バンダイとは関係ありません。

## できること

- カード検索（名前・効果テキスト・カード番号）と、色/コスト/パワー/属性/種別/
  レアリティ/ブロック/シリーズなどでの絞り込み
- デッキ構築（リーダー選択 → タップで枚数指定 → 50 枚）、共有 URL・画像・JSON での書き出し
- デッキ表の画像からのデッキ取り込み（解析は端末内で完結）
- 欲しいカードリスト、所持カード管理、パックの開封記録
- デッキに対する不足カードの一覧と共有
- NEW タブ：公式データ収録前の新カード（仮DB）

## リポジトリ構成

| パス | 内容 |
| --- | --- |
| `index.html` / `app.js` / `style.css` | アプリ本体 |
| `admin.html` | データ整備用（GitHub token の登録）。通常利用では開きません |
| `image-import.js` / `image-import-worker.js` | デッキ画像の解析（Worker で実行） |
| `service-worker.js` | オフライン対応。カードデータ=network-first、シェル=SWR、画像=cache-first |
| `cards.json` | カードデータ（公式サイト由来） |
| `provisional-cards.json` | 仮DB（公式データ収録前の新カード） |
| `image-manifest.json` | カード番号 → 画像パスの対応表 |
| `card-features.json` | デッキ画像解析に使う画像特徴量 |
| `CardsWebP/` | カード画像（WebP） |

### 画像について

配信・コミットするのは **WebP のみ** です（`CardsWebP/`）。ダウンロードした元画像は
`Cards/` に置かれますが、これは変換のための中間ファイルなのでコミットしません
（`.gitignore` 済み）。元画像を持たない環境でも、`CardsWebP/` からマニフェストを
再生成できます。

## 自動更新

| ワークフロー | 実行時刻 | 内容 |
| --- | --- | --- |
| `sync-new-release.yml` | 毎日 18:00 JST | 公式サイトから新弾のカードと画像を取得し、WebP 変換・マニフェスト・特徴量を再生成 |
| `sync-provisional-cards.yml` | 毎日 18:20 JST | 秋葉原カードショップから仮DBのカードを取得 |

どちらも手動実行（workflow_dispatch）に対応しています。`dry_run` を指定すると
ファイルを書き換えずに確認だけできます。

## ローカルでの実行

Service Worker を使うため `file://` では動きません。簡易サーバで開いてください。

```sh
python -m http.server 8000
# → http://localhost:8000/
```

## テスト

```sh
node scripts/test-data-integrity.mjs
```

カードデータと画像マニフェストの整合、画像がすべて WebP を指していること、
ネイティブ `confirm/prompt` を使っていないことなどを確認します。同期ワークフローの
先頭でも実行されます。

## スクリプト

| スクリプト | 内容 |
| --- | --- |
| `sync-new-release.mjs` | 新弾の同期一式（カード → 画像 → WebP → マニフェスト → 特徴量） |
| `sync-official-cards.mjs` / `sync-official-images.mjs` | 公式サイトからのカード・画像取得 |
| `sync-akihabara-cards.mjs` / `sync-provisional-images.mjs` | 仮DBの取得 |
| `convert-images-to-webp.py` | WebP 変換（`--prune` で元画像が消えた WebP を掃除） |
| `build-image-manifest.mjs` | `image-manifest.json` の生成 |
| `build-card-features.py` | デッキ画像解析用の特徴量生成 |
| `update-provisional-image-paths.mjs` | 仮DBの画像参照を WebP に差し替え |

## データ整備（フリガナ）

カード名のフリガナは `furigana-overrides.json` で補正できます。編集をリポジトリへ
保存するには GitHub の fine-grained token が必要です。

1. `admin.html` を開き、token を登録します（必要な権限は Contents の Read and write のみ）
2. アプリの設定で「カード詳細にフリガナ編集欄を表示」をオンにします
3. カードを拡大表示して修正し、Save を押します

token はブラウザの localStorage に保存されます。同一オリジンの JavaScript から
読める状態になるため、共用端末では使わず、有効期限を短くしてください。

## ライセンス / 利用について

このリポジトリのコードは個人利用のために公開しているもので、再利用のための
ライセンスは設定していません（著作権は放棄していません）。カード名・カード画像・
カードテキストの権利は株式会社バンダイに帰属します。

# Discord VC 議事録Bot

VCを録音し、**録音終了後**に日本語の文字起こしと議事録を作るBotです。

- 録音: Discordの参加者ごとにWAVで保存。話者名・おおよその発言時刻を付与。
- 文字起こし: **PC内のfaster-whisper**。音声をAIサービスへアップロードしません。
- 議事録: **ChatGPTにログインしたCodex CLI**。サブスクの利用枠を使います。
- 出力: 概要、議題、決定事項、担当者・期限付きToDo、未決事項、次回確認事項。
- 完成した `minutes.md` と `transcript.md` を指定したテキストチャンネルに添付します。送信先未設定の場合は録音したVCのチャットに添付します。

**OpenAI APIキーは不要です。** APIキー認証は拒否し、Codexの子プロセスにもAPIキーを渡しません。ChatGPT/Codexの利用上限に達した場合は保存済み音声・文字起こしから後で再実行できます。無制限には使えません。

## このPCでの準備状況

Node.js依存関係、Python仮想環境、Whisper `small` モデルを準備済みです。CodexのChatGPTログインと、日本語の合成音声 → ローカル文字起こし → 議事録保存の一連の処理を確認しています。録音・生成・送信先設定の自動テストを用意しています。DiscordのBotトークンとサーバー設定はまだ必要です。実際のDiscord VCでの録音は未検証です。

## 最初に行う設定

1. [Discord Developer Portal](https://discord.com/developers/applications) でApplicationを作成し、Botページでトークンを取得します。
2. General InformationのApplication IDを控えます。
3. Discord設定 → 詳細設定 → 開発者モードをONにして、対象サーバーを右クリック → サーバーIDをコピーします。
4. このフォルダの `.env` に次の3つを設定します。トークンはチャットに貼らず、ローカルファイルに入力してください。

```dotenv
DISCORD_TOKEN=Botのトークン
DISCORD_CLIENT_ID=ApplicationのID
DISCORD_GUILD_ID=対象サーバーのID
```

5. OAuth2のURL Generatorで `bot` と `applications.commands` を選び、Botを対象サーバーに招待します。Bot Permissionsは以下を設定します。

- View Channels（チャンネルを見る）
- Connect（接続）
- Send Messages（メッセージを送信）
- Attach Files（ファイルを添付）

録音対象VCで「チャンネルを見る・接続・メッセージ送信」を許可してください。議事録の送信先（未設定ならVC）では「チャンネルを見る・メッセージ送信・ファイル添付」を許可してください。Message ContentやServer Membersなどの特権Intentは使いません。Stageチャンネル・DMは対象外です。

```sh
cd /Users/fukawanozomi/discord-ai-vc-record
npm run doctor
npm run register
npm start
```

`register` は指定サーバーに `/record` を登録します。初回とコマンド定義変更時に実行してください。`npm start` を実行しているPCがスリープしたり、プロセスを終了したりすると録音できません。

## 使い方

1. 通常のVCに入り、参加者に録音、文字起こし、文章のCodexへの送信、議事録の投稿先を説明して同意を確認します。
2. Discordで `/record start consent:True title:定例会` を実行します。
3. 会話を終えたら `/record stop`。VCからBotが退出し、文字起こしと議事録の作成を開始します。
4. 完成後、設定した送信先（未設定なら録音したVCのチャット）にMarkdownファイルが届きます。

| コマンド | 動作 |
| --- | --- |
| `/record start` | 自分がいるVCを録音。`consent` は必須 |
| `/record stop` | 録音終了・議事録作成 |
| `/record status` | 録音・処理状況と受信済みデータ量 |
| `/record retry id:録音ID` | 保存済み音声から再処理 |

開始できるのは「サーバー管理」権限を持つ人です。他の人にも許可する場合、`.env` の `ALLOWED_ROLE_ID` に許可するロールIDを設定します。停止・再処理は録音開始者またはサーバー管理者が実行できます。

1サーバーにつき録音または議事録作成を1件ずつ処理します。途中参加時にも録音中の通知をVCチャットへ投稿します。個別の同意を自動収集する機能はないため、途中参加者への説明も主催者が行ってください。

## 専用チャンネルへ送信する

Discordで通常のテキストチャンネル（例: `#議事録`）を作り、開発者モードでそのチャンネルを右クリック → チャンネルIDをコピーします。`.env` に設定してBotを再起動してください。

```dotenv
DISCORD_OUTPUT_CHANNEL_ID=コピーしたチャンネルID
```

- 議事録と文字起こしの両方、および処理状況・エラー通知をそのチャンネルに送ります。
- 空欄なら、これまでどおり録音したVCのチャットに送ります。
- 録音開始・途中参加時の通知はVCのチャットに投稿し、結果の送信先も表示します。
- 同じサーバーの通常のテキストチャンネルに対応します。カテゴリ、スレッド、フォーラム、他サーバーは指定できません。
- Botに送信先の「チャンネルを見る・メッセージ送信・ファイル添付」を許可してください。録音開始者もそのチャンネルを閲覧できる必要があります。
- 送信先は録音開始時に保存します。後から設定を変更しても `/record retry` は当初の送信先を使います。以前の録音は元のVCに送ります。
- 送信先の削除・権限不足の場合、別のチャンネルに自動で切り替えません。送信先と権限を確認してください。

スラッシュコマンドの再登録は不要です。Botの再起動後、新しく開始する録音から反映されます。専用チャンネルを閲覧できる人に議事録・文字起こしが共有されるため、参加者にはその送信先を案内してください。

## 保存・再実行

```text
data/
  models/                 ローカル文字起こしモデル
  録音ID/
    session.json          メタデータ・話者・状態
    audio/                話者ごと、最大60秒ずつのWAV
    transcripts/          分割音声の文字起こしキャッシュ
    transcript.md         発言時刻・話者付きの文字起こし
    minutes.md            議事録
```

録音はメモリに溜めずにディスクへ書き込みます。発話単位と60秒上限で分割するため、大きなファイルを丸ごと処理しません。無音の区間は録音ストリームに含まれない場合があります。時刻は受信時刻に基づく目安で、単語単位の正確なタイムスタンプではありません。

Bot終了時は録音を確定保存します。再起動時に中断した状態を回復するので `/record retry` で処理できます。強制終了・電源断では最後の未確定チャンクを失う可能性があります。完成済みチャンクは保存されます。

Discordへ投稿せず、ローカルで再実行する場合:

```sh
npm run process -- 録音ID
```

成功済みの文字起こしはキャッシュを再利用します。議事録は再生成します。長い会議の文字起こしは部分要約を作ってから統合します。文字起こしはCPUで処理するため、PC性能と音声量によっては会議時間以上かかる場合があります。

録音・文字起こし・議事録は**自動削除しません**。不要になった `data/録音ID/` を処理終了後に削除してください。モデルを残すには `data/models/` は削除しません。Discordに添付したファイルは別途削除が必要です。

## 設定

| 環境変数 | 初期値 | 説明 |
| --- | --- | --- |
| `DISCORD_OUTPUT_CHANNEL_ID` | 空欄 | 議事録・文字起こしの送信先テキストチャンネルID。空欄ならVC |
| `WHISPER_MODEL` | `small` | 日本語対応。精度優先なら `medium`、速度優先なら `base` |
| `TRANSCRIBE_LANGUAGE` | `ja` | 文字起こし言語 |
| `PYTHON_PATH` | `./.venv/bin/python` | faster-whisperを入れたPython |
| `CODEX_PATH` | `codex` | Codex CLIの実行ファイル |
| `CODEX_MODEL` | 空欄 | Codexの標準モデル。必要なら利用可能なモデル名を指定 |
| `CODEX_TIMEOUT_SECONDS` | `600` | 要約1回のタイムアウト |
| `DATA_DIR` | `./data` | 録音・モデルの保存先 |
| `MAX_RECORDING_MINUTES` | `120` | 録音時間上限。到達時に自動停止 |
| `MAX_RECORDING_MB` | `2048` | 1会議の全話者合計音声量上限 |
| `ALLOWED_ROLE_ID` | 空欄 | 開始を許可する追加ロール |

モデルを変更したら `npm run setup-model` で事前にダウンロードできます。初回のみモデル取得のためネット接続が必要です。文字起こし自体はローカルです。議事録生成では文字起こしと話者名・会議情報がCodexへ送信されます。

## 別のPCにセットアップする場合

必要: Node.js **22.12以降**、Python **3.10以降**、ChatGPTで利用できるCodex CLI（この実装では **0.142.5以降**）。FFmpegを別途インストールする必要はありません。

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
# Codex CLIが未導入の場合
npm install -g @openai/codex
codex login
npm run setup-model
npm run doctor
# .env のDiscord設定を済ませてから
npm run register
npm start
```

Codexは `--ignore-user-config`、読み取り専用サンドボックス、ChatGPT認証固定で起動します。シェル、プラグイン、アプリ、ブラウザ等を無効化し、一時作業フォルダで議事録本文の生成だけを行います。

## 困ったとき

- **コマンドが出ない**: `DISCORD_CLIENT_ID` とサーバーIDを確認し、`npm run register` を実行。`applications.commands` スコープで招待しているか確認。
- **録音データが0 KiB**: 人が発話しているか、BotがVCに接続しているか、サーバー側でスピーカーミュートされていないか確認。DAVE接続・ネットワーク不具合も考えられます。
- **Botが接続できない**: チャンネル権限、満員のVC、UDPを遮断するネットワークを確認。
- **Codexで失敗**: `codex login status`、`codex login`、サブスクの利用上限を確認。上限回復後に `/record retry`。
- **文字起こしで失敗**: `npm run doctor` と `npm run setup-model` を実行。モデル保存先の空き容量とネット接続を確認。
- **Bot終了後に「録音中」と残る**: Botを一度起動すると中断状態に回復します。録音IDを指定して再処理してください。

Discordの音声受信は公式に安定動作が保証された機能ではありません。DAVE関連修正の入った `@discordjs/voice 0.19.2` を使っていますが、初回は実際のVCで短い会話の録音を確認してください。

## 開発・検証

```sh
npm test
npm run doctor
```

自動テストでは、Opus→PCM→WAV、複数話者、分割・容量上限、再実行、Codex利用失敗時の保存、長文分割、認証方式・操作権限・プロセス排他を確認します。Discord接続や実際のChatGPT利用は自動テストから実行しません。

仕様確認に使用した資料:

- [Codexの非対話実行](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codexの認証](https://learn.chatgpt.com/docs/auth)
- [discord.js voice](https://discord.js.org/docs/packages/voice/0.19.2)
- [voice 0.19.2の修正](https://github.com/discordjs/discord.js/releases/tag/%40discordjs%2Fvoice%400.19.2)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)

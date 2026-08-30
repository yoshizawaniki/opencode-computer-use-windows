# OpenCodeをCodex Desktop / Claude Cowork級の実操作エージェントへ拡張する

## 目的

このタスクの目的は、OpenCodeを単なるCLI / コーディングエージェントではなく、**実際にブラウザやWindowsアプリを見て・操作して・操作後の状態まで検証できるComputer Use対応エージェント**へ拡張することです。

最終的にはOpenCode Goの安価なモデル群を中心に使いながら、

- API非対応のWebサイトを実際に操作する
- Chromeやログイン済みWebサービスを扱う
- Windowsアプリを起動・操作する
- 開発中アプリを実際に触って挙動確認する
- GUI上の不具合を見つけてコード修正する
- 修正後に再度GUIを操作して検証する
- 人間が実演した操作を再利用可能なWorkflow / Skillへ変換する
- 複数の開発・調査・商品販売・収益化プロジェクトで同じComputer Use基盤を共通利用する

ことを実現します。

**MCP対応、Custom Toolを作れること、Skills / Subagent等の既存OpenCode機能そのものを再実装する必要はありません。**

今回実装するのは、それらを利用してOpenCodeに不足している具体的な

**「目・手・GUI検証能力」**

です。

Codex Desktop / Claude Coworkの名称やUIをコピーすることが目的ではありません。

目的は、

**OpenCodeから同等以上の実作業ができること**

です。

---

# 最重要原則

## 1. 実装の正本を一時workspaceに置かない

Codex / C2C / ChatGPT等が生成する一時workspace、Temp、conversation work directory、検証用ディレクトリを実装本体の正本として使用してはいけません。

最初にOpenCodeの現在の構成を調査し、**永続的な正式プロジェクトroot**を確定してください。

正式実装はそのrootで管理します。

一時workspaceで許可するものは、

- 調査
- patch staging
- fixture
- 一時artifact
- 一時テストデータ

までです。

OpenCodeが実際に利用するPlugin / Custom Tool / Skillは、正式プロジェクトrootから適切にinstall / link / deployしてください。

正式rootを確定する前に大量実装を開始しないでください。

既存OpenCode環境を直接巨大な実験場にしないでください。

---

## 2. まず共通基盤を作る

個別のBrowser clickやDesktop clickより先に、最低限以下の共通基盤を設計・実装してください。

- Session管理
- Permission Broker
- Secret Broker
- Artifact管理
- 共通Tool Result形式
- 操作前後のVerification
- Resource ownership
- Error / timeout / cancellation
- redaction
- logging policy

特に**外部作用を伴うすべてのmutation経路はPermission Brokerを必ず通す構造**にしてください。

あとからPermission Brokerを被せる設計は禁止します。

---

## 3. 操作成功とタスク成功を分ける

Computer Use全体の基本フローを、

**観測 → 対象特定 → Permission確認 → 操作 → 再観測 → 検証**

としてください。

「click APIが成功した」
「PowerShellがexit code 0だった」
「CDP commandが正常終了した」

だけでは成功扱いにしてはいけません。

操作後に実際の状態を再取得し、意図した状態へ変化したことを確認してください。

---

## 4. 理想経路が失敗した場合、安易な迂回策へ逃げない

本来採用すべき経路が動かない場合、

1. 理想経路と受入条件を再確認
2. どの地点で失敗しているか特定
3. コード / 設定 / 権限 / 依存 / OS / Browser / 外部サービスを切り分け
4. 根本障壁を解消
5. 本来の経路で再検証

してください。

別方式で「似た結果」を出しただけで完成扱いにしてはいけません。

どうしても技術的に不可能な場合のみ、

- 本来の理想形
- 障壁
- 代替実装
- 理想形との差
- 未検証範囲

を明示してください。

---

# 技術選択の優先順位

操作・観測は可能な限り次の優先順位を採用してください。

1. 既存API / MCP
2. Browser DOM / Accessibility / Playwright / CDP
3. Windows UI Automation
4. Screenshot / Vision / OCR
5. 座標ベースmouse / keyboard

一種類の技術へ固執しないでください。

既存ライブラリ、Playwright、Chrome DevTools Protocol、Windows UI Automation、PowerShell、Python等を積極的に利用してください。

独自実装が不要な部分を無駄に再実装しないでください。

---

# Phase構成

全20機能を無秩序に同時実装しないでください。

以下のPhase順で進め、**各PhaseのAcceptance Gateを通過してから次へ進んでください。**

---

# Phase 0 — Architecture / Foundation

最初に以下を実施してください。

1. 現在のOpenCode環境を調査
2. Plugin / Custom Tools / Skills / AGENTS.md /既存設定を確認
3. 既存機能との重複を整理
4. 正式な永続プロジェクトrootを決定
5. backup作成
6. Architecture決定
7. Module責務を分離
8. Session / Permission / Secret / Artifact / Verification基盤を実装
9. 最小ToolをOpenCodeから実際にロード
10. 再起動後も再現することを確認

### Phase 0 Acceptance Gate

最低限、

- 実装本体が一時workspaceに依存していない
- OpenCodeが正式配置からPlugin / Toolを読み込める
- Permission Brokerを通らないmutation経路が存在しない
- Secretが通常logやTool resultへ漏れない
- Artifact保存場所が明確
- backupからrollback可能
- OpenCode再起動後も動作

を確認してください。

Phase 0を通過する前に大量のBrowser / Desktop操作を追加しないでください。

---

# Phase 1 — Browser Core

## Browser Use

Playwright / CDP等を利用し、OpenCode専用の隔離Browser環境を最初に完成させてください。

最低限、

- BrowserSession作成
- BrowserSession終了
- tab一覧
- tab ID
- tab切替
- new tab
- close tab
- URLを開く
- 戻る
- 進む
- reload
- snapshot
- accessibility tree
- DOM要素探索
- click
- double click
- input
- select
- hover
- scroll
- key press
- wait
- popup / dialog対応
- upload
- download

を扱えるようにしてください。

Browser process / profile / port / session / tabの所有者を明確にし、**BrowserSessionを唯一の管理主体**にしてください。

raw CDP接続を各Toolが勝手に生成する構造にしないでください。

毎回巨大なHTML全文をLLMへ返さないでください。

可能なら、

`[12] button "保存"`

のような簡潔なelement reference方式を採用してください。

参照IDはsnapshot更新時のstale状態を明示的に扱ってください。

### Phase 1 Acceptance Gate

localhost fixture等で、

- Browser起動
- tab作成
- snapshot
- 要素特定
- click
- input
- select
- scroll
- wait
- tab操作
- upload
- download
- dialog
- 操作後の再観測

をOpenCode自身から実行し、実状態まで検証してください。

---

# Phase 2 — Browser Developer Tools / Verification

## Browser Developer Tools

最低限、

- Console log
- Console error
- Network request
- Network failure
- response status
- DOM query
- computed style
- JavaScript evaluate
- basic performance情報

を提供してください。

JavaScript evaluateは任意コード実行の危険性を考慮し、用途・権限境界を設計してください。

### Cookie / Storageの扱い

重要：

**認証済みsessionを利用できることと、認証情報の生値をLLMへ公開できることは分けてください。**

Cookie / localStorage / sessionStorageについて、LLMが必要としないsecret valueを返してはいけません。

原則、

- cookie name
- domain
- expiry
- secure
- httpOnly
- storage key metadata

等は必要に応じて取得可能。

しかし、

- session token
- auth token
- password
- secret cookie value
- credential
- API key

の生値はLLM context / log / normal Tool resultへ返さない設計としてください。

---

## Visual Verification

最低限、

- Screenshot before / after
- region capture
- visual diff
- change detection
- OCR / text確認
- 指定UI存在確認
- 指定UI非存在確認
- 操作前後assert
- DOM / UI state assert
- file / log / process等の補助確認

を提供してください。

保存ボタンであれば、

click
→ 再snapshot / screenshot
→ 「保存しました」確認
→ 必要なら実データやfile / API / log確認
→ 成功

まで行ってください。

### Phase 2 Acceptance Gate

簡単なWebアプリを使用し、

コード変更
→ Webアプリ起動
→ Browser操作
→ Console / Network / UI確認
→ 問題発見
→ コード修正
→ Browser再操作
→ 再検証

の自律ループを実際に成立させてください。

---

# Phase 3 — Windows Semantic Automation

## Windows UI Automation

Windows UI Automation等を利用し、可能なアプリではGUIを構造として扱えるようにしてください。

最低限、

- Window一覧
- active Window
- UI tree
- role / control type
- name
- AutomationId
- text metadata
- bounds
- state
- enabled
- focused
- offscreen
- element検索
- Button invoke
- focus
- textbox value取得
- textbox value設定
- checkbox
- select / combobox
- element出現待機
- Window / control状態取得

を実装してください。

password elementやsecret fieldの値はLLMへ返さないでください。

---

# Phase 4 — Windows Visual / Input Fallback

UI Automationで操作できない場合のfallbackとしてDesktop Computer Useを実装してください。

最低限、

- Windows一覧取得
- アクティブWindow取得
- Window focus
- アプリ起動
- Window / アプリ終了
- 全画面Screenshot
- 指定Window Screenshot
- 指定領域Screenshot
- click
- double click
- right click
- drag
- move
- scroll
- keyboard入力
- key press
- hotkey
- wait

を提供してください。

座標操作は最終fallbackです。

画面取得
→ 判断
→ 操作
→ 再取得
→ 検証

を必ず行ってください。

### App Context / Appshot相当

最低限、

- active app名
- Window title
- Screenshot
- Window bounds
- UI Automation text metadata
- process情報

を一括取得可能にしてください。

特定アプリ名やHWND等からcontext取得する方式も用意してください。

### Phase 3/4 Acceptance Gate

メモ帳等を使い、

1. アプリ起動
2. Window認識
3. UI Automation tree取得
4. textbox特定
5. text入力
6. dialog操作
7. Screenshot
8. 入力結果確認
9. Window終了

までOpenCode自身から実行してください。

さらにOpenCode、Windows設定、または安全な実アプリで、

- Window切替
- UI探索
- Scroll
- text取得
- UIA失敗時のvisual fallback

も確認してください。

---

# Phase 5 — Existing Chrome Bridge

OpenCode専用Browserとは別に、必要な場合だけユーザーが普段使用しているChrome環境を利用できる機構を設計してください。

目的は、

- 既存login
- 開いているtab
- 既存session
- Chrome extension
- 認証済みWebサービス

を再利用することです。

ただし、

**既存認証情報を利用できることと、credentialの生値をLLMへ見せることは別です。**

最低限、

- explicit attach
- tab一覧
- tab選択
- snapshot
- click / input等
- detach

を安全に提供してください。

既存Chrome profileを破損しないこと。

既存Chromeへのattachは自動で行わず、Permission Broker上で専用Browserより高い権限レベルとして扱ってください。

Cookie / session token / credentialの生値をLLMへ返さないでください。

### Phase 5 Acceptance Gate

専用テストprofileと普段使いChromeを明確に分離し、

- attach
- tab discovery
- 操作
- detach
- profile非破損
- secret非露出

を確認してください。

---

# Phase 6 — Record & Replay / Skills

## Record & Replay

ユーザーのGUI操作を再利用可能なWorkflowへ変換してください。

単純な座標記録だけにはしないでください。

可能な場合、

- Window
- HWND
- UI Automation element
- DOM element
- accessibility role / name
- URL
- action
- input parameter
- wait condition
- expected state

を意味的操作へ変換してください。

最低限、

- record
- preview
- edit
- parameter化
- replay
- verification
- Skill化

を設計・実装してください。

secret input valueはWorkflowファイルへ平文保存しないでください。

---

# OpenCode Skills

実装したTool群の上に、少なくとも以下を作成してください。

- `computer-use`
- `browser-use`
- `windows-app-testing`
- `web-app-testing`
- `visual-verification`
- `record-and-replay`

Skillは単なるTool一覧にしないでください。

各Skill内で、

**観測 → 操作 → 再観測 → 検証**

を必須ルールとしてください。

Plugin / Custom ToolsとSkillの配布・登録責務を分離し、OpenCodeが正式に扱える構造へ配置してください。

---

# Phase 7 — Operational Features

以下はCore Computer Use完成後に実装してください。

## Task Persistence / Resume

最低限、

- task ID
- 現在phase
- 最後に確認できた状態
- pending項目
- 使用resource
- BrowserSession
- Window情報
- artifact参照
- verification state

を保存し、中断後に安全に再開できるようにしてください。

入力本文やsecretを不用意に永続化しないでください。

---

## Scheduled Tasks

Windows Task Scheduler等の既存機構を利用して構いません。

定期処理から起動されても、

- Permission
- Secret
- Resource lock
- Task state
- logging

のルールは通常実行と同じものを適用してください。

---

## Notifications

長時間taskについて、

- 完了
- 失敗
- 承認待ち
- 中断
- 要対応

等をWindows通知等で通知できるようにしてください。

---

## Download Manager

Browser downloadについて、

- 開始
- 完了待機
- 保存path
- MIME / type
- file size
- hash
- integrity
- 必要なら内容確認

まで管理してください。

---

## Clipboard

Clipboard read / writeを提供してください。

Clipboardはsecret混入可能性が高いため、Permission / Secret Brokerを必ず通してください。

デフォルトでは全文をLLMへ返さず、

- type
- length
- hash

等のmetadataだけを返す方式も検討してください。

---

## Artifact Preview

最低限、

- HTML
- Markdown
- PDF
- Image
- Spreadsheet

を確認できるpreview方法を用意してください。

OpenCode本体UIの大規模改造が必要なら、独立Viewerとして構いません。

---

# Phase 8 — Advanced Runtime

以下はCore完成を阻害しない独立レイヤーとして扱ってください。

## Browser Annotation

ScreenshotやBrowser画面について、ユーザーが指定した対象をOpenCodeへ渡せる仕組み。

可能ならDOM / UI elementと関連付けてください。

---

## Remote Control

OpenCode sessionを別端末から、

- task状態確認
- current screenshot確認
- continue
- stop
- approve
- deny

できる仕組みを検討・実装してください。

HTTP / WebSocket等で構いません。

Remote Controlは外部公開面を増やすため、認証・network exposure・Permissionを独立設計してください。

---

## Background Desktop

ユーザーが通常利用しているDesktopとは別の環境でComputer Useを実行できる構成を比較してください。

候補：

- 別Windows session
- VM
- RDP
- Windows Sandbox
- その他隔離環境

Windows Virtual Desktopだけで要件を満たさない場合は無理に採用しないでください。

最終的な推奨構成と理由を示してください。

---

## Sandbox

Computer Use agentへPC全体の無制限権限を与えない構成を設計してください。

最低限、

- filesystem
- process
- network
- credentials
- browser profile
- external communication

について権限境界を持たせてください。

可能ならToolレベルではなく、OS / process / container / VM等のより強い境界も検討してください。

---

# Permission Broker

Permission BrokerはPhase 0で必須実装してください。

最低限、

- allow
- ask
- deny

を、

- 操作種別
- Tool
- site / origin
- app / process
- filesystem path
- project
- environment

等で制御できるようにしてください。

特に以下は原則askまたはdeny。

- 外部公開
- 商品公開
- メール送信
- DM送信
- SNS投稿
- 購入
- 課金
- 返金
- Secrets変更
- destructive delete
- 本番データ変更
- credential export
- 既存Chrome attach
- scheduler登録
- remote control公開

Permission Brokerの外からこれらを実行できる経路を残さないでください。

---

# Secret Broker

Secret Brokerは「検討」ではなく必須要件です。

Password / API key / token / cookie / auth header等をLLM contextへ直接公開せずに必要箇所へ利用できる設計としてください。

Windows Credential Manager等の既存安全機構を優先してください。

理想的には、

LLM:
「credential Xを対象password fieldへ入力」

Secret Broker:
credential storeから値取得
→ 対象fieldへ直接入力

LLM:
secret値そのものは見ない

という構造にしてください。

以下は禁止します。

- secretのTool result出力
- secretの通常log出力
- secretのcommit
- secretのWorkflow平文保存
- secretのScreenshot/OCR結果への不用意な露出

---

# 実GUI E2E検証

コード単体テストだけで完成扱いにしないでください。

## Windows

最低限、

1. メモ帳等を起動
2. Windowを認識
3. UI Automationでcontrol確認
4. text入力
5. dialog操作
6. Screenshot
7. 実際の結果を確認

---

## 複雑なWindowsアプリ

OpenCode、設定画面、または安全な実アプリで、

- Window切替
- UI要素探索
- Scroll
- text取得
- visual fallback

を確認してください。

---

## Browser

最低限、

1. Browser起動
2. Pageを開く
3. snapshot
4. click / input
5. select
6. scroll
7. tab操作
8. dialog
9. download / upload
10. Console / Network確認
11. Screenshot
12. 操作後assert

を確認してください。

---

## Chrome Bridge

既存Chromeと専用テストprofileを混同しない方法で、

- attach
- 操作
- detach
- profile非破損
- secret非露出

を確認してください。

---

## 開発ループ

簡単なテストWebアプリまたは既存開発環境で、

コード変更
→ 起動
→ Browser操作
→ UI / Console / Network確認
→ バグ修正
→ 再起動
→ Browser再操作
→ 最終確認

を実際に成立させてください。

---

# 変更管理

- 現在のOpenCode環境を最初に実測
- 変更前backup必須
- 一時workspaceに正本を置かない
- 正式rootをGit管理
- 既存AGENTS.md・プロジェクトルールを遵守
- 既存OpenCode Agent構成を壊さない
- 既存設定の変更は最小限
- 不要な依存追加を避ける
- credentialsをコード・log・commitへ含めない
- 実装成功と実GUI検証を分ける
- 未検証を完成扱いしない
- rollback方法を常に維持する

---

# Architecture上の禁止事項

以下は禁止します。

- 全機能を巨大な単一`index.js`へ集約
- Browser / Windows / Permission / Secret / Workflow責務の混在
- Toolごとに勝手なCDP sessionを生成
- Permission Brokerを迂回するmutation
- secret valueを通常Tool resultへ返す
- 一時workspaceを実装正本として扱う
- fixtureを本番実装扱いする
- 動かなかった技術を説明なく別技術へ置換して完成扱い
- 「APIが成功した」だけで検証完了
- 通常Chrome profileへの無断変更
- 既存OpenCode設定の全面上書き
- 検証用コード・probe・一時profileの放置
- 未実測機能の「完成」報告

---

# 作業の進め方

以下を最後まで繰り返してください。

1. 現状実測
2. Architecture確認
3. Phase内のPLAN
4. 実装
5. 自動テスト
6. 実GUI E2E
7. 問題切り分け
8. 修正
9. 再テスト
10. Acceptance Gate判定
11. Gate通過後のみ次Phase

軽微な実装判断は目的に最も合う方法を自分で選択してください。

ただし、Architecture、正本の場所、Permission / Secret境界、既存OpenCodeへの重大変更は軽微な判断として扱わないでください。

---

# 独立最終監査

最終監査は実装担当の自己申告だけを信用しないでください。

可能なら独立したAgent / Reviewerに以下を実体から再確認させてください。

- 正式プロジェクトroot
- 一時workspace依存がない
- OpenCode Plugin load
- Custom Tool enumeration
- Skill discovery
- OpenCode再起動後の利用
- BrowserSession ownership
- Permission Broker強制
- Secret redaction
- Browser E2E
- Windows UIA E2E
- Desktop fallback E2E
- Chrome Bridge E2E
- Visual Verification
- Record / Replay
- rollback可能性
- temp file / test process / test browser残存
- credentials非露出
- productionへの意図しない外部作用がない

不一致があれば実装担当へ戻し、修正・再検証してください。

---

# 完成条件

Core Computer Useを「完成」と呼べるのは、

**OpenCode自身から実際にBrowser / Windowsアプリを観測・操作し、その操作後の実状態を再取得して、期待状態になったことまで確認できた場合のみ**

です。

Core完成条件には最低限、

- Permission Broker
- Secret Broker
- Browser Core
- Browser verification
- Windows UI Automation
- Desktop fallback
- Screenshot
- Visual verification
- 操作後assert
- OpenCode再起動後の再現性
- 正式な永続配置

を含めてください。

Remote Control、Background Desktop、VM等のAdvanced RuntimeはCore完成とは分離して評価して構いません。

---

# 最終報告

最後に必ず以下を分けて報告してください。

- 実装済み
- 既存OpenCode機能で対応済み
- 実GUIで検証済み
- 自動テストのみ
- 未検証
- 未実装
- Advanced Runtimeとして分離したもの
- Codex / Claude固有で完全再現不能なもの
- 代替実装
- 理想形との差
- 残るセキュリティ上の注意
- 具体的な使い方
- 作成したCustom Tools一覧
- Plugins一覧
- Skills一覧
- Module一覧
- 設定ファイル一覧
- 正式プロジェクトroot
- OpenCodeへのinstall / link方法
- backup場所
- rollback方法
- テスト結果
- E2E結果
- 未確認範囲
- 一時artifact / process / profileのcleanup結果

複数項目については、

- 実装済み
- 既存で対応
- 未実装
- 未検証
- BLOCKED

を明確に分けてください。

---

# 最終目的

今回の目的は特定のデモアプリを作ることでも、Codex DesktopやClaude Coworkの見た目を再現することでもありません。

OpenCode Goのモデルを利用しながら、OpenCodeが

**ファイル・コード・Terminal・Browser・Windows GUI・実アプリ・Webサービスを横断して、自分で作業し、自分で実機確認できる**

汎用Computer Use基盤を完成させることです。

今後、商品販売、AIによる収益化、Webサービス運営、Windowsアプリ開発、調査、自動テスト等の複数プロジェクトで共通利用します。

途中でデモ・fixture・UI制作そのものへ目的をすり替えず、常に

**「OpenCodeの汎用Computer Use能力を、安全かつ再利用可能な正式基盤として完成させる」**

ことを最優先にしてください。
# omp-aidlc-template

[AI-DLC](https://github.com/awslabs/aidlc-workflows)(v2.11.1、Claude Code ハーネス構成)を [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) で動かすためのプロジェクトテンプレートです。

AI-DLC は Claude Code の command hook(`.claude/settings.json`)が動く前提で作られていますが、omp はそれを実行しません。`.omp/extensions/aidlc-bridge.ts` が omp のイベントを `aidlc engine hook <name>` に橋渡しし、AI-DLC のガード・承認記録・監査ログ・自動継続を omp 上で有効にします。

## 前提

- `aidlc` 2.11.1(`curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh`)
- omp 18.x
- AWS 系 MCP を使う場合: `uv` / `uvx`、AWS 認証情報

## 使い方

1. GitHub の **Use this template** で新しいリポジトリを作り、clone する
2. そのディレクトリで `omp` を起動する
3. `/aidlc <作りたいもの>` と入力する(例: `/aidlc express Add a Python CLI that prints hello world`)

承認ゲートや質問は omp の `ask` で表示されます。

## 構成

| パス | 内容 |
|---|---|
| `.claude/`, `aidlc/`, `aidlc.settings.json` | AI-DLC 本体(`aidlc config --harness claude` の出力そのまま) |
| `.omp/extensions/aidlc-bridge.ts` | omp ⇄ AI-DLC ブリッジ |
| `.mcp.json` | context7 / AWS 系 MCP サーバ |

ブリッジは起動時に `.claude/agents/aidlc-*-agent.md` を omp 形式に変換して `.omp/agents/` に生成します(omp は `.claude/agents` を読まないため。gitignore 済み)。

## ブリッジの対応表

| omp イベント | AI-DLC hook |
|---|---|
| `input`(TUI での人間の入力のみ) | `session-start`, `record-human-turn` |
| `tool_call` bash / write / edit / task | `guard-tool-call`, `deliver-stage-rules` |
| `tool_result` write / edit / bash / ask / todo | `write-audit-log`, `run-sensors`, `rebuild-stage-graph`, `record-human-turn`, `sync-workflow-state` |
| `agent_end`(サブエージェント) | `log-subagent` |
| `session_stop` | `continue-workflow` |
| `session_before_compact` / `session_shutdown` | `validate-state` / `session-end` |

Claude Code との差:

- トークン・コスト集計(`fold-usage`)は Claude の transcript が必要なため動きません
- `eval` / `ast_edit` / `xd://` 経由の書き込みは plan approval・review freeze ガードの対象外です
- メインセッションの read / grep / glob はガードを通しません(reviewer の読み取り範囲ガードはサブエージェントのみが対象のため)

## AWS MCP

- `aws login`(リモート環境では `aws login --remote`)の認証情報がそのまま使えます。期限が切れたら再ログインして omp を再起動してください
- `aws login` の認証情報には `botocore[crt]` が必要なため、`.mcp.json` の aws-pricing / aws-serverless に `--with botocore[crt]` を付けています
- `aws-iac` は依存パッケージ `guardpycfn` に linux/arm64 のビルド済みパッケージがなく、arm64 環境では Rust ツールチェーンなしに起動できません

## AI-DLC の更新

`aidlc config` 等で `.claude/` が再生成されても `.omp/` は影響を受けません。hook の入力形式が変わった場合はブリッジの更新が必要になることがあります。

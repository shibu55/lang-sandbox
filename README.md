# LangChain Agent Sandbox

LangChainを使ったAIエージェントの実験・学習用リポジトリです。Azure OpenAIを使用して、様々なエージェントパターンを実装しています。

## 🚀 特徴

- **複数のエージェントパターン** - 基本、グラフベース、関数型など
- **詳細なデバッグ出力** - LLMへのプロンプト、ツール呼び出しを可視化
- **Azure OpenAI対応** - エンタープライズ環境で使用可能
- **TypeScript** - 型安全な開発

## 📋 前提条件

- Node.js 18以上
- Azure OpenAI APIアクセス

## 🔧 セットアップ

### 1. パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env`ファイルを作成し、Azure OpenAIの認証情報を設定：

```bash
cp .env.example .env
```

`.env`ファイルを編集：

```env
AZURE_OPENAI_API_KEY=your-api-key-here
AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4
AZURE_OPENAI_API_VERSION=2024-02-15-preview
```

## 📦 サンプルコード

### basic.ts - 基本的なエージェント

最もシンプルなエージェントの実装。天気情報を取得するツールを使用します。

```bash
npm run basic
```

### real-world.ts - 実用的な天気予報エージェント

会話のメモリ機能を持つ、より実践的なエージェント。以下の機能を含みます：

- システムプロンプト
- 複数のツール（天気取得、ユーザー位置取得）
- 会話メモリ（MemorySaver）

```bash
npm run real
```

### graph.ts - StateGraphエージェント

LangGraphの`StateGraph`を使用した、グラフベースのエージェント。算数計算ツール（add、multiply、divide）を持ちます。

**特徴：**
- ノードベースのフロー制御
- 条件分岐
- ツール呼び出しループ

```bash
npm run graph
```

### functional.ts - 関数型エージェント

`task`と`entrypoint`を使った関数型アプローチのエージェント。`graph.ts`と同じ機能ですが、実装方法が異なります。

**特徴：**
- 関数型のフロー制御
- while文でのループ
- より手続き的なコード

```bash
npm run functional
```

## 🔍 デバッグ機能

すべてのエージェントは詳細なデバッグ情報を出力します：

- **LLMに送信するメッセージ** - システムプロンプト、ユーザー入力、会話履歴
- **ツール呼び出し** - ツール名、引数、実行結果
- **tool_calls** - AIがどのツールを呼び出そうとしているか
- **フロー** - エージェントの実行フロー

### 出力例

```
🤖 エージェント開始

━━━ LLMに送信するメッセージ ━━━
[1] system: You are a helpful assistant...
[2] human: Add 3 and 4.
━━━━━━━━━━━━━━━━━━━━━━━

🔧 ツール呼び出し: add({"a":3,"b":4})
✓ ツール結果: 7

━━━ 最終結果 ━━━
[human]: Add 3 and 4.
[ai]:
  └─ tool_calls: add({"a":3,"b":4})
[tool]: 7
[ai]: 7
━━━━━━━━━━━━━━━━
```

## 🛠️ 開発

### ビルド

```bash
npm run build
```

### 実行（ビルド後）

```bash
npm start
```

## 📚 参考リンク

- [LangChain.js Documentation](https://js.langchain.com/docs/)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
- [Azure OpenAI Service](https://azure.microsoft.com/products/ai-services/openai-service)

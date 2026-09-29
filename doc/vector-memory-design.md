# 可插拔向量记忆 · 设计方案

> 状态：**待评审**，未动工。
> 目标：把知识库节点从「零自由度」改造成「后端可换、模型可换、本地/远程可换」，
> 并把这套模式作为后续所有节点"自由度"的样板。

## 0. 一句话方案

在 Rust 运行时新增两层 trait（`EmbeddingProvider` / `VectorStore`），
用 **2 个 adapter 覆盖你选的全部 3 类形态**，配置分「全局默认 + 节点覆盖」两级，
**FTS5 永久保留为兜底**（向量不可用时自动降级，绝不报错）。

---

## 1. 现状（已核实，非推测）

### 1.1 两套记忆系统，互不连通

| | Rust 运行时（Flow 节点走的） | Python 后端（Flow 碰不到） |
|---|---|---|
| 检索 | SQLite **FTS5 关键词** + `bm25()` | Chroma + FAISS `IndexFlatL2` + BM25 混合 |
| 向量 | **无** | 有 |
| Embedding | **无** | 4 家云 API（google/openai/glm/dashscope） |
| 部署 | —— | **仅本地** `persist_directory`，无 `HttpClient` |
| 桥 | `tauriBridge.ts` 只暴露 `http_request`/`fs_read_text`/`fs_write_text`/`fs_list_dir` | 另一进程 |

### 1.2 Rust 侧既有资产（可直接复用，不用从零建）

- **`native_memory.rs`**：Markdown 为持久真相 + SQLite FTS5 可重建索引。
  已有 `search()` / `search_for_workspace()` / `list_all()`
- **`/v1/memory`** 路由已存在：`GET`（列表/检索）、`POST`（写入）、`DELETE`（清空）
- **写入工具已存在**：`remember` tool（append + search，模型可调用）
- **读取工具已存在**：`memory_search` / `memory_get`（只读）
- **配置结构已存在**：`MemoryConfig { enabled, backend }`，
  `MemoryBackend` 枚举当前只有 `Native | Off` —— **这就是扩展点**
- **依赖已就位**：`reqwest 0.13.1`（rustls + json）→ 云 API 调用零新增依赖；
  `rusqlite 0.40.2`（bundled）→ 向量索引可复用同一 SQLite

### 1.3 前端既有的「自由度」机制（重要）

`FieldDef.optionsFrom: 'providers' | 'configured-providers' | 'models'`
+ `dependsOn` —— LLM 节点已用它在**运行时拉取真实的 provider / model 列表**做下拉。
**这就是节点级配置覆盖的现成范式**，知识库节点直接沿用，不需要发明新机制。

---

## 2. 关键设计决策

### 决策 1：用 2 个 adapter 覆盖 3 类形态（省一半工作量）

你选了「本地模型 / 云 API / 自建兼容端点」三类。核实后的结论：

> **Ollama、LM Studio、vLLM、Xinference、硅基流动、DeepSeek、智谱、阿里 DashScope
> 全都提供 OpenAI 兼容的 `/v1/embeddings`。**

所以：

| 你说的形态 | 实际实现 | 数量 |
|---|---|---|
| 云 API | `OpenAiCompatEmbedding`（base_url 指向云厂商） | **1 个 adapter** |
| 自建/兼容端点 | `OpenAiCompatEmbedding`（base_url 指向本机端口） | ↑ 同一个 |
| 本地模型（零依赖内置） | 需 `fastembed` / `candle` + ONNX/权重下载 | 另需 1 个（重） |

**→ 建议分两步**：先做 `OpenAiCompatEmbedding`，它立刻让你能用 Ollama 跑本地模型
（`base_url = http://127.0.0.1:11434/v1`），**零新增 Rust 依赖**；
真正"内置模型、装完即用不用装 Ollama"作为可选的第二阶段。

> ⚠️ 需要你确认：**"本地模型"你指的是"能连本机模型服务"（Ollama 等，我推荐先用这个），
> 还是"应用内置模型、用户什么都不用装"？** 后者要引入 ONNX Runtime + 模型权重，
> 安装包体积和编译时间都会显著增加。

### 决策 2：FTS5 永久保留为兜底，而不是被替换

向量索引是**叠加层**，不是替代品：

```
查询 → 若向量可用：向量检索 + FTS5 检索 → 融合排序（RRF）
     → 若向量不可用：纯 FTS5（当前行为，不报错）
```

理由：
- 向量模型没配好 / key 过期 / 网络断了 → 知识库**仍然能用**，只是退化成关键词检索
- 符合现有设计哲学（`native_memory.rs` 明确写「SQLite 只是可重建索引」）
- Markdown 仍是唯一持久真相 → 向量索引删了能重建，数据不会丢

### 决策 3：配置两级 —— 全局默认 + 节点覆盖

```toml
# config.toml —— 全局默认（配一次）
[memory]
enabled = true
backend = "native"              # 现有字段，扩展枚举
vector  = "auto"                # auto | sqlite-vec | qdrant | chroma-http | off

[memory.embedding]
provider = "openai-compat"      # openai-compat | none
base_url = "http://127.0.0.1:11434/v1"
model    = "nomic-embed-text"
dim      = 768
api_key  = ""                   # Ollama 不需要，云厂商必填

[memory.vector]
store      = "sqlite-vec"       # sqlite-vec | qdrant | chroma-http
url        = ""                 # 远程时填，如 http://localhost:6333
collection = "hakus-memory"
```

知识库节点上新增字段（用现成的 `optionsFrom` 机制，**下拉选项来自运行时真实可用列表**）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `backend` | select（`optionsFrom: 'vector-stores'`） | 空=跟随全局 |
| `embedding` | select（`optionsFrom: 'embedding-providers'`） | 空=跟随全局 |
| `topK` | number | 返回条数 |
| `minScore` | number | 相似度阈值 |
| `hybrid` | switch | 是否与 FTS5 融合排序 |

新增端点 `GET /v1/memory/backends` → 返回**实际已配置且可用**的 store / embedding 列表，
前端下拉直接消费。这样节点上看到的选项永远是真实可用的，不会出现"选了却没配"。

### 决策 4：远程库走 HTTP adapter —— 顺带打通 Chroma

`HttpVectorStore` 实现一套 Qdrant REST 语义，同时：
- **Qdrant 自建 / Qdrant Cloud** → 直接可用
- **你现有的 Python Chroma** → Chroma 有 REST API，
  只要它以 server 模式起（`chroma run`），Rust 侧就能直接连上，
  **不必写专门的跨语言桥**

这是最省力地复用你已有 Python 资产的方式：不嵌 Python，走网络协议。

---

## 3. 架构

```
┌─────────────────────────────────────────────────────┐
│ 知识库节点 (registry.ts)                              │
│   backend / embedding / topK / minScore / hybrid     │
└───────────────────────┬─────────────────────────────┘
                        │ POST /v1/memory/search
┌───────────────────────▼─────────────────────────────┐
│ runtime_api.rs  — 检索编排层                          │
│   解析节点覆盖 → 合并全局默认 → 融合排序 (RRF)         │
└───────┬─────────────────────────────┬───────────────┘
        │                             │
┌───────▼──────────┐        ┌─────────▼───────────────┐
│ EmbeddingProvider│        │ VectorStore             │
│ (trait)          │        │ (trait)                 │
├──────────────────┤        ├─────────────────────────┤
│ OpenAiCompat     │        │ FtsStore      (已有,兜底)│
│ Local (fastembed)│        │ SqliteVecStore (本地)    │
│ None             │        │ HttpVectorStore(远程)    │
└──────────────────┘        └─────────────────────────┘
```

### Trait 签名（草案）

```rust
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    fn id(&self) -> &str;
    fn dim(&self) -> Option<usize>;
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

/// 一个文档 = 一段文本 + 元数据 + 可选向量
pub struct VectorDoc {
    pub id: String,
    pub text: String,
    pub vector: Option<Vec<f32>>,
    pub workspace_id: Option<String>,
    pub source_path: Option<PathBuf>,
}

pub struct VectorHit {
    pub id: String,
    pub score: f32,
    pub text: String,
    pub source_path: Option<PathBuf>,
}

#[async_trait]
pub trait VectorStore: Send + Sync {
    fn id(&self) -> &str;
    async fn upsert(&self, docs: &[VectorDoc]) -> Result<usize>;
    async fn search(
        &self,
        query: &[f32],
        limit: usize,
        workspace_id: Option<&str>,
    ) -> Result<Vec<VectorHit>>;
    async fn delete(&self, ids: &[String]) -> Result<usize>;
    /// 索引是否与 Markdown 真相同步；false 时由调用方触发重建
    fn is_stale(&self) -> bool;
}
```

**为什么向量存在 `VectorDoc.vector: Option<...>`**：
允许 store 自己算（远程库自带 embedding）也可以由 provider 预算，两种模式都支持。

---

## 4. 数据写入链路（你没回答的那题，这里给选项）

检索修好了，但**库是空的**。以下四种来源可选（可多选，按实施成本排序）：

| 方案 | 说明 | 成本 | 复用 |
|---|---|---|---|
| **A. 已有 Markdown 索引** | 把现有 `memory/global/MEMORY.md` 等索引进向量库 | **最低** | `native_memory.rs` 已有扫描逻辑 |
| **B. 节点结果回写** | 新增 `knowledgesave` 节点，把上游输出存成知识 | 低 | 复用 `POST /v1/memory` |
| **C. 对话记忆** | 会话内容自动入库 | 中 | `remember` tool 已在，需接自动触发 |
| **D. 文档导入** | 导入 md/txt/pdf，分块后向量化 | 中高 | 需要分块器；PDF 解析是额外依赖 |

**建议顺序：A → B →（需要时再加 C / D）**。
A 几乎零成本且立刻让检索有真实数据；B 让流程能自我积累（这最贴合"节点自由度"的定位）。

---

## 5. 分阶段实施

| 阶段 | 内容 | 产出 | 规模 |
|---|---|---|---|
| **P0** | Spike：验证 `sqlite-vec` 在 `rusqlite bundled` 下可加载 | 一份可行性结论 | 0.5 天 |
| **P1** | `EmbeddingProvider` trait + `OpenAiCompatEmbedding` + 全局配置 | 能算出向量 | 1–2 天 |
| **P2** | `VectorStore` trait + `SqliteVecStore` + FTS5 融合排序 | 本地语义检索可用 | 2–3 天 |
| **P3** | `/v1/memory/backends` 端点 + 节点新字段（下拉） | 节点级自由度可见可用 | 1 天 |
| **P4** | 写入链路 A（已有 Markdown 索引）+ B（回写节点） | 库里有真实数据 | 1–2 天 |
| **P5**（可选） | `HttpVectorStore`（Qdrant / Chroma HTTP） | 远程 / 云端 | 2 天 |
| **P6**（可选） | 内置本地模型（fastembed/ONNX） | 免装 Ollama | 3–5 天 |

**P1–P3 是"最小可用闭环"**：做完就能在节点上选后端、看到真实语义检索结果。

---

## 6. 风险与待验证

| 风险 | 说明 | 处置 |
|---|---|---|
| **`sqlite-vec` × `rusqlite bundled`** | `bundled` 从源码编译 SQLite，扩展需经 `sqlite3_auto_extension` 注册；能否在本 workspace 干净集成**未验证** | **P0 先 spike**，不行则退到 HTTP store 或纯 Rust 向量库 |
| **中文分词** | 现有 FTS5 建表**未指定 tokenizer**，中文可能按整串切 → 关键词检索效果存疑 | P2 顺带评估 `unicode61` / `trigram` |
| **维度锁定** | 换 embedding 模型 → 维度变 → 旧向量全部失效 | 索引表存 `dim` + `model`，不匹配时标记 stale 并重建（不报错） |
| **异步 trait** | 项目已有 `async_trait` 用法需确认（reqwest 是 async） | 沿用 workspace 现有模式 |
| **重建耗时** | 大 Markdown 全量向量化慢 | 增量索引（按文件 mtime + hash），复用现有 `stale` 机制 |
| **首次配置门槛** | 用户配 `base_url` / `model` 易错 | P3 的 `backends` 端点回传可用性，配错时节点上明确提示而非静默降级 |

---

## 7. 这套模式如何推广到其他节点（你的"自由度极高"）

本设计的三层结构是**通用样板**：

```
配置分层   全局默认 config.toml  +  节点级覆盖
选项来源   FieldDef.optionsFrom → 运行时真实可用列表（已有机制）
后端抽象   trait + 多 adapter，坏了一个不影响整体
降级策略   永远保留一个"一定能用"的兜底实现（此处是 FTS5）
```

同一套可以套到：
- **HTTP 节点** → 可换请求后端（Rust reqwest / 代理 / 自定义 header 模板）
- **文件节点** → 可换存储后端（本地 fs / SFTP / S3），根目录已有沙箱
- **LLM 节点** → provider/model 已经在用 `optionsFrom`，可补 fallback 链
- **Code 节点** → 可换执行器（JS 子集 / 真 JS / Python）

建议：**先用知识库把样板跑通**，再逐个复制，而不是一次性抽象所有节点。

---

## 8. 需要你拍板的三件事

1. **"本地模型"的确切含义** —— 能连 Ollama 这类本机服务即可（我推荐，零新增依赖），
   还是必须应用内置、用户什么都不用装（引入 ONNX，包体与编译时间显著增加）？
2. **P5 远程 / P6 内置模型是否进本轮** —— 还是先只做 P1–P4 的本地闭环？
3. **写入链路选哪几个** —— 我建议先 A + B，C/D 延后。

---

## 附：本轮（2026-09-23）已修复的相关 bug

- 知识库节点解析 `entries` + `summary` 字段（此前永远查不到东西）
- `fs_cmds.rs` 的 `\\?\` 前缀剥离（原始字符串少一个反斜杠）
- 注：这两处修完，知识库**能正确检索了**，但因库为空，需 P4 才有真实内容

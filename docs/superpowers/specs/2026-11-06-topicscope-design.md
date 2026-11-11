# TopicScope · 选题雷达 — 设计说明

- 日期：2026-11-06
- 赛事：2026 Qoder 高校创造力大赛 · StudyHack 学习科研赛道
- 提交截止：2026-11-30 18:00（天池赛题页论坛发布作品帖）

## 1. 问题定义

研究生/本科生在读文献阶段的三类具体障碍：

1. **指标口径对不上** —— 论文 A 报 accuracy，论文 B 报 balanced accuracy，论文 C 报 mIoU；口径不同的数字放进同一张对比表没有意义。
2. **找不到最新的相关论文** —— 领域产出速度快，靠搜索引擎和 RSS 拼凑不可靠。
3. **不知道这个方向有没有人做过** —— 选题前无法判断某个子问题是否已被做透、是否存在空白。

现有工具与既有参赛作品普遍解决"读完之后如何整理"，没有解决"读之前如何选方向"。

## 2. 产品

TopicScope 是一个纯前端静态站点（部署到 Qoder Sites，公网可访问），三个视图共用一份文献库：

| 视图 | 回答 | 产出 |
|---|---|---|
| 方向雷达 | 这个方向有多少人在做？哪些子问题做透了？哪些还有空白？ | 子方向聚类、覆盖度判定、关键词共现网络 |
| 指标对齐 | 论文 A 的 acc 和论文 B 的 mIoU 怎么放到同一口径比？ | 指标换算、口径陷阱提示、对比表导出 |
| 文献库 | 原始数据长什么样？ | 文献列表、元数据、导出 |

## 3. 架构

```
Vite + TypeScript + React（Qoder Sites React starter）
无后端 · 无外部 CDN 依赖 · 无数据库

lib/
├── metrics/      指标库：分类 / 分割 / 排序 / 回归 + 换算 + 反解 + 自检
├── analysis/     分词 → TF-IDF → K-means → 簇命名 → 共现网络
├── data/         OpenAlex / Crossref 适配器 + 快照加载
└── export.ts     Markdown / CSV 导出

components/
├── RadarView.tsx         子方向卡片、年份分布、机构榜
├── CooccurrenceGraph.tsx Canvas 力导向共现图
├── AlignView.tsx         指标计算器与换算面板
├── LibraryView.tsx       文献表与导出
└── ...

public/data/snapshot-*.json  构建期抓取的真实文献快照（离线兜底）
```

图表：柱状/面积图用 recharts；共现网络用自写 Canvas 力导向布局（recharts 无此能力）。

## 4. 数据来源

在线检索（浏览器直连，均已验证 `Access-Control-Allow-Origin: *`）：

- **OpenAlex** `api.openalex.org/works` —— 标题、摘要、年份、被引数、topics、keywords、作者机构、期刊。支持 `filter=from_publication_date:...`、`sort=cited_by_count:desc`。
- **Crossref** `api.crossref.org/works` —— DOI、作者与机构、发表日期、期刊、被引数、摘要、类型。

不可用（已实测）：arXiv API 无 CORS 头；Semantic Scholar 返回 429；DBLP 有反爬。

**离线兜底**：构建期抓取若干真实方向的文献元数据，打包为 `public/data/snapshot-*.json`。断网或被限流时全流程照常可用，界面明确标注"离线快照"模式。

OpenAlex 可选 API key（设置面板可填），用于规避共享 IP 的每日额度限制。

## 5. 方向雷达算法

1. 取 N=200 篇文献（OpenAlex，可选年份过滤）
2. 文档文本 = title + abstract + topics + keywords
3. 分词：英文后缀剥离 + 停用词表；中文按二元组（bigram）
4. TF-IDF → 词-文献矩阵
5. K-means（余弦距离，k 在 3–8 间按轮廓系数自适应）
6. 簇命名：簇内 TF-IDF 权重最高的 2–3 个词组合为短语
7. 每簇指标：论文数、占比、近 1/3/5 年年份分布、被引总量与中位数、最高被引代表作、Top5 机构、主要 venue
8. 覆盖度判定：

   | 论文数 | 近年增长 | 判定 |
   |---|---|---|
   | 高 | 高 | 已做透，撞车风险大 |
   | 高 | 低 | 成熟方向，需找新角度 |
   | 低 | 有产出 | 潜在空白——有人做过但很少 |
   | 低 | 无产出 | 真空白 |

9. 关键词共现网络：节点=关键词，边权=共现论文数。稀有的词对组合即"该组合少有人做"的直观证据
10. 导出对比表（Markdown / CSV）

## 6. 指标对齐器

指标库，每个指标含定义、输入契约与换算关系：

- **分类**：Accuracy、Balanced Accuracy、Precision/Recall/F1、Macro-F1、Weighted-F1、Micro-F1、MCC、Cohen's Kappa、Specificity、ROC-AUC、PR-AUC、Log Loss
- **分割**：IoU、Dice/F1、mIoU、mDice
- **排序**：Precision@k、Recall@k、MAP、NDCG@k、MRR
- **回归**：MAE、MSE、RMSE、R²、MAPE、SMAPE

换算能力：

- 正向：Precision+Recall→F1；IoU↔Dice；混淆矩阵→全部分类指标
- 反解：mIoU→mDice（逐类单调，二分求解）；各类 recall + support→Accuracy↔Balanced Accuracy
- 不可唯一反解时显式标注（如 Macro-F1→Micro-F1 需类别分布），不假装可算
- 口径陷阱提示：`mean(2·IoU/(1+IoU)) ≠ 2·mean(IoU)/(1+mean(IoU))`

自检用例集：内置已知答案用例（经典混淆矩阵 → 手算 Balanced Accuracy / Macro-F1 等），界面显示 `自检 N/N 通过`。

## 7. 验证口径

| 指标 | 目标 |
|---|---|
| 离线快照文献数 | ≥ 300 篇真实元数据 |
| 在线聚类性能 | 200 篇浏览器内 < 1s |
| 指标换算自检 | 全部通过，用例数写明 |
| 离线可用性 | 核心流程 100% 可离线完成 |
| 包体积 | < 500KB gzip |

## 8. 交付

- 三个视图，桌面与移动端均可用
- 作品帖按官方五部分结构撰写，附硬指标、边界说明与过程截图
- 作品链接为 Qoder Sites 公网地址，访问策略设为 public

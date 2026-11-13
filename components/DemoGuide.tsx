import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { downloadText } from "@/lib/export";

export interface DemoGuideProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoadSnapshot: () => void;
  onSearch: (query: string) => void;
  goTo: (tab: string) => void;
}

interface Preset {
  key: string;
  label: string;
  description: string;
  /** null 表示载入离线快照；否则为在线检索词 */
  query: string | null;
}

const PRESETS: Preset[] = [
  {
    key: "snapshot",
    label: "默认快照",
    description: "载入内置离线快照（540 篇真实论文，2018–2026 按年采样），不联网也能完整演示。",
    query: null,
  },
  {
    key: "growth",
    label: "增长窗口",
    description: "在线检索 mamba 方向，展示「占比 < 10% 且近三年 ≥ 60%」的增长窗口判定与公开阈值。",
    query: "mamba state space model medical image segmentation",
  },
  {
    key: "sparse",
    label: "稀疏方向",
    description: "在线检索 few-shot counting 方向，展示小簇「样本内稀疏 · 证据不足」的诚实判定。",
    query: "few-shot medical image segmentation counting",
  },
];

interface DemoStep {
  tab: string;
  title: string;
  narration: string;
}

const DEMO_STEPS: DemoStep[] = [
  {
    tab: "radar",
    title: "检索与雷达",
    narration:
      "从首屏离线快照讲起：每条判定固定附一行「不能推出什么」，判定阈值（10% / 12% / 60%）在界面原样公开。",
  },
  {
    tab: "align",
    title: "指标口径对齐",
    narration:
      "演示 mIoU ↔ mDice 换不了并解释逐类非线性变换的原因；打开自检面板展示 50/50 通过（期望值来自独立 Python 参考实现）。",
  },
  {
    tab: "library",
    title: "论文与证据",
    narration:
      "打开 nnU-Net 证据卡，讲六维评分拆解与逐字段人工核对；材料不足的字段明说「当前材料无法判断」。",
  },
  {
    tab: "review",
    title: "文献综述",
    narration:
      "生成综述草稿，讲本地质量门禁（引用 / 交织 / 分寸）与自我对抗检查；正文 [n] 与 GB/T 7714 参考文献一一对应。",
  },
  {
    tab: "checkup",
    title: "选题体检",
    narration:
      "演示「拒绝并转向」结论：致命缺陷审计 → 五维评分 → 完整性自检，结论与分数不自相矛盾，降级原因写在结论旁。",
  },
  {
    tab: "archive",
    title: "研究档案",
    narration:
      "载入存档展示完整恢复提示（替换 / 合并标注），导出 JSON 查看元数据；断网也能重看和导出。",
  },
];

interface QaCard {
  question: string;
  answer: string;
}

const QA_CARDS: QaCard[] = [
  {
    question: "空检索词 / 无意义检索词会怎样？",
    answer: "空检索已禁用；无意义词 0 命中时明确提示未检索到，不降级产出噪声判定。",
  },
  {
    question: "4 篇的小簇为什么判「稳定产出」？",
    answer:
      "已改为「样本内稀疏 · 证据不足」（size < 10 或占比 < 5%），导师汇报候选加 size ≥ 10 且证据不弱的过滤，并写进回归用例。",
  },
  {
    question: "AI 会不会编数字？",
    answer:
      "正文数字与送入模型的统计白名单逐一回查，对不上的标「未核对」；不存在的证据 ID 直接丢弃，可现场点开一条建议演示。",
  },
  {
    question: "断网还能用吗？",
    answer: "静态资源已 SW 预缓存，刷新 / 重开可加载；会话内可看可导出，研究档案存 IndexedDB。",
  },
  {
    question: "未填约束直接生成方案呢？",
    answer: "禁止模型代猜，缺失的约束单列进「待补充条件」，不会冒充用户给定的条件。",
  },
];

/** 录屏时应避开的边界输入：部分已修复，仍建议演示走已验证路径。 */
const AVOID_INPUTS: string[] = [
  "空检索词、无意义检索词（如 zzzqqqxxvvv nonexistent topic）——已禁用 / 0 命中不降级，但录屏不要现场试错",
  "counting · processing 卡片与导师汇报备选 2——长尾小簇存在错分，讲解时以「样本内稀疏 · 证据不足」口径带过",
  "断网后刷新页面——SW 预缓存已修复，仍建议录屏全程保持在线，避免现场缓存状态不确定",
  "超长对话输入（> 96 KB）——服务端有请求体上限，会返回 413",
  "未填任何约束直接生成研究方案——缺失项会进「待补充条件」，演示时先把约束填完整",
];

/** 录屏脚本：动线步骤 + 每步旁白要点 + 应避开的边界输入清单，与面板共用同一份数据。 */
function buildRecordingScript(): string {
  const lines: string[] = [
    "# TopicScope · 3 分钟演示录屏脚本",
    "",
    "> 动线全部走已验证可用的路径。覆盖判定、评分与体检结论是启发式线索，不是经过人工验证的结论；旁白请保留这一口径。",
    "",
    "## 开场（约 20 秒）",
    "",
    "- 打开站点，首屏即离线快照（540 篇真实论文，2018–2026 按年采样），不依赖网络。",
    "- 一句话定位：纯前端科研选题工作台——看清方向被做透的程度、对齐指标口径、产出可回查的综述与研究方案。",
    "",
    "## 预置方向（按需切换）",
    "",
  ];
  for (const preset of PRESETS) {
    const query = preset.query ? `（检索词：\`${preset.query}\`）` : "";
    lines.push(`- ${preset.label}：${preset.description}${query}`);
  }
  lines.push("", "## 演示动线与旁白要点（约 2 分 30 秒）", "");
  DEMO_STEPS.forEach((step, index) => {
    lines.push(
      `### 第 ${index + 1} 步 · ${step.title}（页签 \`${step.tab}\`）`,
      "",
      `- 旁白要点：${step.narration}`,
      "",
    );
  });
  lines.push(
    "## 应避开的边界输入",
    "",
    "以下输入即使部分已修复，录屏时仍建议避开，保证演示走已验证路径：",
    "",
  );
  for (const item of AVOID_INPUTS) lines.push(`- ${item}`);
  lines.push("", "## 附：已知局限 Q&A（答辩备查，均为修复后行为）", "");
  for (const card of QA_CARDS) {
    lines.push(`- 问：${card.question}`, `  - 答：${card.answer}`);
  }
  lines.push(
    "",
    "---",
    "",
    "由 TopicScope 评审演示模式导出。Q&A 为修复后行为，录屏前请在当前版本逐条复核。",
  );
  return lines.join("\n");
}

export function DemoGuide({ open, onOpenChange, onLoadSnapshot, onSearch, goTo }: DemoGuideProps) {
  const loadPreset = (preset: Preset) => {
    if (preset.query === null) {
      onLoadSnapshot();
    } else {
      onSearch(preset.query);
    }
    onOpenChange(false);
  };

  const jumpTo = (tab: string) => {
    goTo(tab);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="heading-cn text-base">评审演示模式</DialogTitle>
          <DialogDescription className="text-xs">
            预置方向、3 分钟演示动线、已知局限 Q&A 与录屏脚本。判定与评分为启发式线索，不是经过人工验证的结论。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="label-caps">预置方向 · 一键载入</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {PRESETS.map((preset) => (
                <div
                  key={preset.key}
                  className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5"
                >
                  <p className="text-xs font-medium">{preset.label}</p>
                  <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
                    {preset.description}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-fit text-[11px]"
                    onClick={() => loadPreset(preset)}
                  >
                    {preset.query === null ? "载入快照" : "在线检索"}
                  </Button>
                </div>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-2">
            <h3 className="label-caps">3 分钟演示动线</h3>
            <ol className="space-y-2">
              {DEMO_STEPS.map((step, index) => (
                <li
                  key={step.tab}
                  className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="space-y-0.5">
                    <p className="flex items-center gap-2 text-xs font-medium">
                      {index + 1}. {step.title}
                      <Badge variant="outline" className="rounded-sm font-mono text-[10px]">
                        {step.tab}
                      </Badge>
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{step.narration}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 text-[11px]"
                    onClick={() => jumpTo(step.tab)}
                  >
                    跳转
                  </Button>
                </li>
              ))}
            </ol>
          </section>

          <Separator />

          <section className="space-y-2">
            <h3 className="label-caps">已知局限 Q&A 卡</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              评委常问问题与标准答案。以下均为修复后行为，录屏或答辩前请在当前版本逐条复核。
            </p>
            <div className="space-y-2">
              {QA_CARDS.map((card) => (
                <div key={card.question} className="space-y-1 rounded-md border border-border px-3 py-2">
                  <p className="flex items-center gap-2 text-xs font-medium">
                    <Badge variant="secondary" className="rounded-sm">
                      修复后
                    </Badge>
                    {card.question}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{card.answer}</p>
                </div>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-2">
            <h3 className="label-caps">录屏脚本</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              导出 Markdown：动线步骤、每步旁白要点、应避开的边界输入清单与答辩 Q&A。
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText("topicscope-demo-script.md", buildRecordingScript(), "text/markdown")
              }
            >
              导出录屏脚本（Markdown）
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
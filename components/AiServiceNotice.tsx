import type { ProbeStatus } from "@/hooks/useFunctionProbe";

const COPY: Record<Exclude<ProbeStatus, "ready">, { title: string; detail: string }> = {
  loading: {
    title: "正在检测 AI 服务…",
    detail: "稍候片刻。检测完成前可以先用不依赖模型的功能。",
  },
  not_deployed: {
    title: "这个站点没有部署后端 AI 服务",
    detail:
      "当前是纯静态部署，模型生成功能（方向建议 / 综述 / 体检 / 方案 / 对话）不可用。" +
      "检索、方向雷达、指标口径对齐、文献库与证据卡、研究档案全部在浏览器本地运行，不受影响。",
  },
  not_configured: {
    title: "后端还没有配置模型接口的 key",
    detail:
      "站点维护者需要在 Qoder Sites 的站点设置里填入服务端 Secret（QWEN_API_KEY）后，模型生成功能才会启用。" +
      "在此之前，本地分析功能照常可用。",
  },
  auth_failed: {
    title: "服务端配置的模型 key 没有通过鉴权",
    detail:
      "模型接口拒绝了当前 Secret，请联系站点维护者更新 QWEN_API_KEY。为避免反复失败，这里不再重试。" +
      "本地分析功能照常可用。",
  },
  error: {
    title: "暂时连不上 AI 服务",
    detail: "网络或后端暂时不可用。可以稍后刷新重试；本地分析功能不受影响。",
  },
};

const ALTERNATIVES = [
  "方向雷达：聚类、覆盖判定与饱和度趋势（本地计算）",
  "指标口径对齐：26 个指标换算与误读提示（本地计算）",
  "文献库 + 证据卡：筛选、六维评分、逐字段人工核对（本地）",
  "研究档案：保存 / 载入 / 导出研究会话（本地 IndexedDB）",
];

/** AI 服务不可用时展示原因与可用替代操作，而不是让页签空白。 */
export function AiServiceNotice({ status, feature }: { status: ProbeStatus; feature: string }) {
  if (status === "ready") return null;
  const copy = COPY[status];
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 px-4 py-4">
      <div className="space-y-1">
        <h2 className="heading-cn text-sm">{feature} · 暂不可用</h2>
        <p className="text-xs font-medium">{copy.title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>
      </div>
      <div className="space-y-1">
        <p className="label-caps">现在仍然可以做的</p>
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted-foreground">
          {ALTERNATIVES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        隐私说明：模型生成功能会把你选择的统计数字、论文标题 / 摘要节选、以及你勾选的已核对证据内容发送到站点自带的模型服务；
        检索词会发往 OpenAlex / Crossref。其余分析计算都在你的浏览器本地完成，不上传。
      </p>
    </div>
  );
}
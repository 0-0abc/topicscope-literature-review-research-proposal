import { useEffect, useMemo, useRef, useState } from "react";
import type { CooccurrenceGraph } from "@/lib/analysis/cooccurrence";
import { cn } from "@/lib/utils";

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weight: number;
}

interface Props {
  graph: CooccurrenceGraph | null;
  className?: string;
}

const HEIGHT = 440;
const PADDING = 46;

export function CooccurrenceGraph({ graph, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<LayoutNode[]>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [width, setWidth] = useState(720);
  const [view, setView] = useState<"graph" | "list">("graph");

  const neighbors = useMemo(() => {
    if (!graph) return new Set<string>();
    const focus = selected ?? hovered;
    if (!focus) return new Set<string>();
    const set = new Set<string>([focus]);
    for (const edge of graph.edges) {
      if (edge.source === focus) set.add(edge.target);
      if (edge.target === focus) set.add(edge.source);
    }
    return set;
  }, [graph, hovered, selected]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 720;
      setWidth(Math.max(320, next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph || graph.nodes.length === 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = HEIGHT * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;

    const nodes: LayoutNode[] = graph.nodes.map((node, index) => {
      const angle = (index / graph.nodes.length) * Math.PI * 2;
      const radius = Math.min(width, HEIGHT) * 0.32;
      return {
        id: node.id,
        x: width / 2 + Math.cos(angle) * radius,
        y: HEIGHT / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        weight: node.documentFrequency,
      };
    });
    nodesRef.current = nodes;

    const indexById = new Map(nodes.map((node, index) => [node.id, index]));
    const maxWeight = Math.max(...graph.edges.map((edge) => edge.weight), 1);

    const repulsion = 5200;
    const springLength = Math.min(width, HEIGHT) / 3.4;
    const springStrength = 0.045;
    const damping = 0.86;

    const step = () => {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.01) {
            dx = (i - j) * 0.1 + 0.05;
            dy = 0.05;
            distance = Math.hypot(dx, dy);
          }
          const force = repulsion / (distance * distance);
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      for (const edge of graph.edges) {
        const a = nodes[indexById.get(edge.source)!];
        const b = nodes[indexById.get(edge.target)!];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const weightFactor = 0.4 + (edge.weight / maxWeight) * 0.6;
        const force = (distance - springLength) * springStrength * weightFactor;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      for (const node of nodes) {
        node.vx += (width / 2 - node.x) * 0.012;
        node.vy += (HEIGHT / 2 - node.y) * 0.012;
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
        node.x = Math.min(width - PADDING, Math.max(PADDING, node.x));
        node.y = Math.min(HEIGHT - PADDING, Math.max(PADDING, node.y));
      }
    };

    for (let tick = 0; tick < 320; tick++) step();

    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) positions.set(node.id, { x: node.x, y: node.y });
    positionsRef.current = positions;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, HEIGHT);

    const styles = getComputedStyle(canvas);
    const textColor = styles.getPropertyValue("--foreground").trim() || "#161514";
    const mutedColor = styles.getPropertyValue("--muted-foreground").trim() || "#4b5563";
    const borderColor = styles.getPropertyValue("--border").trim() || "#d7d2c8";
    const accentColor = styles.getPropertyValue("--ring").trim() || "#2454a6";

    const focus = selected ?? hovered;
    const active = new Set<string>();
    if (focus) {
      active.add(focus);
      for (const edge of graph.edges) {
        if (edge.source === focus) active.add(edge.target);
        if (edge.target === focus) active.add(edge.source);
      }
    }

    for (const edge of graph.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dim = focus !== null && !(active.has(edge.source) && active.has(edge.target));
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.strokeStyle = borderColor;
      context.globalAlpha = dim ? 0.12 : Math.min(0.85, 0.18 + (edge.weight / maxWeight) * 0.6);
      context.lineWidth = dim ? 0.6 : 0.6 + (edge.weight / maxWeight) * 2.4;
      context.stroke();
    }
    context.globalAlpha = 1;

    const maxDf = Math.max(...graph.nodes.map((node) => node.documentFrequency), 1);
    for (const node of graph.nodes) {
      const position = positions.get(node.id);
      if (!position) continue;
      const radius = 4 + (node.documentFrequency / maxDf) * 9;
      const dim = focus !== null && !active.has(node.id);
      context.beginPath();
      context.arc(position.x, position.y, radius, 0, Math.PI * 2);
      context.fillStyle = focus === node.id ? accentColor : textColor;
      context.globalAlpha = dim ? 0.22 : 0.9;
      context.fill();
      context.globalAlpha = 1;

      context.font = "11px ui-sans-serif, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillStyle = mutedColor;
      context.globalAlpha = dim ? 0.25 : 1;
      context.fillText(node.label, position.x, position.y + radius + 3);
      context.globalAlpha = 1;
    }
  }, [graph, width, selected, hovered]);

  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (const [id, position] of positionsRef.current) {
      const node = graph?.nodes.find((item) => item.id === id);
      if (!node) continue;
      const radius = 14;
      if (Math.hypot(position.x - x, position.y - y) <= radius) {
        setHovered(id);
        return;
      }
    }
    setHovered(null);
  };

  if (!graph || graph.nodes.length === 0) {
    return (
      <div
        className={cn(
          "figure-panel flex items-center justify-center text-sm text-muted-foreground",
          className,
        )}
        style={{ height: HEIGHT }}
      >
        暂无可用共现数据
      </div>
    );
  }

  const focusNode = selected ?? hovered;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          小屏幕或键盘操作时，可切换为列表形式查看全部词对。
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
          onClick={() => setView((prev) => (prev === "graph" ? "list" : "graph"))}
        >
          {view === "graph" ? "切换为列表" : "切换为网络图"}
        </button>
      </div>
      {view === "list" ? (
        <div className="figure-panel max-h-[440px] overflow-y-auto px-3 py-2">
          <table className="w-full text-xs">
            <caption className="sr-only">关键词共现词对列表，按共现强度降序</caption>
            <thead>
              <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">词对</th>
                <th className="py-1.5 pr-2 text-right font-medium">共现次数</th>
                <th className="py-1.5 text-right font-medium">共现强度（提升度）</th>
              </tr>
            </thead>
            <tbody>
              {[...graph.edges]
                .sort((a, b) => b.weight - a.weight)
                .map((edge) => {
                  const source = graph.nodes.find((n) => n.id === edge.source);
                  const target = graph.nodes.find((n) => n.id === edge.target);
                  return (
                    <tr key={`${edge.source}-${edge.target}`} className="border-b border-border/60 last:border-0">
                      <td className="py-1.5 pr-2">
                        {source?.label ?? edge.source} — {target?.label ?? edge.target}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{edge.weight}</td>
                      <td className="py-1.5 text-right tabular-nums">{edge.lift.toFixed(2)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : (
      <div ref={wrapperRef} className="figure-panel relative w-full overflow-hidden">
        <canvas
          ref={canvasRef}
          className="block"
          onMouseMove={handleMove}
          onMouseLeave={() => setHovered(null)}
          onClick={() => {
            if (hovered) setSelected((prev) => (prev === hovered ? null : hovered));
          }}
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
          {focusNode
            ? `${focusNode}：出现在 ${graph.nodes.find((n) => n.id === focusNode)?.documentFrequency ?? 0} 篇论文中`
            : "悬停查看词频，点击固定关联"}
        </div>
      </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>圆点大小 = 出现论文数</span>
        <span>连线粗细 = 共现次数</span>
        <span>仅保留共现强度 &gt; 1.15 的词对</span>
        {selected ? (
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setSelected(null)}
          >
            取消固定
          </button>
        ) : null}
      </div>
    </div>
  );
}

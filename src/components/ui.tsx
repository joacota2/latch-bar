import type { ReactNode } from "react";
import type { CodexAgent } from "../domain";

export function AgentGlyph({ agent, size = "md" }: { agent: Pick<CodexAgent, "icon" | "accent">; size?: "sm" | "md" | "lg" }) {
  return <span className={`agent-glyph ${agent.accent} ${size}`}>{agent.icon}</span>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? "toggle checked" : "toggle"} onClick={() => onChange(!checked)}><span /></button>;
}

export function PageIntro({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-intro"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

export function SectionLabel({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return <div className="section-label"><h3>{children}</h3>{meta}</div>;
}

export function SourceTag({ children }: { children: ReactNode }) {
  return <span className="source-tag">{children}</span>;
}

export function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{body}</p></div>;
}

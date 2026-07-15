import { Cable, Check, ExternalLink, KeyRound, RefreshCw, Server, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { PageIntro, SourceTag, Toggle } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function McpsPage() {
  const { mcps, notify } = useLatch();
  const [reloading, setReloading] = useState(false);
  const reload = () => { setReloading(true); window.setTimeout(() => { setReloading(false); notify("Codex configuration reloaded"); }, 900); };
  return <div className="page catalog-page">
    <PageIntro eyebrow="CODEX ENVIRONMENT" title="Your tools, already connected" description="Latch reads MCP servers from Codex. Credentials remain in your existing configuration and are never copied into Latch." action={<button className="secondary-button" onClick={reload}><RefreshCw className={reloading ? "spin" : ""} size={15} /> Reload config</button>} />
    <div className="catalog-meta"><span><span className="status-dot" /> {mcps.filter((mcp) => mcp.health === "connected").length} connected</span><span>Source: <code>~/.codex/config.toml</code></span><button onClick={() => notify("Opening config.toml requires the Tauri desktop shell")}>Open config <ExternalLink size={12} /></button></div>
    <div className="catalog-grid">
      {mcps.map((mcp) => <article className="catalog-card" key={mcp.id}>
        <div className="catalog-card-head"><span className={`catalog-icon ${mcp.transport}`}>{mcp.transport === "stdio" ? <TerminalSquare /> : <Server />}</span><div><h3>{mcp.name}</h3><p>{mcp.detail}</p></div><Toggle checked={mcp.enabled} onChange={() => notify("MCP availability is managed by Codex config")} label={`Enable ${mcp.name}`} /></div>
        <div className="catalog-tags"><SourceTag>{mcp.source}</SourceTag><SourceTag>{mcp.transport.toUpperCase()}</SourceTag>{mcp.authentication !== "none" && <SourceTag><KeyRound size={10} /> {mcp.authentication}</SourceTag>}</div>
        <div className={`health-row ${mcp.health}`}><span>{mcp.health === "connected" ? <Check size={12} /> : <Cable size={12} />}</span><strong>{mcp.health === "connected" ? "Connected" : mcp.health === "error" ? "Connection error" : "Not checked"}</strong><small>{mcp.health === "connected" ? "Available to enabled agents" : "Codex will connect when needed"}</small></div>
      </article>)}
    </div>
    <div className="info-banner"><Cable size={19} /><div><strong>Per-agent access</strong><p>Configured does not mean permitted. Choose which MCP servers each agent can use from its editor.</p></div></div>
  </div>;
}

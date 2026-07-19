import { Cable, Check, ExternalLink, KeyRound, RefreshCw, Server, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { PageIntro, SourceTag, Toggle } from "../components/ui";
import { useLatch } from "../store/LatchStore";

export function McpsPage() {
  const { mcps, codexEnvironment, environmentStatus, refreshCodexEnvironment, notify } = useLatch();
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      await refreshCodexEnvironment();
      notify("Codex environment refreshed");
    } finally {
      setReloading(false);
    }
  };
  return <div className="page catalog-page">
    <PageIntro eyebrow="CODEX APP-SERVER" title="Your tools, already connected" description="Latch uses Codex's effective MCP inventory and live authentication status. Credentials never leave Codex." action={<button className="secondary-button" disabled={reloading} onClick={() => void reload()}><RefreshCw className={reloading ? "spin" : ""} size={15} /> Refresh from Codex</button>} />
    <div className="catalog-meta"><span><span className="status-dot" /> {mcps.filter((mcp) => mcp.health === "connected").length} connected</span><span>Source: <code>{codexEnvironment?.configPath ?? "Codex app-server"}</code></span><button onClick={() => notify("Opening config.toml requires the Tauri desktop shell")}>Open config <ExternalLink size={12} /></button></div>
    <div className="catalog-grid">
      {mcps.map((mcp) => <article className="catalog-card" key={mcp.id}>
        <div className="catalog-card-head"><span className={`catalog-icon ${mcp.transport}`}>{mcp.transport === "stdio" ? <TerminalSquare /> : <Server />}</span><div><h3>{mcp.name}</h3><p>{mcp.detail}</p></div><Toggle checked={mcp.enabled} onChange={() => notify(mcp.configurable ? "MCP availability is managed by Codex config" : "This server is managed by the Codex runtime")} label={`Enable ${mcp.name}`} /></div>
        <div className="catalog-tags"><SourceTag>{mcp.source}</SourceTag><SourceTag>{mcp.transport.toUpperCase()}</SourceTag>{mcp.authentication !== "none" && <SourceTag><KeyRound size={10} /> {mcp.authentication}</SourceTag>}</div>
        <div className={`health-row ${mcp.health}`}><span>{mcp.health === "connected" ? <Check size={12} /> : <Cable size={12} />}</span><strong>{mcp.health === "connected" ? "Connected" : mcp.health === "disabled" ? "Disabled" : mcp.health === "error" ? "Authentication required" : "Not checked"}</strong><small>{mcp.health === "connected" ? "Reported by Codex app-server" : mcp.health === "disabled" ? "Disabled in the effective Codex configuration" : "Codex will connect when needed"}</small></div>
      </article>)}
      {mcps.length === 0 && <div className="info-banner"><Cable size={19} /><div><strong>{environmentStatus === "loading" ? "Loading MCP servers" : "No MCP servers reported"}</strong><p>{environmentStatus === "loading" ? "Codex app-server is resolving the effective tool inventory." : "Refresh after configuring an MCP server in Codex."}</p></div></div>}
    </div>
    <div className="info-banner"><Cable size={19} /><div><strong>Per-agent access</strong><p>Configured does not mean permitted. Choose which MCP servers each agent can use from its editor.</p></div></div>
  </div>;
}

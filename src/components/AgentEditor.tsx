import { AlertTriangle, Braces, Check, ChevronDown, Copy, Eye, Pin, Play, Save, Shield, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CodexAgent, CodexPermissionProfile, SandboxMode } from "../domain";
import { agentConfigSchema, applyAgentConfig, parseAgentConfig, serializeAgentConfig } from "../services/agentConfig";
import { buildPrompt } from "../services/promptBuilder";
import { copyNativeText, isTauri } from "../services/runtime";
import { useLatch } from "../store/LatchStore";
import { AgentGlyph, SourceTag, Toggle } from "./ui";

type EditorTab = "general" | "runtime" | "access" | "integrations" | "context" | "result" | "config";

const tabLabels: { id: EditorTab; label: string }[] = [
  { id: "general", label: "General" }, { id: "runtime", label: "Runtime" }, { id: "access", label: "Access" },
  { id: "integrations", label: "MCPs & Skills" }, { id: "context", label: "Context" }, { id: "result", label: "Result" },
  { id: "config", label: "JSON" },
];

function ChoiceCard({ active, title, body, onClick, warning, disabled }: { active: boolean; title: string; body: string; onClick: () => void; warning?: boolean; disabled?: boolean }) {
  return <button type="button" disabled={disabled} className={`choice-card ${active ? "active" : ""} ${warning ? "warning" : ""}`} onClick={onClick}><span className="radio-dot">{active && <i />}</span><div><strong>{title}</strong><p>{body}</p></div>{active && <Check size={14} />}</button>;
}

const sandboxForPermission = (profile: string): SandboxMode | undefined => ({
  ":read-only": "read-only",
  ":workspace": "workspace-write",
  ":danger-full-access": "full-access",
}[profile] as SandboxMode | undefined);

const permissionForSandbox = (sandbox: SandboxMode) => ({
  "read-only": ":read-only",
  "workspace-write": ":workspace",
  "full-access": ":danger-full-access",
}[sandbox]);

function permissionCopy(profile: CodexPermissionProfile) {
  if (profile.id === ":read-only") return { title: "Read only", body: profile.description || "Read files without changing them." };
  if (profile.id === ":workspace") return { title: "Workspace", body: profile.description || "Read and modify files inside the selected workspace." };
  if (profile.id === ":danger-full-access") return { title: "Full access", body: profile.description || "Broad access outside configured workspace roots." };
  return { title: profile.id.replace(/^:/, "").replaceAll("-", " "), body: profile.description || "Custom permission profile discovered from Codex." };
}

export function AgentEditor() {
  const { ready, agents, selectedAgentId, setSelectedAgentId, updateAgent, deleteAgent, duplicateAgent, mcps, skills, workspaces, codexEnvironment, environmentStatus, refreshCodexEnvironment, notify } = useLatch();
  const source = ready ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const [draft, setDraft] = useState<CodexAgent | null>(source ?? null);
  const [tab, setTab] = useState<EditorTab>("general");
  const [promptPreview, setPromptPreview] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [configJson, setConfigJson] = useState(() => source ? serializeAgentConfig(source) : "");
  const [configError, setConfigError] = useState("");
  useEffect(() => {
    setDraft(source ? { ...source, contextPolicy: { ...source.contextPolicy }, outputPolicy: { ...source.outputPolicy } } : null);
    setConfigJson(source ? serializeAgentConfig(source) : "");
    setConfigError(""); setFormError("");
    setTab("general");
    setPromptPreview(false);
  }, [source?.id]);
  useEffect(() => {
    if (!source) return;
    const workspace = source.workspaceMode === "fixed" ? source.fixedWorkspacePath : undefined;
    if (workspace || (source.codexProfile && source.codexProfile !== "default")) void refreshCodexEnvironment(workspace, source.codexProfile);
  }, [refreshCodexEnvironment, source?.codexProfile, source?.fixedWorkspacePath, source?.id, source?.workspaceMode]);
  if (!source || !draft) return null;
  const patch = <K extends keyof CodexAgent>(key: K, value: CodexAgent[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const models = codexEnvironment?.models ?? [];
  const defaultModel = models.find((model) => model.model === codexEnvironment?.effectiveConfig.model) ?? models.find((model) => model.isDefault);
  const selectedModel = draft.model === "default" ? defaultModel : models.find((model) => model.model === draft.model);
  const modelChoice = draft.model === "default" || selectedModel ? draft.model : "__custom__";
  const effortValues = ["default", ...(selectedModel?.supportedReasoningEfforts.map((effort) => effort.id) ?? [])];
  if (!effortValues.includes(draft.reasoningEffort)) effortValues.push(draft.reasoningEffort);
  const serviceTiers = selectedModel?.serviceTiers ?? [];
  const serviceTierValues = ["default", ...serviceTiers.map((tier) => tier.id)];
  if (!serviceTierValues.includes(draft.serviceTier)) serviceTierValues.push(draft.serviceTier);
  const selectedPermission = draft.permissionProfile ?? permissionForSandbox(draft.sandbox);
  const allowedSandboxModes = codexEnvironment?.requirements.allowedSandboxModes;
  const allowedPermissionProfiles = codexEnvironment?.requirements.allowedPermissionProfiles;
  const discoveredPermissions = (codexEnvironment?.permissionProfiles ?? []).filter((profile) => {
    if (!profile.allowed) return false;
    const sandbox = sandboxForPermission(profile.id);
    const protocolSandbox = sandbox === "full-access" ? "danger-full-access" : sandbox;
    if (protocolSandbox && allowedSandboxModes && !allowedSandboxModes.includes(protocolSandbox)) return false;
    if (allowedPermissionProfiles?.[profile.id] === false) return false;
    return true;
  });
  const permissionProfiles: CodexPermissionProfile[] = codexEnvironment
    ? discoveredPermissions
    : [{ id: selectedPermission, description: null, allowed: true }];
  const choosePermission = (profile: string) => setDraft((current) => current ? {
    ...current,
    permissionProfile: profile,
    sandbox: sandboxForPermission(profile) ?? current.sandbox,
  } : current);
  const allowedApprovals = codexEnvironment?.requirements.allowedApprovalPolicies;
  const approvalAllowed = (value: CodexAgent["approvalPolicy"]) => !allowedApprovals || allowedApprovals.includes(value === "always-ask" ? "untrusted" : value === "when-needed" ? "on-request" : "never");
  const save = async (test = false) => {
    if (saving) return;
    const parsed = agentConfigSchema.safeParse(draft);
    if (!parsed.success) { setFormError(`${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`); return; }
    setFormError(""); setSaving(true);
    try {
      if (!await updateAgent(applyAgentConfig(draft, parsed.data))) return;
      setSaved(true);
      if (test) setSelectedAgentId(null);
      notify(test ? "Agent saved. Select text in another app to run it." : "Agent saved");
      window.setTimeout(() => setSaved(false), 1400);
    } finally { setSaving(false); }
  };
  const prepareTest = () => void save(true);
  const toggleMcp = (id: string) => patch("enabledMcpServers", draft.enabledMcpServers.includes(id) ? draft.enabledMcpServers.filter((item) => item !== id) : [...draft.enabledMcpServers, id]);
  const toggleSkill = (id: string) => patch("enabledSkills", draft.enabledSkills.includes(id) ? draft.enabledSkills.filter((item) => item !== id) : [...draft.enabledSkills, id]);
  const selectTab = (nextTab: EditorTab) => {
    if (nextTab === "config") {
      setConfigJson(serializeAgentConfig(draft));
      setConfigError("");
    }
    setTab(nextTab);
  };
  const copyConfig = async () => {
    const json = serializeAgentConfig(draft);
    setConfigJson(json);
    if (isTauri()) await copyNativeText(json);
    else await navigator.clipboard.writeText(json);
    notify("Agent JSON copied");
  };
  const importConfig = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const next = applyAgentConfig(draft, parseAgentConfig(configJson));
      if (!await updateAgent(next)) return;
      setDraft(next);
      setConfigJson(serializeAgentConfig(next));
      setConfigError("");
      setSaved(true);
      notify("Agent configuration imported and saved");
      window.setTimeout(() => setSaved(false), 1400);
    } catch (caught) {
      setConfigError(caught instanceof Error ? caught.message : String(caught));
    } finally { setSaving(false); }
  };

  return <div className="drawer-scrim" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedAgentId(null); }}>
    <aside className="agent-editor" aria-label="Agent editor">
      <header className="editor-header">
        <div className="editor-title"><AgentGlyph agent={draft} size="lg" /><div><span>CODEX AGENT</span><h2>{draft.name}</h2><p>{draft.enabled ? "Active" : "Paused"} · Updated just now</p></div></div>
        <div className="editor-actions"><button className="ghost-icon" onClick={() => duplicateAgent(draft.id)} aria-label="Duplicate"><Copy size={17} /></button><button className="ghost-icon" onClick={() => patch("pinned", !draft.pinned)} aria-label="Pin"><Pin size={17} fill={draft.pinned ? "currentColor" : "none"} /></button><button className="drawer-close" onClick={() => setSelectedAgentId(null)}><X size={20} /></button></div>
      </header>
      <nav className="editor-tabs">{tabLabels.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}>{item.label}{item.id === "integrations" && <span>{draft.enabledMcpServers.length + draft.enabledSkills.length}</span>}</button>)}</nav>
      <div className="editor-body">
        {formError && <p role="alert" className="agent-config-error">{formError}</p>}
        {tab === "general" && <>
          <section className="editor-section"><div className="field-row two"><label><span>Name</span><input value={draft.name} onChange={(event) => patch("name", event.target.value)} /></label><label><span>Icon</span><div className="icon-input"><input maxLength={2} value={draft.icon} onChange={(event) => patch("icon", event.target.value)} /><ChevronDown size={14} /></div></label></div><label className="field"><span>Description</span><input value={draft.description} onChange={(event) => patch("description", event.target.value)} /></label><div className="inline-settings"><div><strong>Enabled</strong><p>Available from Latch and the Context Bar.</p></div><Toggle checked={draft.enabled} onChange={(value) => patch("enabled", value)} label="Enable agent" /></div><div className="inline-settings"><div><strong>Pin to Context Bar</strong><p>Keep this profile one click away from selected text.</p></div><Toggle checked={draft.pinned} onChange={(value) => patch("pinned", value)} label="Pin agent" /></div></section>
          <section className="editor-section"><div className="editor-section-title"><div><span className="section-icon"><Sparkles size={15} /></span><div><h3>Instructions</h3><p>Define exactly how Codex should handle selected content.</p></div></div><button onClick={() => setPromptPreview((open) => !open)}><Eye size={13} /> Preview final prompt</button></div><textarea className="prompt-editor" value={draft.promptTemplate} onChange={(event) => patch("promptTemplate", event.target.value)} /><div className="variable-chips"><span>Insert variable</span>{["selection", "application", "workspace", "timestamp"].map((variable) => <button key={variable} onClick={() => patch("promptTemplate", `${draft.promptTemplate}\n{{${variable}}}`)}>{`{{${variable}}}`}</button>)}</div>{promptPreview && <label className="field"><span>Final prompt preview (sample context)</span><textarea className="agent-json-editor" aria-label="Final prompt preview" readOnly value={buildPrompt(draft, { selection: "Sample selected text", application: "Example application", workspace: draft.fixedWorkspacePath })} /></label>}<p className="field-hint">If <code>{"{{selection}}"}</code> is omitted, Latch safely appends selected content inside a delimited data block.</p></section>
        </>}
        {tab === "runtime" && <>
          <section className="editor-section">
            <div className="editor-section-title"><div><span className="section-icon"><Sparkles size={15} /></span><div><h3>Model</h3><p>Models and capabilities reported by Codex.</p></div></div></div>
            <label className="select-field"><span>Model</span><select value={modelChoice} onChange={(event) => patch("model", event.target.value === "__custom__" ? "" : event.target.value)}><option value="default">Use Codex default{defaultModel ? ` (${defaultModel.displayName})` : ""}</option>{models.map((model) => <option value={model.model} key={model.id}>{model.displayName}</option>)}<option value="__custom__">Custom model identifier…</option></select></label>
            {modelChoice === "__custom__" && <label className="field"><span>Custom model identifier</span><input autoFocus value={draft.model} onChange={(event) => patch("model", event.target.value)} placeholder="provider model id" /></label>}
            {environmentStatus === "loading" && <p className="field-hint">Refreshing the model catalog from Codex…</p>}
            {selectedModel?.description && <p className="field-hint">{selectedModel.description}</p>}
            <div className="inherit-note"><Sparkles size={14} /><span>Recommended</span> Default follows the active Codex configuration.</div>
          </section>
          <section className="editor-section"><h3>Reasoning effort</h3><p className="section-description">Only levels supported by the selected model are shown.</p><div className="segmented-control">{effortValues.map((value) => { const effort = selectedModel?.supportedReasoningEfforts.find((item) => item.id === value); return <button type="button" title={effort?.description} className={draft.reasoningEffort === value ? "active" : ""} onClick={() => patch("reasoningEffort", value)} key={value}>{value === "xhigh" ? "Extra high" : value[0].toUpperCase() + value.slice(1)}</button>; })}</div></section>
          <section className="editor-section"><h3>Service tier</h3><p className="section-description">Additional speed tiers are reported per model by Codex.</p><div className="segmented-control three">{serviceTierValues.map((value) => { const tier = serviceTiers.find((item) => item.id === value); return <button type="button" title={tier?.description} className={draft.serviceTier === value ? "active" : ""} onClick={() => patch("serviceTier", value)} key={value}>{tier?.name || (value === "default" ? "Default" : value)}</button>; })}</div></section>
          <section className="editor-section"><label className="select-field"><span>Codex configuration profile</span><select value={draft.codexProfile ?? "default"} onChange={(event) => { const profile = event.target.value; patch("codexProfile", profile); void refreshCodexEnvironment(draft.workspaceMode === "fixed" ? draft.fixedWorkspacePath : undefined, profile); }}><option value="default">Base configuration</option>{codexEnvironment?.profiles.map((profile) => <option value={profile} key={profile}>{profile}</option>)}{draft.codexProfile && draft.codexProfile !== "default" && !codexEnvironment?.profiles.includes(draft.codexProfile) && <option value={draft.codexProfile}>{draft.codexProfile} (unavailable)</option>}</select></label><p className="field-hint">Profiles are discovered from the active Codex home and applied when app-server starts.</p></section>
        </>}
        {tab === "access" && <>
          <section className="editor-section"><h3>Computer access</h3><p className="section-description">Permission profiles reported by the effective Codex configuration.</p><div className="choice-stack">{permissionProfiles.map((profile) => { const copy = permissionCopy(profile); return <ChoiceCard key={profile.id} active={selectedPermission === profile.id} title={copy.title} body={copy.body} warning={profile.id === ":danger-full-access"} onClick={() => choosePermission(profile.id)} />; })}{permissionProfiles.length === 0 && <p className="field-hint">Codex did not report an allowed permission profile for this configuration.</p>}</div>{selectedPermission === ":danger-full-access" && <div className="persistent-warning"><AlertTriangle size={17} /><div><strong>Full access stays visible during every run</strong><p>Use this only when workspace boundaries cannot support the task.</p></div></div>}</section>
          <section className="editor-section"><h3>Approvals</h3><p className="section-description">Choices prohibited by Codex requirements are disabled.</p><div className="choice-stack compact"><ChoiceCard disabled={!approvalAllowed("always-ask")} active={draft.approvalPolicy === "always-ask"} title="Ask before tool use" body="Pause before commands or external actions." onClick={() => patch("approvalPolicy", "always-ask")} /><ChoiceCard disabled={!approvalAllowed("when-needed")} active={draft.approvalPolicy === "when-needed"} title="Ask when elevated access is needed" body="Continue safely inside the sandbox; ask before crossing it." onClick={() => patch("approvalPolicy", "when-needed")} /><ChoiceCard disabled={!approvalAllowed("never")} active={draft.approvalPolicy === "never"} title="Never ask" body="Run within the configured sandbox without approval prompts." onClick={() => patch("approvalPolicy", "never")} /></div></section>
          <section className="editor-section"><h3>Workspace</h3><label className="select-field"><span>Mode</span><select value={draft.workspaceMode} onChange={(event) => patch("workspaceMode", event.target.value as CodexAgent["workspaceMode"])}><option value="none">No workspace</option><option value="ask-each-time">Ask each time</option><option value="active-application">Choose folder for active application</option><option value="recent-project">Most recent Codex project</option><option value="fixed">Fixed workspace</option></select></label>{draft.workspaceMode === "fixed" && <label className="field"><span>Workspace path</span><input list="codex-workspaces" placeholder="~/Projects/my-app" value={draft.fixedWorkspacePath ?? ""} onChange={(event) => patch("fixedWorkspacePath", event.target.value)} onBlur={(event) => { if (event.currentTarget.value) void refreshCodexEnvironment(event.currentTarget.value, draft.codexProfile); }} /><datalist id="codex-workspaces">{workspaces.map((workspace) => <option value={workspace.path} key={workspace.id}>{workspace.name}</option>)}</datalist></label>}</section>
        </>}
        {tab === "integrations" && <>
          <section className="editor-section"><div className="editor-section-title"><div><span className="section-icon"><Shield size={15} /></span><div><h3>MCP server access</h3><p>Only selected configurable servers are enabled for this profile.</p></div></div><SourceTag>{draft.enabledMcpServers.length} enabled</SourceTag></div><div className="integration-list">{mcps.map((mcp) => <button type="button" disabled={!mcp.configurable} onClick={() => toggleMcp(mcp.id)} className={draft.enabledMcpServers.includes(mcp.id) ? "selected" : ""} key={mcp.id}><span className="check-box">{draft.enabledMcpServers.includes(mcp.id) && <Check size={12} />}</span><div><strong>{mcp.name}</strong><p>{mcp.configurable ? `${mcp.transport.toUpperCase()} · ${mcp.health}` : `Managed by Codex · ${mcp.health}`}</p></div><span className={`tiny-health ${mcp.health}`} /></button>)}{mcps.length === 0 && <p className="field-hint">{environmentStatus === "loading" ? "Loading MCP servers from Codex…" : "Codex did not report any MCP servers."}</p>}</div></section>
          <section className="editor-section"><div className="editor-section-title"><div><span className="section-icon"><Sparkles size={15} /></span><div><h3>Skills</h3><p>Codex resolves Skill metadata and paths for the selected workspace.</p></div></div><SourceTag>{draft.enabledSkills.length} enabled</SourceTag></div><div className="integration-list">{skills.map((skill) => <button type="button" disabled={!skill.enabled || !skill.compatible} onClick={() => toggleSkill(skill.id)} className={draft.enabledSkills.includes(skill.id) ? "selected" : ""} key={skill.id}><span className="check-box">{draft.enabledSkills.includes(skill.id) && <Check size={12} />}</span><div><strong>{skill.name}</strong><p>{skill.source}</p></div><SourceTag>{skill.enabled && skill.compatible ? "Available" : "Unavailable"}</SourceTag></button>)}{skills.length === 0 && <p className="field-hint">{environmentStatus === "loading" ? "Loading Skills from Codex…" : "Codex did not report any Skills."}</p>}</div></section>
        </>}
        {tab === "context" && <>
          <section className="editor-section"><h3>Included context</h3><p className="section-description">Selection is always treated as untrusted user data.</p>{([ ["includeSelection", "Selected text", "The content highlighted by the user."], ["includeApplicationName", "Source application", "App name, never its process contents."], ["includeWindowTitle", "Window title", "May contain sensitive document names."], ["includeWorkspaceMetadata", "Workspace metadata", "Project path and source repository."], ["includeClipboard", "Clipboard", "Not available in this version."], ["includeScreenshot", "Active-window screenshot", "Not available in this version."] ] as const).map(([key, title, body]) => <div className="inline-settings" key={key}><div><strong>{title}</strong><p>{body}</p></div><Toggle disabled={key === "includeClipboard" || key === "includeScreenshot"} checked={key === "includeClipboard" || key === "includeScreenshot" ? false : draft.contextPolicy[key]} onChange={(value) => patch("contextPolicy", { ...draft.contextPolicy, [key]: value })} label={title} /></div>)}</section>
          <section className="editor-section"><label className="field"><span>Maximum selection characters</span><input type="number" min="100" max="200000" value={draft.contextPolicy.maxSelectionCharacters} onChange={(event) => patch("contextPolicy", { ...draft.contextPolicy, maxSelectionCharacters: Number(event.target.value) })} /></label><p className="field-hint">Longer selections are truncated before constructing the prompt.</p></section>
        </>}
        {tab === "result" && <>
          <section className="editor-section"><h3>Default action</h3><div className="choice-stack"><ChoiceCard active={draft.outputPolicy.mode === "preview"} title="Preview" body="Show the result before changing anything." onClick={() => patch("outputPolicy", { ...draft.outputPolicy, mode: "preview" })} /><ChoiceCard active={draft.outputPolicy.mode === "replace"} title="Replace selection" body="Use native accessibility, then clipboard paste as fallback." onClick={() => patch("outputPolicy", { ...draft.outputPolicy, mode: "replace", allowReplace: true })} /><ChoiceCard active={draft.outputPolicy.mode === "copy"} title="Copy" body="Put the final response on the clipboard." onClick={() => patch("outputPolicy", { ...draft.outputPolicy, mode: "copy" })} /><ChoiceCard active={draft.outputPolicy.mode === "open-studio"} title="Open in Studio" body="Best for filesystem work, tools, diffs, and longer runs." onClick={() => patch("outputPolicy", { ...draft.outputPolicy, mode: "open-studio", allowReplace: false })} /></div></section>
          <section className="editor-section"><label className="select-field"><span>Expected output</span><select value={draft.outputPolicy.expectedOutput} onChange={(event) => patch("outputPolicy", { ...draft.outputPolicy, expectedOutput: event.target.value as CodexAgent["outputPolicy"]["expectedOutput"] })}><option value="automatic">Automatic</option><option value="plain-text">Plain text</option><option value="markdown">Markdown</option><option value="code">Code</option><option value="diff">Diff</option></select></label><div className="inline-settings"><div><strong>Stream preview</strong><p>Show the answer as Codex produces it.</p></div><Toggle checked={draft.outputPolicy.streamPreview} onChange={(value) => patch("outputPolicy", { ...draft.outputPolicy, streamPreview: value })} label="Stream preview" /></div><div className="inline-settings"><div><strong>Allow replacement</strong><p>Offer Replace only when the selected control is editable.</p></div><Toggle checked={draft.outputPolicy.allowReplace} onChange={(value) => patch("outputPolicy", { ...draft.outputPolicy, allowReplace: value, mode: !value && draft.outputPolicy.mode === "replace" ? "preview" : draft.outputPolicy.mode })} label="Allow replacement" /></div></section>
        </>}
        {tab === "config" && <section className="editor-section agent-config-section">
          <div className="editor-section-title">
            <div><span className="section-icon"><Braces size={15} /></span><div><h3>Shareable agent JSON</h3><p>Copy this configuration or paste one shared by a teammate.</p></div></div>
            <button type="button" onClick={() => void copyConfig()}><Copy size={13} /> Copy JSON</button>
          </div>
          <textarea className="agent-json-editor" aria-label="Agent JSON configuration" spellCheck={false} value={configJson} onChange={(event) => { setConfigJson(event.target.value); setConfigError(""); }} />
          {configError && <p className="agent-config-error" role="alert">{configError}</p>}
          <div className="agent-config-actions">
            <p>Importing keeps this agent's local ID and timestamps, while replacing all shareable settings.</p>
            <button type="button" className="secondary-button" onClick={() => setConfigJson(serializeAgentConfig(draft))}>Reset</button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => void importConfig()}>Import &amp; save</button>
          </div>
        </section>}
      </div>
      <footer className="editor-footer"><button className="danger-button" onClick={() => { if (window.confirm(`Delete ${draft.name}?`)) deleteAgent(draft.id); }}><Trash2 size={15} /> Delete</button><div><button className="secondary-button" disabled={saving} onClick={prepareTest}><Play size={15} /> Save & test with selection</button><button className="primary-button" disabled={saving} onClick={() => void save()}>{saved ? <Check size={15} /> : <Save size={15} />}{saved ? "Saved" : "Save changes"}</button></div></footer>
    </aside>
  </div>;
}

import type { Approval } from "../../services/approvals";
export function ApprovalDetails({ approval, count }: { approval: Approval; count: number }) {
  return <div className="context-approval-detail" tabIndex={0} role="region" aria-label="Requested access">
    {count > 1 && <p>{count} requests waiting · review each separately</p>}
    <dl>{approval.details.map((detail, index) => <div key={index}><dt>{detail.label}</dt><dd>{detail.text}</dd></div>)}</dl>
  </div>;
}

// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Approval, SessionAgent } from '@crewtree/shared';
import { Button } from '@/components/ui/button';

export interface ApprovalDecisionInput {
  decision: 'allow' | 'deny';
  rule: 'once' | 'pattern';
  pattern?: string;
  reason?: string;
}

function preview(approval: Approval): string {
  const input = approval.input as Record<string, any>;
  if (approval.tool === 'Bash') return String(input.command ?? '');
  if (input.file_path) return String(input.file_path);
  return JSON.stringify(input).slice(0, 160);
}

/** Inline approvals (UI-WIREFRAMES 5): Allow once · Always allow <pattern> · Deny with reason. */
function ApprovalItem({
  approval,
  agentName,
  onDecide,
}: {
  approval: Approval;
  agentName: string;
  onDecide: (id: string, decision: ApprovalDecisionInput) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState(approval.suggestedPattern ?? approval.tool);
  const [mode, setMode] = useState<'none' | 'always' | 'deny'>('none');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: ApprovalDecisionInput) => setError(await onDecide(approval.id, decision));

  return (
    <li className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/20 p-2.5 text-xs space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-amber-500">⚑</span>
        <span className="font-semibold">{agentName}</span>
        <span className="text-muted-foreground">· {approval.tool}</span>
        {approval.label === 'outside_scope' && (
          <span className="rounded border border-amber-300 dark:border-amber-800 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
            {t('approvals.outsideScope')}
          </span>
        )}
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] bg-black/5 dark:bg-black/30 rounded p-1.5 max-h-24 overflow-y-auto">
        {preview(approval)}
      </pre>
      {mode === 'always' && (
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="w-full px-2 py-1 rounded-md border border-input bg-background font-mono text-[11px]"
          aria-label={t('approvals.pattern')}
        />
      )}
      {mode === 'deny' && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('approvals.reasonPlaceholder')}
          className="w-full px-2 py-1 rounded-md border border-input bg-background text-[11px]"
          aria-label={t('approvals.reason')}
        />
      )}
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-1.5">
        {mode === 'none' && (
          <>
            <Button size="sm" className="h-7 text-[11px]" onClick={() => decide({ decision: 'allow', rule: 'once' })}>
              {t('actions.allowOnce')}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setMode('always')}>
              {t('actions.alwaysAllow')}…
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setMode('deny')}>
              {t('approvals.denyWithReason')}
            </Button>
          </>
        )}
        {mode === 'always' && (
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => decide({ decision: 'allow', rule: 'pattern', pattern })}
          >
            {t('approvals.saveRule')}
          </Button>
        )}
        {mode === 'deny' && (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-[11px]"
            onClick={() => decide({ decision: 'deny', rule: 'once', reason: reason || undefined })}
          >
            {t('actions.deny')}
          </Button>
        )}
        {mode !== 'none' && (
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setMode('none')}>
            {t('actions.cancel')}
          </Button>
        )}
      </div>
    </li>
  );
}

export function ApprovalList({
  approvals,
  agents,
  onDecide,
}: {
  approvals: Approval[];
  agents: SessionAgent[];
  onDecide: (id: string, decision: ApprovalDecisionInput) => Promise<string | null>;
}) {
  if (approvals.length === 0) return null;
  const name = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? a.alias || a.agentName : '?';
  };
  return (
    <ul className="space-y-2">
      {approvals.map((a) => (
        <ApprovalItem key={a.id} approval={a} agentName={name(a.sessionAgentId)} onDecide={onDecide} />
      ))}
    </ul>
  );
}

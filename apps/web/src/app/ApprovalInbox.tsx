// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Approval, SessionAgent } from '@crewtree/shared';
import { api } from '@/lib/api';
import { ApprovalList, type ApprovalDecisionInput } from '@/components/workspace/ApprovalList';

type InboxApproval = Approval & { agentName?: string; sessionTitle?: string };

/** Approval Inbox (UI-WIREFRAMES 5): every pending request of every session, from the header ⚑. */
export function ApprovalInbox({ count, onChanged }: { count: number; onChanged: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxApproval[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api<InboxApproval[]>('/api/approvals?status=pending')
      .then(setItems)
      .catch(() => setItems([]));
  }, [open, count]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const decide = async (id: string, decision: ApprovalDecisionInput) => {
    try {
      await api(`/api/approvals/${id}`, { body: decision });
      setItems((prev) => prev.filter((a) => a.id !== id));
      onChanged();
      return null;
    } catch (err: any) {
      return err.message as string;
    }
  };

  const sessions = [...new Map(items.map((a) => [a.sessionId, a.sessionTitle ?? a.sessionId])).entries()];
  // ApprovalList names agents through SessionAgent rows; the inbox already has the names
  const pseudoAgents = items.map((a) => ({
    id: a.sessionAgentId,
    alias: a.agentName ?? '?',
    agentName: a.agentName ?? '?',
  })) as SessionAgent[];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${
          count > 0
            ? 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400'
            : 'border-border text-muted-foreground'
        }`}
        title={t('header.pendingTitle')}
        aria-expanded={open}
      >
        <span aria-hidden>⚑</span>
        <span>{t('header.pending', { count })}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[440px] max-w-[90vw] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl">
          <div className="px-1 pb-1.5 text-xs font-semibold">{t('inbox.title', { count: items.length })}</div>
          {items.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">{t('inbox.empty')}</p>
          ) : (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {sessions.map(([sessionId, title]) => (
                <div key={sessionId} className="space-y-1.5">
                  <div className="flex items-center px-1 text-[11px] text-muted-foreground">
                    {title}
                    <button
                      type="button"
                      className="ml-auto text-primary hover:underline"
                      onClick={() => {
                        setOpen(false);
                        navigate(`/sessions/${sessionId}`);
                      }}
                    >
                      {t('actions.open')}
                    </button>
                  </div>
                  <ApprovalList
                    approvals={items.filter((a) => a.sessionId === sessionId)}
                    agents={pseudoAgents}
                    onDecide={decide}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

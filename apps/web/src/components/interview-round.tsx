import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { post, useApi, type Interview, type SystemInfo } from "@/lib/api";
import { Btn } from "@/ui/kit";

export function InterviewRoundBody({
  positionId,
  row,
  onBrief,
  tall,
}: {
  positionId: string;
  row: Pick<Interview, "id" | "transcriptChars">;
  onBrief?: () => void;
  tall?: boolean;
}) {
  const q = useApi<Interview>(["interview", positionId, row.id], `/api/v1/positions/${positionId}/interviews/${row.id}`);
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const noKey = sys.data?.llmConfigured === false;
  const i = q.data;
  if (q.isLoading && !i) return <div className="mt-2 text-[11px] text-faint">Loading round…</div>;
  if (!i) return <div className="mt-2 text-[11px] text-bad">Could not load round.</div>;
  const transcriptChars = i.transcriptMarkdown?.length ?? row.transcriptChars ?? 0;
  const canBrief = Boolean(i.transcriptMarkdown || i.notesMarkdown || i.notes);
  async function brief() {
    try {
      await post(`/api/v1/positions/${positionId}/interviews/${row.id}/brief`);
      toast("AI brief queued");
      onBrief?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }
  return (
    <div className="mt-2 space-y-3 text-[12px]">
      {i.notesMarkdown || i.notes ? (
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-faint mb-1">Notes</div>
          <Markdown compact>{i.notesMarkdown || i.notes || ""}</Markdown>
        </div>
      ) : null}
      {i.reviewMarkdown ? (
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-faint mb-1">Review</div>
          <Markdown compact>{i.reviewMarkdown}</Markdown>
        </div>
      ) : null}
      {i.transcriptMarkdown ? (
        <details open={tall}>
          <summary className="cursor-pointer text-muted">Transcript ({transcriptChars.toLocaleString()} chars)</summary>
          <pre className={tall ? "mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted" : "mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted"}>{i.transcriptMarkdown}</pre>
        </details>
      ) : null}
      {i.aiBriefMarkdown ? (
        <div>
          <div className="text-[10.5px] uppercase tracking-wide text-faint mb-1">AI brief {i.aiBriefModel ? `· ${i.aiBriefModel}` : ""}</div>
          <Markdown compact>{i.aiBriefMarkdown}</Markdown>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Btn size="xs" onClick={() => void brief()} disabled={!canBrief || noKey} title={noKey ? "Add a model key in Settings" : undefined}>
          <Sparkles className="h-3 w-3" /> {i.aiBriefMarkdown ? "Re-run AI brief" : "AI brief"}
        </Btn>
      </div>
    </div>
  );
}

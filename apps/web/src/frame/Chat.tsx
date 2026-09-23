import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, ChevronDown, Globe, Plus, Square, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { api, client, del, post, useApi, type ChatMessage, type ChatThread, type ChatThreadRow, type SystemInfo } from "@/lib/api";
import { ago } from "@/lib/format";
import { Btn, IconBtn, Kbd, cn } from "@/ui/kit";
import { useUi, type ChatScopeCtx } from "./store";

type StreamState = {
  threadId: string;
  draft: string; // assistant text being streamed
  tools: { id: string; name: string; args: Record<string, unknown>; ok?: boolean; preview?: string; ms?: number }[];
  steps: number;
} | null;

function scopeQuery(s: ChatScopeCtx) {
  if (s.scope === "position") return `scope=position&positionId=${encodeURIComponent(s.positionId)}`;
  if (s.scope === "company") return `scope=company&companyId=${encodeURIComponent(s.companyId)}`;
  return "scope=global";
}

export function ChatPanel() {
  const { chatScope } = useUi();
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const noKey = sys.data?.llmConfigured === false;
  const qc = useQueryClient();
  const scopeKey = JSON.stringify(chatScope);

  const threads = useQuery<ChatThreadRow[]>({
    queryKey: ["chat", "threads", scopeKey],
    queryFn: () => api<ChatThreadRow[]>(`/api/v1/chat/threads?${scopeQuery(chatScope)}&limit=30`),
  });

  const [threadId, setThreadId] = useState<string | null>(null);
  // pick the most recent thread for the scope when the scope changes
  useEffect(() => {
    setThreadId(null);
  }, [scopeKey]);
  useEffect(() => {
    if (threadId == null && threads.data && threads.data.length) setThreadId(threads.data[0]!.id);
  }, [threads.data, threadId]);

  const thread = useQuery<ChatThread>({
    queryKey: ["chat", "thread", threadId],
    queryFn: () => api<ChatThread>(`/api/v1/chat/threads/${threadId}`),
    enabled: Boolean(threadId),
  });

  const [stream, setStream] = useState<StreamState>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const messages = useMemo(() => (thread.data?.messages || []).filter((m) => m.role !== "tool"), [thread.data]);

  // stick to bottom while streaming / on new messages
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, stream?.draft, stream?.tools.length]);

  const newThread = useCallback(async () => {
    const body: Record<string, unknown> = { scope: chatScope.scope };
    if (chatScope.scope === "position") body.positionId = chatScope.positionId;
    if (chatScope.scope === "company") body.companyId = chatScope.companyId;
    const t = await post<ChatThread>("/api/v1/chat/threads", body);
    await qc.invalidateQueries({ queryKey: ["chat", "threads", scopeKey] });
    setThreadId(t.id);
    return t.id;
  }, [chatScope, qc, scopeKey]);

  const send = useCallback(async () => {
    const msg = text.trim();
    if (!msg || stream || noKey) return;
    let id = threadId;
    try {
      if (!id) id = await newThread();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start a thread");
      return;
    }
    setText("");
    // optimistic user message
    qc.setQueryData<ChatThread>(["chat", "thread", id], (old) =>
      old ? { ...old, messages: [...old.messages, { id: `tmp_${Date.now()}`, role: "user", content: msg, at: new Date().toISOString() }] } : old,
    );
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStream({ threadId: id, draft: "", tools: [], steps: 0 });
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
      const tok = client.getToken();
      if (tok) headers.Authorization = `Bearer ${tok}`;
      const res = await fetch(`/api/v1/chat/threads/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: msg }), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message || `chat failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (event: string, data: string) => {
        if (!data) return;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "delta") setStream((s) => (s ? { ...s, draft: s.draft + String(e.text || "") } : s));
        else if (event === "tool_call") setStream((s) => (s ? { ...s, draft: "", tools: [...s.tools, { id: String(e.id), name: String(e.name), args: (e.args as Record<string, unknown>) || {} }], steps: s.steps + 1 } : s));
        else if (event === "tool_result")
          setStream((s) => (s ? { ...s, tools: s.tools.map((t) => (t.id === e.id ? { ...t, ok: Boolean(e.ok), preview: String(e.preview || ""), ms: Number(e.ms || 0) } : t)) } : s));
        else if (event === "message") {
          const m = e.message as ChatMessage;
          qc.setQueryData<ChatThread>(["chat", "thread", id], (old) => (old ? { ...old, messages: [...old.messages.filter((x) => !x.id.startsWith("tmp_") || x.role !== m.role), m] } : old));
          setStream((s) => (s ? { ...s, draft: "" } : s));
        } else if (event === "error") toast.error(String(e.message || "chat error"));
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = "message";
          const dataLines: string[] = [];
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          handle(ev, dataLines.join("\n"));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast.error(e instanceof Error ? e.message : "chat failed");
    } finally {
      abortRef.current = null;
      setStream(null);
      void qc.invalidateQueries({ queryKey: ["chat", "thread", id] });
      void qc.invalidateQueries({ queryKey: ["chat", "threads", scopeKey] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    }
  }, [text, stream, threadId, newThread, qc, scopeKey, noKey]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const scopeLabel = chatScope.scope === "global" ? "Everything" : chatScope.label;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* scope + thread picker */}
      <div className="px-3 h-9 border-b border-border flex items-center gap-2 shrink-0">
        <span className={cn("h-1.5 w-1.5 rounded-full", chatScope.scope === "global" ? "bg-muted" : "bg-accent")} />
        <span className="eyebrow">{chatScope.scope}</span>
        <span className="text-[12px] truncate">{scopeLabel}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <div className="relative">
            <button type="button" onClick={() => setPickerOpen((v) => !v)} className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-[11px] text-muted hover:bg-surface-2 hover:text-fg" title="Threads">
              <span className="font-mono tabular">{threads.data?.length ?? 0}</span>
              <ChevronDown className="h-3 w-3" />
            </button>
            {pickerOpen ? (
              <div className="absolute right-0 top-7 z-10 w-72 max-h-72 overflow-y-auto rounded-md border border-border bg-surface shadow-pop py-1" onMouseLeave={() => setPickerOpen(false)}>
                {(threads.data || []).length === 0 ? <div className="px-3 py-2 text-[11.5px] text-faint">No threads yet</div> : null}
                {(threads.data || []).map((t) => (
                  <button key={t.id} type="button" onClick={() => (setThreadId(t.id), setPickerOpen(false))} className={cn("w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-2 flex items-center gap-2", t.id === threadId && "bg-surface-2")}>
                    <span className="truncate flex-1">{t.title || "Untitled"}</span>
                    <span className="font-mono text-[10px] text-faint tabular">{t.messageCount} · {ago(t.updatedAt)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <IconBtn label="New thread" onClick={() => void newThread().catch((e) => toast.error(String(e)))}>
            <Plus className="h-3.5 w-3.5" />
          </IconBtn>
          {threadId ? (
            <IconBtn
              label="Delete thread"
              onClick={async () => {
                if (!confirm("Delete this thread?")) return;
                await del(`/api/v1/chat/threads/${threadId}`);
                setThreadId(null);
                void qc.invalidateQueries({ queryKey: ["chat", "threads", scopeKey] });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
          ) : null}
        </div>
      </div>

      {/* transcript */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {!threadId && !thread.isLoading && !noKey ? <Starter scope={chatScope} onPick={(t) => setText(t)} /> : null}
        {noKey && !threadId ? (
          <div className="text-[12px] text-muted leading-relaxed">
            Chat needs a model key before it can answer.{" "}
            <Link to="/settings" search={{ tab: "ai" }} className="text-accent hover:underline">Add one in Settings</Link>.
          </div>
        ) : null}
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {stream ? (
          <div className="space-y-1.5">
            {stream.tools.map((t) => (
              <ToolRow key={t.id} t={t} />
            ))}
            {stream.draft ? (
              <div className="md compact caret">
                <Markdown compact>{stream.draft}</Markdown>
              </div>
            ) : stream.tools.length === 0 || stream.tools.every((t) => t.ok !== undefined) ? (
              <div className="font-mono text-[11px] text-faint animate-pulse">thinking…</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* composer */}
      <div className="border-t border-border p-2 shrink-0">
        <div className="rounded-lg border border-border bg-bg focus-within:border-accent transition-colors">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            disabled={noKey}
            placeholder={noKey ? "Add a model key to use chat" : chatScope.scope === "global" ? "Ask about your pipeline, or tell it to do something…" : `Ask about ${scopeLabel}…`}
            className="w-full bg-transparent px-3 pt-2 pb-1 text-[12.5px] outline-none resize-none placeholder:text-faint disabled:opacity-60"
          />
          <div className="flex items-center gap-1 px-2 pb-1.5">
            {noKey ? (
              <span className="text-[10.5px] text-faint">No model key is set.</span>
            ) : (
              <span className="text-[10.5px] text-faint inline-flex items-center gap-1">
                <Globe className="h-3 w-3" /> browser · <Wrench className="h-3 w-3" /> tools
              </span>
            )}
            <div className="flex-1" />
            <Kbd>↵</Kbd>
            {stream ? (
              <Btn size="xs" variant="danger" onClick={() => abortRef.current?.abort()}>
                <Square className="h-3 w-3" /> Stop
              </Btn>
            ) : (
              <Btn size="xs" variant="primary" disabled={noKey || !text.trim()} onClick={() => void send()}>
                <ArrowUp className="h-3 w-3" /> Send
              </Btn>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-lg rounded-br-sm bg-accent/12 border border-accent/25 px-3 py-2 text-[12.5px] whitespace-pre-wrap leading-relaxed">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {m.toolCalls?.length ? (
        <div className="space-y-1">
          {m.toolCalls.map((t) => (
            <ToolRow key={t.id} t={{ ...t, ok: true }} muted />
          ))}
        </div>
      ) : null}
      {m.content ? <Markdown compact>{m.content}</Markdown> : null}
      <div className="font-mono text-[10px] text-faint tabular flex gap-2">
        <span>{ago(m.at)}</span>
        {m.model ? <span>{m.model}</span> : null}
        {m.tokensIn != null ? <span>{m.tokensIn}→{m.tokensOut ?? 0} tok</span> : null}
      </div>
    </div>
  );
}

function ToolRow({ t, muted }: { t: { id: string; name: string; args: Record<string, unknown>; ok?: boolean; preview?: string; ms?: number }; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  const running = t.ok === undefined;
  const isBrowser = t.name.startsWith("browser_");
  const argStr = Object.entries(t.args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return (
    <div className={cn("rounded-md border text-[11px] font-mono", running ? "border-accent/40 bg-accent/5" : t.ok === false ? "border-bad/40 bg-bad/5" : "border-border bg-surface-2/60", muted && "opacity-75")}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-2 py-1 text-left">
        {isBrowser ? <Globe className={cn("h-3 w-3 shrink-0", running ? "text-accent animate-pulse" : "text-muted")} /> : <Wrench className={cn("h-3 w-3 shrink-0", running ? "text-accent animate-pulse" : "text-muted")} />}
        <span className={running ? "text-accent" : "text-fg"}>{t.name}</span>
        <span className="text-faint truncate flex-1">{argStr}</span>
        {t.ms != null ? <span className="text-faint tabular">{t.ms}ms</span> : null}
        {t.ok === false ? <span className="text-bad">failed</span> : null}
      </button>
      {open && t.preview ? <pre className="px-2 pb-2 text-[10.5px] text-muted whitespace-pre-wrap max-h-48 overflow-y-auto">{t.preview}</pre> : null}
    </div>
  );
}

function Starter({ scope, onPick }: { scope: ChatScopeCtx; onPick: (t: string) => void }) {
  const prompts =
    scope.scope === "position"
      ? ["Summarize this role and the three things that matter most for my fit.", "Open the job page in the browser and check whether it is still live.", "Draft three questions to ask the hiring manager.", "Compare this JD against my master resume — what is missing?"]
      : scope.scope === "company"
        ? ["What do we know about this company? Fill any gaps with a quick research pass.", "Open their careers page and list roles that fit me.", "What is their remote and Brazil-hiring stance?"]
        : ["What should I do first today?", "Which PASS positions have been waiting longest?", "Show my applied positions with no movement in 10 days.", "Run discovery and tell me what came in."];
  return (
    <div className="space-y-2">
      <div className="text-[12px] text-muted leading-relaxed">
        {scope.scope === "global" ? "This chat can read your pipeline, change positions, and drive the browser." : `Scoped to ${scope.label}. It sees the JD, triage, evaluations and materials.`}
      </div>
      <div className="grid gap-1">
        {prompts.map((p) => (
          <button key={p} type="button" onClick={() => onPick(p)} className="text-left text-[12px] rounded-md border border-border px-2.5 py-1.5 hover:bg-surface-2 hover:border-border-strong transition-colors">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

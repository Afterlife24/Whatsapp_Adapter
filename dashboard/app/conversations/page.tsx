"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  getConversations, getMessages, getAgents, takeover, release, sendMessage,
  type Conversation, type Message, type Agent,
} from "@/lib/api";
import { formatTime, formatPhone, statusColor } from "@/lib/utils";
import { UserCheck, Bot, Send, RefreshCw, MessageCircle } from "lucide-react";

function ConversationsInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const selectedPhone = searchParams.get("phone") || "";

  const [agents, setAgents]         = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [convos, setConvos]         = useState<Conversation[]>([]);
  const [messages, setMessages]     = useState<Message[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMsgs, setLoadingMsgs]     = useState(false);
  const [activeConvo, setActiveConvo]     = useState<Conversation | null>(null);
  const [msgInput, setMsgInput]     = useState("");
  const [sending, setSending]       = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError]           = useState("");

  const chatContainerRef  = useRef<HTMLDivElement>(null);
  const isAtBottomRef     = useRef(true);
  const prevMsgCountRef   = useRef(0);
  const msgEndRef         = useRef<HTMLDivElement>(null);

  // Load agents once
  useEffect(() => { getAgents().then(setAgents).catch(console.error); }, []);

  const loadConvos = (agentNum?: string) => {
    const filter = agentNum !== undefined ? agentNum : (selectedAgent === "all" ? undefined : selectedAgent);
    return getConversations(filter === "all" ? undefined : filter)
      .then((data) => {
        setConvos(data);
        if (selectedPhone) {
          const f = data.find((c) => c.phone_number === selectedPhone);
          if (f) setActiveConvo(f);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingConvos(false));
  };

  useEffect(() => { loadConvos(); }, [selectedAgent]);

  useEffect(() => {
    if (!activeConvo) return;
    setLoadingMsgs(true);
    getMessages(activeConvo.phone_number)
      .then(setMessages).catch(console.error)
      .finally(() => setLoadingMsgs(false));
  }, [activeConvo?.phone_number]);

  const handleScroll = () => {
    const el = chatContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && isAtBottomRef.current) {
      msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (!loadingMsgs && messages.length > 0) {
      setTimeout(() => {
        msgEndRef.current?.scrollIntoView({ behavior: "instant" });
        isAtBottomRef.current = true;
        prevMsgCountRef.current = messages.length;
      }, 50);
    }
  }, [loadingMsgs]);

  useEffect(() => {
    if (!activeConvo) return;
    const iv = setInterval(async () => {
      try {
        const newMsgs = await getMessages(activeConvo.phone_number);
        setMessages(newMsgs);
        const filter = selectedAgent === "all" ? undefined : selectedAgent;
        getConversations(filter).then(setConvos).catch(() => {});
      } catch {}
    }, 5000);
    return () => clearInterval(iv);
  }, [activeConvo?.phone_number, selectedAgent]);

  const selectConvo = (c: Conversation) => {
    setActiveConvo(c);
    router.push(`/conversations?phone=${encodeURIComponent(c.phone_number)}`);
  };

  const handleTakeover = async () => {
    if (!activeConvo) return;
    setActionLoading(true); setError("");
    try {
      await takeover(activeConvo.phone_number);
      setActiveConvo((p) => p ? { ...p, human_takeover: true } : p);
      setConvos((p) => p.map((c) => c.phone_number === activeConvo.phone_number ? { ...c, human_takeover: true } : c));
    } catch (e: any) { setError(e.message); }
    finally { setActionLoading(false); }
  };

  const handleRelease = async () => {
    if (!activeConvo) return;
    setActionLoading(true); setError("");
    try {
      await release(activeConvo.phone_number);
      setActiveConvo((p) => p ? { ...p, human_takeover: false } : p);
      setConvos((p) => p.map((c) => c.phone_number === activeConvo.phone_number ? { ...c, human_takeover: false } : c));
    } catch (e: any) { setError(e.message); }
    finally { setActionLoading(false); }
  };

  const handleSend = async () => {
    if (!activeConvo || !msgInput.trim()) return;
    setSending(true); setError("");
    try {
      const res = await sendMessage(activeConvo.phone_number, msgInput.trim());
      if (!res.success) {
        setError(res.error_code === "63016" ? "Outside 24h window — user must message first." : res.error || "Failed");
      } else {
        setMsgInput("");
        const msgs = await getMessages(activeConvo.phone_number);
        setMessages(msgs);
      }
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  };

  const msgBubble = (msg: Message, idx: number) => {
    const isUser     = msg.sender === "user";
    const isSystem   = msg.type === "system";
    const isFollowup = msg.type === "followup";

    if (isSystem) {
      return (
        <div key={idx} className="flex justify-center my-3">
          <span className="text-xs bg-yellow-500/10 text-yellow-400/80 border border-yellow-500/15 px-3 py-1 rounded-full">
            {msg.content}
          </span>
        </div>
      );
    }
    return (
      <div key={idx} className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
        <div className="max-w-[68%]">
          <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? "bg-indigo-600 text-white rounded-br-none"
              : isFollowup
              ? "bg-[#1e1530] text-purple-200 border border-purple-500/20 rounded-bl-none"
              : "bg-[#1c1c28] text-[#e2e2f0] border border-[#2a2a3e] rounded-bl-none"
          }`}>
            {msg.content}
          </div>
          <div className={`text-[11px] text-[#3a3a52] mt-1 ${isUser ? "text-right pr-1" : "text-left pl-1"}`}>
            {formatTime(msg.timestamp)}
            {isFollowup && <span className="ml-1 text-purple-500/50">· follow-up</span>}
          </div>
        </div>
      </div>
    );
  };

  const leadStatusDot: Record<string, string> = {
    active:        "bg-emerald-400",
    completed:     "bg-blue-400",
    inactive:      "bg-gray-500",
    not_qualified: "bg-red-400",
  };

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f]">

      {/* ── Agent filter bar ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0d0d16] border-b border-[#1a1a28] flex-wrap flex-shrink-0">
        <span className="text-xs text-[#44445a] mr-1">Agent:</span>
        <button
          onClick={() => { setSelectedAgent("all"); setActiveConvo(null); }}
          className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            selectedAgent === "all"
              ? "bg-indigo-600 text-white"
              : "bg-[#13131c] text-[#8888aa] border border-[#2a2a3a] hover:text-white hover:bg-[#1a1a26]"
          }`}
        >
          All
        </button>
        {agents.map((a) => (
          <button
            key={a.phone_number}
            onClick={() => { setSelectedAgent(a.phone_number); setActiveConvo(null); setLoadingConvos(true); }}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
              selectedAgent === a.phone_number
                ? "bg-indigo-600 text-white"
                : "bg-[#13131c] text-[#8888aa] border border-[#2a2a3a] hover:text-white hover:bg-[#1a1a26]"
            }`}
          >
            {a.agent_name}
          </button>
        ))}
        <button
          onClick={() => loadConvos()}
          className="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-[#44445a] hover:text-white hover:bg-[#1a1a28] transition-colors"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Left: Conversation list ── */}
        <div className="w-[280px] min-w-[280px] flex flex-col bg-[#0d0d16] border-r border-[#1a1a28]">
          <div className="flex-1 overflow-y-auto">
            {loadingConvos ? (
              <div className="p-6 text-center text-[#44445a] text-xs">Loading...</div>
            ) : convos.length === 0 ? (
              <div className="p-6 text-center text-[#44445a] text-xs">No conversations.</div>
            ) : (
              convos.map((c) => {
                const active = activeConvo?.phone_number === c.phone_number;
                const dot = leadStatusDot[c.lead_status || "active"] || "bg-gray-500";
                const agentName = agents.find((a) =>
                  a.phone_number === c.agent_number ||
                  a.phone_number === c.agent_number?.replace("whatsapp:", "")
                )?.agent_name;
                return (
                  <button key={c.phone_number} onClick={() => selectConvo(c)}
                    className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors border-b border-[#12121e]
                      ${active ? "bg-indigo-600/15 border-l-2 border-l-indigo-500" : "hover:bg-[#111120]"}`}>
                    <div className={`relative w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5
                      ${active ? "bg-indigo-600 text-white" : "bg-[#1e1e2e] text-[#6666aa]"}`}>
                      {formatPhone(c.phone_number).slice(-2)}
                      <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-[#0d0d16] ${dot}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className={`text-sm font-medium truncate ${active ? "text-white" : "text-[#c0c0d8]"}`}>
                          {formatPhone(c.phone_number)}
                        </span>
                        {c.human_takeover && (
                          <span className="text-[10px] bg-orange-500/15 text-orange-400 border border-orange-500/20 px-1.5 py-0.5 rounded-full flex-shrink-0">HT</span>
                        )}
                      </div>
                      <p className="text-xs text-[#44445a] truncate">{c.last_message}</p>
                      {selectedAgent === "all" && agentName && (
                        <p className="text-[10px] text-[#3a3a52] mt-0.5 truncate">{agentName}</p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right: Chat panel ── */}
        {activeConvo ? (
          <div className="flex-1 flex flex-col min-w-0 bg-[#09090f]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 bg-[#0d0d16] border-b border-[#1a1a28] flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                  {formatPhone(activeConvo.phone_number).slice(-2)}
                </div>
                <div>
                  <p className="font-semibold text-white text-sm">{formatPhone(activeConvo.phone_number)}</p>
                  <p className="text-[11px] text-[#44445a] mt-0.5">
                    {activeConvo.human_takeover
                      ? <span className="text-orange-400">● Human takeover</span>
                      : <span className="text-emerald-400">● AI responding</span>}
                    {activeConvo.agent_number && (
                      <span className="ml-2 text-[#2a2a3e]">
                        {agents.find((a) => a.phone_number === activeConvo.agent_number)?.agent_name || activeConvo.agent_number}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {error && <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-lg max-w-[180px] truncate">{error}</span>}
                {activeConvo.human_takeover ? (
                  <button onClick={handleRelease} disabled={actionLoading}
                    className="flex items-center gap-1.5 text-xs font-medium bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded-lg hover:bg-emerald-600/30 transition-colors disabled:opacity-50">
                    <Bot size={13} /> Release to AI
                  </button>
                ) : (
                  <button onClick={handleTakeover} disabled={actionLoading}
                    className="flex items-center gap-1.5 text-xs font-medium bg-orange-500/20 text-orange-400 border border-orange-500/30 px-3 py-1.5 rounded-lg hover:bg-orange-500/30 transition-colors disabled:opacity-50">
                    <UserCheck size={13} /> Take Over
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div ref={chatContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-5">
              {loadingMsgs ? (
                <div className="flex items-center justify-center h-full text-[#44445a] text-sm">Loading...</div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <MessageCircle size={36} className="text-[#1e1e2e]" />
                  <p className="text-[#44445a] text-sm">No messages yet.</p>
                </div>
              ) : (
                <>
                  {messages.map((msg, idx) => msgBubble(msg, idx))}
                  <div ref={msgEndRef} />
                </>
              )}
            </div>

            {/* Input */}
            {activeConvo.human_takeover ? (
              <div className="flex-shrink-0 px-5 py-4 bg-[#0d0d16] border-t border-[#1a1a28]">
                <div className="flex items-center gap-3">
                  <input value={msgInput} onChange={(e) => setMsgInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                    placeholder="Type a message..."
                    className="flex-1 bg-[#13131f] border border-[#2a2a3e] rounded-xl px-4 py-2.5 text-sm text-[#e2e2f0] placeholder-[#3a3a52] focus:outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/30 transition-colors" />
                  <button onClick={handleSend} disabled={sending || !msgInput.trim()}
                    className="w-10 h-10 flex items-center justify-center bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 transition-colors disabled:opacity-40 flex-shrink-0">
                    <Send size={15} />
                  </button>
                </div>
                <p className="text-[11px] text-[#2a2a3e] mt-2 text-center">Human takeover active — AI paused · Enter to send</p>
              </div>
            ) : (
              <div className="flex-shrink-0 px-5 py-3 bg-[#0d0d16] border-t border-[#1a1a28] text-center">
                <p className="text-xs text-[#2a2a3e]">AI is responding · <span className="text-orange-400/70">Take Over</span> to reply manually</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-[#09090f] gap-4">
            <div className="w-16 h-16 rounded-2xl bg-[#111120] border border-[#1a1a28] flex items-center justify-center">
              <MessageCircle size={28} className="text-[#2a2a3e]" />
            </div>
            <div className="text-center">
              <p className="font-medium text-[#6666aa] text-sm">Select a conversation</p>
              <p className="text-xs text-[#2a2a3e] mt-1">Choose from the list on the left</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-[#44445a] text-sm bg-[#0a0a0f] min-h-screen">Loading...</div>}>
      <ConversationsInner />
    </Suspense>
  );
}

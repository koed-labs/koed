"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Search,
  Filter,
  GitPullRequest,
  GitMerge,
  ChevronDown,
  GitCommit,
  CheckCircle2,
  MessageSquare,
  X,
  GitBranch,
  Users,
  Bot,
} from "lucide-react";
import { ChatComposer } from "@/components/ChatComposer";
import { useWorkspace } from "@/components/WorkspaceProvider";
import type { ChatMessage, PullRequest as PR } from "@/lib/workspace";

const SUGGESTED_PROMPTS = [
  "Summarize this PR",
  "Find potential bugs",
  "Review this against the memory layer",
];

export default function PullRequestsPage() {
  const { workspace } = useWorkspace();
  const pullRequests = workspace.pullRequests;
  // Deep-linked from elsewhere (For You's pull request notifications, for
  // instance) via /pull-requests?pr=<id> - read once on mount so arriving
  // here already opens that specific PR instead of just the bare queue.
  const searchParams = useSearchParams();
  const [selectedPrId, setSelectedPrId] = useState<string | null>(() => searchParams.get("pr"));
  const [activeTab, setActiveTab] = useState<'all' | 'reviewing' | 'authored'>('all');
  const [detailView, setDetailView] = useState<"summary" | "chat">("summary");
  const [chatDraft, setChatDraft] = useState("");
  const [chatByPrId, setChatByPrId] = useState<Record<string, ChatMessage[]>>({});

  const selectedPr = pullRequests.find(pr => pr.id === selectedPrId);
  const chatMessages = selectedPr ? (chatByPrId[selectedPr.id] ?? []) : [];

  const getFilteredPRs = () => {
    switch (activeTab) {
      case 'reviewing':
        return pullRequests.filter(pr => pr.status === 'open');
      case 'authored':
        return pullRequests.filter(pr => pr.status !== 'merged');
      case 'all':
      default:
        return pullRequests;
    }
  };

  const filteredPRs = getFilteredPRs();
  const previouslyReviewed = filteredPRs.filter(pr => pr.status === 'merged');
  const authored = filteredPRs.filter(pr => pr.status !== 'merged');

  const openChatForPr = (prId: string) => {
    setSelectedPrId(prId);
    setDetailView("chat");
  };

  const sendChatMessage = (text: string) => {
    if (!selectedPr) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: ChatMessage = {
      id: `${selectedPr.id}-user-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    const agentMessage: ChatMessage = {
      id: `${selectedPr.id}-agent-${Date.now()}`,
      role: "agent",
      content: `I'll use this PR as context: ${selectedPr.title} (${selectedPr.repo}, ${selectedPr.baseBranch} › ${selectedPr.branch}). The memory layer can help review the ${selectedPr.added.toLocaleString()} additions without re-reading the full diff.`,
      createdAt: Date.now() + 1,
    };

    setChatByPrId((current) => ({
      ...current,
      [selectedPr.id]: [...(current[selectedPr.id] ?? []), userMessage, agentMessage],
    }));
    setChatDraft("");
  };

  return (
    <div className="flex h-full bg-background text-foreground drag-region">
      {/* Left Pane: PR List */}
      <div className={`flex flex-col h-full overflow-y-auto border-r border-border transition-all duration-300 ${selectedPrId ? 'w-1/2' : 'w-full'}`}>
        <div className="px-8 py-8 w-full max-w-4xl mx-auto no-drag">
          {/* Top Tabs */}
          <div className="flex items-center gap-2 mb-8">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'all' ? 'bg-surface-hover text-foreground' : 'text-muted hover:text-foreground-secondary hover:bg-surface'}`}
            >
              All
            </button>
            <button
              onClick={() => setActiveTab('reviewing')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'reviewing' ? 'bg-surface-hover text-foreground' : 'text-muted hover:text-foreground-secondary hover:bg-surface'}`}
            >
              Reviewing
            </button>
            <button
              onClick={() => setActiveTab('authored')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'authored' ? 'bg-surface-hover text-foreground' : 'text-muted hover:text-foreground-secondary hover:bg-surface'}`}
            >
              Authored
            </button>
          </div>

          {/* Search & Filter */}
          <div className="flex items-center gap-3 mb-10">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <input
                type="text"
                placeholder="Search pull requests"
                className="w-full bg-surface border border-border rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-accent transition-all placeholder:text-faint"
              />
            </div>
            <button className="p-2.5 bg-surface border border-border rounded-lg text-muted hover:text-foreground-secondary hover:bg-surface-hover transition-colors">
              <Filter className="w-4 h-4" />
            </button>
          </div>

          {/* Previously Reviewed Section */}
          {previouslyReviewed.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center text-subtle hover:text-foreground-secondary cursor-pointer mb-4 transition-colors w-fit">
                <span className="text-sm font-medium">Previously reviewed</span>
                <ChevronDown className="w-4 h-4 ml-1" />
              </div>

              <div className="space-y-1">
                {previouslyReviewed.map(pr => (
                  <PRItem
                    key={pr.id}
                    pr={pr}
                    isSelected={selectedPrId === pr.id}
                    onClick={() => {
                      setSelectedPrId(pr.id);
                      setDetailView("summary");
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Authored Section */}
          {authored.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center text-subtle hover:text-foreground-secondary cursor-pointer mb-4 transition-colors w-fit">
                <span className="text-sm font-medium">Authored</span>
                <ChevronDown className="w-4 h-4 ml-1" />
              </div>

              <div className="space-y-1">
                {authored.map(pr => (
                  <PRItem
                    key={pr.id}
                    pr={pr}
                    isSelected={selectedPrId === pr.id}
                    onClick={() => {
                      setSelectedPrId(pr.id);
                      setDetailView("summary");
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {filteredPRs.length === 0 && (
            <div className="rounded-xl border border-border bg-surface/40 px-6 py-16 text-center">
              <GitPullRequest className="mx-auto mb-3 h-6 w-6 text-faint" />
              <p className="text-sm font-medium text-foreground-secondary">No pull requests</p>
              <p className="mt-1 text-xs text-subtle">
                When repos are connected, reviews will show up here.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Right Pane: PR Details */}
      {selectedPr && (
        <div className="w-1/2 flex flex-col h-full bg-background no-drag">
          {/* Details Header */}
          <div className="px-6 py-4 flex items-center justify-between border-b border-border flex-shrink-0 bg-background/90 backdrop-blur-sm z-10">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-surface rounded-md p-1">
                <button
                  className={`px-3 py-1 rounded text-xs font-medium ${detailView === "summary" ? "bg-surface-hover text-foreground" : "text-muted hover:text-foreground-secondary"}`}
                  onClick={() => setDetailView("summary")}
                >
                  Summary
                </button>
                <button className="px-3 py-1 text-faint cursor-not-allowed rounded text-xs font-medium" title="Coming in v1.1">Code</button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                className={`flex items-center px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${detailView === "chat" ? "bg-chip text-chip-foreground" : "bg-surface-hover hover:bg-surface-active text-foreground"}`}
                onClick={() => openChatForPr(selectedPr.id)}
              >
                <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Chat
              </button>
              <button className="px-3 py-1.5 bg-surface-hover text-faint cursor-not-allowed rounded-md text-xs font-medium" title="Coming in v1.1">
                Submit review
              </button>
              <button
                className="p-1.5 text-subtle hover:text-foreground-secondary transition-colors ml-2"
                onClick={() => {
                  setSelectedPrId(null);
                  setDetailView("summary");
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {detailView === "chat" ? (
            <PRChatPanel
              pullRequest={selectedPr}
              messages={chatMessages}
              draft={chatDraft}
              onDraftChange={setChatDraft}
              onSend={sendChatMessage}
            />
          ) : (
          <div className="p-6 overflow-y-auto flex-1">
            <h1 className="text-2xl font-semibold mb-4 text-foreground leading-tight">
              {selectedPr.title}
            </h1>

            <div className="flex items-center gap-2 text-sm text-muted mb-8">
              {selectedPr.avatar ? (
                <img src={selectedPr.avatar} alt="" className="w-5 h-5 rounded-full bg-surface-hover" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-surface-hover" />
              )}
              <span className="font-medium text-foreground-secondary">{selectedPr.author}</span>
              <span>·</span>
              <span>{selectedPr.time}</span>
            </div>

            {/* Metadata Grid */}
            <div className="grid grid-cols-[100px_1fr] gap-y-4 text-sm mb-10">
              <div className="flex items-center text-subtle">
                <GitBranch className="w-4 h-4 mr-2" /> Branch
              </div>
              <div className="flex items-center gap-2">
                <span className="text-foreground-secondary">{selectedPr.baseBranch}</span>
                <span className="text-faint">›</span>
                <span className="text-foreground-secondary">{selectedPr.branch}</span>
                <span className="text-success ml-2">+{selectedPr.added}</span>
                <span className="text-subtle">-{selectedPr.removed}</span>
              </div>

              <div className="flex items-center text-subtle">
                <Users className="w-4 h-4 mr-2" /> Reviewers
              </div>
              <div className="flex items-center">
                {selectedPr.avatar ? (
                  <img src={selectedPr.avatar} alt="" className="w-5 h-5 rounded-full bg-surface-hover" />
                ) : (
                  <div className="w-5 h-5 rounded-full bg-surface-hover" />
                )}
              </div>

              <div className="flex items-center text-subtle">
                <MessageSquare className="w-4 h-4 mr-2" /> Comments
              </div>
              <div className="text-foreground-secondary">No comments</div>

              <div className="flex items-center text-subtle">
                <CheckCircle2 className="w-4 h-4 mr-2" /> Checks
              </div>
              <div className="text-foreground-secondary">No CI checks</div>

              <div className="flex items-center text-subtle">
                <GitPullRequest className="w-4 h-4 mr-2" /> Status
              </div>
              <div className="text-foreground-secondary">Ready for review</div>
            </div>

            {/* Description */}
            <div className="mb-10">
              <div className="flex items-center gap-2 text-foreground-secondary font-medium mb-4 cursor-pointer">
                Description <ChevronDown className="w-4 h-4 text-subtle" />
              </div>
              <div className="text-sm text-muted space-y-2 pl-2">
                <p>Updated</p>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Nahmii ⇄ Ethereum page</li>
                  <li>Compile contracts</li>
                </ul>
              </div>
            </div>

            {/* Checks */}
            <div className="mb-10 border-t border-border/50 pt-6">
              <div className="flex items-center gap-2 text-foreground-secondary font-medium mb-6 cursor-pointer">
                Checks <ChevronDown className="w-4 h-4 text-subtle" />
              </div>
              <div className="text-center text-sm text-subtle py-4">
                No CI checks
              </div>
            </div>

            {/* Merge Conflicts */}
            <div className="mb-10 border-t border-border/50 pt-6">
              <div className="text-foreground-secondary font-medium mb-4">
                Merge conflicts
              </div>
            </div>

            {/* Activity */}
            <div className="border-t border-border/50 pt-6">
              <div className="flex items-center gap-2 text-foreground-secondary font-medium mb-6 cursor-pointer">
                Activity <ChevronDown className="w-4 h-4 text-subtle" /> <span className="text-subtle font-normal">4</span>
              </div>

              <div className="space-y-3">
                <ActivityItem
                  icon={<GitMerge className="w-4 h-4 text-merged" />}
                  text={`Merge pull request #12 from ${selectedPr.author}/${selectedPr.branch}`}
                  hash="2ce61c8"
                  time={selectedPr.time}
                  avatar={selectedPr.avatar}
                />
                <ActivityItem
                  icon={<GitPullRequest className="w-4 h-4 text-success" />}
                  text={`${selectedPr.author} opened this pull request`}
                  time={selectedPr.time}
                />
                <ActivityItem
                  icon={<GitCommit className="w-4 h-4 text-muted" />}
                  text="11 commits"
                  time={selectedPr.time}
                />
              </div>
            </div>

          </div>
          )}
        </div>
      )}
    </div>
  );
}

function PRChatPanel({
  pullRequest,
  messages,
  draft,
  onDraftChange,
  onSend,
}: {
  pullRequest: PR;
  messages: ChatMessage[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
}) {
  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-6 py-5 pb-48">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-wide text-subtle">PR chat</p>
          <h2 className="mt-1 text-lg font-medium text-foreground leading-snug">
            {pullRequest.title}
          </h2>
          <p className="mt-1 text-xs text-subtle">
            {pullRequest.repo} · {pullRequest.baseBranch} › {pullRequest.branch}
          </p>
        </div>

        {messages.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted leading-relaxed">
              Ask about this pull request. The agent uses the PR and your memory layer as context.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-foreground-secondary hover:border-border-strong hover:text-foreground transition-colors"
                  onClick={() => onSend(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="bg-surface-hover text-foreground px-4 py-3 rounded-2xl rounded-tr-sm max-w-[85%] text-sm leading-relaxed">
                    {message.content}
                  </div>
                </div>
              ) : (
                <div key={message.id} className="flex justify-start">
                  <div className="flex items-start gap-3 max-w-[85%]">
                    <div className="w-8 h-8 rounded-full bg-surface border border-border flex items-center justify-center flex-shrink-0 mt-1">
                      <Bot className="w-4 h-4 text-muted" />
                    </div>
                    <p className="text-foreground-secondary text-sm leading-relaxed pt-2">
                      {message.content}
                    </p>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pt-10">
        <ChatComposer
          placeholder="Ask about this pull request..."
          projectName={pullRequest.repo}
          branch={pullRequest.branch}
          footer="This thread stays scoped to the selected pull request."
          value={draft}
          onChange={onDraftChange}
          onSend={onSend}
        />
      </div>
    </div>
  );
}

function PRItem({ pr, isSelected, onClick }: { pr: PR, isSelected: boolean, onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 p-3 rounded-xl transition-colors cursor-pointer group border ${
        isSelected
          ? 'bg-accent/10 border-accent/30'
          : 'bg-transparent border-transparent hover:bg-surface/50'
      }`}
    >
      {/* Icon with Status Dot */}
      <div className="relative mt-1 flex-shrink-0">
        {pr.status === 'merged' ? (
          <GitMerge className="w-5 h-5 text-merged" />
        ) : (
          <GitPullRequest className="w-5 h-5 text-muted" />
        )}

        {/* Status Dot */}
        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-border bg-surface' : 'border-border bg-background'}`}>
          {pr.status === 'merged' && <div className="w-1.5 h-1.5 rounded-full bg-merged" />}
          {pr.status === 'open' && <div className="w-1.5 h-1.5 rounded-full bg-success" />}
          {pr.status === 'draft' && <div className="w-1.5 h-1.5 rounded-full bg-surface-active" />}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-4 mb-1">
          <h3 className={`text-sm font-medium truncate transition-colors ${isSelected ? 'text-accent' : 'text-foreground-secondary group-hover:text-accent'}`}>
            {pr.title}
          </h3>
          <span className="text-xs text-subtle whitespace-nowrap">{pr.time}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-subtle truncate">
            {pr.avatar && (
              <img src={pr.avatar} alt="" className="w-4 h-4 rounded-full bg-surface-hover" />
            )}
            <span className="truncate">{pr.repo}</span>
            <span className="text-foreground-secondary">·</span>
            <span className="truncate text-muted">{pr.baseBranch}</span>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono whitespace-nowrap ml-4">
            <span className="text-success">+{pr.added.toLocaleString()}</span>
            <span className="text-subtle">-{pr.removed.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityItem({ icon, text, hash, time, avatar }: { icon: React.ReactNode, text: string, hash?: string, time: string, avatar?: string }) {
  return (
    <div className="flex items-center justify-between p-3 border border-border rounded-lg bg-surface/50">
      <div className="flex items-center gap-3 truncate">
        {icon}
        <span className="text-sm text-foreground-secondary truncate">{text}</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 ml-4">
        {hash && <span className="text-xs font-mono text-subtle">{hash}</span>}
        {avatar && <img src={avatar} alt="" className="w-4 h-4 rounded-full bg-surface-hover" />}
        <span className="text-xs text-subtle">{time}</span>
      </div>
    </div>
  );
}

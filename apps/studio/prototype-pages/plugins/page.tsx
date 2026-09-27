"use client";

import { useEffect, useState } from "react";
import { Folder, Search, Settings, Plus, MoreHorizontal, Check, RefreshCw, X } from "lucide-react";
import { createId } from "@/lib/workspace";
import {
  SiGmail,
  SiGoogledrive,
  SiNotion,
  SiGithub,
  SiDatadog,
  SiGooglebigquery,
  SiGooglechrome
} from "react-icons/si";
import { FcImageFile, FcPuzzle, FcCommandLine, FcGlobe, FcApproval } from "react-icons/fc";

// Fallback Slack icon
const SlackIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
  </svg>
);

// Fallback OpenAI icon since react-icons/si might not have it in this version
const OpenAiIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.5973 8.3829a.0757.0757 0 0 1-.0379-.052V2.7483a4.504 4.504 0 0 1 5.8682 6.1313l-.1419.0804-4.7783 2.7582a.7853.7853 0 0 0-.3927.6813v6.7369l-2.02-1.1686a.071.071 0 0 1-.038-.052v-5.5826zM8.4095 2.6033a4.4755 4.4755 0 0 1 4.25-.417l-.142-.0852-4.783-2.7582a.7712.7712 0 0 0-.7806 0L1.111 2.7114a.0804.0804 0 0 1 .0332-.0615l4.3998-2.5356a4.4992 4.4992 0 0 1 2.8655 2.489zM19.31 16.059a4.485 4.485 0 0 1-2.3655 1.9728V12.35a.7664.7664 0 0 0-.3879-.6765L10.7422 8.319l2.0201-1.1685a.0757.0757 0 0 1 .071 0l4.8303 2.7865a4.504 4.504 0 0 1 1.6464 6.122zm-7.31-7.2348-3.3283 1.9213v-3.8426l3.3283-1.9213 3.3283 1.9213v3.8426z" />
  </svg>
);

export default function PluginsPage() {
  const [activeTab, setActiveTab] = useState<'plugins' | 'skills'>('plugins');
  const [skillsTab, setSkillsTab] = useState<'personal' | 'system' | 'koed'>('personal');

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-background text-foreground drag-region">
      <div className="px-8 py-8 max-w-4xl mx-auto w-full no-drag relative">
        {/* Top Tabs */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <button
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'plugins' ? 'bg-surface-hover text-foreground' : 'text-muted hover:text-foreground-secondary hover:bg-surface'}`}
              onClick={() => setActiveTab('plugins')}
            >
              Plugins
            </button>
            <button
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === 'skills' ? 'bg-surface-hover text-foreground' : 'text-muted hover:text-foreground-secondary hover:bg-surface'}`}
              onClick={() => setActiveTab('skills')}
            >
              Skills
            </button>
          </div>
        </div>

        {activeTab === 'plugins' ? <PluginsView /> : <SkillsView tab={skillsTab} setTab={setSkillsTab} />}
      </div>
    </div>
  );
}

type CatalogPlugin = {
  title: string;
  desc: string;
  icon: React.ReactNode;
  action?: "add" | "menu";
  active?: boolean;
};

const AVAILABLE_PLUGINS: CatalogPlugin[] = [
  { icon: <SiGmail className="w-5 h-5 text-[#EA4335]" />, title: "Outlook Email", desc: "Read and send Outlook mail" },
  { icon: <FcGlobe className="w-5 h-5" />, title: "Granola", desc: "Meeting notes and follow-ups" },
  { icon: <SiGooglechrome className="w-5 h-5 text-foreground-secondary" />, title: "Chrome", desc: "Browse and extract from the web" },
  { icon: <OpenAiIcon className="w-5 h-5 text-foreground" />, title: "OpenAI", desc: "Models, files, and Assistants APIs" },
];

const POPULAR_PLUGINS: CatalogPlugin[] = [
  { icon: <SiGmail className="w-5 h-5 text-[#EA4335]" />, title: "Gmail", desc: "Read and manage Gmail" },
  { icon: <SiGithub className="w-5 h-5 text-foreground" />, title: "GitHub", desc: "Triage PRs, issues, CI, and publish flows", action: "menu" },
  { icon: <SiGoogledrive className="w-5 h-5 text-[#0066DA]" />, title: "Google Drive", desc: "Drive, Docs, Sheets or Slides", action: "menu" },
  { icon: <CalendarIcon className="w-5 h-5 text-blue-500" />, title: "Google Calendar", desc: "Manage Google Calendar events", active: true },
  { icon: <SiNotion className="w-5 h-5 text-foreground" />, title: "Notion", desc: "Notion docs and workflows" },
  { icon: <SlackIcon className="w-5 h-5 text-[#E01E5A]" />, title: "Slack", desc: "Read and manage Slack" },
];

const NOTEWORTHY_PLUGINS: CatalogPlugin[] = [
  { icon: <FcApproval className="w-5 h-5" />, title: "Healthcare Public Data", desc: "Search official public healthcare sources" },
  { icon: <SiDatadog className="w-5 h-5 text-[#632CA6]" />, title: "Datadog (Preview)", desc: "Search and act on your data" },
  { icon: <SiGooglebigquery className="w-5 h-5 text-[#669DF6]" />, title: "BigQuery", desc: "Query and manage BigQuery" },
  { icon: <LineChartIcon className="w-5 h-5 text-orange-400" />, title: "Longbridge", desc: "Stock quotes, financial data" },
];

function PluginsView() {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const matchesQuery = (plugin: CatalogPlugin) =>
    !normalizedQuery ||
    plugin.title.toLowerCase().includes(normalizedQuery) ||
    plugin.desc.toLowerCase().includes(normalizedQuery);

  const available = AVAILABLE_PLUGINS.filter(matchesQuery);
  const popular = POPULAR_PLUGINS.filter(matchesQuery);
  const noteworthy = NOTEWORTHY_PLUGINS.filter(matchesQuery);
  const hasResults = available.length + popular.length + noteworthy.length > 0;

  return (
    <>
      <h1 className="text-3xl font-semibold mb-2">Plugins</h1>
      <p className="text-muted text-sm mb-6">Work with your agents across your favorite tools</p>

      <div className="relative mb-10">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search plugins"
          className="w-full bg-surface border border-border rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-accent transition-all placeholder:text-faint"
        />
      </div>

      <div className="flex items-center gap-2 mb-6">
        <button className="px-3 py-1 bg-surface-hover text-foreground-secondary rounded-full text-xs font-medium">Public</button>
        <button className="px-3 py-1 text-subtle hover:text-foreground-secondary rounded-full text-xs font-medium transition-colors">Personal</button>
      </div>

      {!hasResults ? (
        <p className="py-12 text-center text-sm text-subtle">No plugins match “{query.trim()}”.</p>
      ) : (
        <>
          {available.length > 0 && (
            <div className="mb-10">
              <h2 className="text-sm font-semibold text-foreground-secondary mb-4">Available</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {available.map((plugin) => (
                  <PluginCard key={plugin.title} {...plugin} />
                ))}
              </div>
            </div>
          )}

          {popular.length > 0 && (
            <div className="mb-10">
              <h2 className="text-sm font-semibold text-foreground-secondary mb-4">Popular</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {popular.map((plugin) => (
                  <PluginCard key={plugin.title} {...plugin} />
                ))}
              </div>
            </div>
          )}

          {noteworthy.length > 0 && (
            <div className="mb-10">
              <h2 className="text-sm font-semibold text-foreground-secondary mb-4">New & Noteworthy</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {noteworthy.map((plugin) => (
                  <PluginCard key={plugin.title} {...plugin} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

type SkillsTab = "personal" | "system" | "koed";

type CatalogSkill = {
  title: string;
  desc: string;
  icon: React.ReactNode;
};

type AddedSkill = {
  id: string;
  title: string;
  desc: string;
  path?: string;
};

const SKILLS_STORAGE_KEY = "memory-layer.skills.v1";

const PERSONAL_SKILLS: CatalogSkill[] = [
  { icon: <SiGooglechrome className="w-5 h-5 text-foreground-secondary" />, title: "Chrome Devtools", desc: "Uses Chrome DevTools via MCP for debugging and inspection" },
  { icon: <FcPuzzle className="w-5 h-5" />, title: "Develop Web Game", desc: "Web game dev + Playwright test loop" },
  { icon: <FcGlobe className="w-5 h-5" />, title: "Frontend Skill", desc: "Design visually strong landing pages, websites, and demos" },
  { icon: <FcApproval className="w-5 h-5" />, title: "Gacha Design Review", desc: "Assess gacha risk and SLP-safe designs" },
  { icon: <FcImageFile className="w-5 h-5" />, title: "Image Gen", desc: "Generate or edit images for websites and product surfaces" },
  { icon: <OpenAiIcon className="w-5 h-5 text-foreground" />, title: "OpenAI Docs", desc: "Reference the official OpenAI developer documentation" },
  { icon: <FcPuzzle className="w-5 h-5" />, title: "Playwright CLI Skill", desc: "Drive a real browser from the terminal with Playwright" },
  { icon: <FcCommandLine className="w-5 h-5" />, title: "Ralphing Setup", desc: "Human-in-the-loop checklist workflow for large technical tasks" },
];

const SYSTEM_SKILLS: CatalogSkill[] = [
  { icon: <FcPuzzle className="w-5 h-5" />, title: "Playwright CLI Skill", desc: "Drive a real browser from the terminal with Playwright" },
  { icon: <FcImageFile className="w-5 h-5" />, title: "Screenshot", desc: "Capture a desktop, window, or pixel region" },
  { icon: <FcApproval className="w-5 h-5" />, title: "Security Best Practices", desc: "Language and framework specific secure-by-default reviews" },
  { icon: <FcCommandLine className="w-5 h-5" />, title: "Ralphing Setup", desc: "Human-in-the-loop checklist workflow for large technical tasks" },
];

const KOED_SKILLS: CatalogSkill[] = [
  { icon: <FcGlobe className="w-5 h-5" />, title: "Koed Team Fixture Testing", desc: "Shared fixtures and checks for Koed team workspaces" },
  { icon: <FcCommandLine className="w-5 h-5" />, title: "Koed Memory", desc: "Recall projects, threads, and review context from the memory layer" },
  { icon: <OpenAiIcon className="w-5 h-5 text-foreground" />, title: "OpenAI Docs", desc: "Reference the official OpenAI developer documentation" },
];

function parseAddedSkills(raw: string | null): AddedSkill[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AddedSkill => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as AddedSkill).id === "string" &&
        typeof (item as AddedSkill).title === "string" &&
        typeof (item as AddedSkill).desc === "string"
      );
    });
  } catch {
    return [];
  }
}

function slugifySkillName(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled-skill";
}

function SkillsView({ tab, setTab }: { tab: SkillsTab, setTab: (t: SkillsTab) => void }) {
  const [query, setQuery] = useState("");
  const [addedSkills, setAddedSkills] = useState<AddedSkill[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addModal, setAddModal] = useState<"create" | "folder" | null>(null);

  useEffect(() => {
    setAddedSkills(parseAddedSkills(window.localStorage.getItem(SKILLS_STORAGE_KEY)));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(addedSkills));
  }, [addedSkills, hydrated]);

  const catalog = tab === "system" ? SYSTEM_SKILLS : tab === "koed" ? KOED_SKILLS : PERSONAL_SKILLS;
  const normalizedQuery = query.trim().toLowerCase();
  const matchesName = (name: string) => !normalizedQuery || name.toLowerCase().includes(normalizedQuery);

  const visibleAdded = tab === "personal" ? addedSkills.filter((skill) => matchesName(skill.title)) : [];
  const visibleCatalog = catalog.filter((skill) => {
    if (!matchesName(skill.title)) return false;
    if (tab !== "personal") return true;
    return !addedSkills.some((added) => added.title.toLowerCase() === skill.title.toLowerCase());
  });
  const hasResults = visibleAdded.length + visibleCatalog.length > 0;

  const addSkill = (input: { title: string; desc: string; path?: string }) => {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Skill name is required");
    }
    const alreadyAdded = addedSkills.some((skill) => skill.title.toLowerCase() === title.toLowerCase());
    if (alreadyAdded) {
      setAddModal(null);
      setTab("personal");
      return;
    }
    setAddedSkills((current) => [
      {
        id: createId("skill"),
        title,
        desc: input.desc.trim() || "Custom skill",
        path: input.path,
      },
      ...current,
    ]);
    setAddModal(null);
    setTab("personal");
  };

  return (
    <>
      <div className="absolute top-8 right-8 flex items-center gap-2">
        <button type="button" aria-label="Refresh skills" className="p-1.5 text-muted hover:text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
        <button type="button" aria-label="Skill settings" className="p-1.5 text-muted hover:text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors">
          <Settings className="w-4 h-4" />
        </button>
        <div className="relative">
          <button
            type="button"
            className="flex items-center gap-1 px-3 py-1.5 bg-chip text-chip-foreground hover:bg-white rounded-md text-sm font-medium transition-colors"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((current) => !current)}
          >
            Add <ChevronDownIcon className="w-4 h-4" />
          </button>
          {addMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAddMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border-strong bg-surface p-1 shadow-xl">
                <button
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddModal("create");
                  }}
                >
                  Create skill
                </button>
                <button
                  type="button"
                  className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-foreground-secondary hover:bg-surface-hover"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddModal("folder");
                  }}
                >
                  Add from folder
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <h1 className="text-3xl font-semibold mb-2">Skills</h1>
      <p className="text-muted text-sm mb-6">Extend your agents with task-specific skills</p>

      <div className="relative mb-10">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills"
          className="w-full bg-surface border border-border rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-border-strong focus:ring-1 focus:ring-accent transition-all placeholder:text-faint"
        />
      </div>

      <div className="flex items-center gap-4 mb-6 border-b border-border pb-2">
        <button
          className={`text-sm font-medium transition-colors ${tab === 'personal' ? 'text-foreground' : 'text-subtle hover:text-foreground-secondary'}`}
          onClick={() => setTab('personal')}
        >
          Personal
        </button>
        <button
          className={`text-sm font-medium transition-colors ${tab === 'system' ? 'text-foreground' : 'text-subtle hover:text-foreground-secondary'}`}
          onClick={() => setTab('system')}
        >
          System
        </button>
        <button
          className={`text-sm font-medium transition-colors ${tab === 'koed' ? 'text-foreground' : 'text-subtle hover:text-foreground-secondary'}`}
          onClick={() => setTab('koed')}
        >
          koed-self-hosted
        </button>
      </div>

      {!hasResults ? (
        <p className="py-12 text-center text-sm text-subtle">No skills match “{query.trim()}”.</p>
      ) : (
        <div className="mb-10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visibleAdded.map((skill) => (
              <SkillCard
                key={skill.id}
                icon={<FcPuzzle className="w-5 h-5" />}
                title={skill.title}
                desc={skill.path ? `${skill.desc} · ${skill.path}` : skill.desc}
                checked
              />
            ))}
            {visibleCatalog.map((skill) => (
              <SkillCard
                key={skill.title}
                icon={skill.icon}
                title={skill.title}
                desc={skill.desc}
                onAdd={() => addSkill({ title: skill.title, desc: skill.desc })}
              />
            ))}
          </div>
        </div>
      )}

      {addModal && (
        <AddSkillModal
          mode={addModal}
          existingNames={addedSkills.map((skill) => skill.title)}
          onClose={() => setAddModal(null)}
          onCreate={addSkill}
        />
      )}
    </>
  );
}

function PluginCard({ icon, title, desc, action = "add", active = false }: { icon: React.ReactNode, title: string, desc: string, action?: "add" | "menu", active?: boolean }) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-xl border transition-colors cursor-pointer ${active ? 'bg-surface-hover/80 border-border-strong' : 'bg-transparent border-transparent hover:bg-surface hover:border-border'}`}>
      <div className="flex items-center gap-4 overflow-hidden">
        <div className="w-10 h-10 rounded-lg bg-surface border border-border flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground-secondary truncate">{title}</span>
          <span className="text-xs text-subtle truncate">{desc}</span>
        </div>
      </div>
      <div className="flex-shrink-0 ml-4">
        {action === "add" ? (
          <button className="p-1.5 text-muted hover:text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors">
            <Plus className="w-4 h-4" />
          </button>
        ) : (
          <button className="p-1.5 text-muted hover:text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors">
            <MoreHorizontal className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function SkillCard({
  icon,
  title,
  desc,
  checked = false,
  onAdd,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  checked?: boolean;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl border border-transparent hover:bg-surface hover:border-border transition-colors cursor-pointer">
      <div className="flex items-center gap-4 overflow-hidden">
        <div className="w-10 h-10 rounded-lg bg-surface border border-border flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground-secondary truncate">{title}</span>
          <span className="text-xs text-subtle truncate">{desc}</span>
        </div>
      </div>
      <div className="flex-shrink-0 ml-4">
        {checked ? (
          <Check className="w-4 h-4 text-faint" />
        ) : onAdd ? (
          <button
            type="button"
            aria-label={`Add ${title}`}
            className="p-1.5 text-muted hover:text-foreground-secondary hover:bg-surface-hover rounded-md transition-colors"
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <Plus className="w-4 h-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AddSkillModal({
  mode,
  existingNames,
  onClose,
  onCreate,
}: {
  mode: "create" | "folder";
  existingNames: string[];
  onClose: () => void;
  onCreate: (input: { title: string; desc: string; path?: string }) => void;
}) {
  const isFolder = mode === "folder";
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [path, setPath] = useState("");

  const canCreate = name.trim().length > 0 && (!isFolder || path.trim().length > 0);
  const duplicate = existingNames.some((item) => item.toLowerCase() === name.trim().toLowerCase());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseFolder = () => {
    const nextPath = name.trim()
      ? `~/skills/${slugifySkillName(name)}`
      : `~/skills/untitled-skill`;
    setPath(nextPath);
    if (!name.trim()) {
      setName(nextPath.split("/").pop() ?? "untitled-skill");
    }
  };

  const submit = () => {
    if (!canCreate || duplicate) return;
    onCreate({
      title: name.trim(),
      desc: desc.trim() || (isFolder ? "Skill added from a local folder" : "Custom skill"),
      path: isFolder ? path.trim() : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">
            {isFolder ? "Add from folder" : "Create skill"}
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5">
          <label className="block">
            <span className="mb-2 block text-sm text-muted">Skill name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Frontend review"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-2 block text-sm text-muted">Description</span>
            <input
              value={desc}
              onChange={(event) => setDesc(event.target.value)}
              placeholder="What this skill should help with"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          {isFolder && (
            <div className="mt-4">
              <span className="mb-2 block text-sm text-muted">Folder</span>
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted">
                  <Folder className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{path || "No folder selected"}</span>
                </div>
                <button
                  type="button"
                  className="flex-shrink-0 rounded-lg border border-border bg-surface-hover px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-active transition-colors"
                  onClick={chooseFolder}
                >
                  Choose folder
                </button>
              </div>
            </div>
          )}

          {duplicate && (
            <p className="mt-3 text-xs text-warning">A skill with this name is already in Personal.</p>
          )}
        </div>

        <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-chip"
            disabled={!canCreate || duplicate}
            onClick={submit}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
  );
}
function LineChartIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
  );
}
function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="m6 9 6 6 6-6"/></svg>
  );
}

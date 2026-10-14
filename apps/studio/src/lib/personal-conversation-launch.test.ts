import { describe, expect, it } from "vitest";
import type { ChatComposerSelection } from "@/components/ChatComposer";
import {
  resolvePersonalChatRecipients,
  type PersonalChatLaunchInstance
} from "./personal-conversation-launch";

const agents = [
  { id: "alice", currentVersion: 2, lifecycle: "active" },
  { id: "bob", currentVersion: 1, lifecycle: "active" }
];
const instance: PersonalChatLaunchInstance = {
  instanceId: "codex.local",
  driverId: "codex",
  runnerDeviceId: "device-1",
  models: [{ id: "model-a", supportedReasoningEfforts: ["low", "high"] }],
  permissionModes: ["supervised", "full_access"]
};
const selection: ChatComposerSelection = {
  agentId: "alice",
  provider: "codex",
  instanceId: "codex.local",
  model: "model-a",
  effort: "high",
  permissionMode: "ask"
};

describe("shared Personal recipient launch", () => {
  it("keeps ordered Agents on the same provider with their explicit chat settings", () => {
    const recipients = resolvePersonalChatRecipients(
      {
        ...selection,
        recipients: [
          { ...selection, agentId: "bob", effort: "low" },
          { ...selection, agentId: "alice" }
        ]
      },
      [instance],
      agents
    );
    expect(
      recipients.map((r) => [r.agentId, r.reasoningEffort, r.permissionMode])
    ).toEqual([
      ["bob", "low", "supervised"],
      ["alice", "high", "supervised"]
    ]);
  });
  it("uses the authority instance ID for hosted providers and supports mixed providers", () => {
    const hosted = {
      ...instance,
      instanceId: "hosted-client",
      hostedInstanceId: "authority-client",
      driverId: "claude"
    };
    const recipients = resolvePersonalChatRecipients(
      {
        ...selection,
        recipients: [
          { ...selection, agentId: "alice" },
          {
            ...selection,
            agentId: "bob",
            provider: "claude",
            instanceId: "hosted-client",
            hostedInstanceId: "authority-client"
          }
        ]
      },
      [instance, hosted],
      agents
    );
    expect(recipients.map((r) => r.aiClientInstanceId)).toEqual([
      "codex.local",
      "authority-client"
    ]);
  });
  it("does not replace verified launch authority with stale device data from a draft", () => {
    expect(() =>
      resolvePersonalChatRecipients(
        { ...selection, targetDeviceId: "stale" },
        [{ ...instance, runnerDeviceId: undefined }],
        agents
      )
    ).toThrow("verified Personal Device");
  });
  it.each([
    {
      label: "unready",
      options: [{ ...instance, ready: false }],
      choice: selection
    },
    { label: "ambiguous", options: [instance, instance], choice: selection },
    {
      label: "unsupported permission",
      options: [{ ...instance, permissionModes: [] }],
      choice: selection
    },
    {
      label: "unsupported reasoning",
      options: [instance],
      choice: { ...selection, effort: "xhigh" }
    },
    {
      label: "retired Agent",
      options: [instance],
      choice: { ...selection, agentId: "retired" }
    }
  ])("blocks $label before sending", ({ options, choice }) => {
    expect(() =>
      resolvePersonalChatRecipients(choice, options, agents)
    ).toThrow();
  });
  it("keeps generic chats on the same execution settings contract", () => {
    const [generic] = resolvePersonalChatRecipients(
      { ...selection, agentId: null },
      [instance],
      agents
    );
    expect(generic).toMatchObject({
      kind: "generic",
      agentId: null,
      model: "model-a",
      reasoningEffort: "high",
      targetDeviceId: "device-1"
    });
  });
  it("blocks a batch spanning different devices", () => {
    expect(() =>
      resolvePersonalChatRecipients(
        {
          ...selection,
          recipients: [
            { ...selection, agentId: "alice" },
            {
              ...selection,
              agentId: "bob",
              provider: "claude",
              instanceId: "claude.local"
            }
          ]
        },
        [
          instance,
          {
            ...instance,
            driverId: "claude",
            instanceId: "claude.local",
            runnerDeviceId: "device-2"
          }
        ],
        agents
      )
    ).toThrow("same Personal Device");
  });
});

import {describe, expect, it} from "vitest";
import {type AiChatAuthorInfo, type AiChatMessage, type AiChatMessageBody}
  from "@gadgets/workshop-shared/api";
import {
  foldProposedChanges, getModelTokenLimits, isCompactionTurn, startsAgentTurn,
} from "../src/agent-compaction";
import {applyCodeChange, type CodeChange} from "@gadgets/workshop-shared/code-change";
import type {Api, AssistantMessage, Message, Model} from "@earendil-works/pi-ai";
import type {ChatBindingEntry} from "../src/storage-schema/overseer-storage";

const user: AiChatAuthorInfo = {type: "user", id: "user", name: "User"};
const agent: AiChatAuthorInfo = {type: "agent", id: "model", name: "Agent"};

// A batch's code change: sets one file of gadget 1.
function codeChange(content: string, filename = "file.js"): CodeChange {
  return {1: [[filename, {set: content}]]};
}

// The files a composed change produces, naming which batches were folded into it.
function filesIn(composed: CodeChange | undefined): string[] {
  if (composed === undefined) return [];
  let content = applyCodeChange(new Map(), composed);
  return [...(content.get(1)?.keys() ?? [])].toSorted();
}

function record(
    sequence: number, author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  return {chatId: 1, sequence, timestamp: new Date(sequence), author, ...body};
}

function message(sequence: number, author: AiChatAuthorInfo, text: string): AiChatMessage {
  return record(sequence, author, {type: "message", message: text});
}

// Provenance fields for synthesized pi assistant messages (only api/provider/id are read).
const testModel = {
  id: "test-model", api: "anthropic-messages", provider: "anthropic",
} as Model<Api>;

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function projection(messages: AiChatMessage[]) {
  return messages.flatMap(entry => entry.type === "message" ? [{
    message: entry.author.type === "agent"
        ? assistantMessage([{type: "text", text: entry.message}])
        : {role: "user" as const, content: entry.message, timestamp: 0},
    sequence: entry.sequence,
    canCut: true,
  }] : []);
}

describe("compaction trigger", () => {
  it("reserves output capacity only where the model counts it against its own window", () => {
    // Workers AI charges the response to the window, so it has to be withheld.
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
    })).toEqual({inputBudget: 229_376, maxOutputTokens: 32_768});

    // Anthropic publishes an input-only window, so withholding anything would waste it.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "",
    })).toEqual({inputBudget: 1_000_000, maxOutputTokens: undefined});
  });

  it("uses the suggested 272K compaction budget for GPT-5.6 and GPT-6", () => {
    for (let model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      expect(getModelTokenLimits({provider: "openai", model, apiToken: ""}))
          .toEqual({inputBudget: 272_000, maxOutputTokens: 128_000});
    }
    for (let model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]) {
      expect(getModelTokenLimits({provider: "openai", model, apiToken: ""}))
          .toEqual({inputBudget: 272_000, maxOutputTokens: 128_000});
    }
  });

  // Workers AI rejects a request whose prompt and response cap together exceed the window, so a
  // Cloudflare model configured by hand needs the reservation the model table can't declare for it.
  it("reserves Workers AI output capacity for a model the registry doesn't list", () => {
    expect(getModelTokenLimits({provider: "cloudflare", model: "@cf/custom", apiToken: ""}))
        .toEqual({inputBudget: 95_232, maxOutputTokens: 32_768});

    // Other providers fall back to the assumed window with nothing withheld.
    expect(getModelTokenLimits({provider: "ollama", model: "local", apiToken: ""}))
        .toEqual({inputBudget: 128_000, maxOutputTokens: undefined});
  });

  it("lets the model config override the window and output limit", () => {
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-unlisted", apiToken: "",
      contextWindow: 1_000_000, outputLimit: 64_000,
    })).toEqual({inputBudget: 936_000, maxOutputTokens: 64_000});

    // An override beats the model table, too.
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
      outputLimit: 16_384,
    })).toEqual({inputBudget: 245_760, maxOutputTokens: 16_384});
  });

  it("takes the config's compaction budget ahead of the model's own", () => {
    let gpt = {provider: "openai" as const, model: "gpt-6-sol", apiToken: ""};
    // Below the suggested 272K, and above it.
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 100_000}))
        .toEqual({inputBudget: 100_000, maxOutputTokens: 128_000});
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 500_000}))
        .toEqual({inputBudget: 500_000, maxOutputTokens: 128_000});

    // A model that declares no budget of its own sizes against its window.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "", compactionInputBudget: 200_000,
    })).toEqual({inputBudget: 200_000, maxOutputTokens: undefined});

    // Absent and undefined are the same.
    expect(getModelTokenLimits({...gpt, compactionInputBudget: undefined}))
        .toEqual(getModelTokenLimits(gpt));
  });

  it("caps the config's compaction budget at what the window leaves for a prompt", () => {
    // 1,050,000 less the 128,000 reserved for the response.
    let gpt = {provider: "openai" as const, model: "gpt-6-sol", apiToken: ""};
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 922_000}).inputBudget)
        .toBe(922_000);
    expect(getModelTokenLimits({...gpt, compactionInputBudget: 922_001}).inputBudget)
        .toBe(922_000);
    expect(getModelTokenLimits({...gpt, compactionInputBudget: Infinity}).inputBudget)
        .toBe(922_000);

    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-opus-5-5", apiToken: "",
      compactionInputBudget: 2_000_000,
    }).inputBudget).toBe(1_000_000);
    expect(getModelTokenLimits({
      provider: "cloudflare", model: "@cf/moonshotai/kimi-k2.7-code", apiToken: "",
      compactionInputBudget: 262_144,
    })).toEqual({inputBudget: 229_376, maxOutputTokens: 32_768});

    // The config's own window and output limit decide the room.
    expect(getModelTokenLimits({
      provider: "anthropic", model: "claude-unlisted", apiToken: "",
      contextWindow: 100_000, outputLimit: 20_000, compactionInputBudget: 90_000,
    }).inputBudget).toBe(80_000);
  });

  it("recognizes /compact as the newest message, and only there", () => {
    let compact = record(1, user, {
      type: "slashCommand", request: {id: {builtin: true, commandId: "compact"}, args: ""},
    });
    expect(isCompactionTurn([message(0, user, "hi"), compact])).toBe(true);
    expect(isCompactionTurn([compact, message(2, user, "hi")])).toBe(false);
    expect(isCompactionTurn([message(0, user, "hi")])).toBe(false);
  });

  // Every one of these produces a `user` model message, so retained context can begin at it. A chat
  // driven only by callbacks would otherwise never find a cut point.
  it("treats callbacks, nudges and accepted connections as turn starts", () => {
    expect(startsAgentTurn(message(0, user, "hi"))).toBe(true);
    expect(startsAgentTurn(message(0, agent, "reply"))).toBe(false);
    expect(startsAgentTurn(record(0, agent, {
      type: "agentCallback", methodName: "run", argsSummary: "", initiatorModelId: "m",
    }))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {type: "agentNudge", text: "continue"}))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {
      type: "connectionRequest", requestId: "1:1", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "accepted",
    }))).toBe(true);
    expect(startsAgentTurn(record(0, agent, {
      type: "connectionRequest", requestId: "1:1", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "pending",
    }))).toBe(false);
  });
});

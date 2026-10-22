import {
  COMPACTION_TRIGGER_RATIO, SUGGESTED_MODELS, WORKERS_AI_OUTPUT_LIMIT, type AiChatMessage,
  type AiModelConfig, type ChatGadgetPinRecord,
} from "@gadgets/workshop-shared/api";
import {composeEpochChanges, type CodeChange} from "@gadgets/workshop-shared/code-change";
import type {Api, Message, Model} from "@earendil-works/pi-ai";
import type {ChatBindingEntry, CompactionCheckpoint} from "./storage-schema/overseer-storage";
import {zeroUsage} from "./ai-invoke";

// Assumed window for a model that SUGGESTED_MODELS doesn't list. A model whose real window is
// smaller still fails at the provider before compaction triggers.
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * How the turn divides the model's window. The reserved response capacity is both withheld from the
 * prompt's budget and sent as the response cap. A model may declare a smaller `compactionInputBudget`
 * when prompts near its full window are priced or paced worse; compaction then sizes against that
 * instead of the window. The config's own `compactionInputBudget` comes ahead of the model's, and
 * either is capped at what the window leaves for a prompt. A Cloudflare model configured by hand
 * has no SUGGESTED_MODELS entry to declare its reservation, so the provider's applies.
 */
export function getModelTokenLimits(config: AiModelConfig):
    {inputBudget: number, maxOutputTokens?: number} {
  let model = SUGGESTED_MODELS[config.provider][config.model];
  let maxOutputTokens = config.outputLimit ?? model?.outputLimit ??
      (config.provider === "cloudflare" ? WORKERS_AI_OUTPUT_LIMIT : undefined);
  let inputLimit = (config.contextWindow ?? model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW) -
      (maxOutputTokens ?? 0);
  return {
    inputBudget: Math.min(
        config.compactionInputBudget ?? model?.compactionInputBudget ?? inputLimit, inputLimit),
    maxOutputTokens,
  };
}

/**
 * True when the chat's newest message is `/compact`. Such a turn compacts and then ends instead of
 * prompting the model. Both the agent and the turn loop derive this from the log rather than
 * passing a flag, so a turn resumed after a restart still behaves the same.
 */
export function isCompactionTurn(messages: AiChatMessage[]): boolean {
  let last = messages.at(-1);
  return last?.type === "slashCommand" && last.request.id.builtin === true &&
      last.request.id.commandId === "compact";
}

/** A user or gadget message that prompted a turn, rather than one that steered a running turn. */
export function isTurnPrompt(message: AiChatMessage): boolean {
  return message.type === "message" && !message.steered &&
      (message.author.type === "user" || message.author.type === "gadget");
}

/**
 * A message that begins an agent turn: the user or a gadget prompted, a callback or nudge arrived,
 * or an accepted connection resumed the agent. Each produces a `user` model message, so cutting
 * here keeps the retained messages from opening mid-turn.
 */
export function startsAgentTurn(message: AiChatMessage): boolean {
  switch (message.type) {
    case "message": return isTurnPrompt(message);
    case "agentCallback": case "agentNudge": return true;
    case "connectionRequest": return message.state === "accepted";
    default: return false;
  }
}

/**
 * One batch of code changes, addressed by the chat sequence that recorded it. `change` is absent
 * for a batch that records only gadget creations or binding additions. `pins` are the batch's
 * declarations, each of which re-roots its gadget (see ChatGadgetPinRecord).
 */
export type ChangeBatch = {sequence: number, change?: CodeChange, pins?: ChatGadgetPinRecord[]};

/**
 * Folds `merge` and `revert` over a chat log. A merge accepts through `mergeThrough` inclusively; a
 * revert discards from `revertFrom` onward. `seed` carries batches already proposed before the log
 * begins, as a checkpoint records. Returns the batches still proposed, oldest first -- the single
 * rule both the proposed-changes view and a new checkpoint are derived from. (Accepted batches are
 * simply dropped: every accepted batch's content lives in commits from its epoch-closing merge on,
 * so nothing replays it.)
 */
export function foldProposedChanges(
    messages: Iterable<AiChatMessage>, seed: readonly ChangeBatch[] = []): ChangeBatch[] {
  let proposed = [...seed];
  for (let message of messages) {
    if (message.type === "changes") {
      // An empty conversion boundary (see AiChatMessageBody.conversionBoundary) proposes
      // nothing: the chat had no uncommitted legacy content to convert, and the boundary alone
      // must not make a read-only migrated chat show proposed changes. A boundary *with* a change
      // is an ordinary proposed batch.
      if (!message.conversionBoundary || message.change !== undefined) {
        proposed.push({sequence: message.sequence, change: message.change, pins: message.pins});
      }
    } else if (message.type === "merge") {
      while (proposed.length > 0 && proposed[0].sequence <= message.mergeThrough) {
        proposed.shift();
      }
    } else if (message.type === "revert") {
      while (proposed.length > 0 &&
             proposed[proposed.length - 1].sequence >= message.revertFrom) {
        proposed.pop();
      }
    }
  }
  return proposed;
}

/**
 * Marks the messages of a chat log (or log tail) that lie in merged or reverted ranges: the
 * single status rule shared by agent replay, chat-doc construction, and the merge/revert guards
 * in overseer.ts. The semantics mirror foldProposedChanges: processing is strictly in log order,
 * so a marking message affects only messages recorded *before* it; a merge accepts through
 * `mergeThrough` inclusively; a revert discards from `revertFrom` up to (not including) the
 * revert message itself; and the earliest marking wins. A "changes" message left unmarked is
 * still proposed. Non-"changes" messages in a range are marked too: replay uses that to elide
 * tool reads whose content was later reverted.
 */
export function chatChangeStatuses(
    messages: Iterable<AiChatMessage>): Map<number, "merged" | "reverted"> {
  let statuses = new Map<number, "merged" | "reverted">();
  let seen: number[] = [];
  let mark = (from: number, through: number, status: "merged" | "reverted") => {
    for (let sequence of seen) {
      if (sequence >= from && sequence <= through && !statuses.has(sequence)) {
        statuses.set(sequence, status);
      }
    }
  };
  for (let msg of messages) {
    if (msg.type === "merge") {
      mark(0, msg.mergeThrough, "merged");
    } else if (msg.type === "revert") {
      mark(msg.revertFrom, msg.sequence - 1, "reverted");
    }
    seen.push(msg.sequence);
  }
  return statuses;
}

/** One model message in the prompt, tagged with where it came from in the chat log. */
export type CompactionProjectionMessage = {
  message: Message;

  /**
   * The durable chat sequence that produced this message. System messages and an earlier summary
   * have no source sequence.
   */
  sequence?: number;

  /**
   * Set on the first model message a chat record contributes. The boundary cuts only here, so a
   * record's messages are never split: a tool result always keeps the call it answers, and the tail
   * opens on a user or assistant message.
   */
  canCut?: boolean;
};

/**
 * Fold state before `compactedTo` into a new checkpoint. `initialBindings` is the chat's seed
 * layer. `previous` already contains it, apart from the always-available resources the chat gained
 * since.
 */
export function buildCompactionState(
    messages: AiChatMessage[], compactedTo: number,
    initialBindings: [string, ChatBindingEntry][],
    previous: CompactionCheckpoint | undefined)
    : Omit<CompactionCheckpoint, "chatId" | "compactedTo" | "summary"> {
  let compacted = messages.filter(message => message.sequence < compactedTo);
  let chatBindings = new Map([...initialBindings, ...previous?.chatBindings ?? []]);
  let nextChangeId = previous?.nextChangeId ?? 0;

  for (let message of compacted) {
    if (message.type === "message") {
      for (let capsule of message.capsules ?? []) {
        if (capsule.bindingName !== undefined && !chatBindings.has(capsule.bindingName)) {
          chatBindings.set(capsule.bindingName, {type: "workpiece", id: capsule.gatekeeperId});
        }
      }
      for (let call of message.toolCalls ?? []) {
        if (call.error) continue;
        if (call.toolName === "createGadget" && call.output !== undefined) {
          chatBindings.set(call.input.bindingName, {type: "workpiece", id: call.output.gadgetId});
        } else if (call.toolName === "createWorktree" && call.output !== undefined) {
          chatBindings.set(call.input.bindingName,
              {type: "workpiece", id: call.output.worktreeId});
        } else if (call.toolName === "createExternalResource" && call.output !== undefined) {
          chatBindings.set(call.input.bindingName,
              {type: "workpiece", id: call.output.gatekeeperId});
        }
      }
    } else if (message.type === "agentCallback") {
      // The name was stamped when the call was appended; a message without one predates durable
      // calls and binds nothing (its arguments are gone).
      if (message.bindingName !== undefined) {
        chatBindings.set(message.bindingName, {type: "value", messageSequence: message.sequence});
      }
    } else if (message.type === "connectionRequest" && message.state === "accepted" &&
               message.gatekeeperId !== undefined && message.bindingName !== undefined) {
      if (!chatBindings.has(message.bindingName)) {
        chatBindings.set(message.bindingName, {type: "workpiece", id: message.gatekeeperId});
      }
    } else if (message.type === "changes") {
      for (let {gadgetId, bindingName} of message.createdGadgets ?? []) {
        if (!chatBindings.has(bindingName)) {
          chatBindings.set(bindingName, {type: "workpiece", id: gadgetId});
        }
      }
      for (let {worktreeId, bindingName} of message.createdWorktrees ?? []) {
        if (!chatBindings.has(bindingName)) {
          chatBindings.set(bindingName, {type: "workpiece", id: worktreeId});
        }
      }
      ++nextChangeId;
    }
  }

  return {
    chatBindings: [...chatBindings],
    nextChangeId,
    ...foldCompactedCode(messages, compactedTo, previous),
  };
}

/**
 * The part of a checkpoint that merges and reverts decide: the pins active at `compactedTo`, the
 * epoch it lies in, and the changes still proposed before it. `messages` start at `previous`'s
 * boundary and may run past `compactedTo`, so a revert recorded after the boundary still drops the
 * changes before it. That is how a revert refolds a checkpoint without touching its summary.
 */
export function foldCompactedCode(
    messages: AiChatMessage[], compactedTo: number, previous: CompactionCheckpoint | undefined)
    : Pick<CompactionCheckpoint, "pins" | "epoch" | "proposedChange"> {
  let compacted = messages.filter(message => message.sequence < compactedTo);

  // Pins active at the boundary, and the epoch it lies in: seeded from the previous checkpoint
  // and folded over the compacted span -- an epoch boundary (an epochBoundary merge, or a
  // migrated chat's conversionBoundary changes message) resets both, and a surviving "changes"
  // message's declarations accumulate. Statuses come from every message given, so a declaration
  // that a later revert discarded is dropped.
  let statuses = chatChangeStatuses(messages);
  let pins = new Map((previous?.pins ?? []).map(pin => [pin.gadgetId, pin] as const));
  let epoch = previous?.epoch;
  for (let message of compacted) {
    if (message.type === "merge" && message.epochBoundary) {
      pins.clear();
      epoch = message.sequence;
      // Merges from before worktrees pinned on modification re-pinned every worktree at the
      // boundary itself (see AiChatMessageBody.worktreePins) -- no later "changes" declaration
      // re-pins those lazily, so the checkpoint must carry them or post-compaction replay would
      // lose the worktrees' bases. Merges written now record no such pins.
      for (let pin of message.worktreePins ?? []) {
        pins.set(pin.worktreeId, {gadgetId: pin.worktreeId, baseCommit: pin.baseCommit});
      }
    } else if (message.type === "changes" && statuses.get(message.sequence) !== "reverted") {
      if (message.conversionBoundary) {
        pins.clear();
        epoch = message.sequence;
      }
      for (let pin of message.pins ?? []) pins.set(pin.gadgetId, pin);
    }
  }

  // Proposed changes stay addressable by sequence until a merge accepts them or a revert drops
  // them; the checkpoint carries their composition so replay needn't load the compacted
  // messages. A carried-forward prefix is addressed below every message in this span: the
  // previous checkpoint already folded it, so nothing here can accept or revert part of it.
  // Composition is bounded by content size, not edit count, so `proposedChange` can't grow with
  // history the way merged CRDT updates could. A declaration in the span re-roots its gadget,
  // dropping that gadget's part of what came before it, the carried-forward prefix included.
  // A later merge is not applied here, since replay applies it to the whole checkpoint, but a
  // later revert is: replay can't take back part of a composed change.
  let proposedChange = composeEpochChanges(foldProposedChanges(
      compacted,
      previous?.proposedChange !== undefined
          ? [{sequence: -1, change: previous.proposedChange}] : [])
      .filter(batch => statuses.get(batch.sequence) !== "reverted"));

  return {
    pins: pins.size === 0 ? undefined : [...pins.values()],
    epoch,
    proposedChange,
  };
}

import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import type { MicroActionCapability, MicroActionComposer } from "./action-contract.js";
import { getAgentId, record, sameKey, text } from "./action-values.js";

type SkillMentionDependencies = {
  host: ControlUiHost;
  sessions: () => readonly ControlUiSession[];
  composer: () => MicroActionComposer | null;
  assertCurrent: (generation: number, capability?: MicroActionCapability) => void;
  requireSession: (sessionKey: string | null, generation: number) => Promise<ControlUiSession>;
};

function missingSkillRequirements(skill: Record<string, unknown>): boolean {
  const missing = record(skill.missing);
  return Object.values(missing ?? {}).some((values) => Array.isArray(values) && values.length > 0);
}

function skillMentionTarget(value: string, caret: number): { start: number; end: number } | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  let start = safeCaret;
  while (start > 0 && /[-a-zA-Z0-9_:]/u.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  if (start === 0 || value[start - 1] !== "$") {
    return null;
  }
  let backslashes = 0;
  for (let cursor = start - 2; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  if (backslashes % 2 === 1) {
    return null;
  }
  let end = safeCaret;
  while (end < value.length && /[-a-zA-Z0-9_:]/u.test(value[end] ?? "")) {
    end += 1;
  }
  while (end > start && value[end - 1] === ":") {
    end -= 1;
  }
  return { start: start - 1, end };
}

export async function insertNativeSkillMention(
  dependencies: SkillMentionDependencies,
  sessionKey: string | null,
  requestedSkill: string,
  generation: number,
): Promise<string> {
  const { host } = dependencies;
  dependencies.assertCurrent(generation, "write");
  if (!sessionKey) {
    throw new Error("No conversation was captured for this skill binding.");
  }
  const configuredName = requestedSkill.trim();
  if (!configuredName) {
    throw new Error("Choose a skill name in the Codex Micro layout settings first.");
  }

  const composer = dependencies.composer();
  if (!composer || !sameKey(host, composer.props.sessionKey, sessionKey)) {
    throw new Error(
      "Open the captured conversation's native composer to insert this skill mention.",
    );
  }
  if (composer.props.sending) {
    throw new Error("The native composer is sending and cannot accept a skill mention right now.");
  }
  const textarea = composer.container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea || textarea.disabled || textarea.readOnly) {
    throw new Error("The captured conversation's native composer is unavailable or read-only.");
  }

  const session = await dependencies.requireSession(sessionKey, generation);
  dependencies.assertCurrent(generation, "write");
  const agentId =
    composer.props.agentId || session.agentId || getAgentId(sessionKey, dependencies.sessions());
  if (!agentId) {
    throw new Error(
      "OpenClaw could not identify the captured conversation's agent for skill checks.",
    );
  }
  const report = record(await host.request("skills.status", { agentId }));
  dependencies.assertCurrent(generation, "write");
  const candidates = Array.isArray(report?.skills)
    ? report.skills.flatMap((entry) => {
        const skill = record(entry);
        if (!skill) {
          return [];
        }
        const name = text(skill.name);
        const key = text(skill.skillKey);
        return name && key ? [{ skill, name, key }] : [];
      })
    : [];
  const normalizedName = configuredName.toLocaleLowerCase();
  const exactNameMatches = candidates.filter(
    ({ name }) => name.toLocaleLowerCase() === normalizedName,
  );
  const matches =
    exactNameMatches.length > 0
      ? exactNameMatches
      : candidates.filter(({ key }) => key.toLocaleLowerCase() === normalizedName);
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? `The skill name “${configuredName}” is ambiguous for this agent.`
        : `No native composer skill named “${configuredName}” is available for this agent.`,
    );
  }
  const selected = matches[0]!;
  const skill = selected.skill;
  if (skill.blockedByAllowlist === true || skill.blockedByAgentFilter === true) {
    throw new Error(
      `The skill “${selected.name}” is blocked by this agent's current skill policy.`,
    );
  }
  if (missingSkillRequirements(skill)) {
    throw new Error(
      `The skill “${selected.name}” is missing required dependencies or configuration; inspect it in Skills.`,
    );
  }
  if (skill.modelVisible !== true) {
    throw new Error(
      `The skill “${selected.name}” is not available as a native composer skill mention for this agent.`,
    );
  }
  const overrides = record(record(session.toolOverrides)?.skills);
  const hasOverride = Boolean(overrides && Object.hasOwn(overrides, selected.key));
  const enabled = hasOverride ? overrides?.[selected.key] === true : skill.disabled !== true;
  if (!enabled) {
    throw new Error(`The skill “${selected.name}” is disabled for this conversation.`);
  }

  let commandResult: unknown;
  try {
    commandResult = await host.request("commands.list", {
      agentId,
      sessionKey,
      includeArgs: true,
      scope: "text",
    });
  } catch {
    throw new Error(
      `Could not verify the native composer command for skill “${selected.name}”; no draft was changed.`,
    );
  }
  dependencies.assertCurrent(generation, "write");
  const commandEntries = record(commandResult)?.commands;
  const commandMatches = Array.isArray(commandEntries)
    ? commandEntries.flatMap((entry) => {
        const command = record(entry);
        const name = text(command?.name);
        if (!command || !name || command.source !== "skill" || command.skillModelVisible !== true) {
          return [];
        }
        const nativeName = text(command.nativeName);
        const displayName = text(command.skillDisplayName);
        const aliases = Array.isArray(command.textAliases)
          ? command.textAliases.filter((alias): alias is string => typeof alias === "string")
          : [];
        const skillNames = [selected.name, selected.key];
        const matchesSkill = [nativeName, displayName, ...aliases]
          .filter((candidate): candidate is string => Boolean(candidate))
          .some((candidate) =>
            skillNames.some(
              (skillName) => candidate.toLocaleLowerCase() === skillName.toLocaleLowerCase(),
            ),
          );
        return matchesSkill ? [{ name }] : [];
      })
    : [];
  if (commandMatches.length !== 1) {
    throw new Error(
      `The native composer does not expose one unambiguous command for skill “${selected.name}”.`,
    );
  }
  const commandName = commandMatches[0]!.name;

  const currentComposer = dependencies.composer();
  dependencies.assertCurrent(generation, "write");
  if (
    !currentComposer ||
    currentComposer.container !== composer.container ||
    !sameKey(host, currentComposer.props.sessionKey, sessionKey)
  ) {
    throw new Error(
      "The captured composer changed while the skill was being checked; nothing was inserted.",
    );
  }
  const currentDraft = textarea.value;
  const caret =
    typeof textarea.selectionStart === "number" ? textarea.selectionStart : currentDraft.length;
  const target = skillMentionTarget(currentDraft, caret);
  let nextDraft: string;
  if (target) {
    const replacement = `$${commandName}${target.end === currentDraft.length ? " " : ""}`;
    nextDraft = `${currentDraft.slice(0, target.start)}${replacement}${currentDraft.slice(target.end)}`;
  } else {
    const separator = currentDraft.length > 0 && !/\s$/u.test(currentDraft) ? " " : "";
    nextDraft = `${currentDraft}${separator}$${commandName} `;
  }
  currentComposer.props.setDraft(nextDraft);
  return `Inserted the native $${commandName} skill mention in the captured composer draft; it was not sent.`;
}

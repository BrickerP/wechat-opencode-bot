// The tools the WeChat orchestrators end a turn and talk to the user with. OpenCode loads this file as a server
// plugin from ~/.config/opencode/plugins/, where scripts/install-agents.sh links it into the deployed release. The
// tools only acknowledge: wechat-opencode-bot reads their calls from the session's messages
// (src/opencode/provider.ts). They are hidden from every other agent, subagents included.

/** The agents that get the tools: config/agents/wechat-orchestrator.md and wechat-orchestrator-read.md. */
const AGENTS = new Set(["wechat-orchestrator", "wechat-orchestrator-read"])
const REPORT = "wechat_report"
const REPLY = "wechat_reply"

const report = {
  name: REPORT,
  description:
    "End every turn with this, exactly once, as the last thing you do: the answer the user reads in WeChat and what " +
    "the bridge records. Nothing else you write reaches the user. Write nothing after it.",
  input: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["done", "needs_input", "blocked", "failed"],
        description:
          "done: answered or finished. needs_input: the reply asks the user something you need. blocked: something " +
          "out of your reach stops the work, such as an offline machine. failed: you could not do it. The reply says why.",
      },
      reply: { type: "string", description: "The whole answer for the user, plain text." },
      summary: { type: "string", description: "One line under 80 characters: what this turn did and its outcome." },
      memory: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
        description:
          "Durable facts for later tasks, each one line in Chinese: conclusion, reason, date. Start one with an id " +
          'from <memory> in brackets, such as "[mem_x] …", to replace that memory. Leave it out when there is nothing.',
      },
      files: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
        description: "Absolute paths of files in the workspace to send after the reply. Leave it out when there are none.",
      },
    },
    required: ["status", "reply", "summary"],
    additionalProperties: false,
  },
  options: { codemode: false },
  execute: async () => ({ content: "Reported. End your turn now: call no more tools and write nothing more." }),
}

const reply = {
  name: REPLY,
  description:
    "Send the user one short message now, while the work goes on: the scope you settled on, or what you check next. " +
    "At most twice a turn, and only when the work takes a while. It is never the answer: that goes in wechat_report.",
  input: {
    type: "object",
    properties: { text: { type: "string", description: "One or two sentences, plain text." } },
    required: ["text"],
    additionalProperties: false,
  },
  options: { codemode: false },
  execute: async () => ({ content: "Sent to the user. Go on with the work." }),
}

export default {
  id: "wechat-bridge",
  async setup(ctx) {
    // Set a default on new implementation delegations only. An explicit model in the brief (e.g. a project's
    // restricted provider), a resumed child, other agents, and ordinary OpenCode sessions retain their selection.
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "subagent" || event.agent !== "wechat-orchestrator" || event.input?.agent !== "wechat-general" ||
          event.input.sessionID || event.input.model) return
      const session = await ctx.session.get({ sessionID: event.sessionID })
      const model = session.metadata?.wechatGeneralModel
      if (typeof model === "string" && model) event.input = { ...event.input, model }
    })
    await ctx.tool.transform((editor) => {
      editor.add(report)
      editor.add(reply)
    })
    // Tools are global; every other agent's model calls go out without them.
    await ctx.session.hook("context", (event) => {
      if (AGENTS.has(event.agent)) return
      delete event.tools[REPORT]
      delete event.tools[REPLY]
    })
  },
}

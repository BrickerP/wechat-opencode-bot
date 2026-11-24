// plugin/wechat-bridge.js, the OpenCode server plugin that gives the orchestrators wechat_report and wechat_reply: it
// registers both with the schemas the bridge reads, acknowledges each call, and hides both from every other agent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'owb-bridge-plugin-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { BRIDGE_PLUGIN, REPLY_TOOL, REPORT_STATUSES, REPORT_TOOL } = await import('../opencode/provider.js');
const { ORCHESTRATOR_AGENT, ORCHESTRATOR_READ_AGENT } = await import('../orchestrator.js');
// Plain JavaScript that OpenCode loads as it is: from dist/tests, two levels up is the repository.
const plugin = (await import(new URL('../../plugin/wechat-bridge.js', import.meta.url).href)).default;

after(() => rmSync(tmp, { recursive: true, force: true }));

/** What setup registers through a fake plugin context: the tools added and the session hooks. */
async function load(generalModel?: string) {
  const tools: any[] = [];
  const hooks = new Map<string, (event: any) => void | Promise<void>>();
  const registration = { dispose: async () => {} };
  await plugin.setup({
    tool: {
      hook: async (name: string, cb: (event: any) => Promise<void>) => { hooks.set(name, cb); return registration; },
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: unknown) => void tools.push(tool) });
        return registration;
      },
    },
    session: {
      get: async () => ({ metadata: { wechatGeneralModel: generalModel } }),
      hook: async (name: string, callback: (event: any) => void | Promise<void>) => {
        hooks.set(name, callback);
        return registration;
      },
    },
  });
  return { tools, hooks };
}

test('the plugin adds wechat_report and wechat_reply, with the fields the bridge reads', async () => {
  const { tools } = await load();
  assert.equal(plugin.id, BRIDGE_PLUGIN);
  assert.deepEqual(tools.map((tool) => tool.name), [REPORT_TOOL, REPLY_TOOL]);
  const [report, reply] = tools;
  assert.deepEqual(report.input.required, ['status', 'reply', 'summary']);
  assert.deepEqual(report.input.properties.status.enum, [...REPORT_STATUSES]);
  assert.deepEqual([report.input.properties.memory.maxItems, report.input.properties.files.maxItems], [5, 3]);
  assert.deepEqual(reply.input.required, ['text']);
  for (const tool of tools) {
    assert.equal(tool.input.additionalProperties, false, tool.name);
    assert.deepEqual(tool.options, { codemode: false }, `${tool.name}: called directly, never from Code Mode`);
    assert.ok(tool.description.length > 40, tool.name);
    const out = await tool.execute({}, {});
    assert.equal(typeof out.content, 'string', `${tool.name} only acknowledges`);
  }
  assert.match((await report.execute({}, {})).content, /End your turn now/);
});

test('only a new implementation delegation with a role model gets an override', async () => {
  const root = { agent: ORCHESTRATOR_AGENT, tool: 'subagent', sessionID: 'ses_test' };
  for (const model of [undefined, 'provider/writer']) {
    const { hooks } = await load(model);
    for (const input of [{ agent: 'wechat-general' }, { agent: 'wechat-general', model: 'internal/only' },
      { agent: 'wechat-general', sessionID: 'ses_child' }, { agent: 'wechat-explore' }]) {
      const event = { ...root, input: { ...input } };
      await hooks.get('execute.before')!(event);
      assert.equal(event.input.model, input.model ?? (input.agent === 'wechat-general' && !input.sessionID ? model : undefined));
    }
  }
});

test('every agent but the two orchestrators makes its model calls without the tools', async () => {
  const { hooks } = await load();
  const context = hooks.get('context');
  assert.ok(context, 'a context hook');
  const offered = async (agent: string) => {
    const event = { agent, tools: { [REPORT_TOOL]: {}, [REPLY_TOOL]: {}, read: {}, subagent: {} } };
    await context(event);
    return Object.keys(event.tools);
  };
  for (const agent of [ORCHESTRATOR_AGENT, ORCHESTRATOR_READ_AGENT]) {
    assert.deepEqual(await offered(agent), [REPORT_TOOL, REPLY_TOOL, 'read', 'subagent'], agent);
  }
  for (const agent of ['wechat-explore', 'wechat-general', 'build']) {
    assert.deepEqual(await offered(agent), ['read', 'subagent'], agent);
  }
});

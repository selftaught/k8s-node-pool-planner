import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseToml, deepMerge, cpuMillis, memMiB, sandboxPods } from './presets.js';

test('parses the TOML subset presets.toml uses', () => {
	const t = parseToml(`
# comment
top = "x"  # trailing
n = 5
f = 1.5
b = true
node_selector = { workload = "sandbox" }
list = [
    { port = 8000, name = "laravel", public = true },
    { port = 22, name = "ssh" },
]
res = { cpu = "1", requests = { cpu = "150m" } }

[presets.a-b]
image = 'lit'
cmd = ["/x"]
[presets.a-b.sub]
k = "v"
`);
	assert.equal(t.top, 'x'); assert.equal(t.n, 5); assert.equal(t.f, 1.5); assert.equal(t.b, true);
	assert.deepEqual(t.node_selector, { workload: 'sandbox' });
	assert.equal(t.list.length, 2); assert.equal(t.list[1].name, 'ssh');
	assert.equal(t.res.requests.cpu, '150m');
	assert.equal(t.presets['a-b'].image, 'lit'); assert.equal(t.presets['a-b'].sub.k, 'v');
});
test('reports the line of a syntax error', () => {
	assert.throws(() => parseToml('a = 1\nb = \n'), /line 2/);
});
test('quantities', () => {
	assert.equal(cpuMillis('1'), 1000); assert.equal(cpuMillis('150m'), 150); assert.equal(cpuMillis('0.5'), 500);
	assert.equal(memMiB('3Gi'), 3072); assert.equal(memMiB('1536Mi'), 1536); assert.equal(memMiB('1G'), 954);
});
test('a layer replaces keys, tables merge', () => {
	const m = deepMerge({ a: { x: 1, y: 2 }, l: [1] }, { a: { y: 3 }, l: [2, 3] });
	assert.deepEqual(m, { a: { x: 1, y: 3 }, l: [2, 3] });
});
test('sandbox pod = sandbox + caddy, agent pod = agent + ssh relay; requests default to limits', () => {
	const cfg = parseToml(`
default_preset = "p"
caddy_resources = { cpu = "100m", memory = "128Mi", requests = { memory = "48Mi" } }
ssh_forward_resources = { cpu = "50m", memory = "96Mi", requests = { memory = "32Mi" } }
node_selector = { workload = "sandbox" }
[presets.p]
caddy = true
resources = { cpu = "1", memory = "3Gi", requests = { cpu = "150m", memory = "1536Mi" } }
agent = { resources = { cpu = "1", memory = "2Gi", requests = { cpu = "100m", memory = "512Mi" } } }
`);
	const r = sandboxPods(cfg);
	assert.deepEqual(r.pods[0], { name: 'sandbox', cpuReq: 250, memReq: 1584, cpuLim: 1100, memLim: 3200 });
	assert.deepEqual(r.pods[1], { name: 'agent', cpuReq: 150, memReq: 544, cpuLim: 1050, memLim: 2144 });
	assert.deepEqual(r.nodeSelector, { workload: 'sandbox' });
	assert.throws(() => sandboxPods(cfg, 'nope'), /no preset named/);
});
const real = '../kapps-api/config/base/kapps/presets.toml';
test('parses the real kapps-api presets.toml', { skip: !existsSync(real) }, () => {
	const cfg = parseToml(readFileSync(real, 'utf8'));
	const r = sandboxPods(cfg);
	assert.equal(r.presetName, cfg.default_preset); assert.equal(r.pods.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, fitPerNode, costs, poolCapacity, poolWaste, activeReplicas, maxApps, minNodes } from './planner.js';

const pool = (o = {}) => ({ id: 'p1', providerId: 'oci', shapeId: 'VM.Standard.E4.Flex', units: 2, memPerUnit: 8,
	count: 2, sysCpu: 0, sysMem: 0, dsCpu: 0, dsMem: 0, maxPods: 110, ...o });
const w = (o = {}) => ({ id: 'a', cpuReq: 500, cpuLim: 1000, memReq: 1024, memLim: 2048, replicas: 1, pool: '', ...o });

test('capacity: E4 2 OCPU = 4 vCPU, 16 GB', () => {
	const c = poolCapacity(pool());
	assert.equal(c.vcpu, 4); assert.equal(c.memGB, 16);
});
test('fit per node is limited by the tightest resource', () => {
	const f = fitPerNode(pool(), w({ cpuReq: 1000, memReq: 1024 }));
	assert.equal(f.n, 4); assert.equal(f.limiter, 'cpu');
});
test('pack spills to extra nodes and reports the count', () => {
	const r = pack({ pools: [pool()], workloads: [w({ cpuReq: 1000, replicas: 10 })] });
	assert.equal(r.scheduled.a, 8); assert.equal(r.unscheduled.a, 2); assert.equal(r.extraNodes.p1, 1);
});
test('pool pinning is respected', () => {
	const r = pack({ pools: [pool(), pool({ id: 'p2' })], workloads: [w({ pool: 'p2', replicas: 3 })] });
	assert.equal(r.nodes.p1.flatMap((n) => n.pods).length, 0);
	assert.equal(r.nodes.p2.flatMap((n) => n.pods).length, 3);
});
test('cost: 2 OCPU + 16 GB E4 = 2*0.025+16*0.0015 per hour', () => {
	const c = costs({ pools: [pool({ count: 1 })], workloads: [], clusterFees: { oci: 'basic' } });
	assert.ok(Math.abs(c.pools.p1.nodeHourly - 0.074) < 1e-9);
});

test('active % scales replicas that can scale to zero, not always-on ones', () => {
	const plan = { activePct: 25, pools: [pool()], workloads: [w({ replicas: 10 }), w({ id: 'b', replicas: 10, scaleToZero: false })] };
	assert.equal(activeReplicas(plan, plan.workloads[0]), 3);
	assert.equal(activeReplicas(plan, plan.workloads[1]), 10);
	const r = pack(plan);
	assert.equal((r.scheduled.a || 0) + (r.unscheduled.a || 0), 3);
});

test('maxApps finds the largest app count that fits and shrinks as activity rises', () => {
	const mk = (activePct) => ({ activePct, pools: [pool({ count: 2 })], workloads: [w({ perApp: 1, cpuReq: 1000, memReq: 100 })] });
	// 2 nodes x 4 vCPU = 8 pods at 100% active; 10% active fits 80
	assert.equal(maxApps(mk(100)).max, 8);
	assert.equal(maxApps(mk(10)).max, 80);
	assert.equal(maxApps(mk(100)).bottleneck.resource, 'cpu');
});
test('always-on per-app workloads do not shrink with the active %', () => {
	const plan = { activePct: 10, pools: [pool({ count: 2 })], workloads: [w({ perApp: 1, scaleToZero: false, cpuReq: 1000, memReq: 100 })] };
	assert.equal(maxApps(plan).max, 8);
});

test('minNodes: smallest node count per pool that schedules every active replica', () => {
	// 4 vCPU nodes: 10 x 1000m pods need 3 nodes, whatever the current count is
	const r = minNodes({ pools: [pool({ count: 9 })], workloads: [w({ cpuReq: 1000, memReq: 100, replicas: 10 })] });
	assert.equal(r.pools.p1.min, 3); assert.equal(r.pools.p1.current, 9); assert.equal(r.totalMin, 3);
	assert.deepEqual(r.unplaceable, {});
});
test('minNodes: pinned work gets its own pool, loose work fills open room before opening a node', () => {
	const plan = { pools: [pool(), pool({ id: 'p2' })], workloads: [
		w({ id: 'pin', pool: 'p2', cpuReq: 3000, memReq: 100, replicas: 1 }),
		w({ id: 'any', cpuReq: 1000, memReq: 100, replicas: 1 })] };
	const r = minNodes(plan);
	assert.equal(r.pools.p2.min, 1); assert.equal(r.pools.p1.min, 0); assert.equal(r.totalMin, 1);
});
test('minNodes: honours active % and reports replicas bigger than a node', () => {
	const r = minNodes({ activePct: 50, pools: [pool()], workloads: [
		w({ cpuReq: 1000, memReq: 100, replicas: 8 }), w({ id: 'huge', cpuReq: 99999, replicas: 1, scaleToZero: false })] });
	assert.equal(r.pools.p1.min, 1); assert.equal(r.unplaceable.huge, 1);
});
test('poolWaste: splits each node into requested, node overhead and unrequested, priced per OCPU and GB', () => {
	// E4 2 OCPU = 4 vCPU / 16 GB at $0.025/OCPU-hr + $0.0015/GB-hr
	const p = pool({ count: 1, sysCpu: 300, sysMem: 724, dsCpu: 200, dsMem: 300 });
	const plan = { pools: [p], workloads: [w({ cpuReq: 1000, memReq: 2048, replicas: 1 })] };
	const x = poolWaste(p, pack(plan).nodes.p1);
	assert.equal(x.overheadCpu, 500); assert.equal(x.overheadMem, 1024);
	assert.equal(x.idleCpu, 2500); assert.equal(x.idleMem, 13312);
	const perMilli = (2 * 0.025 * 730) / 4000, perMiB = (16 * 0.0015 * 730) / 16384;
	assert.ok(Math.abs(x.idleMonthly - (2500 * perMilli + 13312 * perMiB)) < 1e-9);
	assert.ok(Math.abs(x.monthly - (2 * 0.025 + 16 * 0.0015) * 730) < 1e-9);
	assert.equal(poolWaste(p, []).idleMonthly, 0);
});
test('minNodes: returns the packed nodes so waste can be measured at the minimum', () => {
	const r = minNodes({ pools: [pool({ count: 9 })], workloads: [w({ cpuReq: 1000, memReq: 100, replicas: 10 })] });
	assert.equal(r.pools.p1.nodes.length, 3);
	assert.equal(poolWaste(pool(), r.pools.p1.nodes).idleCpu, 3 * 4000 - 10 * 1000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, fitPerNode, costs, poolCapacity, activeReplicas } from './planner.js';

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

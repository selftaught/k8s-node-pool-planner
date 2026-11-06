// Pure planning math: no DOM, no provider specifics beyond the provider objects passed in.
// Units: CPU in millicores, memory in MiB. Node sizes arrive as vCPU / GB(=GiB).
import { getProvider, getShape, nodeHourly, HOURS_PER_MONTH } from './providers/index.js';

export function poolCapacity(pool) {
	const shape = getShape(getProvider(pool.providerId), pool.shapeId);
	const vcpu = pool.units * shape.vcpuPerUnit;
	const memGB = shape.flex ? pool.units * pool.memPerUnit : shape.fixedMemGB;
	const cpu = vcpu * 1000;
	const mem = memGB * 1024;
	return {
		vcpu, memGB, cpu, mem,
		allocCpu: Math.max(0, cpu - pool.sysCpu - pool.dsCpu),
		allocMem: Math.max(0, mem - pool.sysMem - pool.dsMem),
		maxPods: pool.maxPods,
	};
}

/** How many replicas of one workload fit on a single empty node of the pool (requests-based). */
export function fitPerNode(pool, w) {
	const c = poolCapacity(pool);
	const byCpu = w.cpuReq > 0 ? Math.floor(c.allocCpu / w.cpuReq) : Infinity;
	const byMem = w.memReq > 0 ? Math.floor(c.allocMem / w.memReq) : Infinity;
	const byPods = c.maxPods;
	const n = Math.min(byCpu, byMem, byPods);
	const limiter = n === byCpu ? 'cpu' : n === byMem ? 'memory' : 'pods';
	return { n: Number.isFinite(n) ? n : 0, limiter, byCpu, byMem, byPods };
}

const newNode = (pool, cap, index, extra = false) => ({
	poolId: pool.id, index, extra, cap,
	cpuFree: cap.allocCpu, memFree: cap.allocMem, podsFree: cap.maxPods,
	pods: [], reqCpu: 0, reqMem: 0, limCpu: 0, limMem: 0,
});

function place(node, w) {
	node.cpuFree -= w.cpuReq; node.memFree -= w.memReq; node.podsFree -= 1;
	node.reqCpu += w.cpuReq; node.reqMem += w.memReq;
	node.limCpu += Math.max(w.cpuLim || 0, w.cpuReq); node.limMem += Math.max(w.memLim || 0, w.memReq);
	node.pods.push(w.id);
}
const fits = (n, w) => n.cpuFree >= w.cpuReq && n.memFree >= w.memReq && n.podsFree >= 1;

/**
 * First-fit-decreasing bin packing of every replica onto the pools' existing nodes.
 * A workload with a pool set only lands there; otherwise any pool, in order.
 * Replicas that don't fit are "unscheduled"; they are then packed onto extra (virtual) nodes
 * to compute how many more nodes each pool would need.
 */
export function pack(plan) {
	const pools = plan.pools;
	const caps = Object.fromEntries(pools.map((p) => [p.id, poolCapacity(p)]));
	const nodes = [];
	const byPool = Object.fromEntries(pools.map((p) => [p.id, []]));
	for (const p of pools) {
		for (let i = 0; i < p.count; i++) {
			const n = newNode(p, caps[p.id], i);
			nodes.push(n); byPool[p.id].push(n);
		}
	}
	const pods = [];
	for (const w of plan.workloads) for (let r = 0; r < w.replicas; r++) pods.push(w);
	// dominant resource share against the biggest pool, largest first
	const ref = pools.length ? caps[pools[0].id] : { allocCpu: 1, allocMem: 1 };
	const weight = (w) => Math.max(w.cpuReq / (ref.allocCpu || 1), w.memReq / (ref.allocMem || 1));
	pods.sort((a, b) => weight(b) - weight(a));

	const scheduled = {}; const unscheduled = {}; const unplaceable = {};
	const targets = (w) => (w.pool ? pools.filter((p) => p.id === w.pool) : pools);
	const leftovers = [];
	for (const w of pods) {
		let done = false;
		for (const p of targets(w)) {
			const node = byPool[p.id].find((n) => fits(n, w));
			if (node) { place(node, w); scheduled[w.id] = (scheduled[w.id] || 0) + 1; done = true; break; }
		}
		if (!done) { unscheduled[w.id] = (unscheduled[w.id] || 0) + 1; leftovers.push(w); }
	}
	const extra = Object.fromEntries(pools.map((p) => [p.id, 0]));
	for (const w of leftovers) {
		const p = targets(w)[0];
		if (!p) { unplaceable[w.id] = (unplaceable[w.id] || 0) + 1; continue; }
		let node = byPool[p.id].find((n) => n.extra && fits(n, w));
		if (!node) {
			node = newNode(p, caps[p.id], byPool[p.id].length, true);
			if (!fits(node, w)) { unplaceable[w.id] = (unplaceable[w.id] || 0) + 1; continue; } // bigger than a node
			byPool[p.id].push(node); extra[p.id]++;
		}
		place(node, w);
	}
	return { caps, nodes: byPool, scheduled, unscheduled, unplaceable, extraNodes: extra };
}

/** Cost per pool + totals (monthly). */
export function costs(plan) {
	const out = { pools: {}, clusterFees: [], monthly: 0, hourly: 0 };
	for (const p of plan.pools) {
		const provider = getProvider(p.providerId);
		const shape = getShape(provider, p.shapeId);
		const cap = poolCapacity(p);
		const nodeH = nodeHourly(provider, shape, cap.vcpu, cap.memGB, { unitPrice: p.unitPrice, gbPrice: p.gbPrice });
		out.pools[p.id] = { nodeHourly: nodeH, nodeMonthly: nodeH * HOURS_PER_MONTH, monthly: nodeH * HOURS_PER_MONTH * p.count, currency: provider.currency };
		out.hourly += nodeH * p.count;
	}
	for (const providerId of new Set(plan.pools.map((p) => p.providerId))) {
		const provider = getProvider(providerId);
		const fee = provider.clusterFees?.find((f) => f.id === plan.clusterFees?.[providerId]) || provider.clusterFees?.[0];
		if (fee) { out.clusterFees.push({ providerId, name: fee.name, monthly: fee.hourly * HOURS_PER_MONTH }); out.hourly += fee.hourly; }
	}
	out.monthly = out.hourly * HOURS_PER_MONTH;
	return out;
}

/** Utilisation summary for a pool from a pack() result. */
export function poolUsage(pool, packed) {
	const nodes = packed.nodes[pool.id].filter((n) => !n.extra);
	const cap = packed.caps[pool.id];
	const n = nodes.length || 1;
	const sum = (k) => nodes.reduce((a, x) => a + x[k], 0);
	return {
		cpuReqPct: (sum('reqCpu') / (cap.allocCpu * n)) * 100,
		memReqPct: (sum('reqMem') / (cap.allocMem * n)) * 100,
		cpuLimPct: (sum('limCpu') / (cap.allocCpu * n)) * 100,
		memLimPct: (sum('limMem') / (cap.allocMem * n)) * 100,
		pods: nodes.reduce((a, x) => a + x.pods.length, 0),
	};
}

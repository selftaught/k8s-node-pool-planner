// Pure planning math: no DOM, no provider specifics beyond the provider objects passed in.
// Units: CPU in millicores, memory in MiB. Node sizes arrive as vCPU / GB(=GiB).
import { getProvider, getShape, nodeHourly, HOURS_PER_MONTH } from './providers/index.js';

/** Replicas that exist. A workload with perApp > 0 scales with the plan's app count (when one is set). */
export function totalReplicas(plan, w) {
	return w.perApp > 0 && plan.appCount != null ? Math.round(plan.appCount * w.perApp) : w.replicas;
}

/** Replicas expected to be running. Workloads that scale to zero follow the plan's active %; others stay fully up. */
export function activeReplicas(plan, w) {
	const total = totalReplicas(plan, w);
	if (w.scaleToZero === false) return total;
	const pct = Math.min(100, Math.max(0, plan.activePct ?? 100));
	return Math.ceil((total * pct) / 100 - 1e-9);
}

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
	for (const w of plan.workloads) for (let r = 0; r < activeReplicas(plan, w); r++) pods.push(w);
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
	// Negotiated/committed discount off the whole bill (nodes and cluster fees), 0-100.
	const d = Math.min(100, Math.max(0, Number(plan.discountPct) || 0)) / 100;
	out.discountPct = d * 100;
	out.listMonthly = out.hourly * HOURS_PER_MONTH;
	out.discountMonthly = out.listMonthly * d;
	out.monthly = out.listMonthly - out.discountMonthly;
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

const MAX_APPS = 100000;

/**
 * Largest app count (workloads with perApp > 0 scale with it) whose active pods all fit the pools'
 * existing nodes, at the given active %. Returns { max, capped, fixedFits, bottleneck }.
 * max = -1 when even zero apps don't fit (the fixed workloads alone are too big).
 */
export function maxApps(plan, activePct = plan.activePct ?? 100) {
	const fits = (n) => Object.keys(pack({ ...plan, activePct, appCount: n }).unscheduled).length === 0;
	if (!fits(0)) return { max: -1, capped: false, fixedFits: false };
	let hi = 1;
	while (hi < MAX_APPS && fits(hi)) hi *= 2;
	if (hi >= MAX_APPS && fits(hi)) return { max: hi, capped: true, fixedFits: true };
	let lo = hi >> 1; // fits(lo) holds (or lo = 0)
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
	// What ran out at lo + 1: the pool the first unplaced workload targets, and its tighter resource.
	const over = { ...plan, activePct, appCount: lo + 1 };
	const r = pack(over);
	const w = over.workloads.find((x) => r.unscheduled[x.id]);
	const pool = (w && plan.pools.find((x) => x.id === w.pool)) || plan.pools[0];
	let bottleneck = null;
	if (pool) {
		const u = poolUsage(pool, r);
		const cap = r.caps[pool.id];
		const podPct = (u.pods / (cap.maxPods * Math.max(1, pool.count))) * 100;
		const opts = [['cpu', u.cpuReqPct], ['memory', u.memReqPct], ['pods', podPct]];
		const [resource, pct] = opts.sort((a, b) => b[1] - a[1])[0];
		bottleneck = { pool: pool.name, resource, pct };
	}
	return { max: lo, capped: false, fixedFits: true, bottleneck };
}

/**
 * Minimum nodes each pool needs so every active replica is scheduled (requests-based), starting from
 * empty pools: the current node counts are ignored. Pinned workloads are packed into their own pool
 * first; workloads for "any pool" then fill the room already open in any pool (pool order) and only
 * open a new node, in the first pool where one fits, when nothing has room.
 * Returns { pools: { [id]: { min, current } }, totalMin, totalCurrent, unplaceable: { [workloadId]: n } }.
 * unplaceable replicas are bigger than an empty node of every pool they may run on.
 */
export function minNodes(plan) {
	const pools = plan.pools;
	const caps = Object.fromEntries(pools.map((p) => [p.id, poolCapacity(p)]));
	const byPool = Object.fromEntries(pools.map((p) => [p.id, []]));
	const pods = [];
	for (const w of plan.workloads) for (let r = 0; r < activeReplicas(plan, w); r++) pods.push(w);
	const ref = pools.length ? caps[pools[0].id] : { allocCpu: 1, allocMem: 1 };
	const weight = (w) => Math.max(w.cpuReq / (ref.allocCpu || 1), w.memReq / (ref.allocMem || 1));
	pods.sort((a, b) => weight(b) - weight(a));

	const unplaceable = {};
	const lost = (w) => { unplaceable[w.id] = (unplaceable[w.id] || 0) + 1; };
	const open = (p, w) => {
		const node = newNode(p, caps[p.id], byPool[p.id].length);
		if (!fits(node, w)) return false;
		byPool[p.id].push(node); place(node, w); return true;
	};
	const pinned = pods.filter((w) => w.pool && pools.some((p) => p.id === w.pool));
	// a workload naming a pool that no longer exists cannot run anywhere
	for (const w of pods) if (w.pool && !pools.some((p) => p.id === w.pool)) lost(w);
	const loose = pods.filter((w) => !w.pool);
	for (const w of pinned) {
		const p = pools.find((x) => x.id === w.pool);
		const node = byPool[p.id].find((n) => fits(n, w));
		if (node) place(node, w); else if (!open(p, w)) lost(w);
	}
	for (const w of loose) {
		let done = false;
		for (const p of pools) {
			const node = byPool[p.id].find((n) => fits(n, w));
			if (node) { place(node, w); done = true; break; }
		}
		if (!done) for (const p of pools) if (open(p, w)) { done = true; break; }
		if (!done) lost(w);
	}
	const out = Object.fromEntries(pools.map((p) => [p.id, { min: byPool[p.id].length, current: p.count }]));
	return {
		pools: out,
		totalMin: Object.values(out).reduce((a, x) => a + x.min, 0),
		totalCurrent: pools.reduce((a, p) => a + p.count, 0),
		unplaceable,
	};
}

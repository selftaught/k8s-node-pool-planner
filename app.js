import { PROVIDERS, getProvider, getShape, HOURS_PER_MONTH } from './providers/index.js';
import { pack, costs, fitPerNode, poolCapacity, poolUsage, poolWaste, activeReplicas, totalReplicas, maxApps, minNodes } from './planner.js';

import { parseToml, deepMerge, sandboxPods } from './presets.js';

const KEY = 'nodepool-planner:v1';
const COLORS = ['#4f8cff', '#3ecf8e', '#f5b84b', '#b07cff', '#ff7a8a', '#36c5d6', '#e8893a', '#9acd32'];
const uid = () => Math.random().toString(36).slice(2, 8);
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (n, cur = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: n < 10 ? 3 : 0 }).format(n);
const vcpus = (m) => fmt(m / 1000, 1) + ' vCPU';
const gbs = (mib) => fmt(mib / 1024, 1) + ' GB';

function newPool(over = {}) {
	const provider = PROVIDERS[0];
	const shape = provider.shapes[0];
	return {
		id: uid(), name: 'pool-' + uid().slice(0, 3), providerId: provider.id, shapeId: shape.id,
		units: shape.defaultUnits, memPerUnit: shape.defaultMemPerUnit, count: 3,
		sysCpu: 150, sysMem: 800, dsCpu: 200, dsMem: 300, maxPods: 110, ...over,
	};
}
let colorIdx = 0;
function newWorkload(over = {}) {
	return { id: uid(), name: 'app-' + uid().slice(0, 3), cpuReq: 250, cpuLim: 500, memReq: 512, memLim: 1024, replicas: 3, pool: '', color: COLORS[colorIdx++ % COLORS.length], ...over };
}
function example() {
	const general = newPool({ id: 'general', name: 'general', units: 4, memPerUnit: 8, count: 4 });
	const memory = newPool({ id: 'memory', name: 'memory-heavy', shapeId: 'VM.Standard.E5.Flex', units: 4, memPerUnit: 16, count: 2 });
	const arm = newPool({ id: 'arm', name: 'arm-cheap', shapeId: 'VM.Standard.A1.Flex', units: 4, memPerUnit: 6, count: 2 });
	return {
		clusterFees: { oci: 'enhanced' }, pools: [general, memory, arm],
		workloads: [
			newWorkload({ name: 'api', cpuReq: 500, cpuLim: 1000, memReq: 768, memLim: 1024, replicas: 12, pool: 'general' }),
			newWorkload({ name: 'worker', cpuReq: 250, cpuLim: 500, memReq: 512, memLim: 1024, replicas: 20, pool: '' }),
			newWorkload({ name: 'cache', cpuReq: 500, cpuLim: 1000, memReq: 6144, memLim: 8192, replicas: 4, pool: 'memory' }),
			newWorkload({ name: 'cron-arm', cpuReq: 100, cpuLim: 200, memReq: 256, memLim: 256, replicas: 10, pool: 'arm' }),
		],
	};
}

let plan = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || example(); } catch { return example(); } })();
const save = () => localStorage.setItem(KEY, JSON.stringify(plan));

// ---------- form helpers ----------
function field(obj, key, label, { type = 'number', min = 0, step = 1, onchange, wide = false, options } = {}) {
	const l = document.createElement('label');
	if (wide) l.className = 'wide';
	l.append(label);
	let el;
	if (options) {
		el = document.createElement('select');
		for (const [v, t] of options) el.add(new Option(t, v, false, v === obj[key]));
	} else {
		el = document.createElement('input');
		el.type = type; el.value = obj[key];
		if (type === 'number') { el.min = min; el.step = step; }
	}
	el.addEventListener('input', () => {
		obj[key] = options ? el.value : type === 'number' ? Math.max(min, Number(el.value) || 0) : el.value;
		save();
		if (onchange) onchange(); else renderResults();
	});
	l.append(el);
	return l;
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

// ---------- editors ----------
function renderPools() {
	const root = $('#pools'); root.innerHTML = '';
	for (const pool of plan.pools) {
		const provider = getProvider(pool.providerId);
		const shape = getShape(provider, pool.shapeId);
		const card = el('div', 'card');
		const head = el('div', 'head');
		const name = field(pool, 'name', '', { type: 'text', onchange: () => { renderWorkloads(); renderResults(); } }).querySelector('input');
		const del = el('button', 'x', '✕'); del.title = 'Remove pool';
		del.onclick = () => { plan.pools = plan.pools.filter((p) => p !== pool); plan.workloads.forEach((w) => { if (w.pool === pool.id) w.pool = ''; }); save(); renderAll(); };
		head.append(name, del);

		const g = el('div', 'grid');
		g.append(
			field(pool, 'providerId', 'Provider', { options: PROVIDERS.map((p) => [p.id, p.name]), onchange: () => {
				const s = getProvider(pool.providerId).shapes[0];
				Object.assign(pool, { shapeId: s.id, units: s.defaultUnits, memPerUnit: s.defaultMemPerUnit, unitPrice: undefined, gbPrice: undefined });
				save(); renderAll();
			}, wide: true }),
			field(pool, 'shapeId', 'Shape', { options: provider.shapes.map((s) => [s.id, s.name]), onchange: () => {
				const s = getShape(provider, pool.shapeId);
				Object.assign(pool, { units: s.defaultUnits, memPerUnit: s.defaultMemPerUnit ?? 0, unitPrice: undefined, gbPrice: undefined });
				save(); renderAll();
			}, wide: true }),
			field(pool, 'count', 'Nodes', { min: 0 }),
		);
		if (shape.flex) {
			g.append(
				field(pool, 'units', `${shape.unitLabel}s per node (${shape.vcpuPerUnit} vCPU each)`, { min: shape.minUnits }),
				field(pool, 'memPerUnit', 'GB RAM per ' + shape.unitLabel, { min: 1 }),
			);
		}
		const adv = el('details'); adv.innerHTML = '<summary>Reserved, overhead &amp; pricing</summary>';
		const ag = el('div', 'grid');
		ag.append(
			field(pool, 'sysCpu', 'System reserved CPU (m)'), field(pool, 'sysMem', 'System reserved mem (MiB)'),
			field(pool, 'dsCpu', 'DaemonSet CPU (m)'), field(pool, 'dsMem', 'DaemonSet mem (MiB)'),
			field(pool, 'maxPods', 'Max pods / node'),
		);
		const up = { ...pool, unitPrice: pool.unitPrice ?? shape.unitPrice, gbPrice: pool.gbPrice ?? shape.gbPrice };
		for (const [k, label] of [['unitPrice', `$/${shape.unitLabel}-hr`], ['gbPrice', '$/GB-hr']]) {
			const f = field(up, k, label, { step: 0.0001, onchange: () => { pool[k] = up[k]; save(); renderResults(); } });
			ag.append(f);
		}
		adv.append(ag);
		const d = el('div', 'derived'); d.id = 'derived-' + pool.id;
		card.append(head, g, adv, d);
		root.append(card);
	}
}

function renderWorkloads() {
	const root = $('#workloads'); root.innerHTML = '';
	for (const w of plan.workloads) {
		const card = el('div', 'card');
		const head = el('div', 'head');
		const sw = el('input'); sw.type = 'color'; sw.value = w.color; sw.style.cssText = 'width:26px;padding:0;height:22px;flex:none';
		sw.oninput = () => { w.color = sw.value; save(); renderResults(); };
		const name = field(w, 'name', '', { type: 'text' }).querySelector('input');
		const del = el('button', 'x', '✕');
		del.onclick = () => { plan.workloads = plan.workloads.filter((x) => x !== w); save(); renderAll(); };
		head.append(sw, name, del);
		const g = el('div', 'grid');
		g.append(
			field(w, 'replicas', 'Replicas (fixed)'),
			field(w, 'perApp', 'Per app (0 = fixed count)', { step: 0.1 }),
			field(w, 'pool', 'Run on pool', { options: [['', 'Any pool'], ...plan.pools.map((p) => [p.id, p.name])] }),
			field(w, 'cpuReq', 'CPU request (m)'), field(w, 'cpuLim', 'CPU limit (m)'),
			field(w, 'memReq', 'Mem request (MiB)'), field(w, 'memLim', 'Mem limit (MiB)'),
		);
		const z = el('label', 'derived'); z.style.cssText = 'display:flex;gap:6px;align-items:center';
		const cb = el('input'); cb.type = 'checkbox'; cb.style.width = 'auto'; cb.checked = w.scaleToZero !== false;
		cb.onchange = () => { w.scaleToZero = cb.checked; save(); renderResults(); };
		z.append(cb, 'Can scale to zero (follows the active % slider)');
		const d = el('div', 'derived'); d.id = 'wl-' + w.id;
		card.append(head, g, z, d);
		root.append(card);
	}
}

// ---------- results ----------
function seg(w, pct, label) {
	const i = el('i'); i.style.cssText = `width:${pct}%;background:${w.color}`; i.title = label; return i;
}

function renderResults() {
	// keep pool-name dropdowns on workloads in sync is done on structural change; here just compute.
	const packed = pack(plan);
	const cost = costs(plan);
	const wById = Object.fromEntries(plan.workloads.map((w) => [w.id, w]));
	const cur = 'USD';

	let totalNodes = 0, vcpu = 0, mem = 0;
	for (const p of plan.pools) { const c = poolCapacity(p); totalNodes += p.count; vcpu += c.vcpu * p.count; mem += c.memGB * p.count; }
	const totalPods = plan.workloads.reduce((a, w) => a + totalReplicas(plan, w), 0);
	const wantPods = plan.workloads.reduce((a, w) => a + activeReplicas(plan, w), 0);
	const zeroed = totalPods - wantPods;
	const schedPods = Object.values(packed.scheduled).reduce((a, b) => a + b, 0);
	const unsched = wantPods - schedPods;
	const extraTotal = Object.values(packed.extraNodes).reduce((a, b) => a + b, 0);
	const net = 1 - cost.discountPct / 100;
	const waste = Object.fromEntries(plan.pools.map((p) => [p.id, poolWaste(p, packed.nodes[p.id].filter((n) => !n.extra))]));
	const idleMonthly = Object.values(waste).reduce((a, x) => a + x.idleMonthly, 0) * net;

	for (const p of plan.pools) {
		const d = $('#derived-' + p.id); if (!d) continue;
		const c = packed.caps[p.id];
		d.innerHTML = `Node: ${fmt(c.vcpu)} vCPU / ${fmt(c.memGB)} GB · allocatable ${fmt(c.allocCpu)}m / ${fmt(c.allocMem)} MiB · ${money(cost.pools[p.id].nodeMonthly)}/mo per node`;
	}
	for (const w of plan.workloads) {
		const d = $('#wl-' + w.id); if (!d) continue;
		const parts = plan.pools.filter((p) => !w.pool || p.id === w.pool).map((p) => { const f = fitPerNode(p, w); return `${p.name}: <b>${f.n}</b>/node (${f.limiter})`; });
		d.innerHTML = 'Max per empty node — ' + (parts.join(' · ') || 'no pool');
	}

	const cls = unsched ? 'bad' : 'ok';
	const out = $('#results'); out.innerHTML = '';
	out.append(el('div', 'cards',
		`<div class="stat"><span>Monthly cost</span><b>${money(cost.monthly, cur)}</b></div>
		<div class="stat"><span>Annual</span><b>${money(cost.monthly * 12, cur)}</b></div>
		<div class="stat"><span>List price / mo</span><b>${money(cost.listMonthly, cur)}</b></div>
		<div class="stat"><span>Nodes</span><b>${totalNodes}</b></div>
		<div class="stat"><span>Total capacity</span><b>${fmt(vcpu)} vCPU · ${fmt(mem)} GB</b></div>
		<div class="stat"><span>Scaled to zero</span><b>${zeroed} <small>of ${totalPods}</small></b></div>
		<div class="stat"><span>Pods scheduled</span><b class="${cls}">${schedPods} / ${wantPods}</b></div>
		<div class="stat"><span>Extra nodes needed</span><b class="${extraTotal ? 'bad' : 'ok'}">${extraTotal}</b></div>
		<div class="stat"><span>Unrequested / mo</span><b class="${idleMonthly > cost.monthly * 0.5 ? 'warn' : ''}">${money(idleMonthly, cur)}</b></div>`));

	if (showMin) out.append(minNodesSection(cost));
	out.append(wasteSection(waste, cost));
	if (plan.workloads.some((w) => w.perApp > 0)) out.append(capacitySection(cost));

	if (plan.workloads.length) {
		out.append(el('div', 'legend', plan.workloads.map((w) => `<span><i class="swatch" style="background:${w.color}"></i>${esc(w.name)}</span>`).join('')
			+ '<span style="margin-left:auto">Bars show requests; red edge = limits exceed allocatable (overcommit)</span>'));
	}

	for (const p of plan.pools) {
		const block = el('div', 'pool-block');
		const c = packed.caps[p.id], u = poolUsage(p, packed), extra = packed.extraNodes[p.id];
		block.append(el('h3', null, `${esc(p.name)} <small class="hint">× ${p.count}</small>`));
		block.append(el('div', 'meta',
			`${esc(getShape(getProvider(p.providerId), p.shapeId).name)} · ${fmt(c.vcpu)} vCPU / ${fmt(c.memGB)} GB per node · ${money(cost.pools[p.id].monthly)}/mo · ` +
			`${packed.nodes[p.id].filter((n) => !n.extra && n.pods.length).length}/${p.count} nodes in use · CPU req ${fmt(u.cpuReqPct)}% (limits ${fmt(u.cpuLimPct)}%) · Mem req ${fmt(u.memReqPct)}% (limits ${fmt(u.memLimPct)}%) · ${u.pods} pods` +
			(p.count ? ` · unrequested ${vcpus(waste[p.id].idleCpu)} / ${gbs(waste[p.id].idleMem)} (${money(waste[p.id].idleMonthly * net)}/mo)` : '') +
			(extra ? ` · <span class="bad">needs ${extra} more node${extra > 1 ? 's' : ''} (${money(extra * cost.pools[p.id].nodeMonthly)}/mo)</span>` : '')));
		const nodes = el('div', 'nodes');
		packed.nodes[p.id].forEach((n, i) => {
			const nd = el('div', 'node' + (n.extra ? ' extra' : ''));
			nd.append(el('div', 't', `<span>${n.extra ? 'needed' : 'node ' + (i + 1)}</span><span>${n.pods.length}/${n.cap.maxPods} pods</span>`));
			for (const [label, req, lim, alloc, unit, k] of [['CPU', 'reqCpu', 'limCpu', n.cap.allocCpu, 'm', 'cpuReq'], ['MEM', 'reqMem', 'limMem', n.cap.allocMem, ' MiB', 'memReq']]) {
				const bar = el('div', 'bar' + (n[lim] > alloc ? ' lim' : ''));
				const counts = {};
				n.pods.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
				for (const [id, cnt] of Object.entries(counts)) {
					const w = wById[id]; const pct = (w[k] * cnt / alloc) * 100;
					bar.append(seg(w, pct, `${w.name} ×${cnt}: ${fmt(w[k] * cnt)}${unit}`));
				}
				nd.append(bar, el('div', 'lab', `<span>${label} ${fmt((n[req] / alloc) * 100)}%</span><span>lim ${fmt((n[lim] / alloc) * 100)}%</span>`));
			}
			nodes.append(nd);
		});
		block.append(nodes);
		out.append(block);
	}

	// workload table
	let t = '<h3>Workloads</h3><table><tr><th>App</th><th class="n">Replicas</th><th class="n">Active</th><th class="n">Scheduled</th><th class="n">Requests total</th><th class="n">Limits total</th><th>Max per node (by pool)</th><th class="n">Monthly cost*</th></tr>';
	const poolOf = {};
	for (const p of plan.pools) packed.nodes[p.id].forEach((n) => n.pods.forEach((id) => { (poolOf[id] ||= {})[p.id] = (poolOf[id][p.id] || 0) + 1; }));
	const poolTotals = Object.fromEntries(plan.pools.map((p) => [p.id, { cpu: 0, mem: 0 }]));
	plan.workloads.forEach((w) => Object.entries(poolOf[w.id] || {}).forEach(([pid, n]) => { poolTotals[pid].cpu += w.cpuReq * n; poolTotals[pid].mem += w.memReq * n; }));
	for (const w of plan.workloads) {
		const sched = packed.scheduled[w.id] || 0;
		const max = plan.pools.filter((p) => !w.pool || p.id === w.pool).map((p) => `${esc(p.name)}: ${fitPerNode(p, w).n}`).join(', ');
		// cost share: each pool's monthly cost split between workloads by dominant share of requests on that pool
		let share = 0;
		for (const [pid, n] of Object.entries(poolOf[w.id] || {})) {
			// split proportional to requests (cpu and mem averaged), over total pool cost
			const frac = ((w.cpuReq * n) / (poolTotals[pid].cpu || 1) + (w.memReq * n) / (poolTotals[pid].mem || 1)) / 2;
			share += cost.pools[pid].monthly * frac * (1 - cost.discountPct / 100);
		}
		t += `<tr><td><i class="swatch" style="display:inline-block;background:${w.color}"></i> ${esc(w.name)}</td><td class="n">${totalReplicas(plan, w)}</td><td class="n">${activeReplicas(plan, w)}${w.scaleToZero === false ? ' (always on)' : ''}</td>
			<td class="n ${sched < activeReplicas(plan, w) ? 'bad' : ''}">${sched}${packed.unplaceable[w.id] ? ' (does not fit any node)' : ''}</td>
			<td class="n">${fmt(w.cpuReq * activeReplicas(plan, w))}m / ${fmt(w.memReq * activeReplicas(plan, w))} MiB</td>
			<td class="n">${fmt(Math.max(w.cpuLim, w.cpuReq) * activeReplicas(plan, w))}m / ${fmt(Math.max(w.memLim, w.memReq) * activeReplicas(plan, w))} MiB</td>
			<td>${max}</td><td class="n">${money(share)}</td></tr>`;
	}
	t += '</table><p class="hint">*Share of the monthly cost of the pools it runs on, split by requested CPU/memory.</p>';
	out.append(el('div', null, t));

	// cost table
	let c = '<h3>Cost breakdown</h3><table><tr><th>Item</th><th class="n">Per node / hr</th><th class="n">Per node / mo</th><th class="n">Nodes</th><th class="n">Monthly</th></tr>';
	for (const p of plan.pools) { const x = cost.pools[p.id]; c += `<tr><td>${esc(p.name)} — ${esc(p.shapeId)}</td><td class="n">${money(x.nodeHourly)}</td><td class="n">${money(x.nodeMonthly)}</td><td class="n">${p.count}</td><td class="n">${money(x.monthly)}</td></tr>`; }
	for (const f of cost.clusterFees) c += `<tr><td>${esc(f.name)}</td><td class="n">—</td><td class="n">—</td><td class="n">1</td><td class="n">${money(f.monthly)}</td></tr>`;
	if (cost.discountPct) c += `<tr><td>Discount (${fmt(cost.discountPct, 1)}%)</td><td class="n">—</td><td class="n">—</td><td class="n"></td><td class="n">−${money(cost.discountMonthly)}</td></tr>`;
	c += `<tr><th>Total (${HOURS_PER_MONTH} hrs/mo)</th><th></th><th></th><th class="n">${totalNodes}</th><th class="n">${money(cost.monthly)}</th></tr></table>`;
	out.append(el('div', null, c));

	// cluster fee picker per provider
	const fees = el('div', 'hint', 'Cluster fee: ');
	for (const pid of new Set(plan.pools.map((p) => p.providerId))) {
		const prov = getProvider(pid);
		if (!prov.clusterFees?.length) continue;
		plan.clusterFees ||= {};
		const holder = { v: plan.clusterFees[pid] || prov.clusterFees[0].id };
		const lab = field(holder, 'v', prov.name + ' ', { options: prov.clusterFees.map((f) => [f.id, f.name]), onchange: () => { plan.clusterFees[pid] = holder.v; save(); renderResults(); } });
		lab.style.display = 'inline-flex'; lab.style.marginRight = '12px'; lab.style.flexDirection = 'row'; lab.style.gap = '6px';
		fees.append(lab);
	}
	out.append(fees);
}
let showMin = false;
function minNodesSection(cost) {
	const r = minNodes(plan);
	const box = el('div');
	const net = 1 - cost.discountPct / 100;
	let idleTotal = 0;
	const rows = plan.pools.map((p) => {
		const m = r.pools[p.id], delta = m.min - m.current, w = poolWaste(p, m.nodes);
		const dcls = delta > 0 ? 'bad' : delta < 0 ? 'ok' : '';
		idleTotal += w.idleMonthly * net;
		return `<tr><td>${esc(p.name)}</td><td class="n">${m.current}</td><td class="n"><b>${m.min}</b></td>
			<td class="n ${dcls}">${delta > 0 ? '+' : ''}${delta}</td><td class="n">${money(m.min * cost.pools[p.id].nodeMonthly)}</td>
			<td class="n">${m.min ? `${vcpus(w.idleCpu)} (${fmt(w.idleCpuPct)}%)` : '—'}</td>
			<td class="n">${m.min ? `${gbs(w.idleMem)} (${fmt(w.idleMemPct)}%)` : '—'}</td>
			<td class="n">${m.min ? money(w.idleMonthly * net) : '—'}</td></tr>`;
	}).join('');
	const lost = Object.entries(r.unplaceable);
	const warn = lost.length ? `<p class="bad">Cannot be placed on any node of its pool (bigger than one node, or its pool was removed): ${lost.map(([id, n]) => `${esc(plan.workloads.find((w) => w.id === id)?.name || id)} × ${n}`).join(', ')}</p>` : '';
	box.innerHTML = `<h3>Minimum nodes per pool</h3>
		<p class="hint">Fewest nodes that schedule every active replica by requests, ignoring the current node counts. Workloads pinned to a pool are packed there; “Any pool” workloads fill room already open before a new node is added in the first pool that fits. Follows the active % and apps count. Excludes headroom for failures or surge, so add a buffer before using it as a floor.</p>
		<table><tr><th>Pool</th><th class="n">Current</th><th class="n">Minimum</th><th class="n">Change</th><th class="n">Min cost / mo</th>
			<th class="n">Unrequested CPU</th><th class="n">Unrequested mem</th><th class="n">Unrequested / mo</th></tr>${rows}
		<tr><th>Total</th><th class="n">${r.totalCurrent}</th><th class="n">${r.totalMin}</th><th class="n">${r.totalMin - r.totalCurrent}</th><th></th>
			<th></th><th></th><th class="n">${money(idleTotal)}</th></tr></table>
		<p class="hint">Unrequested = allocatable left over on the minimum nodes (the pool's whole node size, less system reserved and DaemonSets, less what pods request); the percentages are of the nodes' full hardware.</p>${warn}`;
	const apply = el('button', 'cta', 'Apply minimums to pools');
	apply.onclick = () => { plan.pools.forEach((p) => { p.count = r.pools[p.id].min; }); save(); renderAll(); };
	box.append(apply);
	return box;
}
function wasteSection(waste, cost) {
	const net = 1 - cost.discountPct / 100;
	const t = { cpu: 0, mem: 0, reqCpu: 0, reqMem: 0, overheadCpu: 0, overheadMem: 0, idleCpu: 0, idleMem: 0, overheadMonthly: 0, idleMonthly: 0 };
	const rows = plan.pools.map((p) => {
		const w = waste[p.id], c = poolCapacity(p);
		for (const k of Object.keys(t)) t[k] += w[k];
		return `<tr><td>${esc(p.name)}</td><td>${w.nodes} × ${esc(p.shapeId)} · ${fmt(c.vcpu)} vCPU / ${fmt(c.memGB)} GB</td>
			<td class="n">${vcpus(w.cpu)} / ${gbs(w.mem)}</td>
			<td class="n">${vcpus(w.reqCpu)} / ${gbs(w.reqMem)}</td>
			<td class="n">${vcpus(w.overheadCpu)} / ${gbs(w.overheadMem)}</td>
			<td class="n">${vcpus(w.idleCpu)} <small class="hint">(${fmt(w.idleCpuPct)}%)</small></td>
			<td class="n">${gbs(w.idleMem)} <small class="hint">(${fmt(w.idleMemPct)}%)</small></td>
			<td class="n">${money(w.overheadMonthly * net)}</td>
			<td class="n"><b>${money(w.idleMonthly * net)}</b></td></tr>`;
	}).join('');
	const pct = (a, b) => (b ? fmt((a / b) * 100) : '0');
	const box = el('div');
	box.innerHTML = `<h3>Wasted resources</h3>
		<p class="hint">Per pool, from each node's hardware: what pods request, what the node keeps for itself (system reserved + DaemonSets), and what is left unrequested. Counts the pool's current nodes, not the extra ones it needs. Percentages are of the full hardware; costs split each node's price into its OCPU and GB parts, after the discount.</p>
		<table><tr><th>Pool</th><th>Hardware</th><th class="n">Total</th><th class="n">Requested</th><th class="n">Node overhead</th>
			<th class="n">Unrequested CPU</th><th class="n">Unrequested mem</th><th class="n">Overhead / mo</th><th class="n">Unrequested / mo</th></tr>${rows}
		<tr><th>Total</th><th></th><th class="n">${vcpus(t.cpu)} / ${gbs(t.mem)}</th><th class="n">${vcpus(t.reqCpu)} / ${gbs(t.reqMem)}</th>
			<th class="n">${vcpus(t.overheadCpu)} / ${gbs(t.overheadMem)}</th>
			<th class="n">${vcpus(t.idleCpu)} (${pct(t.idleCpu, t.cpu)}%)</th><th class="n">${gbs(t.idleMem)} (${pct(t.idleMem, t.mem)}%)</th>
			<th class="n">${money(t.overheadMonthly * net)}</th><th class="n">${money(t.idleMonthly * net)}</th></tr></table>`;
	return box;
}
function capacitySection(cost) {
	const box = el('div');
	const cur = plan.activePct ?? 100;
	const pcts = [...new Set([1, 2, 5, 10, 20, 30, 50, 100, cur])].sort((a, b) => a - b);
	const rows = pcts.map((pct) => {
		const r = maxApps(plan, pct);
		const apps = r.max;
		const b = r.bottleneck;
		const perApp = apps > 0 ? money((cost.listMonthly * (1 - cost.discountPct / 100)) / apps) : '—';
		return `<tr${pct === cur ? ' style="background:#1d2536"' : ''}><td>${fmt(pct, pct % 1 ? 1 : 0)}%${pct === cur ? ' (current)' : ''}</td>
			<td class="n"><b>${apps < 0 ? 'fixed workloads do not fit' : fmt(apps) + (r.capped ? '+' : '')}</b></td>
			<td class="n">${apps > 0 ? fmt(Math.ceil((apps * pct) / 100)) : '—'}</td>
			<td>${b ? `${esc(b.pool)} ${b.resource} (${fmt(b.pct)}% requested)` : '—'}</td><td class="n">${perApp}</td></tr>`;
	}).join('');
	box.innerHTML = `<h3>Capacity: how many apps fit on this cell</h3>
		<p class="hint">Apps = workloads with “Per app” &gt; 0 (e.g. 1 sandbox + 1 agent + 1 deployed app + 1 database each), multiplied up until something stops fitting. Scale-to-zero workloads count only their active share; always-on ones (e.g. databases) count in full. Set “Apps on cell” in the header to see a specific count laid out below.</p>
		<table><tr><th>Active %</th><th class="n">Max apps on cell</th><th class="n">Active at once</th><th>Runs out first</th><th class="n">Cost / app / mo</th></tr>${rows}</table>`;
	return box;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Discount control lives in the header (outside #results) so dragging it is not interrupted by re-renders.
const dSlider = $('#discount'), dNum = $('#discount-num');
const appsNum = $('#apps');
function syncApps() { appsNum.value = plan.appCount ?? ''; }
appsNum.onchange = () => { plan.appCount = appsNum.value === '' ? null : Math.max(0, Math.floor(Number(appsNum.value) || 0)); save(); renderResults(); };
$('#min-nodes').onclick = () => { showMin = true; renderResults(); };
$('#find-max').onclick = () => {
	const r = maxApps(plan);
	if (r.max < 0) { alert('The fixed workloads alone do not fit on this cell.'); return; }
	plan.appCount = r.max; syncApps(); save(); renderResults();
};
function syncDiscount() { syncApps(); dSlider.value = dNum.value = plan.discountPct || 0; aSlider.value = aNum.value = plan.activePct ?? 100; }
const aSlider = $('#active'), aNum = $('#active-num');
const setActive = (v) => { plan.activePct = Math.min(100, Math.max(0, Number(v) || 0)); syncDiscount(); save(); renderResults(); };
aSlider.oninput = () => setActive(aSlider.value);
aNum.onchange = () => setActive(aNum.value);
const setDiscount = (v) => { plan.discountPct = Math.min(100, Math.max(0, Number(v) || 0)); syncDiscount(); save(); renderResults(); };
dSlider.oninput = () => setDiscount(dSlider.value);
dNum.onchange = () => setDiscount(dNum.value);

function renderAll() { syncDiscount(); renderPools(); renderWorkloads(); renderResults(); }

// ---------- toolbar ----------
$('#add-pool').onclick = () => { plan.pools.push(newPool()); save(); renderAll(); };
$('#add-workload').onclick = () => { plan.workloads.push(newWorkload()); save(); renderAll(); };
$('#reset').onclick = () => { if (confirm('Replace the current plan with the example?')) { plan = example(); save(); renderAll(); } };
$('#export').onclick = () => {
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
	a.download = 'nodepool-plan.json'; a.click();
};
$('#import').onclick = () => $('#file').click();
$('#file').onchange = async (e) => {
	const f = e.target.files[0]; if (!f) return;
	try {
		const p = JSON.parse(await f.text());
		if (!Array.isArray(p.pools) || !Array.isArray(p.workloads)) throw new Error('missing pools/workloads');
		plan = p; save(); renderAll();
	} catch (err) { alert('Invalid plan file: ' + err.message); }
	e.target.value = '';
};

// ---------- presets.toml import ----------
// Files are layered in the order picked (later wins, tables merge), like kapps-api's config layers.
// Re-importing replaces the workloads a previous import made and leaves everything else alone.
$('#import-presets').onclick = () => $('#presets-file').click();
$('#presets-file').onchange = async (e) => {
	const files = [...e.target.files]; e.target.value = '';
	if (!files.length) return;
	try {
		let cfg = {};
		for (const f of files) cfg = deepMerge(cfg, parseToml(await f.text()));
		const names = Object.keys(cfg.presets || {});
		if (!names.length) throw new Error('no [presets.*] tables found');
		let name = cfg.default_preset || names[0];
		if (names.length > 1) {
			name = prompt(`Preset to import (${names.join(', ')}):`, name);
			if (name === null) return;
		}
		const r = sandboxPods(cfg, name.trim());
		// Pin to the pool the preset's node_selector names (kapps labels pools workload=<name>); add it when absent.
		const want = Object.values(r.nodeSelector)[0];
		let pool = want && plan.pools.find((p) => p.name === want || p.id === want);
		let added = false;
		if (want && !pool) { pool = newPool({ name: want, count: 1 }); plan.pools.push(pool); added = true; }
		plan.workloads = plan.workloads.filter((w) => !w.fromPreset);
		for (const pod of r.pods) {
			plan.workloads.push(newWorkload({
				name: `${r.presetName}:${pod.name}`, cpuReq: pod.cpuReq, cpuLim: pod.cpuLim, memReq: pod.memReq, memLim: pod.memLim,
				replicas: 0, perApp: 1, scaleToZero: true, pool: pool ? pool.id : '', fromPreset: true,
			}));
		}
		save(); renderAll();
		alert(`Imported preset ${r.presetName}: ${r.pods.map((p) => p.name).join(' + ')} per app` +
			(pool ? `, pinned to pool "${pool.name}"${added ? ' (added; set its shape and size)' : ''}` : '') +
			'.\nSet "Apps on cell" to size it. Each pod sums its containers (sandbox + Caddy; agent + ssh relay); init containers are left out.');
	} catch (err) { alert('Could not import presets: ' + err.message); }
};

renderAll();

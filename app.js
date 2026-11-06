import { PROVIDERS, getProvider, getShape, HOURS_PER_MONTH } from './providers/index.js';
import { pack, costs, fitPerNode, poolCapacity, poolUsage } from './planner.js';

const KEY = 'nodepool-planner:v1';
const COLORS = ['#4f8cff', '#3ecf8e', '#f5b84b', '#b07cff', '#ff7a8a', '#36c5d6', '#e8893a', '#9acd32'];
const uid = () => Math.random().toString(36).slice(2, 8);
const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const money = (n, cur = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: n < 10 ? 3 : 0 }).format(n);

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
			field(w, 'replicas', 'Replicas'),
			field(w, 'pool', 'Run on pool', { options: [['', 'Any pool'], ...plan.pools.map((p) => [p.id, p.name])] }),
			field(w, 'cpuReq', 'CPU request (m)'), field(w, 'cpuLim', 'CPU limit (m)'),
			field(w, 'memReq', 'Mem request (MiB)'), field(w, 'memLim', 'Mem limit (MiB)'),
		);
		const d = el('div', 'derived'); d.id = 'wl-' + w.id;
		card.append(head, g, d);
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
	const wantPods = plan.workloads.reduce((a, w) => a + w.replicas, 0);
	const schedPods = Object.values(packed.scheduled).reduce((a, b) => a + b, 0);
	const unsched = wantPods - schedPods;
	const extraTotal = Object.values(packed.extraNodes).reduce((a, b) => a + b, 0);

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
		<div class="stat"><span>Pods scheduled</span><b class="${cls}">${schedPods} / ${wantPods}</b></div>
		<div class="stat"><span>Extra nodes needed</span><b class="${extraTotal ? 'bad' : 'ok'}">${extraTotal}</b></div>`));

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
			`CPU req ${fmt(u.cpuReqPct)}% (limits ${fmt(u.cpuLimPct)}%) · Mem req ${fmt(u.memReqPct)}% (limits ${fmt(u.memLimPct)}%) · ${u.pods} pods` +
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
	let t = '<h3>Workloads</h3><table><tr><th>App</th><th class="n">Replicas</th><th class="n">Scheduled</th><th class="n">Requests total</th><th class="n">Limits total</th><th>Max per node (by pool)</th><th class="n">Monthly cost*</th></tr>';
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
		t += `<tr><td><i class="swatch" style="display:inline-block;background:${w.color}"></i> ${esc(w.name)}</td><td class="n">${w.replicas}</td>
			<td class="n ${sched < w.replicas ? 'bad' : ''}">${sched}${packed.unplaceable[w.id] ? ' (does not fit any node)' : ''}</td>
			<td class="n">${fmt(w.cpuReq * w.replicas)}m / ${fmt(w.memReq * w.replicas)} MiB</td>
			<td class="n">${fmt(Math.max(w.cpuLim, w.cpuReq) * w.replicas)}m / ${fmt(Math.max(w.memLim, w.memReq) * w.replicas)} MiB</td>
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Discount control lives in the header (outside #results) so dragging it is not interrupted by re-renders.
const dSlider = $('#discount'), dNum = $('#discount-num');
function syncDiscount() { dSlider.value = dNum.value = plan.discountPct || 0; }
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

renderAll();
